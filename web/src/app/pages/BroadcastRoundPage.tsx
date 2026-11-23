import { useParams } from 'react-router';
import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/broadcasts/:roundId`, §6 GET /api/broadcasts/round/:roundId polled every 10 s: grid of live mini-boards; a game opens in the Studio.
 * TODO(web-other): replace this stub with the real page.
 */
export default function BroadcastRoundPage() {
  const { roundId = '' } = useParams();
  return <StubPage title={`Broadcast round · ${roundId}`} plan="§9 `/broadcasts/:roundId`, §6 GET /api/broadcasts/round/:roundId polled every 10 s: grid of live mini-boards; a game opens in the Studio." />;
}
