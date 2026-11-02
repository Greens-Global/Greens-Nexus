// The panel a form entry opens beside the list (Neil, 11/02/2026): the
// answers by section, the photos (opening the viewer), the location stamp as
// a map link, the signature, who sent it and when; then what a reviewer does
// with it - Reviewed / Needs Follow-Up / Close with a note (a person sets the
// state, never code), Make a Ticket / Make a Task through the existing create
// modals, the PDF, and the links the entry already has. Rendered in the
// Forms tab and by DocumentSidePanel for a library row of kind 'form_entry'.
import { useEffect, useMemo, useState } from 'react';
import { MapPin } from 'lucide-react';
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { formatDateTime } from '../lib/datetime';
import { StatusLabel } from '../components/StatusLabel';
import { PanelShell, saveBlob } from '../components/DocumentSidePanel';
import { AttachmentViewer } from '../tasks/components';
import { TicketComposer, TaskComposer } from './entryMounts';
import { REVIEW_ACTIONS, entryState, entryTitle, entryBody, entryFiles, formatAnswer, groupBySection, groupLabel, mapsLink } from './formsModel';

const go = (view, detail) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, ...detail } }));
// The linked ticket / task opens itself, not just its module - both halves of
// the bell's handoff (components/NotificationBell.jsx, lib/pendingOpen.js):
// the note for a module still loading, the event for one already up.
const openLinked = (kind, id) => {
  const detail = kind === 'ticket' ? { ticketId: id } : { taskId: id };
  go(kind === 'ticket' ? 'tickets' : 'tasks', detail);
  setPendingOpen(kind, id);
  setTimeout(() => window.dispatchEvent(new CustomEvent(`nexus:open-${kind}`, { detail })), 0);
};

