// Settings -> Tools (Sep 26): the things an admin DOES, next to the things
// they configure - Act As and the Microsoft 365 directory sync. This replaced
// the header's wrench menu (Pranshu: the extra header icon earned nothing a
// Settings tab doesn't do better); the troubleshooting card went too.
//
// Each card is gated the same way its backend route is, and hidden (not
// disabled) when the person can't use it:
//   - Act As: Manager+ or an 'act-as' grant (routers/act_as.py).
//   - Microsoft 365 sync: require_hr_write + _require_unrestricted in
//     routers/hr.py, i.e. IT Admin+ or a People Editor grant, and no
//     company-limited People access.
import { useState, useSyncExternalStore, lazy, Suspense } from 'react';
import { UserCog, DoorOpen, RefreshCw, Loader2, Wrench } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDateTime } from '../lib/datetime';
import { SkeletonBlocks } from '../components/AsyncState';

const ActAsPicker = lazy(() => import('../components/ActAsModal').then(m => ({ default: m.ActAsPicker })));

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
async function runM365Sync() {
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

const spin = { animation: 'spin 1s linear infinite' };

export default function SettingsTools() {
  const { can, myGrantedModules, canAccessModule, hrScope, actingAs, startActAs, stopActAs } = useRole();
  const sync = useSyncExternalStore(subscribeSync, getSync, getSync);
  const [stopping, setStopping] = useState(false);

  const canActAs = can('manager') || !!myGrantedModules?.has('act-as');
  const canSync = !!canAccessModule?.('hr', 'administrator', 'editor') && !Array.isArray(hrScope);

  async function exitActAs() {
    setStopping(true);
    try { await stopActAs(); } finally { setStopping(false); }
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
                <ActAsPicker onStart={startActAs} autoFocus={false} pageSize={10} />
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

        </div>
      </div>
    </div>
  );
}
