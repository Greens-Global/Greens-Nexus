// Settings -> Tools (Sep 26): the things an admin DOES, next to the things
// they configure. Act As, the Microsoft 365 directory sync, and two
// troubleshooting helpers (a live API check and a copy-ready diagnostic block
// for support tickets). This replaced the header's wrench menu - Pranshu: the
// extra header icon earned nothing that a Settings tab doesn't do better.
//
// Each card is gated the same way its backend route is, and hidden (not
// disabled) when the person can't use it:
//   - Act As: Manager+ or an 'act-as' grant (routers/act_as.py).
//   - Microsoft 365 sync: require_hr_write + _require_unrestricted in
//     routers/hr.py, i.e. IT Admin+ or a People Editor grant, and no
//     company-limited People access.
//   - Troubleshooting: everyone who can open Settings.
import { useState, useEffect, useCallback, useSyncExternalStore, lazy, Suspense } from 'react';
import { UserCog, DoorOpen, RefreshCw, Gauge, ClipboardCopy, Loader2, Wrench } from 'lucide-react';
import { api, API_BASE } from '../api';
import { useRole, ROLES, EXTERNAL_ROLE_META } from '../contexts/RoleContext';
import { formatDateTime } from '../lib/datetime';
import { SkeletonBlocks } from '../components/AsyncState';

const ActAsPicker = lazy(() => import('../components/ActAsModal').then(m => ({ default: m.ActAsPicker })));

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev';
const shortBuild = (id) => (/^[0-9a-f]{12,}$/i.test(id) ? id.slice(0, 7) : id);

// ── Microsoft 365 sync: state that outlives the tab ──────────────────────────
// A sync takes a minute or two. Kept at module level so leaving the tab (or
// Settings) mid-run doesn't lose it, and coming back shows where it got to
// and how the last run ended.
let syncState = { busy: false, label: '', last: null };   // last: { ok, text, at }
const syncListeners = new Set();
function setSync(next) {
  syncState = { ...syncState, ...next };
  syncListeners.forEach(l => l());
}
function subscribeSync(l) { syncListeners.add(l); return () => syncListeners.delete(l); }
function getSync() { return syncState; }

// Start the server-side two-way sync, poll it, then the best-effort photo
// pass. A 409 means a sync is already running (maybe started by someone
// else) - watch that one instead of failing.
export async function runM365Sync() {
  if (syncState.busy) return;
  setSync({ busy: true, label: 'Starting…' });
  let last;
  try {
    try { await api.syncM365TwoWay(); }
    catch (err) { if (err?.status !== 409) throw err; }
    let s = null;
    for (;;) {
      await new Promise(r => setTimeout(r, 2500));
      try { s = await api.syncM365TwoWayStatus(); } catch { continue; }
      if (s.phase === 'pull') setSync({ label: 'Reading directory…' });
      else if (s.phase === 'push') setSync({ label: `Updating ${s.done} of ${s.total}…` });
      else break;
    }
    if (s?.phase === 'failed') {
      last = { ok: false, text: `Failed: ${s.errors?.[0]?.error || 'please try again'}.` };
    } else {
      const bits = [];
      const p = s?.pull || {};
      if (p.created) bits.push(`${p.created} added`);
      bits.push(`${p.linked || 0} linked`, `${p.updated || 0} updated`);
      bits.push(`${s?.pushedOk || 0} sent to Microsoft 365`);
      try {
        setSync({ label: 'Syncing photos…' });
        const ph = await api.syncM365Photos();
        if (ph?.updated) bits.push(`${ph.updated} photos`);
      } catch { /* photo pass is best-effort */ }
      last = { ok: true, text: `Complete: ${bits.join(' · ')}.` };
    }
  } catch (err) {
    last = { ok: false, text: err?.message || 'Microsoft 365 sync failed.' };
  }
  setSync({ busy: false, label: '', last: { ...last, at: new Date() } });
}

// ── System status ────────────────────────────────────────────────────────────
// /health and /version are unauthenticated and exempt from rate limiting
// (middleware_hardening.EXEMPT_PREFIXES). credentials: 'omit' - neither needs
// a cookie, and nothing about the session should ride along.
async function timedFetch(path, ms = 8000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  try {
    return await fetch(`${API_BASE}${path}`, { cache: 'no-store', credentials: 'omit', signal: ctrl?.signal });
  } finally { if (timer) clearTimeout(timer); }
}

