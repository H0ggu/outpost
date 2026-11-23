import { useParams } from 'react-router';
import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/databases/:id`, §6 database detail, games list, PGN import (multipart or paste), export, delete.
 * TODO(web-other): replace this stub with the real page.
 */
export default function DatabasePage() {
  const { id = '' } = useParams();
  return <StubPage title={`Database · ${id}`} plan="§9 `/databases/:id`, §6 database detail, games list, PGN import (multipart or paste), export, delete." />;
}
