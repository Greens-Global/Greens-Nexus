// The Job's Field tab (Neil, 11/03/2026, plan phase 2): what happened on
// site, from the modules that hold it - hours from the Time Clock punches
// stamped with this jobsite (hours only, never pay; the crew sees their own),
// the photos from the daily logs, the form entries filed for the job
// (inspections, safety, toolbox talks - their answers stay behind the Forms
// rule), and the equipment out to it (ordinary Items checkouts). The daily
// logs themselves stay on Site Activity, one click away.
import { useMemo, useState } from 'react';
import { Clock, Camera, ClipboardCheck, Wrench, ClipboardList, Plus } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CARD, TONE, personName } from '../ui';
import { clientId, useLoad } from '../lib/job';
import { formatHoursWords } from '../../lib/hoursText';

const go = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));
const h3 = { fontSize: 15, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 };
const quiet = { fontSize: 13, color: 'var(--text-secondary)' };
const FORM_STATUS = {
  submitted: ['Submitted', TONE.blue], reviewed: ['Reviewed', TONE.green],
  follow_up: ['Needs Follow-Up', TONE.yellow], closed: ['Closed', TONE.gray],
};

function Section({ icon: Icon, title, children, label }) {
  return (
    <section style={{ ...CARD, marginBottom: 14 }} aria-label={label || title}>
      <h3 style={h3}><Icon size={16} style={{ color: 'var(--text-secondary)' }} />{title}</h3>
      {children}
    </section>
  );
}

function Hours({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobLabor(project.id), project.id);
  const days = useMemo(() => Object.keys(data?.byDay || {}).sort().reverse().slice(0, 14), [data]);
  const people = useMemo(() => Object.entries(data?.byPerson || {}).sort((a, b) => b[1] - a[1]), [data]);
  const names = { ...(project.names || {}), ...(data?.names || {}) };
  return (
    <Section icon={Clock} title="Hours on This Job">
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error ? <SkeletonBlocks count={2} height={40} borderRadius={8} /> : data && (
        data.total === 0 ? (
          <div style={quiet}>No hours yet. Time Clock punches count here when the person's shift is placed on this jobsite.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {data.ownOnly ? 'Your Hours' : 'By Person'}
              </div>
              {people.map(([em, h]) => (
                <div key={em} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0', borderTop: '1px solid var(--border-color)' }}>
                  <span>{personName(em, names)}</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{h} h</b>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--border-color)', fontWeight: 700 }}>
                <span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{data.total} h</span>
              </div>
            </div>
            {/* Round Three (11/11/2026): the same hours by the cost code picked at punch-in. */}
            {(data.byCode || []).some((c) => c.code) && (
              <div data-hours-by-code="">
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>By Cost Code</div>
                {data.byCode.map((c) => (
                  <div key={c.code || '-'} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 14, padding: '4px 0', borderTop: '1px solid var(--border-color)' }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.code ? (c.name ? `${c.code} - ${c.name}` : c.code) : 'Not Coded'}</span>
                    <b style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatHoursWords(c.hours, { compact: true })}</b>
                  </div>
                ))}
              </div>
            )}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>By Day</div>
              {days.map((d) => (
                <div key={d} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0', borderTop: '1px solid var(--border-color)' }}>
                  <span>{formatDate(d, d)}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{data.byDay[d]} h</span>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </Section>
  );
}

function Photos({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobPhotos(project.id), project.id);
  const list = data?.photos || [];
  return (
    <Section icon={Camera} title="Photos">
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error ? <SkeletonBlocks count={1} height={96} borderRadius={8} /> : list.length === 0 ? (
        <div style={quiet}>No photos yet. They arrive with the crew's daily logs.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
          {list.map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer" title={p.caption || formatDate(p.logDate, p.logDate)}
              style={{ display: 'block', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: 'var(--mist)', border: '1px solid var(--border-color)' }}>
              <img src={p.thumbnailUrl || p.url} alt={p.caption || `Photo from ${formatDate(p.logDate, p.logDate)}`} loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </a>
          ))}
        </div>
      )}
    </Section>
  );
}

function Forms({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobForms(project.id), project.id);
  const list = data?.entries || [];
  return (
    <Section icon={ClipboardCheck} title="Inspections And Safety">
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error ? <SkeletonBlocks count={2} height={40} borderRadius={8} /> : list.length === 0 ? (
        <div style={quiet}>No forms filed for this job yet. A form filled from a shift on this jobsite, or with this job picked, shows here.</div>
      ) : list.map((e) => {
        const [label, color] = FORM_STATUS[e.status] || FORM_STATUS.submitted;
        return (
          <button key={e.id} type="button" data-form-entry={e.id}
            onClick={() => go('documents', `documents-forms:entry:${e.id}`)}
            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0',
              background: 'none', border: 'none', borderTop: '1px solid var(--border-color)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
            <span style={{ minWidth: 0, fontSize: 14 }}>
              <b>{e.title}</b>
              <span style={{ color: 'var(--text-secondary)' }}> · {e.submittedByName || personName(e.submittedBy, project.names)} · {formatDateTime(e.submittedAt, '')}</span>
            </span>
            <StatusLabel size="sm" label={label} color={color} />
          </button>
        );
      })}
    </Section>
  );
}

