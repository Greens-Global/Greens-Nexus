// Task Module - Manage: admin surface for the whole workspace. Internal sub-tab
// strip (Automation rules · Custom fields · Custom statuses · Templates · Intake
// forms · Activity log · Reporting), ported from the export's manage/ + reporting/
// screens onto the Nexus inline-style idiom + FastAPI-backed store.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap, Plus, Trash2, Pencil, ListChecks, FileText, Inbox, Activity as ActivityIcon,
  BarChart3, Download, X, CheckCircle2, Flag, ArrowRightLeft, User, Calendar, MessageSquare,
  Circle, Palette, Users, List, Mail, FolderPlus,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { api } from '../api';
import {
  NX, FONT, card, chip, btn, input as inputStyle,
  STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, colorForKey,
} from './theme';
import { Avatar, EmptyState, Modal } from './components';
import { taskStats, topLevel, fmtDateTime, teamProjectIds } from './lib';
import TasksWorkspace from './TasksWorkspace';
import { TeamModal, deptIcon } from './TeamsView';
import TaskNotifySettings from './TaskNotifySettings';

// ── Small shared bits ─────────────────────────────────────────────────────────
const fieldLabel = { display: 'block', fontSize: 12.5, fontWeight: 600, color: NX.dim, marginBottom: 6 };
const selectStyle = { ...inputStyle, cursor: 'pointer' };
const iconBadge = { width: 32, height: 32, flexShrink: 0, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: NX.hover };

function Field({ label, children }) {
  return <div style={{ marginBottom: 14 }}><label style={fieldLabel}>{label}</label>{children}</div>;
}

function SectionHead({ title, hint, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: NX.ink }}>{title}</div>
        {hint && <div style={{ fontSize: 13, color: NX.dim, marginTop: 2 }}>{hint}</div>}
      </div>
      {action}
    </div>
  );
}

function RowCard({ children }) {
  return <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: 12, marginBottom: 8 }}>{children}</div>;
}

function IconButton({ icon: Icon, onClick, title, danger }) {
  return (
    <button type="button" title={title} onClick={onClick}
      style={{ ...btn('ghost'), padding: 7, color: danger ? NX.red : NX.dim }}>
      <Icon size={16} />
    </button>
  );
}

const STATUS_KEYS = STATUS_ORDER;
const PRIORITY_KEYS = PRIORITY_ORDER;
const SWATCHES = [NX.blue, NX.green, NX.amber, NX.red, NX.purple, NX.teal, NX.pink, NX.dim];

// ── Sub-tabs registry ─────────────────────────────────────────────────────────
const SUBTABS = [
  { key: 'tasklist', label: 'Task List', icon: List },
  { key: 'import', label: 'Asana', icon: Download },
  { key: 'departments', label: 'Teams', icon: Users },
  { key: 'rules', label: 'Automation Rules', icon: Zap },
  { key: 'fields', label: 'Custom Fields', icon: ListChecks },
  { key: 'statuses', label: 'Custom Statuses', icon: Palette },
  { key: 'templates', label: 'Templates', icon: FileText },
  { key: 'intake', label: 'Intake Forms', icon: Inbox },
  { key: 'taskNotify', label: 'Task Notifications', icon: Mail },
  { key: 'activity', label: 'Activity Log', icon: ActivityIcon },
  { key: 'reporting', label: 'Reporting', icon: BarChart3 },
];

export default function ManageView() {
  const store = useTasks();
  const [tab, setTab] = useState('rules');

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Sub-tab strip - underline tabs, horizontally scrollable on mobile */}
      <div data-tour="task-manage-tabs" className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto' }}>
        {SUBTABS.map((t) => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              ...btn('ghost'), flexShrink: 0, padding: '13px 12px', borderRadius: 0,
              borderBottom: `2px solid ${active ? NX.primary : 'transparent'}`,
              color: active ? NX.ink : NX.dim, fontWeight: active ? 700 : 600,
            }}>
              <t.icon size={15} />{t.label}
            </button>
          );
        })}
      </div>

      {/* Body - the Task List is full-bleed (wide, self-scrolling table); the rest
          keep the centered admin column. */}
      {tab === 'tasklist' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <TasksWorkspace title="Task List" />
        </div>
      ) : (
        <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.surface2, padding: 20 }}>
          <div style={{ maxWidth: 940, margin: '0 auto' }}>
            {tab === 'import' && <AsanaImportTab store={store} />}
            {tab === 'departments' && <TeamsTab store={store} />}
            {tab === 'rules' && <RulesTab store={store} />}
            {tab === 'fields' && <FieldsTab store={store} />}
            {tab === 'statuses' && <StatusesTab store={store} />}
            {tab === 'templates' && <TemplatesTab store={store} />}
            {tab === 'intake' && <IntakeTab store={store} />}
            {tab === 'taskNotify' && <TaskNotifySettings />}
            {tab === 'activity' && <ActivityTab store={store} />}
            {tab === 'reporting' && <ReportingTab store={store} />}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Import from Asana - paste a token + project GIDs, runs server-side ─────────
