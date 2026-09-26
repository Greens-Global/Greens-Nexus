// Tools - the header's actions-and-utilities menu (Neil, Sep 26).
//
// The line it draws: Settings are configuration (how Nexus behaves, saved and
// left alone); Tools are things you DO (start a job, jump into a flow, check
// something, grab info for a ticket). Same idea as the Microsoft 365 / Google
// Workspace admin "quick actions" and the Okta / Rippling admin tools menus:
// one grouped launcher at the top of every screen, each row one action.
//
// Rules this file keeps:
//   - Every row is backed by something real that already exists - no
//     placeholders. Rows a person can't use are HIDDEN, never disabled, using
//     the exact same gates the destination (or the backend route) applies, so
//     Tools never leads anyone to an "Access Restricted" page or a 403.
//   - Act As reuses components/ActAsModal (the same picker Settings used to
//     show inline) and useRole's startActAs / stopActAs; the sticky "Exit Act
//     As" banner in TopHeader is untouched.
//   - The Microsoft 365 sync moved here out of Global Settings (it is an
//     action, not a setting). Its progress lives in a module-level store so it
//     survives the menu closing; the trigger shows a spinner while it runs and
//     a toast reports the result.
//   - Phones: the header trigger is hidden (a 4th right-side icon collides
//     with the NEXUS wordmark), so the phone menu (MobileMenu) opens this via
//     the `nexus:tools-open` window event and it renders as a sheet.
import { useState, useEffect, useRef, useCallback, useSyncExternalStore, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import {
  Wrench, UserCog, DoorOpen, RefreshCw, Activity, FileText, FileSignature,
  Gauge, ClipboardCopy, Loader2, X,
} from 'lucide-react';
import { api, API_BASE } from '../api';
import { useRole, ROLES, EXTERNAL_ROLE_META } from '../contexts/RoleContext';
import { useIsMobile } from '../lib/useIsMobile';
import { formatDateTime } from '../lib/datetime';

const ActAsModal = lazy(() => import('./ActAsModal'));

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev';
const shortBuild = (id) => (/^[0-9a-f]{12,}$/i.test(id) ? id.slice(0, 7) : id);

// ── Gates ────────────────────────────────────────────────────────────────────
// Mirrors App.jsx's ProtectedView for the views Tools links to (VIEW_MIN_ROLES
// there: documents / admin-console are 'supervisor'; pdf-editor has no entry,
// so it is open to every internal user). Keep in sync if those change.
const VIEW_MIN_ROLES = { documents: 'supervisor', 'admin-console': 'supervisor' };
function canOpenView(view, { can, myGrantedModules, isExternal }) {
  if (isExternal) return !!myGrantedModules?.has(view);
  const minRole = VIEW_MIN_ROLES[view];
  return !minRole || can('administrator') || (minRole !== 'administrator' && !!myGrantedModules?.has(view));
}

// ── Microsoft 365 sync: state that outlives the menu ─────────────────────────
let syncState = { busy: false, label: '' };
const syncListeners = new Set();
const toastListeners = new Set();
function setSync(next) {
  syncState = { ...syncState, ...next };
  syncListeners.forEach(l => l());
}
function subscribeSync(l) { syncListeners.add(l); return () => syncListeners.delete(l); }
function getSync() { return syncState; }
function emitToast(msg, kind = 'success') { toastListeners.forEach(l => l({ msg, kind })); }

// Same job the Settings "Sync Now" button used to run: start the server-side
// two-way sync, poll its status, then the best-effort photo pass. A 409 means
// a sync is already running (maybe started by someone else) - watch that one.
async function runM365Sync() {
  if (syncState.busy) return;
  setSync({ busy: true, label: 'Starting…' });
  emitToast('Microsoft 365 sync started. You can keep working; you will see the result here.');
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
      emitToast(`Microsoft 365 sync failed: ${s.errors?.[0]?.error || 'please try again'}.`, 'error');
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
      emitToast(`Microsoft 365 sync complete: ${bits.join(' · ')}.`);
    }
  } catch (err) {
    emitToast(err?.message || 'Microsoft 365 sync failed.', 'error');
  }
  setSync({ busy: false, label: '' });
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

