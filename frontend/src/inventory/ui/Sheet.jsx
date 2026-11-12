// Item Management - Popups (Items redesign, Neil 11/02/2026).
//
// CLAUDE.md "Popups are sheets from the right": every Items popup that is a
// record, a form or a workspace is a SHEET (the shared Modal in
// tasks/components.jsx - docked right, full height, the 60% rule, the slide,
// the sheet stack, the phone's bottom sheet), and a QUESTION (Reject, Delete,
// Force Return) is the centered card. Both go through here so the Items
// screens never hand-roll a fixed overlay again.
//
// Stacking: the item record is z 4000; anything opened from a screen or the
// record sits above it at 4100 and a question at 4200, so the newest is
// always on top and the sheet beneath recedes (lib/sheetStack.js).
import { Modal } from '../../tasks/components';

export const Z_RECORD = 4000;
export const Z_SHEET = 4100;
export const Z_QUESTION = 4200;

// `addressed`: the address opens this sheet (the item record) - Back is the
// address's, so the sheet adds no Back entry of its own (Modal backToClose).
export function ItemSheet({ title, onClose, children, footer, isDirty = false, onSave, width, zIndex = Z_SHEET, addressed = false }) {
  return (
    <Modal title={title} onClose={onClose} footer={footer} isDirty={isDirty} onSave={onSave}
      width={width} placement="sheet" zIndex={zIndex} backToClose={!addressed}>
      {children}
    </Modal>
  );
}

export function ItemQuestion({ title, onClose, children, footer, isDirty = false, zIndex = Z_QUESTION }) {
  return (
    <Modal title={title} onClose={onClose} footer={footer} isDirty={isDirty}
      placement="center" minHeight={0} width={420} zIndex={zIndex}>
      {children}
    </Modal>
  );
}

// Field label: 12px, normal case (DESIGN.md: no uppercase tracking).
export const LABEL = { fontSize: 13, fontWeight: 600, color: 'var(--wk-dim, var(--muted))', display: 'block', marginBottom: 6 };
export const HINT = { fontSize: 12, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.45 };
export const ERROR = { fontSize: 13, color: 'var(--bad-fg)', margin: '10px 0 0' };
