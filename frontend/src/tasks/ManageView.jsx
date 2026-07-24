// Task Module — Manage: admin surface for the whole workspace. Internal sub-tab
// strip (Automation rules · Custom fields · Custom statuses · Templates · Intake
// forms · Activity log · Reporting), ported from the export's manage/ + reporting/
// screens onto the Nexus inline-style idiom + FastAPI-backed store.
import { useEffect, useMemo, useState } from 'react';
import {
  Zap, Plus, Trash2, Pencil, ListChecks, FileText, Inbox, Activity as ActivityIcon,
  BarChart3, Download, X, CheckCircle2, Flag, ArrowRightLeft, User, Calendar, MessageSquare,
  Circle, Palette, Users, List, Mail,
} from 'lucide-react';
import { useTasks } from './TasksContext';
import { api } from '../api';
import {
  NX, FONT, card, chip, btn, input as inputStyle,
  STATUS_META, STATUS_ORDER, PRIORITY_META, PRIORITY_ORDER, colorForKey,
} from './theme';
import { Avatar, EmptyState, Modal } from './components';
import { taskStats, topLevel, fmtDateTime } from './lib';
import TasksWorkspace from './TasksWorkspace';
import { TeamModal, deptIcon } from './TeamsView';
import TicketNotifySettings from '../tickets/TicketNotifySettings';
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
  { key: 'ticketNotify', label: 'Ticket Notifications', icon: Mail },
  { key: 'taskNotify', label: 'Task Notifications', icon: Mail },
  { key: 'activity', label: 'Activity Log', icon: ActivityIcon },
  { key: 'reporting', label: 'Reporting', icon: BarChart3 },
];

