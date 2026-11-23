import { Link } from 'react-router';
import type { BroadcastSummary } from '@outpost/shared/api';
import { Box, EmptyState, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { BroadcastError, formatTourDates, RoundStatusPill } from './components/library/broadcast.tsx';
import { useBroadcasts } from './library-hooks.ts';
import './components/library/library.css';
import './BroadcastsPage.css';

/** The round a tour card opens: Lichess's default, else the live one, else the latest started. */
export function defaultRound(b: BroadcastSummary) {
  return (
    b.rounds.find(r => r.id === b.defaultRoundId) ??
    b.rounds.find(r => r.ongoing) ??
    [...b.rounds].reverse().find(r => r.finished) ??
    b.rounds[0] ??
    null
  );
}

/** Lichess broadcast tiers (lila RelayTour.Tier): 5 best, 4 high, 3 normal. */
const tierLabel = (tier: number | null): string | null => (tier === null ? null : tier >= 5 ? 'Top tier' : tier === 4 ? 'High tier' : null);

/** Plain text from a tour description (which may contain Markdown), shortened. */
export function shortDescription(text: string | null, max = 220): string | null {
  if (!text) return null;
  const plain = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/**
 * PLAN §9 `/broadcasts`, §5 live broadcasts, §6 GET /api/broadcasts: official Lichess broadcasts,
 * ongoing first then recent, each with its rounds; a round opens the live boards. Without a Lichess
 * token on the server the page says so plainly.
 */
export default function BroadcastsPage() {
  const q = useBroadcasts();
  return (
    <Page title="Broadcasts">
      <Box title="Broadcasts">
        <p className="lib-lead">Official over-the-board events relayed by Lichess, with live boards and clocks.</p>
        {q.data ? (
          q.data.active.length + q.data.recent.length === 0 ? (
            <EmptyState icon={licon.RadioTower} title="No official broadcasts right now">
              <p>Check back when the next tournament starts.</p>
            </EmptyState>
          ) : (
            <>
              {q.data.active.length > 0 && <TourList title="Ongoing" tours={q.data.active} />}
              {q.data.recent.length > 0 && <TourList title="Recent" tours={q.data.recent} />}
            </>
          )
        ) : q.isError ? (
          <BroadcastError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Spinner center />
        )}
      </Box>
    </Page>
  );
}

function TourList({ title, tours }: { title: string; tours: readonly BroadcastSummary[] }) {
  return (
    <section className="lib-tours">
      <h2 className="lib-section-title">
        {title} <span className="lib-count">{tours.length}</span>
      </h2>
      <ul className="lib-tours__list">
        {tours.map(t => (
          <TourCard key={t.tour.id} b={t} />
        ))}
      </ul>
    </section>
  );
}

function TourCard({ b }: { b: BroadcastSummary }) {
  const main = defaultRound(b);
  const dates = formatTourDates(b.tour.dates);
  const tier = tierLabel(b.tour.tier);
  const info = [dates, b.tour.info.location, b.tour.info.fideTC ?? b.tour.info.tc, b.tour.info.format].filter(Boolean);
  const desc = shortDescription(b.tour.description);
  return (
    <li className={b.live ? 'lib-tour lib-tour--live' : 'lib-tour'}>
      <div className="lib-tour__head">
        {main ? (
          <Link to={paths.broadcastRound(main.id)} className="lib-tour__name">
            {b.tour.name}
          </Link>
        ) : (
          <span className="lib-tour__name">{b.tour.name}</span>
        )}
        {b.live && (
          <span className="lib-pill lib-pill--live">
            <span className="lib-live-dot" aria-hidden /> Live
          </span>
        )}
        {tier && (
          <span className="lib-pill" data-icon={licon.Star}>
            {tier}
          </span>
        )}
      </div>
      {info.length > 0 && <div className="lib-tour__info">{info.join(' · ')}</div>}
      {b.tour.info.players && <div className="lib-tour__players">{b.tour.info.players}</div>}
      {desc && <p className="lib-tour__desc">{desc}</p>}
      {b.rounds.length > 0 && (
        <nav className="lib-rounds" aria-label={`${b.tour.name} rounds`}>
          {b.rounds.map(r => (
            <Link
              key={r.id}
              to={paths.broadcastRound(r.id)}
              className={['lib-round', r.ongoing && 'lib-round--live', r.finished && 'lib-round--done'].filter(Boolean).join(' ')}
              title={r.ongoing ? 'Live now' : r.finished ? 'Finished' : 'Not started'}
            >
              {r.ongoing && <span className="lib-live-dot" aria-hidden />}
              {r.name}
            </Link>
          ))}
        </nav>
      )}
      {main && main.ongoing && (
        <div className="lib-tour__status">
          <RoundStatusPill round={main} /> <span className="muted">{main.name}</span>
        </div>
      )}
    </li>
  );
}
