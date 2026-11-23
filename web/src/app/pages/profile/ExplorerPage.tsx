import { useState } from 'react';
import { useUrlFilters } from '../../api/hooks.ts';
import { licon } from '../../components/index.ts';
import { Segmented } from './components/bits.tsx';
import { fmtLine } from './format.ts';
import { useProfile } from './hooks.ts';
import { studioExplorerLink } from './links.ts';

/**
 * Explorer tab (PLAN §5, §8.4): lila's analysis board from the Studio, embedded with minimal
 * chrome (`/studio?embed=explorer&explorer=player:<slug>&color=…&filters=<segment>`), so the
 * opening explorer reads this profile's games with the current filters. A colour toggle
 * switches sides; a `line` filter (e.g. from the Openings tab) also opens the board there.
 */
export default function ExplorerPage() {
  const { slug } = useProfile();
  const [filters, setFilters] = useUrlFilters();
  const color = filters.color ?? 'white';
  const src = studioExplorerLink(slug, color, filters, true);
  const [loaded, setLoaded] = useState<string | null>(null);

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
        {filters.line?.length ? (
          <span className="profile-explorer__line">
            from <span className="san">{fmtLine(filters.line)}</span>
          </span>
        ) : null}
        <a className="button button-empty button-thin profile-explorer__open" href={studioExplorerLink(slug, color, filters, false)} data-icon={licon.Expand}>
          Open in Studio
        </a>
      </div>
      <div className="profile-explorer__frame-wrap">
        {loaded !== src && (
          <div className="profile-explorer__loading" aria-hidden>
            <span className="spinner" />
          </div>
        )}
        <iframe key={src} className="profile-explorer__frame" src={src} title="Opening explorer" onLoad={() => setLoaded(src)} />
      </div>
    </section>
  );
}
