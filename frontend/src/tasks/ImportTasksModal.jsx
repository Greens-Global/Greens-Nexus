// Task Module - Import Tasks from CSV / Excel (Neil, Oct 22 2026).
//
// A four-step wizard in the shared Modal: Upload -> Map Columns -> Preview ->
// Done. The file is read here (importing.js); every decision about the rows -
// people, statuses, options, required fields, parents - is the server's, and
// the Preview IS its dry run (POST /tasks/import, dry_run), so what is shown
// is exactly what Import will do. Opened from the project screen, for
// editors and up (TasksWorkspace); the server checks again.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileSpreadsheet, Download, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Spinner } from '../components/AsyncState';
import { Modal, StatusChip, PriorityChip } from './components';
import { useTasks } from './TasksContext';
import { NX, btn, input as inputStyle } from './theme';
import { projectRoleWithTeams, roleAtLeast } from './lib';
import { formatDate } from '../lib/datetime';
import {
  IMPORT_FIELDS, CF, MAX_IMPORT_ROWS, autoMapHeaders, importableFields, fileProblem, readWorkbook,
  sheetTable, buildImportRows, skippedWithParent, errorReportCsv, downloadText, downloadTemplate,
} from './importing';

const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map Columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'done', label: 'Done' },
];
const PREVIEW_LIMIT = 300;
const newImportId = () => (globalThis.crypto?.randomUUID?.()
  || `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const labelStyle = { fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5, display: 'block' };
const th = { textAlign: 'left', fontSize: 11.5, fontWeight: 600, color: NX.dim, padding: '7px 9px', borderBottom: `1px solid ${NX.border}`, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: NX.surface };
const td = { padding: '7px 9px', borderBottom: `1px solid ${NX.border2}`, fontSize: 12.5, color: NX.ink, verticalAlign: 'top' };

function Steps({ step }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol aria-label="Import steps" style={{ display: 'flex', gap: 6, listStyle: 'none', margin: '0 0 16px', padding: 0, flexWrap: 'wrap' }}>
      {STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === at ? 'step' : undefined} style={{
          fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999,
          color: i === at ? NX.primary : i < at ? NX.ink : NX.faint,
          border: `1px solid ${i === at ? NX.primary : NX.border}`,
        }}>{i + 1}. {s.label}</li>
      ))}
    </ol>
  );
}

function Check({ checked, onChange, children, hint, disabled = false }) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: disabled ? NX.faint : NX.ink, cursor: disabled ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>{children}{hint && <span style={{ display: 'block', fontSize: 11.5, color: NX.faint, marginTop: 2 }}>{hint}</span>}</span>
    </label>
  );
}

export default function ImportTasksModal({ projectId, canManage = false, onClose, onViewImported }) {
  const store = useTasks();
  const { projects = [], teams = [], sections = [], customFields = [], nameOf = (e) => e, myEmail } = store;
  const [step, setStep] = useState('upload');
  const [file, setFile] = useState(null);
  const [workbook, setWorkbook] = useState(null);
  const [sheet, setSheet] = useState('');
  const [table, setTable] = useState(null);
  const [destId, setDestId] = useState(projectId || '');
  const [sectionId, setSectionId] = useState('');
  const [mapping, setMapping] = useState([]);
  const [createSections, setCreateSections] = useState(false);
  const [addOptions, setAddOptions] = useState(false);
  const [report, setReport] = useState(null);
  const [excluded, setExcluded] = useState(() => new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [notify, setNotify] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  // One id for this run of the wizard: the server refuses a second import
  // with it (409), so a retry after a timeout cannot import the file twice.
  const [importId] = useState(newImportId);

  // Only projects this person may add work to (the server's bar: editor).
  const destinations = useMemo(() => projects
    .filter((p) => !p.archived && roleAtLeast(projectRoleWithTeams(p, myEmail, canManage, teams), 'editor'))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
  [projects, teams, myEmail, canManage]);
  const project = projects.find((p) => p.id === destId) || null;
  const projectSections = useMemo(() => sections
    .filter((s) => s.projectId === destId && s.custom)
    .sort((a, b) => (a.position || 0) - (b.position || 0)), [sections, destId]);
  const fields = useMemo(() => importableFields(customFields, destId), [customFields, destId]);
  const fieldsById = useMemo(() => Object.fromEntries(fields.map((f) => [f.id, f])), [fields]);
  const targets = useMemo(() => [
    ...IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    ...fields.map((f) => ({ key: CF + f.id, label: f.name })),
  ], [fields]);

  const loadSheet = async (wb, name) => {
    const t = await sheetTable(wb, name);
    setTable(t);
    setMapping(autoMapHeaders(t.headers, importableFields(customFields, destId)));
    setReport(null);
    setExcluded(new Set());
  };

  const takeFile = async (f) => {
    setErr('');
    const problem = fileProblem(f);
    if (problem) { setErr(problem); return; }
    setBusy('read');
    try {
      const wb = await readWorkbook(f);
      const first = wb.SheetNames?.[0] || '';
      setFile(f);
      setWorkbook(wb);
      setSheet(first);
      await loadSheet(wb, first);
    } catch {
      setErr('That file could not be read. Save it as .xlsx or .csv and try again.');
      setFile(null); setWorkbook(null); setTable(null);
    } finally {
      setBusy('');
    }
  };

  // Ctrl+V of a copied file while the Upload step is showing.
  useEffect(() => {
    if (step !== 'upload') return undefined;
    const onPaste = (e) => {
      const f = Array.from(e.clipboardData?.files || [])[0];
      if (f) { e.preventDefault(); takeFile(f); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const rowCount = table?.rows?.length || 0;
  const tooMany = rowCount > MAX_IMPORT_ROWS;
  const hasTitle = mapping.includes('title');
  const mapsSection = mapping.includes('section');
  const mapsSelect = mapping.some((m) => m.startsWith(CF) && ['select', 'multiselect'].includes(fieldsById[m.slice(CF.length)]?.type));

  const request = (dry, excl = excluded) => ({
    project_id: destId, section_id: sectionId, file_name: file?.name || '', dry_run: dry, import_id: importId,
    notify_assignees: !dry && notify, create_sections: mapsSection && createSections,
    add_missing_options: canManage && mapsSelect && addOptions,
    rows: buildImportRows(table, mapping, fieldsById, excl),
  });

  const runPreview = async () => {
    setErr(''); setBusy('preview');
    try {
      // Every row, excluded or not: the preview is the whole file, and an
      // exclusion is applied when importing.
      const r = await store.importTasks(request(true, new Set()));
      setReport(r);
      setStep('preview');
    } catch (e) {
      setErr(e?.message || 'The preview could not be built.');
    } finally {
      setBusy('');
    }
  };

  const hidden = useMemo(() => skippedWithParent(report?.rows, excluded), [report, excluded]);
  const willImport = (report?.rows || []).filter((r) => !r.errors.length && !excluded.has(r.row) && !hidden.has(r.row)).length;

  const runImport = async () => {
    setErr(''); setBusy('import');
    try {
      // Excluded rows and the subtasks under them are not sent at all, so
      // each is counted once - here, not again as a server error.
      const r = await store.importTasks(request(false, new Set([...excluded, ...hidden])));
      setResult(r);
      setStep('done');
    } catch (e) {
      setErr(e?.message || 'The import may not have finished. Check the project before trying again.');
    } finally {
      setBusy('');
    }
  };

  const toggleRow = (n) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });

  const excludedRows = (report?.rows || []).filter((r) => excluded.has(r.row) || hidden.has(r.row));
  const skippedTotal = (result?.skipped || 0) + excludedRows.length;

  const footer = (() => {
    if (step === 'upload') {
      return (<>
        <button style={btn('ghost')} onClick={onClose}>Cancel</button>
        <button style={{ ...btn('primary'), opacity: table && rowCount && !tooMany && destId ? 1 : 0.5 }}
          disabled={!table || !rowCount || tooMany || !destId} onClick={() => setStep('map')}>Next</button>
      </>);
    }
    if (step === 'map') {
      return (<>
        <button style={btn('ghost')} onClick={() => setStep('upload')}>Back</button>
        <button style={{ ...btn('primary'), opacity: hasTitle && !busy ? 1 : 0.5 }} disabled={!hasTitle || !!busy} onClick={runPreview}>
          {busy === 'preview' ? <><Spinner size={14} color="currentColor" label="Checking" />Checking…</> : 'Preview'}
        </button>
      </>);
    }
    if (step === 'preview') {
      return (<>
        <button style={btn('ghost')} onClick={() => setStep('map')} disabled={!!busy}>Back</button>
        <button style={{ ...btn('primary'), opacity: willImport && !busy ? 1 : 0.5 }} disabled={!willImport || !!busy} onClick={runImport}>
          {busy === 'import' ? <><Spinner size={14} color="currentColor" label="Importing" />Importing…</> : `Import ${willImport} Task${willImport === 1 ? '' : 's'}`}
        </button>
      </>);
    }
    return (<>
      {skippedTotal > 0 && (
        <button style={btn('outline')} onClick={() => downloadText(errorReportCsv(result, excludedRows), `import-errors-${(file?.name || 'file').replace(/\.[^.]+$/, '')}.csv`)}>
          <Download size={14} />Download Error Report
        </button>
      )}
      <button style={btn('ghost')} onClick={onClose}>Close</button>
      {/* The list behind this dialog is the project it was opened from; tasks
          imported into another project are found by opening that one. */}
      {result?.created > 0 && result.projectId === projectId && (
        <button style={btn('primary')} onClick={() => onViewImported?.(result)}>View Imported Tasks</button>
      )}
    </>);
  })();

  return (
    // Not closable while the import is on the wire: closing would not stop
    // it, and the person would not see whether it landed.
    <Modal title="Import Tasks" onClose={() => { if (busy !== 'import') onClose(); }} footer={footer}>
      <Steps step={step} />
      {err && (
        <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', color: NX.red, fontSize: 13, marginBottom: 12 }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />{err}
        </div>
      )}

      {step === 'upload' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} className="nx-fill">
          <div
            role="button" tabIndex={0} aria-label="Choose a file to import"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) takeFile(f); }}
            style={{ border: `2px dashed ${NX.border}`, borderRadius: 12, padding: '28px 16px', textAlign: 'center', cursor: 'pointer', background: NX.surface2, flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 8, minHeight: 150 }}>
            {busy === 'read' ? <Spinner size={26} label="Reading the file" />
              : file ? <FileSpreadsheet size={28} style={{ color: NX.green }} /> : <Upload size={26} style={{ color: NX.faint }} />}
            <div style={{ fontSize: 14, fontWeight: 600, color: NX.ink }}>
              {file ? file.name : 'Drop a CSV or Excel file here'}
            </div>
            <div style={{ fontSize: 12.5, color: NX.dim }}>
              {file ? `${rowCount.toLocaleString('en-US')} row${rowCount === 1 ? '' : 's'} found` : 'or click to choose one, or press Ctrl+V to paste a copied file'}
            </div>
            <div style={{ fontSize: 11.5, color: NX.faint }}>.csv, .xlsx or .xls - up to {MAX_IMPORT_ROWS.toLocaleString('en-US')} rows and 5 MB</div>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" hidden data-testid="import-file"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) takeFile(f); }} />
          </div>
          {tooMany && (
            <div role="alert" style={{ fontSize: 13, color: NX.red }}>
              This sheet has {rowCount.toLocaleString('en-US')} rows. Split it into files of {MAX_IMPORT_ROWS.toLocaleString('en-US')} rows or fewer.
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {workbook && (workbook.SheetNames || []).length > 1 && (
              <label>
                <span style={labelStyle}>Sheet</span>
                <select value={sheet} style={inputStyle} onChange={async (e) => { setSheet(e.target.value); await loadSheet(workbook, e.target.value); }}>
                  {workbook.SheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            )}
            <label>
              <span style={labelStyle}>Project</span>
              <select value={destId} style={inputStyle} onChange={(e) => {
                setDestId(e.target.value); setSectionId('');
                if (table) setMapping(autoMapHeaders(table.headers, importableFields(customFields, e.target.value)));
              }}>
                {!destId && <option value="">Choose a project</option>}
                {destinations.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>
              <span style={labelStyle}>Default Section</span>
              <select value={sectionId} style={inputStyle} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">No Section</option>
                {projectSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: NX.dim }}>
            <button type="button" style={btn('outline')} disabled={!project} onClick={() => downloadTemplate(project, fields).catch(() => setErr('The template could not be built.'))}>
              <Download size={14} />Download Template
            </button>
            <span>An Excel file with this project&apos;s columns. Dates as MM/DD/YYYY; people by work email or name.</span>
          </div>
        </div>
      )}

      {step === 'map' && table && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} className="nx-fill">
          <div style={{ fontSize: 12.5, color: NX.dim }}>
            Match each column to a task field. Task Name is required; columns set to Don&apos;t Import are left out.
          </div>
          <div className="nx-fill nx-scroll" style={{ overflow: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Column</th><th style={th}>Example</th><th style={th}>Import As</th></tr></thead>
              <tbody>
                {table.headers.map((h, col) => {
                  const sample = table.rows.map((r) => String(r.text[col] ?? '').trim()).find(Boolean) || '';
                  const takenElsewhere = new Set(mapping.filter((m, i) => m && i !== col));
                  return (
                    <tr key={`${col}-${h}`}>
                      <td style={{ ...td, fontWeight: 600 }}>{h || `Column ${col + 1}`}</td>
                      <td style={{ ...td, color: NX.dim, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sample}</td>
                      <td style={td}>
                        <select aria-label={`Import ${h || `Column ${col + 1}`} as`} value={mapping[col] || ''} style={{ ...inputStyle, padding: '5px 8px', fontSize: 13, minWidth: 170 }}
                          onChange={(e) => setMapping((m) => m.map((x, i) => (i === col ? e.target.value : x)))}>
                          <option value="">Don&apos;t Import</option>
                          {targets.filter((t) => !takenElsewhere.has(t.key)).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!hasTitle && <div style={{ fontSize: 12.5, color: NX.red }}>Choose the column that holds the task name.</div>}
          {mapsSection && (
            <Check checked={createSections} onChange={setCreateSections} hint="Otherwise a section this project does not have is left out.">
              Create Sections That Don&apos;t Exist
            </Check>
          )}
          {mapsSelect && (
            <Check checked={addOptions} onChange={setAddOptions} disabled={!canManage}
              hint={canManage ? 'Values that are not an option yet are added to the field.' : 'Only a manager can add options. Values that are not an option are left empty.'}>
              Add Missing Options
            </Check>
          )}
        </div>
      )}

      {step === 'preview' && report && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} className="nx-fill">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
            <span><strong>{willImport}</strong> ready to import</span>
            {report.skipped > 0 && <span style={{ color: NX.red }}><strong>{report.skipped}</strong> with errors - will be skipped</span>}
            {report.rows.some((r) => r.warnings.length) && <span style={{ color: NX.amber }}><strong>{report.rows.filter((r) => r.warnings.length).length}</strong> with warnings</span>}
            {(report.newSections || []).length > 0 && <span style={{ color: NX.dim }}>New sections: {report.newSections.join(', ')}</span>}
            {(report.newOptions || []).length > 0 && <span style={{ color: NX.dim }}>New options: {report.newOptions.map((o) => `${o.field}: ${o.label}`).join(', ')}</span>}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Check checked={onlyProblems} onChange={setOnlyProblems}>Show Only Rows With Problems</Check>
            <Check checked={notify} onChange={setNotify} hint="Off: nobody is told. On: one notice per person for the whole import.">Notify Assignees</Check>
          </div>
          <div className="nx-fill nx-scroll" style={{ overflow: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr>
                <th style={th} aria-label="Include" />
                <th style={th}>Row</th><th style={th}>Task Name</th><th style={th}>Assignee</th>
                <th style={th}>Due</th><th style={th}>Status</th><th style={th}>Priority</th><th style={th}>Issues</th>
              </tr></thead>
              <tbody>
                {report.rows.filter((r) => !onlyProblems || r.errors.length || r.warnings.length).slice(0, PREVIEW_LIMIT).map((r) => {
                  const bad = r.errors.length > 0;
                  const off = bad || excluded.has(r.row) || hidden.has(r.row);
                  return (
                    <tr key={r.row} data-testid={`preview-row-${r.row}`} style={{ opacity: off ? 0.55 : 1 }}>
                      <td style={td}>
                        <input type="checkbox" aria-label={`Import row ${r.row}`} checked={!off} disabled={bad || hidden.has(r.row)} onChange={() => toggleRow(r.row)} />
                      </td>
                      <td style={{ ...td, color: NX.dim }}>{r.row}</td>
                      <td style={{ ...td, paddingLeft: 9 + (r.depth || 0) * 16, fontWeight: r.depth ? 400 : 600 }}>{r.title || <span style={{ color: NX.faint }}>No name</span>}</td>
                      <td style={td}>{(r.assignees || []).map((e) => nameOf(e)).join(', ')}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.dueOn ? formatDate(r.dueOn) : ''}</td>
                      <td style={td}><StatusChip status={r.status} /></td>
                      <td style={td}><PriorityChip priority={r.priority} /></td>
                      <td style={{ ...td, minWidth: 220 }}>
                        {r.errors.map((m) => <div key={m} style={{ color: NX.red }}>{m}</div>)}
                        {hidden.has(r.row) && !bad && <div style={{ color: NX.dim }}>Skipped with its parent row.</div>}
                        {r.warnings.map((m) => <div key={m} style={{ color: NX.amber }}>{m}</div>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {report.rows.length > PREVIEW_LIMIT && (
              <div style={{ padding: '8px 10px', fontSize: 12, color: NX.faint }}>
                Showing the first {PREVIEW_LIMIT} rows. Every row is checked and imported.
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }} className="nx-fill">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle2 size={26} style={{ color: NX.green }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink }}>
                Imported {result.created} Task{result.created === 1 ? '' : 's'}
              </div>
              <div style={{ fontSize: 13, color: NX.dim }}>
                into {project?.name || 'the project'} from {file?.name}.
                {result.projectId !== projectId && ' Open that project to see them.'}
              </div>
            </div>
          </div>
          {skippedTotal > 0 && (
            <div style={{ fontSize: 13, color: NX.dim }}>
              {skippedTotal} row{skippedTotal === 1 ? ' was' : 's were'} skipped. Download the error report to see why.
            </div>
          )}
          {(result.droppedPeople || []).length > 0 && (
            <div style={{ fontSize: 13, color: NX.amber }}>
              {result.droppedPeople.length === 1 ? 'One person was' : `${result.droppedPeople.length} people were`} left off because they are not in the Nexus directory, have left, or are in another company.
            </div>
          )}
          {(result.newSections || []).length > 0 && <div style={{ fontSize: 13, color: NX.dim }}>New sections: {result.newSections.join(', ')}</div>}
        </div>
      )}
    </Modal>
  );
}
