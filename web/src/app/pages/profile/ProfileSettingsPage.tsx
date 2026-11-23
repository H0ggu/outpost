import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { SLUG_RE, slugify, type ExternalPlayerHit, type Id, type NewSourceInput, type ProfileHeader, type ReferencePlayer, type Visibility } from '@outpost/shared/api';
import { useSearch } from '../../api/hooks.ts';
import { Box, Card, EmptyState, errorMessage, licon, Spinner } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { Segmented, SiteIcon, TitleBadge } from './components/bits.tsx';
import { fmtInt, SOURCE_KIND_LABELS } from './format.ts';
import { useAddSource, useDatabases, useDeleteProfile, usePatchProfile, useProfile, useRemoveSource } from './hooks.ts';

/**
 * Profile settings (owner or admin; PLAN §5 "private profile, custom page address, hide one
 * account", §6 PATCH/DELETE /api/profiles/:slug and the sources endpoints): rename, address,
 * visibility, daily auto refresh, show/hide and add/remove accounts, delete the profile.
 */
export default function ProfileSettingsPage() {
  const { header } = useProfile();
  if (!header.canEdit) {
    return (
      <Box>
        <EmptyState icon={licon.Padlock} title="Only the owner of this profile (or an admin) can change its settings" />
      </Box>
    );
  }
  return (
    <div className="settings-page">
      <GeneralCard header={header} />
      <SourcesCard header={header} />
      <AddSourceCard header={header} />
      <DangerCard header={header} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Name, address, visibility, auto refresh
// ---------------------------------------------------------------------------

function GeneralCard({ header }: { header: ProfileHeader }) {
  const navigate = useNavigate();
  const patch = usePatchProfile(header.slug);
  const ids = { name: useId(), slug: useId(), auto: useId() };
  const [displayName, setDisplayName] = useState(header.displayName);
  const [slug, setSlug] = useState(header.slug);
  const [visibility, setVisibility] = useState<Visibility>(header.visibility);
  const [autoRefresh, setAutoRefresh] = useState(header.autoRefresh);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(header.displayName);
    setSlug(header.slug);
    setVisibility(header.visibility);
    setAutoRefresh(header.autoRefresh);
  }, [header.displayName, header.slug, header.visibility, header.autoRefresh]);

  const nameError = displayName.trim().length === 0 ? 'Enter a name' : displayName.trim().length > 100 ? 'At most 100 characters' : null;
  const slugError = SLUG_RE.test(slug) ? null : 'Lowercase letters, digits and dashes (2–64), not starting with a dash';
  const changes = {
    ...(displayName.trim() !== header.displayName ? { displayName: displayName.trim() } : {}),
    ...(slug !== header.slug ? { slug } : {}),
    ...(visibility !== header.visibility ? { visibility } : {}),
    ...(autoRefresh !== header.autoRefresh ? { autoRefresh } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || nameError || slugError) return;
    setSaved(false);
    patch.mutate(changes, {
      onSuccess: h => {
        setSaved(true);
        if (h.slug !== header.slug) navigate(paths.profile(h.slug, 'settings'), { replace: true });
      },
    });
  };

  return (
    <Card title="Profile" className="settings-card">
      <form onSubmit={submit} noValidate>
        <div className="form-group">
          <label htmlFor={ids.name}>Name</label>
          <input id={ids.name} type="text" value={displayName} maxLength={100} onChange={e => setDisplayName(e.target.value)} aria-invalid={nameError ? true : undefined} />
          {nameError && <span className="form-error">{nameError}</span>}
        </div>
        <div className="form-group">
          <label htmlFor={ids.slug}>Page address</label>
          <span className="slug-input">
            <span className="slug-input__prefix">/u/</span>
            <input id={ids.slug} type="text" value={slug} maxLength={64} spellCheck={false} autoCapitalize="off" onChange={e => setSlug(e.target.value.toLowerCase())} aria-invalid={slugError ? true : undefined} />
            <button type="button" className="button button-empty button-thin" onClick={() => setSlug(slugify(displayName))} title="Make an address from the name">
              From name
            </button>
          </span>
          {slugError ? <span className="form-error">{slugError}</span> : slug !== header.slug && <span className="form-hint">The old address stops working.</span>}
        </div>
        <div className="form-group">
          <span className="form-label">Visibility</span>
          <Segmented
            label="Visibility"
            value={visibility}
            options={[
              { value: 'private', label: 'Private', icon: licon.Padlock },
              { value: 'public', label: 'Public', icon: licon.Globe },
            ]}
            onChange={setVisibility}
          />
          <span className="form-hint">
            {visibility === 'private' ? 'Only you (and admins) can see this profile.' : 'Every signed-in user can find and see this profile (and visitors, if the admin allows anonymous browsing).'}
          </span>
        </div>
        <div className="form-group form-group--check">
          <input id={ids.auto} type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          <label htmlFor={ids.auto}>Update automatically every day</label>
        </div>
        <div className="form-actions">
          <button type="submit" className="button" disabled={!dirty || !!nameError || !!slugError || patch.isPending}>
            {patch.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && !dirty && <span className="good" role="status">Saved</span>}
          {patch.isError && <span className="form-error" role="alert">{errorMessage(patch.error)}</span>}
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Accounts: show/hide, remove
// ---------------------------------------------------------------------------

function SourcesCard({ header }: { header: ProfileHeader }) {
  const patch = usePatchProfile(header.slug);
  const remove = useRemoveSource(header.slug);
  const [confirming, setConfirming] = useState<Id | null>(null);
  const hiddenIds = header.sources.filter(s => s.hidden).map(s => s.id);

  const setHidden = (id: Id, hide: boolean) =>
    patch.mutate({ hiddenSourceIds: hide ? [...hiddenIds, id] : hiddenIds.filter(x => x !== id) });

  return (
    <Card title="Accounts" pad={false} className="settings-card">
      {header.sources.length === 0 ? (
        <EmptyState icon={licon.User} title="No accounts yet: add one below" />
      ) : (
        <ul className="settings-sources">
          {header.sources.map(s => (
            <li key={s.id} className={s.hidden ? 'is-hidden' : undefined}>
              <span className="settings-sources__name">
                <SiteIcon kind={s.kind} />
                <TitleBadge title={s.title} />
                <span>{s.displayName}</span>
                <span className="muted">
                  {SOURCE_KIND_LABELS[s.kind]} · {fmtInt(s.gameCount)} games
                </span>
              </span>
              <span className="settings-sources__actions">
                <button
                  type="button"
                  className="button button-secondary button-thin"
                  data-icon={licon.Eye}
                  aria-pressed={s.hidden}
                  disabled={patch.isPending}
                  title={s.hidden ? 'Hidden from other viewers: click to show' : 'Hide this account from other viewers'}
                  onClick={() => setHidden(s.id, !s.hidden)}
                >
                  {s.hidden ? 'Show' : 'Hide'}
                </button>
                {confirming === s.id ? (
                  <>
                    <button type="button" className="button button-red button-thin" disabled={remove.isPending} onClick={() => remove.mutate(s.id, { onSettled: () => setConfirming(null) })}>
                      Remove
                    </button>
                    <button type="button" className="button button-empty button-thin" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="button button-empty button-thin" data-icon={licon.Trash} onClick={() => setConfirming(s.id)} aria-label={`Remove ${s.displayName}`} title="Remove from this profile" />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(patch.isError || remove.isError) && (
        <p className="form-error card-sub--pad" role="alert">
          {errorMessage(patch.error ?? remove.error)}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Add an account
// ---------------------------------------------------------------------------

type AddMode = 'online' | 'fide' | 'pgn';

function AddSourceCard({ header }: { header: ProfileHeader }) {
  const [mode, setMode] = useState<AddMode>('online');
  const add = useAddSource(header.slug);
  const [added, setAdded] = useState<string | null>(null);
  const has = (kind: NewSourceInput['kind'], key: string) => header.sources.some(s => s.kind === kind && s.key.toLowerCase() === key.toLowerCase());

  const submit = (input: NewSourceInput, label: string) => {
    setAdded(null);
    add.mutate(input, { onSuccess: () => setAdded(label) });
  };

  return (
    <Card
      title="Add an account"
      className="settings-card"
      actions={
        <Segmented
          label="Kind of account"
          size="sm"
          value={mode}
          options={[
            { value: 'online', label: 'Lichess / Chess.com' },
            { value: 'fide', label: 'FIDE' },
            { value: 'pgn', label: 'PGN database' },
          ]}
          onChange={m => {
            setMode(m);
            add.reset();
            setAdded(null);
          }}
        />
      }
    >
      {mode === 'online' && <OnlineSearch has={has} onAdd={submit} pending={add.isPending} />}
      {mode === 'fide' && <FideSearch has={has} onAdd={submit} pending={add.isPending} />}
      {mode === 'pgn' && <PgnSource slug={header.slug} onAdd={submit} pending={add.isPending} />}
      <div className="form-actions" aria-live="polite">
        {add.isPending && <Spinner size={18} label="Adding" />}
        {added && !add.isPending && <span className="good">Added {added}. Its games are being imported.</span>}
        {add.isError && <span className="form-error">{errorMessage(add.error)}</span>}
      </div>
    </Card>
  );
}

/** A debounced search term (from 2 characters). */
function useDebounced(value: string, ms = 350): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface AddProps {
  has: (kind: NewSourceInput['kind'], key: string) => boolean;
  onAdd: (input: NewSourceInput, label: string) => void;
  pending: boolean;
}

function OnlineSearch({ has, onAdd, pending }: AddProps) {
  const id = useId();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const search = useSearch(term);
  const valid = /^[A-Za-z0-9_-]{2,50}$/.test(q.trim());
  const hits: ExternalPlayerHit[] = search.data && term.length >= 2 ? [...search.data.lichess, ...search.data.chesscom] : [];

  const addButton = (kind: 'lichess' | 'chesscom', username: string) =>
    has(kind, username) ? (
      <span className="muted">Already added</span>
    ) : (
      <button type="button" className="button button-thin" data-icon={licon.PlusButton} disabled={pending} onClick={() => onAdd({ kind, key: username }, `${SOURCE_KIND_LABELS[kind]} ${username}`)}>
        Add
      </button>
    );

  return (
    <div className="add-source">
      <div className="form-group">
        <label htmlFor={id}>Username</label>
        <input id={id} type="search" value={q} placeholder="Lichess or Chess.com username" autoComplete="off" spellCheck={false} onChange={e => setQ(e.target.value)} />
      </div>
      {valid && (
        <div className="add-source__direct">
          {(['lichess', 'chesscom'] as const).map(kind => (
            <button
              key={kind}
              type="button"
              className="button button-secondary button-thin"
              disabled={pending || has(kind, q.trim())}
              onClick={() => onAdd({ kind, key: q.trim() }, `${SOURCE_KIND_LABELS[kind]} ${q.trim()}`)}
            >
              <SiteIcon kind={kind} /> Add “{q.trim()}” on {SOURCE_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
      {search.isFetching && term.length >= 2 && <Spinner size={18} label="Searching" />}
      {search.isError && <p className="form-error">{errorMessage(search.error)}</p>}
      {hits.length > 0 && (
        <ul className="search-hits">
          {hits.map(h => (
            <li key={`${h.kind}:${h.username}`}>
              <span className="search-hits__name">
                <SiteIcon kind={h.kind} />
                <TitleBadge title={h.title} />
                {h.username}
                {h.known && <span className="muted"> · games in Outpost</span>}
                {!h.exists && <span className="muted"> · not confirmed</span>}
              </span>
              {addButton(h.kind, h.username)}
            </li>
          ))}
        </ul>
      )}
      {term.length >= 2 && search.data && hits.length === 0 && !search.isFetching && <p className="muted">No accounts found for “{term}”.</p>}
    </div>
  );
}

function FideSearch({ has, onAdd, pending }: AddProps) {
  const id = useId();
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const search = useSearch(term);
  const players: ReferencePlayer[] = search.data && term.length >= 2 ? search.data.reference.filter(p => p.fideId) : [];
  const isId = /^\d{3,12}$/.test(q.trim());

  return (
    <div className="add-source">
      <p className="form-hint">A FIDE player is built from the games in the reference database (broadcasts and imported OTB games).</p>
      <div className="form-group">
        <label htmlFor={id}>Name or FIDE id</label>
        <input id={id} type="search" value={q} placeholder="e.g. Carlsen or 1503014" autoComplete="off" spellCheck={false} onChange={e => setQ(e.target.value)} />
      </div>
      {isId && (
        <div className="add-source__direct">
          <button type="button" className="button button-secondary button-thin" disabled={pending || has('fide', q.trim())} onClick={() => onAdd({ kind: 'fide', key: q.trim() }, `FIDE ${q.trim()}`)}>
            <SiteIcon kind="fide" /> Add FIDE id {q.trim()}
          </button>
        </div>
      )}
      {search.isFetching && term.length >= 2 && <Spinner size={18} label="Searching" />}
      {players.length > 0 && (
        <ul className="search-hits">
          {players.map(p => (
            <li key={p.fideId!}>
              <span className="search-hits__name">
                <SiteIcon kind="fide" />
                <TitleBadge title={p.title} />
                {p.name}
                <span className="muted">
                  {' '}
                  · {p.fideId}
                  {p.federation ? ` · ${p.federation}` : ''} · {fmtInt(p.games)} games
                </span>
              </span>
              {has('fide', p.fideId!) ? (
                <span className="muted">Already added</span>
              ) : (
                <button type="button" className="button button-thin" data-icon={licon.PlusButton} disabled={pending} onClick={() => onAdd({ kind: 'fide', key: p.fideId! }, p.name)}>
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {term.length >= 2 && search.data && players.length === 0 && !isId && !search.isFetching && <p className="muted">No reference-database players found for “{term}”.</p>}
    </div>
  );
}

function PgnSource({ slug, onAdd, pending }: { slug: string } & Omit<AddProps, 'has'>) {
  const ids = { db: useId(), name: useId() };
  const databases = useDatabases(slug, true);
  const games = (databases.data?.databases ?? []).filter(d => d.kind === 'games');
  const [dbId, setDbId] = useState<string>('');
  const [name, setName] = useState('');
  const chosen = dbId || (games[0] ? String(games[0].id) : '');

  if (databases.isPending) return <Spinner center size={24} label="Loading databases" />;
  if (databases.isError) return <p className="form-error">{errorMessage(databases.error)}</p>;
  if (games.length === 0)
    return (
      <EmptyState icon={licon.Book} title="No PGN databases yet">
        <Link to={paths.databases}>Create one and import games first</Link>
      </EmptyState>
    );

  return (
    <form
      className="add-source"
      onSubmit={e => {
        e.preventDefault();
        if (!name.trim() || !chosen) return;
        onAdd({ kind: 'pgn', key: name.trim(), databaseId: Number(chosen) }, `${name.trim()} (PGN)`);
      }}
    >
      <div className="form-group">
        <label htmlFor={ids.db}>Database</label>
        <select id={ids.db} value={chosen} onChange={e => setDbId(e.target.value)}>
          {games.map(d => (
            <option key={d.id} value={d.id}>
              {d.name} ({fmtInt(d.gameCount)} games)
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor={ids.name}>Player name, exactly as in the PGN</label>
        <input id={ids.name} type="text" value={name} maxLength={200} placeholder="Carlsen, Magnus" onChange={e => setName(e.target.value)} />
      </div>
      <button type="submit" className="button button-thin" data-icon={licon.PlusButton} disabled={pending || !name.trim()}>
        Add player
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function DangerCard({ header }: { header: ProfileHeader }) {
  const navigate = useNavigate();
  const del = useDeleteProfile(header.slug);
  const id = useId();
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <Card title="Delete profile" className="settings-card settings-card--danger">
      <p>Deleting the profile removes its page, bookmarks and settings. Imported games stay in Outpost for other profiles.</p>
      {open ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (typed === header.slug) del.mutate(undefined, { onSuccess: () => navigate(paths.players, { replace: true }) });
          }}
        >
          <div className="form-group">
            <label htmlFor={id}>
              Type <code>{header.slug}</code> to confirm
            </label>
            <input id={id} type="text" value={typed} autoComplete="off" spellCheck={false} onChange={e => setTyped(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="submit" className="button button-red" disabled={typed !== header.slug || del.isPending} data-icon={licon.Trash}>
              Delete for good
            </button>
            <button type="button" className="button button-empty" onClick={() => setOpen(false)}>
              Cancel
            </button>
            {del.isError && <span className="form-error">{errorMessage(del.error)}</span>}
          </div>
        </form>
      ) : (
        <button type="button" className="button button-red button-thin" data-icon={licon.Trash} onClick={() => setOpen(true)}>
          Delete this profile
        </button>
      )}
    </Card>
  );
}
