import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Activity tab, §6 GET /api/profiles/:slug/activity?tz= (calendar heatmap, by hour, by weekday, hour × weekday grid).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function ActivityPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Activity · ${slug}`} plan="§5 Activity tab, §6 GET /api/profiles/:slug/activity?tz= (calendar heatmap, by hour, by weekday, hour × weekday grid)." />;
}
