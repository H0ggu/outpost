import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Opponents tab, §6 /opponents (most played, titled) and /behaviour (win/draw/loss terminations).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function OpponentsPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Opponents · ${slug}`} plan="§5 Opponents tab, §6 /opponents (most played, titled) and /behaviour (win/draw/loss terminations)." />;
}
