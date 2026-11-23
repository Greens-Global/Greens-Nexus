// Operations > Reports > Reports Center (Neil, Oct 20; library Oct 20 - "much
// better than Cubby"; Reports Center, Oct 28 2026 call). The landing view is
// the Reports Center (ReportLibrary): Monthly Required on top (pinned, B12),
// the person's Memorized Reports (B11), then every report. A report opens
// here as a live table that sorts, searches, filters, opens tenants and
// units, and takes preset columns (B10), with the period / facilities /
// options one click away and Memorize, Schedule and Export (B8) beside them.
// Cubby itself only hands out files.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bookmark, CalendarClock, ChevronDown, Pin, SlidersHorizontal, Star } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime } from '../lib/datetime';
import DrillPanel from './DrillPanel';
import ReportLibrary, { SourceBadge } from './ReportLibrary';
import ReportRunDialog, { downloadReport, requestFor } from './ReportRunDialog';
import ReportTable from './ReportTable';
import { ExportMenu } from './ColumnsMenu';
import { cellText } from './reportFormat';
import { SHAPE_KEYS, cleanOptions, facilitiesWords, optionWords } from './reportFields';
import { fromPageRange, periodName, rangeWords, resolvePeriod } from './reportPeriod';
import { getChoices, getFavorites, getRecent, pushRecent, toggleFavorite } from './reportPrefs';
import { cleanShape, shapeOptions } from './columnControls';
import { reportTableKey, useOpsColumnShapes, useOpsColumns, useReportsCenter } from './opsPrefs';

export function initialChoices(meta, scope, range) {
  const saved = getChoices(meta.key);
  const period = saved?.period?.mode ? saved.period : fromPageRange(range);
  return { period, facilityIds: scope.map((f) => f.id), options: cleanOptions(meta, saved?.options), format: saved?.format || 'xlsx' };
}

// The headline figures as one quiet line (Oct 28 2026, B7: the data starts
// higher; and no stat boxes - Neil, 11/17/2026).
function Headline({ summary }) {
  if (!Array.isArray(summary) || !summary.length) return null;
  return (
    <p className="ops-headline">
      {summary.map((s, i) => (
        <span key={s.label}>
          {i > 0 && <span className="ops-headline-sep" aria-hidden="true"> - </span>}
          <span>{s.label}</span> <strong>{s.type === 'text' ? String(s.value ?? '') : cellText(s.value, s.type) || '-'}</strong>
        </span>
      ))}
    </p>
  );
}

const withoutShape = (options) => Object.fromEntries(Object.entries(options || {}).filter(([k]) => !SHAPE_KEYS.includes(k)));

