// What Each Hire Gets (Neil, Oct 22): one look at every company and kind of
// hire - the offer letter, hiring packet, promotion letter and separation
// package Nexus would send someone working at the company's own place - with
// what is missing set up from right here. The server asks the same picker a
// real hire uses (GET /hr/packets/coverage), so this never says something the
// send would not do.
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, MapPin } from 'lucide-react';
import { api } from '../api';
import { Spinner } from './AsyncState';
import { placeName } from '../lib/usStates';

const EVENTS = [
  ['offer', 'Offer Letter'], ['hire', 'Hiring Packet'], ['promotion', 'Promotion Letter'], ['separation', 'Separation Package'],
];
const WHO = { employee: 'Employees', contractor: 'Contractors' };
const COUNTRY_NAMES = { US: 'United States', IN: 'India', CA: 'Canada', GB: 'United Kingdom', AE: 'United Arab Emirates', PH: 'Philippines', MX: 'Mexico', AU: 'Australia' };

export default function PacketCoverage({ refreshKey, companyId, onSetUp, onOpen, toastErr }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  // A company that never hires one kind (GGCon: contractors only) says so once,
  // and its row stops calling missing paperwork a gap.
  async function setHired(entityId, workerType, hired) {
    try {
      const r = await api.setPacketHired(entityId, workerType, hired);
      setData(d => ({ ...d, companies: d.companies.map(c => c.id !== entityId ? c
        : { ...c, rows: c.rows.map(row => ({ ...row, notHired: (r.notHired || []).includes(row.workerType) })) }) }));
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
  }
  useEffect(() => {
    let alive = true;
    api.getPacketCoverage().then(d => alive && setData(d)).catch(e => alive && setErr(e?.message || 'Could not load.'));
    return () => { alive = false; };
  }, [refreshKey]);
  if (err) return <div style={{ fontSize: 13, color: 'hsl(var(--color-red))' }}>{err}</div>;
  if (!data) return <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}><Spinner size="section" /></div>;
  const companies = (data.companies || []).filter(c => !companyId || c.id === companyId);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
        What a new hire at each company gets, by where the company&apos;s people work. Someone hired to work in another state or country gets that place&apos;s documents.
      </div>
      {(data.unplaced || []).length > 0 && (
        <div role="status" style={{ border: '1px solid rgba(180,83,9,0.35)', background: 'rgba(180,83,9,0.07)', borderRadius: 12, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
          <b style={{ color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={13} /> No place set:</b>{' '}
          {data.unplaced.map((u, i) => (
            <span key={u.id}>{i ? ', ' : ''}<button type="button" onClick={() => onOpen?.(u)} style={linkBtn}>{u.name}</button></span>
          ))}
          {' '}would go to any country - open each and pick Works In.
        </div>
      )}
      {companies.map(c => {
        const where = placeName(c.country, c.region, COUNTRY_NAMES);
        return (
          <section key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'var(--mist)' }}>
              <b style={{ fontSize: 14 }}>{c.name}</b>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: where ? 'var(--muted)' : 'hsl(var(--color-orange))' }}>
                <MapPin size={12} /> {where || 'No country set - set it in Company Settings so Nexus knows which paperwork applies'}
              </span>
            </div>
            {c.rows.map(r => r.notHired ? (
              <div key={r.workerType} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--line)', alignItems: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                <span style={{ flex: '0 0 110px', fontWeight: 700 }}>{WHO[r.workerType]}</span>
                <span style={{ flex: 1 }}>{c.name} does not hire {WHO[r.workerType].toLowerCase()} - nothing to set up.</span>
                <button type="button" onClick={() => setHired(c.id, r.workerType, true)} style={linkBtn}>Undo</button>
              </div>
            ) : (
              <div key={r.workerType} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--line)', alignItems: 'stretch' }}>
                <div style={{ flex: '0 0 110px', fontSize: 13, fontWeight: 700, paddingTop: 6 }}>
                  {WHO[r.workerType]}
                  <button type="button" onClick={() => setHired(c.id, r.workerType, false)} title={`${c.name} never hires ${WHO[r.workerType].toLowerCase()}`}
                    style={{ ...linkBtn, display: 'block', fontSize: 11.5, fontWeight: 500, marginTop: 4, color: 'var(--muted)' }}>Not Hired Here</button>
                </div>
                {EVENTS.map(([key, label]) => {
                  const s = r[key];
                  const critical = !s && (key === 'offer' || key === 'hire');
                  return (
                    <div key={key} style={{ flex: '1 1 170px', minWidth: 0, border: `1px solid ${critical ? 'rgba(180,83,9,0.4)' : 'var(--line)'}`, borderRadius: 10, padding: '7px 10px', background: 'var(--card)' }}>
                      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>{label}</div>
                      {s ? (
                        <button type="button" onClick={() => onOpen?.({ ...s, event: key })} title={s.place}
                          style={{ ...linkBtn, display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, maxWidth: '100%', textAlign: 'left' }}>
                          <CheckCircle2 size={13} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                        </button>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12.5, color: critical ? '#b45309' : 'var(--muted)', fontWeight: critical ? 700 : 500 }}>Not Set Up</span>
                          <button type="button" className="secondary-btn" onClick={() => onSetUp?.({ event: key, workerType: r.workerType, country: c.country, region: c.region, companyId: '' })}
                            style={{ fontSize: 11.5, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <Plus size={11} /> Set Up
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', textDecoration: 'underline', textDecorationColor: 'var(--line)' };
