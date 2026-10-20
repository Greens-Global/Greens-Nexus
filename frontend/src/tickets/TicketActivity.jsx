// TicketActivity - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, Zap, Lock } from 'lucide-react';
import { api } from '../api';
import { richBodyHtml } from '../tasks/lib';
import { formatDateTime } from '../lib/datetime';
import { NX, chip, PRIORITY_META } from '../tasks/theme';
import { Avatar } from '../tasks/components';
import {
  TICKET_TYPE_META, TYPE_FIELDS,
  SERVICE_FIELDS, serviceAreaLabel,
  allTopicQuestionDefs, labelFromKey,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_KEY, HELP_SUBTOPIC_LABEL } from './ticketMeta';
import { SkeletonBlocks } from '../components/AsyncState';
import { hasRichText, readOnlyFieldValue } from './ticketViewShared';

// The field key from a "created" snapshot's typeFields (see _ticket_snapshot
// in backend/routers/tickets.py) back to its question definition, so the
// snapshot can use the SAME label the Overview tab shows for that field
// today - checked against the type's own fields first, then every service
// question (an app/type re-pick since then can leave a key that no longer
// belongs to either, but the snapshot must still show what was asked at the
// time), falling back to the raw key if nothing matches at all.
function auditFieldDef(type, key) {
  return (TYPE_FIELDS[type] || []).find((f) => f.key === key)
    || allTopicQuestionDefs().find((f) => f.key === key)
    || Object.values(SERVICE_FIELDS).flat().find((f) => f.key === key)
    || (key === HELP_SUBTOPIC_KEY ? { key, label: HELP_SUBTOPIC_LABEL, type: 'text' } : null)
    || { key, label: key.startsWith('svc_') ? labelFromKey(key) : key, type: 'text' };
}

