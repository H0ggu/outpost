import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §6 PATCH/DELETE /api/profiles/:slug, sources add/remove/hide, visibility, slug, auto refresh (owner or admin).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function ProfileSettingsPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`Profile settings · ${slug}`} plan="§6 PATCH/DELETE /api/profiles/:slug, sources add/remove/hide, visibility, slug, auto refresh (owner or admin)." />;
}
