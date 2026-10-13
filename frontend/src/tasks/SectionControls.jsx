// The Custom grouping's controls (Oct 13 2026): "+ Add Section" under the
// list, and Rename / Delete on a section's header. `sec` is a
// useCustomSections() result - see customSections.js.
import { useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import AnchoredMenu from '../components/AnchoredMenu';
import { dialog } from '../ui/dialog';
import { NX, FONT, btn } from './theme';

async function promptNewSection(sec) {
  const name = await dialog.prompt(
    sec.personal ? 'Name the section. It is yours - it only organizes your My Tasks.' : 'Name the section. Everyone on this project sees it.',
    { title: 'Add Section', confirmText: 'Add Section', placeholder: 'e.g. Annual Recurring', required: true },
  );
  if (name && name.trim()) await sec.add(name);
}

export function AddSectionButton({ sec, style }) {
  return (
    <button type="button" onClick={() => promptNewSection(sec).catch((e) => alert(e?.message || 'Could not add the section.'))}
      style={{ ...btn('ghost'), gap: 6, color: NX.dim, fontSize: 13, ...style }}>
      <Plus size={14} /> Add Section
    </button>
  );
}

/** The "..." on a section header. Nothing for "No Section", which is where
 *  unfiled tasks live and cannot be renamed or removed. */
export function SectionMenu({ sec, group }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  if (!group?.sectionId) return null;
  const rename = async () => {
    setOpen(false);
    const name = await dialog.prompt('Section name', { title: 'Rename Section', confirmText: 'Rename', defaultValue: group.label, required: true });
    if (name && name.trim() && name.trim() !== group.label) await sec.rename(group.sectionId, name).catch((e) => alert(e?.message || 'Could not rename the section.'));
  };
  const remove = async () => {
    setOpen(false);
    const n = group.tasks.length;
    const ok = await dialog.confirm(
      n ? `Delete "${group.label}"? Its ${n} task${n === 1 ? '' : 's'} move to No Section - no task is deleted.` : `Delete "${group.label}"?`,
      { title: 'Delete Section', confirmText: 'Delete Section', danger: true },
    );
    if (ok) await sec.remove(group.sectionId).catch((e) => alert(e?.message || 'Could not delete the section.'));
  };
  const item = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: NX.ink, fontFamily: FONT, textAlign: 'left' };
  return (
    <span ref={ref} style={{ display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={`Section options for ${group.label}`} title="Section Options"
        onClick={() => setOpen((o) => !o)} style={{ ...btn('ghost'), padding: 3, color: NX.faint }}>
        <MoreHorizontal size={15} />
      </button>
      <AnchoredMenu anchorRef={ref} open={open} onClose={() => setOpen(false)}
        style={{ width: 180, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 4 }}>
        <button type="button" className="nx-menu-row" onClick={rename} style={item}><Pencil size={14} style={{ color: NX.dim }} />Rename Section</button>
        <button type="button" className="nx-menu-row" onClick={remove} style={{ ...item, color: NX.red }}><Trash2 size={14} />Delete Section</button>
      </AnchoredMenu>
    </span>
  );
}