function AsanaImportTab({ store }) {
  const [token, setToken] = useState('');
  const [gids, setGids] = useState('');
  const opts = { subtasks: true, comments: true, attachments: true, silent_comments: true };
  const [busy, setBusy] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projects, setProjects] = useState(null);   // null = not loaded; [] = loaded, none
  const [picked, setPicked] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const togglePick = (gid) => setPicked((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });

  const loadProjects = async () => {
    if (!token.trim()) { setError('Enter your Asana token first.'); return; }
    setError(''); setLoadingProjects(true);
    try {
      const list = await api.asanaListProjects({ token: token.trim() });
      setProjects(list);
      if (list.length === 0) setError('No projects found for this token.');
    } catch (e) { setError(e.message || String(e)); } finally { setLoadingProjects(false); }
  };

  const run = async () => {
    // selected from the picker + any manually typed GIDs. An EMPTY list is
    // meaningful: the server then imports every project the token can see, so
    // the common case needs nothing but a token.
    const typed = gids.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const list = [...new Set([...picked, ...typed])];
    if (!token.trim()) { setError('Enter your Asana token first.'); return; }
    setError(''); setResult(null); setBusy(true);
    try {
      const res = await api.asanaImport({ token: token.trim(), project_gids: list, ...opts });
      setResult(res);
      await store.refresh?.();   // pull the newly-created projects/tasks into the UI
    } catch (e) {
      setError(e.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <SectionHead title="Import from Asana" hint="Bring projects, tasks, subtasks, comments and attachments in from Asana. A token on its own imports everything it can see." />
      <div style={{ ...card, padding: 16, maxWidth: 620 }}>
        <Field label="Asana Personal Access Token">
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={token} onChange={(e) => { setToken(e.target.value); setProjects(null); setPicked(new Set()); }} placeholder="1/…  (app.asana.com → My Apps → Personal access tokens)"
              style={{ ...inputStyle, flex: 1 }} autoComplete="off" />
            <button onClick={loadProjects} disabled={loadingProjects || !token.trim()} style={{ ...btn('outline'), flexShrink: 0, opacity: loadingProjects ? 0.6 : 1 }}>
              {loadingProjects ? 'Loading…' : 'Load projects'}
            </button>
          </div>
        </Field>

        {/* Project picker - populated by "Load projects" */}
        {projects && projects.length > 0 && (
          <Field label={`Projects  (${picked.size} selected)`}>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 8 }}>
              {projects.map((p) => (
                <label key={p.gid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontSize: 13, cursor: 'pointer', borderBottom: `1px solid ${NX.border2}` }}>
                  <input type="checkbox" checked={picked.has(p.gid)} onChange={() => togglePick(p.gid)} />
                  <span style={{ flex: 1, minWidth: 0, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.workspace && <span style={{ fontSize: 11, color: NX.faint }}>{p.workspace}</span>}
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label="Project GID(s) - optional">
          <input value={gids} onChange={(e) => setGids(e.target.value)} placeholder="Leave blank to import everything this token can see" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Only needed to import a specific subset. Otherwise leave it blank, or tick projects
            after <b>Load projects</b> above.
          </div>
        </Field>
        {error && <div style={{ color: NX.red, fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button onClick={run} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>
            <Download size={15} />{busy ? 'Importing…' : 'Import'}
          </button>
          {busy && <span style={{ fontSize: 12.5, color: NX.dim }}>Reading Asana and creating tasks - this can take a minute for large projects.</span>}
        </div>
        {result && (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: NX.hover, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: NX.green, marginBottom: 6 }}>✓ Import complete</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, color: NX.dim }}>
              {/* "tasks" counts subtasks too - the importer walks one tree and
                  doesn't split the two. "updated" covers rows that already
                  existed and were refreshed rather than created. */}
              <span><b style={{ color: NX.ink }}>{result.projects}</b> projects</span>
              <span><b style={{ color: NX.ink }}>{result.tasks}</b> tasks &amp; subtasks</span>
              <span><b style={{ color: NX.ink }}>{result.skipped || 0}</b> updated</span>
              <span><b style={{ color: NX.ink }}>{result.comments}</b> comments</span>
              <span><b style={{ color: NX.ink }}>{result.attachments}</b> attachments</span>
              <span><b style={{ color: NX.ink }}>{result.activities || 0}</b> activity entries</span>
            </div>
            {result.errors?.length > 0 && (
              <div style={{ marginTop: 8, color: NX.red, fontSize: 12 }}>{result.errors.length} error(s): {result.errors.join('; ')}</div>
            )}
          </div>
        )}
      </div>

      <div style={{ height: 24 }} />
      <AsanaSyncPanel store={store} />
    </div>
  );
}

// ── Two-way sync (Nexus <-> Asana) ────────────────────────────────────────────
function AsanaSyncPanel({ store }) {
  const [cfg, setCfg] = useState(null);
  const [token, setToken] = useState('');
  const [map, setMap] = useState({});   // nexusProjectId -> asanaProjectGid
  // nexusProjectId -> "Team A, Team B". No longer editable (team shares are
  // detected automatically); kept so saving the mapping round-trips any legacy
  // value instead of silently clearing it.
  const [extraTeams, setExtraTeams] = useState({});
  const [hooks, setHooks] = useState([]);
  const [hookEnv, setHookEnv] = useState({ publicBase: '', isSyncWorker: false });
  const [asanaProjects, setAsanaProjects] = useState(null);   // null = not loaded
  const [targetBase, setTargetBase] = useState('');   // override only; blank = use the API's own host
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [dupes, setDupes] = useState(null);
  const [assignees, setAssignees] = useState(null);
  const [workspaces, setWorkspaces] = useState(null);   // dry-run result awaiting confirmation
  const [orphans, setOrphans] = useState(null); // stranded-row dry run, same shape
  const [teamReport, setTeamReport] = useState([]); // per-team access outcomes from the last pull
  const [importJob, setImportJob] = useState(null); // live "Import All Projects" run, polled
  // True once this page has actually SEEN the job as "running" - gates whether
  // watchImport's mount-time check is allowed to call importDone. Without this,
  // opening the page re-displayed whatever import last happened (even days
  // ago, even cancelled) as if it had just finished, because the status
  // endpoint always returns the latest-ever job with no "already shown" flag.
  const hasWatchedRunning = useRef(false);
  const [setupToken, setSetupToken] = useState('');   // Setup card's own PAT (write-only)

  const load = () => {
    api.getAsanaSyncConfig().then((c) => {
      setCfg(c);
      setMap(Object.fromEntries((c.projectMap || []).map((m) => [m.nexusProjectId, m.asanaProjectGid])));
      setExtraTeams(Object.fromEntries((c.projectMap || []).map((m) => [m.nexusProjectId, (m.extraTeamNames || []).join(', ')])));
    }).catch(() => setCfg({ enabled: false, hasToken: false, projectMap: [] }));
    api.getAsanaWebhooks().then((r) => {
      setHooks(r.webhooks || []);
      setHookEnv({ publicBase: r.publicBase || '', isSyncWorker: !!r.isSyncWorker });
    }).catch(() => setHooks([]));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const loadAsanaProjects = async () => {
    setErr(''); setBusy('loadproj');
    try { setAsanaProjects(await api.getAsanaSyncProjects()); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Fills only the BLANK rows below - never overwrites an entry the operator
  // already typed or picked, and never creates a Nexus project (that stays
  // exclusive to Import from Asana / Import All Projects). Nothing is saved
  // until Save mapping is clicked, so a bad match costs nothing to undo.
  //
  // Two ways a row can match:
  //  1. Name, case/whitespace-insensitive - the common case.
  //  2. GID: if the Nexus project's own name literally contains an Asana
  //     project's gid (someone pasted "Foo (1216...)" as the name, or the
  //     project was named after its gid directly), that's matched too.
  // Always fetches a FRESH Asana project list rather than reusing whatever was
  // last loaded - a project created or renamed in Asana since the last "Load
  // Asana projects" click must not silently fail to match just because the
  // cached list predates it.
  const normName = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const autoMapProjects = async () => {
    setErr(''); setBusy('automap');
    try {
      const list = await api.getAsanaSyncProjects();
      setAsanaProjects(list);
      const byName = new Map(list.map((p) => [normName(p.name), p.gid]));
      const claimed = new Set(Object.values(map).filter(Boolean));
      let matched = 0;
      setMap((m) => {
        const next = { ...m };
        for (const p of projects) {
          if (next[p.id]) continue;
          const name = p.name || '';
          const gid = byName.get(normName(name))
            || list.find((ap) => name.includes(ap.gid))?.gid;
          if (gid && !claimed.has(gid)) { next[p.id] = gid; claimed.add(gid); matched++; }
        }
        return next;
      });
      setMsg(`Matched ${matched} project(s) by name or GID - review below, then Save mapping.`);
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Saves an empty mapping - the same PUT the form already sends when every
  // row is blank, just as a one-click shortcut for starting a curated mapping
  // from scratch. Does not touch tasks; only stops pull/push from following
  // these projects until they're remapped.
  const clearMap = async () => {
    if (!confirm('Remove every project mapping? This only stops pull/push from touching these projects - no tasks are deleted.')) return;
    setErr(''); setBusy('clearmap');
    try { await api.setAsanaProjectMap({ maps: [] }); setMap({}); setMsg('Mapping cleared.'); load(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  const webhooks = async (action) => {
    setErr(''); setMsg(''); setBusy(action);
    try {
      if (action === 'register') {
        const res = await api.registerAsanaWebhooks({ target_base: targetBase.trim() || null });
        setMsg(`Registered ${res.registered} webhook(s).`);
      } else {
        const res = await api.deleteAsanaWebhooks();
        setMsg(`Removed ${res.removed} webhook(s).`);
      }
      load();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  const saveConfig = async (patch) => {
    setErr(''); setMsg(''); setBusy('config');
    try { const c = await api.setAsanaSyncConfig(patch); setCfg((p) => ({ ...p, ...c })); setToken(''); setMsg('Saved.'); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };
  const saveMap = async () => {
    setErr(''); setMsg(''); setBusy('map');
    const maps = Object.entries(map).filter(([, g]) => g && g.trim()).map(([nexusProjectId, asanaProjectGid]) => ({
      nexusProjectId, asanaProjectGid: asanaProjectGid.trim(),
      extraTeamNames: (extraTeams[nexusProjectId] || '').split(',').map((s) => s.trim()).filter(Boolean),
    }));
    try { await api.setAsanaProjectMap({ maps }); setMsg(`Saved ${maps.length} project mapping(s).`); load(); }
    catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };
  // "Push all" writes Nexus's current rows over the real Asana workspace, and
  // it is the one control here that can destroy work nobody can get back: an
  // Asana edit made since this backend last pulled is overwritten, and any
  // queued deletions drain to Asana in the same run. It is also available from
  // a local backend, deliberately, so a laptop pointed at a database holding
  // the shared token can overwrite production in a single click with no idea
  // that is what it is doing. So: say which workspace, say how much, and say
  // when this instance is not the one that owns the sync.
  const confirmPush = () => {
    const ws = (workspaces || []).find((w) => w.gid === cfg.workspaceGid);
    const target = ws ? `"${ws.name}" (${ws.gid})` : (cfg.workspaceGid || 'the configured workspace');
    const mapped = Object.values(map).filter((g) => g && g.trim()).length;
    return window.confirm(
      `Push every task in ${mapped} mapped project(s) to Asana workspace ${target}.\n\n`
      + 'This overwrites the Asana copy with what Nexus holds now, including any '
      + 'change made in Asana since this backend last pulled, and sends any pending '
      + 'deletions.\n'
      + (hookEnv.isSyncWorker ? '' : '\nThis backend does not run background sync, so its data '
         + 'is probably older than Asana\'s. If this is your local machine, pull first or cancel.\n')
      + '\nContinue?');
  };
  const run = async (which) => {
    if (which === 'push' && !confirmPush()) return;
    setErr(''); setMsg(''); setBusy(which);
    try {
      const res = which === 'pull' ? await api.asanaSyncPull() : await api.asanaSyncPushAll();
      await store.refresh?.();
      setMsg(which === 'pull'
        ? `Pulled from Asana: +${res.created} created, ${res.updated} updated, +${res.comments || 0} comments${res.deleted ? `, ${res.deleted} deleted` : ''}.`
        : `Pushed ${res.pushed} task(s) to Asana`
          + (res.deleted ? `, deleted ${res.deleted} there` : '')
          + (res.pendingDeletes ? ` (${res.pendingDeletes} deletion(s) still pending)` : '') + '.');
      // Team access resolves through several steps that all fail quietly on the
      // Asana side; the pull now reports each outcome by name so a team that
      // didn't come across says why instead of just not appearing.
      setTeamReport(which === 'pull' ? (res.teams || []) : []);
      load();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // One click to bring the whole workspace across: create/adopt a Nexus project
  // per Asana project, map it, import its contents. Runs the same engine as
  // Pull, so nothing here is a second inbound path.
  //
  // The server runs it in the background and we poll, because a full workspace
  // takes minutes and Azure kills any request at ~230s. Progress lives in the
  // DB, so closing this page does not stop the import and coming back picks it
  // up again.
  const importDone = useCallback((job) => {
    const res = job.result || {};
    if (job.status === 'error') { setErr(job.error || 'Import failed.'); return; }
    // Stalled: the worker went away mid-run. Not a failure to act on - it picks
    // up where it stopped when the API next starts, and Import resumes it too.
    if (job.status === 'stalled') {
      setErr(`${job.error || 'Import stopped responding.'} It will resume automatically.`);
      return;
    }
    // A cancelled run keeps everything it already imported - saying so matters,
    // or it reads as if the work was thrown away.
    setMsg((job.status === 'cancelled' ? 'Import stopped. Kept what it had already imported: ' : '')
      + `Imported ${res.projects || 0} project(s): +${res.tasks || 0} task(s), `
      + `+${res.comments || 0} comment(s), +${res.attachments || 0} attachment(s)`
      + (res.skipped ? `, ${res.skipped} already present` : '')
      + `. ${res.mapped ?? res.projects ?? 0} project(s) mapped.`
      + ((res.errors || []).length ? ` ${res.errors.length} issue(s): ${res.errors.join('; ')}` : ''));
  }, []);

  const watchImport = useCallback(async () => {
    const job = await api.asanaSyncImportAllStatus().catch(() => null);
    if (!job || job.status === 'idle') { setImportJob(null); return false; }
    setImportJob(job);
    if (job.status === 'running') { hasWatchedRunning.current = true; return true; }
    setImportJob(null);
    // Only report a result for a run this page actually watched happen - a job
    // that was ALREADY finished/cancelled/stalled the first time we checked is
    // history from a previous visit (possibly someone else's, possibly days
    // old), not news, and must not be replayed as if it just completed.
    if (hasWatchedRunning.current) { importDone(job); hasWatchedRunning.current = false; }
    await store.refresh?.();
    load();
    return false;
  }, [importDone, store, load]);

  // Poll only while a job is live, and stop on unmount so a closed page does
  // not keep hitting the API.
  useEffect(() => {
    if (!importJob || importJob.status !== 'running') return undefined;
    let alive = true;
    const id = setInterval(() => { if (alive) watchImport(); }, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [importJob, watchImport]);

  // An import already running when this page opens (started here earlier, or by
  // someone else) shows its progress instead of looking idle.
  useEffect(() => { watchImport(); /* once on mount */ }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const importAll = async () => {
    setErr(''); setMsg('');
    try {
      setImportJob(await api.asanaSyncImportAll());
    } catch (e) { setErr(e.message || String(e)); }
  };

  const cancelImport = async () => {
    try { setImportJob(await api.asanaSyncImportAllCancel()); }
    catch (e) { setErr(e.message || String(e)); }
  };

  // Step 2 of setup - the same setting as the "Sync enabled" checkbox above, so the
  // three steps read as a sequence. A toggle, not a one-way switch: turning sync off
  // is the fastest way to stop a mess reaching the shared Asana workspace.
  const toggleSync = async () => {
    const next = !cfg.enabled;
    setErr(''); setMsg(''); setBusy('enable');
    try {
      const c = await api.setAsanaSyncConfig({ enabled: next });
      setCfg((p) => ({ ...p, ...c }));
      setMsg(next
        ? 'Sync is ON - mapped projects pull from Asana every 2 minutes and push changes out automatically (on the deployed API).'
        : 'Sync is OFF - nothing pulls or pushes until you turn it back on. Manual Pull / Push all still work.');
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Setup's own PAT. Blank falls back to the service token below.
  const saveSetupToken = async () => {
    setErr(''); setMsg(''); setBusy('setuptoken');
    try {
      const c = await api.setAsanaSyncConfig({ setup_token: setupToken.trim() });
      setCfg((p) => ({ ...p, ...c }));
      setSetupToken('');
      setMsg(c.hasSetupToken ? 'Setup token saved.' : 'Setup token cleared - setup will use the service token.');
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Step 3. Only possible where Asana can reach this API, so the button says so
  // rather than failing with a raw error on a laptop.
  const setupWebhooks = async () => {
    setErr(''); setMsg(''); setBusy('hooks');
    try {
      const r = await api.registerAsanaWebhooks({ target_base: targetBase.trim() });
      setMsg(`Registered ${r.registered ?? 0} webhook(s) - Asana changes now stream in live.`);
      load();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Same dry-run-then-apply shape as dedupe. Clears sync rows stranded by
  // project deletes that predate the purge in delete_project.
  const purgeOrphans = async (apply) => {
    setErr(''); setMsg(''); setBusy('orphans');
    try {
      const res = await api.asanaSyncPurgeOrphans(apply);
      const total = (res.deadLinks || 0) + (res.orphanTasks || 0) + (res.danglingMaps || 0);
      if (!apply) {
        setOrphans({ ...res, total });
        setMsg(total
          ? [res.deadLinks && `${res.deadLinks} dead task link(s)`,
             res.orphanTasks && `${res.orphanTasks} orphaned task(s)`,
             res.danglingMaps && `${res.danglingMaps} dangling mapping(s)`]
              .filter(Boolean).join(', ') + '. Click again to clear.'
          : 'Nothing stranded.');
      } else {
        setOrphans(null);
        await store.refresh?.();
        setMsg(`Cleared ${res.deadLinks} dead link(s), ${res.orphanTasks} orphaned task(s) `
          + `and ${res.danglingMaps} dangling mapping(s). Those Asana projects can be imported fresh now.`);
      }
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  // Duplicate cleanup: dry run first (reports the count), then the same button
  // applies it. Merges tasks that all point at one Asana task - see
  // asana_sync.dedupe_tasks.
  async function loadWorkspaces() {
    setBusy('loadws');
    try {
      setWorkspaces(await api.asanaWorkspaces());
    } catch (e) {
      alert(e?.message || 'Could not list workspaces.');
    } finally { setBusy(''); }
  }

  async function checkAssignees() {
    setBusy('assignees');
    try {
      setAssignees(await api.asanaAssigneeCheck());
    } catch (e) {
      setAssignees({ reason: e?.message || 'Could not check assignee mapping.', assignees: [] });
    } finally { setBusy(''); }
  }

  const dedupe = async (apply) => {
    setErr(''); setMsg(''); setBusy('dedupe');
    try {
      const res = await api.asanaSyncDedupe(apply);
      const total = (res.merged || 0) + (res.sections || 0) + (res.people || 0);
      if (!apply) {
        setDupes({ ...res, total });
        setMsg(total
          ? [res.merged && `${res.merged} duplicate task(s) across ${res.gids} Asana task(s)`,
             res.sections && `${res.sections} duplicate section(s)`,
             res.people && `${res.people} unresolved Asana address(es)`]
              .filter(Boolean).join(', ') + '. Click again to fix.'
          : 'Nothing to clean up.');
      } else {
        setDupes(null);
        await store.refresh?.();
        setMsg(`Merged ${res.merged} duplicate task(s) and ${res.sections || 0} section(s), `
          + `resolved ${res.people || 0} Asana address(es) to Nexus people. `
          + 'Comments, files and subtasks moved onto the original.');
      }
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  if (!cfg) return null;
  const projects = store.projects || [];
  return (
    <div>
      {/* Setup - its own section, above the detailed sync config. Three
          independent, individually re-runnable steps, each showing whether it's
          already done, so a half-finished setup is obvious at a glance. */}
      <SectionHead title="Setup" hint="Get Asana connected in three steps. Each one is independent and safe to re-run." />
      <div style={{ ...card, padding: 16, maxWidth: 640, marginBottom: 22 }}>
        <Field label={`Setup token ${cfg.hasSetupToken ? '(set - leave blank to keep)' : '(optional - defaults to the service token below)'}`}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={setupToken} onChange={(e) => setSetupToken(e.target.value)}
              placeholder={cfg.hasSetupToken ? '•••••• set' : '1/… Asana PAT used only for setup'}
              style={{ ...inputStyle, flex: 1 }} autoComplete="off" />
            <button onClick={saveSetupToken} disabled={busy === 'setuptoken' || (!setupToken.trim() && !cfg.hasSetupToken)}
              style={{ ...btn('outline'), flexShrink: 0 }}>
              {setupToken.trim() ? 'Save' : 'Clear'}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
            Used only by Import and Register webhooks. Keeping it separate lets a bulk import run under
            an admin account without that account becoming the identity every ongoing sync push comes from.
          </div>
        </Field>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <button onClick={importAll} disabled={(!cfg.hasToken && !cfg.hasSetupToken) || !!busy || !!importJob}
            title={(cfg.hasToken || cfg.hasSetupToken) ? '' : 'Save a token first'} style={btn('outline')}>
            <FolderPlus size={14} />{importJob ? 'Importing…' : '1 · Import All Projects'}
          </button>
          <button onClick={toggleSync} disabled={!cfg.hasToken || !!busy}
            title={cfg.enabled ? 'Click to turn sync off' : 'Click to turn sync on'}
            style={cfg.enabled
              ? { ...btn('outline'), color: NX.green, borderColor: NX.green }
              : btn('outline')}>
            {cfg.enabled ? <CheckCircle2 size={14} /> : <Zap size={14} />}
            {busy === 'enable' ? 'Saving…' : (cfg.enabled ? '2 · Sync is on' : '2 · Sync is off')}
          </button>
          <button onClick={setupWebhooks} disabled={(!cfg.hasToken && !cfg.hasSetupToken) || !!busy || (!hookEnv.publicBase && !targetBase.trim())}
            title={!hookEnv.publicBase && !targetBase.trim()
              ? 'Needs a public API URL - run this from the deployed site'
              : ''} style={hooks.length ? { ...btn('outline'), color: NX.green, borderColor: NX.green } : btn('outline')}>
            {hooks.length ? <CheckCircle2 size={14} /> : <Zap size={14} />}
            {busy === 'hooks' ? 'Registering…' : (hooks.length ? `3 · ${hooks.length} webhook(s) live` : '3 · Register Webhooks')}
          </button>
        </div>
        {importJob && (
          // Progress comes from the server, so this survives a page reload and
          // shows the same state to anyone else watching.
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: NX.dim, marginBottom: 5 }}>
              <span>{importJob.cancelling
                ? `Stopping after ${importJob.current || 'this project'}…`
                : (importJob.current ? `Importing ${importJob.current}` : 'Listing projects in Asana')}</span>
              <span style={{ marginLeft: 'auto' }}>{importJob.total ? `${importJob.done} of ${importJob.total}` : ''}</span>
              <button onClick={cancelImport} disabled={importJob.cancelling}
                style={{ ...btn('outline'), height: 24, fontSize: 11.5, padding: '0 9px',
                         opacity: importJob.cancelling ? 0.5 : 1 }}>
                {importJob.cancelling ? 'Stopping…' : 'Cancel'}
              </button>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: NX.border, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 999, background: NX.primary,
                width: importJob.total ? `${Math.round((importJob.done / importJob.total) * 100)}%` : '15%',
                transition: 'width 0.4s ease',
              }} />
            </div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 6 }}>
              This runs on the server. You can leave this page; the import keeps going.
              Cancelling stops it after the current project and keeps everything already imported.
            </div>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 8, lineHeight: 1.55 }}>
          <b>Import</b> creates and maps a Nexus project for every Asana project the token can see -
          additive, so re-running tops them up and never deletes. <b>Sync</b> toggles the 2-minute pull
          and automatic pushes; turning it off stops both immediately, and manual Pull / Push all still
          work. <b>Webhooks</b> add live streaming and need a public API URL, so they only register from
          the deployed site.
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 13, color: NX.green }}>{msg}</div>}
        {err && <div style={{ marginTop: 10, fontSize: 13, color: NX.red }}>{err}</div>}
      </div>

      <SectionHead title="Two-way Sync" hint="Keep tasks in mapped Nexus projects in sync with Asana (title, description, due date, done). This toggle is separate from the Setup card's Sync toggle above - either one being on is enough to sync the projects mapped below." />
      <div style={{ ...card, padding: 16, maxWidth: 640 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.manualSyncEnabled} onChange={(e) => saveConfig({ manual_sync_enabled: e.target.checked })} />
          <span style={{ fontWeight: 700, color: NX.ink }}>Sync enabled</span>
          <span style={{ color: NX.faint }}>{cfg.manualSyncEnabled ? 'new tasks in mapped projects push to Asana automatically' : 'off'}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.manualDeleteSync} onChange={(e) => saveConfig({ manual_delete_sync: e.target.checked })} />
          <span style={{ fontWeight: 700, color: NX.ink }}>Sync deletions</span>
          <span style={{ color: NX.faint }}>
            {cfg.manualDeleteSync
              ? 'deleting a task on either side deletes it on the other'
              : 'off - a deleted task is only unlinked, never removed'}
          </span>
        </label>
        <Field label={`Service token ${cfg.hasToken ? '(set - leave blank to keep)' : '(required)'}`}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.hasToken ? '•••••• set' : '1/… Asana PAT with write access'} style={{ ...inputStyle, flex: 1 }} autoComplete="off" />
            <button onClick={() => saveConfig({ token })} disabled={!token.trim() || busy === 'config'} style={{ ...btn('outline'), flexShrink: 0 }}>Save token</button>
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Workspace GID (for assignee sync)">
            {/* A picker, because Asana shows no workspace id anywhere in its UI
                and the ids in its URLs (app.asana.com/0/<project>/<task>) are
                PROJECT ids - which is how a project gid ends up here. It reads
                as valid, nothing validates it, and the only symptom is that
                assignees quietly stop resolving while everything else syncs. */}
            {workspaces && workspaces.length > 0 ? (
              <select value={cfg.workspaceGid || ''}
                onChange={(e) => { setCfg((p) => ({ ...p, workspaceGid: e.target.value })); saveConfig({ workspace_gid: e.target.value }); }}
                style={selectStyle}>
                <option value="">Select workspace</option>
                {workspaces.map((w) => <option key={w.gid} value={w.gid}>{w.name} ({w.gid})</option>)}
                {/* Keep whatever is stored visible even when it is not a real
                    workspace - otherwise a wrong value silently reads as blank. */}
                {cfg.workspaceGid && !workspaces.some((w) => w.gid === cfg.workspaceGid) && (
                  <option value={cfg.workspaceGid}>{cfg.workspaceGid} - not a workspace this token can see</option>
                )}
              </select>
            ) : (
              <input value={cfg.workspaceGid || ''} onChange={(e) => setCfg((p) => ({ ...p, workspaceGid: e.target.value }))} onBlur={(e) => saveConfig({ workspace_gid: e.target.value })} placeholder="120…" style={inputStyle} />
            )}
            <button onClick={loadWorkspaces} disabled={!cfg.hasToken || !!busy}
              title={cfg.hasToken ? '' : 'Save a token first'}
              style={{ ...btn('ghost'), padding: '3px 8px', fontSize: 12, color: NX.blue, marginTop: 4 }}>
              {busy === 'loadws' ? 'Loading…' : (workspaces ? 'Reload workspaces' : 'Find my workspace')}
            </button>
          </Field>
          <Field label="Default project GID (unmapped tasks)">
            <input value={cfg.defaultProjectGid || ''} onChange={(e) => setCfg((p) => ({ ...p, defaultProjectGid: e.target.value }))} onBlur={(e) => saveConfig({ default_project_gid: e.target.value })} placeholder="Optional" style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <label style={{ ...fieldLabel, marginBottom: 0 }}>Project mapping (Nexus → Asana)</label>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button onClick={autoMapProjects} disabled={!cfg.hasToken || !!busy} title={cfg.hasToken ? 'Fill blank rows by matching project names' : 'Save a token first'} style={{ ...btn('ghost'), padding: '3px 8px', fontSize: 12, color: NX.blue }}>
              {busy === 'automap' ? 'Matching…' : 'Map Auto'}
            </button>
            <button onClick={loadAsanaProjects} disabled={!cfg.hasToken || !!busy} title={cfg.hasToken ? '' : 'Save a token first'} style={{ ...btn('ghost'), padding: '3px 8px', fontSize: 12, color: NX.blue }}>
              {busy === 'loadproj' ? 'Loading…' : (asanaProjects ? 'Reload Asana projects' : 'Load Asana projects')}
            </button>
          </div>
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 8, marginBottom: 10 }}>
          {projects.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: NX.faint }}>No Nexus projects yet.</div>}
          {projects.map((p) => (
            <div key={p.id} style={{ padding: '7px 10px', borderBottom: `1px solid ${NX.border2}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {asanaProjects ? (
                  <select value={map[p.id] || ''} onChange={(e) => setMap((m) => ({ ...m, [p.id]: e.target.value }))} style={{ ...inputStyle, appearance: 'auto', cursor: 'pointer', width: 230, padding: '5px 8px', fontSize: 12 }}>
                    <option value="">- not synced -</option>
                    {asanaProjects.map((ap) => <option key={ap.gid} value={ap.gid}>{ap.name}</option>)}
                  </select>
                ) : (
                  <input value={map[p.id] || ''} onChange={(e) => setMap((m) => ({ ...m, [p.id]: e.target.value }))} placeholder="Asana project GID" style={{ ...inputStyle, width: 200, padding: '5px 8px', fontSize: 12 }} />
                )}
              </div>
              {/* No "also grant these teams" box any more: GET /memberships
                  ?parent={'{'}project{'}'} reports every team shared into a project,
                  ad-hoc ones included, so Pull picks them up on its own. The
                  field existed only while that was believed impossible; values
                  already saved are still honored server-side. */}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button onClick={saveMap} disabled={busy === 'map'} style={btn('outline')}>{busy === 'map' ? 'Saving…' : 'Save mapping'}</button>
          <button onClick={clearMap} disabled={!!busy} style={{ ...btn('ghost'), color: NX.red }}>{busy === 'clearmap' ? 'Clearing…' : 'Clear Mapping'}</button>
          <button onClick={() => run('push')} disabled={!!busy} style={btn('outline')}><ArrowRightLeft size={14} />{busy === 'push' ? 'Pushing…' : 'Push all → Asana'}</button>
          <button onClick={() => run('pull')} disabled={!!busy} style={btn('primary')}><Download size={14} />{busy === 'pull' ? 'Pulling…' : 'Pull ← Asana'}</button>
          {cfg.lastPullAt && <span style={{ fontSize: 11.5, color: NX.faint }}>last pull {fmtDateTime(cfg.lastPullAt)}</span>}
        </div>

        {/* Assignee gets its own check because it is the one field that can fail
            alone: it is the only one that must be TRANSLATED (Nexus email ->
            Asana user gid) rather than copied, and every way that translation
            fails looks the same from outside - the task updates, the assignee
            does not, and nothing says why. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={checkAssignees} disabled={!!busy} style={btn('ghost')}>
            <Users size={14} />{busy === 'assignees' ? 'Checking…' : 'Check assignee mapping'}
          </button>
          {assignees && (
            <span style={{ fontSize: 11.5, color: assignees.reason ? NX.amber : NX.green }}>
              {assignees.reason
                || `all ${assignees.assignees.length} assignees resolve · ${assignees.usersWithEmail}/${assignees.usersInWorkspace} workspace users readable`}
            </span>
          )}
        </div>
        {assignees && assignees.assignees.some((a) => !a.resolved) && (
          <div style={{ marginTop: 8, fontSize: 12, color: NX.dim, lineHeight: 1.7 }}>
            {assignees.assignees.filter((a) => !a.resolved).map((a) => (
              <div key={a.email}>· <strong>{a.email}</strong> has no Asana account in this workspace</div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={() => dedupe(!!(dupes && dupes.total))} disabled={!!busy}
            style={dupes && dupes.total ? { ...btn('outline'), color: NX.red, borderColor: NX.red } : btn('ghost')}>
            {busy === 'dedupe' ? 'Checking…' : (dupes && dupes.total ? `Fix ${dupes.total} issue(s)` : 'Check sync data')}
          </button>
          <span style={{ fontSize: 11.5, color: NX.faint }}>
            Merges Nexus tasks pointing at the same Asana task (keeping the original), collapses duplicate sections, and resolves Asana guest addresses to real Nexus people.
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={() => purgeOrphans(!!(orphans && orphans.total))} disabled={!!busy}
            style={orphans && orphans.total ? { ...btn('outline'), color: NX.red, borderColor: NX.red } : btn('ghost')}>
            {busy === 'orphans' ? 'Checking…' : (orphans && orphans.total ? `Clear ${orphans.total} stranded row(s)` : 'Check for stranded sync rows')}
          </button>
          <span style={{ fontSize: 11.5, color: NX.faint }}>
            Finds links and mappings left behind by older project deletes. Each one silently blocks a fresh import of the Asana tasks behind it. Asana is never touched.
          </span>
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 13, color: NX.green }}>{msg}</div>}
        {err && <div style={{ marginTop: 10, fontSize: 13, color: NX.red }}>{err}</div>}
        {teamReport.length > 0 && (
          <div style={{ marginTop: 10, border: `1px solid ${NX.border}`, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: NX.dim, marginBottom: 4 }}>Team access</div>
            {teamReport.map((line, i) => (
              <div key={i} style={{ fontSize: 11.5, color: /granted|owning team, \d/.test(line) ? NX.green : NX.amber, marginTop: 2 }}>
                {line}
              </div>
            ))}
          </div>
        )}

        {/* Real-time inbound via Asana webhooks (needs a public API URL) */}
        <div style={{ borderTop: `1px solid ${NX.border2}`, marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: NX.dim, marginBottom: 8 }}>Real-time (webhooks)</div>
          <Field label={hookEnv.publicBase ? 'Public API base URL (override - blank uses this API)' : 'Public API base URL (Asana must reach it)'}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={targetBase} onChange={(e) => setTargetBase(e.target.value)} placeholder={hookEnv.publicBase || 'https://your-public-api-host'} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => webhooks('register')} disabled={(!hookEnv.publicBase && !targetBase.trim()) || !!busy} style={{ ...btn('outline'), flexShrink: 0 }}>{busy === 'register' ? 'Registering…' : 'Register'}</button>
              {hooks.length > 0 && <button onClick={() => webhooks('delete')} disabled={!!busy} style={{ ...btn('ghost'), flexShrink: 0, color: NX.red }}>{busy === 'delete' ? 'Removing…' : 'Remove'}</button>}
            </div>
          </Field>
          <div style={{ fontSize: 12, color: hooks.length ? NX.green : NX.faint }}>
            {hooks.length ? `✓ ${hooks.length} active webhook(s) - Asana changes stream in live.` : 'No webhooks - inbound relies on the auto-pull + manual Pull.'}
          </div>
          <div style={{ fontSize: 11, color: NX.faint, marginTop: 4 }}>
            {hookEnv.publicBase
              ? `Registers against ${hookEnv.publicBase} - leave the field blank unless you're pointing Asana somewhere else.`
              : 'This API has no public URL, so Asana can’t reach it. Register from the deployed dev/prod site, or paste a public tunnel URL.'}
          </div>
          {!hookEnv.isSyncWorker && (
            <div style={{ fontSize: 11, color: NX.amber, marginTop: 6 }}>
              Background sync is off in this backend - automatic push and the periodic pull only run on the deployed API, so one instance owns the shared Asana workspace. “Push all” and “Pull” below still work from here.
            </div>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 11.5, color: NX.faint }}>
          Syncs both ways: title · description · start &amp; due date · status · priority · done · assignee · followers · tags · section · milestone · subtasks · dependencies · comments · attachments, plus Asana’s activity history inbound.
          On the deployed API inbound is live via webhooks with a 5-min auto-pull fallback, and a 15-min push sweep re-sends anything an edit-time push missed. Locally nothing runs automatically - use “Pull” and “Push all”.
        </div>
      </div>
    </div>
  );
}

// ── 0. Teams - creation lives here (Manage-only); Teams page browses/edits ──
function TeamsTab({ store }) {
  const { teams, tasks, nameOf, deleteTeam, projects } = store;
  const [editing, setEditing] = useState(null); // {} for new, team object to edit, null closed
  // Dry-run-then-apply, the same shape the Asana cleanups use.
  const [fill, setFill] = useState(null);
  const [fillBusy, setFillBusy] = useState(false);
  const [fillMsg, setFillMsg] = useState('');

  const backfill = async (apply) => {
    setFillBusy(true); setFillMsg('');
    try {
      const r = await api.backfillTaskTeams(apply);
      if (!apply) {
        setFill(r);
        setFillMsg(r.filled
          ? `${r.filled} task(s) across ${r.projects} project(s) would get their project's team. Click again to apply.`
          : 'Nothing to fill in - every task already has a team, or its project has none (or more than one).');
      } else {
        setFill(null);
        await store.refresh?.();
        setFillMsg(`Filled in the team on ${r.filled} task(s).`);
      }
    } catch (e) { setFillMsg(e.message || String(e)); } finally { setFillBusy(false); }
  };

  const taskCountByTeam = useMemo(() => {
    const m = {};
    for (const t of tasks) if (t.teamId) m[t.teamId] = (m[t.teamId] || 0) + 1;
    return m;
  }, [tasks]);
  const projectName = (id) => projects.find((p) => p.id === id)?.name || 'Unassigned';

  return (
    <div>
      <SectionHead title="Teams" hint="Create and manage the teams members are grouped into. A team can serve several projects."
        action={<button style={btn('primary')} onClick={() => setEditing({})}><Plus size={15} />New Team</button>} />

      {/* Tasks created before a project had a team show "-" forever, because
          nothing ever set team_id. This fills those in from the project. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <button onClick={() => backfill(!!(fill && fill.filled))} disabled={fillBusy}
          style={fill && fill.filled ? { ...btn('outline'), color: NX.red, borderColor: NX.red } : btn('outline')}>
          {fillBusy ? 'Checking…' : (fill && fill.filled ? `Fill in ${fill.filled} task(s)` : 'Fill team from project')}
        </button>
        <span style={{ fontSize: 11.5, color: NX.faint, flex: 1, minWidth: 240 }}>
          Sets the Team on tasks that have none, in projects with exactly one team. Never overwrites a
          team already chosen, and skips projects with several - there'd be no right answer.
        </span>
      </div>
      {fillMsg && <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 12 }}>{fillMsg}</div>}

      {teams.length === 0 ? (
        <EmptyState icon={Users} title="No Teams Yet" hint="Create a team to group members and their work." />
      ) : (
        teams.map((d) => {
          const Icon = deptIcon(d.icon);
          const color = d.color || NX.blue;
          const members = d.memberIds || [];
          return (
            <RowCard key={d.id}>
              <span style={{ ...iconBadge, background: `${color}1a`, color }}><Icon size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>{d.name}</div>
                <div style={{ fontSize: 12, color: NX.faint, marginTop: 1 }}>
                  {(teamProjectIds(d).map(projectName).filter(Boolean).join(', ') || 'No project')} · {members.length} member{members.length === 1 ? '' : 's'} · {taskCountByTeam[d.id] || 0} task{(taskCountByTeam[d.id] || 0) === 1 ? '' : 's'}
                </div>
              </div>
              <IconButton icon={Pencil} title="Edit Team" onClick={() => setEditing(d)} />
            </RowCard>
          );
        })
      )}

      {editing && (
        <TeamModal
          team={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onDelete={editing.id ? () => { if (confirm(`Delete "${editing.name}"? This can't be undone.`)) { deleteTeam(editing.id); setEditing(null); } } : null}
        />
      )}
    </div>
  );
}

// ── 1. Automation rules ───────────────────────────────────────────────────────
const TRIGGER_TYPES = [
  { value: 'status_changed', label: 'When status changes to' },
  { value: 'priority_changed', label: 'When priority changes to' },
  { value: 'created', label: 'When a task is created' },
  { value: 'completed_early', label: 'When completed before its due date' },
];
const NO_TRIGGER_VALUE = ['created', 'completed_early'];
const ACTION_TYPES = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'add_tag', label: 'Add tag' },
  { value: 'set_milestone', label: 'Mark as milestone' },
];
const NO_ACTION_VALUE = ['set_milestone'];
const humanize = (s = '') => String(s).replace(/_/g, ' ');

function describeTrigger(trigger = {}) {
  const t = TRIGGER_TYPES.find((x) => x.value === trigger.type)?.label || trigger.type || 'Trigger';
  return trigger.value ? `${t} ${humanize(trigger.value)}` : t;
}
function describeAction(a = {}) {
  if (a.type === 'set_milestone') return 'mark as milestone';
  return `${humanize(a.type)} ${humanize(a.value)}`.trim();
}

function RulesTab({ store }) {
  const { rules, createRule, updateRule, deleteRule } = store;
  const [editing, setEditing] = useState(null); // rule object or 'new'

  return (
    <div>
      <SectionHead
        title="Automation Rules"
        hint="Trigger → action rules that run automatically across tasks."
        action={<button style={btn('primary')} onClick={() => setEditing('new')}><Plus size={15} />Add Rule</button>}
      />
      {rules.length === 0 ? (
        <EmptyState icon={Zap} title="No Rules Yet" hint="Add a rule to automate status, priority and tagging." />
      ) : rules.map((r) => (
        <RowCard key={r.id}>
          <span style={{ ...iconBadge, color: NX.amber }}><Zap size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name}</div>
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 1 }}>
              {describeTrigger(r.trigger)} → {(r.actions || []).map(describeAction).join(', ') || '-'}
            </div>
          </div>
          <Toggle on={!!r.enabled} onChange={() => updateRule(r.id, { enabled: !r.enabled })} />
          <IconButton icon={Pencil} title="Edit Rule" onClick={() => setEditing(r)} />
          <IconButton icon={Trash2} title="Delete Rule" danger onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) deleteRule(r.id); }} />
        </RowCard>
      ))}
      {editing && (
        <RuleModal
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            if (editing === 'new') await createRule(data);
            else await updateRule(editing.id, data);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button type="button" onClick={onChange} title={on ? 'Enabled' : 'Disabled'} style={{
      position: 'relative', width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0,
    }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

function RuleModal({ rule, onClose, onSave }) {
  const { statusOrder, statusMeta } = useTasks();
  const [name, setName] = useState(rule?.name || '');
  const [enabled, setEnabled] = useState(rule ? !!rule.enabled : true);
  const [trigger, setTrigger] = useState(rule?.trigger?.type || 'status_changed');
  const [triggerValue, setTriggerValue] = useState(rule?.trigger?.value || 'not_started');
  const [actions, setActions] = useState(
    rule?.actions?.length ? rule.actions.map((a) => ({ type: a.type, value: a.value ?? '' })) : [{ type: 'set_priority', value: 'urgent' }],
  );

  const setAction = (i, patch) => setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const addAction = () => setActions((prev) => [...prev, { type: 'set_priority', value: 'urgent' }]);
  const removeAction = (i) => setActions((prev) => prev.filter((_, idx) => idx !== i));

  const save = () => {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      enabled,
      trigger: { type: trigger, value: NO_TRIGGER_VALUE.includes(trigger) ? undefined : triggerValue },
      actions: actions.map((a) => ({ type: a.type, value: NO_ACTION_VALUE.includes(a.type) ? '' : a.value })),
    });
  };

  return (
    <Modal title={rule ? 'Edit Rule' : 'New Rule'} onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>{rule ? 'Save rule' : 'Add rule'}</button>
      </>
    }>
      <Field label="Rule name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Escalate urgent bugs" style={inputStyle} />
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Toggle on={enabled} onChange={() => setEnabled((v) => !v)} />
        <span style={{ fontSize: 13, color: NX.dim }}>{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: NO_TRIGGER_VALUE.includes(trigger) ? '1fr' : '1fr 1fr', gap: 12 }}>
        <Field label="Trigger">
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} style={selectStyle}>
            {TRIGGER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        {!NO_TRIGGER_VALUE.includes(trigger) && (
          <Field label="Value">
            <select value={triggerValue} onChange={(e) => setTriggerValue(e.target.value)} style={selectStyle}>
              {(trigger === 'status_changed' ? statusOrder : PRIORITY_KEYS).map((k) => (
                <option key={k} value={k}>{trigger === 'status_changed' ? (statusMeta[k]?.label || k) : PRIORITY_META[k].label}</option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <label style={fieldLabel}>Actions</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {actions.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={a.type} onChange={(e) => setAction(i, { type: e.target.value, value: e.target.value === 'set_status' ? 'in_progress' : e.target.value === 'set_priority' ? 'urgent' : '' })} style={{ ...selectStyle, flex: 1 }}>
              {ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {!NO_ACTION_VALUE.includes(a.type) && (
              a.type === 'set_priority' ? (
                <select value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} style={{ ...selectStyle, flex: 1 }}>
                  {PRIORITY_KEYS.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
                </select>
              ) : a.type === 'set_status' ? (
                <select value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} style={{ ...selectStyle, flex: 1 }}>
                  {statusOrder.map((s) => <option key={s} value={s}>{statusMeta[s]?.label || s}</option>)}
                </select>
              ) : (
                <input value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} placeholder="Tag" style={{ ...inputStyle, flex: 1 }} />
              )
            )}
            <IconButton icon={X} title="Remove Action" onClick={() => removeAction(i)} />
          </div>
        ))}
      </div>
      <button style={{ ...btn('outline'), marginTop: 8 }} onClick={addAction}><Plus size={14} />Add Action</button>
    </Modal>
  );
}

// ── 2. Custom fields ──────────────────────────────────────────────────────────
const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'multiselect', label: 'Multi-Select' },
  { value: 'people', label: 'People' },
  { value: 'checkbox', label: 'Checkbox' },
];
// The two kinds whose value is chosen from a fixed option list.
const OPTION_TYPES = ['select', 'multiselect'];

function FieldsTab({ store }) {
  const { customFields, createCustomField, updateCustomField, deleteCustomField, projects = [] } = store;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const projectName = (id) => projects.find((p) => p.id === id)?.name || '';

  return (
    <div>
      <SectionHead
        title="Custom Fields"
        hint="Extra fields on tasks (text, number, date, checkbox or a select list). Scope a field to specific projects so it is not a column in every one."
        action={<button style={btn('primary')} onClick={() => setAdding(true)}><Plus size={15} />New Custom Field</button>}
      />
      {customFields.length === 0 ? (
        <EmptyState icon={ListChecks} title="No Custom Fields" hint="Add a field to capture extra data on tasks." />
      ) : customFields.map((f) => (
        <RowCard key={f.id}>
          <span style={{ ...iconBadge, color: NX.blue }}><ListChecks size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{f.name}</div>
            {f.description && <div style={{ fontSize: 12, color: NX.dim, marginTop: 1 }}>{f.description}</div>}
            {OPTION_TYPES.includes(f.type) && !!(f.options || []).length && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                {(f.options || []).map((o) => {
                  const opt = typeof o === 'string' ? { id: o, label: o, color: NX.dim } : o;
                  return <span key={opt.id} style={chip(opt.color || NX.dim, `${opt.color || NX.dim}1a`)}>{opt.label}</span>;
                })}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 3 }}>
              {(f.projectIds || []).length
                ? (f.projectIds || []).map(projectName).filter(Boolean).join(', ')
                : 'Every project'}
            </div>
          </div>
          {f.required && <span style={chip(NX.red, 'rgba(220,38,38,0.12)')}>Required</span>}
          {f.readOnly && <span title="Calculated in Asana - imported but never pushed back" style={chip(NX.dim, NX.border2)}>Read-only</span>}
          <span style={chip(NX.dim, NX.border2)}>{FIELD_TYPES.find((t) => t.value === f.type)?.label || f.type}</span>
          <IconButton icon={Pencil} title="Edit Field" onClick={() => setEditing(f)} />
          <IconButton icon={Trash2} title="Delete Field" danger onClick={() => { if (confirm(`Delete field "${f.name}"?`)) deleteCustomField(f.id); }} />
        </RowCard>
      ))}
      {adding && <FieldModal projects={projects} onClose={() => setAdding(false)} onSave={async (d) => { await createCustomField(d); setAdding(false); }} />}
      {editing && <FieldModal projects={projects} field={editing} onClose={() => setEditing(null)}
        onSave={async (d) => { await updateCustomField(editing.id, d); setEditing(null); }} />}
    </div>
  );
}

const FIELD_OPTION_COLORS = ['#2563eb', '#0d9488', '#16a34a', '#7c3aed', '#d97706',
  '#dc2626', '#db2777', '#0891b2', '#4f46e5', '#475569'];

// `field` set = editing that field; absent = creating a new one. The TYPE is
// not editable on an existing field: values already stored are in that type's
// shape, and switching, say, select to number would leave every captured value
// unreadable. Renaming and rescoping - the reasons anyone opens this - are safe
// because a task's values are keyed by field id, not by name.
function FieldModal({ projects = [], field = null, onClose, onSave }) {
  const [name, setName] = useState(field?.name || '');
  const [description, setDescription] = useState(field?.description || '');
  const [type, setType] = useState(field?.type || 'text');
  const [options, setOptions] = useState(() => {
    const existing = (field?.options || []).map((o) => (typeof o === 'string'
      ? { label: o, color: FIELD_OPTION_COLORS[0] }
      : { label: o.label || o.id || '', color: o.color || FIELD_OPTION_COLORS[0] }));
    return existing.length ? existing : [{ label: '', color: FIELD_OPTION_COLORS[0] }];
  });
  // Empty = the field applies to every project, which is how every field
  // behaved before scoping existed.
  const [projectIds, setProjectIds] = useState(field?.projectIds || []);
  const [required, setRequired] = useState(!!field?.required);

  const setOpt = (i, patch) => setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const toggleProject = (id) => setProjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const save = () => {
    if (!name.trim()) return;
    const opts = OPTION_TYPES.includes(type)
      ? options.filter((o) => o.label.trim()).map((o) => ({ id: o.label.trim(), label: o.label.trim(), color: o.color }))
      : [];
    onSave({ name: name.trim(), description: description.trim(), type, options: opts,
             project_ids: projectIds, required });
  };

  return (
    <Modal title={field ? 'Edit Custom Field' : 'New Custom Field'} onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>{field ? 'Save Field' : 'Add Field'}</button>
      </>
    }>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Story points" style={inputStyle} /></Field>
      <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" style={inputStyle} /></Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)} disabled={!!field}
          style={{ ...selectStyle, opacity: field ? 0.6 : 1, cursor: field ? 'not-allowed' : 'pointer' }}>
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {field && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>Type cannot change once tasks hold values in it.</div>}
      </Field>
      {OPTION_TYPES.includes(type) && (
        <div>
          <label style={fieldLabel}>Options</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map((o, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input value={o.label} onChange={(e) => setOpt(i, { label: e.target.value })} placeholder={`Option ${i + 1}`} style={{ ...inputStyle, flex: 1 }} />
                {/* Colors are what make a select readable at a glance in the list
                    view - the same reason Asana colors its option chips. */}
                <div style={{ display: 'flex', gap: 3 }}>
                  {FIELD_OPTION_COLORS.slice(0, 6).map((c) => (
                    <button key={c} type="button" title={c} onClick={() => setOpt(i, { color: c })}
                      style={{ width: 18, height: 18, borderRadius: 5, background: c, cursor: 'pointer',
                               border: o.color === c ? `2px solid ${NX.ink}` : '2px solid transparent' }} />
                  ))}
                </div>
                <IconButton icon={X} title="Remove Option" onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))} />
              </div>
            ))}
          </div>
          <button style={{ ...btn('outline'), marginTop: 8 }}
            onClick={() => setOptions((prev) => [...prev, { label: '', color: FIELD_OPTION_COLORS[prev.length % FIELD_OPTION_COLORS.length] }])}>
            <Plus size={14} />Add Option
          </button>
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <label style={fieldLabel}>Projects</label>
        <div style={{ fontSize: 11.5, color: NX.faint, marginBottom: 6 }}>
          Pick none to use this field in every project.
        </div>
        {projects.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No projects yet.</div>
        ) : (
          <div style={{ maxHeight: 150, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10 }}>
            {projects.filter((p) => !p.archived).map((p) => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 13, cursor: 'pointer', borderBottom: `1px solid ${NX.border2}` }}>
                <input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggleProject(p.id)} style={{ cursor: 'pointer' }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} style={{ width: 16, height: 16 }} />
        Required when creating a task
      </label>
    </Modal>
  );
}

// ── 3. Custom statuses ────────────────────────────────────────────────────────
function StatusesTab({ store }) {
  const { customStatuses, createCustomStatus, updateCustomStatus, deleteCustomStatus, dedupeCustomStatuses, projects = [] } = store;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [merging, setMerging] = useState(false);
  const [mergeNote, setMergeNote] = useState('');
  const projectName = (id) => projects.find((p) => p.id === id)?.name || '';

  // Same label on more than one row is the symptom the merge fixes. Computed so
  // the button only appears when there is something to do - an always-visible
  // maintenance action invites a click that rewrites task statuses for nothing.
  const dupeCount = (() => {
    const seen = new Map();
    for (const s of customStatuses) {
      const k = (s.label || '').trim().toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return [...seen.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
  })();

  const merge = async () => {
    setMerging(true); setMergeNote('');
    try {
      const r = await dedupeCustomStatuses();
      setMergeNote(r.merged
        ? `Merged ${r.merged} duplicate status${r.merged === 1 ? '' : 'es'}`
          + (r.tasksRemapped ? `, moved ${r.tasksRemapped} task${r.tasksRemapped === 1 ? '' : 's'} onto the kept status.` : '.')
        : 'Nothing to merge.');
    } catch (e) {
      setMergeNote(e.message || 'Could not merge statuses.');
    } finally { setMerging(false); }
  };

  return (
    <div>
      <SectionHead
        title="Custom Statuses"
        hint="Additional workflow statuses beyond the four built-in ones. Scope a status to specific projects so it is not a board column in every one."
        action={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {dupeCount > 0 && (
              <button style={btn('outline')} onClick={merge} disabled={merging}
                title="Asana's Task Progress is usually a per-project field, so the same stage arrives once per project. This collapses them onto one status scoped to every project that used it.">
                {merging ? 'Merging…' : `Merge ${dupeCount} duplicate${dupeCount === 1 ? '' : 's'}`}
              </button>
            )}
            <button style={btn('primary')} onClick={() => setAdding(true)}><Plus size={15} />New Status</button>
          </div>
        )}
      />
      {mergeNote && (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: NX.dim }}>{mergeNote}</div>
      )}
      {customStatuses.length === 0 ? (
        <EmptyState icon={Palette} title="No Custom Statuses" hint="Add a status to model your own workflow stages." />
      ) : customStatuses.map((s) => (
        <RowCard key={s.id}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: s.color || NX.dim, flexShrink: 0, marginLeft: 6 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.label}</div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 3 }}>
              {(s.projectIds || []).length
                ? (s.projectIds || []).map(projectName).filter(Boolean).join(', ')
                : 'Every project'}
            </div>
          </div>
          <IconButton icon={Pencil} title="Edit Status" onClick={() => setEditing(s)} />
          <IconButton icon={Trash2} title="Delete Status" danger onClick={() => { if (confirm(`Delete status "${s.label}"?`)) deleteCustomStatus(s.id); }} />
        </RowCard>
      ))}
      {adding && <StatusModal projects={projects} onClose={() => setAdding(false)} onSave={async (d) => { await createCustomStatus(d); setAdding(false); }} />}
      {editing && <StatusModal projects={projects} status={editing} onClose={() => setEditing(null)}
        onSave={async (d) => { await updateCustomStatus(editing.id, d); setEditing(null); }} />}
    </div>
  );
}

function StatusModal({ projects = [], status = null, onClose, onSave }) {
  const [label, setLabel] = useState(status?.label || '');
  const [color, setColor] = useState(status?.color || SWATCHES[0]);
  const [projectIds, setProjectIds] = useState(status?.projectIds || []);
  const toggleProject = (id) => setProjectIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const save = () => { if (label.trim()) onSave({ label: label.trim(), color, project_ids: projectIds }); };

  return (
    <Modal title={status ? 'Edit Status' : 'New Status'} width={440} onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>{status ? 'Save Status' : 'Add Status'}</button>
      </>
    }>
      <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blocked" style={inputStyle} /></Field>
      <label style={fieldLabel}>Color</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {SWATCHES.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} title={c} style={{
            width: 30, height: 30, borderRadius: '50%', background: c, cursor: 'pointer',
            border: color === c ? `3px solid ${NX.ink}` : `2px solid ${NX.border}`,
          }} />
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <label style={fieldLabel}>Projects</label>
        <div style={{ fontSize: 12, color: NX.dim, marginBottom: 6 }}>
          Leave all unchecked to show this status on every board.
        </div>
        {projects.length === 0 ? (
          <div style={{ fontSize: 12.5, color: NX.faint }}>No projects yet.</div>
        ) : (
          <div style={{ maxHeight: 150, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10 }}>
            {projects.filter((p) => !p.archived).map((p) => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 13, cursor: 'pointer', borderBottom: `1px solid ${NX.border2}` }}>
                <input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggleProject(p.id)} style={{ cursor: 'pointer' }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── 4. Templates ──────────────────────────────────────────────────────────────
function TemplatesTab({ store }) {
  const { templates, createTemplate, deleteTemplate } = store;
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <SectionHead
        title="Templates"
        hint="Reusable task blueprints - default fields plus a pre-built subtask list."
        action={<button style={btn('primary')} onClick={() => setAdding(true)}><Plus size={15} />New Template</button>}
      />
      {templates.length === 0 ? (
        <EmptyState icon={FileText} title="No Templates" hint="Create a template to spin up recurring work fast." />
      ) : templates.map((t) => (
        <RowCard key={t.id}>
          <span style={{ ...iconBadge, color: NX.purple }}><FileText size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</div>
            {t.description && <div style={{ fontSize: 12, color: NX.dim, marginTop: 1 }}>{t.description}</div>}
          </div>
          <span style={chip(NX.dim, NX.border2)}>{(t.subtaskTitles || []).length} subtasks</span>
          <IconButton icon={Trash2} title="Delete Template" danger onClick={() => { if (confirm(`Delete template "${t.name}"?`)) deleteTemplate(t.id); }} />
        </RowCard>
      ))}
      {adding && <TemplateModal onClose={() => setAdding(false)} onSave={async (d) => { await createTemplate(d); setAdding(false); }} />}
    </div>
  );
}

function TemplateModal({ onClose, onSave }) {
  const { statusOrder, statusMeta } = useTasks();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('');
  const [status, setStatus] = useState('');
  const [subtasks, setSubtasks] = useState(['']);

  const setSub = (i, v) => setSubtasks((prev) => prev.map((s, idx) => (idx === i ? v : s)));
  const save = () => {
    if (!name.trim()) return;
    const patch = {};
    if (priority) patch.priority = priority;
    if (status) patch.status = status;
    onSave({
      name: name.trim(),
      description: description.trim(),
      patch,
      subtaskTitles: subtasks.map((s) => s.trim()).filter(Boolean),
    });
  };

  return (
    <Modal title="New Template" onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>Add Template</button>
      </>
    }>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New hire onboarding" style={inputStyle} /></Field>
      <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" style={inputStyle} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Default priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={selectStyle}>
            <option value="">No default</option>
            {PRIORITY_KEYS.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </Field>
        <Field label="Default status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
            <option value="">No default</option>
            {statusOrder.map((s) => <option key={s} value={s}>{statusMeta[s]?.label || s}</option>)}
          </select>
        </Field>
      </div>
      <label style={fieldLabel}>Subtasks</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {subtasks.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={s} onChange={(e) => setSub(i, e.target.value)} placeholder={`Subtask ${i + 1}`} style={{ ...inputStyle, flex: 1 }} />
            <IconButton icon={X} title="Remove Subtask" onClick={() => setSubtasks((prev) => prev.filter((_, idx) => idx !== i))} />
          </div>
        ))}
      </div>
      <button style={{ ...btn('outline'), marginTop: 8 }} onClick={() => setSubtasks((prev) => [...prev, ''])}><Plus size={14} />Add Subtask</button>
    </Modal>
  );
}

// ── 5. Intake forms ───────────────────────────────────────────────────────────
const INTAKE_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select'];

function IntakeTab({ store }) {
  const { intakeForms, projects, projectName, createIntakeForm, deleteIntakeForm } = store;
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <SectionHead
        title="Intake Forms"
        hint="Public request forms that funnel new work into a target project."
        action={<button style={btn('primary')} onClick={() => setAdding(true)}><Plus size={15} />New Form</button>}
      />
      {intakeForms.length === 0 ? (
        <EmptyState icon={Inbox} title="No Intake Forms" hint="Create a form to collect structured requests." />
      ) : intakeForms.map((f) => (
        <RowCard key={f.id}>
          <span style={{ ...iconBadge, color: NX.teal }}><Inbox size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>{f.title}</div>
            <div style={{ fontSize: 12, color: NX.dim, marginTop: 1 }}>
              {(f.fields || []).length} fields
              {f.targetProjectId ? ` → ${projectName(f.targetProjectId) || 'project'}` : ' · no target project'}
            </div>
          </div>
          <IconButton icon={Trash2} title="Delete Form" danger onClick={() => { if (confirm(`Delete form "${f.title}"?`)) deleteIntakeForm(f.id); }} />
        </RowCard>
      ))}
      {adding && <IntakeModal projects={projects} onClose={() => setAdding(false)} onSave={async (d) => { await createIntakeForm(d); setAdding(false); }} />}
    </div>
  );
}

function IntakeModal({ projects, onClose, onSave }) {
  const [title, setTitle] = useState('');
  const [targetProjectId, setTargetProjectId] = useState('');
  const [fields, setFields] = useState([{ label: '', type: 'text' }]);

  const setField = (i, patch) => setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const save = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      targetProjectId,
      fields: fields.map((f) => ({ label: f.label.trim(), type: f.type })).filter((f) => f.label),
    });
  };

  return (
    <Modal title="New Intake Form" onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>Add Form</button>
      </>
    }>
      <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. IT support request" style={inputStyle} /></Field>
      <Field label="Target project">
        <select value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)} style={selectStyle}>
          <option value="">No target project</option>
          {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <label style={fieldLabel}>Fields</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fields.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder={`Field ${i + 1}`} style={{ ...inputStyle, flex: 1 }} />
            <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })} style={{ ...selectStyle, width: 130 }}>
              {INTAKE_FIELD_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
            <IconButton icon={X} title="Remove Field" onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))} />
          </div>
        ))}
      </div>
      <button style={{ ...btn('outline'), marginTop: 8 }} onClick={() => setFields((prev) => [...prev, { label: '', type: 'text' }])}><Plus size={14} />Add Field</button>
    </Modal>
  );
}

