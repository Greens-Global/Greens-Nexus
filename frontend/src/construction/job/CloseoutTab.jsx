// The Job's Closeout tab (Neil, 11/03/2026, plan phase 2) - a placeholder
// until phase 3 (feat/construction-field) writes warranties, permits and the
// final inspection back to Asset Management and serials to Items. Until then
// it shows only what is real: the "Closeout" section of the job's own task
// project (the template's closeout checklist), nothing made up.
import { ClipboardCheck } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { StatusLabel } from '../../components/StatusLabel';
import { formatDate } from '../../lib/datetime';
import { CARD, TONE } from '../ui';
import Empty from '../Empty';
import { useLoad } from '../lib/job';
import { SetUp } from './PunchTab';

export default function CloseoutTab({ project }) {
  const { data: view, error, reload } = useLoad(() => api.getJobSchedule(project.id), project.id);
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!view) return <SkeletonBlocks count={3} height={56} borderRadius={8} />;
  if (!view.taskProject) return <SetUp view={view} project={project} onDone={reload} />;
  const sec = (view.sections || []).find((s) => s.name.trim().toLowerCase() === 'closeout');
  const rows = sec ? (view.tasks || []).filter((t) => t.sectionId === sec.id) : [];
  return (
    <div style={CARD}>
      <h3 style={{ fontSize: '1.05rem', marginBottom: 4 }}>Closeout</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 14px' }}>
        The closeout steps on the job's schedule. Handing warranties, permits and the final inspection to the
        property in Asset Management comes with the next release.
      </p>
      {rows.length === 0 ? (
        <Empty icon={ClipboardCheck} title="No closeout steps"
          hint="This job's schedule has no Closeout section. Add one in Tasks to track the handover here." />
      ) : rows.map((t) => (
        <div key={t.id} data-closeout={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border-color)' }}>
          <span style={{ minWidth: 0, fontSize: '0.88rem' }}>
            <b>{t.title}</b>
            {t.checklistTotal > 0 && <span style={{ color: 'var(--text-secondary)' }}> · {t.checklistDone} of {t.checklistTotal} checked</span>}
            {t.dueOn && <span style={{ color: 'var(--text-secondary)' }}> · Due {formatDate(t.dueOn, t.dueOn)}</span>}
          </span>
          <StatusLabel size="sm" label={t.completed ? 'Done' : 'Open'} color={t.completed ? TONE.green : TONE.slate} />
        </div>
      ))}
    </div>
  );
}