function Photos({ label, urls, onOpen }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {urls.map((u, i) => (
        <button key={`${u}-${i}`} type="button" onClick={() => onOpen(u, `${label} ${i + 1}`)} title="Open the photo"
          style={{ padding: 0, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--mist)', cursor: 'zoom-in', width: 72, height: 72 }}>
          <img src={u} alt={`${label} ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function Value({ def, value, onOpen }) {
  if (value === undefined || value === null || value === '') return <span className="nx-dl-muted">-</span>;
  switch (def.type) {
    case 'photo':
      return Array.isArray(value) && value.length ? <Photos label={def.label || def.token} urls={value} onOpen={onOpen} /> : <span className="nx-dl-muted">No photo</span>;
    case 'signature':
      return <img src={value} alt={def.label || def.token} style={{ maxWidth: 220, maxHeight: 90, border: '1px solid var(--line)', borderRadius: 6, background: '#fff', display: 'block' }} />;
    case 'gps': {
      const href = mapsLink(value);
      const where = value.siteName || `${value.lat}, ${value.lng}`;
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-blue))' }}>
          <MapPin size={13} aria-hidden="true" /> {where}
          {value.accuracyM ? <span className="nx-dl-muted">(within {Math.round(value.accuracyM)} m)</span> : null}
        </a>
      ) : <span>{where}</span>;
    }
    default:
      return <span style={{ overflowWrap: 'anywhere' }}>{formatAnswer(def, value) || '-'}</span>;
  }
}

function RepeatRows({ group, fields, rows, onOpen }) {
  if (!rows.length) return <div className="nx-dl-muted">None added</div>;
  return (
    <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((row, i) => (
        <li key={`${group}-${i}`}>
          <dl className="nx-dl-facts">
            {fields.map((f) => <div key={f.token}><dt>{f.label || f.token}</dt><dd><Value def={f} value={row?.[f.token]} onOpen={onOpen} /></dd></div>)}
          </dl>
        </li>
      ))}
    </ol>
  );
}

function Answers({ defs, answers, onOpen }) {
  const known = new Set();
  const sections = groupBySection(defs).map(({ section, fields }) => {
    const items = [];
    const groups = new Set();
    for (const def of fields) {
      const g = def.repeat?.group;
      if (!g) { known.add(def.token); items.push({ key: def.token, label: def.label || def.token, node: <Value def={def} value={answers[def.token]} onOpen={onOpen} /> }); continue; }
      known.add(g);
      if (groups.has(g)) continue;
      groups.add(g);
      const members = fields.filter((f) => f.repeat?.group === g);
      members.forEach((m) => known.add(m.token));
      items.push({ key: `group:${g}`, label: groupLabel(g, members), wide: true,
        node: <RepeatRows group={g} fields={members} rows={Array.isArray(answers[g]) ? answers[g] : []} onOpen={onOpen} /> });
    }
    return { section, items };
  });
  // Answers the template no longer names (an older version, a renamed field).
  // `_location` is the submission's own stamp, shown with the facts above.
  const extra = Object.entries(answers || {}).filter(([k, v]) => !known.has(k) && k !== '_location' && v !== undefined && v !== null && v !== '');
  if (extra.length) sections.push({ section: defs.length ? 'Other Answers' : 'Answers', items: extra.map(([k, v]) => ({ key: k, label: k, node: <span style={{ overflowWrap: 'anywhere' }}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span> })) });
  if (!sections.length) return <div className="nx-dl-muted">No answers were recorded.</div>;
  return sections.map(({ section, items }) => (
    <section key={section} className="nx-dl-section">
      <h4>{section}</h4>
      {items.map((it) => (it.wide ? (
        <div key={it.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="nx-dl-muted">{it.label}</div>{it.node}
        </div>
      ) : (
        <dl key={it.key} className="nx-dl-facts"><div><dt>{it.label}</dt><dd>{it.node}</dd></div></dl>
      )))}
    </section>
  ));
}

function Review({ entry, onSaved, toastOk, toastErr }) {
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const next = await api.reviewFormEntry(entry.id, { status, note: note.trim() });
      toastOk?.(`${entryState(status).label} - ${entry.submittedByName || entry.submittedBy || 'the submitter'} is told`);
      setStatus(''); setNote('');
      await onSaved(next);
    } catch (e) { toastErr?.(e?.message || 'Could not save the review.'); }
    setBusy(false);
  };
  return (
    <section className="nx-dl-section">
      <h4>Review</h4>
      <div className="nx-dl-actions" role="group" aria-label="Review state">
        {REVIEW_ACTIONS.filter(([k]) => k !== entry.status).map(([k, label]) => (
          <button key={k} type="button" className={status === k ? 'primary-btn' : 'secondary-btn'} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {status && (
        <>
          <textarea className="form-input" rows={3} aria-label="Review note" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={status === 'follow_up' ? 'What needs doing' : 'A note for the submitter (optional)'} style={{ width: '100%', fontSize: 13 }} />
          <div className="nx-dl-actions">
            <button type="button" className="primary-btn" disabled={busy || (status === 'follow_up' && !note.trim())} onClick={save}>{busy ? 'Saving...' : 'Save Review'}</button>
            <button type="button" className="secondary-btn" onClick={() => { setStatus(''); setNote(''); }}>Cancel</button>
          </div>
        </>
      )}
      {entry.reviewNote && !status && (
        <div className="nx-dl-step"><i className={`nx-dl-dot nx-dl-${entryState(entry.status).tone}`} aria-hidden="true" />
          <div>{entry.reviewNote}<small>{entry.reviewerEmail}{entry.reviewedAt ? ` - ${formatDateTime(entry.reviewedAt)}` : ''}</small></div></div>
      )}
    </section>
  );
}

// A photo in the private bucket as a File, so it rides along as a task
// attachment; a photo that cannot be read stays a link in the body.
async function filesFor(urls) {
  const out = [];
  for (const u of urls.slice(0, 10)) {
    try {
      const { blob, filename } = await api.viewerBlob(u);
      const name = filename || decodeURIComponent(u.split('/').pop().split('?')[0]) || 'photo.jpg';
      out.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
    } catch { /* link only */ }
  }
  return out;
}

export default function EntryPanel({ entry: given, onClose, onChanged, toastOk, toastErr }) {
  const [entry, setEntry] = useState(given);
  const [defs, setDefs] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [composer, setComposer] = useState(null);   // { kind: 'ticket' | 'task', ...seed }
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    // The row may have come with answers; the fresh read is the truth.
    api.getFormEntry(given.id).then((e) => { if (live && e) setEntry(e); }).catch(() => {});
    return () => { live = false; };
  }, [given.id]);
  useEffect(() => {
    let live = true;
    if (!entry.templateId) { setDefs([]); return undefined; }
    api.getDocTemplate(entry.templateId).then((t) => { if (live) setDefs(t?.fieldDefs || []); }).catch(() => { if (live) setDefs([]); });
    return () => { live = false; };
  }, [entry.templateId]);

  const fieldDefs = useMemo(() => defs || [], [defs]);
  const answers = entry.answers || {};
  const state = entryState(entry.status);

  const refresh = async (next) => {
    if (next) setEntry(next);
    else await api.getFormEntry(entry.id).then((e) => e && setEntry(e)).catch(() => {});
    await onChanged?.();
  };
  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  };
  const download = () => run('pdf', async () => saveBlob(await api.formEntryPdf(entry.id), entry.title || 'form-entry'));

  const openTicket = () => setComposer({ kind: 'ticket', initial: { subject: entryTitle(entry), description: entryBody(entry, fieldDefs) } });
  const openTask = () => run('task', async () => {
    const files = await filesFor(entryFiles(fieldDefs, answers));
    setComposer({ kind: 'task', defaults: { title: entryTitle(entry), description: entryBody(entry, fieldDefs), files } });
  });
  const linked = (patch) => async (made) => {
    setComposer(null);
    const id = made?.id || made?.ticketId || made?.taskId;
    if (!id) return;
    try {
      const next = await api.linkFormEntry(entry.id, patch(id));
      toastOk?.(patch(id).ticketId ? 'Ticket made and linked' : 'Task made and linked');
      await refresh(next);
    } catch (e) { toastErr?.(e?.message || 'Made, but the link back to the entry did not save.'); }
  };

  const stamp = answers._location && typeof answers._location === 'object' ? answers._location : null;
  const facts = [
    ['Submitted By', entry.submittedByName || entry.submittedBy],
    ['Submitted', formatDateTime(entry.submittedAt)],
    ['Site', entry.workSiteName],
    ['Company', entry.company],
    ['Form', entry.templateVersion ? `Version ${entry.templateVersion}` : ''],
    ['From', entry.source === 'phone' ? 'A phone' : entry.source === 'web' ? 'The web' : ''],
    ['Reviewed', entry.reviewedAt ? `${formatDateTime(entry.reviewedAt)}${entry.reviewerEmail ? ` by ${entry.reviewerEmail}` : ''}` : ''],
  ].filter(([, v]) => v);

  return (
    <PanelShell title={entry.title || 'Form Entry'} onClose={onClose}
      subtitle={<StatusLabel label={state.label} color={state.color} size="sm" />}>
      <dl className="nx-dl-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        {stamp && <div><dt>Location</dt><dd><Value def={{ type: 'gps', label: 'Location' }} value={stamp} onOpen={() => {}} /></dd></div>}
      </dl>

      <div className="nx-dl-actions">
        <button type="button" className="secondary-btn" onClick={openTicket}>Make a Ticket</button>
        <button type="button" className="secondary-btn" disabled={busy === 'task'} onClick={openTask}>{busy === 'task' ? 'Gathering Photos...' : 'Make a Task'}</button>
        <button type="button" className="secondary-btn" disabled={busy === 'pdf'} onClick={download}>{busy === 'pdf' ? 'Preparing...' : 'Download PDF'}</button>
      </div>
      {(entry.linkedTicketId || entry.linkedTaskId || entry.linkedAssetId) && (
        <div className="nx-dl-actions" aria-label="Linked records">
          {entry.linkedTicketId && <button type="button" className="secondary-btn" onClick={() => openLinked('ticket', entry.linkedTicketId)}>Open Ticket</button>}
          {entry.linkedTaskId && <button type="button" className="secondary-btn" onClick={() => openLinked('task', entry.linkedTaskId)}>Open Task</button>}
          {entry.linkedAssetId && <button type="button" className="secondary-btn" onClick={() => go('property-asset', { sub: `a:${entry.linkedAssetId}:overview` })}>Open Asset</button>}
        </div>
      )}

      {defs === null ? <div className="nx-dl-muted">Reading the answers...</div>
        : <Answers defs={fieldDefs} answers={answers} onOpen={(url, name) => setViewing({ url, name, kind: 'image' })} />}

      {entry.canReview && <Review entry={entry} onSaved={refresh} toastOk={toastOk} toastErr={toastErr} />}
      {!entry.canReview && entry.reviewNote && (
        <section className="nx-dl-section"><h4>Review</h4><div>{entry.reviewNote}</div></section>
      )}

      {viewing && <AttachmentViewer att={viewing} onClose={() => setViewing(null)} />}
      {composer?.kind === 'ticket' && <TicketComposer initial={composer.initial} onClose={() => setComposer(null)} onCreated={linked((id) => ({ ticketId: id }))} />}
      {composer?.kind === 'task' && <TaskComposer defaults={composer.defaults} onClose={() => setComposer(null)} onCreated={linked((id) => ({ taskId: id }))} />}
    </PanelShell>
  );
}

