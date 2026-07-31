// Small "Export" dropdown shown in the asset-page header toolbar. Purely presentational - the
// actual CSV/PDF generation lives in ../../lib/csvExport.js; this component just renders the
// button + menu and wires the two callbacks.
//
// Usage (asset page toolbar):
//   <ExportMenu onPdf={() => exportAssetPdf(asset, store)} onCsv={() => exportAssetCsv(asset, store)} />

import { useState } from 'react';
import { Download } from 'lucide-react';

export function ExportMenu({ onPdf, onCsv }) {
  const [open, setOpen] = useState(false);

  const options = [
    ['PDF', onPdf],
    ['CSV', onCsv],
  ];

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="secondary-btn"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Download size={14} /> Export <span style={{ fontSize: '0.62rem', opacity: 0.7 }}>▼</span>
      </button>

      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            zIndex: 200,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            overflow: 'hidden',
            minWidth: 158,
          }}
        >
          {options.map(([label, fn]) => (
            <button
              key={label}
              onClick={() => { setOpen(false); fn && fn(); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '9px 14px',
                border: 'none',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                fontSize: '0.82rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
              }}
            >
              Export as {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
