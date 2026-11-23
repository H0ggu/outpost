/**
 * Preference sections of /settings (PLAN §6 `UserPrefs`): appearance (site theme, board, pieces,
 * sounds — previewed with the vendored lila assets and a live board) and display (W/D/L
 * perspective, time zone, Studio layout). Every change saves at once and applies live: the
 * optimistic session update makes Layout re-apply theme, board and pieces.
 */
import type { Config } from '@lichess-org/chessground/config';
import { useMemo, type ReactNode } from 'react';
import {
  BOARD_THEMES,
  PIECE_SETS,
  SOUND_SETS,
  STUDIO_LAYOUTS,
  type BoardTheme,
  type PieceSet,
  type SoundSet,
  type StudioLayout,
  type ThemeName,
  type UpdatePrefsRequest,
  type UserPrefs,
} from '@outpost/shared/api';
import { browserTimeZone } from '../../../api/hooks.ts';
import { Board } from '../../../components/Board.tsx';
import { Box, Button, licon, WdlBar } from '../../../components/index.ts';
import { BOARD_FILES, boardThumbnailUrl, pieceUrl, playSound } from '../../../../lichess/assets.ts';
import { useSavePrefs } from '../../account-hooks.ts';
import { describeError, Flash, RadioGroup, useTransient } from './forms.tsx';
import { timeFormat } from './format.ts';
import './account.css';

/** Display names of the piece sets (lila's names). */
export const PIECE_SET_LABELS: Readonly<Record<PieceSet, string>> = {
  cburnett: 'Cburnett',
  merida: 'Merida',
  chessnut: 'Chessnut',
  fantasy: 'Fantasy',
  spatial: 'Spatial',
  celtic: 'Celtic',
  'kiwen-suwi': 'Kiwen-suwi',
  firi: 'Firi',
  rhosgfx: 'RhosGFX',
  mpchess: 'MPChess',
  pixel: 'Pixel',
  letter: 'Letter',
};

/** Display names of the sound sets. */
export const SOUND_SET_LABELS: Readonly<Record<SoundSet, string>> = {
  sfx: 'SFX',
  piano: 'Piano',
  nes: 'NES',
  silent: 'Silent',
};

/** The site themes, true black first (the default). */
export const THEMES: ReadonlyArray<{ value: ThemeName; label: string; help: string }> = [
  { value: 'black', label: 'True black', help: 'Pure black for OLED screens. The default.' },
  { value: 'dark', label: 'Dark', help: "Lichess's dark theme." },
  { value: 'light', label: 'Light', help: "Lichess's light theme." },
];

const STUDIO_LAYOUT_LABELS: Readonly<Record<StudioLayout, { label: string; help: string }>> = {
  default: { label: 'Standard', help: 'Board, moves and tools side by side.' },
  explorer: { label: 'Explorer', help: 'Opening explorer opened next to the board.' },
  games: { label: 'Games', help: 'Room for game lists and My Files.' },
  focus: { label: 'Focus', help: 'Just the board and the moves.' },
};

/** Saves one preference change and reports it. */
function usePrefSaver() {
  const save = useSavePrefs();
  const [saved, flashSaved] = useTransient<number>();
  const update = (patch: UpdatePrefsRequest) => save.mutate(patch, { onSuccess: () => flashSaved(Date.now()) });
  const status: ReactNode = save.isError ? (
    <Flash kind="failure">Could not save: {describeError(save.error)}</Flash>
  ) : null;
  const badge: ReactNode = save.isPending ? (
    <span className="acc-saved muted">Saving…</span>
  ) : saved ? (
    <span className="acc-saved good" role="status">
      <i data-icon={licon.Checkmark} aria-hidden /> Saved
    </span>
  ) : null;
  return { update, status, badge };
}

/** A starting position for the board preview: the Ruy Lopez after 3.Bb5. */
const PREVIEW_CONFIG: Config = {
  fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  lastMove: ['f1', 'b5'],
  viewOnly: true,
  coordinates: true,
  orientation: 'white',
  animation: { enabled: false },
};

