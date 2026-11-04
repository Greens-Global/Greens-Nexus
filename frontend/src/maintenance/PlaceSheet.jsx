// Scan to Request (Construction plan phase 5, Neil 11/03/2026): what a site
// or equipment QR tag opens - /tickets/place/<property>[/<asset>]. The open
// tickets there (a summary only for one the person cannot open), Report a
// Problem (ONE ticket through the desk's own intake: the property and the
// equipment set, the topic from the property's areas, photos with Ctrl+V on
// a computer), and Start Work for the maintenance team. A place the person
// may not see is the access-denied state, never a blank sheet.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Lock, Plus, Wrench } from 'lucide-react';
import { Modal } from '../tasks/components';
import { SkeletonBlocks } from '../components/AsyncState';
import { api } from '../api';
import { ticketNo } from '../tickets/ticketMeta';
import { TicketLine, PhotoPicker, DictateButton } from './workUi';
import { usePhotos, openTicket, field, box, OVERDUE_COLOR } from './workLib';

function NoAccess({ onClose }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '48px 16px', textAlign: 'center' }}>
      <span style={{ width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--hover)' }}><Lock size={22} /></span>
      <div style={{ fontSize: 16, fontWeight: 700 }}>You Do Not Have Access to This Place</div>
      <div style={{ fontSize: 13.5, color: 'var(--muted)', maxWidth: 360 }}>This tag belongs to a property you cannot see in Nexus. Ask your manager if you should have access.</div>
      <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
    </div>
  );
}

function ReportForm({ data, onCancel, onFiled }) {
  const [topic, setTopic] = useState(data.topics.length === 1 ? data.topics[0].topic : '');
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const units = data.units?.units || [];
  const [unit, setUnit] = useState('Common Area');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const photos = usePhotos('scan');
  const areas = useMemo(() => {
    const out = {};
    for (const t of data.topics) (out[t.areaLabel] ||= []).push(t);
    return out;
  }, [data.topics]);
  const ready = topic && subject.trim() && !photos.busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setErr('');
    try {
      const made = await api.reportPlaceProblem(data.property.id, {
        topic, subject: subject.trim(), description: details, unit, asset_id: data.asset?.id || '',
        photos: photos.photos.map((p) => p.url),
      });
      onFiled(made);
    } catch (e) { setErr(e?.message || 'That did not send - try again.'); setBusy(false); }
  };
  if (!data.topics.length) {
    return <div style={{ fontSize: 13.5, color: 'var(--muted)', padding: '12px 0' }}>Problems here are not reported through Nexus for your company yet. Tell your manager.</div>;
  }
  return (
    <div onPaste={photos.onPaste} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label style={field}>What Is Wrong
        <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} style={box}
          placeholder={data.asset ? `${data.asset.name} will not start` : 'Gate will not close'} autoFocus />
      </label>
      <label style={field}>About
        <select value={topic} onChange={(e) => setTopic(e.target.value)} style={box}>
          <option value="">Pick One</option>
          {Object.entries(areas).map(([label, list]) => (
            <optgroup key={label} label={label}>{list.map((t) => <option key={t.topic} value={t.topic}>{t.topic}</option>)}</optgroup>
          ))}
        </select>
      </label>
      {units.length > 0 && (
        <label style={field}>Where
          <select value={unit} onChange={(e) => setUnit(e.target.value)} style={box}>
            <option value="Common Area">Common Area</option>
            {units.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
      )}
      <label style={field}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>Details <DictateButton value={details} onChange={setDetails} /></span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} style={box} placeholder="What you saw, and when." />
      </label>
      <div style={field}>Photos<PhotoPicker state={photos} /></div>
      {err && <div role="alert" style={{ color: OVERDUE_COLOR, fontSize: 13 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-btn" onClick={submit} disabled={!ready || busy}>{busy ? 'Sending...' : 'Send Report'}</button>
      </div>
    </div>
  );
}

export default function PlaceSheet({ propertyId, assetId = '', onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [reporting, setReporting] = useState(false);
  const [filed, setFiled] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    let live = true;
    api.getMaintenancePlace(propertyId, assetId)
      .then((data) => { if (live) setState({ status: 'ok', data }); })
      .catch((e) => { if (live) setState({ status: e?.status === 404 ? 'denied' : 'error', message: e?.message }); });
    return () => { live = false; };
  }, [propertyId, assetId]);
  useEffect(() => load(), [load]);
  const data = state.data;
  const title = data ? (data.asset ? data.asset.name : data.property.name) : 'Scanned Tag';
  const start = async (row) => {
    setBusy(row.id); setErr('');
    try { await api.startMaintenanceWork(row.id); load(); } catch (e) { setErr(e?.message || 'That did not start - try again.'); }
    setBusy('');
  };
  return (
    <Modal title={title} onClose={onClose} isDirty={reporting} zIndex={4300}>
      {state.status === 'loading' && <SkeletonBlocks count={3} height={64} borderRadius={10} />}
      {state.status === 'denied' && <NoAccess onClose={onClose} />}
      {state.status === 'error' && (
        <div style={{ padding: '24px 0', fontSize: 13.5 }}>
          Nexus could not be reached. <button type="button" className="secondary-btn" onClick={() => { setState({ status: 'loading' }); load(); }}>Try Again</button>
        </div>
      )}
      {state.status === 'ok' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>
            {data.asset ? `${data.asset.kind === 'vehicle' ? 'Vehicle' : 'Equipment'} at ${data.property.name}` : data.property.city || 'Property'}
          </div>
          {filed && <div role="status" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--hover)', fontSize: 13.5 }}>Sent - {ticketNo(filed.code) || 'your ticket'} is with the team. You will hear back on it.</div>}
          {reporting ? (
            <ReportForm data={data} onCancel={() => setReporting(false)}
              onFiled={(made) => { setReporting(false); setFiled(made); load(); }} />
          ) : (
            <button type="button" className="primary-btn" onClick={() => { setFiled(null); setReporting(true); }}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46, fontSize: 15 }}>
              <Plus size={16} /> Report a Problem
            </button>
          )}
          <section aria-label="Open Tickets">
            <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'none', marginBottom: 2 }}>
              Open Tickets{data.tickets.length ? ` (${data.tickets.length})` : ''}
            </div>
            {err && <div role="alert" style={{ color: OVERDUE_COLOR, fontSize: 13 }}>{err}</div>}
            {data.tickets.length === 0
              ? <div style={{ fontSize: 13.5, color: 'var(--muted)', padding: '10px 0' }}>Nothing open here.</div>
              : data.tickets.map((r) => (
                <TicketLine key={r.id} row={r} onOpen={r.canOpen ? () => { onClose(); openTicket(r.id); } : null}>
                  {data.canStart && r.canOpen && r.status !== 'in_progress' && (
                    <button type="button" className="secondary-btn" disabled={busy === r.id} onClick={() => start(r)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40 }}>
                      <Wrench size={14} /> {busy === r.id ? 'Starting...' : 'Start Work'}
                    </button>
                  )}
                </TicketLine>
              ))}
          </section>
        </div>
      )}
    </Modal>
  );
}
