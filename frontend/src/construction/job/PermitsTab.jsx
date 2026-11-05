// Permits And Inspections (Round Two, 11/05/2026): the same records the
// Closeout tab hands over, live from day one - the permits pulled, each
// inspection's scheduled day and result. The day before an inspection the
// superintendent is belled; a Failed one bells the managers. Closeout still
// files them to the property.
import { ClipboardCheck } from 'lucide-react';
import { api } from '../../api';
import { ErrorBanner, SkeletonBlocks } from '../../components/AsyncState';
import { formatDate } from '../../lib/datetime';
import { useLoad } from '../lib/job';
import HandoverRecords from './HandoverRecords';

export default function PermitsTab({ project }) {
  const { data, error, reload } = useLoad(() => api.getJobCloseout(project.id), project.id);
  if (error) return <ErrorBanner message={error} onRetry={reload} />;
  if (!data) return <SkeletonBlocks count={2} height={56} borderRadius={8} />;
  const today = project.today || '';
  const ahead = (data.records || [])
    .filter((r) => r.kind === 'inspection' && ['', 'pending'].includes(r.result || '') && r.dueOn && r.dueOn >= today)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const failed = (data.records || []).filter((r) => r.kind === 'inspection' && r.result === 'failed').length;
  const next = ahead[0];
  const blurb = (
    <>
      {next ? <>Next inspection: <b>{next.title || 'Inspection'}</b> {formatDate(next.dueOn, next.dueOn)}{next.ahj ? ` with ${next.ahj}` : ''}. </> : 'No inspection scheduled. '}
      {failed > 0 ? `${failed} failed - schedule the re-inspection. ` : ''}
      The superintendent is belled the day before each inspection; a failed one bells the managers.
    </>
  );
  return (
    <HandoverRecords project={project} data={data} reload={reload} kinds={['permit', 'inspection']}
      title="Permits And Inspections" blurb={blurb} icon={ClipboardCheck} />
  );
}
