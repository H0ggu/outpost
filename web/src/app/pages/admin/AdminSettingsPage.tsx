/**
 * `/admin/settings` (PLAN §3, §6 GET/PUT /api/admin/settings; GET /api/admin/status): instance
 * settings — sign-up mode, anonymous browsing, the Lichess token (write-only: shown masked, env
 * wins), the Chess.com contact, auto-refresh hour, update cooldown, initial sync months, masters
 * source and broadcast auto-import — saved together (changed fields only), then the status panel.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import type { AdminSettings, MastersSource, SignupMode } from '@outpost/shared/api';
import { Box, Button, ErrorBox, licon, Spinner, useDocumentTitle } from '../../components/index.ts';
import { paths } from '../../paths.ts';
import { useAdminSettings, useReferenceInfo, useUpdateAdminSettings } from '../account-hooks.ts';
import { draftOf, MAX_COOLDOWN, MAX_MONTHS, settingsPatch, settingsProblems, type Draft } from '../components/account/adminSettings.ts';
import { formatCount, hourLabel, localHourOfUtc } from '../components/account/format.ts';
import { Field, Flash, formErrors, RadioGroup, TextField, Toggle, useTransient } from '../components/account/forms.tsx';
import { StatusPanel } from '../components/account/StatusPanel.tsx';
import './admin.css';

const SIGNUP_HELP: Record<SignupMode, string> = {
  closed: 'Only admins add accounts (with an invite link from the Users page).',
  invite: 'Anyone with an invite code can create an account.',
  open: 'Anyone who can reach this Outpost can create an account.',
};

export default function AdminSettingsPage() {
  useDocumentTitle('Settings · Admin');
  const settings = useAdminSettings();
  const location = useLocation();
  const [saved, flashSaved] = useTransient<number>(4000);

  useEffect(() => {
    if (location.hash === '#status' && settings.data) document.getElementById('status')?.scrollIntoView({ block: 'start' });
  }, [location.hash, settings.data]);

  return (
    <>
      {settings.isPending ? (
        <Box title="Instance settings" level={2}>
          <Spinner center />
        </Box>
      ) : settings.isError ? (
        <Box title="Instance settings" level={2}>
          <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
        </Box>
      ) : (
        // Re-keyed by the server's answer after a save: a fresh draft and an empty token field.
        <SettingsForm key={settings.dataUpdatedAt} settings={settings.data} saved={saved !== null} onSaved={() => flashSaved(Date.now())} />
      )}
      <StatusPanel />
    </>
  );
}

function SettingsForm({ settings, saved, onSaved }: { settings: AdminSettings; saved: boolean; onSaved: () => void }) {
  const update = useUpdateAdminSettings();
  const reference = useReferenceInfo();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));

  const patch = useMemo(() => settingsPatch(settings, draft), [settings, draft]);
  const dirty = Object.keys(patch).length > 0;
  const { field, form } = formErrors(
    update.error,
    ['signupMode', 'anonymousBrowsing', 'lichessToken', 'chesscomContact', 'autoRefreshHourUtc', 'updateCooldownMinutes', 'initialSyncMonths', 'mastersSource', 'broadcastAutoImport'],
    problems,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = settingsProblems(draft);
    setProblems(p);
    if (Object.keys(p).length || !dirty) return;
    // Not `mutate(patch, { onSuccess })`: the saved settings re-key this form before the hook's
    // refetches finish, and per-call callbacks of an unmounted form never run. The promise still
    // settles, and `onSaved` belongs to the page, which stays. Failures show through `update.error`.
    update.mutateAsync(patch).then(onSaved, () => undefined);
  };

  const referenceDbs = reference.data?.databases ?? [];
  const mastersKnown = settings.mastersSource === 'lichess' || referenceDbs.some(d => `reference:${d.id}` === settings.mastersSource);
  const token = settings.lichessToken;

  return (
    <Box title="Instance settings" level={2}>
      {saved && <Flash>Settings saved.</Flash>}
      <form onSubmit={submit} noValidate className="acc-form adm-settings" aria-label="Instance settings">
        <section className="adm-section" aria-labelledby="adm-access">
          <h3 id="adm-access">Access</h3>
          <RadioGroup
            legend="Sign-up"
            name="signupMode"
            value={draft.signupMode}
            onChange={v => set('signupMode', v)}
            options={[
              { value: 'closed', label: 'Closed', icon: licon.Padlock },
              { value: 'invite', label: 'Invite only', icon: licon.Envelope },
              { value: 'open', label: 'Open', icon: licon.Group },
            ]}
            help={SIGNUP_HELP[draft.signupMode]}
            error={field.signupMode}
          />
          <Toggle
            label="Anonymous browsing"
            checked={draft.anonymousBrowsing}
            onChange={v => set('anonymousBrowsing', v)}
            help="Visitors without an account may read public profiles and their statistics. Everything else still needs an account."
          />
        </section>

        <section className="adm-section" aria-labelledby="adm-upstream">
          <h3 id="adm-upstream">Lichess and Chess.com</h3>
          <Field
            id="adm-token"
            label="Lichess API token"
            error={field.lichessToken}
            help={
              token.fromEnv ? (
                <>
                  Set by <code>LICHESS_TOKEN</code> in the server environment, which overrides this setting. Change it there and
                  restart Outpost.
                </>
              ) : (
                <>
                  Needed for the Lichess opening explorer, the player explorer and live broadcasts; it also speeds up game imports.
                  Create a personal token at{' '}
                  <a href="https://lichess.org/account/oauth/token" target="_blank" rel="noreferrer noopener">
                    lichess.org/account/oauth/token
                  </a>{' '}
                  (no scopes needed; <code>study:read</code> recommended). It is never shown again or sent to browsers.
                </>
              )
            }
          >
            <div className="adm-secret">
              <span className={token.set && !draft.clearToken ? 'adm-secret__value' : 'adm-secret__value muted'}>
                {draft.clearToken ? 'Will be removed' : token.set ? (token.masked ?? 'Set') : 'Not set'}
                {token.fromEnv && <span className="acc-badge acc-badge--queued">env</span>}
              </span>
              {token.fromEnv && (
                // Read-only stand-in, so the label still names a control.
                <input id="adm-token" className="form-control" value="Set in the environment" readOnly disabled aria-describedby="adm-token-help" />
              )}
              {!token.fromEnv && (
                <>
                  <input
                    id="adm-token"
                    type="password"
                    className="form-control"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={token.set ? 'Paste a new token to replace it' : 'lip_…'}
                    value={draft.tokenInput}
                    aria-invalid={field.lichessToken ? true : undefined}
                    aria-describedby="adm-token-help"
                    onChange={e => {
                      set('tokenInput', e.target.value);
                      if (e.target.value) set('clearToken', false);
                    }}
                  />
                  {token.set && (
                    <Button
                      variant={draft.clearToken ? 'secondary' : 'empty'}
                      size="sm"
                      icon={draft.clearToken ? licon.Back : licon.Trash}
                      onClick={() => {
                        set('clearToken', !draft.clearToken);
                        set('tokenInput', '');
                      }}
                    >
                      {draft.clearToken ? 'Keep token' : 'Remove token'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </Field>
          {settings.chesscomContactFromEnv ? (
            <Field
              id="adm-contact"
              label="Chess.com contact"
              help={
                <>
                  Set by <code>CHESSCOM_CONTACT</code> in the server environment, which overrides this setting.
                </>
              }
            >
              <input id="adm-contact" className="form-control" value={settings.chesscomContact ?? ''} readOnly disabled aria-describedby="adm-contact-help" />
            </Field>
          ) : (
            <TextField
              id="adm-contact"
              label="Chess.com contact"
              placeholder="an e-mail address or a URL"
              autoComplete="off"
              value={draft.chesscomContact}
              onChange={e => set('chesscomContact', e.target.value)}
              error={field.chesscomContact}
              help="Sent in the User-Agent of requests to Chess.com and Lichess, so they can reach the operator. Chess.com refuses anonymous clients; leave it empty and Chess.com syncs may fail."
            />
          )}
        </section>

        <section className="adm-section" aria-labelledby="adm-sync">
          <h3 id="adm-sync">Updates</h3>
          <div className="adm-row">
            <Field
              id="adm-hour"
              label="Daily auto-refresh"
              error={field.autoRefreshHourUtc}
              help={`Profiles with auto-refresh on are updated once a day at this hour (UTC): ${hourLabel(localHourOfUtc(draft.autoRefreshHourUtc))} in your time zone.`}
            >
              <select
                id="adm-hour"
                className="form-control"
                value={draft.autoRefreshHourUtc}
                aria-describedby="adm-hour-help"
                onChange={e => set('autoRefreshHourUtc', Number(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)} UTC
                  </option>
                ))}
              </select>
            </Field>
            <TextField
              id="adm-cooldown"
              label="Update cooldown (minutes)"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_COOLDOWN}
              step={1}
              value={draft.updateCooldownMinutes}
              onChange={e => set('updateCooldownMinutes', e.target.value)}
              error={field.updateCooldownMinutes}
              help="Minimum time between two manual updates of the same profile. 0 = no limit."
            />
            <TextField
              id="adm-months"
              label="First import (months)"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_MONTHS}
              step={1}
              value={draft.initialSyncMonths}
              onChange={e => set('initialSyncMonths', e.target.value)}
              error={field.initialSyncMonths}
              help="How far back a newly added account is imported. 0 = its whole history."
            />
          </div>
        </section>

        <section className="adm-section" aria-labelledby="adm-explorer">
          <h3 id="adm-explorer">Explorer</h3>
          <Field
            id="adm-masters"
            label="Masters database"
            error={field.mastersSource}
            help={
              <>
                What the Studio's “Masters” explorer shows: the Lichess masters database, or a local reference database (from the{' '}
                <Link to={paths.admin.reference}>Reference DB</Link> page).
              </>
            }
          >
            <select
              id="adm-masters"
              className="form-control"
              value={draft.mastersSource}
              aria-describedby="adm-masters-help"
              onChange={e => set('mastersSource', e.target.value as MastersSource)}
            >
              <option value="lichess">Lichess masters (explorer.lichess.org)</option>
              {referenceDbs.map(db => (
                <option key={db.id} value={`reference:${db.id}`}>
                  Reference: {db.name} ({formatCount(db.gameCount)} games)
                </option>
              ))}
              {!mastersKnown && <option value={settings.mastersSource}>Reference database #{settings.mastersSource.split(':')[1]}</option>}
            </select>
          </Field>
          {'broadcastAutoImport' in settings && (
            <Toggle
              label="Import finished broadcast rounds automatically"
              checked={draft.broadcastAutoImport}
              onChange={v => set('broadcastAutoImport', v)}
              help="Adds finished official Lichess broadcast rounds to the built-in “Lichess broadcasts” reference database (CC BY-SA 4.0). Needs the Lichess token."
            />
          )}
        </section>

        {form && <Flash kind="failure">{form}</Flash>}
        <div className={dirty ? 'adm-savebar adm-savebar--dirty' : 'adm-savebar'}>
          <span className="muted">{dirty ? 'Unsaved changes' : 'No changes'}</span>
          <Button
            variant="secondary"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setDraft(draftOf(settings));
              setProblems({});
              update.reset();
            }}
          >
            Discard
          </Button>
          <Button type="submit" icon={licon.Checkmark} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </form>
    </Box>
  );
}
