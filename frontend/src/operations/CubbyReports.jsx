// Operations > Reports > Reports (Neil, Oct 20; library Oct 20 - "much
// better than Cubby"). The landing view is the report list (ReportLibrary);
// a report opens here as a live table that sorts, searches, opens tenants and
// units, and shows its headline figures, with the period / facilities /
// options one click away and Download (XLSX, PDF, CSV) and Schedule beside
// them. Cubby itself only hands out files.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, ChevronDown, Download, SlidersHorizontal, Star } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import DrillPanel from './DrillPanel';
import ReportLibrary, { SourceBadge } from './ReportLibrary';
import ReportRunDialog, { downloadReport, requestFor } from './ReportRunDialog';
import ReportTable from './ReportTable';
import { cellText } from './reportFormat';
import { FORMATS, cleanOptions, facilitiesWords, optionWords } from './reportFields';
import { fromPageRange, periodName, rangeWords, resolvePeriod } from './reportPeriod';
import { getChoices, getFavorites, getRecent, pushRecent, toggleFavorite } from './reportPrefs';

export function initialChoices(meta, scope, range) {
  const saved = getChoices(meta.key);
  const period = saved?.period?.mode ? saved.period : fromPageRange(range);
  return { period, facilityIds: scope.map((f) => f.id), options: cleanOptions(meta, saved?.options), format: saved?.format || 'xlsx' };
}

function Tiles({ summary }) {
  if (!Array.isArray(summary) || !summary.length) return null;
  return (
    <div className="ops-tiles">
      {summary.map((s) => (
        <div key={s.label} className="ops-tile">
          <div className="ops-tile-l">{s.label}</div>
          <div className="ops-tile-v">{s.type === 'text' ? String(s.value ?? '') : cellText(s.value, s.type) || '-'}</div>
        </div>
      ))}
    </div>
  );
}

