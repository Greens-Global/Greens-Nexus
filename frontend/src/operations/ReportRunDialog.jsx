// Operations > Reports: the Run / Download dialog. Pick the period, the
// facilities, the report's own options and a file format, then open the
// report on screen (Cubby cannot) or download it. The choices are remembered
// per report in this browser.
import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import { api, saveBlob } from '../api';
import { csvName, downloadCsv } from './csv';
import { toCsvRows } from './reportFormat';
import { resolvePeriod } from './reportPeriod';
import { saveChoices } from './reportPrefs';
import { FacilitiesField, FormatField, OptionsField, PeriodField, ReportModal, facilitiesWords } from './reportFields';

// The request for /run and /export: every facility = [] (all).
export function requestFor(meta, choices, facilities, today) {
  const all = choices.facilityIds.length >= facilities.length;
  const { from, to } = meta.period ? resolvePeriod(choices.period, today)
    : { from: '', to: meta.pointInTime && choices.period?.mode === 'past' && choices.period.date ? choices.period.date : '' };
  return { facilityIds: all ? [] : choices.facilityIds, start: from, end: to, options: meta.options?.length ? choices.options : undefined };
}

// Download as XLSX / PDF / CSV from the server. Before the export endpoint is
// live (404), a CSV is still built here from the report itself.
export async function downloadReport(meta, choices, facilities, today) {
  const params = requestFor(meta, choices, facilities, today);
  try {
    const { blob, filename } = await api.opsReportExport(meta.key, { ...params, format: choices.format });
    saveBlob(blob, filename);
  } catch (err) {
    if (err?.status !== 404 && err?.status !== 405) throw err;
    if (choices.format !== 'csv') {
      const e = new Error(`${choices.format.toUpperCase()} files are not switched on yet. CSV works now.`);
      e.status = 404;
      throw e;
    }
    const data = await api.opsReport(meta.key, params);
    const where = facilitiesWords(params.facilityIds, facilities).replace(/ \(\d+\)$/, '');
    downloadCsv(csvName(data.title || meta.title, where, data.period?.to || data.asOf), (data.columns || []).map((c) => c.label), toCsvRows(data.columns || [], data.rows || []));
  }
}

export default function ReportRunDialog({ meta, mode = 'view', initial, facilities, today, onOpen, onClose }) {
  const [choices, setChoices] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setChoices((c) => ({ ...c, [k]: v }));
  const ok = choices.facilityIds.length > 0;

  const open = () => { saveChoices(meta.key, choices); onOpen(choices); };
  const download = async () => {
    saveChoices(meta.key, choices);
    setBusy(true); setError('');
    try {
      await downloadReport(meta, choices, facilities, today);
      onClose();
    } catch (err) {
      console.error('Operations report download failed', err);
      setError(err?.message || 'The file could not be prepared. Try again.');
    } finally { setBusy(false); }
  };

  const primaryDownload = mode === 'download';
  const footer = (
    <>
      {error && <p className="ops-form-error" role="alert" style={{ flex: '1 1 100%' }}>{error}</p>}
      <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
      <button type="button" className={primaryDownload ? 'secondary-btn' : 'primary-btn'} disabled={!ok} onClick={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Eye size={14} aria-hidden="true" /> Open in Nexus
      </button>
      <button type="button" className={primaryDownload ? 'primary-btn' : 'secondary-btn'} disabled={!ok || busy} onClick={download}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Download size={14} aria-hidden="true" /> {busy ? 'Preparing...' : 'Download'}
      </button>
    </>
  );

  return (
    <ReportModal title={meta.title} sub={meta.about} onClose={onClose} footer={footer}>
      <PeriodField meta={meta} value={choices.period} onChange={set('period')} today={today} />
      <FacilitiesField facilities={facilities} value={choices.facilityIds} onChange={set('facilityIds')} />
      <OptionsField meta={meta} value={choices.options} onChange={set('options')} />
      <FormatField value={choices.format} onChange={set('format')} />
    </ReportModal>
  );
}
