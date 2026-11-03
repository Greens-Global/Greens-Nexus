// Item Management - Full-size photo viewer.
// Above every sheet, and Escape closes only it (the shared escape layer),
// never the sheet beneath it too (Items redesign, 11/02/2026).
import { X } from 'lucide-react';
import { useEscapeLayer } from '../../tasks/components';

export function ImageLightbox({ src, alt, onClose }) {
  useEscapeLayer(() => onClose());
  return (
    <div role="dialog" aria-modal="true" aria-label={alt || 'Photo'}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 4600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <img src={src} alt={alt || 'Photo'} style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10, boxShadow: '0 20px 80px rgba(0,0,0,0.5)' }} />
      <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 20, right: 24, background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8, padding: 8, color: '#fff', cursor: 'pointer', display: 'flex' }}>
        <X size={20} />
      </button>
    </div>
  );
}
