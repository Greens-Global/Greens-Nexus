// Ticket Manager > AI Features (Oct 2026, backend/routers/ticket_ai.py).
//
// One desk-wide switch for the ticket AI features: the drawer's AI Summary
// and Suggested Help Topic (create form and drawer). On by default. Saves the
// moment it is flipped. Manager+ (a ticket supervisor under explicit desk
// access) - the server is the real boundary; this only shows the control.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, card } from '../tasks/theme';
import { LoadingState } from '../components/AsyncState';
import SavedCheck from '../components/SavedCheck';

export default function TicketAiSettings() {
  const [cfg, setCfg] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api.getTicketAiSettings()
      .then((r) => { if (alive) setCfg(r || { enabled: true }); })
      .catch((e) => { if (alive) setLoadErr(e?.message || 'Could not load the AI settings.'); });
    return () => { alive = false; };
  }, []);

  if (loadErr) return <div style={{ fontSize: 13, color: NX.red, fontFamily: FONT }}>{loadErr}</div>;
  if (!cfg) return <LoadingState size="section" minHeight={120} />;

  const flip = () => {
    const next = !cfg.enabled;
    setSaving(true); setErr(''); setSaved(false);
    api.setTicketAiSettings(next)
      .then((r) => { setCfg(r || { ...cfg, enabled: next }); setSaved(true); setTimeout(() => setSaved(false), 1800); })
      .catch((e) => setErr(e?.message || 'Could not save.'))
      .finally(() => setSaving(false));
  };

  return (
    <div data-testid="ticket-ai-settings" style={{ fontFamily: FONT, color: NX.ink, maxWidth: 760 }}>
      <div style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={16} style={{ color: NX.purple }} />
          <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>AI Features</div>
          <button type="button" role="switch" aria-checked={!!cfg.enabled} aria-label="AI Features" onClick={flip} disabled={saving}
            style={{
              position: 'relative', width: 34, height: 20, borderRadius: 999, border: 'none', cursor: saving ? 'default' : 'pointer',
              background: cfg.enabled ? NX.green : NX.border, transition: 'background 0.15s', flexShrink: 0, padding: 0, opacity: saving ? 0.6 : 1,
            }}>
            <span style={{ position: 'absolute', top: 2, left: cfg.enabled ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
          </button>
          <SavedCheck show={saved} />
        </div>
        <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.6, marginTop: 10 }}>
          When this is on, desk agents get an AI Summary on each ticket (the issue, what has been tried, where it
          stands and the next step), and people raising a ticket see up to three suggested help topics they can
          click. Suggestions are only ever picked from your configured help topics, and nothing is chosen for anyone.
          Requesters never see AI summaries.
        </div>
        {cfg.enabled && !cfg.keyConfigured && (
          <div style={{ fontSize: 12, color: NX.amber, fontWeight: 600, lineHeight: 1.5, marginTop: 10 }}>
            No AI key is set on the server, so AI Summaries are hidden and help topic suggestions use keyword matching only.
          </div>
        )}
        {err && <div role="alert" style={{ fontSize: 12.5, color: NX.red, fontWeight: 600, marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
