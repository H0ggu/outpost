import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/profiles/new`, §6 POST /api/profiles (CreateProfileRequest: several Lichess/Chess.com accounts, a FIDE id or a PGN database player).
 * TODO(web-other): replace this stub with the real page.
 */
export default function NewProfilePage() {
  return <StubPage title="New profile" plan="§9 `/profiles/new`, §6 POST /api/profiles (CreateProfileRequest: several Lichess/Chess.com accounts, a FIDE id or a PGN database player)." />;
}