function ReportView({ meta, choices, facilities, today, presets, memorized, fav, pinned, onFavorite, onPin, onBack, onChange, onSchedule, canSchedule, center }) {
  const [report, setReport] = useState({ status: 'loading' });
  const [drill, setDrill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  // A memorized report runs with its own columns; a report opened from the
  // list with the person's columns for that report.
  const [kept, setKept] = useOpsColumns(reportTableKey(meta.key));
  const [local, setLocal] = useState(() => (memorized ? cleanShape(memorized.shape) : null));
  const shape = local || kept;
  const setShape = local ? setLocal : setKept;
  const addKey = shape.add.join(',');
  const req = useMemo(() => requestFor(meta, { ...choices, options: withoutShape(choices.options) }, facilities, today,
    addKey ? { addColumns: addKey } : null), [meta, choices, facilities, today, addKey]);
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
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(''), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  const fileChoices = { ...choices, options: withoutShape(choices.options) };
  const download = async (format) => {
    setBusy(true); setFlash('');
    try { await downloadReport(meta, { ...fileChoices, format }, facilities, today, shapeOptions(shape)); } catch (err) {
      console.error('Operations report download failed', err);
      setFlash(err?.message || 'The file could not be prepared. Try again.');
    } finally { setBusy(false); }
  };
  const every = choices.facilityIds.length >= facilities.length;
  const saved = { period: choices.period, facilityIds: every ? null : choices.facilityIds, options: withoutShape(choices.options) };
  const memorize = async () => {
    const name = await dialog.prompt('Name this memorized report. It reruns with these settings and columns in one click.', {
      title: 'Memorize Report', confirmText: 'Memorize', required: true, defaultValue: `${meta.title} - ${where}`,
    });
    if (!name) return;
    const row = center.memorize({ name, report: meta.key, choices: saved, shape });
    setFlash(`Memorized as ${row.name}. It is under Memorized Reports in the Reports Center.`);
  };
  const saveChanges = () => {
    center.update(memorized.id, { choices: saved, shape });
    setFlash(`${memorized.name} now opens with these settings and columns.`);
  };

  const onDrill = useCallback((kind, fid, id) => setDrill([kind, fid, id]), []);
  const data = report.data;
  const off = meta.source === 'unavailable';
  const period = meta.period ? resolvePeriod(choices.period, today) : null;
  const opts = optionWords(meta, choices.options);
  const pinKey = memorized ? `m:${memorized.id}` : meta.key;

  return (
    <div className="dash-card ops-report-view" style={{ minWidth: 0 }}>
      <div className="ops-view-head">
        <div style={{ minWidth: 0 }}>
          <button type="button" className="ops-back" onClick={onBack}><ArrowLeft size={13} aria-hidden="true" /> Reports Center</button>
          <h2 className="ops-view-title">
            {memorized ? memorized.name : meta.title}
            <button type="button" className="ops-icon-btn" data-on={fav} aria-pressed={fav} aria-label={fav ? 'Remove from Favorites' : 'Add to Favorites'} onClick={onFavorite}>
              <Star size={15} fill={fav ? 'currentColor' : 'none'} />
            </button>
            <button type="button" className="ops-icon-btn" data-on={pinned} aria-pressed={pinned}
              aria-label={pinned ? 'Unpin from Monthly Required' : 'Pin to Monthly Required'} title={pinned ? 'Unpin from Monthly Required' : 'Pin to Monthly Required'}
              onClick={() => onPin(pinKey)}>
              <Pin size={15} fill={pinned ? 'currentColor' : 'none'} />
            </button>
            <SourceBadge source={meta.source} />
          </h2>
          <div className="dash-card-sub">{memorized ? `${meta.title}, memorized ${formatDate(memorized.savedAt)}. ` : ''}{meta.about}</div>
        </div>
        <div className="ops-view-acts">
          {memorized ? (
            <>
              <button type="button" className="secondary-btn ops-btn-sm" onClick={saveChanges}><Bookmark size={14} aria-hidden="true" /> Save Changes</button>
              <button type="button" className="secondary-btn ops-btn-sm" onClick={memorize}>Memorize As New</button>
            </>
          ) : (
            <button type="button" className="secondary-btn ops-btn-sm" onClick={memorize} disabled={off}><Bookmark size={14} aria-hidden="true" /> Memorize</button>
          )}
          <button type="button" className="secondary-btn ops-btn-sm" disabled={off || !canSchedule}
            onClick={() => onSchedule(meta, { ...fileChoices, options: { ...fileChoices.options, ...shapeOptions(shape) } })}
            title={canSchedule ? undefined : 'Scheduled reports are not switched on yet'}>
            <CalendarClock size={14} aria-hidden="true" /> Schedule
          </button>
          <ExportMenu onPick={download} busy={busy} disabled={off} />
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
      {flash && <div className="ops-rep-flash" role="status">{flash}</div>}

      {report.status === 'loading' && !data && <LoadingState size="section" label={`Building ${meta.title}`} minHeight={220} />}
      {report.status === 'error' && <ErrorBanner message={report.error} onRetry={load} />}
      {data && data.key === meta.key && (
        <div style={{ opacity: report.status === 'loading' ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={report.status === 'loading'}>
          {data.available === false ? <div className="ops-empty">{data.notes?.[0] || 'Cubby does not share this data yet.'}</div> : (
            <>
              <Headline summary={data.summary} />
              <ReportTable title={data.title || meta.title} where={where} asOf={data.period?.to || data.asOf}
                columns={data.allColumns || data.columns || []} rows={data.rows || []}
                totals={data.totals} groups={data.groups} onDrill={onDrill} exportable={false}
                shape={shape} onShape={setShape} presets={presets} />
              {data.notes?.length > 0 && <ul className="ops-rep-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              <p className="ops-note" style={{ marginTop: 8 }}>
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
  const [open, setOpen] = useState(null);       // { key, choices, scopeKey, memId }
  const [dialogState, setDialog] = useState(null);   // { key, mode, choices }
  const center = useReportsCenter();
  const shapeOf = useOpsColumnShapes();
  const reports = catalog.reports;
  const presets = catalog.presets || [];
  const byKey = (k) => reports.find((r) => r.key === k);
  const scopeKey = scope.map((f) => f.id).join(',');

  // The page's facility dropdown moves an open report with it: choices made
  // under another facility pick give way to the page's new one.
  const choices = useMemo(() => (!open ? null : open.scopeKey === scopeKey ? open.choices
    : { ...open.choices, facilityIds: scopeKey ? scopeKey.split(',') : [] }), [open, scopeKey]);

  const show = (key, picked, memId = null) => {
    const meta = byKey(key);
    if (!meta) return;
    setRecent(pushRecent(key));
    setOpen({ key, scopeKey, choices: picked || initialChoices(meta, scope, range), memId });
    setDialog(null);
  };
  const openMemorized = (m) => {
    const meta = byKey(m.report);
    if (!meta) return;
    const base = initialChoices(meta, scope, range);
    const ids = Array.isArray(m.choices?.facilityIds) ? m.choices.facilityIds.filter((id) => facilities.some((f) => f.id === id)) : null;
    show(m.report, {
      ...base,
      period: m.choices?.period?.mode ? m.choices.period : base.period,
      facilityIds: ids?.length ? ids : facilities.map((f) => f.id),
      options: cleanOptions(meta, m.choices?.options),
    }, m.id);
  };
  const ask = (key, mode) => {
    const meta = byKey(key);
    setDialog({ key, mode, choices: open?.key === key ? choices : initialChoices(meta, scope, range) });
  };
  const fav = (key) => setFavorites(toggleFavorite(key));
  const meta = open && byKey(open.key);
  const memorized = open?.memId ? center.memorized.find((m) => m.id === open.memId) || null : null;
  const dialogMeta = dialogState && byKey(dialogState.key);
  // Schedule from the list follows the person's columns for that report.
  const scheduleFromList = (k) => {
    const m = byKey(k);
    const c = initialChoices(m, scope, range);
    onSchedule(m, { ...c, options: { ...c.options, ...shapeOptions(shapeOf(reportTableKey(k))) } });
  };

  return (
    <>
      {meta ? (
        <ReportView key={`${meta.key}:${open.memId || ''}`} meta={meta} choices={choices} facilities={facilities} today={today}
          presets={presets} memorized={memorized} center={center}
          fav={favorites.includes(meta.key)} pinned={center.pinned.includes(memorized ? `m:${memorized.id}` : meta.key)}
          onFavorite={() => fav(meta.key)} onPin={center.togglePin} onBack={() => setOpen(null)} onChange={() => ask(meta.key, 'view')}
          onSchedule={onSchedule} canSchedule={canSchedule} />
      ) : (
        <ReportLibrary reports={reports} categories={catalog.categories || []} favorites={favorites} recent={recent} onFavorite={fav}
          center={center} onOpenMemorized={openMemorized}
          onOpen={(k) => show(k)} onDownload={(k) => ask(k, 'download')} onSchedule={scheduleFromList}
          canSchedule={canSchedule} />
      )}
      {dialogMeta && (
        <ReportRunDialog meta={dialogMeta} mode={dialogState.mode} initial={dialogState.choices} facilities={facilities} today={today}
          extra={shapeOptions(open?.key === dialogState.key && memorized ? cleanShape(memorized.shape) : shapeOf(reportTableKey(dialogState.key)))}
          onOpen={(c) => show(dialogState.key, c, open?.key === dialogState.key ? open.memId : null)} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

