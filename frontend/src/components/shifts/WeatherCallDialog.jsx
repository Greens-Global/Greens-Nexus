import { useEffect, useMemo, useState } from 'react';
import { CloudRain, CloudLightning, TriangleAlert, Check, Phone, RotateCcw, Send, X } from 'lucide-react';
import { api } from '../../api';
import { dialog } from '../../ui/dialog';
import { formatDate, formatHHMM, formatDateTime, formatWeekday } from '../../lib/datetime';
import { ErrorBanner, Spinner, SkeletonBlocks } from '../AsyncState';
import { MODAL_BACK, MODAL_CARD, LBL } from './ScheduleToolbar';
import { BAND_LABEL } from './WeatherChip';
import { AvatarName } from '../../tasks/components';

// The Weather Call (Weather Call, Oct 2026): one group, one day. The top is
// the forecast for the scheduled hours; the bottom is the roster with a
// checkbox per person (everyone checked - uncheck whoever can still work
// with pay), ONE decision, a reason, and whether to text. Confirm changes
// the shifts and tells the crew; the screen then becomes the roster of who
// has acknowledged, with phone numbers beside anyone who has not, and the
// Remind / Reinstate / Make Another Call buttons. Nexus never decides.

const KINDS = [
  ['cancel', 'Cancel the Day', 'The picked people are off. The day is unpaid.'],
  ['delay', 'Delay the Start', 'Everyone picked starts later; a start past the end of a shift cancels it.'],
  ['end_early', 'End Early', 'Everyone picked finishes earlier.'],
  ['move', 'Move the Crew', 'Another site or indoor work; the times stay.'],
  ['proceed', 'Proceed as Planned', 'Tell the crew the shift goes ahead despite the forecast.'],
];
const OUTCOME_TEXT = { cancelled: 'Canceled (Unpaid)', delayed: 'Delayed', shortened: 'Ends Early', moved: 'Moved', kept: 'Shift Stands' };
const BAND_COLOR = { heads_up: 'hsl(var(--color-blue))', major: 'hsl(var(--color-orange))', warning: 'hsl(var(--color-red))', quiet: 'var(--muted)' };
const CELL = { padding: '6px 8px', fontSize: 12.5, borderTop: '1px solid var(--line)', verticalAlign: 'top' };

function smsSummary(people, picked, sms) {
  const sel = people.filter((p) => picked.has(p.email));
  if (!sms) return `${sel.length} picked · no texts for this call`;
  const no = sel.filter((p) => !p.phone).length, off = sel.filter((p) => p.phone && !p.smsOn).length;
  const texted = sel.length - no - off;
  const bits = [`${sel.length} picked`, `texts to ${texted}`];
  if (no) bits.push(`${no} ${no === 1 ? 'has' : 'have'} no phone on file`);
  if (off) bits.push(`${off} turned texts off`);
  return bits.join(' · ');
}

