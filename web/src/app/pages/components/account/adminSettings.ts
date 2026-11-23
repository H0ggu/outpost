/**
 * Draft state of the admin settings form: what the admin is editing, the client-side checks and
 * the `PUT /api/admin/settings` body of the changed fields (PLAN §6). The Lichess token is
 * write-only: the form never holds the stored token, only a replacement or "remove".
 */
import type { AdminSettings, MastersSource, SignupMode, UpdateAdminSettingsRequest } from '@outpost/shared/api';
import { formatCount } from './format.ts';

/** Editable copy of the settings (the token is write-only: `tokenInput` is a replacement). */
export interface Draft {
  signupMode: SignupMode;
  anonymousBrowsing: boolean;
  tokenInput: string;
  clearToken: boolean;
  chesscomContact: string;
  autoRefreshHourUtc: number;
  updateCooldownMinutes: string;
  initialSyncMonths: string;
  mastersSource: MastersSource;
  broadcastAutoImport: boolean;
}

export const draftOf = (s: AdminSettings): Draft => ({
  signupMode: s.signupMode,
  anonymousBrowsing: s.anonymousBrowsing,
  tokenInput: '',
  clearToken: false,
  chesscomContact: s.chesscomContactFromEnv ? '' : (s.chesscomContact ?? ''),
  autoRefreshHourUtc: s.autoRefreshHourUtc,
  updateCooldownMinutes: String(s.updateCooldownMinutes),
  initialSyncMonths: String(s.initialSyncMonths),
  mastersSource: s.mastersSource,
  broadcastAutoImport: s.broadcastAutoImport ?? false,
});

export const MAX_COOLDOWN = 7 * 24 * 60;
export const MAX_MONTHS = 600;

/** Client-side checks, by field. */
export function settingsProblems(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  const cooldown = Number(d.updateCooldownMinutes);
  if (d.updateCooldownMinutes.trim() === '' || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN)
    p.updateCooldownMinutes = `A whole number of minutes from 0 to ${formatCount(MAX_COOLDOWN)} (one week).`;
  const months = Number(d.initialSyncMonths);
  if (d.initialSyncMonths.trim() === '' || !Number.isInteger(months) || months < 0 || months > MAX_MONTHS)
    p.initialSyncMonths = `A whole number of months from 0 to ${MAX_MONTHS}.`;
  const token = d.tokenInput.trim();
  if (token && !/^[A-Za-z0-9_]+$/.test(token)) p.lichessToken = 'A Lichess token has only letters, digits and _ (it starts with lip_).';
  if (token.length > 2048) p.lichessToken = 'That token is too long.';
  if (d.chesscomContact.trim().length > 200) p.chesscomContact = 'Keep it under 200 characters.';
  return p;
}

/** The changed fields as a `PUT` body. */
export function settingsPatch(s: AdminSettings, d: Draft): UpdateAdminSettingsRequest {
  const out: UpdateAdminSettingsRequest = {};
  if (d.signupMode !== s.signupMode) out.signupMode = d.signupMode;
  if (d.anonymousBrowsing !== s.anonymousBrowsing) out.anonymousBrowsing = d.anonymousBrowsing;
  if (!s.lichessToken.fromEnv) {
    if (d.tokenInput.trim()) out.lichessToken = d.tokenInput.trim();
    else if (d.clearToken && s.lichessToken.set) out.lichessToken = null;
  }
  if (!s.chesscomContactFromEnv) {
    const contact = d.chesscomContact.trim();
    if (contact !== (s.chesscomContact ?? '')) out.chesscomContact = contact ? contact : null;
  }
  if (d.autoRefreshHourUtc !== s.autoRefreshHourUtc) out.autoRefreshHourUtc = d.autoRefreshHourUtc;
  if (Number(d.updateCooldownMinutes) !== s.updateCooldownMinutes) out.updateCooldownMinutes = Number(d.updateCooldownMinutes);
  if (Number(d.initialSyncMonths) !== s.initialSyncMonths) out.initialSyncMonths = Number(d.initialSyncMonths);
  if (d.mastersSource !== s.mastersSource) out.mastersSource = d.mastersSource;
  // Only servers that report the setting accept it.
  if ('broadcastAutoImport' in s && d.broadcastAutoImport !== (s.broadcastAutoImport ?? false)) out.broadcastAutoImport = d.broadcastAutoImport;
  return out;
}