export default function ManageView() {
  const store = useTasks();
  const [tab, setTab] = useState('rules');

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Sub-tab strip — underline tabs, horizontally scrollable on mobile */}
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface, overflowX: 'auto' }}>
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

      {/* Body — the Task List is full-bleed (wide, self-scrolling table); the rest
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
            {tab === 'ticketNotify' && <TicketNotifySettings />}
            {tab === 'taskNotify' && <TaskNotifySettings />}
            {tab === 'activity' && <ActivityTab store={store} />}
            {tab === 'reporting' && <ReportingTab store={store} />}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Import from Asana — paste a token + project GIDs, runs server-side ─────────
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
    // selected from the picker + any manually typed GIDs
    const typed = gids.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const list = [...new Set([...picked, ...typed])];
    if (!token.trim() || list.length === 0) { setError('Pick at least one project (or type a GID).'); return; }
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
      <SectionHead title="Import from Asana" hint="Bring projects, tasks, subtasks, comments and attachments in from an Asana workspace." />
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

        {/* Project picker — populated by "Load projects" */}
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

        <Field label={projects && projects.length ? 'Or add project GID(s) manually' : 'Project GID(s)'}>
          <input value={gids} onChange={(e) => setGids(e.target.value)} placeholder="e.g. 1201234567890  1209876543210  (space or comma separated)" style={inputStyle} />
          <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>Tip: use <b>Load projects</b> above to avoid GID mistakes. A project URL is app.asana.com/0/<b>&lt;GID&gt;</b>/list — the middle number (not a task or “My Tasks” id).</div>
        </Field>
        {error && <div style={{ color: NX.red, fontSize: 13, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button onClick={run} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>
            <Download size={15} />{busy ? 'Importing…' : 'Import'}
          </button>
          {busy && <span style={{ fontSize: 12.5, color: NX.dim }}>Reading Asana and creating tasks — this can take a minute for large projects.</span>}
        </div>
        {result && (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: NX.hover, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: NX.green, marginBottom: 6 }}>✓ Import complete</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, color: NX.dim }}>
              <span><b style={{ color: NX.ink }}>{result.projects}</b> projects</span>
              <span><b style={{ color: NX.ink }}>{result.tasks}</b> tasks</span>
              <span><b style={{ color: NX.ink }}>{result.subtasks}</b> subtasks</span>
              <span><b style={{ color: NX.ink }}>{result.comments}</b> comments</span>
              <span><b style={{ color: NX.ink }}>{result.attachments}</b> attachments</span>
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
  const [extraTeams, setExtraTeams] = useState({});   // nexusProjectId -> "Team A, Team B"
  const [hooks, setHooks] = useState([]);
  const [hookEnv, setHookEnv] = useState({ publicBase: '', isSyncWorker: false });
  const [asanaProjects, setAsanaProjects] = useState(null);   // null = not loaded
  const [targetBase, setTargetBase] = useState('');   // override only; blank = use the API's own host
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

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
  const run = async (which) => {
    setErr(''); setMsg(''); setBusy(which);
    try {
      const res = which === 'pull' ? await api.asanaSyncPull() : await api.asanaSyncPushAll();
      await store.refresh?.();
      setMsg(which === 'pull' ? `Pulled from Asana: +${res.created} created, ${res.updated} updated, +${res.comments || 0} comments.` : `Pushed ${res.pushed} task(s) to Asana.`);
      load();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(''); }
  };

  if (!cfg) return null;
  const projects = store.projects || [];
  return (
    <div>
      <SectionHead title="Two-way Sync" hint="Keep tasks in mapped Nexus projects in sync with Asana (title, description, due date, done)." />
      <div style={{ ...card, padding: 16, maxWidth: 640 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => saveConfig({ enabled: e.target.checked })} />
          <span style={{ fontWeight: 700, color: NX.ink }}>Sync enabled</span>
          <span style={{ color: NX.faint }}>{cfg.enabled ? 'new tasks in mapped projects push to Asana automatically' : 'off'}</span>
        </label>
        <Field label={`Service token ${cfg.hasToken ? '(set — leave blank to keep)' : '(required)'}`}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.hasToken ? '•••••• set' : '1/… Asana PAT with write access'} style={{ ...inputStyle, flex: 1 }} autoComplete="off" />
            <button onClick={() => saveConfig({ token })} disabled={!token.trim() || busy === 'config'} style={{ ...btn('outline'), flexShrink: 0 }}>Save token</button>
          </div>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Workspace GID (for assignee sync)">
            <input value={cfg.workspaceGid || ''} onChange={(e) => setCfg((p) => ({ ...p, workspaceGid: e.target.value }))} onBlur={(e) => saveConfig({ workspace_gid: e.target.value })} placeholder="120…" style={inputStyle} />
          </Field>
          <Field label="Default project GID (unmapped tasks)">
            <input value={cfg.defaultProjectGid || ''} onChange={(e) => setCfg((p) => ({ ...p, defaultProjectGid: e.target.value }))} onBlur={(e) => saveConfig({ default_project_gid: e.target.value })} placeholder="Optional" style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <label style={{ ...fieldLabel, marginBottom: 0 }}>Project mapping (Nexus → Asana)</label>
          <button onClick={loadAsanaProjects} disabled={!cfg.hasToken || busy === 'loadproj'} title={cfg.hasToken ? '' : 'Save a token first'} style={{ ...btn('ghost'), padding: '3px 8px', fontSize: 12, marginLeft: 'auto', color: NX.blue }}>
            {busy === 'loadproj' ? 'Loading…' : (asanaProjects ? 'Reload Asana projects' : 'Load Asana projects')}
          </button>
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 8, marginBottom: 10 }}>
          {projects.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: NX.faint }}>No Nexus projects yet.</div>}
          {projects.map((p) => (
            <div key={p.id} style={{ padding: '7px 10px', borderBottom: `1px solid ${NX.border2}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {asanaProjects ? (
                  <select value={map[p.id] || ''} onChange={(e) => setMap((m) => ({ ...m, [p.id]: e.target.value }))} style={{ ...inputStyle, appearance: 'auto', cursor: 'pointer', width: 230, padding: '5px 8px', fontSize: 12 }}>
                    <option value="">— not synced —</option>
                    {asanaProjects.map((ap) => <option key={ap.gid} value={ap.gid}>{ap.name}</option>)}
                  </select>
                ) : (
                  <input value={map[p.id] || ''} onChange={(e) => setMap((m) => ({ ...m, [p.id]: e.target.value }))} placeholder="Asana project GID" style={{ ...inputStyle, width: 200, padding: '5px 8px', fontSize: 12 }} />
                )}
              </div>
              {/* Asana's API has no way to reveal a team ad-hoc-invited to a
                  project via its Share dialog (confirmed live, Jul 2026) — only
                  a project's own OWNING team syncs automatically. Name any
                  extra team(s) here once; Pull re-resolves the roster from the
                  Asana workspace every time, same find-or-create-by-name a
                  detected team would get. */}
              {map[p.id] && (
                <input value={extraTeams[p.id] || ''} onChange={(e) => setExtraTeams((m) => ({ ...m, [p.id]: e.target.value }))}
                  placeholder="Also grant these Asana teams (comma-separated) — for shares Asana's API can't detect, e.g. IT"
                  style={{ ...inputStyle, width: '100%', marginTop: 6, padding: '4px 8px', fontSize: 11.5, boxSizing: 'border-box' }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <button onClick={saveMap} disabled={busy === 'map'} style={btn('outline')}>{busy === 'map' ? 'Saving…' : 'Save mapping'}</button>
          <button onClick={() => run('push')} disabled={!!busy} style={btn('outline')}><ArrowRightLeft size={14} />{busy === 'push' ? 'Pushing…' : 'Push all → Asana'}</button>
          <button onClick={() => run('pull')} disabled={!!busy} style={btn('primary')}><Download size={14} />{busy === 'pull' ? 'Pulling…' : 'Pull ← Asana'}</button>
          {cfg.lastPullAt && <span style={{ fontSize: 11.5, color: NX.faint }}>last pull {fmtDateTime(cfg.lastPullAt)}</span>}
        </div>
        {msg && <div style={{ marginTop: 10, fontSize: 13, color: NX.green }}>{msg}</div>}
        {err && <div style={{ marginTop: 10, fontSize: 13, color: NX.red }}>{err}</div>}

        {/* Real-time inbound via Asana webhooks (needs a public API URL) */}
        <div style={{ borderTop: `1px solid ${NX.border2}`, marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: NX.dim, marginBottom: 8 }}>Real-time (webhooks)</div>
          <Field label={hookEnv.publicBase ? 'Public API base URL (override — blank uses this API)' : 'Public API base URL (Asana must reach it)'}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={targetBase} onChange={(e) => setTargetBase(e.target.value)} placeholder={hookEnv.publicBase || 'https://your-public-api-host'} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => webhooks('register')} disabled={(!hookEnv.publicBase && !targetBase.trim()) || !!busy} style={{ ...btn('outline'), flexShrink: 0 }}>{busy === 'register' ? 'Registering…' : 'Register'}</button>
              {hooks.length > 0 && <button onClick={() => webhooks('delete')} disabled={!!busy} style={{ ...btn('ghost'), flexShrink: 0, color: NX.red }}>{busy === 'delete' ? 'Removing…' : 'Remove'}</button>}
            </div>
          </Field>
          <div style={{ fontSize: 12, color: hooks.length ? NX.green : NX.faint }}>
            {hooks.length ? `✓ ${hooks.length} active webhook(s) — Asana changes stream in live.` : 'No webhooks — inbound relies on the auto-pull + manual Pull.'}
          </div>
          <div style={{ fontSize: 11, color: NX.faint, marginTop: 4 }}>
            {hookEnv.publicBase
              ? `Registers against ${hookEnv.publicBase} — leave the field blank unless you're pointing Asana somewhere else.`
              : 'This API has no public URL, so Asana can’t reach it. Register from the deployed dev/prod site, or paste a public tunnel URL.'}
          </div>
          {!hookEnv.isSyncWorker && (
            <div style={{ fontSize: 11, color: NX.amber, marginTop: 6 }}>
              Background sync is off in this backend — automatic push and the periodic pull only run on the deployed API, so one instance owns the shared Asana workspace. “Push all” and “Pull” below still work from here.
            </div>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 11.5, color: NX.faint }}>
          Syncs both ways: title · description · due date · done · assignee · comments. Inbound is live via webhooks, with a 5-min auto-pull fallback on the deployed API (and manual “Pull” anywhere).
        </div>
      </div>
    </div>
  );
}

// ── 0. Teams — creation lives here (Manage-only); Teams page browses/edits ──
function TeamsTab({ store }) {
  const { teams, tasks, nameOf, deleteTeam, projects } = store;
  const [editing, setEditing] = useState(null); // {} for new, team object to edit, null closed

  const taskCountByTeam = useMemo(() => {
    const m = {};
    for (const t of tasks) if (t.teamId) m[t.teamId] = (m[t.teamId] || 0) + 1;
    return m;
  }, [tasks]);
  const projectName = (id) => projects.find((p) => p.id === id)?.name || 'Unassigned';

  return (
    <div>
      <SectionHead title="Teams" hint="Create and manage the teams members are grouped into, within a project."
        action={<button style={btn('primary')} onClick={() => setEditing({})}><Plus size={15} />New Team</button>} />

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
                  {projectName(d.projectId)} · {members.length} member{members.length === 1 ? '' : 's'} · {taskCountByTeam[d.id] || 0} task{(taskCountByTeam[d.id] || 0) === 1 ? '' : 's'}
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
              {describeTrigger(r.trigger)} → {(r.actions || []).map(describeAction).join(', ') || '—'}
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
  { value: 'checkbox', label: 'Checkbox' },
];

function FieldsTab({ store }) {
  const { customFields, createCustomField, deleteCustomField } = store;
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <SectionHead
        title="Custom Fields"
        hint="Extra fields you can attach to tasks (text, number, date or a select list)."
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
            {f.type === 'select' && !!(f.options || []).length && (
              <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 2 }}>{(f.options || []).join(' · ')}</div>
            )}
          </div>
          <span style={chip(NX.dim, NX.border2)}>{FIELD_TYPES.find((t) => t.value === f.type)?.label || f.type}</span>
          <IconButton icon={Trash2} title="Delete Field" danger onClick={() => { if (confirm(`Delete field "${f.name}"?`)) deleteCustomField(f.id); }} />
        </RowCard>
      ))}
      {adding && <FieldModal onClose={() => setAdding(false)} onSave={async (d) => { await createCustomField(d); setAdding(false); }} />}
    </div>
  );
}

