import { useParams } from 'react-router';
import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/prep/:id`, §5 tournament preparation, §6 GET /api/prep/:id/report (PrepReport; printable).
 * TODO(web-other): replace this stub with the real page.
 */
export default function PrepPage() {
  const { id = '' } = useParams();
  return <StubPage title={`Prep report · ${id}`} plan="§9 `/prep/:id`, §5 tournament preparation, §6 GET /api/prep/:id/report (PrepReport; printable)." />;
}