export function AppearanceSection({ prefs }: { prefs: UserPrefs }) {
  const { update, status, badge } = usePrefSaver();
  return (
    <Box title="Appearance" level={2} actions={badge}>
      {status}
      <div className="acc-appearance">
        <div className="acc-appearance__controls">
          <fieldset className="form-group acc-fieldset">
            <legend className="acc-label">Site theme</legend>
            <div className="acc-themes">
              {THEMES.map(t => (
                <label key={t.value} className={['acc-theme', `acc-theme--${t.value}`, prefs.theme === t.value && 'active'].filter(Boolean).join(' ')}>
                  <input type="radio" name="theme" value={t.value} checked={prefs.theme === t.value} onChange={() => update({ theme: t.value })} />
                  <span className="acc-theme__swatch" aria-hidden>
                    <span className="acc-theme__bar" />
                    <span className="acc-theme__box">
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                  <span className="acc-theme__name">{t.label}</span>
                  <span className="acc-theme__help">{t.help}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group acc-fieldset">
            <legend className="acc-label">Board</legend>
            <div className="acc-tiles">
              {BOARD_THEMES.map((b: BoardTheme) => (
                <label key={b} className={['acc-tile', prefs.boardTheme === b && 'active'].filter(Boolean).join(' ')} title={BOARD_FILES[b].label}>
                  <input type="radio" name="board" value={b} checked={prefs.boardTheme === b} onChange={() => update({ boardTheme: b })} />
                  <img src={boardThumbnailUrl(b)} alt="" width={64} height={64} loading="lazy" />
                  <span className="acc-tile__name">{BOARD_FILES[b].label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group acc-fieldset">
            <legend className="acc-label">Pieces</legend>
            <div className="acc-tiles">
              {PIECE_SETS.map((set: PieceSet) => (
                <label
                  key={set}
                  className={['acc-tile', 'acc-tile--pieces', prefs.pieceSet === set && 'active'].filter(Boolean).join(' ')}
                  title={PIECE_SET_LABELS[set]}
                >
                  <input type="radio" name="pieces" value={set} checked={prefs.pieceSet === set} onChange={() => update({ pieceSet: set })} />
                  <span className="acc-tile__pieces" style={{ backgroundImage: `url('${boardThumbnailUrl(prefs.boardTheme)}')` }}>
                    <img src={pieceUrl(set, 'white', 'knight')} alt="" width={32} height={32} loading="lazy" />
                    <img src={pieceUrl(set, 'black', 'queen')} alt="" width={32} height={32} loading="lazy" />
                  </span>
                  <span className="acc-tile__name">{PIECE_SET_LABELS[set]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="form-group acc-fieldset">
            <legend className="acc-label">Sounds</legend>
            <div className="acc-sounds">
              <div className="acc-radio">
                {SOUND_SETS.map((set: SoundSet) => (
                  <label key={set} className={prefs.soundSet === set ? 'active' : undefined}>
                    <input
                      type="radio"
                      name="sound"
                      value={set}
                      checked={prefs.soundSet === set}
                      onChange={() => {
                        update({ soundSet: set });
                        playSound(set, 'Move');
                      }}
                    />
                    <span data-icon={set === 'silent' ? licon.Mute : licon.Voice}>{SOUND_SET_LABELS[set]}</span>
                  </label>
                ))}
              </div>
              <div className="acc-sounds__try">
                <Button variant="secondary" size="sm" icon={licon.PlayTriangle} disabled={prefs.soundSet === 'silent'} onClick={() => playSound(prefs.soundSet, 'Move')}>
                  Move
                </Button>
                <Button variant="secondary" size="sm" icon={licon.PlayTriangle} disabled={prefs.soundSet === 'silent'} onClick={() => playSound(prefs.soundSet, 'Capture')}>
                  Capture
                </Button>
                <Button variant="secondary" size="sm" icon={licon.PlayTriangle} disabled={prefs.soundSet === 'silent'} onClick={() => playSound(prefs.soundSet, 'Check')}>
                  Check
                </Button>
              </div>
            </div>
            <p className="acc-help">Used by the Studio and the live boards.</p>
          </fieldset>
        </div>

        <figure className="acc-appearance__preview">
          <Board config={PREVIEW_CONFIG} className="acc-preview-board" />
          <figcaption className="muted">
            {BOARD_FILES[prefs.boardTheme].label} board, {PIECE_SET_LABELS[prefs.pieceSet]} pieces
          </figcaption>
        </figure>
      </div>
    </Box>
  );
}

export function DisplaySection({ prefs }: { prefs: UserPrefs }) {
  const { update, status, badge } = usePrefSaver();
  const zone = browserTimeZone();
  const now = useMemo(() => Date.now(), []);
  return (
    <Box title="Display" level={2} actions={badge}>
      {status}
      <RadioGroup
        legend="Win / draw / loss colours"
        name="perspective"
        value={prefs.winratePerspective}
        onChange={v => update({ winratePerspective: v })}
        options={[
          { value: 'player', label: "Player's results" },
          { value: 'white', label: 'White / Black results' },
        ]}
        help={
          <div className="acc-wdl-demo">
            <div>
              <span className="acc-wdl-demo__label">Player's results: wins green, losses red</span>
              <WdlBar w={52} d={18} l={30} mode="player" />
            </div>
            <div>
              <span className="acc-wdl-demo__label">White / Black: like the Lichess explorer</span>
              <WdlBar w={52} d={18} l={30} mode="color" />
            </div>
          </div>
        }
      />
      <RadioGroup
        legend="Times and dates"
        name="timezone"
        value={prefs.timezone}
        onChange={v => update({ timezone: v })}
        options={[
          { value: 'local', label: 'This device', title: zone },
          { value: 'utc', label: 'UTC' },
        ]}
        help={
          <>
            Now: {timeFormat(prefs.timezone).dateTime(now)}
            {prefs.timezone === 'local' && <> ({zone})</>}
          </>
        }
      />
      <RadioGroup
        legend="Studio layout"
        name="studio-layout"
        value={prefs.studioLayout}
        onChange={v => update({ studioLayout: v })}
        options={STUDIO_LAYOUTS.map(l => ({ value: l, label: STUDIO_LAYOUT_LABELS[l].label, title: STUDIO_LAYOUT_LABELS[l].help }))}
        help={STUDIO_LAYOUT_LABELS[prefs.studioLayout].help}
      />
    </Box>
  );
}
