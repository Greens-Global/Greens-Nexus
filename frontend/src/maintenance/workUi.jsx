// The small pieces the field sheets share (Construction plan phase 5,
// 11/03/2026): a ticket line (StatusLabel, priority mark, due day and
// Overdue), the photo picker (camera or files, Ctrl+V on a computer, the
// private ticket-evidence bucket) and the dictation button (the browser's
// own speech recognition - no AI, no key; no microphone where there is none).
// Plain calls only, so the offline layer (feat/field-offline) can wrap them.
import { useEffect, useRef } from 'react';
import { Camera, Mic, MicOff, X } from 'lucide-react';
import { StatusLabel, PriorityMark } from '../components/StatusLabel';
import { TICKET_STATUS_META } from '../tickets/ticketMeta';
import { formatDate } from '../lib/datetime';
import { canDictate, useDictation, spokenAfter } from '../lib/voice';
import { useIsMobile } from '../lib/useIsMobile';
import { OVERDUE_COLOR } from './workLib';



export function TicketStatus({ status }) {
  const m = TICKET_STATUS_META[status] || TICKET_STATUS_META.open;
  return <StatusLabel label={m.label} color={m.color} size="sm" />;
}

/** "Due 12/01/2026", or the Overdue label when the day has passed. */
export function DueLabel({ row }) {
  if (!row.pmDueOn) return null;
  if (row.overdue) return <StatusLabel label={`Overdue · ${formatDate(row.pmDueOn)}`} color={OVERDUE_COLOR} size="sm" />;
  return <span style={{ fontSize: 13, color: 'var(--muted)' }}>Due {formatDate(row.pmDueOn)}</span>;
}

export function TicketLine({ row, children, onOpen }) {
  return (
    <div className="nx-pm-line" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', padding: '12px 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <button type="button" onClick={onOpen} disabled={!onOpen}
          style={{ all: 'unset', cursor: onOpen ? 'pointer' : 'default', display: 'block', maxWidth: '100%' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>{row.codeLabel}</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{row.subject}</span>
        </button>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <TicketStatus status={row.status} />
          {row.preventive && <StatusLabel label="Preventive" color="#0f766e" size="sm" />}
          <PriorityMark priority={row.priority} size={13} />
          <DueLabel row={row} />
          {(row.equipmentName || row.propertyName) && (
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{[row.propertyName, row.equipmentName, row.unit].filter(Boolean).join(' · ')}</span>
          )}
        </div>
      </div>
      {children && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

export function PhotoPicker({ state, label = 'Add a Photo', required = false }) {
  const ref = useRef(null);
  const isMobile = useIsMobile();
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {state.photos.map((p) => (
          <span key={p.url} style={{ position: 'relative', width: 64, height: 64, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--hover)' }}>
            <img src={p.url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => state.remove(p.url)}
              style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, borderRadius: 999, border: 'none', background: 'rgba(17,24,39,0.7)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
              <X size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="secondary-btn" onClick={() => ref.current?.click()} disabled={state.busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40 }}>
          <Camera size={15} /> {state.busy ? 'Uploading...' : label}{required ? ' (Required)' : ''}
        </button>
        <input ref={ref} type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { state.add(e.target.files); e.target.value = ''; }} />
      </div>
      {!isMobile && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Or press Ctrl+V to paste a photo.</div>}
      {state.error && <div role="alert" style={{ fontSize: 13, color: OVERDUE_COLOR, marginTop: 6 }}>{state.error}</div>}
    </div>
  );
}

/** A microphone beside a text box: the words land as they are spoken. */
export function DictateButton({ value, onChange }) {
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const d = useDictation((said) => {
    const before = valueRef.current || '';
    const next = before + spokenAfter(before, said);
    valueRef.current = next;
    onChange(next);
  });
  if (!canDictate()) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button type="button" className="secondary-btn" aria-pressed={d.listening} onClick={d.listening ? d.stop : d.start}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36 }}>
        {d.listening ? <MicOff size={14} /> : <Mic size={14} />} {d.listening ? 'Stop' : 'Dictate'}
      </button>
      {d.interim && <span style={{ fontSize: 13, color: 'var(--muted)' }}>{d.interim}</span>}
      {d.error && <span role="alert" style={{ fontSize: 13, color: OVERDUE_COLOR }}>{d.error}</span>}
    </span>
  );
}
