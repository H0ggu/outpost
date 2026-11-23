import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Openings tab, §6 GET /api/profiles/:slug/openings (most/best/worst, min/max moves, min games); click-through to the Explorer tab with `line`.
 * TODO(web-profile): replace this stub with the real page.
 */
export default function OpeningsPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Openings · ${slug}`} plan="§5 Openings tab, §6 GET /api/profiles/:slug/openings (most/best/worst, min/max moves, min games); click-through to the Explorer tab with `line`." />;
}
