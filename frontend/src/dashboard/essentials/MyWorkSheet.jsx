// My Work, the whole list (Neil, 11/13/2026) - what View All on the tile
// opens: every row GET /me/work returned (each due group holds up to 50,
// with its real count in the header), the same kind chips and the same rows
// as the tile, in a sheet from the right. The tile owns the data, the chip
// and Complete, so the two never show different lists; this file only lays
// the full list out. Its own lazy chunk: it brings the shared Modal.
import { ArrowRight } from 'lucide-react';

import { Modal } from '../../tasks/components.jsx';
import { FS } from '../../lib/typeScale';
import { navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';
import { WorkRow, WorkChips } from './MyWork.jsx';
import { rowKey, pickRows, chipsFor, workSub, errorLine } from './myWorkModel';

const ALL_ROWS = 100000;   // no cap: every row the server sent
const sectionStyle = { fontSize: FS.meta, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '14px 8px 4px', display: 'flex', justifyContent: 'space-between' };

export default function MyWorkSheet({ data, only, onOnly, busy, mobile, onOpen, onComplete, onClose }) {
  const chips = chipsFor(data);
  const sections = pickRows(data, ALL_ROWS, only);
  const total = data?.counts?.total ?? 0;
  const failed = errorLine(data?.errors);
  const footer = (
    <button type="button" className="secondary-btn" onClick={() => { onClose(); navigate('tasks', 'mine'); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      Open My Tasks <ArrowRight size={13} />
    </button>
  );
  return (
    <Modal title="My Work" onClose={onClose} footer={footer} width="60vw">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ fontSize: FS.body, color: 'var(--muted)', padding: '0 8px' }}>
          {total ? workSub(total, data?.sources) : 'Nothing is waiting on you.'}
        </div>
        <WorkChips chips={chips} value={only} onChange={onOnly} mobile={mobile} />
        {failed && <div role="status" style={{ ...noteStyle, padding: '4px 8px', textAlign: 'left', color: 'hsl(var(--color-red))' }}>{failed}</div>}
        <div className="nx-fill" style={{ overflowY: 'auto', minHeight: 0 }}>
          {!sections.length && <div style={noteStyle}>{only === 'all' ? 'Nothing is waiting on you.' : 'Nothing of this kind is waiting on you.'}</div>}
          {sections.map((s) => (
            <div key={s.key}>
              <div style={sectionStyle}>
                <span>{s.label}</span>
                <span>{s.count > s.items.length ? `${s.items.length} of ${s.count}` : s.count}</span>
              </div>
              {s.items.map((it) => (
                <WorkRow key={rowKey(it)} it={it} overdue={s.key === 'overdue'} mobile={mobile}
                  busy={busy.has(rowKey(it))} onOpen={onOpen} onComplete={onComplete} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
