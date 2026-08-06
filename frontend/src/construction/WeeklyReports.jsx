// Construction - weekly reports. The manager's 10 minutes.
//
// The screen is built around one claim: a manager should be able to read the
// draft, fix what is wrong, and publish, without leaving the page. So sections
// are edited inline rather than in a modal, and the AI's original is one click
// away on every section that was changed - a manager who cannot see what they
// overwrote will not trust the edit.
//
// Publishing is deliberately a separate, confirmed act. A published report is
// immutable server-side and an executive may act on it, so it does not share a
// button with "save my wording".
import { useCallback, useEffect, useState } from 'react';
import {
  FileText, Sparkles, Download, Send, RotateCcw, AlertTriangle, Lock, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../api';

const CARD = {
  backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: 'var(--shadow-sm)',
};

const STATUS = {
  draft:      { label: 'Draft',      bg: 'var(--border-color)',     fg: 'var(--text-secondary)' },
  in_review:  { label: 'In review',  bg: 'hsl(var(--color-blue))',  fg: '#fff' },
  approved:   { label: 'Approved',   bg: 'hsl(var(--color-green))', fg: '#fff' },
  published:  { label: 'Published',  bg: 'hsl(var(--color-green))', fg: '#fff' },
  superseded: { label: 'Superseded', bg: 'var(--border-color)',     fg: 'var(--text-secondary)' },
};

// Mirrors construction_report.SECTIONS - the four sections of the sample
// report. Keep the two in step; the server is the authority on order (it sends
// sectionOrder) and this map only supplies display labels.
const LABELS = {
  summary_of_progress: 'Summary of Progress',
  rfis_and_submittals: "RFI's and Submittals",
  cost_exposures: 'Cost Exposures',
  critical_milestones: 'Critical Milestones',
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
  critical_milestones: 'Assembled from the Milestones register.',
};

// Monday of the current week, jobsite-local. The server takes week_start and
// derives the end, so this must agree with how a crew thinks about "this week".
function thisMonday() {
  const d = new Date();
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Section({ sectionKey, section, locked, onChange }) {
  const [showAi, setShowAi] = useState(false);
  const label = LABELS[sectionKey] || sectionKey.replace(/_/g, ' ');
  const text = section?.text ?? section?.ai_text ?? '';
  const edited = !!section?.edited_at && section.text !== section.ai_text;
  const editable = EDITABLE.has(sectionKey) && !locked;

  // A section with no prose and no rows behind it is noise on this screen.
  if (!text && !editable && !(section?.sources || []).length) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: '0.9rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</strong>
        {edited && (
          <button type="button" onClick={() => setShowAi((v) => !v)}
            title="See what the AI originally wrote"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                     display: 'inline-flex', alignItems: 'center', gap: 3,
                     fontSize: '0.7rem', color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
            {showAi ? <ChevronDown size={11} /> : <ChevronRight size={11} />}edited
          </button>
        )}
        {(section?.sources || []).length > 0 && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            {section.sources.length} source{section.sources.length === 1 ? '' : 's'}
          </span>
        )}
        {/* Says where the text comes from, so a manager who cannot type here
            knows what to change instead of assuming the field is broken. */}
        {!editable && !locked && DERIVED_HINT[sectionKey] && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            {DERIVED_HINT[sectionKey]}
          </span>
        )}
      </div>

      {showAi && (
        <div style={{ marginBottom: 6, padding: '8px 10px', borderRadius: 6,
                      backgroundColor: 'var(--bg-primary)', border: '1px dashed var(--border-color)',
                      fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <Sparkles size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          {section.ai_text || '(the AI wrote nothing for this section)'}
        </div>
      )}

      {editable ? (
        <textarea className="form-input" rows={Math.min(10, Math.max(3, Math.ceil(text.length / 90)))}
          value={text} onChange={(e) => onChange(sectionKey, e.target.value)}
          style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: '0.85rem', lineHeight: 1.5 }} />
      ) : (
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, margin: 0, whiteSpace: 'pre-line',
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
      const r = await api.generateConstructionReport(project.id, { week_start: thisMonday() });
      setEdits({});
      setReports((prev) => [r, ...(prev || []).filter((x) => x.id !== r.id)]);
      setOpenId(r.id);
    } catch (e) {
      // Drafting spends model tokens over the network; a 502 here is far more
      // likely than a bug, so it says so rather than "something went wrong".
      setError(e.message || 'Could not draft the report. The AI service may be unavailable.');
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
    } catch (e) {
      setError(e.message || 'Could not publish the report.');
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
          <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>
            Weekly Reports
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            Drafted from approved daily logs. Edit, then publish.
          </p>
        </div>
        {canReview && (
          <button className="primary-btn" onClick={generate} disabled={!!busy}>
            <Sparkles size={15} />{busy === 'generate' ? 'Drafting…' : 'Generate This Week'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', marginBottom: 16,
                      borderRadius: 8, backgroundColor: 'hsl(var(--color-red) / 0.08)',
                      border: '1px solid hsl(var(--color-red) / 0.3)', fontSize: '0.85rem' }}>
          <AlertTriangle size={16} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button className="secondary-btn" style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={load}>Retry</button>
        </div>
      )}

      {reports === null ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          Loading reports&hellip;
        </div>
      ) : reports.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-secondary)' }}>
          <FileText size={30} style={{ opacity: 0.4, marginBottom: 12 }} />
          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            No reports yet
          </div>
          <p style={{ fontSize: '0.85rem', maxWidth: 460, margin: '0 auto' }}>
            A report is drafted from the daily logs a manager has approved this week. Approve some logs first, then generate.
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
                           borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem',
                           border: `1px solid ${on ? 'var(--pine)' : 'var(--border-color)'}`,
                           backgroundColor: on ? 'var(--bg-primary)' : 'transparent',
                           fontWeight: on ? 600 : 400 }}>
                  {r.weekStart}
                  {r.version > 1 && <span style={{ color: 'var(--text-secondary)' }}>v{r.version}</span>}
                  <span style={{ backgroundColor: s.bg, color: s.fg, fontSize: '0.65rem',
                                 padding: '1px 6px', borderRadius: 3, fontWeight: 600 }}>{s.label}</span>
                </button>
              );
            })}
          </div>

          {open && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{open.title}</strong>
                {locked && open.status === 'published' && (
                  <span title="A published report is immutable. Generate again to create a new version."
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem',
                             color: 'var(--text-secondary)' }}><Lock size={11} />locked</span>
                )}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 18 }}>
                {open.weekStart} to {open.weekEnd}
                {open.stats?.logs != null && ` · ${open.stats.logs} approved log${open.stats.logs === 1 ? '' : 's'}`}
                {open.stats?.crewDays ? ` · ${open.stats.crewDays} crew-days` : ''}
                {open.stats?.safetyFlags ? ` · ${open.stats.safetyFlags} safety flag${open.stats.safetyFlags === 1 ? '' : 's'}` : ''}
              </div>

              {order.map((k) => (
                <Section key={k} sectionKey={k} section={merged(k)} locked={locked}
                  onChange={(key, val) => setEdits((e) => ({ ...e, [key]: val }))} />
              ))}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20,
                            paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                <div style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {Object.keys(edits).length
                    ? `${Object.keys(edits).length} unsaved edit${Object.keys(edits).length === 1 ? '' : 's'}`
                    : open.publishedAt ? `Published by ${open.approvedBy}` : 'No unsaved changes'}
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
                    <button className="primary-btn" onClick={publish} disabled={!!busy}
                      title="Publishing freezes this report. Later edits create a new version.">
                      <Send size={15} />{busy === 'publish' ? 'Publishing…' : 'Publish'}
                    </button>
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
