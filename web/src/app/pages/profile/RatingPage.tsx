import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Rating tab, §6 GET /api/profiles/:slug/rating (history per source and time class, averages over the last N games).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function RatingPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Rating · ${slug}`} plan="§5 Rating tab, §6 GET /api/profiles/:slug/rating (history per source and time class, averages over the last N games)." />;
}
