/**
 * Page-local TanStack Query hooks of the account and admin pages (login, signup, setup, settings,
 * /admin/*) and the site chrome's job indicator. Same pattern as the kit's `api/hooks.ts`:
 * contract types from @outpost/shared, `api` with the abort signal.
 *
 * Keys use top-level prefixes so an area can be refreshed at once: `['me', …]` (my sessions),
 * `['admin', …]` (admin settings, status, users, invites), `['jobs', …]` (shared with the kit's
 * `queryKeys.myJobs`), `['reference']` (shared with the library pages, same endpoint and type).
 * `['me']` and `['admin']` are dropped on sign-in and sign-out like every non-session query.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  API_ROUTES,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type AdminJobsPage,
  type AdminJobsQuery,
  type AdminSettings,
  type AdminStatus,
  type AdminUser,
  type AdminUsersResponse,
  type ApiErrorBody,
  type BroadcastMonthsRequest,
  type ChangePasswordRequest,
  type CreateInviteRequest,
  type Id,
  type ImportJobsResponse,
  type ImportResponse,
  type Invite,
  type InvitesResponse,
  type JobInfo,
  type LoginRequest,
  type LoginResponse,
  type OkResponse,
  type ReferenceImportRequest,
  type ReferenceInfo,
  type SessionInfo,
  type SessionsResponse,
  type SessionUser,
  type SetupRequest,
  type SignupRequest,
  type TotpDisableRequest,
  type TotpEnableRequest,
  type TotpSetupResponse,
  type UpdateAdminSettingsRequest,
  type UpdateAdminUserRequest,
  type UpdatePrefsRequest,
  type UserPrefs,
} from '@outpost/shared/api';
import { api, ApiError } from '../api/client.ts';
import { queryKeys } from '../api/hooks.ts';

/** Query keys of the account and admin pages. */
export const accountKeys = {
  mySessions: ['me', 'sessions'] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminStatus: ['admin', 'status'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminInvites: ['admin', 'invites'] as const,
  adminJobs: (q: AdminJobsQuery) => ['jobs', 'admin', q] as const,
  /** Same key, endpoint and type as the library pages' `libraryKeys.reference`. */
  reference: ['reference'] as const,
};

/** Poll intervals (ms), read at call time so tests can shorten them. */
export const ACCOUNT_POLL = {
  /** Admin jobs table while something is queued or running. */
  jobsActiveMs: 3000,
  /** Admin jobs table otherwise (auto-refresh on). */
  jobsIdleMs: 15_000,
  /** Reference page while a month or import is queued or running. */
  referenceMs: 4000,
};

/** A job that is still queued or running. */
export const isActiveJob = (job: JobInfo | null | undefined): boolean =>
  !!job && (job.status === 'queued' || job.status === 'running');

// ---------------------------------------------------------------------------
// Sign-in, sign-up, setup
// ---------------------------------------------------------------------------

/**
 * After a successful sign-in (login, signup, setup): forget everything cached for the previous
 * visitor, store the new user in the session and refetch it.
 */
export async function signedIn(qc: QueryClient, user: SessionUser): Promise<void> {
  qc.removeQueries({ predicate: q => q.queryKey[0] !== queryKeys.session[0] });
  qc.setQueryData<SessionInfo>(queryKeys.session, s => (s ? { ...s, user, setupRequired: s.setupRequired && user.role !== 'admin' } : s));
  await qc.invalidateQueries({ queryKey: queryKeys.session });
}

/** After the current session ended (revoked, password reset elsewhere): drop caches, refetch the session. */
export async function signedOut(qc: QueryClient): Promise<void> {
  qc.removeQueries({ predicate: q => q.queryKey[0] !== queryKeys.session[0] });
  qc.setQueryData<SessionInfo>(queryKeys.session, s => (s ? { ...s, user: null } : s));
  await qc.invalidateQueries({ queryKey: queryKeys.session });
}

/** `POST /api/login` (401 `totp_required` when a TOTP code is needed). */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post<LoginResponse>(API_ROUTES.login, body),
    onSuccess: res => signedIn(qc, res.user),
  });
}

/** `POST /api/signup`. */
export function useSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SignupRequest) => api.post<LoginResponse>(API_ROUTES.signup, body),
    onSuccess: res => signedIn(qc, res.user),
  });
}

