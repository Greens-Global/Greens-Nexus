import { useState } from 'react';
import { X, Mail } from 'lucide-react';
import EmailSettingsPanel from '../tasks/MyEmailSettings';

// "Email Settings" (header dropdown, between My Profile and What's New) - each
// person's own task email preferences. Same shell as MyProfileModal so the two
// read as siblings. The "Email Settings" link in every task email opens this
// (TopHeader reads ?emailSettings=1).
export default function EmailSettingsModal({ onClose }) {
  // The settings API answers 403 for an account with no Task module access -
  // say so plainly instead of showing controls that cannot be saved.
  const [unavailable, setUnavailable] = useState(false);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div role="dialog" aria-label="Email Settings"
        style={{ background: 'var(--card)', borderRadius: 14, width: '52vw', minWidth: 420, maxWidth: '94vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>
            <Mail size={15} /> Email Settings
          </span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '14px 18px 18px', fontFamily: 'Inter, sans-serif' }}>
          {unavailable ? (
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
              Task email settings aren&apos;t available for your account because you don&apos;t have access to the Tasks module.
            </p>
          ) : (
            <EmailSettingsPanel onUnavailable={() => setUnavailable(true)} />
          )}
        </div>
      </div>
    </div>
  );
}
