// Construction - weekly reports. The manager's 10 minutes.
//
// The screen is built around one claim: a manager should be able to read the
// draft, fix what is wrong, and publish, without leaving the page. So sections
// are edited inline rather than in a modal, and the AI's original is one click
// away on every section that was changed - a manager who cannot see what they
// overwrote will not trust the edit.
//
// Publishing is deliberately a separate, confirmed act - pressed and held
// (ui/HoldButton.jsx, Neil Oct 30 2026). A published report is immutable
// server-side and an executive may act on it, so it does not share a button
// with "save my wording".
//
// 11/03/2026: the week is picked (the project's week, on the jobsite's clock -
// the server's `weekStart`, the same rule the Friday scheduler cuts by); a
// published week stays readable until its new version is published; nothing
// about AI shows while AI is off.
import { useCallback, useEffect, useState } from 'react';
import {
  FileText, Sparkles, Download, Send, RotateCcw, AlertTriangle, Lock, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { StatusLabel } from '../components/StatusLabel';
import HoldButton, { HOLD_RECORD_MS } from '../ui/HoldButton';
import { CARD, REPORT_STATUS as STATUS, personName } from './ui';
import { useConstructionMeta } from './lib/meta';
import { weekChoices } from './lib/weeks';
import { formatHoursWords } from '../lib/hoursText';

// Mirrors construction_report.SECTIONS - the four sections of the sample
// report. Keep the two in step; the server is the authority on order (it sends
// sectionOrder) and this map only supplies display labels.
const LABELS = {
  summary_of_progress: 'Summary of Progress',
  rfis_and_submittals: "RFI's and Submittals",
  cost_exposures: 'Cost Exposures',
  critical_milestones: 'Critical Milestones',
  // Real health (11/03/2026, phase 3) - all assembled from rows.
  job_health: 'Schedule and Health',
  punch_list: 'Punch List',
  change_orders: 'Change Orders',
  weather_and_delays: 'Weather and Delays',
};

// Sections the manager types into.
//
// Cost Exposures is editable because it is the ONLY way that section is ever
// filled: it cannot be derived from daily logs and the model is not allowed to
// guess at a number that lands in a pay application.
//
// The other two are assembled from the register tables on every generate, so an
// edit here would be silently overwritten the next time the report is redrafted.
// Change an RFI or a milestone in Schedule And Correspondence instead.
const EDITABLE = new Set(['summary_of_progress', 'cost_exposures']);

// Shown in place of an edit box on the row-derived sections, so a manager is not
// left wondering why the text is not selectable.
const DERIVED_HINT = {
  rfis_and_submittals: 'Assembled from the RFIs and Submittals registers.',
  critical_milestones: "Assembled from the job's schedule (its milestones in Tasks).",
  job_health: 'Late, At Risk or On Track from the dates, milestones and RFIs; crew-days from Time Clock punches.',
  punch_list: "Counted from the job's punch list.",
  change_orders: 'From the Changes tab - signed and pending change orders.',
  weather_and_delays: "Added up from the delay lines on the week's daily logs.",
};

// The photos and before / after pairs the report prints (11/03/2026): the
// week's approved logs' photos and job photos, and the pairs among them. A
// manager takes one out of a draft here; the photo log prints what stays.
function ReportPhotos({ project, report, locked, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getJobTimeline(project.id)).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData({ photos: [], pairs: [] }); });
    return () => { live = false; };
  }, [project.id, report.id]);
  if (!data) return null;
  const byId = Object.fromEntries((data.photos || []).map((p) => [p.id, p]));
  const pairs = (data.pairs || []).filter((pr) => (report.pairIds || []).includes(pr.id) && byId[pr.beforeId] && byId[pr.afterId]);
  const photos = (report.mediaIds || []).map((id) => byId[id]).filter((p) => p && p.kind === 'photo');
  if (!photos.length && !pairs.length) return null;
  const drop = async (patch) => {
    setBusy(true);
    try { onChanged(await api.updateConstructionReport(report.id, patch)); } finally { setBusy(false); }
  };
  const x = { position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,.6)', color: '#fff', border: 'none', borderRadius: 4, fontSize: 11, padding: '1px 6px', cursor: 'pointer' };
  return (
    <div style={{ marginTop: 6, marginBottom: 14 }} data-report-photos="">
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Photos in This Report</div>
      {pairs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 8 }}>
          {pairs.map((pr) => (
            <div key={pr.id} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, border: '1px solid var(--border-color)', borderRadius: 8, padding: 4 }}>
              {[['Before', byId[pr.beforeId]], ['After', byId[pr.afterId]]].map(([w, p]) => (
                <figure key={w} style={{ margin: 0 }}>
                  <img src={p.thumbnailUrl || p.url} alt={`${w} photo`} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 4 }} />
                  <figcaption style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{w}</figcaption>
                </figure>
              ))}
              {!locked && <button type="button" style={x} disabled={busy} aria-label="Leave this pair out"
                onClick={() => drop({ pair_ids: (report.pairIds || []).filter((i) => i !== pr.id) })}>Leave Out</button>}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6 }}>
        {photos.map((p) => (
          <div key={p.id} style={{ position: 'relative' }}>
            <img src={p.thumbnailUrl || p.url} alt={p.caption || 'Photo'} style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 6, display: 'block' }} />
            {!locked && <button type="button" style={x} disabled={busy} aria-label="Leave this photo out"
              onClick={() => drop({ media_ids: (report.mediaIds || []).filter((i) => i !== p.id) })}>Out</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ sectionKey, section, locked, onChange, showAiOriginal }) {
  const [showAi, setShowAi] = useState(false);
  const label = LABELS[sectionKey] || sectionKey.replace(/_/g, ' ');
  const text = section?.text ?? section?.ai_text ?? '';
  const edited = showAiOriginal && !!section?.edited_at && section.text !== section.ai_text;
  const editable = EDITABLE.has(sectionKey) && !locked;

  // A section with no prose and no rows behind it is noise on this screen.
  if (!text && !editable && !(section?.sources || []).length) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 15 }}>{label}</strong>
        {edited && (
          <button type="button" onClick={() => setShowAi((v) => !v)}
            title="See what the AI originally wrote"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                     display: 'inline-flex', alignItems: 'center', gap: 3,
                     fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
            {showAi ? <ChevronDown size={11} /> : <ChevronRight size={11} />}Edited
          </button>
        )}
        {(section?.sources || []).length > 0 && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {section.sources.length} source{section.sources.length === 1 ? '' : 's'}
          </span>
        )}
        {/* Says where the text comes from, so a manager who cannot type here
            knows what to change instead of assuming the field is broken. */}
        {!editable && !locked && DERIVED_HINT[sectionKey] && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            {DERIVED_HINT[sectionKey]}
          </span>
        )}
      </div>

      {showAi && (
        <div style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 6,
                      backgroundColor: 'var(--bg-primary)', border: '1px dashed var(--border-color)',
                      fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          {section.ai_text || '(the AI wrote nothing for this section)'}
        </div>
      )}

      {editable ? (
        <textarea className="form-input" rows={Math.min(10, Math.max(3, Math.ceil(text.length / 90)))}
          value={text} onChange={(e) => onChange(sectionKey, e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }} />
      ) : (
        <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0, whiteSpace: 'pre-line',
                    color: text ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
          {text || '(assembled from records at render time)'}
        </p>
      )}
    </div>
  );
}

