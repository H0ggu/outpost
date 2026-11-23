import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 Explorer tab: iframe of the Studio with the player explorer (studioPlayerExplorer(slug, color, filters, true)); filters bar.
 * TODO(web-profile): replace this stub with the real page.
 */
export default function ExplorerPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Explorer · ${slug}`} plan="§5 Explorer tab: iframe of the Studio with the player explorer (studioPlayerExplorer(slug, color, filters, true)); filters bar." />;
}
