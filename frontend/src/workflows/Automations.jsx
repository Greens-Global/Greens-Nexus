// Workflows > Automations (Neil, Oct 28 2026: "automations should be
// managed, and workflows should be managed, all of this requires a good
// ability to turn these off"). One screen for every automatic thing:
//   - Workflows: how many there are and how many run, with a link to the list
//   - Task Automation Rules: each rule with its own on / off switch, saved
//     through the Tasks rule endpoint (POST /workflows/automations/task-rules
//     /{id}/enabled proxies PATCH /task-automation-rules/{id}), and Edit In
//     Tasks (Tasks > Manage, where the rule itself is built)
//   - Built-In Automations: the background jobs, read-only - what each does,
//     how often, and the Settings group that controls it when one exists
// Data: GET /workflows/automations plus GET /workflows for the count.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, ListChecks, Settings as SettingsIcon, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { Switch } from '../components/settings/SettingsUI';
import { formatDateTime } from '../lib/datetime';
import { Card, FONT, LinkButton, Muted, SectionTitle, errorText } from './ui';

export default function Automations({ go }) {
  const [data, setData] = useState(null);
  const [workflows, setWorkflows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.wfAutomations(),
      api.wfList({ scope: 'company' }).catch(() => null),
    ])
      .then(([a, w]) => { setData(a || {}); setWorkflows(Array.isArray(w) ? w : null); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

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
                </div>
                <Muted style={{ whiteSpace: 'nowrap' }}>{j.every}</Muted>
                {j.settingLink?.view ? (
                  <LinkButton onClick={() => navigate(j.settingLink.view, j.settingLink.sub)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
                    <SettingsIcon size={13} /> Settings
                  </LinkButton>
                ) : <Muted style={{ whiteSpace: 'nowrap' }}>Always on</Muted>}
              </div>
            ))}
          </Card>
        </section>
      </AsyncSection>
    </div>
  );
}
