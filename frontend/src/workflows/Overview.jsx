// Workflows > Overview (Oct 28 2026): what needs a person (paused by the
// system, failing, owner gone), the last 24 hours in three figures, the ten
// most recent runs, and the two ways to start - a template or a blank
// workflow. The data is GET /workflows/overview, loaded by WorkflowsApp
// (it also feeds the paused-all banner on every tab) and handed down.
import { useState } from 'react';
import { AlertTriangle, LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { formatDateTime } from '../lib/datetime';
import { waited } from '../lib/approvalActions';
import { runStatusMeta } from './lib/status';
import { buildSub } from './lib/sub';
import { Card, FONT, LinkButton, Muted, SectionTitle, errorText } from './ui';

export default function Overview({ overview, loading, error, reload, go }) {
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  const newWorkflow = async () => {
    setCreating(true);
    setNotice('');
    try {
      // A blank company means the owner's own scope - the server resolves it.
      const wf = await api.wfCreate({ name: 'Untitled Workflow', companyId: '' });
      if (wf?.id) go(buildSub('builder', wf.id));
      else setNotice('The workflow was not created - please try again.');
    } catch (e) {
      setNotice(errorText(e, 'The workflow was not created - please try again.'));
    } finally {
      setCreating(false);
    }
  };

  const attention = overview?.needsAttention || [];
  const last = overview?.last24h || {};
  const recent = (overview?.recent || []).slice(0, 10);

  return (
    <div style={{ fontFamily: FONT, display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="primary-btn" onClick={newWorkflow} disabled={creating}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> {creating ? 'Creating...' : 'New Workflow'}
        </button>
        <button type="button" className="secondary-btn" onClick={() => go('templates')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LayoutTemplate size={14} /> Start From A Template
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="secondary-btn" onClick={reload} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {notice && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13 }}>{notice}</div>}

      <AsyncSection loading={loading} error={error} onRetry={reload}
        errorMessage="The overview couldn't be loaded right now - please try again."
        skeleton={<SkeletonBlocks count={3} height={110} />}>
        <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' }}>
          <section style={{ gridColumn: '1 / -1' }}>
            <SectionTitle count={attention.length || null}>Needs Attention</SectionTitle>
            <Card>
              {attention.length === 0 ? (
                <div style={{ padding: '18px 16px', fontSize: 13.5, color: 'var(--muted)' }}>Every workflow is running as published.</div>
              ) : attention.map((a) => (
                <div key={a.id} className="wf-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                  <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <LinkButton onClick={() => go(buildSub('builder', a.id))} style={{ color: 'var(--ink)', fontSize: 14 }}>{a.name}</LinkButton>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                      {a.reason}{a.since ? <span title={formatDateTime(a.since)}> - since {formatDateTime(a.since)}</span> : null}
                    </div>
                  </div>
                  <button type="button" className="secondary-btn" onClick={() => go(buildSub('builder', a.id))}>Open</button>
                </div>
              ))}
            </Card>
          </section>

          <section>
            <SectionTitle>Last 24 Hours</SectionTitle>
            <Card style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', padding: '14px 8px' }}>
              <Figure label="Runs" value={last.runs} />
              <Figure label="Succeeded" value={last.succeeded} color="#16a34a" />
              <Figure label="Failed" value={last.failed} color={last.failed > 0 ? '#dc2626' : undefined} />
            </Card>
          </section>

          <section style={{ gridColumn: '1 / -1' }}>
            <SectionTitle action={<LinkButton onClick={() => go('runs')} style={{ fontSize: 13 }}>Every Run</LinkButton>}>Recent Runs</SectionTitle>
            <Card>
              {recent.length === 0 ? (
                <div style={{ padding: '18px 16px', fontSize: 13.5, color: 'var(--muted)' }}>No runs yet. A published workflow's runs show here as they happen.</div>
              ) : recent.map((r) => {
                const m = runStatusMeta(r.status);
                return (
                  <button key={r.id} type="button" onClick={() => go(buildSub('run', r.id))}
                    style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 12px', width: '100%', textAlign: 'left',
                      padding: '10px 16px', border: 'none', borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', font: 'inherit', color: 'var(--ink)', fontFamily: FONT }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.workflowName}</span>
                    <StatusLabel label={m.label} color={m.color} size="sm" />
                    <Muted style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subjectLabel || r.summary || ''}</Muted>
                    <Muted title={r.startedAt ? formatDateTime(r.startedAt) : ''} style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{waited(r.startedAt)}</Muted>
                  </button>
                );
              })}
            </Card>
          </section>
        </div>
      </AsyncSection>
    </div>
  );
}

function Figure({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', padding: '6px 4px' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || 'var(--ink)', lineHeight: 1.1 }}>{value ?? 0}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{label}</div>
    </div>
  );
}
