// Settings > Workflows (Oct 28 2026): whether workflows run, the ceilings,
// the owner digest and the organization-wide pause. An organization default
// a company may override (`GET /workflows/settings?company=`), drawn with
// the Settings rows (SettingsUI.jsx): a switch saves on click, the typed
// fields go through one Save row that shows only once something changed.
// Org-only rows (Pause All, Nexus run-as, webhooks) are Global Admins'.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { api } from '../api';
import { SettingCard, SettingRow, SwitchRow, NumberBox } from '../components/settings/SettingsUI';
import { Spinner, ErrorBanner } from '../components/AsyncState';
import { useRole } from '../contexts/RoleContext';
import { dialog } from '../ui/dialog';
import { formatDateTime } from '../lib/datetime';

const RUNS_CAP = 500;
const RECIPIENTS_CAP = 200;

const pick = (m) => ({
  enabled: !!m?.enabled, ownerDigest: !!m?.ownerDigest,
  maxRunsPerHourCap: m?.maxRunsPerHourCap ?? RUNS_CAP, maxRecipientsCap: m?.maxRecipientsCap ?? RECIPIENTS_CAP,
  nexusRunAs: !!m?.nexusRunAs, webhookHosts: Array.isArray(m?.webhookHosts) ? [...m.webhookHosts] : [],
});
const clamp = (v, max) => Math.min(max, Math.max(1, Number(v) || 0));
const sameHosts = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

export function WorkflowsSettings({ company = '', onOverride, toastOk, toastErr }) {
  const { myRole } = useRole();
  const isGA = myRole === 'owner';
  const orgFace = !company;
  const [meta, setMeta] = useState(null);
  const [vals, setVals] = useState(pick(null));
  const [secrets, setSecrets] = useState({});
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.wfSettings(company).then((m) => { setLoadErr(''); setMeta(m); setVals(pick(m)); setSecrets({}); })
      .catch((e) => setLoadErr(e?.message || 'Could not load the settings.'));
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (meta && company) onOverride?.(!!meta.override); }, [meta, company, onOverride]);

  // The org face belongs to Global Admins; a company's face to whoever Settings let in.
  const canEdit = orgFace ? isGA : true;

  const saved = useMemo(() => pick(meta), [meta]);
  const dirty = !!meta && (
    String(vals.maxRunsPerHourCap) !== String(saved.maxRunsPerHourCap)
    || String(vals.maxRecipientsCap) !== String(saved.maxRecipientsCap)
    || !sameHosts(vals.webhookHosts, saved.webhookHosts)
    || Object.values(secrets).some((s) => s)
  );

  async function save(next, { reset = false, typed = {} } = {}) {
    setBusy(true);
    try {
      const body = { ...pick(meta), ...next };
      body.maxRunsPerHourCap = clamp(body.maxRunsPerHourCap, RUNS_CAP);
      body.maxRecipientsCap = clamp(body.maxRecipientsCap, RECIPIENTS_CAP);
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
      setMeta(m); setVals(pick(m)); setSecrets({});
      toastOk?.(reset ? 'Back to the default for every company.' : 'Saved.');
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); load(); }
    finally { setBusy(false); }
  }

  async function pauseAll(paused) {
    if (paused && !(await dialog.confirm('Pause every workflow in every company? Nothing starts until a Global Admin turns them back on; events keep queuing for 7 days.', { title: 'Pause All Workflows', confirmText: 'Pause All', danger: true }))) return;
    setBusy(true);
    try {
      await api.wfPauseAll({ paused });
      toastOk?.(paused ? 'All workflows are paused.' : 'Workflows are running again.');
      load();
    } catch (e) { toastErr?.(e?.message || 'Could not change the pause.'); }
    finally { setBusy(false); }
  }

  if (loadErr) return <ErrorBanner message={loadErr} onRetry={load} />;
  if (!meta) return <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="section" /></div>;

  const off = !canEdit || busy;
  const secretsSet = new Set(meta.webhookSecretsSet || []);
  const pausedLine = meta.pausedAll
    ? `Paused by ${meta.pausedBy || 'a Global Admin'} since ${formatDateTime(meta.pausedAt, 'an unknown time')}. Events keep queuing for 7 days, so switching back on loses nothing recent.`
    : 'Stops every workflow in every company from starting a run. A run already waiting on an approval still finishes when the decision arrives.';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {company && <span className="nx-set-pad" style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.override ? 'This company has its own workflow settings.' : 'This company uses the default.'}</span>}
      <SettingCard>
        <SwitchRow id={`wf-enabled-${company || 'all'}`} title="Workflows On"
          desc={company ? 'Off: no workflow starts a run for this company\'s records; its workflows show "Paused: company switch".' : 'The default for every company. Off: no run starts anywhere a company has not switched workflows on itself.'}
          checked={vals.enabled} disabled={off} onChange={(v) => save({ ...vals, enabled: v })} />
        {orgFace && (
          <SwitchRow id="wf-pause-all" title="Pause All Workflows" desc={pausedLine}
            checked={!!meta.pausedAll} disabled={!isGA || busy} onChange={pauseAll} />
        )}
        <SwitchRow id={`wf-digest-${company || 'all'}`} title="Owner Digest"
          desc="A Monday email to each workflow owner: last week's runs, failures and what each workflow did most."
          checked={vals.ownerDigest} disabled={off} onChange={(v) => save({ ...vals, ownerDigest: v })} />
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
            desc="Lets a Global Admin set a workflow to run as Nexus for organization-wide housekeeping. Nexus can only message: notify, email, wait and stop; every module action still needs a person."
            checked={vals.nexusRunAs} disabled={!isGA || busy} onChange={(v) => save({ ...vals, nexusRunAs: v })} />
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
          The default for every company is changed by a Global Admin. Pick your company to set its own.
        </p>
      ) : (
        <div className="nx-set-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {dirty && <button type="button" className="primary-btn" disabled={busy} onClick={() => save(vals, { typed: secrets })}>{busy ? 'Saving…' : 'Save'}</button>}
          {dirty && <button type="button" className="secondary-btn" disabled={busy} onClick={() => { setVals(pick(meta)); setSecrets({}); }}>Discard Changes</button>}
          {!!company && !!meta.override && <button type="button" className="secondary-btn" disabled={busy} onClick={() => save(pick(meta), { reset: true })}>Use the Default</button>}
        </div>
      )}
    </div>
  );
}

export default WorkflowsSettings;
