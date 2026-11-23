import { useId, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { slugify, SLUG_RE, type CreateProfileRequest, type Visibility } from '@outpost/shared/api';
import { ApiError } from '../api/client.ts';
import { useSession } from '../api/hooks.ts';
import { Box, Button, ErrorBox, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { AccountPicker } from './components/library/AccountPicker.tsx';
import { dedupeSources, parseNewProfileQuery, sourceIdentity, type PickedSource } from './components/library/newProfileQuery.ts';
import { SourceBadge } from './components/library/ProfileList.tsx';
import { SignInPrompt } from './components/library/QueryView.tsx';
import { useCreateProfile, useDatabases } from './library-hooks.ts';
import './components/library/library.css';
import './NewProfilePage.css';

/** Longest display name the form accepts. */
const MAX_NAME = 100;

/** A server message as a sentence (the API's messages carry no full stop). */
const sentence = (text: string): string => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * PLAN §9 `/profiles/new`, §6 POST /api/profiles: pick and merge any number of accounts (Lichess,
 * Chess.com, a FIDE id from the reference DB, a player inside a PGN database), name the profile,
 * choose its page address and visibility. On success the profile page opens (its header shows the
 * initial sync), with the new `ProfileHeader` already in the cache.
 * Pre-selection from links: `?lichess=&chesscom=&fide=&db=&player=&name=` (newProfileQuery.ts).
 */
export default function NewProfilePage() {
  const session = useSession();
  return (
    <Page title="New profile" narrow>
      {session.isPending ? (
        <Spinner center />
      ) : session.data?.user ? (
        <NewProfileForm />
      ) : (
        <Box title="New profile">
          <SignInPrompt what="and create profiles" />
        </Box>
      )}
    </Page>
  );
}

function NewProfileForm() {
  const id = useId();
  const anonymous = !!useSession().data?.anonymousBrowsing;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [initial] = useState(() => parseNewProfileQuery(params));
  const [sources, setSources] = useState<PickedSource[]>(initial.sources);
  const [name, setName] = useState(initial.name ?? '');
  const [nameTouched, setNameTouched] = useState(!!initial.name);
  const [slug, setSlug] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const create = useCreateProfile();
  const databases = useDatabases(sources.some(s => s.kind === 'pgn'));
  const dbName = (dbId: number | undefined) => databases.data?.databases.find(d => d.id === dbId)?.name ?? `database #${dbId}`;

  const first = sources[0];
  const suggestedName = first ? (first.kind === 'pgn' ? first.key : (first.label ?? first.key)) : '';
  const displayName = (nameTouched ? name : suggestedName).trim();
  const slugPreview = slug.trim() || (displayName ? slugify(displayName) : '');
  const slugInvalid = slug.trim() !== '' && !SLUG_RE.test(slug.trim());
  const conflict = create.error instanceof ApiError && create.error.status === 409;

  const add = (s: PickedSource) => {
    setSources(cur => dedupeSources([...cur, s]));
    setFormError(null);
  };
  const remove = (s: PickedSource) => setSources(cur => cur.filter(x => sourceIdentity(x) !== sourceIdentity(s)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (sources.length === 0) return setFormError('Add at least one account.');
    if (!displayName) return setFormError('Give the profile a name.');
    if (displayName.length > MAX_NAME) return setFormError(`Names are at most ${MAX_NAME} characters.`);
    if (slugInvalid) return setFormError('Fix the page address first.');
    setFormError(null);
    const body: CreateProfileRequest = {
      displayName,
      visibility,
      autoRefresh,
      sources: sources.map(s => (s.kind === 'pgn' ? { kind: s.kind, key: s.key, databaseId: s.databaseId } : { kind: s.kind, key: s.key })),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
    };
    create.mutate(body, {
      onSuccess: header => navigate(paths.profile(header.slug), { replace: true }),
    });
  };

  return (
    <div className="lib-newprofile">
      <Box title="New profile">
        <p className="lib-lead">
          A profile merges any number of accounts into one page of statistics. Add every account the player uses.
        </p>

        <h2 className="lib-section-title">
          Accounts {sources.length > 0 && <span className="lib-count">{sources.length}</span>}
        </h2>
        {sources.length === 0 ? (
          <p className="muted">No accounts yet. Search below, or add one by hand.</p>
        ) : (
          <ul className="lib-picked">
            {sources.map(s => (
              <li key={sourceIdentity(s)}>
                <span className="lib-picked__main">
                  <SourceBadge source={{ kind: s.kind, displayName: s.label ?? s.key }} />
                  {s.kind === 'fide' && s.label && <span className="muted lib-picked__extra">FIDE {s.key}</span>}
                  {s.kind === 'pgn' && <span className="muted lib-picked__extra">in {dbName(s.databaseId)}</span>}
                </span>
                <button
                  type="button"
                  className="lib-icon-btn lib-icon-btn--danger"
                  data-icon={licon.X}
                  aria-label={`Remove ${s.label ?? s.key}`}
                  title="Remove"
                  onClick={() => remove(s)}
                />
              </li>
            ))}
          </ul>
        )}

        <h2 className="lib-section-title">Add an account</h2>
        <AccountPicker picked={sources} onAdd={add} />
      </Box>

      <form onSubmit={submit} noValidate aria-label="Profile settings">
        <Box title="Profile" level={2}>
          <div className="form-group">
            <label htmlFor={`${id}-name`}>Display name</label>
            <input
              id={`${id}-name`}
              type="text"
              value={nameTouched ? name : suggestedName}
              maxLength={MAX_NAME}
              placeholder="e.g. Magnus Carlsen"
              onChange={e => {
                setNameTouched(true);
                setName(e.target.value);
              }}
            />
          </div>

          <div className="form-group">
            <label htmlFor={`${id}-slug`}>Page address</label>
            <div className="lib-slug">
              <span className="lib-slug__prefix">/u/</span>
              <input
                id={`${id}-slug`}
                type="text"
                value={slug}
                placeholder={slugPreview || 'player-name'}
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={slugInvalid || conflict}
                aria-describedby={`${id}-slug-help`}
                onChange={e => setSlug(e.target.value.toLowerCase())}
              />
            </div>
            <span id={`${id}-slug-help`} className={slugInvalid || conflict ? 'form-error' : 'lib-hint'}>
              {slugInvalid
                ? 'Use 2–64 lowercase letters, digits and dashes (not starting with a dash).'
                : conflict
                  ? `${sentence(create.error?.message ?? 'That address is taken')} Choose another address.`
                  : 'Leave empty to use the suggestion; a number is added if it is taken.'}
            </span>
          </div>

          <fieldset className="lib-radios">
            <legend>Who can see it</legend>
            <label className="lib-checkbox">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'private'} onChange={() => setVisibility('private')} />
              <span>
                <i data-icon={licon.Padlock} aria-hidden /> <strong>Private</strong> <span className="muted">only you (and admins)</span>
              </span>
            </label>
            <label className="lib-checkbox">
              <input type="radio" name={`${id}-vis`} checked={visibility === 'public'} onChange={() => setVisibility('public')} />
              <span>
                <i data-icon={licon.Globe} aria-hidden /> <strong>Public</strong>{' '}
                <span className="muted">
                  {anonymous
                    ? 'listed under Players; anyone who can reach this server can read it, signed in or not'
                    : 'listed under Players for everyone signed in to this server'}
                </span>
              </span>
            </label>
          </fieldset>

          <label className="lib-checkbox lib-autorefresh">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            <span>Update automatically every day</span>
          </label>

          {formError && <p className="form-error">{formError}</p>}
          {create.isError && !conflict && <ErrorBox error={create.error} title="Could not create the profile" />}

          <div className="lib-actions lib-actions--end lib-submit">
            <Button type="submit" icon={licon.Checkmark} disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create profile'}
            </Button>
          </div>
          <p className="lib-hint lib-actions--end">The first sync starts right away; you can follow it on the profile page.</p>
        </Box>
      </form>
    </div>
  );
}