/** `POST /api/setup`: the first admin. */
export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api.post<LoginResponse>(API_ROUTES.setup, body),
    onSuccess: res => signedIn(qc, res.user),
  });
}

// ---------------------------------------------------------------------------
// My account: prefs, password, TOTP, sessions
// ---------------------------------------------------------------------------

const PREFS_MUTATION = ['me', 'prefs'] as const;

/** Order of prefs saves on this page, shared by every `useSavePrefs` (appearance and display). */
let prefsSeq = 0;

/**
 * `PUT /api/me/prefs` with an optimistic update of the cached session, so the theme, board and
 * pieces change at once (Layout applies the session's prefs). Quick successive picks may overlap
 * and answer out of order: only the newest save writes the server's answer back (an older answer
 * would undo a newer pick), and a failure rolls back and refetches the session.
 */
export function useSavePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: PREFS_MUTATION,
    mutationFn: (patch: UpdatePrefsRequest) => api.put<UserPrefs>(API_ROUTES.me.prefs, patch),
    onMutate: async patch => {
      const seq = ++prefsSeq;
      // A session refetch in flight would bring back the old prefs (cancel before writing: a
      // cancelled fetch reverts the query to its state from before the fetch).
      await qc.cancelQueries({ queryKey: queryKeys.session, exact: true });
      const before = qc.getQueryData<SessionInfo>(queryKeys.session)?.user?.prefs;
      qc.setQueryData<SessionInfo>(queryKeys.session, s =>
        s?.user ? { ...s, user: { ...s.user, prefs: { ...s.user.prefs, ...patch } } } : s,
      );
      return { before, seq };
    },
    onError: async (_e, _patch, ctx) => {
      if (ctx?.seq === prefsSeq && ctx.before) {
        const before = ctx.before;
        qc.setQueryData<SessionInfo>(queryKeys.session, s => (s?.user ? { ...s, user: { ...s.user, prefs: before } } : s));
      }
      if (qc.isMutating({ mutationKey: PREFS_MUTATION }) <= 1) await qc.invalidateQueries({ queryKey: queryKeys.session });
    },
    onSuccess: (prefs, _patch, ctx) => {
      if (ctx.seq !== prefsSeq) return;
      qc.setQueryData<SessionInfo>(queryKeys.session, s => (s?.user ? { ...s, user: { ...s.user, prefs } } : s));
    },
  });
}

/** `POST /api/me/password`. Other sessions may end, so the session list is refetched. */
export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => api.post<OkResponse>(API_ROUTES.me.password, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: accountKeys.mySessions }),
  });
}

/** `POST /api/me/totp/setup`: a pending secret with its QR code. */
export function useTotpSetup() {
  return useMutation({
    mutationFn: () => api.post<TotpSetupResponse>(API_ROUTES.me.totpSetup),
  });
}

/** `POST /api/me/totp/enable` or `/disable`, then refetch the session (`totpEnabled`). */
export function useTotpChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ({ action: 'enable' } & TotpEnableRequest) | ({ action: 'disable' } & TotpDisableRequest)) =>
      req.action === 'enable'
        ? api.post<OkResponse>(API_ROUTES.me.totpEnable, { code: req.code } satisfies TotpEnableRequest)
        : api.post<OkResponse>(API_ROUTES.me.totpDisable, { password: req.password, code: req.code } satisfies TotpDisableRequest),
    onSuccess: (_r, req) => {
      qc.setQueryData<SessionInfo>(queryKeys.session, s =>
        s?.user ? { ...s, user: { ...s.user, totpEnabled: req.action === 'enable' } } : s,
      );
      return qc.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

/** `GET /api/me/sessions`. */
export function useMySessions(enabled = true) {
  return useQuery({
    queryKey: accountKeys.mySessions,
    queryFn: ({ signal }) => api.get<SessionsResponse>(API_ROUTES.me.sessions, undefined, signal),
    enabled,
    staleTime: 0,
  });
}

/** `DELETE /api/me/sessions/:id`. Revoking the current session signs this browser out. */
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; current: boolean }) => api.del<OkResponse>(API_ROUTES.me.session(id)),
    onSuccess: async (_r, { id, current }) => {
      if (current) return signedOut(qc);
      qc.setQueryData<SessionsResponse>(accountKeys.mySessions, d => (d ? { sessions: d.sessions.filter(s => s.id !== id) } : d));
      return qc.invalidateQueries({ queryKey: accountKeys.mySessions });
    },
  });
}

