// Workflows > Workflows (Oct 28 2026): every workflow the person may see,
// in three scopes - Mine, My Company, Every Company (the last only with the
// full grant or an administrator's role; GET /workflows?scope= enforces the
// same on the server). Search, a table on desktop and cards on a phone, row
// actions Pause / Resume / Duplicate / Archive / Delete, and a click opens the
// builder (wf:<id>).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Copy, Pause, Play, Plus, Search, Workflow as WorkflowIcon } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { useRole } from '../contexts/RoleContext';
import { formatDateTime } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { dialog } from '../ui/dialog';
import HoldButton from '../ui/HoldButton';
import { EmptyState } from '../tasks/components';
import { wfStatusMeta } from './lib/status';
import { buildSub } from './lib/sub';
import { describeTrigger } from './lib/text';
import { useCatalog } from './lib/useCatalog';
import { Card, Chip, FONT, Muted } from './ui';
import { errorText } from './lib/errors';

const SCOPES = [
  { key: 'mine', label: 'Mine' },
  { key: 'company', label: 'My Company' },
  { key: 'all', label: 'Every Company' },
];

export default function WorkflowList({ go }) {
  const { canAccessModule } = useRole();
  const isMobile = useIsMobile('(max-width: 760px)');
  const { catalog } = useCatalog();
  const everyCompany = canAccessModule('workflows', 'administrator', 'full');
  const scopes = useMemo(() => SCOPES.filter((s) => s.key !== 'all' || everyCompany), [everyCompany]);
  const [scope, setScope] = useState('mine');
  const [q, setQ] = useState('');
  // What was loaded, keyed by the scope and a retry tick: a scope switch or a
  // retry shows the skeleton (the key no longer matches) and never the
  // previous scope's rows; the state is set only from the response.
  const [tick, setTick] = useState(0);
  const loadKey = `${scope}:${tick}`;
  const [loaded, setLoaded] = useState({ key: '', rows: null, error: false });
  const rows = loaded.key === loadKey ? loaded.rows : null;
  const error = loaded.key === loadKey && loaded.error;
  const loading = loaded.key !== loadKey;
  const [busy, setBusy] = useState(null);     // workflow id with an action in flight
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let on = true;
    api.wfList({ scope })
      .then((list) => { if (on) setLoaded({ key: loadKey, rows: Array.isArray(list) ? list : [], error: false }); })
      .catch(() => { if (on) setLoaded({ key: loadKey, rows: null, error: true }); });
    return () => { on = false; };
  }, [scope, loadKey]);
  const load = useCallback(() => setTick((t) => t + 1), []);
  const setRows = (fn) => setLoaded((l) => ({ ...l, rows: fn(l.rows) }));

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = rows || [];
    if (!needle) return all;
    return all.filter((w) => [w.name, w.description, w.ownerName, w.ownerEmail, w.companyName, w.triggerText]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }, [rows, q]);

  const act = async (w, fn, after) => {
    setBusy(w.id);
    setNotice('');
    try {
      const res = await fn();
      after?.(res);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const patch = (id, changes) => setRows((rs) => (rs || []).map((r) => (r.id === id ? { ...r, ...changes } : r)));

  const pause = (w) => act(w, () => api.wfStatus(w.id, { status: 'paused', reason: '' }), (res) => patch(w.id, res?.status ? res : { status: 'paused' }));
  const resume = (w) => act(w, () => api.wfStatus(w.id, { status: 'active', reason: '' }), (res) => patch(w.id, res?.status ? res : { status: 'active', pausedReason: '' }));
  const duplicate = (w) => act(w, () => api.wfDuplicate(w.id, { name: `${w.name} (Copy)`, companyId: w.companyId || '' }), (res) => {
    if (res?.id) go(buildSub('builder', res.id)); else load();
  });
  const archive = async (w) => {
    const ok = await dialog.confirm(`Archive "${w.name}"? It stops running and leaves the list. Its runs stay in Runs.`, { title: 'Archive Workflow', confirmText: 'Archive', danger: true });
    if (!ok) return;
    act(w, () => api.wfStatus(w.id, { status: 'archived', reason: '' }), () => setRows((rs) => (rs || []).filter((r) => r.id !== w.id)));
  };
  // Delete is held on the row (Hold to confirm, Neil, Oct 30 2026): one
  // workflow, so no dialog; a refusal rewinds the button with the reason and
  // the row leaves once the check has shown (onDone).
  const remove = async (w) => {
    setNotice('');
    try {
      await api.wfDelete(w.id);
    } catch (e) {
      throw new Error(errorText(e), { cause: e });
    }
  };
  const removed = (w) => setRows((rs) => (rs || []).filter((r) => r.id !== w.id));
  const create = () => act({ id: 'new' }, () => api.wfCreate({ name: 'Untitled Workflow', companyId: '' }), (res) => { if (res?.id) go(buildSub('builder', res.id)); });

  const triggerText = (w) => w.triggerText || describeTrigger(w.trigger, catalog);

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div className="scroll-tabs" role="tablist" aria-label="Scope" style={{ display: 'flex', gap: 8, paddingBottom: 2, flex: '1 1 auto', minWidth: 0 }}>
          {scopes.map((s) => <Chip key={s.key} on={scope === s.key} onClick={() => setScope(s.key)}>{s.label}</Chip>)}
        </div>
        <label style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} data-slash-search="" placeholder="Search workflows" aria-label="Search workflows"
            style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', font: 'inherit', fontSize: 13 }} />
        </label>
        <button type="button" className="primary-btn" onClick={create} disabled={busy === 'new'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Workflow
        </button>
      </div>
      {notice && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13, marginBottom: 10 }}>{notice}</div>}

      <AsyncSection loading={loading && !rows} error={error && !rows} onRetry={() => load()}
        errorMessage="The workflows couldn't be loaded right now - please try again."
        isEmpty={!shown.length}
        skeleton={<SkeletonBlocks count={4} height={56} borderRadius={10} />}
        emptyContent={
          <Card>
            <EmptyState icon={WorkflowIcon} title={q ? 'No workflow matches that' : 'No workflows here yet'}
              hint={q ? 'Try another word, or another scope.' : 'Start from a template on the Templates tab, or click New Workflow.'} />
          </Card>
        }>
        <Card>
          {/* Between the phone cards and a wide desktop the table scrolls
              sideways inside the card instead of clipping its last columns. */}
          <div style={isMobile ? undefined : { overflowX: 'auto' }}>
            <div style={isMobile ? undefined : { minWidth: 980 }}>
              {!isMobile && (
                <div role="row" style={{ ...GRID, padding: '8px 16px', fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>
                  <span>Name</span><span>Trigger</span><span>Scope</span><span>Owner</span><span>Status</span><span style={{ textAlign: 'right' }}>Runs 7d</span><span>Last Run</span><span />
                </div>
              )}
              {shown.map((w) => {
                const m = wfStatusMeta(w.status);
                const actions = (
                  <div style={{ display: 'flex', gap: isMobile ? 6 : 4, justifyContent: isMobile ? 'flex-start' : 'flex-end', flexWrap: isMobile ? 'wrap' : 'nowrap' }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    {w.status === 'active' && <IconBtn label="Pause" Icon={Pause} onClick={() => pause(w)} disabled={busy === w.id} />}
                    {(w.status === 'paused' || w.status === 'needs_attention') && <IconBtn label="Resume" Icon={Play} onClick={() => resume(w)} disabled={busy === w.id} />}
                    <IconBtn label="Duplicate" Icon={Copy} onClick={() => duplicate(w)} disabled={busy === w.id} />
                    {w.status !== 'archived' && <IconBtn label="Archive" Icon={Archive} onClick={() => archive(w)} disabled={busy === w.id} />}
                    <HoldButton size="sm" label="Delete" doneLabel="Deleted" onConfirm={() => remove(w)} onDone={() => removed(w)} disabled={busy === w.id}
                      fallbackMessage={`Delete "${w.name}" for good? It stops running and cannot be brought back. Runs still waiting are cancelled; its past runs stay in Runs.`} />
                  </div>
                );
                const open = () => go(buildSub('builder', w.id));
                if (isMobile) {
                  return (
                    <div key={w.id} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
                      style={{ padding: '12px 14px', borderTop: '1px solid var(--line)', display: 'grid', gap: 6, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{w.name}</span>
                        <StatusLabel label={m.label} color={m.color} size="sm" />
                      </div>
                      <Muted>{triggerText(w)}</Muted>
                      <Muted>{w.companyName || 'Every Company'} - {w.ownerName || w.ownerEmail || '-'} - {w.runs7d ?? 0} runs in 7 days{w.lastRunAt ? ` - last ${formatDateTime(w.lastRunAt)}` : ''}</Muted>
                      {w.pausedReason && <Muted style={{ color: 'hsl(var(--color-orange))' }}>Paused: {w.pausedReason}</Muted>}
                      {w.companyEnabled === false && <Muted style={{ color: 'hsl(var(--color-orange))' }}>{COMPANY_OFF}</Muted>}
                      {actions}
                    </div>
                  );
                }
                return (
                  <div key={w.id} role="row" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
                    style={{ ...GRID, padding: '10px 16px', borderTop: '1px solid var(--line)', alignItems: 'center', cursor: 'pointer', fontSize: 13.5 }}>
                    <span style={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.description || ''}>{w.name}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)' }} title={triggerText(w)}>{triggerText(w)}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.companyName || 'Every Company'}</span>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.ownerEmail || ''}>{w.ownerName || w.ownerEmail || '-'}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                      <StatusLabel label={m.label} color={m.color} size="sm" />
                      {w.pausedReason && <Muted style={{ fontSize: 11.5 }}>{w.pausedReason}</Muted>}
                      {w.companyEnabled === false && <Muted style={{ fontSize: 11.5 }}>{COMPANY_OFF}</Muted>}
                    </span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {w.runs7d ?? 0}{w.failCount > 0 && <span style={{ color: 'hsl(var(--color-red))', marginLeft: 4 }} title="Failed runs">({w.failCount})</span>}
                    </span>
                    <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: 12.5 }}>{w.lastRunAt ? formatDateTime(w.lastRunAt) : '-'}</span>
                    {actions}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </AsyncSection>
    </div>
  );
}

const GRID = { display: 'grid', gridTemplateColumns: 'minmax(160px, 1.4fr) minmax(160px, 2fr) minmax(110px, 1fr) minmax(120px, 1fr) 112px 64px 140px 132px', gap: 12 };   // the last: four 30px row actions and their gaps, the same on every row

// The company has workflows switched off in Settings > Workflows: the server
// says so with companyEnabled: false (a row without the flag says nothing).
const COMPANY_OFF = 'Paused: company switch';

// On a desktop row the actions are icons on one line (the label is the
// tooltip and the accessible name); a phone card keeps the words.
function IconBtn({ label, Icon, onClick, disabled }) {
  const isMobile = useIsMobile('(max-width: 760px)');
  return (
    <button type="button" className="secondary-btn" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      style={isMobile
        ? { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', fontSize: 12.5 }
        : { display: 'inline-grid', placeItems: 'center', width: 30, height: 30, padding: 0 }}>
      <Icon size={isMobile ? 13 : 15} aria-hidden="true" />{isMobile && <span>{label}</span>}
    </button>
  );
}
