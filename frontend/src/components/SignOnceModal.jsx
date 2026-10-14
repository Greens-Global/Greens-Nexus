// Signs Once (Oct 14): "HR just needs to sign one time on that template ...
// if a HR is changed for that company from company settings it again asks
// for sign" (Pranshu). The person who holds the step's role for the company
// adopts their signature once - the same signature pad and the same one-time
// code as every Nexus signature - and the packet applies it to every packet
// sent after this. The server checks who may (backend/hr_packet_docs.py).
import { useState } from 'react';
import { X, PenTool, Mail, CheckCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { SignaturePad } from './ESign';
import { Spinner } from './AsyncState';

const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '16px 0 6px', textTransform: 'uppercase', letterSpacing: '.04em' };

export default function SignOnceModal({ packetId, entityId = '', step, packetName, companyName, onClose, onDone, toastErr }) {
  const [sig, setSig] = useState(null);          // {kind, data} from the pad
  const [pad, setPad] = useState(false);
  const [sent, setSent] = useState(null);        // {masked, devCode?}
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function sendCode() {
    setBusy('code'); setError('');
    try {
      const out = await api.signOnceCode(packetId, { step: step.key, entity_id: entityId });
      setSent(out);
      if (out.devCode) setCode(out.devCode);     // local only - never on a deployed API
    } catch (e) { setError(e?.message || 'Could not send the code.'); }
    setBusy('');
  }
  async function sign() {
    setBusy('sign'); setError('');
    try {
      const status = await api.signOnce(packetId, {
        step: step.key, entity_id: entityId, consent: true,
        signature_kind: sig.kind === 'drawn' ? 'drawn' : 'typed', signature_data: sig.data, code: code.trim(),
      });
      onDone?.(status);
    } catch (e) {
      setError(e?.message || 'Could not sign.');
      toastErr?.(e?.message || 'Could not sign.');
    }
    setBusy('');
  }

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1380, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: 'min(94dvh, 820px)', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PenTool size={17} style={{ color: 'var(--pine)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15.5 }}>Sign Once - {packetName || 'Packet'}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{step.roleLabel}{companyName ? ` for ${companyName}` : ''}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', padding: '6px 22px 18px' }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, marginTop: 10 }}>
            Sign this packet once. Your signature then goes on every packet sent from it automatically - you are not asked again.
            If someone else becomes {step.roleLabel}, they sign once in your place.
          </div>

          <label style={lbl}>1. Your Signature</label>
          {sig ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <img src={sig.data} alt="Your signature" style={{ height: 56, maxWidth: 260, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)', borderRadius: 10, padding: '4px 10px' }} />
              <button type="button" className="secondary-btn" onClick={() => setPad(true)} style={{ fontSize: 12 }}>Change</button>
            </div>
          ) : (
            <button type="button" className="secondary-btn" onClick={() => setPad(true)} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <PenTool size={13} /> Adopt Your Signature
            </button>
          )}

          <label style={lbl}>2. Verify It's You</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="secondary-btn" onClick={sendCode} disabled={!!busy}
              style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {busy === 'code' ? <Spinner size={12} /> : <Mail size={13} />} {sent ? 'Send Another Code' : 'Email Me A Code'}
            </button>
            {sent && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sent to {sent.masked}</span>}
          </div>
          {sent && (
            <input className="form-input" style={{ width: 180, marginTop: 8, letterSpacing: '.2em', fontSize: 15 }} inputMode="numeric" maxLength={6}
              placeholder="6-digit code" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label="One-time code" />
          )}

          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12.5, marginTop: 16 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 2, accentColor: 'var(--pine)' }} />
            I agree to sign electronically, and that this signature is applied to every {packetName || 'packet'} sent{companyName ? ` for ${companyName}` : ''} until someone else holds {step.roleLabel}.
          </label>
          {error && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: 'hsla(var(--color-orange),0.1)', color: 'hsl(var(--color-orange))', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginTop: 10 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{error}</span>
            </div>
          )}
        </div>
        <div style={{ padding: '12px 22px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={sign} disabled={!!busy || !sig || code.length !== 6 || !agree}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {busy === 'sign' ? <Spinner size={13} /> : <CheckCircle size={13} />} Sign Once
          </button>
        </div>
      </div>
      {pad && <SignaturePad name={step.name || ''} onClose={() => setPad(false)} onAdopt={s => { setSig(s); setPad(false); }} />}
    </div>
  );
}