// ── 6. Activity log ───────────────────────────────────────────────────────────
const ACTIVITY_ICON = {
  created: Plus, updated: Pencil, completed: CheckCircle2, deleted: Trash2,
  status_changed: ArrowRightLeft, priority_changed: Flag, assignee_changed: User,
  due: Calendar, commented: MessageSquare, automation: Zap,
};

function ActivityTab({ store }) {
  const { nameOf } = store;
  const [rows, setRows] = useState(null); // null = loading
  useEffect(() => {
    let alive = true;
    api.getGlobalTaskActivity()
      .then((r) => { if (alive) setRows(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  const sorted = useMemo(() => [...(rows || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))), [rows]);

  return (
    <div>
      <SectionHead title="Activity Log" hint="A running history of everything that happened across tasks and projects." />
      {rows === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: NX.faint, fontSize: 13 }}>Loading activity…</div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="No Activity Yet" hint="Actions across the workspace will show up here." />
      ) : (
        <div style={{ ...card, padding: 6 }}>
          {sorted.map((e) => {
            const Icon = e.entityKind === 'project' ? FileText : (ACTIVITY_ICON[e.type] || Circle);
            const actor = e.actorId ? nameOf(e.actorId) : 'Someone';
            const when = fmtDateTime(e.at);
            return (
              <div key={e.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '9px 10px', borderRadius: 8 }}>
                {e.actorId
                  ? <Avatar email={e.actorId} name={actor} size={28} />
                  : <span style={{ ...iconBadge, width: 28, height: 28, color: NX.dim }}><Icon size={14} /></span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: NX.ink }}>
                    {/* entityCode is still recorded on the row, just not shown -
                        task numbers are hidden everywhere in this module now.
                        The line below carries entityTitle, which identifies the
                        task to a human better than a code did anyway. */}
                    <span style={{ fontWeight: 700 }}>{actor}</span> {e.detail || humanize(e.type)}
                  </div>
                  {e.entityTitle && <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.entityTitle}</div>}
                </div>
                <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap' }}>{when}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 7. Reporting ──────────────────────────────────────────────────────────────
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCSV(filename, headers, rows) {
  const lines = [headers, ...rows].map((r) => r.map(csvEscape).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BarRows({ data }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.some((d) => d.value > 0)) return <div style={{ fontSize: 13, color: NX.faint, padding: '6px 0' }}>No matching tasks.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {data.filter((d) => d.value > 0).map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 120, fontSize: 12.5, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{d.label}</span>
          <span style={{ flex: 1, height: 10, borderRadius: 999, background: NX.border2, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${(d.value / max) * 100}%`, background: d.color || NX.blue, borderRadius: 999 }} />
          </span>
          <span style={{ width: 34, textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: NX.ink, flexShrink: 0 }}>{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function ReportCard({ title, children }) {
  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function ReportingTab({ store }) {
  const { tasks, projects, nameOf, projectName } = store;
  const list = useMemo(() => topLevel(tasks), [tasks]);
  const stats = useMemo(() => taskStats(list), [list]);

  const byStatus = store.statusOrder.map((s) => ({ label: store.statusMeta[s]?.label || s, value: list.filter((t) => t.status === s).length, color: store.statusMeta[s]?.color })).filter((d) => d.value > 0);
  const byPriority = PRIORITY_KEYS.map((p) => ({ label: PRIORITY_META[p].label, value: list.filter((t) => t.priority === p).length, color: PRIORITY_META[p].color }));
  const byProject = (projects || []).map((p) => ({ label: p.name, value: list.filter((t) => t.projectId === p.id).length, color: colorForKey(p.id) }));

  const exportCsv = () => {
    const headers = ['Title', 'Status', 'Priority', 'Assignee', 'Project', 'Due'];
    const rows = list.map((t) => [
      t.title || '',
      store.statusMeta[t.status]?.label || t.status || '',
      PRIORITY_META[t.priority]?.label || t.priority || '',
      t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned',
      t.projectId ? (projectName(t.projectId) || '-') : '-',
      t.dueOn || '',
    ]);
    downloadCSV(`task-report-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  };

  const kpis = [
    { label: 'Completion Rate', value: `${stats.pct}%`, color: NX.green },
    { label: 'In Progress', value: stats.inProgress, color: NX.blue },
    { label: 'Overdue', value: stats.overdue, color: NX.red },
    { label: 'Total Tasks', value: stats.total, color: NX.primary },
  ];

  return (
    <div>
      <SectionHead
        title="Reporting"
        hint="Workspace-wide rollups across projects, teams and status."
        action={<button style={btn('primary')} onClick={exportCsv}><Download size={15} />Export CSV</button>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, padding: 16 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: NX.dim }}>{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8, color: k.color, lineHeight: 1 }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
        <ReportCard title="Tasks by Status"><BarRows data={byStatus} /></ReportCard>
        <ReportCard title="Tasks by Priority"><BarRows data={byPriority} /></ReportCard>
        <ReportCard title="Tasks by Project"><BarRows data={byProject} /></ReportCard>
      </div>
    </div>
  );
}