export default function WeeklyReports({ project, canReview }) {
  const [reports, setReports] = useState(null);
  const [openId, setOpenId] = useState('');
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const { aiEnabled } = useConstructionMeta();
  const weeks = weekChoices(project);
  const [week, setWeek] = useState(weeks[0]);

  // openId is set functionally rather than read here: as a dependency it would
  // make every tab click re-run the effect and refetch the whole list.
  const load = useCallback(() => {
    setError('');
    api.getConstructionReports(project.id)
      .then((r) => { setReports(r); if (r.length) setOpenId((cur) => cur || r[0].id); })
      .catch((e) => { setReports([]); setError(e.message || 'Could not load reports.'); });
  }, [project.id]);

  useEffect(load, [load]);

  const open = (reports || []).find((r) => r.id === openId) || null;
  const locked = !open || open.status === 'published' || open.status === 'superseded' || !canReview;

  const generate = async () => {
    setBusy('generate'); setError('');
    try {
      const r = await api.generateConstructionReport(project.id, { week_start: week || weeks[0] });
      setEdits({});
      setReports((prev) => [r, ...(prev || []).filter((x) => x.id !== r.id)]);
      setOpenId(r.id);
    } catch (e) {
      setError(e.message || (aiEnabled ? 'Could not draft the report. The AI service may be unavailable.' : 'Could not draft the report.'));
    } finally { setBusy(''); }
  };

  const save = async () => {
    if (!open || !Object.keys(edits).length) return;
    setBusy('save'); setError('');
    try {
      const r = await api.updateConstructionReport(open.id, { sections: edits });
      setEdits({});
      setReports((prev) => (prev || []).map((x) => (x.id === r.id ? r : x)));
    } catch (e) {
      setError(e.message || 'Could not save your edits.');
    } finally { setBusy(''); }
  };

  const downloadPdf = async () => {
    if (!open) return;
    setBusy('pdf'); setError('');
    try {
      // The server renders on demand, so unsaved edits would not be in the file.
      // Flush them first rather than hand the manager a PDF of the draft they
      // just corrected.
      if (Object.keys(edits).length && !locked) {
        const r = await api.updateConstructionReport(open.id, { sections: edits });
        setEdits({});
        setReports((prev) => (prev || []).map((x) => (x.id === r.id ? r : x)));
      }
      const { blob, filename } = await api.exportConstructionReportPdf(open.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || 'Could not render the PDF.');
    } finally { setBusy(''); }
  };

  // Held, not clicked (HoldButton): the button finishes only when the server
  // did; a refusal shows under it. The week's earlier published version steps
  // aside on the server, so the list is read again.
  const publish = async () => {
    if (!open) return;
    setBusy('publish'); setError('');
    try {
      // Unsaved edits would be lost behind an immutable report, so they go first.
      if (Object.keys(edits).length) {
        await api.updateConstructionReport(open.id, { sections: edits });
        setEdits({});
      }
      const r = await api.publishConstructionReport(open.id);
      setReports((prev) => (prev || []).map((x) => (x.id === r.id ? r : x)));
      load();
    } finally { setBusy(''); }
  };

  const sections = open?.sections || {};
  const order = open?.sectionOrder || Object.keys(sections);
  const merged = (key) => (key in edits
    ? { ...(sections[key] || {}), text: edits[key] }
    : sections[key]);

  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <h3 style={{ fontSize: 18, marginBottom: 4 }}>
            Weekly Reports
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            Drafted from approved daily logs. Edit, then publish.
          </p>
        </div>
        {canReview && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label htmlFor="report-week" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Week</label>
            <select id="report-week" className="form-input" value={week} onChange={(e) => setWeek(e.target.value)}
              style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}>
              {weeks.map((w, i) => (
                <option key={w} value={w}>{i === 0 ? `This Week (${formatDate(w, w)})` : `Week of ${formatDate(w, w)}`}</option>
              ))}
            </select>
            <button className="primary-btn" onClick={generate} disabled={!!busy}>
              {aiEnabled && <Sparkles size={15} />}{busy === 'generate' ? 'Drafting…' : 'Draft Report'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', marginBottom: 16,
                      borderRadius: 8, backgroundColor: 'hsl(var(--color-red) / 0.08)',
                      border: '1px solid hsl(var(--color-red) / 0.3)', fontSize: 13 }}>
          <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="secondary-btn" style={{ padding: '4px 12px', fontSize: 13 }} onClick={load}>Retry</button>
        </div>
      )}

      {reports === null ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          Loading reports&hellip;
        </div>
      ) : reports.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
          <FileText size={30} style={{ opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            No reports yet
          </div>
          <p style={{ fontSize: 13, maxWidth: 460, margin: '0 auto' }}>
            A report is drafted from the daily logs a manager has approved that week. Approve some logs first, then draft it.
          </p>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
            {reports.map((r) => {
              const s = STATUS[r.status] || STATUS.draft;
              const on = r.id === openId;
              return (
                <button key={r.id} type="button" onClick={() => { setOpenId(r.id); setEdits({}); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                           borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                           border: `1px solid ${on ? 'var(--pine)' : 'var(--border-color)'}`,
                           backgroundColor: on ? 'var(--bg-primary)' : 'transparent',
                           fontWeight: on ? 600 : 400 }}>
                  {formatDate(r.weekStart, r.weekStart)}
                  {r.version > 1 && <span style={{ color: 'var(--text-secondary)' }}>v{r.version}</span>}
                  <StatusLabel size="sm" label={s.label} color={s.color} />
                </button>
              );
            })}
          </div>

          {open && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}>{open.title}</strong>
                {locked && open.status === 'published' && (
                  <span title="A published report is immutable. Generate again to create a new version."
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem',
                             color: 'var(--text-secondary)' }}><Lock size={11} />Locked</span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18 }}>
                {formatDate(open.weekStart, open.weekStart)} to {formatDate(open.weekEnd, open.weekEnd)}
                {open.stats?.logs != null && ` · ${open.stats.logs} approved log${open.stats.logs === 1 ? '' : 's'}`}
                {open.stats?.crewDaysPunched ? ` · ${open.stats.crewDaysPunched} crew-days from punches` : open.stats?.crewDays ? ` · ${open.stats.crewDays} crew-days` : ''}
                {open.stats?.weatherDelayHours ? ` · ${formatHoursWords(open.stats.weatherDelayHours, { compact: true })} weather delay` : ''}
                {aiEnabled && open.stats?.safetyFlags ? ` · ${open.stats.safetyFlags} safety flag${open.stats.safetyFlags === 1 ? '' : 's'}` : ''}
              </div>

              <ReportPhotos project={project} report={open} locked={locked}
                onChanged={(r) => setReports((prev) => (prev || []).map((x) => (x.id === r.id ? r : x)))} />

              {order.map((k) => (
                <Section key={k} sectionKey={k} section={merged(k)} locked={locked}
                  showAiOriginal={aiEnabled && !!open.aiWritten}
                  onChange={(key, val) => setEdits((e) => ({ ...e, [key]: val }))} />
              ))}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20,
                            paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                <div style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {Object.keys(edits).length
                    ? `${Object.keys(edits).length} unsaved edit${Object.keys(edits).length === 1 ? '' : 's'}`
                    : open.publishedAt ? `Published by ${open.approvedByName || personName(open.approvedBy)}` : 'No unsaved changes'}
                </div>
                <button className="secondary-btn" onClick={downloadPdf} disabled={!!busy}>
                  <Download size={15} />{busy === 'pdf' ? 'Rendering…' : 'PDF'}
                </button>
                {!locked && (
                  <>
                    {Object.keys(edits).length > 0 && (
                      <button className="secondary-btn" onClick={() => setEdits({})} disabled={!!busy}>
                        <RotateCcw size={15} />Discard
                      </button>
                    )}
                    <button className="secondary-btn" onClick={save}
                      disabled={!!busy || !Object.keys(edits).length}>
                      {busy === 'save' ? 'Saving…' : 'Save'}
                    </button>
                    <span title="Publishing freezes this report and sends it to the executives. Later edits create a new version.">
                      <HoldButton label="Publish" doneLabel="Published" icon={Send} holdMs={HOLD_RECORD_MS} className="nx-hold-send"
                        disabled={!!busy && busy !== 'publish'} onConfirm={publish}
                        fallbackMessage="Publish this report? It is frozen and sent to the executives." />
                    </span>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