function Equipment({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobEquipment(project.id), project.id);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const out = data?.equipment || [];
  const add = async () => {
    if (!pick || busy) return;
    setBusy(true); setErr('');
    try { await api.linkJobEquipment(project.id, { id: clientId('eq'), checkout_id: pick }); setPick(''); reload(); }
    catch (e) { setErr(e.message || 'Could not add that.'); }
    setBusy(false);
  };
  return (
    <Section icon={Wrench} title="Equipment on This Job">
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {!data && !error ? <SkeletonBlocks count={2} height={40} borderRadius={8} /> : data && (
        <>
          {out.length === 0 ? <div style={quiet}>No equipment on this job. Equipment comes from Items checkouts held by the job's people.</div>
            : out.map((e) => (
              <div key={e.linkId} data-equipment={e.checkoutId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: 14, minWidth: 0 }}>
                  <b>{e.itemName}</b>
                  <span style={{ color: 'var(--text-secondary)' }}> · {e.holderName || personName(e.holderEmail, project.names)}{e.handedOverAt ? ` · since ${formatDate(e.handedOverAt, '')}` : ''}</span>
                </span>
                {data.canEdit && (
                  <HoldButton label="Take Off" doneLabel="Taken Off" holdMs={HOLD_RECORD_MS} size="sm"
                    onConfirm={() => api.endJobEquipment(e.linkId).then(reload)}
                    fallbackMessage={`Take ${e.itemName} off this job? The checkout itself stays as it is.`} />
                )}
              </div>
            ))}
          {data.canEdit && (data.candidates || []).length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <select className="form-input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Equipment to add" style={{ flex: '1 1 240px' }}>
                <option value="">Add equipment checked out to the crew</option>
                {data.candidates.map((c) => <option key={c.checkoutId} value={c.checkoutId}>{c.itemName} - {c.holderName || c.holderEmail}</option>)}
              </select>
              <button className="secondary-btn" disabled={!pick || busy} onClick={add}><Plus size={14} />Add to Job</button>
            </div>
          )}
          {err && <div role="alert" style={{ fontSize: 13, color: 'hsl(var(--color-red))', marginTop: 6 }}>{err}</div>}
        </>
      )}
    </Section>
  );
}

export default function FieldTab({ project }) {
  return (
    <div>
      <div style={{ ...CARD, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <ClipboardList size={20} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 600 }}>Daily Logs</div>
          <div style={quiet}>The crew's daily logs and the weekly report live on Site Activity.</div>
        </div>
        <button className="secondary-btn" onClick={() => go('ops', `activity:${project.id}`)}>Open Site Activity</button>
      </div>
      <Hours project={project} />
      <Photos project={project} />
      <Forms project={project} />
      <Equipment project={project} />
    </div>
  );
}
