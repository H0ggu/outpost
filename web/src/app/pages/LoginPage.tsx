import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/login`, §6 POST /api/login (LoginRequest; ask for a TOTP code on 401 totp_required), then go to `?next=`.
 * TODO(web-other): replace this stub with the real page.
 */
export default function LoginPage() {
  return <StubPage title="Sign in" plan="§9 `/login`, §6 POST /api/login (LoginRequest; ask for a TOTP code on 401 totp_required), then go to `?next=`." />;
}
