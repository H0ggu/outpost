/**
 * Choropleth of opponents' countries (World map tab): d3-geo Equal Earth projection of
 * world-atlas 110m (Natural Earth, public domain) through topojson-client. Atlas ids are ISO
 * 3166-1 numeric codes, mapped to alpha-2 with i18n-iso-countries' code table; Kosovo has no id
 * and is matched by name. Countries too small for the 110m atlas are drawn as dots.
 */
import { geoEqualEarth, geoPath } from 'd3-geo';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import isoCodes from 'i18n-iso-countries/codes.json';
import { useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import worldTopo from 'world-atlas/countries-110m.json';
import type { WorldMapCountry } from '@outpost/shared/api';
import { countryName, flagEmoji } from '../../../../components/index.ts';
import { fmtInt, fmtPct, scoreOfWdl } from '../../format.ts';
import { useElementWidth } from '../../hooks.ts';
import { ChartTooltip, scoreBin, scoreColor, seqBin, seqColor, TipRow, type TooltipState } from './common.tsx';

/** What the colours show. */
export type MapMetric = 'games' | 'opponents' | 'score' | 'played';

const NUMERIC_TO_ALPHA2 = new Map((isoCodes as string[][]).map(c => [c[2]!, c[0]!]));
/** Atlas shapes without an ISO id. */
const NAMED_SHAPES: Readonly<Record<string, string>> = { Kosovo: 'XK', 'N. Cyprus': 'CY', Somaliland: 'SO' };

/** Approximate centres (lon, lat) of countries missing from the 110m atlas. */
export const SMALL_COUNTRIES: Readonly<Record<string, readonly [number, number]>> = {
  AD: [1.52, 42.51], AG: [-61.8, 17.07], AI: [-63.05, 18.22], AS: [-170.7, -14.3], AW: [-69.97, 12.52],
  AX: [19.9, 60.2], BB: [-59.55, 13.17], BH: [50.55, 26.07], BL: [-62.83, 17.9], BM: [-64.75, 32.3],
  BQ: [-68.26, 12.17], CK: [-159.78, -21.24], CV: [-23.6, 15.1], CW: [-68.99, 12.17], DM: [-61.37, 15.42],
  FM: [158.2, 6.9], FO: [-6.9, 62.0], GD: [-61.68, 12.12], GF: [-53.1, 3.93], GG: [-2.58, 49.45],
  GI: [-5.35, 36.14], GP: [-61.55, 16.25], GU: [144.79, 13.44], HK: [114.17, 22.32], IM: [-4.53, 54.23],
  JE: [-2.13, 49.21], KI: [173.0, 1.42], KM: [43.33, -11.7], KN: [-62.75, 17.3], KY: [-81.25, 19.31],
  LC: [-60.98, 13.9], LI: [9.55, 47.16], MC: [7.42, 43.74], MF: [-63.06, 18.08], MH: [171.2, 7.1],
  MO: [113.55, 22.17], MP: [145.75, 15.18], MQ: [-61.0, 14.64], MS: [-62.19, 16.74], MT: [14.4, 35.9],
  MU: [57.55, -20.25], MV: [73.5, 4.17], NF: [167.95, -29.03], NR: [166.93, -0.52], NU: [-169.87, -19.05],
  PF: [-149.4, -17.65], PM: [-56.3, 46.9], PW: [134.58, 7.5], RE: [55.53, -21.13], SC: [55.45, -4.68],
  SG: [103.82, 1.35], SH: [-5.7, -15.95], SM: [12.46, 43.94], ST: [6.6, 0.2], SX: [-63.05, 18.04],
  TC: [-71.8, 21.8], TO: [-175.2, -21.2], TV: [179.2, -8.52], VA: [12.45, 41.9], VC: [-61.2, 13.25],
  VG: [-64.62, 18.42], VI: [-64.9, 18.34], WF: [-176.2, -13.3], WS: [-172.1, -13.75], YT: [45.15, -12.8],
};

interface Shape {
  code: string | null;
  name: string;
  feature: Feature<Geometry, { name: string }>;
}

/** Country shapes (without Antarctica), parsed once. */
let shapesCache: Shape[] | null = null;
function countryShapes(): Shape[] {
  if (shapesCache) return shapesCache;
  const topo = worldTopo as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>;
  shapesCache = fc.features
    .filter(f => f.id !== '010')
    .map(f => ({
      code: (f.id !== undefined ? NUMERIC_TO_ALPHA2.get(String(f.id)) : NAMED_SHAPES[f.properties.name]) ?? NAMED_SHAPES[f.properties.name] ?? null,
      name: f.properties.name,
      feature: f,
    }));
  return shapesCache;
}

/** Alpha-2 codes that have a polygon in the atlas. */
export function atlasCodes(): Set<string> {
  return new Set(countryShapes().flatMap(s => (s.code ? [s.code] : [])));
}

/** Fill of a country for the selected metric. */
function fillFor(metric: MapMetric, c: WorldMapCountry | undefined, max: number): string {
  if (!c || c.games === 0) return 'var(--c-map-land)';
  switch (metric) {
    case 'games':
      return seqColor(seqBin(c.games, max));
    case 'opponents':
      return seqColor(seqBin(c.opponents, max));
    case 'score':
      return scoreColor(scoreBin(scoreOfWdl(c)));
    case 'played':
      return seqColor(4);
  }
}

/** Tooltip body for a country. */
function CountryTip({ code, c }: { code: string; c: WorldMapCountry | undefined }) {
  return (
    <>
      <div className="chart-tip__title">
        {flagEmoji(code) && <span className="flag">{flagEmoji(code)}</span>} {countryName(code)}
      </div>
      {c ? (
        <>
          <TipRow label="Games" value={fmtInt(c.games)} />
          <TipRow label="Opponents" value={fmtInt(c.opponents)} />
          <TipRow label="W / D / L" value={`${c.w} / ${c.d} / ${c.l}`} />
          <TipRow label="Score" value={fmtPct(scoreOfWdl(c))} />
        </>
      ) : (
        <div className="muted">No games</div>
      )}
    </>
  );
}

/** Props of `WorldMap`. */
export interface WorldMapProps {
  countries: readonly WorldMapCountry[];
  metric: MapMetric;
  /** Highlight one country (e.g. hovered in the list). */
  highlight?: string | null;
  onSelect?: (code: string) => void;
}

/** The choropleth, filling its container's width. */
export function WorldMap({ countries, metric, highlight, onSelect }: WorldMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 800);
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<TooltipState | null>(null);

  const byCode = useMemo(() => new Map(countries.map(c => [c.code.toUpperCase(), c])), [countries]);
  const max = Math.max(1, ...countries.map(c => (metric === 'opponents' ? c.opponents : c.games)));

  const geo = useMemo(() => {
    const shapes = countryShapes();
    const collection: FeatureCollection = { type: 'FeatureCollection', features: shapes.map(s => s.feature) };
    const projection = geoEqualEarth().fitWidth(width - 4, collection);
    const path = geoPath(projection);
    const [[, y0], [, y1]] = path.bounds(collection);
    projection.translate([projection.translate()[0] + 2, projection.translate()[1] - y0 + 2]);
    return {
      height: Math.ceil(y1 - y0 + 4),
      shapes: shapes.map(s => ({ ...s, d: path(s.feature) ?? '' })),
      project: (lonLat: readonly [number, number]) => projection([lonLat[0], lonLat[1]]),
    };
  }, [width]);

  const present = useMemo(() => new Set(geo.shapes.flatMap(s => (s.code ? [s.code] : []))), [geo]);
  const dots = countries
    .filter(c => !present.has(c.code.toUpperCase()) && SMALL_COUNTRIES[c.code.toUpperCase()])
    .map(c => {
      const p = geo.project(SMALL_COUNTRIES[c.code.toUpperCase()]!);
      return p ? { code: c.code.toUpperCase(), x: p[0], y: p[1], c } : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  const show = (code: string | null, e: { clientX: number; clientY: number }) => {
    if (!code) {
      setHover(null);
      setTip(null);
      return;
    }
    const rect = ref.current?.getBoundingClientRect();
    setHover(code);
    setTip({
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0) - 10,
      content: <CountryTip code={code} c={byCode.get(code)} />,
    });
  };

  const active = hover ?? highlight ?? null;

  return (
    <div ref={ref} className="chart world-map">
      <svg
        width={width}
        height={geo.height}
        role="img"
        aria-label="Opponents by country"
        onPointerLeave={() => {
          setHover(null);
          setTip(null);
        }}
      >
        {geo.shapes.map((s, i) => (
          <path
            key={s.code ?? `x${i}`}
            d={s.d}
            className={['map-country', s.code && byCode.has(s.code) && 'has-data', s.code !== null && s.code === active && 'active'].filter(Boolean).join(' ')}
            style={{ fill: fillFor(metric, s.code ? byCode.get(s.code) : undefined, max) }}
            onPointerMove={e => show(s.code, e)}
            onClick={e => {
              show(s.code, e);
              if (s.code && byCode.has(s.code)) onSelect?.(s.code);
            }}
          />
        ))}
        {dots.map(d => (
          <circle
            key={d.code}
            className={['map-dot', d.code === active && 'active'].filter(Boolean).join(' ')}
            cx={d.x}
            cy={d.y}
            r={4}
            style={{ fill: fillFor(metric, d.c, max) }}
            onPointerMove={e => show(d.code, e)}
            onClick={e => {
              show(d.code, e);
              onSelect?.(d.code);
            }}
          />
        ))}
      </svg>
      <ChartTooltip tip={tip} width={width} />
    </div>
  );
}