function FieldModal({ onClose, onSave }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('text');
  const [options, setOptions] = useState(['']);

  const setOpt = (i, v) => setOptions((prev) => prev.map((o, idx) => (idx === i ? v : o)));
  const save = () => {
    if (!name.trim()) return;
    const opts = type === 'select' ? options.map((o) => o.trim()).filter(Boolean) : [];
    onSave({ name: name.trim(), description: description.trim(), type, options: opts });
  };

  return (
    <Modal title="New Custom Field" onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>Add Field</button>
      </>
    }>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Story points" style={inputStyle} /></Field>
      <Field label="Description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" style={inputStyle} /></Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)} style={selectStyle}>
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </Field>
      {type === 'select' && (
        <div>
          <label style={fieldLabel}>Options</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map((o, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input value={o} onChange={(e) => setOpt(i, e.target.value)} placeholder={`Option ${i + 1}`} style={{ ...inputStyle, flex: 1 }} />
                <IconButton icon={X} title="Remove Option" onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))} />
              </div>
            ))}
          </div>
          <button style={{ ...btn('outline'), marginTop: 8 }} onClick={() => setOptions((prev) => [...prev, ''])}><Plus size={14} />Add Option</button>
        </div>
      )}
    </Modal>
  );
}

// ── 3. Custom statuses ────────────────────────────────────────────────────────
function StatusesTab({ store }) {
  const { customStatuses, createCustomStatus, deleteCustomStatus } = store;
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <SectionHead
        title="Custom Statuses"
        hint="Additional workflow statuses beyond the four built-in ones."
        action={<button style={btn('primary')} onClick={() => setAdding(true)}><Plus size={15} />New Status</button>}
      />
      {customStatuses.length === 0 ? (
        <EmptyState icon={Palette} title="No Custom Statuses" hint="Add a status to model your own workflow stages." />
      ) : customStatuses.map((s) => (
        <RowCard key={s.id}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: s.color || NX.dim, flexShrink: 0, marginLeft: 6 }} />
          <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>{s.label}</div>
          <IconButton icon={Trash2} title="Delete Status" danger onClick={() => { if (confirm(`Delete status "${s.label}"?`)) deleteCustomStatus(s.id); }} />
        </RowCard>
      ))}
      {adding && <StatusModal onClose={() => setAdding(false)} onSave={async (d) => { await createCustomStatus(d); setAdding(false); }} />}
    </div>
  );
}

