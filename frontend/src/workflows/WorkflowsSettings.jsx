// Settings > Workflows (Oct 28 2026): whether workflows run, the ceilings,
// the owner digest and the organization-wide pause. An organization default
// a company may override (`GET /workflows/settings?company=`), drawn with
// the Settings rows (SettingsUI.jsx): a switch saves on click (only that
// switch - a half-typed cap beside it stays a draft), the typed fields are a
// draft (lib/useDraft.js) with ONE Save row at the foot (components/SaveRow.jsx).
// Org-only rows (Pause All, Nexus run-as, webhooks) are Super Administrators'.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, Plus, Pause } from 'lucide-react';
import { api } from '../api';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import { useRole } from '../contexts/RoleContext';
import { dialog } from '../ui/dialog';
import { HOLD_MAJOR_MS } from '../ui/HoldButton';
import { formatDateTime } from '../lib/datetime';
import { errorText } from './lib/errors';
import SaveRow from '../components/SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';

const RUNS_CAP = 500;
const RECIPIENTS_CAP = 200;
const TEXT_DAILY_CAP = 20;
const SUMMARY_MAX = 1440;

const pick = (m) => ({
  enabled: !!m?.enabled, ownerDigest: !!m?.ownerDigest, textMessages: m?.textMessages !== false,
  maxRunsPerHourCap: m?.maxRunsPerHourCap ?? RUNS_CAP, maxRecipientsCap: m?.maxRecipientsCap ?? RECIPIENTS_CAP,
  textDailyCap: m?.textDailyCap ?? 3, summaryMinutes: m?.summaryMinutes ?? 60,
  nexusRunAs: !!m?.nexusRunAs, webhookHosts: Array.isArray(m?.webhookHosts) ? [...m.webhookHosts] : [],
});
const clamp = (v, max, min = 1) => Math.min(max, Math.max(min, Number(v) || 0));
// The typed part of the settings: what the Save row saves.
const TYPED = ['maxRunsPerHourCap', 'maxRecipientsCap', 'textDailyCap', 'summaryMinutes', 'webhookHosts'];
const typedOf = (p) => Object.fromEntries(TYPED.map((k) => [k, p[k]]));
const typedPart = (m) => typedOf(pick(m));