// The original submission, exactly as raised - see _ticket_snapshot on the
// backend. A permanent, un-editable audit copy: if a requester's mistake in
// any of these gets corrected later, this card is the proof of what the
// ticket originally said (Pranshu, Sept 8 2026).
function CreatedSnapshotCard({ snapshot, nameOf, companies, allDepts }) {
  const rows = [
    ['Type', TICKET_TYPE_META[snapshot.type]?.label || snapshot.type || '-'],
    ['Priority', PRIORITY_META[snapshot.priority]?.label || snapshot.priority || '-'],
    ['Help With', snapshot.application || '-'],
    ['Service Area', serviceAreaLabel(snapshot.serviceArea) || '-'],
    ['Department', allDepts.find((d) => d.id === snapshot.hrDepartmentId)?.name || '-'],
    ['Company', companies.find((c) => c.id === snapshot.companyId)?.name || '-'],
  ];
  const tfKeys = Object.keys(snapshot.typeFields || {});
  return (
    <div style={{ border: `1px dashed ${NX.border}`, borderRadius: 10, padding: 12, background: NX.surface2 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: NX.dim, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ClipboardList size={13} /> Original request (unedited)
      </div>
      <div style={{ marginBottom: snapshot.description ? 8 : 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Title</div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: NX.ink }}>{snapshot.subject || '-'}</div>
      </div>
      {hasRichText(snapshot.description) && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: NX.faint, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Description</div>
          <div className="nx-rich-body" style={{ fontSize: 13, color: NX.dim }}
            dangerouslySetInnerHTML={{ __html: richBodyHtml(snapshot.description, nameOf) }} />
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12.5 }}>
        {rows.map(([k, v]) => (
          <div key={k}><span style={{ color: NX.faint }}>{k}: </span><span style={{ color: NX.ink }}>{v}</span></div>
        ))}
        {tfKeys.map((k) => {
          const f = auditFieldDef(snapshot.type, k);
          return (
            <div key={k}><span style={{ color: NX.faint }}>{f.label}: </span><span style={{ color: NX.ink }}>{readOnlyFieldValue(f, snapshot.typeFields[k], nameOf)}</span></div>
          );
        })}
      </div>
    </div>
  );
}

// ── Activity log ─────────────────────────────────────────────────────────────
// Server-side already drops the notification/auto-close "system" bookkeeping
// (ticket_notify.py) before this ever sees it - what's left is exactly the
// "who changed what, when" trail the ticket asks for: status/priority/
// assignee moves, field corrections (subject/description/department/
// application/service area/resolution/type-specific answers), comments,
// attachments and approvals, each with a real actor and timestamp. The
// "created" entry is the one exception - rendered as the original-submission
// audit card above, not a one-line "created this ticket".
function TicketActivity({ ticketId, nameOf, companies = [], allDepts = [] }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.getTicketActivity(ticketId).then(setRows).catch(() => setRows([])); }, [ticketId]);
  if (rows === null) return <div style={{ padding: '6px 0' }}><SkeletonBlocks count={4} height={44} /></div>;
  if (rows.length === 0) return <div style={{ fontSize: 13, color: NX.faint, textAlign: 'center', padding: 16 }}>No activity yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((a) => {
        // A row logged before this snapshot existed just has the old plain
        // "created this ticket" text - shown as a normal line rather than a
        // broken card when it isn't valid JSON.
        let snapshot = null;
        if (a.type === 'created') {
          try { snapshot = JSON.parse(a.detail); } catch { /* pre-existing plain-text row */ }
        }
        // Same fallback for "commented" rows logged before the preview
        // existed - those are still the old plain "commented" / "added an
        // internal note" string and render as-is.
        let comment = null;
        if (a.type === 'commented') {
          try { comment = JSON.parse(a.detail); } catch { /* pre-existing plain-text row */ }
        }
        // A deleted comment is logged as JSON too ({internal, text, ...}) -
        // never with the comment's words; show its `text` and the Internal chip.
        let removed = null;
        if (a.type === 'comment_deleted') {
          try { removed = JSON.parse(a.detail); } catch { /* plain-text row */ }
        }
        // Default assignee (Oct 2026): written by Nexus, not by a person, so
        // the line is the sentence itself - "Assigned to Sam Patel
        // automatically (help topic: Printer or Scanner)".
        if (a.type === 'auto_assigned' || a.type === 'auto_assign_gap') {
          const gap = a.type === 'auto_assign_gap';
          return (
            <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <span aria-hidden style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                background: gap ? 'rgba(245,158,11,0.16)' : NX.surface2, color: gap ? NX.amber : NX.dim }}>
                {gap ? <AlertTriangle size={12} /> : <Zap size={12} />}
              </span>
              <span style={{ color: gap ? NX.amber : NX.dim, fontWeight: gap ? 600 : 400 }}>{a.detail}</span>
              <span style={{ color: NX.faint, marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</span>
            </div>
          );
        }
        return (
          <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <Avatar email={a.actorId} name={nameOf(a.actorId)} size={22} />
              <span style={{ color: NX.ink, fontWeight: 600 }}>{nameOf(a.actorId) || a.actorId || 'Someone'}</span>
              <span style={{ color: NX.dim }}>
                {snapshot ? 'created this ticket' : comment ? (comment.internal ? 'added an internal note' : 'commented') : removed ? (removed.text || 'deleted a comment') : a.detail}
              </span>
              {(comment?.internal || removed?.internal) && <span style={{ ...chip(NX.amber, 'rgba(245,158,11,0.16)'), display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px' }}><Lock size={10} /> Internal</span>}
              <span style={{ color: NX.faint, marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</span>
            </div>
            {snapshot && <CreatedSnapshotCard snapshot={snapshot} nameOf={nameOf} companies={companies} allDepts={allDepts} />}
            {comment && (
              <div style={{
                marginLeft: 30, fontSize: 13, color: NX.ink, whiteSpace: 'pre-wrap', padding: '6px 10px', borderRadius: 8,
                background: comment.internal ? 'rgba(245,158,11,0.08)' : NX.surface2,
                border: `1px solid ${comment.internal ? 'rgba(245,158,11,0.3)' : NX.border2}`,
              }}>{comment.preview}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { TicketActivity };
