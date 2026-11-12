// Crisis support card (11/02/2026, the legal compliance pass). Shown when a
// message typed to an assistant, Ask HR or a ticket expresses suicidal intent
// or self-harm (lib/crisisSupport.js). A calm, centered card - a question,
// not a sheet - that the person acknowledges with one button; the message
// they wrote still goes where it was going. Nothing about the card is stored
// or sent to anyone.
import { useEffect, useRef, useState } from 'react';
import { HeartHandshake, Phone } from 'lucide-react';
import { CRISIS_MESSAGE, CRISIS_TITLE, crisisResources, __setCrisisHost } from '../lib/crisisSupport';

let _country = '';
// The signed-in person's country (US / IN), set once by the app shell when it
// is known; the card shows both lists until then.
export function setCrisisCountry(c) { _country = String(c || ''); }

const LINK = { color: 'hsl(var(--color-green, 152 60% 30%))', fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 2 };

export function CrisisSupportCard({ country, resources, title = CRISIS_TITLE, message = CRISIS_MESSAGE, onDone }) {
  const btn = useRef(null);
  useEffect(() => { btn.current?.focus(); }, []);
  const blocks = resources?.length ? resources : crisisResources(country);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(15,23,42,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="crisis-title" aria-describedby="crisis-body"
        style={{ background: 'var(--card, #fff)', color: 'var(--ink, #111827)', border: '1px solid var(--line, #e5e7eb)',
          borderRadius: 16, width: 'min(520px, 100%)', maxHeight: '90dvh', overflowY: 'auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)', padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <HeartHandshake size={22} style={{ color: 'hsl(var(--color-green, 152 60% 30%))', flexShrink: 0 }} aria-hidden="true" />
          <h2 id="crisis-title" style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{title}</h2>
        </div>
        <p id="crisis-body" style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6 }}>{message}</p>
        {blocks.map((b) => (
          <div key={b.country} style={{ border: '1px solid var(--line, #e5e7eb)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
            {blocks.length > 1 && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted, #6b7280)', marginBottom: 4 }}>{b.label}</div>}
            {b.lines.map((l) => (
              <div key={l.name} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{l.name}</div>
                <div style={{ fontSize: 13, color: 'var(--muted, #6b7280)', marginBottom: 4 }}>{l.detail}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13 }}>
                  {l.links.map((k) => (
                    <a key={k.href} href={k.href} style={LINK}
                      {...(k.href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{k.label}</a>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginTop: 4 }}>
              <Phone size={13} aria-hidden="true" />
              <span>In immediate danger? Call <a href={b.emergency.href} style={LINK}>{b.emergency.number}</a>.</span>
            </div>
          </div>
        ))}
        <p style={{ margin: '4px 0 16px', fontSize: 13, color: 'var(--muted, #6b7280)', lineHeight: 1.5 }}>
          This notice is not recorded or shared with anyone. Your message is sent as usual.
        </p>
        <button ref={btn} type="button" className="primary-btn" onClick={() => onDone?.()}
          style={{ fontSize: 14, padding: '10px 22px' }}>
          I Understand
        </button>
      </div>
    </div>
  );
}

// Mounted once at the app root (main.jsx, beside DialogHost). Shows one card
// at a time; showCrisisSupport() resolves when the person acknowledges it.
export default function CrisisSupportHost() {
  const [item, setItem] = useState(null);
  const open = useRef(null);
  useEffect(() => {
    __setCrisisHost((o) => {
      // A second card while one is open: the first send was acknowledged
      // by the card that replaces it - resolve it, never leave it hanging.
      const prev = open.current;
      open.current = o;
      setItem(o);
      prev?.onDone?.();
    });
    return () => {
      __setCrisisHost(null);
      const prev = open.current;
      open.current = null;
      prev?.onDone?.();
    };
  }, []);
  if (!item) return null;
  const done = () => { const fn = item.onDone; open.current = null; setItem(null); fn?.(); };
  return <CrisisSupportCard country={item.country ?? _country} resources={item.resources}
    title={item.title} message={item.message} onDone={done} />;
}
