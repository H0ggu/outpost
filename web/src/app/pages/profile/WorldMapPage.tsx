import { useState } from 'react';
import type { WorldMapCountry } from '@outpost/shared/api';
import { useWorldMap } from '../../api/hooks.ts';
import { Box, countryName, EmptyState, ErrorBox, FlagEmoji, licon, Spinner, WdlBar } from '../../components/index.ts';
import { ScoreText, Segmented, StatTile } from './components/bits.tsx';
import { CategoryLegend, ScoreLegend, SeqLegend } from './components/charts/common.tsx';
import { WorldMap, type MapMetric } from './components/charts/WorldMap.tsx';
import { fmtInt, scoreOfWdl } from './format.ts';
import { oneOf, useProfile, useQueryParam } from './hooks.ts';

const METRICS = ['games', 'opponents', 'score', 'played'] as const;
const VIEWS = ['map', 'list'] as const;
type SortKey = 'games' | 'opponents' | 'score' | 'name';

/**
 * World map tab (PLAN §5, §6 `GET /api/profiles/:slug/worldmap`): a choropleth of opponents'
 * countries (games, opponents, score or played/not played), a tooltip per country, a country
 * list, and a note about opponents whose country is unknown or still being looked up.
 */
export default function WorldMapPage() {
  const { slug } = useProfile();
  const map = useWorldMap(slug, {});
  const [metric, setMetric] = useQueryParam<MapMetric>('show', oneOf(METRICS, 'games'), 'games');
  const [view, setView] = useQueryParam<(typeof VIEWS)[number]>('view', oneOf(VIEWS, 'map'), 'map');
  const [selected, setSelected] = useState<string | null>(null);

  const actions = (
    <div className="map-controls">
      <Segmented
        label="View"
        size="sm"
        value={view}
        options={[
          { value: 'map', label: 'Map', icon: licon.Globe },
          { value: 'list', label: 'List', icon: licon.List },
        ]}
        onChange={v => setView(v, { replace: true })}
      />
      {view === 'map' && (
        <Segmented
          label="Colour by"
          size="sm"
          value={metric}
          options={[
            { value: 'games', label: 'Games' },
            { value: 'opponents', label: 'Opponents' },
            { value: 'score', label: 'Score' },
            { value: 'played', label: 'Played' },
          ]}
          onChange={v => setMetric(v, { replace: true })}
        />
      )}
    </div>
  );

  let body;
  if (map.isPending) body = <Spinner center label="Loading the map" />;
  else if (map.isError) body = <ErrorBox error={map.error} onRetry={() => void map.refetch()} title="Could not load the world map" />;
  else {
    const m = map.data;
    const countries = m.countries.filter(c => c.games > 0);
    const knownGames = countries.reduce((n, c) => n + c.games, 0);
    const opponents = countries.reduce((n, c) => n + c.opponents, 0);
    body = (
      <>
        <div className="map-summary">
          <StatTile value={fmtInt(countries.length)} label="Countries" />
          <StatTile value={fmtInt(opponents)} label="Opponents" />
          <StatTile value={fmtInt(knownGames)} label="Games" />
        </div>
        {countries.length === 0 ? (
          <EmptyState icon={licon.Globe} title="No opponent countries yet">
            <p>Countries are looked up after games are imported; this can take a while for big profiles.</p>
          </EmptyState>
        ) : view === 'map' ? (
          <>
            <WorldMap countries={countries} metric={metric} highlight={selected} onSelect={setSelected} />
            <div className="map-legend">
              {metric === 'score' ? (
                <ScoreLegend />
              ) : metric === 'played' ? (
                <CategoryLegend
                  label="Countries played"
                  items={[
                    { label: 'Played', color: 'var(--c-seq-4)' },
                    { label: 'Not played', color: 'var(--c-map-land)' },
                  ]}
                />
              ) : (
                <SeqLegend label={metric === 'games' ? 'Games' : 'Opponents'} />
              )}
            </div>
            <CountryTable countries={countries} limit={10} selected={selected} onSelect={setSelected} />
          </>
        ) : (
          <CountryTable countries={countries} selected={selected} onSelect={setSelected} />
        )}
        <LookupNote unknownGames={m.unknownGames} pending={m.pendingLookups} />
      </>
    );
  }

  return (
    <Box title="World map" level={2} actions={actions} className="worldmap-box">
      {body}
    </Box>
  );
}

function LookupNote({ unknownGames, pending }: { unknownGames: number; pending: number }) {
  if (unknownGames === 0 && pending === 0) return null;
  return (
    <p className="map-note" data-icon={licon.InfoCircle}>
      {unknownGames > 0 && <>{fmtInt(unknownGames)} games are against opponents whose country is unknown. </>}
      {pending > 0 && <>{fmtInt(pending)} opponents are still queued for a country lookup, so the map fills in over time.</>}
    </p>
  );
}

function CountryTable({
  countries,
  limit,
  selected,
  onSelect,
}: {
  countries: readonly WorldMapCountry[];
  limit?: number;
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>('games');
  const sorted = [...countries].sort((a, b) => {
    switch (sort) {
      case 'name':
        return countryName(a.code).localeCompare(countryName(b.code));
      case 'opponents':
        return b.opponents - a.opponents || b.games - a.games;
      case 'score':
        return (scoreOfWdl(b) ?? 0) - (scoreOfWdl(a) ?? 0) || b.games - a.games;
      default:
        return b.games - a.games;
    }
  });
  const rows = limit ? sorted.slice(0, limit) : sorted;
  const th = (key: SortKey, label: string, cls?: string) => (
    <th className={cls} aria-sort={sort === key ? (key === 'name' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className={['th-sort', sort === key && 'active'].filter(Boolean).join(' ')} onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  );
  return (
    <div className="map-table">
      {limit && countries.length > limit && <h3 className="map-table__title">Top {limit} countries</h3>}
      <div className="table-wrap">
        <table className="slist">
          <thead>
            <tr>
              {th('name', 'Country')}
              {th('games', 'Games', 'num')}
              {th('opponents', 'Opponents', 'num map-opps')}
              <th className="map-wdl">Win / draw / loss</th>
              {th('score', 'Score', 'num')}
            </tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.code} className={['clickable', selected === c.code.toUpperCase() && 'selected'].filter(Boolean).join(' ')} tabIndex={0} onClick={() => onSelect(c.code.toUpperCase())} onKeyDown={e => e.key === 'Enter' && onSelect(c.code.toUpperCase())}>
                <td className="map-country-name">
                  <FlagEmoji code={c.code} /> {countryName(c.code)}
                </td>
                <td className="num">{fmtInt(c.games)}</td>
                <td className="num map-opps">{fmtInt(c.opponents)}</td>
                <td className="map-wdl">
                  <WdlBar w={c.w} d={c.d} l={c.l} />
                </td>
                <td className="num">
                  <ScoreText score={scoreOfWdl(c)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
