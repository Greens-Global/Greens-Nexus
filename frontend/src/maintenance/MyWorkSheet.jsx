// My Work (Construction plan phase 5, Neil 11/03/2026): a technician's list
// on the phone, opened from Workday's My Work tile. The open tickets assigned
// to me and - for the maintenance team - my team's unassigned tickets at
// properties, preventive first by due date (GET /maintenance/my-work). One
// tap Start, one tap Done (FinishWork: the note by dictation, the checklist,
// the photo a preventive ticket needs), and Scan a Tag through the ONE Items
// scanner, which opens the place's sheet.
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ScanLine, Wrench } from 'lucide-react';
import { Modal } from '../tasks/components';
import { SkeletonBlocks } from '../components/AsyncState';
import { api } from '../api';
import { TicketLine } from './workUi';
import { openTicket, OVERDUE_COLOR } from './workLib';
import { openPlace } from './placeLink';
import SheetGuard from './SheetGuard';

const FinishWork = lazy(() => import('./FinishWork'));
const ScannerSheet = lazy(() => import('../inventory/scan/ScannerSheet'));
// An item tag scanned here opens the item in Items, as it would from there.
const openItem = (id) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'inventory', sub: `item/${id}` } }));

export default function MyWorkSheet({ onClose, initial = null }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [finishing, setFinishing] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(() => {
    api.getMyMaintenanceWork().then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e?.message || 'Nexus could not be reached.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  const start = async (row) => {
    setBusy(row.id); setNotice('');
    try { await api.startMaintenanceWork(row.id); load(); } catch (e) { setNotice(e?.message || 'That did not start.'); }
    setBusy('');
  };
  const rows = data?.tickets || [];
  return (
    <Modal title="My Work" onClose={onClose} zIndex={4200}
      footer={<button type="button" className="secondary-btn" onClick={() => setScanning(true)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 42 }}><ScanLine size={15} /> Scan a Tag</button>}>
      {!data && !error && <SkeletonBlocks count={4} height={64} borderRadius={10} />}
      {error && !data && <div style={{ fontSize: 13.5 }}>{error} <button type="button" className="secondary-btn" onClick={load}>Try Again</button></div>}
      {data && (
        <div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 6 }}>
            {rows.length === 0 ? 'Nothing open for you right now.' : `${rows.length} open${data.overdue ? ` · ${data.overdue} overdue` : ''}${data.preventive ? ` · ${data.preventive} preventive` : ''}`}
          </div>
          {notice && <div role="alert" style={{ color: OVERDUE_COLOR, fontSize: 13 }}>{notice}</div>}
          {rows.map((r) => {
            const steps = r.checklist || [];
            const done = steps.filter((s) => s.done).length;
            return (
              <TicketLine key={r.id} row={r} onOpen={() => { onClose(); openTicket(r.id); }}>
                {steps.length > 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)', alignSelf: 'center' }}>{done} of {steps.length} Steps</span>}
                {!r.mine && <span style={{ fontSize: 12.5, color: 'var(--muted)', alignSelf: 'center' }}>Unassigned</span>}
                {r.status !== 'in_progress' && data.canStart && (
                  <button type="button" className="secondary-btn" disabled={busy === r.id} onClick={() => start(r)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 42 }}>
                    <Wrench size={14} /> {busy === r.id ? 'Starting...' : 'Start'}
                  </button>
                )}
                {r.mine && (
                  <button type="button" className="primary-btn" onClick={() => setFinishing(r)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 42 }}>
                    <CheckCircle2 size={14} /> Done
                  </button>
                )}
              </TicketLine>
            );
          })}
        </div>
      )}
      {finishing && (
        <SheetGuard onClose={() => setFinishing(null)}>
          <Suspense fallback={null}>
            <FinishWork row={finishing} onClose={() => setFinishing(null)}
              onDone={() => { setFinishing(null); setNotice(''); load(); }} />
          </Suspense>
        </SheetGuard>
      )}
      {scanning && (
        <SheetGuard onClose={() => setScanning(false)}>
          <Suspense fallback={null}>
            <ScannerSheet items={[]} onClose={() => setScanning(false)}
              onFound={(it) => { setScanning(false); onClose(); openItem(it.id); }}
              onPlace={(p) => { setScanning(false); onClose(); openPlace(p.propertyId, p.assetId); }} />
          </Suspense>
        </SheetGuard>
      )}
    </Modal>
  );
}
