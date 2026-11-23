import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Overview tab, §6 GET /api/profiles/:slug/overview (OverviewStats).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function OverviewPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Overview · ${slug}`} plan="§5 Overview tab, §6 GET /api/profiles/:slug/overview (OverviewStats)." />;
}
