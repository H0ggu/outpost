/**
 * `/settings` (PLAN §9; §6 /api/me/*): the signed-in user's preferences and account, in lila's
 * account-page layout (side menu, one section at a time, `?section=` in the URL):
 *   - Appearance: site theme (true black, dark, light — applied live), board, pieces, sounds;
 *   - Display: W/D/L perspective, time zone, Studio layout;
 *   - Password, Two-factor authentication (TOTP), Sessions.
 */
import { useSearchParams } from 'react-router';
import { useSession } from '../api/hooks.ts';
import { ErrorBox, licon, Page, Spinner } from '../components/index.ts';
import { paths } from '../paths.ts';
import { PasswordSection, SessionsSection, TotpSection } from './components/account/AccountSections.tsx';
import { SignInPrompt } from './components/account/misc.tsx';
import { PageMenu } from './components/account/PageMenu.tsx';
import { AppearanceSection, DisplaySection } from './components/account/PrefsSections.tsx';

/** Sections of the settings page, in menu order. */
const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: licon.Tshirt },
  { id: 'display', label: 'Display', icon: licon.ScreenDesktop },
  { id: 'password', label: 'Password', icon: licon.Padlock },
  { id: 'two-factor', label: 'Two-factor', icon: licon.Shield },
  { id: 'sessions', label: 'Sessions', icon: licon.PhoneMobile },
] as const;

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

const sectionHref = (id: SectionId): string => (id === 'appearance' ? paths.settings : `${paths.settings}?section=${id}`);

export default function SettingsPage() {
  const session = useSession();
  const [params] = useSearchParams();
  const requested = params.get('section');
  const section: SectionId = SETTINGS_SECTIONS.some(s => s.id === requested) ? (requested as SectionId) : 'appearance';

  if (session.isPending) return <Spinner center />;
  if (session.isError)
    return (
      <Page title="Settings">
        <ErrorBox error={session.error} onRetry={() => void session.refetch()} />
      </Page>
    );
  const user = session.data.user;
  if (!user) return <SignInPrompt title="Settings">Your preferences and account settings are saved with your account.</SignInPrompt>;

  const title = SETTINGS_SECTIONS.find(s => s.id === section)!.label;
  return (
    <Page title={`${title} · Settings`}>
      <PageMenu
        label="Settings sections"
        items={SETTINGS_SECTIONS.map(s => ({ to: sectionHref(s.id), label: s.label, icon: s.icon, active: s.id === section }))}
      >
        {section === 'appearance' && <AppearanceSection prefs={user.prefs} />}
        {section === 'display' && <DisplaySection prefs={user.prefs} />}
        {section === 'password' && <PasswordSection username={user.username} />}
        {section === 'two-factor' && <TotpSection user={user} />}
        {section === 'sessions' && <SessionsSection />}
      </PageMenu>
    </Page>
  );
}
