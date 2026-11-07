// New From Template (Neil, 11/06/2026): what a new note starts from - the
// person's own notes marked Use as Template above the built-in starters
// (noteTemplates.js). A question, so the shared Modal stays a centered card
// on a desktop (placement="center"), like New Board's picker.
import { useEffect, useState } from 'react';
import { LayoutTemplate, Users, UserRound, HardHat, ArrowRightLeft, TriangleAlert, CalendarCheck, StickyNote } from 'lucide-react';
import { Modal } from '../tasks/components';
import { api } from '../api';
import { NOTE_TEMPLATES } from './noteTemplates';

const ICONS = { meeting: Users, 'one-on-one': UserRound, 'site-walk': HardHat, handover: ArrowRightLeft, incident: TriangleAlert, weekly: CalendarCheck };

export default function NoteTemplatePicker({ onPick, onPickNote, onClose, busy = false }) {
  const [mine, setMine] = useState([]);
  useEffect(() => {
    let alive = true;
    api.notesList({ view: 'templates' })
      .then((r) => { if (alive) setMine((r?.notes || []).filter((n) => n.kind === 'note')); })
      .catch(() => { /* the starters still show */ });
    return () => { alive = false; };
  }, []);
  return (
    <Modal title="New From Template" onClose={onClose} placement="center" width="560px" minHeight="0">
      {mine.length > 0 && (<>
        <div className="nt-tpl-kicker">Your Templates</div>
        <div className="nt-tpl-grid" role="group" aria-label="Your Templates" style={{ marginBottom: 16 }}>
          {mine.map((n) => (
            <button key={n.id} type="button" className="nt-tpl" disabled={busy} onClick={() => onPickNote(n)} aria-label={`${n.title || 'Untitled Note'} - your template`}>
              <StickyNote size={22} aria-hidden="true" />
              <span className="nt-tpl-label">{n.title || 'Untitled Note'}</span>
              {n.preview && <span className="nt-tpl-sub">{n.preview.slice(0, 60)}</span>}
            </button>
          ))}
        </div>
      </>)}
      <p className="nt-tpl-hint">
        Start from a layout. Everything in it can be changed. To make your own, open a note and pick Use as Template from its More menu.
      </p>
      <div className="nt-tpl-grid" role="group" aria-label="Templates">
        {NOTE_TEMPLATES.map((t) => {
          const Icon = ICONS[t.key] || LayoutTemplate;
          return (
            <button key={t.key} type="button" className="nt-tpl" disabled={busy} onClick={() => onPick(t.key)} aria-label={`${t.label} - ${t.hint}`}>
              <Icon size={22} aria-hidden="true" />
              <span className="nt-tpl-label">{t.label}</span>
              <span className="nt-tpl-sub">{t.hint}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