function DownloadMenu({ onPick, busy, disabled }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="ops-menu" ref={box}>
      <button type="button" className="primary-btn ops-btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen((o) => !o)}>
        <Download size={14} aria-hidden="true" /> {busy ? 'Preparing...' : 'Download'} <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ops-menu-pop dash-card" role="menu">
          {FORMATS.map(([k, l, about, Icon]) => (
            <button key={k} type="button" role="menuitem" className="ops-menu-item" onClick={() => { setOpen(false); onPick(k); }}>
              <Icon size={16} aria-hidden="true" />
              <span><span className="ops-fmt-l">{l}</span><span className="ops-rd-hint">{about}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportView({ meta, choices, facilities, today, fav, onFavorite, onBack, onChange, onSchedule, canSchedule }) {
  const [report, setReport] = useState({ status: 'loading' });
  const [drill, setDrill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const req = useMemo(() => requestFor(meta, choices, facilities, today), [meta, choices, facilities, today]);
  const where = facilitiesWords(req.facilityIds, facilities).replace(/ \(\d+\)$/, '');

  const load = useCallback(async () => {
    setReport((r) => ({ status: 'loading', data: r.data?.key === meta.key ? r.data : null }));
    try {
      setReport({ status: 'ready', data: await api.opsReport(meta.key, req) });
    } catch (err) {
      console.error('Operations report failed', err);
      setReport({ status: 'error', error: err?.message || "Couldn't build this report." });
    }
  }, [meta.key, req]);
  useEffect(() => { load(); }, [load]);

  const download = async (format) => {
    setBusy(true); setFlash('');
    try { await downloadReport(meta, { ...choices, format }, facilities, today); } catch (err) {
      console.error('Operations report download failed', err);
      setFlash(err?.message || 'The file could not be prepared. Try again.');
    } finally { setBusy(false); }
  };

  const onDrill = useCallback((kind, fid, id) => setDrill([kind, fid, id]), []);
  const data = report.data;
  const off = meta.source === 'unavailable';
  const period = meta.period ? resolvePeriod(choices.period, today) : null;
  const opts = optionWords(meta, choices.options);

  return (
    <div className="dash-card" style={{ minWidth: 0 }}>
      <button type="button" className="ops-back" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" /> All Reports</button>
      <div className="ops-view-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="ops-view-title">
            {meta.title}
            <button type="button" className="ops-icon-btn" data-on={fav} aria-pressed={fav} aria-label={fav ? 'Remove from Favorites' : 'Add to Favorites'} onClick={onFavorite}>
              <Star size={16} fill={fav ? 'currentColor' : 'none'} />
            </button>
            <SourceBadge source={meta.source} />
          </h2>
          <div className="dash-card-sub">{meta.about}</div>
        </div>
        <div className="ops-view-acts">
          <button type="button" className="secondary-btn ops-btn-sm" disabled={off || !canSchedule} onClick={onSchedule}
            title={canSchedule ? undefined : 'Scheduled reports are not switched on yet'}>
            <CalendarClock size={14} aria-hidden="true" /> Schedule
          </button>
          <DownloadMenu onPick={download} busy={busy} disabled={off} />
        </div>
      </div>

      <div className="ops-view-bar">
        <button type="button" className="ops-ctl" onClick={onChange} aria-label="Change Period">
          <span className="ops-ctl-l">Period</span>
          <span className="ops-ctl-v">{period ? `${periodName(choices.period)}: ${rangeWords(period)}`
            : meta.pointInTime && choices.period?.mode === 'past' && choices.period.date ? `As of ${formatDate(choices.period.date)}` : 'As of the Last Cubby Sync'}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <button type="button" className="ops-ctl" onClick={onChange} aria-label="Change Facilities">
          <span className="ops-ctl-l">Facilities</span>
          <span className="ops-ctl-v">{facilitiesWords(choices.facilityIds, facilities)}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {opts && (
          <button type="button" className="ops-ctl" onClick={onChange} aria-label="Change Options">
            <SlidersHorizontal size={13} aria-hidden="true" />
            <span className="ops-ctl-v">{opts}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {flash && <div className="ops-rep-flash is-bad" role="alert">{flash}</div>}

      {report.status === 'loading' && !data && <LoadingState size="section" label={`Building ${meta.title}`} minHeight={220} />}
      {report.status === 'error' && <ErrorBanner message={report.error} onRetry={load} />}
      {data && data.key === meta.key && (
        <div style={{ opacity: report.status === 'loading' ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={report.status === 'loading'}>
          {data.available === false ? <div className="ops-empty">{data.notes?.[0] || 'Cubby does not share this data yet.'}</div> : (
            <>
              <Tiles summary={data.summary} />
              {data.notes?.length > 0 && <ul className="ops-rep-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              <ReportTable title={data.title || meta.title} where={where} asOf={data.period?.to || data.asOf} columns={data.columns || []} rows={data.rows || []}
                totals={data.totals} groups={data.groups} onDrill={onDrill} csv={false} />
              <p className="ops-note" style={{ marginTop: 10 }}>
                {data.period ? `${formatDate(data.period.from)} - ${formatDate(data.period.to)}. ` : ''}
                {Array.isArray(data.facilities) && data.facilities.length ? `${data.facilities.join(', ')}. ` : ''}
                {data.fetchedAt ? `Cubby data from ${formatDateTime(data.fetchedAt)}. ` : ''}
                Tenant name, unit and money only: no phone, email or address. Click a tenant or a unit to see more.
              </p>
            </>
          )}
        </div>
      )}
      {drill && <DrillPanel key={drill.join(':')} target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

// `catalog` and the schedules come from Reports.jsx (the Scheduled tab shares them).
export default function CubbyReports({ catalog, scope, facilities, range, today, canSchedule, onSchedule }) {
  const [favorites, setFavorites] = useState(getFavorites);
  const [recent, setRecent] = useState(getRecent);
  const [open, setOpen] = useState(null);       // { key, choices }
  const [dialog, setDialog] = useState(null);   // { key, mode, choices }
  const reports = catalog.reports;
  const byKey = (k) => reports.find((r) => r.key === k);
  const scopeKey = scope.map((f) => f.id).join(',');

  // The page's facility dropdown moves an open report with it: choices made
  // under another facility pick give way to the page's new one.
  const choices = useMemo(() => (!open ? null : open.scopeKey === scopeKey ? open.choices
    : { ...open.choices, facilityIds: scopeKey ? scopeKey.split(',') : [] }), [open, scopeKey]);

  const show = (key, choices) => {
    const meta = byKey(key);
    if (!meta) return;
    setRecent(pushRecent(key));
    setOpen({ key, scopeKey, choices: choices || initialChoices(meta, scope, range) });
    setDialog(null);
  };
  const ask = (key, mode) => {
    const meta = byKey(key);
    setDialog({ key, mode, choices: open?.key === key ? choices : initialChoices(meta, scope, range) });
  };
  const fav = (key) => setFavorites(toggleFavorite(key));
  const meta = open && byKey(open.key);
  const dialogMeta = dialog && byKey(dialog.key);

  return (
    <>
      {meta ? (
        <ReportView meta={meta} choices={choices} facilities={facilities} today={today} fav={favorites.includes(meta.key)}
          onFavorite={() => fav(meta.key)} onBack={() => setOpen(null)} onChange={() => ask(meta.key, 'view')}
          onSchedule={() => onSchedule(meta, choices)} canSchedule={canSchedule} />
      ) : (
        <ReportLibrary reports={reports} categories={catalog.categories || []} favorites={favorites} recent={recent} onFavorite={fav}
          onOpen={(k) => show(k)} onDownload={(k) => ask(k, 'download')} onSchedule={(k) => onSchedule(byKey(k), initialChoices(byKey(k), scope, range))}
          canSchedule={canSchedule} />
      )}
      {dialogMeta && (
        <ReportRunDialog meta={dialogMeta} mode={dialog.mode} initial={dialog.choices} facilities={facilities} today={today}
          onOpen={(choices) => show(dialog.key, choices)} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