// ---------------------------------------------------------------------------
// Admin: settings, status, users, invites
// ---------------------------------------------------------------------------

/** `GET /api/admin/settings`. */
export function useAdminSettings(enabled = true) {
  return useQuery({
    queryKey: accountKeys.adminSettings,
    queryFn: ({ signal }) => api.get<AdminSettings>(API_ROUTES.admin.settings, undefined, signal),
    enabled,
  });
}

/** `PUT /api/admin/settings` (changed fields only). Signup mode and anonymous browsing live in the session too. */
export function useUpdateAdminSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAdminSettingsRequest) => api.put<AdminSettings>(API_ROUTES.admin.settings, patch),
    onSuccess: settings => {
      qc.setQueryData(accountKeys.adminSettings, settings);
      qc.setQueryData<SessionInfo>(queryKeys.session, s =>
        s ? { ...s, signupMode: settings.signupMode, anonymousBrowsing: settings.anonymousBrowsing } : s,
      );
      return Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.session }),
        // Token validity is part of the status panel.
        qc.invalidateQueries({ queryKey: accountKeys.adminStatus }),
      ]);
    },
  });
}

/** `GET /api/admin/status` (probes upstreams, so it is kept for a minute). */
export function useAdminStatus(enabled = true) {
  return useQuery({
    queryKey: accountKeys.adminStatus,
    queryFn: ({ signal }) => api.get<AdminStatus>(API_ROUTES.admin.status, undefined, signal),
    enabled,
    staleTime: 60_000,
  });
}

/** `GET /api/admin/users`. */
export function useAdminUsers() {
  return useQuery({
    queryKey: accountKeys.adminUsers,
    queryFn: ({ signal }) => api.get<AdminUsersResponse>(API_ROUTES.admin.users, undefined, signal),
  });
}

/** `PATCH /api/admin/users/:id`. */
export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: UpdateAdminUserRequest }) => api.patch<AdminUser>(API_ROUTES.admin.user(id), patch),
    onSuccess: user => {
      qc.setQueryData<AdminUsersResponse>(accountKeys.adminUsers, d =>
        d ? { users: d.users.map(u => (u.id === user.id ? user : u)) } : d,
      );
      return qc.invalidateQueries({ queryKey: accountKeys.adminUsers });
    },
  });
}

/** `DELETE /api/admin/users/:id`. */
export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.del<OkResponse>(API_ROUTES.admin.user(id)),
    onSuccess: (_r, id) => {
      qc.setQueryData<AdminUsersResponse>(accountKeys.adminUsers, d => (d ? { users: d.users.filter(u => u.id !== id) } : d));
      return Promise.all([
        qc.invalidateQueries({ queryKey: accountKeys.adminUsers }),
        qc.invalidateQueries({ queryKey: accountKeys.adminInvites }),
      ]);
    },
  });
}

/** `GET /api/admin/invites`. */
export function useInvites() {
  return useQuery({
    queryKey: accountKeys.adminInvites,
    queryFn: ({ signal }) => api.get<InvitesResponse>(API_ROUTES.admin.invites, undefined, signal),
  });
}

/** `POST /api/admin/invites` → the new invite. */
export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteRequest) => api.post<Invite>(API_ROUTES.admin.invites, body),
    onSuccess: invite => {
      qc.setQueryData<InvitesResponse>(accountKeys.adminInvites, d =>
        d ? { invites: [invite, ...d.invites.filter(i => i.code !== invite.code)] } : d,
      );
      return qc.invalidateQueries({ queryKey: accountKeys.adminInvites });
    },
  });
}

/** `DELETE /api/admin/invites/:code`. */
export function useDeleteInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => api.del<OkResponse>(API_ROUTES.admin.invite(code)),
    onSuccess: (_r, code) => {
      qc.setQueryData<InvitesResponse>(accountKeys.adminInvites, d => (d ? { invites: d.invites.filter(i => i.code !== code) } : d));
      return qc.invalidateQueries({ queryKey: accountKeys.adminInvites });
    },
  });
}

// ---------------------------------------------------------------------------
// Admin: jobs
// ---------------------------------------------------------------------------

