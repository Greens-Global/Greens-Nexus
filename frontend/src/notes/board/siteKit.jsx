// The Storage Site Kit on a Board (Neil, 11/10/2026): the Knowledge Base's
// line drawings (kb/components/drawings.jsx - the ONE illustration library:
// the fence, the gate, the buildings, units, roll-up doors, locks, the three
// shapes of space, RVs and boats) placed on a board as pictures. A drawing is
// drawn once to a PNG here and goes in as an ordinary board image, so it is
// stored in the private bucket like any pasted picture (Board's
// storeNewFiles) - never a data URL in the saved scene, never a second
// drawing set. The same drawing placed twice is one file (`kit-<name>`).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Drawing, { DRAWING_NAMES } from '../../kb/components/drawings';
import { Modal } from '../../tasks/components';
import { btn } from '../../tasks/theme';

// The drawings' theme tokens as the engine's light palette (dark mode inverts it like every board color).
const TOKENS = {
  '--kb-ink': '#1e1e1e', '--kb-dim': '#868e96', '--kb-line': '#ced4da', '--kb-paper': '#f8f9fa',
  '--kb-green-soft': '#d3f9d8', '--kb-green': '#2f9e44', '--kb-card': '#ffffff',
};
export const KIT_W = 200;
export const KIT_H = 110;

export const KIT_GROUPS = [
  { label: 'Site', names: ['facility-fence', 'facility-gate', 'building-drive-up', 'building-multi-story', 'plan-drive-in', 'plan-pull-through', 'plan-angled'] },
  { label: 'Units', names: ['unit-drive-up', 'unit-interior', 'unit-climate', 'unit-mesh-ceiling', 'door-roll-up'] },
  { label: 'Spaces', names: ['space-open', 'space-covered', 'space-enclosed', 'measure-length', 'measure-height'] },
  { label: 'Locks', names: ['hasp', 'hasp-overlock', 'lock-disc', 'lock-cylinder', 'lock-cylinder-core', 'lock-padlock'] },
  { label: 'Vehicles', names: DRAWING_NAMES.filter((n) => n.startsWith('rv-') || n.startsWith('boat-')) },
].map((g) => ({ ...g, names: g.names.filter((n) => DRAWING_NAMES.includes(n)) }));

const WORDS = { rv: 'RV', ahj: 'AHJ' };
/** 'plan-pull-through' -> 'Plan Pull Through'. */
export const kitLabel = (name) => name.split('-').map((w) => WORDS[w] || w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** A drawing's SVG markup with its theme tokens made literal (an image file has no CSS). */
export function kitSvg(name) {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<Drawing name={name} />));
  let svg = host.innerHTML;
  root.unmount();
  for (const [k, v] of Object.entries(TOKENS)) svg = svg.split(`var(${k})`).join(v);
  return svg.replace('<svg ', `<svg width="${KIT_W * 2}" height="${KIT_H * 2}" `);
}

/** A drawing as a PNG data URL, twice the size it is placed at. */
export function kitPng(name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = KIT_W * 2; c.height = KIT_H * 2;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('The drawing did not render'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(kitSvg(name))}`;
  });
}

/** The image element for a kit drawing (the file is added to the engine beside it). Plain JSON. */
export function kitImage({ name, x, y, now = Date.now() }) {
  const n = () => Math.floor(Math.random() * 0x7fffffff);
  return {
    id: `kit${n().toString(36)}${now.toString(36)}`, type: 'image', x, y, width: KIT_W, height: KIT_H, angle: 0,
    strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: n(), version: 1, versionNonce: n(),
    isDeleted: false, boundElements: null, updated: now, link: null, locked: false,
    fileId: `kit-${name}`, status: 'saved', scale: [1, 1], crop: null, customData: { nexusKit: name },
  };
}

export default function SiteKitSheet({ onPick, onClose }) {
  const [busy, setBusy] = useState('');
  const pick = async (name) => {
    if (busy) return;
    setBusy(name);
    try { await onPick(name); } finally { setBusy(''); }
  };
  return (
    <Modal title="Storage Site Kit" onClose={onClose} zIndex={4200}
      footer={<button type="button" onClick={onClose} style={btn('outline')}>Close</button>}>
      <div className="nx-kit nx-fill">
        <p className="nx-kit-hint">Click a drawing to put it on the board. Resize and label it like any picture.</p>
        {KIT_GROUPS.filter((g) => g.names.length).map((g) => (
          <section key={g.label} className="nx-kit-group">
            <h3>{g.label}</h3>
            <div className="nx-kit-grid">
              {g.names.map((name) => (
                <button key={name} type="button" className="nx-kit-item" onClick={() => pick(name)} disabled={!!busy} data-kit={name}>
                  <Drawing name={name} title={kitLabel(name)} />
                  <span>{busy === name ? 'Adding…' : kitLabel(name)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
