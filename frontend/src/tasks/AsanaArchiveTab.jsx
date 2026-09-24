// Task Module - Manage -> Asana Archive (Sep 2026).
//
// The Asana integration is removed and the workspace is gone. Nothing Nexus
// imported was deleted - every task, comment and attachment is still here, and
// the Asana link records are kept as an archive. What this lists is the part
// that could NOT survive: rows that still only point at a file or page on
// Asana's servers, whose links are now dead. Read-only; backend asana_legacy.py.
import { useEffect, useState } from 'react';
import { Archive, FileWarning, Link2Off, MessageSquare, FileText } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, card, chip } from './theme';
import AsyncSection from '../components/AsyncState';

const KIND = {
  asana_file: { label: 'File Lost', color: NX.red, hint: 'The file itself was stored on Asana and was never copied into Nexus.' },
  asana_link: { label: 'Dead Link', color: NX.amber, hint: 'A link to an Asana page, or to a file Asana pointed at elsewhere (Drive, Dropbox) - that file may still exist there.' },
};

const openTask = (taskId) => {
  if (!taskId) return;
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine', taskId } }));
};

function Group({ title, icon: Icon, data, describe }) {
  const rows = data?.rows || [];
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', fontSize: 14.5, fontWeight: 700 }}>
        <Icon size={15} style={{ color: NX.dim }} /> {title}
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: data?.total ? NX.red : NX.green }}>
          {data?.total ?? 0}
        </span>
      </div>
      {rows.length > 0 && (
        <div style={{ borderTop: `1px solid ${NX.border}` }}>
          {rows.map((r, i) => {
            const k = KIND[r.kind] || KIND.asana_link;
            return (
              <div key={`${r.id || r.taskId}-${i}`} onClick={() => openTask(r.taskId)} title={k.hint}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: `1px solid ${NX.border2}`, cursor: r.taskId ? 'pointer' : 'default', fontSize: 13 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = NX.hover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <span style={{ ...chip(k.color, `${k.color}1a`), flexShrink: 0 }}>{k.label}</span>
                <span style={{ color: NX.faint, flexShrink: 0, fontSize: 12 }}>{r.taskCode || '-'}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.taskTitle || '(task no longer exists)'}{describe ? <span style={{ color: NX.dim }}> - {describe(r)}</span> : null}
                </span>
              </div>
            );
          })}
          {data.total > rows.length && (
            <div style={{ padding: '8px 16px', fontSize: 12, color: NX.faint }}>
              Showing the first {rows.length} of {data.total}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AsanaArchiveTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    api.getAsanaLegacyAudit()
      .then((d) => { if (live) { setData(d); setErr(''); } })
      .catch((e) => { if (live) setErr(e?.message || 'Could not load the Asana archive.'); });
    return () => { live = false; };
  }, [reload]);

  const lost = data ? data.attachments.total + data.descriptions.total + data.comments.total : 0;
  const archiveRows = data ? Object.values(data.archive || {}).reduce((n, v) => n + (v || 0), 0) : 0;

  return (
    <div style={{ fontFamily: FONT, color: NX.ink, display: 'grid', gap: 14 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 800 }}>
          <Archive size={18} /> Asana Archive
        </div>
        <div style={{ fontSize: 13, color: NX.dim, marginTop: 4, maxWidth: 760 }}>
          The Asana sync has been removed. Everything imported from Asana is still in Nexus, and the records of
          which Asana task each one came from are kept. The only things that could not be kept are files and links
          that still point at Asana, listed below. Click a row to open its task.
        </div>
      </div>
      <AsyncSection loading={!data && !err} error={!!err} errorMessage={err} onRetry={() => setReload((n) => n + 1)}>
        {data && (
          <>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
              {[
                { label: 'Tasks From Asana', value: data.syncedTasks, color: NX.ink },
                { label: 'Archived Link Records', value: archiveRows, color: NX.ink },
                { label: 'Rows Pointing At Asana', value: lost, color: lost ? NX.red : NX.green },
              ].map((s) => (
                <div key={s.label}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: NX.faint, textTransform: 'uppercase', letterSpacing: '.06em' }}>{s.label}</div>
                </div>
              ))}
            </div>
            <Group title="Attachments" icon={FileWarning} data={data.attachments} describe={(r) => r.name} />
            <Group title="Task Descriptions" icon={FileText} data={data.descriptions} />
            <Group title="Comments" icon={MessageSquare} data={data.comments} describe={(r) => r.author} />
            {lost === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: NX.green }}>
                <Link2Off size={14} /> Nothing in Nexus depends on Asana any more.
              </div>
            )}
          </>
        )}
      </AsyncSection>
    </div>
  );
}
