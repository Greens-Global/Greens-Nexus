import { useState } from 'react';
import { Copy } from 'lucide-react';

/** Small icon button that copies `text` to the clipboard, briefly showing "Copied" feedback. */
export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard && navigator.clipboard.writeText(text || '');
    } catch (err) {
      // clipboard API unavailable/denied — ignore
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  };

  return (
    <button
      title="Copy address"
      onClick={handleClick}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        padding: '2px 4px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: copied ? 'hsl(var(--color-green))' : 'var(--text-secondary)',
        borderRadius: 6,
      }}
    >
      {copied ? <span style={{ fontSize: '0.72rem', fontWeight: 600 }}>Copied</span> : <Copy size={14} />}
    </button>
  );
}