export async function checkSystemStatus() {
  const out = { reachable: false, ms: null, apiVersion: '', checkedAt: new Date() };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  try {
    const r = await timedFetch('/health');
    out.ms = Math.round(now() - t0);
    out.reachable = !!r?.ok;
  } catch { /* unreachable */ }
  if (out.reachable) {
    try {
      const v = await timedFetch('/version');
      if (v?.ok) out.apiVersion = (await v.json())?.version || '';
    } catch { /* version is informational */ }
  }
  out.checkedAt = new Date();
  return out;
}

// ── Diagnostic info ──────────────────────────────────────────────────────────
// Plain text for a support ticket. Only the page PATH (no query string or
// hash - links like ?request= or sign tokens live there) and never tokens,
// cookies, storage or session ids.
export function buildDiagnosticText({ status, email, roleLabel, actingAs, isExternal }) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const [view = 'dashboard', sub = ''] = path.split('/').filter(Boolean);
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const scr = typeof window !== 'undefined' && window.screen ? `${window.screen.width} x ${window.screen.height}` : 'unknown';
  const win = typeof window !== 'undefined' ? `${window.innerWidth} x ${window.innerHeight}` : 'unknown';
  const apiLine = !status
    ? 'Not checked'
    : status.reachable
      ? `Reachable (${status.ms} ms)${status.apiVersion ? `, version ${status.apiVersion}` : ''}`
      : 'Unreachable';
  let apiHost = '';
  try { apiHost = new URL(API_BASE, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').host; } catch { /* keep blank */ }
  return [
    'Nexus Diagnostic Info',
    `Captured: ${formatDateTime(new Date())}`,
    `App build: ${shortBuild(BUILD_ID)}`,
    `API: ${apiLine}`,
    `API host: ${apiHost || 'unknown'}`,
    `Page: ${path || '/'} (view: ${view}${sub ? `, sub: ${sub}` : ''})`,
    `Signed in as: ${email || 'unknown'}`,
    `Access level: ${roleLabel}${isExternal ? ' (external account)' : ''}`,
    `Acting as: ${actingAs ? `${actingAs.targetName} (${actingAs.targetEmail})` : 'No'}`,
    `Browser: ${nav.userAgent || 'unknown'}`,
    `Platform: ${nav.userAgentData?.platform || nav.platform || 'unknown'}`,
    `Language: ${nav.language || 'unknown'}${tz ? `, time zone ${tz}` : ''}`,
    `Screen: ${scr}, window ${win}, pixel ratio ${typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1}`,
    `Online: ${nav.onLine === false ? 'No' : 'Yes'}`,
  ].join('\n');
}

// Takes a PROMISE of the text: the API check runs first, and Safari only lets
// a page write to the clipboard inside the click that asked for it. A
// ClipboardItem holding a promise keeps that permission while the text is
// still being built; plain writeText (and the textarea fallback) cover the rest.
async function copyText(textPromise) {
  if (typeof window.ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      const blob = textPromise.then(t => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new window.ClipboardItem({ 'text/plain': blob })]);
      return;
    } catch { /* fall through to writeText */ }
  }
  const text = await textPromise;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand?.('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('Copy is blocked in this browser.');
}

// ── Layout ───────────────────────────────────────────────────────────────────
function ToolCard({ icon: Icon, title, sub, children, testId }) {
  return (
    <section data-testid={testId} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 18, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--paper)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon size={14} style={{ color: 'var(--ink)' }} />
        </span>
        <span style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</h3>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{sub}</div>
        </span>
      </div>
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
  );
}

