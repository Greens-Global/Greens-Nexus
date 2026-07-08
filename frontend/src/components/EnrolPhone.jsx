import { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { Loader2, X, KeyRound, Smartphone, Ban } from 'lucide-react';
import { api, API_BASE } from '../api';

// Enrol a field worker's phone: mint a one-time device token (reuses the
// silent-agent model) and render a QR that carries EVERYTHING the Nexus Field
// app needs — server URL + pairing code — so one scan pairs the phone with no
// typing. Token is generated locally into the QR; it never leaves the browser.
export default function EnrolPhone({ employees = [], onClose, toastErr }) {
  const [email, setEmail] = useState('');
  const [serverUrl, setServerUrl] = useState(API_BASE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pairing, setPairing] = useState(null);   // { code } after enroll
  const [qr, setQr] = useState('');
  const [devices, setDevices] = useState(null);
  const canvasRef = useRef(null);

  const loadDevices = useCallback(() => {
    api.timeAgentDevices()
      .then(r => setDevices((r.devices || []).filter(d => (d.label || '').toLowerCase().includes('phone'))))
      .catch(() => setDevices([]));
  }, []);
  useEffect(() => { loadDevices(); }, [loadDevices]);

  // (Re)draw the QR whenever we have a code + a server URL.
  useEffect(() => {
    if (!pairing) { setQr(''); return; }
    const payload = JSON.stringify({ v: 1, api: serverUrl.trim().replace(/\/$/, ''), code: pairing.code });
    QRCode.toDataURL(payload, { width: 260, margin: 1, errorCorrectionLevel: 'M' })
      .then(setQr).catch(() => setQr(''));
  }, [pairing, serverUrl]);

  async function enrol() {
    const em = email.trim().toLowerCase();
    if (!em.includes('@')) { setErr('Enter the worker’s work email.'); return; }
    if (!serverUrl.trim()) { setErr('Set the server URL.'); return; }
    setErr(''); setBusy(true);
    try {
      const r = await api.timeAgentEnroll({ email: em, label: 'Field phone' });
      setPairing({ code: r.token });
      loadDevices();
    } catch (e) { setErr(e?.message || 'Could not enrol — admin permission is required.'); }
    setBusy(false);
  }

  async function revoke(id) {
    try { await api.timeAgentRevoke(id); loadDevices(); }
    catch (e) { toastErr && toastErr(e?.message || 'Could not revoke.'); }
  }

  const overlay = {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000,
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
  };
  const card = {
    background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
    width: 'min(560px, 100%)', padding: 22, fontFamily: 'Inter,sans-serif',
  };

  return (
    <div style={overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <Smartphone size={18} style={{ color: 'var(--pine)' }} />
          <strong style={{ fontSize: 16 }}>Enrol a phone</strong>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>

        {!pairing ? (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
              Generate a pairing QR for the Nexus Field app. Scanning it sets up the phone with no typing.
            </p>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Worker email</label>
            <input className="form-input" list="enrol-emp" value={email} placeholder="worker@greensglobal.com"
              onChange={e => setEmail(e.target.value)} style={{ width: '100%', marginTop: 4, fontSize: 13 }} />
            <datalist id="enrol-emp">
              {employees.map(e => {
                const em = e.email || e.work_email; if (!em) return null;
                const nm = e.name || `${e.firstName || e.first_name || ''} ${e.lastName || e.last_name || ''}`.trim();
                return <option key={em} value={em}>{nm}</option>;
              })}
            </datalist>
            <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginTop: 12 }}>Server URL (baked into the QR)</label>
            <input className="form-input" value={serverUrl} onChange={e => setServerUrl(e.target.value)}
              style={{ width: '100%', marginTop: 4, fontSize: 13 }} />
            {err && <p style={{ fontSize: 11.5, color: '#b91c1c', margin: '10px 0 0' }}>{err}</p>}
            <button className="primary-btn" onClick={enrol} disabled={busy}
              style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <KeyRound size={13} />}
              Generate pairing QR
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
              In the <strong>Nexus Field</strong> app tap <strong>Scan pairing QR</strong> and point it here.
              This code is shown once — generate a new one per phone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 14px' }}>
              {qr
                ? <img src={qr} alt="Pairing QR" width={260} height={260}
                    style={{ borderRadius: 12, border: '1px solid var(--line)', background: '#fff', padding: 8 }} />
                : <div style={{ width: 260, height: 260, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Generating…</div>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', wordBreak: 'break-all' }}>
              {email.trim().toLowerCase()} · {serverUrl.trim().replace(/\/$/, '')}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
              <button className="secondary-btn" onClick={() => { setPairing(null); setEmail(''); }} style={{ fontSize: 12 }}>Enrol another</button>
              <button className="primary-btn" onClick={onClose} style={{ fontSize: 12 }}>Done</button>
            </div>
          </>
        )}

        {/* Enrolled phones */}
        <div style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Enrolled phones
          </div>
          {devices === null ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
            : devices.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No phones enrolled yet.</div>
            : devices.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <span style={{ flex: 1, fontSize: 12.5 }}>{d.name || d.email}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{d.lastSeen ? `seen ${d.lastSeen.slice(0, 10)}` : 'never seen'}</span>
                <button onClick={() => revoke(d.id)} title="Revoke"
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: '#b91c1c', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
                  <Ban size={12} /> Revoke
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
