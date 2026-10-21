// Settings > Global Settings > Operations > Push to Cubby (Visesh, Oct 21 2026:
// "we will keep the feature of pushing but keep it locked and we add a switch
// somewhere under settings to turn it on").
//
// One server-side switch, OFF by default (backend/ops_cubby_push.py,
// routers/ops_settings.py). Off: Nexus only reads from Cubby and staff mark
// changes "Entered in Cubby" by hand. On: Rate Management and Revenue
// Management show Push to Cubby, and the server allows the push routes.
// Administrators or an Operations Full grant may flip it (`canEdit`); every
// flip is audited and the last few are listed here.
import { useCallback, useEffect, useState } from 'react';
import { Lock, Send } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';

export default function OpsSettings({ toastOk, toastErr }) {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try { setState({ status: 'ready', data: await api.getOpsSettings() }); } catch (err) {
      console.error('Operations settings: could not load', err);
      setState({ status: 'error', data: null });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (state.status === 'loading') return <SkeletonBlocks count={2} height={44} borderRadius={10} />;
  if (state.status === 'error') return <ErrorBanner message="Couldn't load the Operations settings." onRetry={load} />;
  const s = state.data;
  const on = !!s.cubbyPushOn;

  const flip = async () => {
    const next = !on;
    if (next && !window.confirm('Turn on Push to Cubby? Approved rate and rent changes will be sent to Cubby from Nexus, which changes live prices and rents.')) return;
    setSaving(true);
    try {
      setState({ status: 'ready', data: await api.saveOpsSettings({ cubbyPushOn: next }) });
      toastOk?.(next ? 'Push to Cubby is on' : 'Push to Cubby is off');
    } catch (err) {
      console.error('Operations settings: could not save', err);
      toastErr?.(err?.message || 'That could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <div data-testid="ops-settings" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {on ? <Send size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
          <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>Push to Cubby</div>
          <span className={`status-badge ${on ? 'status-approved' : 'pill-muted'}`}>{on ? 'On' : 'Off'}</span>
          <button type="button" role="switch" aria-checked={on} aria-label="Push to Cubby" onClick={flip} disabled={saving || !s.canEdit}
            style={{
              position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', padding: 0, flexShrink: 0,
              cursor: saving || !s.canEdit ? 'default' : 'pointer', background: on ? 'var(--ok-fg, #15803d)' : 'var(--line, #cbd5e1)',
              opacity: saving || !s.canEdit ? 0.6 : 1, transition: 'background 0.15s',
            }}>
            <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 10 }}>
          <p style={{ margin: '0 0 6px' }}>
            <strong style={{ color: 'var(--ink)' }}>Off (the default):</strong> Nexus only reads from Cubby. Staff enter rate and rent
            changes in Cubby by hand, then mark them &quot;Entered in Cubby&quot; in Rate Management and Revenue Management.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--ink)' }}>On:</strong> those screens show Push to Cubby, and Nexus sends approved new
            standard and web rates, and existing tenants&apos; rent changes, to Cubby itself. Every push is logged with who sent it.
          </p>
        </div>
        {on && !s.writeConfigured && (
          <p className="ops-note" role="status" style={{ margin: '10px 0 0', color: 'var(--warn-fg)' }}>
            This server has no Cubby key with the Manager role ({s.writeKeyEnv}), so pushes will be refused until an
            administrator adds it in the API&apos;s app settings.
          </p>
        )}
        {!s.canEdit && (
          <p className="ops-note" style={{ margin: '10px 0 0' }}>
            You can see this setting. Only a Global Admin, an IT Admin or someone with Full access to Operations can change it.
          </p>
        )}
        {s.updatedAt && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
            Last changed {formatDateTime(s.updatedAt)} by {s.updatedBy}
          </div>
        )}
      </div>
      {s.history?.length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Recent Changes</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--muted)' }} data-testid="ops-settings-history">
            {s.history.map((h, i) => (
              <li key={`${h.at}:${i}`}>{formatDateTime(h.at)} - {h.by} turned it {h.to ? 'on' : 'off'}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