async function checkSystemStatus() {
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
// Plain text for a support ticket. Deliberately only the page PATH (no query
// string or hash - links like ?request= or sign tokens live there) and never
// tokens, cookies, storage or session ids.
function buildDiagnosticText({ status, email, roleLabel, actingAs, isExternal }) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  const [view = 'dashboard', sub = ''] = path.split('/').filter(Boolean);
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const scr = typeof window !== 'undefined' && window.screen ? `${window.screen.width} x ${window.screen.height}` : 'unknown';
  const win = typeof window !== 'undefined' ? `${window.innerWidth} x ${window.innerHeight}` : 'unknown';
  const api = !status
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
    `API: ${api}`,
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

function SystemStatusDialog({ onClose }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const closeRef = useRef(null);

  const run = useCallback(async () => {
    setChecking(true);
    const s = await checkSystemStatus();
    setStatus(s);
    setChecking(false);
  }, []);
  useEffect(() => {
    let live = true;
    checkSystemStatus().then(s => { if (live) { setStatus(s); setChecking(false); } });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = (label, value, tone) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ color: tone || 'var(--ink)', fontWeight: 600, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="nx-status-title"
        style={{ background: 'var(--card)', borderRadius: 14, width: 380, maxWidth: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box' }}
        onMouseDown={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Gauge size={16} style={{ color: 'var(--muted)' }} />
            <span id="nx-status-title" style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>System Status</span>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: '6px 18px 16px' }} aria-live="polite">
          {!status ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', fontSize: 13, color: 'var(--muted)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Checking the Nexus API…
            </div>
          ) : (
            <>
              {row('Nexus API', status.reachable ? 'Reachable' : 'Unreachable',
                status.reachable ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))')}
              {row('Response Time', status.ms != null && status.reachable ? `${status.ms} ms` : '-')}
              {row('API Version', status.apiVersion || '-')}
              {row('App Build', shortBuild(BUILD_ID))}
              {row('Last Checked', formatDateTime(status.checkedAt))}
              {!status.reachable && (
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
                  Nexus can't reach its server right now. Check your connection and try again. If it keeps failing, copy the diagnostic info from Tools into a support ticket.
                </p>
              )}
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="secondary-btn" onClick={run} disabled={checking}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {checking ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={13} />}
              {checking ? 'Checking…' : 'Check Again'}
            </button>
            <button className="primary-btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const ITEM_CSS = `
.nx-tools-item { display:flex; align-items:center; gap:10px; width:100%; background:none; border:none; padding:8px 10px; border-radius:7px; font-family:'Inter',sans-serif; color:var(--ink); cursor:pointer; text-align:left; box-sizing:border-box; }
.nx-tools-item:hover, .nx-tools-item:focus-visible { background: var(--sidebar-hover-bg, var(--mist)); outline: none; }
.nx-tools-item:focus-visible { box-shadow: inset 0 0 0 2px var(--wk-brand, var(--line)); }
.nx-tools-item[aria-disabled="true"] { cursor: default; }
.nx-tools-item .nx-tools-icon { width:28px; height:28px; border-radius:7px; background:var(--paper, var(--mist)); border:1px solid var(--line); display:grid; place-items:center; flex-shrink:0; color:var(--ink); }
`;

export default function ToolsMenu() {
  const role = useRole();
  const { can, myRole, realEmail, myGrantedModules, canAccessModule, hrScope, isExternal, actingAs, startActAs, stopActAs } = role;
  const narrow = useIsMobile('(max-width: 900px)');
  const [open, setOpen] = useState(false);
  const [actAsOpen, setActAsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [stopping, setStopping] = useState(false);
  const sync = useSyncExternalStore(subscribeSync, getSync, getSync);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [anchor, setAnchor] = useState(null);

  // ── Gates (hide, never disable) ──
  const showActAs = !actingAs && (can('manager') || !!myGrantedModules?.has('act-as'));
  // Server: require_hr_write (IT Admin+ or an 'hr' Editor grant) AND
  // _require_unrestricted (no company-scoped People access).
  const showSync = !!canAccessModule?.('hr', 'administrator', 'editor') && !Array.isArray(hrScope);
  // Settings > Audit Logs reads /audit-logs, which is require_administrator.
  const showAudit = can('administrator') && canOpenView('admin-console', role);
  const showPdf = canOpenView('pdf-editor', role);
  // Sending needs the Documents screen AND the e-sign send route's
  // require_hr_write, or the wizard ends in a 403.
  const showSign = canOpenView('documents', role) && !!canAccessModule?.('hr', 'administrator', 'editor');

  const groups = [
    { key: 'admin', label: 'Admin', items: [
      actingAs && { key: 'exit-act-as', Icon: DoorOpen, label: stopping ? 'Exiting…' : 'Exit Act As',
        hint: `You are acting as ${actingAs.targetName}`, danger: true },
      showActAs && { key: 'act-as', Icon: UserCog, label: 'Act As', hint: 'See Nexus the way another employee does' },
      showSync && { key: 'm365', Icon: RefreshCw, label: 'Sync Microsoft 365', busy: sync.busy,
        hint: sync.busy ? (sync.label || 'Running…') : 'Update people and photos from the directory' },
      showAudit && { key: 'audit', Icon: Activity, label: 'Audit Logs', hint: 'Who changed what, and when' },
    ].filter(Boolean) },
    { key: 'everyday', label: 'Everyday', items: [
      showPdf && { key: 'pdf', Icon: FileText, label: 'PDF Editor', hint: 'Open, edit and convert PDF files' },
      showSign && { key: 'sign', Icon: FileSignature, label: 'Send for Signature', hint: 'Start a new Nexus Sign envelope' },
    ].filter(Boolean) },
    { key: 'troubleshooting', label: 'Troubleshooting', items: [
      { key: 'status', Icon: Gauge, label: 'System Status', hint: 'Check the connection to Nexus' },
      { key: 'diag', Icon: ClipboardCopy, label: 'Copy Diagnostic Info', hint: 'For a support ticket' },
    ] },
  ].filter(g => g.items.length);

  const focusItem = (idx) => {
    const items = panelRef.current ? [...panelRef.current.querySelectorAll('[data-tool-item]')] : [];
    if (!items.length) return;
    items[(idx + items.length) % items.length].focus();
  };

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus && triggerRef.current && triggerRef.current.offsetParent !== null) triggerRef.current.focus();
  }, []);

  const openMenu = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect?.();
    setAnchor(r && r.width ? { top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) } : null);
    setOpen(true);
  }, []);

  // Toast feed from the sync job (and copy results below).
  useEffect(() => {
    let timer;
    const l = (t) => { setToast(t); clearTimeout(timer); timer = setTimeout(() => setToast(null), 4500); };
    toastListeners.add(l);
    return () => { toastListeners.delete(l); clearTimeout(timer); };
  }, []);

  // Phones: MobileMenu has no header trigger to click - it asks by event.
  useEffect(() => {
    const onOpen = () => openMenu();
    window.addEventListener('nexus:tools-open', onOpen);
    return () => window.removeEventListener('nexus:tools-open', onOpen);
  }, [openMenu]);

  // Focus the first row on open; Esc / outside click close.
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => focusItem(0), 0);
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);

  function onPanelKey(e) {
    const items = [...panelRef.current.querySelectorAll('[data-tool-item]')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(idx < 0 ? -1 : idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
  }

  const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

  async function copyDiagnostics() {
    const roleLabel = isExternal ? EXTERNAL_ROLE_META.label : (ROLES[myRole]?.label || ROLES.employee.label);
    const text = checkSystemStatus()
      .catch(() => null)
      .then(status => buildDiagnosticText({ status, email: realEmail, roleLabel, actingAs, isExternal }));
    try {
      await copyText(text);
      emitToast('Diagnostic info copied. Paste it into your support ticket.');
    } catch (err) {
      emitToast(err?.message || 'Could not copy to the clipboard.', 'error');
    }
  }

  async function activate(item) {
    if (item.busy) return;
    switch (item.key) {
      case 'exit-act-as':
        if (stopping) return;
        setStopping(true);
        try { await stopActAs(); } finally { setStopping(false); }
        close(false);
        return;
      case 'act-as':   close(false); setActAsOpen(true); return;
      case 'm365':     runM365Sync(); return; // menu stays open so the progress shows
      case 'audit':    close(false); navigate('admin-console', 'audit'); return;
      case 'pdf':      close(false); navigate('pdf-editor', null); return;
      case 'sign':     close(false); navigate('documents', 'documents-esign-new'); return;
      case 'status':   close(false); setStatusOpen(true); return;
      case 'diag':     close(); copyDiagnostics(); return;
      default:         return;
    }
  }

  const sheet = narrow || !anchor;
  const panelStyle = sheet
    ? { position: 'fixed', top: 64, left: 12, right: 12, maxHeight: 'calc(100dvh - 80px)' }
    : { position: 'fixed', top: anchor.top, right: anchor.right, width: 300, maxHeight: `calc(100vh - ${anchor.top + 16}px)` };

  const panel = open && createPortal(
    <div ref={panelRef} role="menu" aria-label="Tools" onKeyDown={onPanelKey}
      style={{
        ...panelStyle, overflowY: 'auto', boxSizing: 'border-box', background: 'var(--card)',
        border: '1px solid var(--line)', borderRadius: 12, boxShadow: 'var(--shadow-lg, 0 8px 28px rgba(0,0,0,0.15))',
        padding: 6, zIndex: 1200, fontFamily: 'Inter, sans-serif',
      }}>
      <style>{ITEM_CSS}</style>
      {sheet && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px 2px' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Tools</span>
          <button onClick={() => close()} aria-label="Close tools" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
      )}
      {groups.map((g, gi) => (
        <div key={g.key} role="group" aria-labelledby={`nx-tools-${g.key}`}>
          {gi > 0 && <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />}
          <div id={`nx-tools-${g.key}`} style={{ padding: '8px 10px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {g.label}
          </div>
          {g.items.map(item => (
            <button key={item.key} type="button" role="menuitem" data-tool-item className="nx-tools-item"
              aria-disabled={item.busy ? 'true' : undefined} onClick={() => activate(item)}>
              <span className="nx-tools-icon" style={item.danger ? { color: 'hsl(var(--color-orange))' } : undefined}>
                {item.busy
                  ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  : <item.Icon size={14} />}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: item.danger ? 'hsl(var(--color-orange))' : 'var(--ink)' }}>{item.label}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );

  return (
    <>
      {/* Desktop-only trigger (.header-desktop-tools hides it under 900px). */}
      <span className="header-desktop-tools">
        <button ref={triggerRef} type="button" className="icon-btn" title={sync.busy ? 'Tools - Microsoft 365 sync running' : 'Tools'}
          aria-label="Tools" aria-haspopup="menu" aria-expanded={open}
          onClick={() => (open ? close(false) : openMenu())}
          style={{ position: 'relative' }}>
          <Wrench style={{ width: 16, height: 16 }} />
          {sync.busy && (
            <span aria-hidden style={{ position: 'absolute', top: 5, right: 5, width: 9, height: 9, borderRadius: '50%', border: '2px solid var(--line)', borderTopColor: 'var(--wk-brand, var(--ink))', animation: 'spin 0.8s linear infinite', boxSizing: 'border-box' }} />
          )}
        </button>
      </span>
      {panel}

      {actAsOpen && (
        <Suspense fallback={null}>
          <ActAsModal onClose={() => setActAsOpen(false)} onStart={startActAs} />
        </Suspense>
      )}
      {statusOpen && <SystemStatusDialog onClose={() => setStatusOpen(false)} />}
      {toast && createPortal(
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'error' ? 'hsl(var(--color-red))' : 'hsl(var(--color-green))', color: '#fff', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600, zIndex: 1300, boxShadow: 'var(--shadow-lg)', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif' }}>
          {toast.msg}
        </div>,
        document.body,
      )}
    </>
  );
}
