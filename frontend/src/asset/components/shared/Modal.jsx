import { Modal as NexusModal } from '../../../tasks/components.jsx';

/**
 * The module's modal is Nexus's shared Modal (tasks/components.jsx): 60vw wide,
 * at least 60vh tall, header and footer fixed with only the body scrolling, a
 * full-screen sheet on phones, Escape / overlay / X ask before discarding an
 * edit (`isDirty` + `onSave`). The old module card scrolled as a whole, so the
 * Save button left the screen on any form taller than the viewport. `wide`
 * bumps the width; `maxWidth` (px) overrides both.
 */
export function Modal({ title, children, footer, wide, maxWidth, onClose, isDirty = false, onSave }) {
  const width = maxWidth ? `min(94vw, ${maxWidth}px)` : wide ? 'clamp(680px, 68vw, 1100px)' : 'clamp(520px, 60vw, 980px)';
  return (
    <NexusModal title={title} onClose={onClose} footer={footer} width={width} minHeight="60vh" isDirty={isDirty} onSave={onSave}>
      {children}
    </NexusModal>
  );
}
