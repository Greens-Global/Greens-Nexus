// Workflows > Automations (Neil, Oct 28 2026: "automations should be
// managed, and workflows should be managed, all of this requires a good
// ability to turn these off"). One screen for every automatic thing:
//   - Workflows: how many there are and how many run, with a link to the list
//   - Task Automation Rules: each rule with its own on / off switch, saved
//     through the Tasks rule endpoint (POST /workflows/automations/task-rules
//     /{id}/enabled proxies PATCH /task-automation-rules/{id}), Runs (the
//     rule's newest 50 firings, GET /task-automation-runs?rule_id=) and Edit
//     In Tasks (Tasks > Manage, where the rule itself is built)
//   - Built-In Automations: the background jobs - what each does, how often,
//     the Settings group that controls it when one exists, and (Oct 28 2026)
//     an off switch per job for Global Admins (POST /workflows/automations
//     /jobs/{key}/off, one org-wide list); everyone else sees an Off chip
// Data: GET /workflows/automations plus GET /workflows for the count.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, History, ListChecks, Settings as SettingsIcon, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { Switch } from '../components/settings/SettingsUI';
import { useRole } from '../contexts/RoleContext';
import { formatDateTime } from '../lib/datetime';
import { Modal } from '../tasks/components';
import { Card, FONT, LinkButton, Muted, SectionTitle } from './ui';
import { errorText } from './lib/errors';

const RUNS_LIMIT = 50;

export default function Automations({ go }) {
  const { can } = useRole();
  const isGlobalAdmin = can('owner');
  const [data, setData] = useState(null);
  const [workflows, setWorkflows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');
  const [runsFor, setRunsFor] = useState(null);   // the task rule whose Runs popup is open

  // The fetch sets state only from the responses; Retry shows the skeleton
  // again through `load`.
  const fetchAll = useCallback(() => Promise.all([
    api.wfAutomations(),
    api.wfList({ scope: 'company' }).catch(() => null),
  ])
    .then(([a, w]) => { setData(a || {}); setWorkflows(Array.isArray(w) ? w : null); setError(false); })
    .catch(() => setError(true))
    .finally(() => setLoading(false)), []);
  const load = useCallback(() => { setLoading(true); return fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  const rules = data?.taskRules || [];
  const jobs = data?.jobs || [];

  // Optimistic: the switch moves at once and comes back if the server refuses.
  const toggle = async (rule, enabled) => {
    setNotice('');
    setData((d) => ({ ...d, taskRules: (d?.taskRules || []).map((r) => (r.id === rule.id ? { ...r, enabled } : r)) }));
    try {
      await api.wfTaskRuleEnabled(rule.id, enabled);
    } catch (e) {
      setData((d) => ({ ...d, taskRules: (d?.taskRules || []).map((r) => (r.id === rule.id ? { ...r, enabled: !enabled } : r)) }));
      setNotice(errorText(e, `"${rule.name}" could not be ${enabled ? 'turned on' : 'turned off'} - please try again.`));
    }
  };

  // The built-in switch: the same optimistic shape, one org-wide list.
  const toggleJob = async (job, off) => {
    setNotice('');
    setData((d) => ({ ...d, jobs: (d?.jobs || []).map((j) => (j.key === job.key ? { ...j, off } : j)) }));
    try {
      await api.wfJobOff(job.key, off);
    } catch (e) {
      setData((d) => ({ ...d, jobs: (d?.jobs || []).map((j) => (j.key === job.key ? { ...j, off: !off } : j)) }));
      setNotice(errorText(e, `"${job.label}" could not be ${off ? 'turned off' : 'turned on'} - please try again.`));
    }
  };

  const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub ?? null } }));

  const active = (workflows || []).filter((w) => w.status === 'active').length;

  return (
    <div style={{ fontFamily: FONT, display: 'grid', gap: 18 }}>
      {notice && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13 }}>{notice}</div>}
      <AsyncSection loading={loading && !data} error={error && !data} onRetry={load}
        errorMessage="The automations couldn't be loaded right now - please try again."
        skeleton={<SkeletonBlocks count={3} height={96} />}>
        <section>
          <SectionTitle>Workflows</SectionTitle>
          <Card style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
            <WorkflowIcon size={18} style={{ color: 'var(--wk-brand)' }} />
            <div style={{ flex: 1, minWidth: 160, fontSize: 13.5 }}>
              {workflows ? (
                <><strong>{workflows.length}</strong> {workflows.length === 1 ? 'workflow' : 'workflows'} in your company, <strong>{active}</strong> active</>
              ) : 'Workflows built in this module'}
              <div><Muted>Pause or resume any one of them from the Workflows tab; Settings &gt; Workflows pauses everything.</Muted></div>
            </div>
            <button type="button" className="secondary-btn" onClick={() => go('list')}>Open Workflows</button>
          </Card>
        </section>

        <section>
          <SectionTitle count={rules.length || null}>Task Automation Rules</SectionTitle>
          <Card>
            {rules.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13.5, color: 'var(--muted)' }}>
                No task automation rules yet. They are built in Tasks &gt; Manage &gt; Automation Rules.
              </div>
            ) : rules.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <ListChecks size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</div>
                  <Muted>
                    {r.triggerText || 'Task rule'}
                    {r.runCount != null ? ` - ${r.runCount} ${r.runCount === 1 ? 'run' : 'runs'}` : ''}
                    {r.lastRunAt ? `, last ${formatDateTime(r.lastRunAt)}` : ''}
                  </Muted>
                </div>
                <LinkButton onClick={() => setRunsFor(r)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }} title="What this rule did">
                  <History size={13} /> Runs
                </LinkButton>
                <button type="button" className="secondary-btn" onClick={() => navigate('tasks', 'manage')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '5px 10px' }}>
                  <ExternalLink size={13} /> Edit In Tasks
                </button>
                <Switch checked={!!r.enabled} onChange={(on) => toggle(r, on)} label={`${r.name} on`} />
              </div>
            ))}
          </Card>
        </section>

        <section>
          <SectionTitle count={jobs.length || null}>Built-In Automations</SectionTitle>
          <Card>
            {jobs.length === 0 ? (
              <div style={{ padding: '18px 16px', fontSize: 13.5, color: 'var(--muted)' }}>Nothing listed.</div>
            ) : jobs.map((j) => (
              <div key={j.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <Zap size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{j.label}</div>
                  <Muted>{j.what}</Muted>
                  {j.lastRun?.at && <LastRun run={j.lastRun} />}
                </div>
                <Muted style={{ whiteSpace: 'nowrap' }}>{j.every}</Muted>
                {j.settingLink?.view && (
                  <LinkButton onClick={() => navigate(j.settingLink.view, j.settingLink.sub)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                    <SettingsIcon size={13} /> Settings
                  </LinkButton>
                )}
                {j.switch === false ? null : isGlobalAdmin ? (
                  <Switch checked={!j.off} onChange={(on) => toggleJob(j, !on)} label={`${j.label} on`} />
                ) : j.off ? <StatusLabel label="Off" color="#64748b" size="sm" /> : null}
              </div>
            ))}
          </Card>
        </section>
      </AsyncSection>
      {runsFor && <RuleRunsModal rule={runsFor} onClose={() => setRunsFor(null)} />}
    </div>
  );
}