/** `GET /api/admin/jobs`, refreshed every few seconds while `autoRefresh` (faster while jobs run). */
export function useAdminJobs(query: AdminJobsQuery, autoRefresh: boolean) {
  return useQuery({
    queryKey: accountKeys.adminJobs(query),
    queryFn: ({ signal }) => api.get<AdminJobsPage>(API_ROUTES.admin.jobs, { ...query }, signal),
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchInterval: q => {
      if (!autoRefresh) return false;
      const c = q.state.data?.counts;
      return c && c.queued + c.running > 0 ? ACCOUNT_POLL.jobsActiveMs : ACCOUNT_POLL.jobsIdleMs;
    },
  });
}

/** `POST /api/admin/jobs/:id/retry` or `/cancel` → the (possibly new) job. */
export function useJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: Id; action: 'retry' | 'cancel' }) =>
      api.post<JobInfo>(action === 'retry' ? API_ROUTES.admin.jobRetry(id) : API_ROUTES.admin.jobCancel(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

// ---------------------------------------------------------------------------
// Admin: reference database
// ---------------------------------------------------------------------------

/** True while a broadcast month or a reference import is queued or running. */
export const referenceBusy = (info: ReferenceInfo | undefined): boolean =>
  !!info &&
  (info.broadcastMonths.some(m => m.status === 'queued' || m.status === 'importing') ||
    info.databases.some(d => isActiveJob(d.importJob)));

/** `GET /api/reference`, polled while an import is queued or running. */
export function useReferenceInfo() {
  return useQuery({
    queryKey: accountKeys.reference,
    queryFn: ({ signal }) => api.get<ReferenceInfo>(API_ROUTES.reference, undefined, signal),
    refetchInterval: q => (referenceBusy(q.state.data) ? ACCOUNT_POLL.referenceMs : false),
  });
}

/** Everything a queued reference import changes. */
function afterReferenceImport(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: accountKeys.reference }),
    qc.invalidateQueries({ queryKey: ['databases'] }),
    qc.invalidateQueries({ queryKey: ['jobs'] }),
  ]);
}

/** `POST /api/admin/reference/broadcast-months`. */
export function useImportBroadcastMonths() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BroadcastMonthsRequest) => api.post<ImportJobsResponse>(API_ROUTES.admin.referenceBroadcastMonths, body),
    onSuccess: () => afterReferenceImport(qc),
  });
}

/** Input of `useReferenceImport`: a URL (JSON) or a file (multipart, with upload progress). */
export type ReferenceImportInput =
  | { source: 'url'; request: ReferenceImportRequest }
  | {
      source: 'file';
      file: Blob & { name?: string };
      request: Omit<ReferenceImportRequest, 'url'>;
      onProgress?: (loaded: number, total: number) => void;
      signal?: AbortSignal;
    };

/** `POST /api/admin/reference/import` → the queued job. */
export function useReferenceImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReferenceImportInput): Promise<ImportResponse> => {
      if (input.source === 'url') return api.post<ImportResponse>(API_ROUTES.admin.referenceImport, input.request);
      const form = new FormData();
      for (const [k, v] of Object.entries(input.request)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
      form.append('file', input.file, input.file.name ?? 'upload.pgn');
      return uploadForm<ImportResponse>(API_ROUTES.admin.referenceImport, form, {
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    onSuccess: () => afterReferenceImport(qc),
  });
}

/**
 * Multipart POST with upload progress (reference imports go up to 2 GB, PLAN §10). `fetch` has no
 * upload progress, so this uses XMLHttpRequest with the same rules as the `api` client: same-origin
 * credentials, the CSRF header, and `ApiError` for failures (`network` when unreachable).
 */
export function uploadForm<T>(
  path: string,
  form: FormData,
  opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => opts.signal?.removeEventListener('abort', abort);
    if (opts.signal?.aborted) {
      reject(new DOMException('The upload was cancelled', 'AbortError'));
      return;
    }
    xhr.open('POST', path);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader(CSRF_HEADER, CSRF_HEADER_VALUE);
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      done();
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const err = (body as Partial<ApiErrorBody> | null)?.error;
      reject(
        err?.code
          ? new ApiError(xhr.status, err.code, err.message, err.details)
          : new ApiError(xhr.status, xhr.status === 413 ? 'payload_too_large' : 'internal', xhr.statusText || `HTTP ${xhr.status}`),
      );
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new ApiError(0, 'network', 'Cannot reach the Outpost server'));
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new DOMException('The upload was cancelled', 'AbortError'));
    });
    opts.signal?.addEventListener('abort', abort, { once: true });
    xhr.send(form);
  });
}
