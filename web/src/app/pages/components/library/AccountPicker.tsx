/**
 * Adds accounts to a new profile: search (Lichess, Chess.com, reference players with a FIDE id) or
 * enter one by hand — a username, a FIDE id, or a player name inside one of your PGN databases.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { DatabaseInfo, SourceKind } from '@outpost/shared/api';
import { useSearch } from '../../../api/hooks.ts';
import { Button, licon } from '../../../components/index.ts';
import { useDatabaseGames, useDatabases, useDebouncedValue } from '../../library-hooks.ts';
import { SearchField } from './controls.tsx';
import { sourceIdentity, type PickedSource } from './newProfileQuery.ts';
import { ExternalHitRow, externalSource, HitSection, ReferenceHitRow, referenceSource, unavailableSet } from './SearchHits.tsx';

const USERNAME_RE = /^[A-Za-z0-9_-]{2,50}$/;
const FIDE_RE = /^\d{1,12}$/;

/** Labels of the manual-entry kinds. */
const MANUAL_KINDS: ReadonlyArray<{ kind: SourceKind; label: string }> = [
  { kind: 'lichess', label: 'Lichess username' },
  { kind: 'chesscom', label: 'Chess.com username' },
  { kind: 'fide', label: 'FIDE id (reference DB)' },
  { kind: 'pgn', label: 'Player in a PGN database' },
];

export function AccountPicker({ picked, onAdd }: { picked: readonly PickedSource[]; onAdd: (s: PickedSource) => void }) {
  const [q, setQ] = useState('');
  const term = useDebouncedValue(q, 300).trim();
  const search = useSearch(term);
  const has = (s: PickedSource) => picked.some(p => sourceIdentity(p) === sourceIdentity(s));

  const addButton = (s: PickedSource | null, name: string) =>
    s ? (
      has(s) ? (
        <span className="lib-pill lib-pill--good" data-icon={licon.Checkmark}>
          added
        </span>
      ) : (
        <Button size="sm" variant="secondary" icon={licon.PlusButton} onClick={() => onAdd(s)} aria-label={`Add ${name}`}>
          Add
        </Button>
      )
    ) : (
      <span className="muted lib-hit__note">no FIDE id</span>
    );

  const r = search.data;
  const down = unavailableSet(r);

  return (
    <div className="lib-picker">
      <SearchField
        value={q}
        onChange={setQ}
        label="Search for an account"
        placeholder="Username, player name or FIDE id"
        busy={search.isFetching && term.length >= 2}
      />
      {term.length >= 2 && r && (
        <div className={search.isPlaceholderData ? 'lib-results lib-results--stale' : 'lib-results'}>
          <HitSection title="Lichess" count={r.lichess.length} unavailable={down.has('lichess')} empty="No match.">
            {r.lichess.map(h => (
              <ExternalHitRow key={h.username} hit={h} actions={addButton(externalSource(h), h.username)} />
            ))}
          </HitSection>
          <HitSection title="Chess.com" count={r.chesscom.length} unavailable={down.has('chesscom')} empty="No exact match.">
            {r.chesscom.map(h => (
              <ExternalHitRow key={h.username} hit={h} actions={addButton(externalSource(h), h.username)} />
            ))}
          </HitSection>
          {(r.reference.length > 0 || down.has('reference')) && (
            <HitSection title="Reference database" count={r.reference.length} unavailable={down.has('reference')}>
              {r.reference.map(p => (
                <ReferenceHitRow key={`${p.fideId ?? ''}:${p.name}`} player={p} actions={addButton(referenceSource(p), p.name)} />
              ))}
            </HitSection>
          )}
        </div>
      )}
      {search.isError && term.length >= 2 && <p className="form-error">Search failed: {search.error.message}</p>}
      <ManualSource has={has} onAdd={onAdd} />
    </div>
  );
}

/** Manual entry: kind, then username / FIDE id / database + player name. */
function ManualSource({ has, onAdd }: { has: (s: PickedSource) => boolean; onAdd: (s: PickedSource) => void }) {
  const id = useId();
  const [kind, setKind] = useState<SourceKind>('lichess');
  const [key, setKey] = useState('');
  const [dbId, setDbId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const databases = useDatabases(kind === 'pgn');
  const gameDbs = useMemo(() => (databases.data?.databases ?? []).filter(d => d.kind === 'games'), [databases.data]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    let s: PickedSource | null = null;
    if (kind === 'lichess' || kind === 'chesscom') {
      if (!USERNAME_RE.test(k)) return setError('Usernames are 2–50 letters, digits, “_” or “-”.');
      s = { kind, key: k };
    } else if (kind === 'fide') {
      if (!FIDE_RE.test(k)) return setError('A FIDE id is a number, e.g. 1503014.');
      s = { kind, key: k };
    } else {
      if (dbId === '') return setError('Pick a database.');
      if (!k) return setError('Type the player’s name as written in the PGN.');
      const db = gameDbs.find(d => d.id === dbId);
      s = { kind: 'pgn', key: k, databaseId: dbId, label: db ? `${k} (${db.name})` : k };
    }
    if (has(s)) return setError('Already added.');
    setError(null);
    onAdd(s);
    setKey('');
  };

  return (
    <form className="lib-manual-source" onSubmit={submit} aria-label="Add an account by hand">
      <div className="lib-inline-form">
        <div className="form-group form-group--narrow">
          <label htmlFor={`${id}-kind`}>Add by hand</label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={e => {
              setKind(e.target.value as SourceKind);
              setError(null);
            }}
          >
            {MANUAL_KINDS.map(k => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {kind === 'pgn' && (
          <div className="form-group form-group--narrow">
            <label htmlFor={`${id}-db`}>Database</label>
            <select id={`${id}-db`} value={dbId} onChange={e => setDbId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{databases.isPending ? 'Loading…' : gameDbs.length ? 'Choose…' : 'No databases'}</option>
              {gameDbs.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group">
          <label htmlFor={`${id}-key`}>{kind === 'fide' ? 'FIDE id' : kind === 'pgn' ? 'Player name' : 'Username'}</label>
          <input
            id={`${id}-key`}
            type="text"
            value={key}
            inputMode={kind === 'fide' ? 'numeric' : undefined}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            list={kind === 'pgn' ? `${id}-names` : undefined}
            placeholder={kind === 'fide' ? '1503014' : kind === 'pgn' ? 'Carlsen, Magnus' : 'username'}
            onChange={e => setKey(e.target.value)}
          />
          {kind === 'pgn' && dbId !== '' && <PlayerNames listId={`${id}-names`} db={gameDbs.find(d => d.id === dbId)} q={key} />}
        </div>
        <Button type="submit" variant="secondary" icon={licon.PlusButton}>
          Add
        </Button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {kind === 'pgn' && (
        <p className="lib-hint">Games where this exact name plays White or Black are attached to the profile.</p>
      )}
    </form>
  );
}

/** `<datalist>` of player names in a database that contain `q` (from its game list search). */
function PlayerNames({ listId, db, q }: { listId: string; db: DatabaseInfo | undefined; q: string }) {
  const term = useDebouncedValue(q, 300).trim();
  const games = useDatabaseGames(db?.id, 1, 50, term.length >= 2 ? term : '');
  const names = useMemo(() => {
    const t = term.toLowerCase();
    const set = new Set<string>();
    for (const g of games.data?.games ?? [])
      for (const n of [g.white.name, g.black.name]) if (!t || n.toLowerCase().includes(t)) set.add(n);
    return [...set].sort((a, b) => a.localeCompare(b)).slice(0, 30);
  }, [games.data, term]);
  return (
    <datalist id={listId}>
      {names.map(n => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