export function WorkflowsSettings({ company = '', onOverride, toastOk, toastErr }) {
  const { myRole } = useRole();
  const isGA = myRole === 'owner';
  const orgFace = !company;
  const [meta, setMeta] = useState(null);
  const [secrets, setSecrets] = useState({});
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.wfSettings(company).then((m) => { setLoadErr(''); setMeta(m); })
      .catch((e) => setLoadErr(errorText(e, 'Could not load the settings.')));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);

  // The org face belongs to Super Administrators; a company's face to whoever Settings let in.
  const canEdit = orgFace ? isGA : true;

  const saved = useMemo(() => pick(meta), [meta]);
  const savedTyped = useMemo(() => (meta ? typedPart(meta) : null), [meta]);
  const { draft, setDraft, dirty: typedDirty, reset: resetTyped } = useDraft(savedTyped, { rebase: true });
  const vals = { ...saved, ...(draft || {}) };
  const dirty = typedDirty || Object.values(secrets).some((s) => s);
  const discard = () => { resetTyped(); setSecrets({}); };

  // Writes `next` over what is saved; true once it landed.
  async function save(next, { reset = false, typed = {} } = {}) {
    setBusy(true);
    try {
      const body = { ...pick(meta), ...next };
      body.maxRunsPerHourCap = clamp(body.maxRunsPerHourCap, RUNS_CAP);
      body.maxRecipientsCap = clamp(body.maxRecipientsCap, RECIPIENTS_CAP);
      body.textDailyCap = clamp(body.textDailyCap, TEXT_DAILY_CAP);
      body.summaryMinutes = clamp(body.summaryMinutes, SUMMARY_MAX, 5);
      body.webhookHosts = body.webhookHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
      // Secrets are keyed by the host as it is saved (trimmed, lowercase).
      const typedSecrets = {};
      for (const [h, s] of Object.entries(typed)) {
        const k = h.trim().toLowerCase();
        if (s && body.webhookHosts.includes(k)) typedSecrets[k] = s;
      }
      if (Object.keys(typedSecrets).length) body.webhookSecrets = typedSecrets;
      if (reset) body.override = false;
      const m = await api.wfSettingsSave(body, company);
      if (next === draft || reset) { setSecrets({}); setDraft(typedPart(m)); }
      setMeta(m);
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
      return true;
    } catch (e) { toastErr?.(errorText(e, 'Could not save.')); load(); return false; }
    finally { setBusy(false); }
  }
  // A switch saves only itself, never the typed draft beside it.
  const flip = (key) => (v) => save({ [key]: v });
  const saveTyped = () => save(draft, { typed: secrets });
  useGroupDirty(dirty && canEdit, saveTyped);
  const setVals = (fn) => setDraft((d) => typedOf(fn({ ...saved, ...d })));

  async function pauseAll(paused) {
    // Pausing stops every workflow for everyone, so it is held to confirm
    // (ui/HoldButton.jsx, HOLD_MAJOR_MS); the dialog runs the pause and stays
    // open with the reason if it fails. Turning them back on needs no hold.
    if (paused) {
      const ok = await dialog.confirm('This stops every workflow in every company until a Super Administrator turns them back on. Nothing new starts meanwhile; events keep queuing for 7 days, so switching back on loses nothing recent.', {
        title: 'Pause All Workflows?', confirmText: 'Pause All Workflows', doneText: 'Paused', hold: true, holdMs: HOLD_MAJOR_MS, holdIcon: Pause, danger: true,
        onConfirm: async () => {
          try { await api.wfPauseAll({ paused: true }); } catch (e) { throw new Error(errorText(e, 'Could not change the pause.'), { cause: e }); }
        },
      });
      if (ok) { toastOk?.('All workflows are paused.'); load(); }
      return;
    }
    setBusy(true);
    try {
      await api.wfPauseAll({ paused });
      toastOk?.(paused ? 'All workflows are paused.' : 'Workflows are running again.');
      load();
    } catch (e) { toastErr?.(errorText(e, 'Could not change the pause.')); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;

  const off = !canEdit || busy;
  const secretsSet = new Set(meta.webhookSecretsSet || []);
  const pausedLine = meta.pausedAll
    ? `Paused by ${meta.pausedBy || 'a Super Administrator'} since ${formatDateTime(meta.pausedAt, 'an unknown time')}. Events keep queuing for 7 days, so switching back on loses nothing recent.`
    : 'Stops every workflow in every company from starting a run. A run already waiting on an approval still finishes when the decision arrives.';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has its own workflow settings.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SwitchRow id={`wf-enabled-${company || 'all'}`} title="Workflows On"
          desc={company ? 'Off: no workflow starts a run for this company\'s records; its workflows show "Paused: company switch".' : 'The default for every company. Off: no run starts anywhere a company has not switched workflows on itself.'}
          checked={vals.enabled} disabled={off} onChange={flip('enabled')} />
        {orgFace && (
          <SwitchRow id="wf-pause-all" title="Pause All Workflows" desc={pausedLine}
            checked={!!meta.pausedAll} disabled={!isGA || busy} onChange={pauseAll} />
        )}
        <SwitchRow id={`wf-digest-${company || 'all'}`} title="Owner Digest"
          desc="A Monday email to each workflow owner: last week's runs, failures and what each workflow did most."
          checked={vals.ownerDigest} disabled={off} onChange={flip('ownerDigest')} />
        <SwitchRow id={`wf-texts-${company || 'all'}`} title="Text Messages"
          desc={`${company ? 'Off: this company\'s workflows cannot send a text.' : 'The default for every company. Off: Send A Text Message is refused.'} Each text is billed per message; people are texted at the phone on their People record and can turn workflow texts off in their profile.${meta.textingReady === false ? ' Texting is not set up on this server yet, so texts fail until it is.' : ''}`}
          checked={vals.textMessages} disabled={off} onChange={flip('textMessages')} />
        <SettingRow title="Texts Per Person Per Day"
          desc={`The most workflow texts one person gets in 24 hours; past it the message goes to their notifications instead. People who work in California are never texted between 9:00 PM and 8:00 AM Pacific: those texts go out at 8:00 AM. The ceiling is ${TEXT_DAILY_CAP}.`}
          control={<NumberBox label="Texts per person per day" min={1} max={TEXT_DAILY_CAP} unit="texts" disabled={off} value={vals.textDailyCap}
            onChange={(v) => setVals((p) => ({ ...p, textDailyCap: v === '' ? '' : Number(v) }))} />} />
        <SettingRow title="Summary Wait"
          desc="For a step set to Send One Summary Per Person: how long the first message waits for more from the same workflow before each person gets one email or text with them all."
          control={<NumberBox label="Summary wait" min={5} max={SUMMARY_MAX} unit="minutes" disabled={off} value={vals.summaryMinutes}
            onChange={(v) => setVals((p) => ({ ...p, summaryMinutes: v === '' ? '' : Number(v) }))} />} />
        <SettingRow title="Runs Per Hour Cap"
          desc={`The most runs one workflow may start in an hour before it is paused for attention. A workflow sets its own limit below this; the ceiling is ${RUNS_CAP}.`}
          control={<NumberBox label="Runs per hour cap" min={1} max={RUNS_CAP} unit="runs" disabled={off} value={vals.maxRunsPerHourCap}
            onChange={(v) => setVals((p) => ({ ...p, maxRunsPerHourCap: v === '' ? '' : Number(v) }))} />} />
        <SettingRow title="Recipients Cap"
          desc={`The most people one step may notify, email or message. A workflow sets its own limit below this; the ceiling is ${RECIPIENTS_CAP}.`}
          control={<NumberBox label="Recipients cap" min={1} max={RECIPIENTS_CAP} unit="people" disabled={off} value={vals.maxRecipientsCap}
            onChange={(v) => setVals((p) => ({ ...p, maxRecipientsCap: v === '' ? '' : Number(v) }))} />} />
        {orgFace && (
          <SwitchRow id="wf-nexus-run-as" title="Nexus Run-As"
            desc="Lets a Super Administrator set a workflow to run as Nexus for organization-wide housekeeping. Nexus can only message: notify, email, text, wait and stop; every module action still needs a person."
            checked={vals.nexusRunAs} disabled={!isGA || busy} onChange={flip('nexusRunAs')} />
        )}
        {orgFace && (
          <SettingRow title="Webhook Hosts"
            desc="The hosts Call A Webhook may post to, each signed with its own secret. A secret is write-only: type a new one to replace it.">
            <div style={{ display: 'grid', gap: 8 }}>
              {vals.webhookHosts.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No hosts yet - workflows cannot call a webhook until one is listed.</span>}
              {vals.webhookHosts.map((h, i) => (
                <div key={i} className="wf-webhook-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto auto', gap: 8, alignItems: 'center' }}>
                  <input className="form-input" value={h} placeholder="hooks.example.com" aria-label={`Webhook host ${i + 1}`} disabled={!isGA || busy}
                    onChange={(e) => setVals((p) => { const hosts = [...p.webhookHosts]; hosts[i] = e.target.value; return { ...p, webhookHosts: hosts }; })} />
                  <input className="form-input" type="password" autoComplete="new-password" value={secrets[h] || ''} aria-label={`Secret for ${h || `host ${i + 1}`}`}
                    placeholder={secretsSet.has(h) ? 'Type a new secret to replace it' : 'Secret'} disabled={!isGA || busy || !h}
                    onChange={(e) => setSecrets((p) => ({ ...p, [h]: e.target.value }))} />
                  <span className={`nx-set-badge${secretsSet.has(h) ? ' is-own' : ''}`}>{secretsSet.has(h) ? 'Secret Set' : 'No Secret'}</span>
                  <button type="button" className="icon-btn" aria-label={`Remove ${h || `host ${i + 1}`}`} disabled={!isGA || busy}
                    onClick={() => setVals((p) => ({ ...p, webhookHosts: p.webhookHosts.filter((_, j) => j !== i) }))}><Trash2 size={14} /></button>
                </div>
              ))}
              <div>
                <button type="button" className="secondary-btn" disabled={!isGA || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setVals((p) => ({ ...p, webhookHosts: [...p.webhookHosts, ''] }))}><Plus size={14} /> Add Host</button>
              </div>
            </div>
          </SettingRow>
        )}
      </SettingCard>
      {!canEdit ? (
        <p className="nx-set-pad" style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          The default for every company is changed by a Super Administrator. Pick your company to set its own.
        </p>
      ) : (
        <SaveRow dirty={dirty} busy={busy} onSave={saveTyped} onDiscard={discard} style={{ margin: 0, padding: '12px 18px' }}
          onUseDefault={company && meta.override ? () => save(pick(meta), { reset: true }) : undefined}
          note={orgFace ? 'Saves the caps and the webhook hosts. The switches save when clicked.' : 'Saves the caps for this company. The switches save when clicked.'} />
      )}
    </div>
  );
}

export default WorkflowsSettings;
