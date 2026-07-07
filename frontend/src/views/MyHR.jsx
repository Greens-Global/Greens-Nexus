import { useState, useEffect } from 'react';
import {
  User, Phone, Mail, Heart, Briefcase, Building2, CalendarDays, MapPin, Network,
  FileText, Download, CalendarOff, Plus, Loader2, Pencil, Check, X, BadgeCheck,
  Clock, Banknote,
} from 'lucide-react';
import { api } from '../api';

// My HR — employee self-service. Shows ONLY the signed-in person's own record:
// profile (with self-service contact edits), their sealed e-sign documents, and
// their leave (reuses the /timeclock/timeoff endpoints). The HR module remains
// the HR team's admin console; this screen is baseline for everyone.

const TIMEOFF_TYPES = [
  ['vacation', 'Vacation'], ['sick', 'Sick'], ['personal', 'Personal'],
  ['unpaid', 'Unpaid'], ['other', 'Other'],
];
const STATUS_META = {
  pending:   { label: 'Pending',   bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  approved:  { label: 'Approved',  bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
  rejected:  { label: 'Rejected',  bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))' },
  cancelled: { label: 'Cancelled', bg: 'var(--mist)',                    fg: 'var(--muted)' },
};

const fmtD = (iso) => iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

function Row({ Icon, label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <Icon size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--muted)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5, color: 'var(--ink)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

export default function MyHR() {
  const [profile, setProfile] = useState(null);
  const [profErr, setProfErr] = useState('');
  const [docs, setDocs] = useState([]);
  const [leave, setLeave] = useState([]);
  const [sheet, setSheet] = useState(null);       // { days: { date: {...} } }
  const [stubs, setStubs] = useState([]);
  const [stubBusy, setStubBusy] = useState({});
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [dlBusy, setDlBusy] = useState({});
  const [loForm, setLoForm] = useState({ type: 'vacation', start_date: '', end_date: '', note: '' });
  const [loOpen, setLoOpen] = useState(false);
  const [loBusy, setLoBusy] = useState(false);

  const flash = (t, ok = true) => { setToast({ t, ok }); setTimeout(() => setToast(null), 4000); };

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(e => setProfErr(e?.message || 'Could not load your profile'));
    api.myHrDocs().then(setDocs).catch(() => {});
    api.timeOffMine().then(setLeave).catch(() => {});
    api.myPaystubs().then(setStubs).catch(() => {});
    const end = new Date();
    const start = new Date(end.getTime() - 13 * 86400000);
    const d = (x) => x.toISOString().slice(0, 10);
    api.timeMy(d(start), d(end)).then(setSheet).catch(() => setSheet({ days: {} }));
  }, []);

  const startEdit = () => {
    const em = profile?.personal?.emergency || {};
    setForm({
      personal_email: profile?.personalEmail || '', phone: profile?.phone || '',
      emergency_name: em.name || '', emergency_relationship: em.relationship || '', emergency_phone: em.phone || '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const updated = await api.myHrProfileSave(form);
      setProfile(updated);
      setEditing(false);
      flash('Profile updated');
    } catch (e) { flash(e?.message || 'Could not save', false); }
    finally { setSaving(false); }
  };

  const download = async (rid) => {
    setDlBusy(p => ({ ...p, [rid]: true }));
    try {
      const { url } = await api.myHrDocDownload(rid);
      window.open(url, '_blank', 'noopener');
    } catch (e) { flash(e?.message || 'Could not download', false); }
    finally { setDlBusy(p => ({ ...p, [rid]: false })); }
  };

  const downloadStub = async (id) => {
    setStubBusy(p => ({ ...p, [id]: true }));
    try {
      const { url } = await api.myPaystubDownload(id);
      window.open(url, '_blank', 'noopener');
    } catch (e) { flash(e?.message || 'Could not download', false); }
    finally { setStubBusy(p => ({ ...p, [id]: false })); }
  };

  const submitLeave = async () => {
    if (!loForm.start_date || !loForm.end_date) return;
    setLoBusy(true);
    try {
      const created = await api.timeOffCreate(loForm);
      setLeave(l => [created, ...l]);
      setLoOpen(false);
      setLoForm({ type: 'vacation', start_date: '', end_date: '', note: '' });
      flash('Time-off request submitted');
    } catch (e) { flash(e?.message || 'Could not submit', false); }
    finally { setLoBusy(false); }
  };

  const em = profile?.personal?.emergency || {};
  const initials = profile ? `${(profile.firstName || ' ')[0]}${(profile.lastName || ' ')[0]}`.trim().toUpperCase() : '';
  const input = { width: '100%' };
  const lbl = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', margin: '10px 0 4px' };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out', maxWidth: 1060 }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>My HR</h2>
          <p>Your profile, documents and leave — only you see this</p>
        </div>
      </div>

      {toast && (
        <div style={{ padding: '9px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5, fontWeight: 600,
          background: toast.ok ? 'hsla(var(--color-green),0.1)' : 'rgba(220,38,38,0.08)',
          color: toast.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{toast.t}</div>
      )}

      {profErr ? (
        <div className="dash-card" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13.5, padding: 40 }}>{profErr}</div>
      ) : !profile ? (
        <div style={{ padding: '50px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* ── Profile ── */}
          <div className="dash-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              {profile.photoUrl
                ? <img src={profile.photoUrl} alt="" style={{ width: 54, height: 54, borderRadius: '50%', objectFit: 'cover' }} />
                : <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 18, color: 'var(--muted)' }}>{initials || <User size={22} />}</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--ink)' }}>{profile.firstName} {profile.lastName}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{[profile.jobTitle, profile.department].filter(Boolean).join(' · ')}</div>
              </div>
              {profile.status === 'active' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))' }}>
                  <BadgeCheck size={12} /> Active
                </span>
              )}
            </div>
            <Row Icon={Briefcase} label="Employee code" value={profile.employeeCode} />
            <Row Icon={Mail} label="Work email" value={profile.workEmail} />
            <Row Icon={CalendarDays} label="Start date" value={fmtD(profile.startDate)} />
            <Row Icon={Network} label="Reports to" value={profile.manager} />
            <Row Icon={MapPin} label="Location" value={profile.location} />
            <Row Icon={Building2} label="Employment" value={(profile.employmentType || '').replace('_', ' ')} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 2px' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>Contact & emergency</span>
              {!editing && (
                <button className="secondary-btn" onClick={startEdit} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
                  <Pencil size={12} /> Edit
                </button>
              )}
            </div>

            {!editing ? (
              <div>
                <Row Icon={Mail} label="Personal email" value={profile.personalEmail} />
                <Row Icon={Phone} label="Phone" value={profile.phone} />
                <Row Icon={Heart} label="Emergency contact" value={em.name ? [em.name, em.relationship && `(${em.relationship})`, em.phone].filter(Boolean).join(' · ') : ''} />
                {!profile.personalEmail && !profile.phone && !em.name && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>Nothing here yet — add your contact details so HR can reach you.</div>
                )}
              </div>
            ) : (
              <div>
                <label style={lbl}>Personal email</label>
                <input className="form-input" style={input} value={form.personal_email} onChange={e => setForm(f => ({ ...f, personal_email: e.target.value }))} />
                <label style={lbl}>Phone</label>
                <input className="form-input" style={input} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                <label style={lbl}>Emergency contact name</label>
                <input className="form-input" style={input} value={form.emergency_name} onChange={e => setForm(f => ({ ...f, emergency_name: e.target.value }))} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={lbl}>Relationship</label>
                    <input className="form-input" style={input} value={form.emergency_relationship} onChange={e => setForm(f => ({ ...f, emergency_relationship: e.target.value }))} />
                  </div>
                  <div>
                    <label style={lbl}>Their phone</label>
                    <input className="form-input" style={input} value={form.emergency_phone} onChange={e => setForm(f => ({ ...f, emergency_phone: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                  <button className="secondary-btn" onClick={() => setEditing(false)} disabled={saving}><X size={13} /> Cancel</button>
                  <button className="primary-btn" onClick={saveEdit} disabled={saving}>
                    {saving ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Saving…</> : <><Check size={13} /> Save</>}
                  </button>
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
                  Name, job, department or bank changes go through HR.
                </p>
              </div>
            )}
          </div>

          {/* ── My timesheet (last 14 days) ── */}
          <div className="dash-card">
            <div className="dash-card-head">
              <div>
                <div className="dash-card-title">My timesheet</div>
                <div className="dash-card-sub">Last 14 days — full detail lives in Time Clock</div>
              </div>
              <Clock size={15} style={{ color: 'var(--muted)' }} />
            </div>
            {!sheet ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>
            ) : (() => {
              const fmtT = (v) => !v ? '—' : (String(v).includes('T') ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : v);
              const hm = (min) => `${Math.floor((min || 0) / 60)}h ${String((min || 0) % 60).padStart(2, '0')}m`;
              const entries = Object.entries(sheet.days || {}).sort((a, b) => b[0].localeCompare(a[0]));
              const total = entries.reduce((s, [, d]) => s + (d.workedMin || 0), 0);
              if (!entries.length) return <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 0', textAlign: 'center' }}>No punches in the last two weeks.</div>;
              return (
                <div>
                  {entries.map(([date, d]) => (
                    <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', width: 108, flexShrink: 0 }}>
                        {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', flex: 1 }}>
                        {fmtT(d.firstIn)} → {fmtT(d.lastOut)}{d.breakMin ? ` · ${hm(d.breakMin)} break` : ''}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{hm(d.workedMin)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, fontSize: 12.5, fontWeight: 700 }}>
                    <span style={{ color: 'var(--muted)' }}>Total</span>
                    <span style={{ color: 'var(--ink)' }}>{hm(total)}</span>
                  </div>
                </div>
              );
            })()}
          </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* ── My documents ── */}
            <div className="dash-card">
              <div className="dash-card-head">
                <div>
                  <div className="dash-card-title">My documents</div>
                  <div className="dash-card-sub">Signed and sealed copies of everything you were part of</div>
                </div>
                <FileText size={15} style={{ color: 'var(--muted)' }} />
              </div>
              {docs.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '16px 0', textAlign: 'center' }}>No completed documents yet.</div>
              ) : docs.map(d => (
                <div key={d.requestId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                  <FileText size={15} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Completed {fmtD(d.completedAt?.slice(0, 10))}</div>
                  </div>
                  <button className="secondary-btn" onClick={() => download(d.requestId)} disabled={!!dlBusy[d.requestId]}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
                    {dlBusy[d.requestId] ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={12} />} PDF
                  </button>
                </div>
              ))}
            </div>

            {/* ── My paystubs ── */}
            <div className="dash-card">
              <div className="dash-card-head">
                <div>
                  <div className="dash-card-title">My paystubs</div>
                  <div className="dash-card-sub">Uploaded by HR each pay period</div>
                </div>
                <Banknote size={15} style={{ color: 'var(--muted)' }} />
              </div>
              {stubs.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '16px 0', textAlign: 'center' }}>No paystubs yet — they'll appear here when HR uploads them.</div>
              ) : stubs.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                  <Banknote size={15} style={{ color: 'hsl(var(--color-green))', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Added {fmtD(s.createdAt?.slice(0, 10))}</div>
                  </div>
                  <button className="secondary-btn" onClick={() => downloadStub(s.id)} disabled={!!stubBusy[s.id]}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>
                    {stubBusy[s.id] ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={12} />} PDF
                  </button>
                </div>
              ))}
            </div>

            {/* ── My leave ── */}
            <div className="dash-card">
              <div className="dash-card-head">
                <div>
                  <div className="dash-card-title">My leave</div>
                  <div className="dash-card-sub">Time-off requests and their status</div>
                </div>
                <button className="primary-btn" onClick={() => setLoOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '6px 12px' }}>
                  <Plus size={13} /> Request time off
                </button>
              </div>

              {loOpen && (
                <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 12, background: 'var(--mist)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={lbl}>Type</label>
                      <select className="form-input" style={input} value={loForm.type} onChange={e => setLoForm(f => ({ ...f, type: e.target.value }))}>
                        {TIMEOFF_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lbl}>From</label>
                      <input type="date" className="form-input" style={input} value={loForm.start_date} onChange={e => setLoForm(f => ({ ...f, start_date: e.target.value }))} />
                    </div>
                    <div>
                      <label style={lbl}>To</label>
                      <input type="date" className="form-input" style={input} value={loForm.end_date} onChange={e => setLoForm(f => ({ ...f, end_date: e.target.value }))} />
                    </div>
                  </div>
                  <label style={lbl}>Note (optional)</label>
                  <input className="form-input" style={input} value={loForm.note} placeholder="Anything your manager should know" onChange={e => setLoForm(f => ({ ...f, note: e.target.value }))} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                    <button className="secondary-btn" onClick={() => setLoOpen(false)} disabled={loBusy}>Cancel</button>
                    <button className="primary-btn" onClick={submitLeave} disabled={loBusy || !loForm.start_date || !loForm.end_date}>
                      {loBusy ? <><Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> Submitting…</> : 'Submit'}
                    </button>
                  </div>
                </div>
              )}

              {leave.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '16px 0', textAlign: 'center' }}>No time-off requests yet.</div>
              ) : leave.map(r => {
                const m = STATUS_META[r.status] || STATUS_META.pending;
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                    <CalendarOff size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                        {(TIMEOFF_TYPES.find(([v]) => v === r.type)?.[1]) || r.type} · {fmtD(r.startDate || r.start_date)} → {fmtD(r.endDate || r.end_date)}
                      </div>
                      {r.note && <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</div>}
                    </div>
                    <span style={{ padding: '2px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: m.bg, color: m.fg, flexShrink: 0 }}>{m.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
