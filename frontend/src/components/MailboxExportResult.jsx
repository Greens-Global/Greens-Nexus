// The RESULT of a mailbox export, on the person's Documents tab (Neil, Oct 22
// 2026: "a mailbox export should only be in the off-boarding process"). The
// export is started only from Offboard / Change Status; this row only shows
// how it went and hands over the .zip. No export = nothing at all.
import { useEffect, useState } from 'react';
import { Mail, FileText } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';

export default function MailboxExportResult({ employeeId, toastErr }) {
  const [job, setJob] = useState(null);
  useEffect(() => { api.getMailboxExport(employeeId).then(setJob).catch(() => setJob(null)); }, [employeeId]);
  const active = job && (job.status === 'pending' || job.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { api.getExportStatus(job.id).then(setJob).catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [active, job?.id]);

  if (!job) return null;

  async function download() {
    try { const { url } = await api.getExportUrl(job.id); window.open(url, '_blank', 'noopener'); }
    catch (e) { toastErr?.(e?.message || 'Could not get the download link.'); }
  }
  const status = job.status === 'done' ? ['Ready', job.message, job.updatedAt && formatDate(job.updatedAt.slice(0, 10))].filter(Boolean).join(' · ')
    : job.status === 'error' ? `Failed · ${job.message || 'unknown reason'}`
    : job.total > 0 ? `Running · ${job.count} of ${job.total} messages`
    : 'Running · counting the mailbox';

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--muted)', textTransform: 'uppercase', flex: 1 }}>
          <Mail size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />Mailbox Export
        </span>
        {job.status === 'done' && (
          <button className="secondary-btn" onClick={download} style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px' }}>
            <FileText size={12} /> Download .zip
          </button>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: job.status === 'error' ? 'hsl(var(--color-red))' : 'var(--muted)' }}>{status}</div>
    </div>
  );
}