// A built-in job's last run (job_switch.record_run, Oct 29 2026): when, what
// it did (non-zero counts) and any pass that failed.
function LastRun({ run }) {
  const done = (run.items || []).filter((i) => i.count > 0);
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
      Last run {formatDateTime(run.at)}{done.length ? `: ${done.map((i) => `${i.label} ${i.count}`).join(', ')}` : ': nothing to do'}
      {(run.errors || []).map((e) => <div key={e} style={{ color: '#dc2626', marginTop: 2 }}>{e}</div>)}
    </div>
  );
}

// A task rule's runs: the newest 50, each with when, the task and what the
// rule did (the Tasks Runs panel's rows, read-only).
const RULE_RUN_STATUS = { ok: { label: 'Done', color: '#16a34a' }, done: { label: 'Done', color: '#16a34a' }, error: { label: 'Failed', color: '#dc2626' }, failed: { label: 'Failed', color: '#dc2626' }, skipped: { label: 'Skipped', color: '#64748b' } };
const ruleRunStatus = (s) => RULE_RUN_STATUS[s] || { label: String(s || 'Done').replace(/\b\w/g, (c) => c.toUpperCase()), color: '#64748b' };

function RuleRunsModal({ rule, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let on = true;
    api.getTaskAutomationRuns(rule.id, RUNS_LIMIT)
      .then((list) => { if (on) { setRows(Array.isArray(list) ? list : []); setError(false); } })
      .catch(() => { if (on) setError(true); });
    return () => { on = false; };
  }, [rule.id, tick]);

  const line = (x) => {
    const task = [x.taskCode, x.taskTitle].filter(Boolean).join(' ');
    const acts = Array.isArray(x.actions) ? x.actions.map((a) => (typeof a === 'string' ? a : a?.label || a?.type || '')).filter(Boolean) : [];
    return [task, x.detail, acts.length ? acts.join(', ') : ''].filter(Boolean).join(' - ');
  };

  return (
    <Modal title={`${rule.name} - Runs`} onClose={onClose}
      footer={<button type="button" className="primary-btn" onClick={onClose}>Close</button>}>
      <div style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
        <Muted>The newest {RUNS_LIMIT} times this rule fired{rule.triggerText ? ` - ${rule.triggerText.charAt(0).toLowerCase()}${rule.triggerText.slice(1)}` : ''}.</Muted>
        <div className="nx-fill" style={{ overflowY: 'auto' }}>
          <AsyncSection loading={rows === null && !error} error={error} isEmpty={!!rows && !rows.length}
            errorMessage="The runs couldn't be loaded right now - please try again." onRetry={() => { setRows(null); setError(false); setTick((t) => t + 1); }}
            skeleton={<SkeletonBlocks count={4} height={44} borderRadius={8} />}
            emptyContent={<div style={{ padding: '18px 4px', fontSize: 13.5, color: 'var(--muted)' }}>This rule has not fired yet.</div>}>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {(rows || []).map((x) => {
                const m = ruleRunStatus(x.status);
                return (
                  <li key={x.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 12px', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 13 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <StatusLabel label={m.label} color={m.color} size="sm" />
                      <span style={{ fontWeight: 600 }}>{x.event || x.trigger || 'Fired'}</span>
                    </div>
                    <Muted style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{x.at ? formatDateTime(x.at) : ''}</Muted>
                    {line(x) && <div style={{ gridColumn: '1 / -1', overflowWrap: 'anywhere', color: 'var(--ink)' }}>{line(x)}</div>}
                  </li>
                );
              })}
            </ol>
          </AsyncSection>
        </div>
      </div>
    </Modal>
  );
}