const statusRow = (label, value, tone) => (
  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line)', fontSize: 12.5 }}>
    <span style={{ color: 'var(--muted)' }}>{label}</span>
    <span style={{ color: tone || 'var(--ink)', fontWeight: 600, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
  </div>
);

const spin = { animation: 'spin 1s linear infinite' };

export default function SettingsTools({ toastOk, toastErr }) {
  const { can, myRole, realEmail, myGrantedModules, canAccessModule, hrScope, isExternal, actingAs, startActAs, stopActAs } = useRole();
  const sync = useSyncExternalStore(subscribeSync, getSync, getSync);
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  const canActAs = can('manager') || !!myGrantedModules?.has('act-as');
  const canSync = !!canAccessModule?.('hr', 'administrator', 'editor') && !Array.isArray(hrScope);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setStatus(await checkSystemStatus());
    setChecking(false);
  }, []);
  // One check on arrival, so the card never opens empty.
  useEffect(() => { runCheck(); }, [runCheck]);

  async function exitActAs() {
    setStopping(true);
    try { await stopActAs(); } finally { setStopping(false); }
  }

  async function copyDiagnostics() {
    const roleLabel = isExternal ? EXTERNAL_ROLE_META.label : (ROLES[myRole]?.label || ROLES.employee.label);
    const text = checkSystemStatus()
      .catch(() => null)
      .then(s => buildDiagnosticText({ status: s, email: realEmail, roleLabel, actingAs, isExternal }));
    try {
      await copyText(text);
      toastOk?.('Diagnostic info copied. Paste it into your support ticket.');
    } catch (err) {
      toastErr?.(err?.message || 'Could not copy to the clipboard.');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)', marginBottom: 16 }}>
        <Wrench size={15} style={{ color: 'var(--muted)', marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Actions, not settings.</strong> Nothing here changes how Nexus is set up.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 14, alignItems: 'start' }}>
        {(canActAs || actingAs) && (
          <ToolCard testId="tool-act-as" icon={UserCog} title="Act As"
            sub="Use Nexus as another employee sees it, to troubleshoot their access. Limited to people whose role is below your own.">
            {actingAs ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink)' }}>
                  Currently acting as <strong>{actingAs.targetName}</strong> ({actingAs.targetEmail}).
                </span>
                <button className="secondary-btn" onClick={exitActAs} disabled={stopping}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-red))' }}>
                  <DoorOpen size={14} /> {stopping ? 'Exiting…' : 'Exit Act As'}
                </button>
              </div>
            ) : (
              <Suspense fallback={<SkeletonBlocks count={3} height={40} borderRadius={10} />}>
                <ActAsPicker onStart={startActAs} autoFocus={false} />
              </Suspense>
            )}
          </ToolCard>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {canSync && (
            <ToolCard testId="tool-m365" icon={RefreshCw} title="Microsoft 365 Directory Sync"
              sub="Sync employee records and profile photos between Nexus and the Microsoft 365 directory. It runs in the background, so you can leave this page.">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button className="primary-btn" onClick={runM365Sync} disabled={sync.busy}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {sync.busy ? <Loader2 size={14} style={spin} /> : <RefreshCw size={14} />}
                  {sync.busy ? 'Syncing…' : 'Sync Now'}
                </button>
                {sync.busy && <span aria-live="polite" style={{ fontSize: 12.5, color: 'var(--muted)' }}>{sync.label}</span>}
              </div>
              {!sync.busy && sync.last && (
                <div aria-live="polite" style={{ fontSize: 12, marginTop: 10, color: sync.last.ok ? 'var(--muted)' : 'hsl(var(--color-red))' }}>
                  Last run {formatDateTime(sync.last.at)}: {sync.last.text}
                </div>
              )}
            </ToolCard>
          )}

          <ToolCard testId="tool-troubleshooting" icon={Gauge} title="Troubleshooting"
            sub="Check that Nexus can reach its server, and copy the details support needs into a ticket.">
            <div aria-live="polite">
              {!status ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12.5, color: 'var(--muted)' }}>
                  <Loader2 size={14} style={spin} /> Checking the Nexus API…
                </div>
              ) : (
                <>
                  {statusRow('Nexus API', status.reachable ? 'Reachable' : 'Unreachable',
                    status.reachable ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))')}
                  {statusRow('Response Time', status.ms != null && status.reachable ? `${status.ms} ms` : '-')}
                  {statusRow('API Version', status.apiVersion || '-')}
                  {statusRow('App Build', shortBuild(BUILD_ID))}
                  {statusRow('Last Checked', formatDateTime(status.checkedAt))}
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <button className="secondary-btn" onClick={runCheck} disabled={checking}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {checking ? <Loader2 size={13} style={spin} /> : <RefreshCw size={13} />}
                {checking ? 'Checking…' : 'Check Again'}
              </button>
              <button className="secondary-btn" onClick={copyDiagnostics}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ClipboardCopy size={13} /> Copy Diagnostic Info
              </button>
            </div>
          </ToolCard>
        </div>
      </div>
    </div>
  );
}
