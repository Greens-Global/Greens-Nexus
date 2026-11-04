// Start Job / Open Job on a ticket (Neil, 11/03/2026, construction plan phase
// 2): Tickets ARE the maintenance work orders, and a ticket gets a Job when
// it needs a crew, materials or more than a day. One button in the ticket's
// footer (the desk's side pane and the popup alike): Start Job for a manager
// while the ticket has no job, Open Job once it has one. The job is a Work
// Order prefilled from the ticket on the server (routers/construction_jobs.py
// start_job); the ticket keeps its SLA and its queue, and its status follows
// the job's both ways (construction_ticket_sync.py). Never on an Ask HR
// ticket - the caller does not render this for one.
import { useEffect, useState } from 'react';
import { HardHat } from 'lucide-react';
import { api } from '../api';
import { btn } from '../tasks/theme';
import { dialog as appDialog } from '../ui/dialog';

const openJob = (id) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'ops', sub: `project:${id}` } }));

export default function TicketJobAction({ ticketId, onOpen }) {
  const [state, setState] = useState(null);   // { jobs, canStart } | null while loading / unavailable
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getTicketJobs?.(ticketId))
      .then((r) => { if (live) setState(r || null); })
      .catch(() => { if (live) setState(null); });
    return () => { live = false; };
  }, [ticketId]);
  if (!state) return null;
  const job = (state.jobs || [])[0];
  if (job) {
    return (
      <button type="button" style={btn('outline')} data-ticket-job={job.id} title={`Open the job ${job.name}`}
        onClick={() => { onOpen?.(); openJob(job.id); }}>
        <HardHat size={14} /> Open Job
      </button>
    );
  }
  if (!state.canStart) return null;
  const start = async () => {
    if (!(await appDialog.confirm('Start a Work Order job from this ticket? It takes the ticket\'s title, description, property and photos, and the ticket is resolved when the job is complete.',
      { title: 'Start Job', confirmText: 'Start Job' }))) return;
    setBusy(true);
    try {
      const r = await api.startJobFromTicket(ticketId, {});
      onOpen?.();
      openJob(r.job.id);
    } catch (e) {
      appDialog.alert(`Could not start the job: ${e.message || e}`);
    }
    setBusy(false);
  };
  return (
    <button type="button" style={btn('outline')} disabled={busy} onClick={start} data-start-job=""
      title="This needs a crew, materials or more than a day - give it a Job">
      <HardHat size={14} /> {busy ? 'Starting…' : 'Start Job'}
    </button>
  );
}