function Hourly({ hours }) {
  if (!hours?.length) return null;
  const max = Math.max(...hours.map((h) => Number(h.inches) || 0), 0.1);
  return (
    <div role="img" aria-label="Rain by hour" style={{ display: 'grid', gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))`, gap: 3, alignItems: 'end', height: 64, marginTop: 8 }}>
      {hours.map((h) => {
        const chance = Number(h.chance) || 0;
        const hh = Number((h.time || '').slice(11, 13));
        return (
          <div key={h.time} title={`${formatHHMM(`${String(hh).padStart(2, '0')}:00`)} · ${chance}% · ${Number(h.inches || 0).toFixed(2)} in`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <div style={{ width: '100%', height: `${Math.max(3, Math.round((Number(h.inches) || 0) / max * 44))}px`, background: `hsl(var(--color-blue) / ${0.25 + chance / 140})`, borderRadius: 3 }} />
            <span style={{ fontSize: 9, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{hh % 12 || 12}{hh < 12 ? 'a' : 'p'}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function WeatherCallDialog({ groupId, date, onClose, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState(null);     // Set of emails; null until the roster loads
  const [kind, setKind] = useState('cancel');
  const [newStart, setNewStart] = useState('10:00');
  const [newEnd, setNewEnd] = useState('12:00');
  const [moveTo, setMoveTo] = useState('');
  const [reason, setReason] = useState('');
  const [sms, setSms] = useState(true);
  const [busy, setBusy] = useState(false);
  const [another, setAnother] = useState(false);  // show the form again over an active call
  useEffect(() => {
    let live = true;
    setError(null);
    api.weatherCallScreen(groupId, date).then((r) => {
      if (!live) return;
      setData((prev) => {
        if (prev === null) setSms(r.smsDefault !== false);   // the setting seeds the switch once; the decider's choice then stands
        return r;
      });
      setPicked((p) => p ?? new Set(r.roster.filter((x) => x.email).map((x) => x.email)));
    }).catch((e) => { if (live) setError(e?.message || 'The weather call could not be loaded.'); });
    return () => { live = false; };
  }, [groupId, date, tick]);
  const reload = () => setTick((t) => t + 1);
  const people = useMemo(() => (data?.roster || []).filter((p) => p.email), [data]);
  const decision = data?.decision && data.decision.status === 'active' ? data.decision : null;
  const history = data?.decision && data.decision.status !== 'active' ? data.decision : null;
  const o = data?.outlook || {};
  const toggle = (em) => setPicked((s) => { const n = new Set(s); if (n.has(em)) n.delete(em); else n.add(em); return n; });
  const allPicked = picked && people.length > 0 && people.every((p) => picked.has(p.email));

  async function confirm() {
    if (!reason.trim()) { toastErr?.('Give the crew a short reason.'); return; }
    if (kind === 'move' && !moveTo.trim()) { toastErr?.('Say where the crew should go instead.'); return; }
    const n = picked.size;
    const what = KINDS.find(([k]) => k === kind)?.[1] || kind;
    const ok = await dialog.confirm(`${what} for ${n} of ${people.length} on ${formatDate(date)}? ${kind === 'cancel' ? 'Their day is unpaid. ' : ''}`
      + `Nexus changes their shifts now and tells them on every channel${sms ? ', including a text' : ''}.`, { title: 'Make the Weather Call', confirmText: 'Confirm', danger: kind === 'cancel' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.weatherCallDecide(groupId, date, { kind, emails: [...picked], new_start: kind === 'delay' ? newStart : undefined,
        new_end: kind === 'end_early' ? newEnd : undefined, move_to: kind === 'move' ? moveTo.trim() : undefined, reason: reason.trim(), sms });
      toastOk?.('Weather call made. The crew is being told.');
      setAnother(false); setReason('');
      reload(); onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'The weather call could not be made.'); }
    setBusy(false);
  }
  async function reinstate() {
    const ok = await dialog.confirm('Put every shift back as it was and tell the same people? Use this when the weather clears.', { title: 'Reinstate the Shifts', confirmText: 'Reinstate' });
    if (!ok) return;
    setBusy(true);
    try { await api.weatherCallReinstate(decision.id); toastOk?.('Shifts reinstated. The crew is being told.'); reload(); onChanged?.(); }
    catch (e) { toastErr?.(e?.message || 'Could not reinstate.'); }
    setBusy(false);
  }
  async function remind() {
    setBusy(true);
    try { const r = await api.weatherCallRemind(decision.id); toastOk?.(r.reminded ? `Reminded ${r.reminded} ${r.reminded === 1 ? 'person' : 'people'}.` : 'Everyone has acknowledged.'); reload(); }
    catch (e) { toastErr?.(e?.message || 'Could not send the reminder.'); }
    setBusy(false);
  }

  const BandIcon = o.band === 'warning' ? TriangleAlert : o.storm ? CloudLightning : CloudRain;
  const showForm = data && data.canDecide && (!decision || another);
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Weather Call" className="nx-popup" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Weather Call{data ? ` - ${data.group.name}` : ''}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>{formatWeekday(date)}, {formatDate(date)}{data?.group?.workSiteName ? ` · ${data.group.workSiteName}` : ''}</div>

        {error ? <ErrorBanner message={error} onRetry={reload} /> : !data ? <SkeletonBlocks count={3} height={56} borderRadius={10} /> : (
          <div style={{ display: 'grid', gap: 14 }}>
            {/* The forecast for the scheduled hours */}
            <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
              {o.band ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <BandIcon size={16} style={{ color: BAND_COLOR[o.band] || 'var(--muted)', flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: 800, color: BAND_COLOR[o.band] || 'var(--ink)' }}>
                      {o.band === 'warning' && o.alerts?.length ? o.alerts.join(', ') : o.storm ? 'Thunderstorms' : BAND_LABEL[o.band] || 'Quiet'}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{o.chance}% chance · {Number(o.inches || 0).toFixed(2)} in during {o.windowStart} - {o.windowEnd}</span>
                    {o.updatedAt && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>Forecast as of {formatDateTime(o.updatedAt)}</span>}
                  </div>
                  <Hourly hours={o.hourly} />
                </>
              ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No forecast on record for this day yet. The watch checks every half hour; a call can still be made.</div>}
            </div>

            {/* An active call: who was told, who has acknowledged */}
            {decision && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', background: 'var(--card)' }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{decision.kind === 'proceed' ? 'Going Ahead as Planned' : decision.kind === 'cancel' ? 'Day Canceled for Weather (Unpaid)'
                  : decision.kind === 'delay' ? `Start Delayed to ${formatHHMM(decision.newStart)}` : decision.kind === 'end_early' ? `Ending Early at ${formatHHMM(decision.newEnd)}` : `Moved to ${/^\d{4}-\d{2}-\d{2}$/.test(decision.moveTo || '') ? formatDate(decision.moveTo) : decision.moveTo}`}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}><AvatarName email={decision.decidedBy} name={decision.decidedByName} size={18} /> · {formatDateTime(decision.decidedAt)} · {decision.reason}</div>
                <div style={{ fontSize: 12.5, marginTop: 8, fontWeight: 700 }}>
                  {decision.ackedCount} of {decision.selectedCount} acknowledged{decision.pendingCount ? ` · ${decision.pendingCount} waiting` : ''}
                </div>
                <div style={{ overflowX: 'auto', marginTop: 6 }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 420 }}>
                    <thead><tr>{['Person', 'Outcome', 'Told by', 'Acknowledged'].map((h) => <th key={h} style={{ ...LBL, textAlign: 'left', padding: '0 8px 4px' }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {decision.people.map((p) => {
                        const ch = p.channels || {};
                        const told = p.selected ? ['bell', ch.sms === 'ok' ? 'text' : '', ch.email === 'ok' ? 'email' : '', ch.teams === 'ok' ? 'Teams' : ''].filter(Boolean).join(', ') : 'bell';
                        return (
                          <tr key={p.email} data-ack-row={p.email} style={{ opacity: p.selected ? 1 : 0.6 }}>
                            <td style={CELL}><AvatarName email={p.email} name={p.name} size={20}><b>{p.name}</b></AvatarName>{p.selected && !p.ackAt && p.phoneNumber && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--muted)' }}><Phone size={10} /> <span style={{ userSelect: 'all' }}>{p.phoneNumber}</span></div>}</td>
                            <td style={CELL}>{OUTCOME_TEXT[p.outcome] || p.outcome}</td>
                            <td style={{ ...CELL, color: 'var(--muted)' }}>{told}{p.selected && ch.sms && ch.sms !== 'ok' ? ` · text: ${ch.sms}` : ''}</td>
                            <td style={CELL}>{!p.selected ? <span style={{ color: 'var(--muted)' }}>-</span> : p.ackAt ? <span style={{ color: 'hsl(var(--color-green))', fontWeight: 700 }}>{formatDateTime(p.ackAt)}</span>
                              : <span style={{ color: 'hsl(var(--color-orange))', fontWeight: 700 }}>Waiting{p.remindedAt ? ' · reminded' : ''}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.canDecide && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    {decision.pendingCount > 0 && <button type="button" className="secondary-btn" onClick={remind} disabled={busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Send size={12} /> Remind the Silent</button>}
                    <button type="button" className="secondary-btn" onClick={reinstate} disabled={busy} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><RotateCcw size={12} /> Reinstate</button>
                    {!another && <button type="button" className="secondary-btn" onClick={() => setAnother(true)} disabled={busy} style={{ fontSize: 12 }}>Make Another Call</button>}
                  </div>
                )}
              </div>
            )}
            {history && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {history.status === 'reinstated' ? `A weather call on this day was reversed by ${history.reinstatedBy} on ${formatDateTime(history.reinstatedAt)}.` : 'An earlier call on this day was superseded.'}
              </div>
            )}

            {/* The call */}
            {showForm && (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div style={{ ...LBL, display: 'flex', alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>Who this applies to - uncheck anyone who can still work with pay</span>
                    <button type="button" onClick={() => setPicked(allPicked ? new Set() : new Set(people.map((p) => p.email)))} style={{ border: 'none', background: 'none', color: 'var(--wk-brand)', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, padding: 0 }}>
                      {allPicked ? 'Clear All' : 'Pick All'}
                    </button>
                  </div>
                  <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 220, overflowY: 'auto' }}>
                    {people.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--muted)' }}>Nobody is scheduled for this group that day.</div>}
                    {people.map((p) => (
                      <label key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={picked?.has(p.email) || false} onChange={() => toggle(p.email)} aria-label={`Apply to ${p.name}`} />
                        <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{p.name}</span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{p.shifts.map((s) => `${formatHHMM(s.originalStart || s.start)} - ${formatHHMM(s.originalEnd || s.end)}${s.weatherStatus ? ` (${OUTCOME_TEXT[s.weatherStatus] || s.weatherStatus})` : ''}`).join(', ')}</span>
                        <span title={!p.phone ? 'No phone on file' : !p.smsOn ? 'Texts turned off' : 'Will be texted'} style={{ fontSize: 11, color: !p.phone || !p.smsOn ? 'hsl(var(--color-orange))' : 'var(--muted)' }}>
                          {!p.phone ? 'no phone' : !p.smsOn ? 'texts off' : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={LBL}>The call</div>
                  <div role="radiogroup" aria-label="Decision" style={{ display: 'grid', gap: 6 }}>
                    {KINDS.map(([k, label, hint]) => (
                      <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', border: `1px solid ${kind === k ? 'var(--wk-brand)' : 'var(--line)'}`, borderRadius: 10, cursor: 'pointer', background: kind === k ? 'var(--wk-brand-tint)' : 'transparent' }}>
                        <input type="radio" name="weather-kind" value={k} checked={kind === k} onChange={() => setKind(k)} aria-label={label} style={{ marginTop: 2 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{hint}</div>
                          {kind === k && k === 'delay' && <input type="time" className="form-input" value={newStart} onChange={(e) => setNewStart(e.target.value)} aria-label="New start time" style={{ marginTop: 6, fontSize: 12.5, width: 140 }} />}
                          {kind === k && k === 'end_early' && <input type="time" className="form-input" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} aria-label="New end time" style={{ marginTop: 6, fontSize: 12.5, width: 140 }} />}
                          {kind === k && k === 'move' && <input className="form-input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="e.g. Shop - indoor prep" aria-label="Where to" maxLength={80} style={{ marginTop: 6, fontSize: 12.5, width: '100%' }} />}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <label><div style={LBL}>Reason - the crew sees this</div>
                  <textarea className="form-input" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Flooded access road, 1 in of rain by 9 AM" aria-label="Reason" style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} aria-label="Text the crew" /> Text the crew, besides the bell, email and Teams
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>{picked ? smsSummary(people, picked, sms) : ''}</span>
                  {another && <button type="button" className="secondary-btn" onClick={() => setAnother(false)}>Cancel</button>}
                  <button type="button" className="primary-btn" onClick={confirm} disabled={busy || !people.length || (!picked?.size && kind !== 'proceed')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {busy ? <Spinner size={13} /> : <Check size={13} />} Make the Call
                  </button>
                </div>
              </div>
            )}
            {data && !data.canDecide && !decision && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                The weather call for this group is made by {data.group.deciders.length ? data.group.deciders.map((d) => d.name).join(', ') : "the group's schedulers or the company's managers"}.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