function StatusModal({ onClose, onSave }) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const save = () => { if (label.trim()) onSave({ label: label.trim(), color }); };

  return (
    <Modal title="New Status" width={440} onClose={onClose} footer={
      <>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={btn('primary')} onClick={save}>Add Status</button>
      </>
    }>
      <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blocked" style={inputStyle} /></Field>
      <label style={fieldLabel}>Colour</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {SWATCHES.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} title={c} style={{
            width: 30, height: 30, borderRadius: '50%', background: c, cursor: 'pointer',
            border: color === c ? `3px solid ${NX.ink}` : `2px solid ${NX.border}`,
          }} />
        ))}
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
        hint="Reusable task blueprints — default fields plus a pre-built subtask list."
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
                    <span style={{ fontWeight: 700 }}>{actor}</span> {e.detail || humanize(e.type)}{' '}
                    {e.entityCode && <span style={{ fontWeight: 700, color: NX.blue }}>{e.entityCode}</span>}
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
    const headers = ['Code', 'Title', 'Status', 'Priority', 'Assignee', 'Project', 'Due'];
    const rows = list.map((t) => [
      t.code || '',
      t.title || '',
      store.statusMeta[t.status]?.label || t.status || '',
      PRIORITY_META[t.priority]?.label || t.priority || '',
      t.assigneeId ? nameOf(t.assigneeId) : 'Unassigned',
      t.projectId ? (projectName(t.projectId) || '—') : '—',
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
