import { useState } from 'react';
import { normLabel } from '../../lib/format.js';

const INPUT_STYLE = {
  width: '100%',
  padding: '6px 9px',
  fontSize: '0.8rem',
  border: '1px solid var(--border-color)',
  borderRadius: 7,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  marginTop: 6,
  boxSizing: 'border-box',
};

const ACTION_LINK_STYLE = {
  flex: 1,
  textAlign: 'center',
  padding: '7px 10px',
  borderRadius: 8,
  fontSize: '0.78rem',
  fontWeight: 600,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  border: '1px solid var(--border-color)',
};

/** Contact name that expands into an editable popover with email/phone (mailto/tel quick actions).
 *  `contacts` is a map keyed by `normLabel(fieldLabel)` -> {email, phone}. Used by Project Team fields. */
export function ContactCell({ name, label, contacts, onSave }) {
  const current = (contacts && contacts[normLabel(label)]) || {};
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(current.email || '');
  const [phone, setPhone] = useState(current.phone || '');

  const handleSave = () => {
    onSave && onSave(label, { email: email.trim(), phone: phone.trim() });
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Contact details"
        style={{
          border: 'none',
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          fontSize: '0.85rem',
          fontWeight: 600,
          color: 'hsl(var(--color-blue))',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          textAlign: 'left',
        }}
      >
        {name}
        <span style={{ fontSize: '0.58rem', opacity: 0.65 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          style={{
            marginTop: 8,
            width: 280,
            maxWidth: '100%',
            padding: 13,
            border: '1px solid var(--border-color)',
            borderRadius: 11,
            background: 'var(--bg-card)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: 1 }}>{name}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', fontWeight: 700 }}>
            {label}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
            <a
              href={email ? `mailto:${email}` : undefined}
              className="secondary-btn"
              style={{ ...ACTION_LINK_STYLE, opacity: email ? 1 : 0.4, pointerEvents: email ? 'auto' : 'none', color: 'hsl(var(--color-blue))' }}
            >
              ✉ Email
            </a>
            <a
              href={phone ? `tel:${String(phone).replace(/[^0-9+]/g, '')}` : undefined}
              className="secondary-btn"
              style={{ ...ACTION_LINK_STYLE, opacity: phone ? 1 : 0.4, pointerEvents: phone ? 'auto' : 'none', color: 'hsl(var(--color-green))' }}
            >
              ✆ Call
            </a>
          </div>

          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" style={INPUT_STYLE} />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" style={INPUT_STYLE} />

          <div style={{ display: 'flex', gap: 8, marginTop: 11, justifyContent: 'flex-end' }}>
            <button className="secondary-btn" onClick={() => setOpen(false)} style={{ fontSize: '0.76rem', padding: '5px 13px' }}>
              Close
            </button>
            <button className="primary-btn" onClick={handleSave} style={{ fontSize: '0.76rem', padding: '5px 13px' }}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
