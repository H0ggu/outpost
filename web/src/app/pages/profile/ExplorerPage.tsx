import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { encodeFiltersSegment } from '@outpost/shared/filters';
import { useUrlFilters } from '../../api/hooks.ts';
import { licon } from '../../components/index.ts';
import { readEmbedMessage, type EmbedPositionMessage } from '../../explorerEmbed.ts';
import { paths } from '../../paths.ts';
import { Segmented } from './components/bits.tsx';
import { fmtInt, fmtLine } from './format.ts';
import { useProfile } from './hooks.ts';
import { studioExplorerLink } from './links.ts';

/**
 * Explorer tab (PLAN §5, §8.4): lila's analysis board from the Studio, embedded with minimal
 * chrome (`/studio?embed=explorer&explorer=player:<slug>&color=…&filters=<segment>`), so the
 * opening explorer reads this profile's games with the current filters. A colour toggle
 * switches sides; a `line` filter (e.g. from the Openings tab) also opens the board there.
 *
 * The embed reports where its board is (`explorerEmbed.ts`), so "Open in Studio" and the games
 * link follow the board without reloading it; the explorer's "All N games" opens the Games tab
 * at that line (the same filters, so the same games).
 */
export default function ExplorerPage() {
  const { slug } = useProfile();
  const navigate = useNavigate();
  const [filters, setFilters] = useUrlFilters();
  const color = filters.color ?? 'white';
  const src = studioExplorerLink(slug, color, filters, true);
  const [loaded, setLoaded] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // Where the embedded board is, for the frame it came from (a new `src` starts over).
  const [board, setBoard] = useState<{ src: string; at: EmbedPositionMessage } | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (e.origin !== window.location.origin || !own || e.source !== own) return;
      const m = readEmbedMessage(e.data);
      if (!m) return;
      if (m.type === 'outpost:position') setBoard({ src, at: m });
      else if (m.player === slug) navigate(paths.profile(slug, 'games', { ...filters, color: m.color, line: m.line.length ? m.line : undefined }));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, slug, filters, navigate]);

  const at = board?.src === src ? board.at : null;
  // The board's moves when it reports them (null: a line too long or from a set-up position), else the filter's.
  const line = at ? at.line : (filters.line ?? []);
  const games = at && at.player === slug && at.color === color ? at.games : null;
  const studioHref =
    at && line === null
      ? paths.studio({ explorer: `player:${slug}`, color, fen: at.fen, filters: encodeFiltersSegment({ ...filters, line: undefined }) })
      : studioExplorerLink(slug, color, { ...filters, line: line?.length ? line : undefined }, false);

  return (
    <section className="box profile-explorer">
      <div className="profile-explorer__bar">
        <Segmented
          label="Explore the games as"
          size="sm"
          value={color}
          options={[
            { value: 'white', label: <><span className="color-dot color-dot--white" aria-hidden /> As White</> },
            { value: 'black', label: <><span className="color-dot color-dot--black" aria-hidden /> As Black</> },
          ]}
          onChange={c => setFilters({ ...filters, color: c })}
        />
        {line?.length ? (
          <span className="profile-explorer__line">
            {at ? 'at' : 'from'} <span className="san">{fmtLine(line)}</span>
          </span>
        ) : null}
        {line !== null && (
          <Link
            className="button button-empty button-thin profile-explorer__games"
            to={paths.profile(slug, 'games', { ...filters, color, line: line.length ? line : undefined })}
            data-icon={licon.List}
            title="The games of this profile that reach the board's position, with these filters"
          >
            {games === null ? 'Games at this position' : games === 1 ? '1 game at this position' : `${fmtInt(games)} games at this position`}
          </Link>
        )}
        <a className="button button-empty button-thin profile-explorer__open" href={studioHref} data-icon={licon.Expand}>
          Open in Studio
        </a>
      </div>
      <div className="profile-explorer__frame-wrap">
        {loaded !== src && (
          <div className="profile-explorer__loading" aria-hidden>
            <span className="spinner" />
          </div>
        )}
        <iframe
          ref={frame}
          key={src}
          className="profile-explorer__frame"
          src={src}
          title="Opening explorer"
          onLoad={() => setLoaded(src)}
        />
      </div>
    </section>
  );
}
