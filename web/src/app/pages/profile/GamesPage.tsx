import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Games tab, §6 GET /api/profiles/:slug/games (GamesPage, 20 per page) and games.pgn export; filters bar.
 * TODO(web-profile): replace this stub with the real page.
 */
export default function GamesPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Games · ${slug}`} plan="§5 Games tab, §6 GET /api/profiles/:slug/games (GamesPage, 20 per page) and games.pgn export; filters bar." />;
}
