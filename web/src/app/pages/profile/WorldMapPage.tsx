import { useParams } from 'react-router';
import { StubPage } from '../../components/Page.tsx';

/**
 * Stub. PLAN §5 World Map tab, §6 GET /api/profiles/:slug/worldmap; d3-geo + world-atlas 110m + i18n-iso-countries (web-libs.md §6).
 * TODO(web-profile): replace this stub with the real page.
 */
export default function WorldMapPage() {
  const { slug = '' } = useParams();
  return <StubPage title={`World map · ${slug}`} plan="§5 World Map tab, §6 GET /api/profiles/:slug/worldmap; d3-geo + world-atlas 110m + i18n-iso-countries (web-libs.md §6)." />;
}
