// Settings > Operations > Cubby Tasks (Neil, Oct 30 2026): Cubby's tasks come
// into Nexus Tasks after each 15-minute Cubby sync - each facility's into the
// project picked here, a task assigned to people in Cubby to those people -
// and a Cubby task completed or reopened in Nexus is sent back to Cubby,
// behind its own switch (off by default - Visesh, Oct 20-21 2026: nothing is
// written to Cubby unless a switch under Settings says so). Server side:
// backend/cubby_tasks.py, routers/cubby_tasks.py.
//
// Settings saves one way (Oct 23 2026): the two switches and each facility's
// project select save on change, with a toast. No Save row - there is no
// typed field here.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks, Spinner } from '../components/AsyncState';
import { SettingCard, SettingRow, SwitchRow } from '../components/settings/SettingsUI';
import { formatDateTime } from '../lib/datetime';

const note = { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 };

export default function CubbyTasksSettings({ toastOk, toastErr }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [busy, setBusy] = useState('');          // 'on' | 'close' | 'sync' | a facility id
  const load = useCallback(async () => {
    try { setState({ status: 'ready', data: await api.getCubbyTaskSettings() }); } catch (err) {
      console.error('Cubby Tasks settings: could not load', err);
      setState({ status: 'error', data: null });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <SkeletonBlocks count={3} height={44} borderRadius={10} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the Cubby Tasks settings." onRetry={load} />;
  const s = state.data;
  const canEdit = !!s.canEdit;

  const save = async (key, patch, okText) => {
    setBusy(key);
    try {
      setState({ status: 'ready', data: await api.saveCubbyTaskSettings(patch) });
      toastOk?.(okText);
    } catch (err) {
      console.error('Cubby Tasks settings: could not save', err);
      toastErr?.(err?.message || 'That could not be saved.');
    } finally { setBusy(''); }
  };
  const flipOn = (next) => save('on', { on: next }, next ? 'Cubby Tasks is on' : 'Cubby Tasks is off');
  const flipClose = (next) => {
    if (next && !window.confirm('Close tasks in Cubby from Nexus? When someone completes or reopens a Cubby task in Nexus, Nexus will do the same in Cubby.')) return;
    save('close', { closeInCubby: next }, next ? 'Close Tasks in Cubby is on' : 'Close Tasks in Cubby is off');
  };
  const pickProject = (facilityId, projectId) => {
    const projects = { ...(s.projects || {}) };
    if (projectId) projects[facilityId] = projectId; else delete projects[facilityId];
    const fac = s.facilities.find((f) => f.id === facilityId);
    const proj = s.projectOptions.find((p) => p.id === projectId);
    save(facilityId, { projects }, proj ? `${facName(fac)} tasks go to ${proj.name}` : `${facName(fac)} tasks are skipped`);
  };
  const syncNow = async () => {
    setBusy('sync');
    try {
      const r = await api.runCubbyTaskSync();
      setState({ status: 'ready', data: r });
      const run = r.run || {};
      toastOk?.(run.status === 'off' ? 'Cubby Tasks is off' : `Synced: ${run.created || 0} new, ${run.updated || 0} updated, ${run.completedFromCubby || 0} completed from Cubby`);
    } catch (err) {
      console.error('Cubby Tasks: sync failed', err);
      toastErr?.(err?.message || 'The sync could not run.');
    } finally { setBusy(''); }
  };

  const run = s.lastRun || {};
  const unmapped = Object.entries(run.unmapped || {});
  const unmatched = Object.entries(run.unmatchedPeople || {});
  const facById = Object.fromEntries((s.facilities || []).map((f) => [f.id, f]));

  return (
    <div data-testid="cubby-tasks-settings" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingCard>
        <SwitchRow id="cubby-tasks-on" title="Bring Cubby Tasks Into Nexus" checked={!!s.on} onChange={flipOn}
          disabled={!canEdit || busy === 'on'}
          desc="After each Cubby sync (every 15 minutes), every open Cubby task becomes a task in the facility's project below, linked to Cubby. A task assigned to people in Cubby goes to those people; one assigned to a group, or to nobody, goes to the project for the facility manager. Tasks made in Nexus never go to Cubby.">
          {s.on && !s.warehouseConfigured && (
            <p className="ops-note" role="status" style={{ margin: 0, color: 'var(--warn-fg)' }}>
              This server is not connected to Cubby&apos;s reporting warehouse (CUBBY_BQ_CREDENTIALS_JSON), which is where Cubby says
              who a task is assigned to. Until an administrator connects it, every Cubby task lands in its facility&apos;s project with no assignee.
            </p>
          )}
        </SwitchRow>
        <SwitchRow id="cubby-tasks-close" title="Close Tasks in Cubby" checked={!!s.closeInCubby} onChange={flipClose}
          disabled={!canEdit || busy === 'close'}
          desc="Off (the default): completing a Cubby task in Nexus changes nothing in Cubby - a manager closes it there too. On: a Cubby task completed or reopened in Nexus is completed or reopened in Cubby within a minute. Needs the Manager-role Cubby key.">
          {s.closeInCubby && !s.writeConfigured && (
            <p className="ops-note" role="status" style={{ margin: 0, color: 'var(--warn-fg)' }}>
              This server has no Cubby key with the Manager role ({s.writeKeyEnv}), so nothing is sent until an administrator adds it
              in the API&apos;s app settings. Completions wait in the queue meanwhile.
            </p>
          )}
        </SwitchRow>
      </SettingCard>

      <div>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Where Each Facility&apos;s Tasks Go</div>
        <SettingCard>
          {(s.facilities || []).length === 0 && (
            <SettingRow title="No facilities yet" desc="The facility list fills in after the first Cubby sync." />
          )}
          {(s.facilities || []).map((f) => (
            <SettingRow key={f.id} title={facName(f)} desc={f.internalName && f.internalName !== f.name ? f.name : undefined}
              control={(
                <select className="form-select" aria-label={`Project for ${facName(f)}`} value={(s.projects || {})[f.id] || ''}
                  disabled={!canEdit || busy === f.id} onChange={(e) => pickProject(f.id, e.target.value)} style={{ minWidth: 220 }}>
                  <option value="">Skip this facility</option>
                  {(s.projectOptions || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )} />
          ))}
        </SettingCard>
        <p style={{ ...note, margin: '8px 0 0' }}>
          Tasks are created as the project&apos;s owner (else whoever last saved these settings), so they land on that company&apos;s side.
          A facility set to Skip is counted in the run below, never guessed.
        </p>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>Last Run</div>
          {canEdit && (
            <button type="button" className="secondary-btn" onClick={syncNow} disabled={!s.on || busy === 'sync'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {busy === 'sync' ? <Spinner size={13} /> : <RefreshCw size={13} />} Sync Now
            </button>
          )}
        </div>
        <SettingCard>
          <div className="nx-set-row" data-testid="cubby-tasks-run" style={note}>
            {!run.at && <span>No run yet{s.on ? ' - the next Cubby sync starts one.' : '.'}</span>}
            {run.at && (
              <>
                <div style={{ color: 'var(--ink)', fontWeight: 600 }}>
                  {formatDateTime(run.at)} - {run.status === 'failed' ? 'failed' : run.status === 'partial' ? 'finished with errors' : 'finished'}
                  {run.trigger === 'manual' ? ' (Sync Now)' : ''}
                </div>
                {run.error && <div style={{ color: 'var(--danger-fg, #b91c1c)' }}>{run.error}</div>}
                {run.status !== 'failed' && (
                  <div>
                    {run.open || 0} open in Cubby · {run.created || 0} new in Nexus · {run.updated || 0} updated · {run.reassigned || 0} reassigned ·{' '}
                    {run.completedFromCubby || 0} completed from Cubby · {run.reopenedFromCubby || 0} reopened from Cubby
                  </div>
                )}
                {run.warehouse && run.warehouse !== 'ok' && <div>Assignees not read: {run.warehouse}.</div>}
                {unmapped.length > 0 && (
                  <div>Skipped, no project picked: {unmapped.map(([fid, n]) => `${facName(facById[fid]) || fid} (${n})`).join(', ')}.</div>
                )}
                {(run.noCreator || []).length > 0 && (
                  <div>No one to create tasks as for: {run.noCreator.map((fid) => facName(facById[fid]) || fid).join(', ')} - give the project an owner who is in the directory.</div>
                )}
                {unmatched.length > 0 && (
                  <div>Assigned in Cubby to people with no Nexus account: {unmatched.map(([n, c]) => `${n} (${c})`).join(', ')}.</div>
                )}
                {(run.errors || []).length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} data-testid="cubby-tasks-errors">
                    {run.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </>
            )}
            <div style={{ marginTop: 6 }}>
              {s.linked || 0} Cubby {s.linked === 1 ? 'task' : 'tasks'} linked, {s.linkedOpen || 0} open.
              {s.pending > 0 && ` ${s.pending} ${s.pending === 1 ? 'change' : 'changes'} waiting to go to Cubby${s.closeInCubby ? '' : ' (Close Tasks in Cubby is off)'}.`}
              {s.stuck > 0 && ` ${s.stuck} ${s.stuck === 1 ? 'has' : 'have'} stopped retrying - see the errors below.`}
            </div>
            {(s.pendingErrors || []).length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} data-testid="cubby-tasks-push-errors">
                {s.pendingErrors.map((e, i) => <li key={i}>{e.title}: {e.error} (tried {e.attempts}×)</li>)}
              </ul>
            )}
          </div>
        </SettingCard>
      </div>

      {!canEdit && (
        <p className="ops-note" style={{ margin: 0 }}>
          You can see these settings. Only a Global Admin, an IT Admin or someone with Full access to Operations can change them.
        </p>
      )}
      {s.updatedAt && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Last changed {formatDateTime(s.updatedAt)} by {s.updatedBy}</div>
      )}
    </div>
  );
}

function facName(f) {
  if (!f) return '';
  return (f.internalName || f.name || f.id || '').trim();
}
