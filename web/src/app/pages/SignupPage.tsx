import { StubPage } from '../components/Page.tsx';

/**
 * Stub. PLAN §9 `/signup`, §6 POST /api/signup (SignupRequest; `?invite=` prefills the code; honour SessionInfo.signupMode).
 * TODO(web-other): replace this stub with the real page.
 */
export default function SignupPage() {
  return <StubPage title="Create account" plan="§9 `/signup`, §6 POST /api/signup (SignupRequest; `?invite=` prefills the code; honour SessionInfo.signupMode)." />;
}
