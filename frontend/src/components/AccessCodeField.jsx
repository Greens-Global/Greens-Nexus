import { useState } from 'react';
import { RefreshCw, Copy, Check } from 'lucide-react';

// The access code an external signer must enter to open their link - with a
// generator, a copy button, and the option to text it to them (Sagar, Sep 21).
//
// The code is the SECOND factor on top of the emailed link, which is what lets
// the signing certificate say "plus an out-of-band access code"
// (services/certificate.py). So it is texted or shared by hand, never emailed:
// a code sent to the same inbox as the link is not a second channel, and the
// certificate would be claiming protection that did not exist.
//
// Ambiguous characters are left out of the alphabet - a code read off a screen
// and typed on a phone must not turn on whether that was a 0 or an O.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1

export function generateAccessCode(groups = 2, size = 4) {
  const bytes = new Uint8Array(groups * size);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return Array.from({ length: groups }, (_, g) => chars.slice(g * size, (g + 1) * size).join(''))
    .join('-');
}

/** "+1 555 0142" -> "••• 0142" - enough to recognize the number, not enough to
 *  hand it to someone reading over a shoulder. */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : 'their mobile';
}

const iconBtn = {
  position: 'absolute', top: '50%', transform: 'translateY(-50%)',
  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
  color: 'var(--muted)', display: 'flex', alignItems: 'center',
};

export default function AccessCodeField({ value = '', onChange, phone = '', codeSms = false,
                                          onCodeSmsChange, compact = false }) {
  const [copied, setCopied] = useState(false);
  const hasPhone = String(phone || '').replace(/\D/g, '').length >= 7;

  const generate = () => {
    onChange(generateAccessCode());
    // Generating one is the point at which "how does the signer get it?"
    // matters - so if a mobile is on file, texting it is the default answer.
    if (hasPhone) onCodeSmsChange?.(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked - the code is on screen to read anyway */ }
  };

  return (
    <div style={{ marginTop: compact ? 6 : 8 }}>
      <div style={{ position: 'relative' }}>
        <input className="form-input" maxLength={40} value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={compact ? 'Access code (optional)'
            : 'Access code (optional) - the link will ask for it'}
          style={{ width: '100%', fontSize: compact ? 11.5 : 12, paddingRight: value ? 58 : 34 }} />
        {value && (
          <button type="button" onClick={copy} title={copied ? 'Copied' : 'Copy the code'}
            aria-label="Copy access code" style={{ ...iconBtn, right: 30 }}>
            {copied ? <Check size={14} style={{ color: 'hsl(var(--color-green))' }} /> : <Copy size={14} />}
          </button>
        )}
        <button type="button" onClick={generate} title="Generate a random access code"
          aria-label="Generate access code" style={{ ...iconBtn, right: 6 }}>
          <RefreshCw size={14} />
        </button>
      </div>
      {value && (hasPhone ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!codeSms} onChange={(e) => onCodeSmsChange?.(e.target.checked)} />
          Text the code to {maskPhone(phone)} when sending
        </label>
      ) : (
        <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--muted)' }}>
          Add a mobile number above to text it, or copy it and share it yourself. It is never emailed - the link already goes to their inbox.
        </p>
      ))}
    </div>
  );
}
