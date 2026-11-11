// Edit Job (Neil, 11/03/2026, plan item 7). Crew, managers, executives,
// phase, percent complete and the property link could only be set when a job
// was created, so workers never got in and published reports went to nobody.
//
// A sheet from the right (the shared Modal), Settings-style rows
// (components/settings/SettingsUI.jsx - title and description left, the
// control right) and ONE Save row at the foot (components/SaveRow.jsx, the
// draft beside the saved value - lib/useDraft.js). People come from the
// curated Nexus People list (getPeopleDirectory), never M365. Contract value
// shows only to the people the server gave it to (it is absent otherwise),
// and the property list is Asset Management's, private ones only for those
// who may see them (the server's /ticket-properties). The Books rows (the
// job's Intacct Project-Job and entity, plan phase 4) show only to managers
// with Accounting access (BooksRows; saved with the same one Save).
import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import { Modal, DateField, PersonMultiSelect } from '../tasks/components';
import { SettingRow, SettingCard, NumberBox } from '../components/settings/SettingsUI';
import SaveRow from '../components/SaveRow';
import { ErrorBanner } from '../components/AsyncState';
import WorkSiteLinkPanel from '../components/WorkSiteLinkPanel';
import { googleMapsUrl } from '../lib/addressSearch';
import { useDraft } from '../lib/useDraft';
import { PROJECT_STATUS } from './ui';
import BooksRows from './BooksRows';
import ClientRows from './ClientRows';
import LaborCodesRows from './LaborCodesRows';
import { useClientDraft, useLaborCodesDraft } from './lib/client';
import { JOB_TYPE } from './lib/job';
import { useBooksDraft } from './lib/money';
import { useNexusPeople, useProperties, savedOf, changesFor, invalidReason, targetMoved } from './lib/jobForm';

export default function EditJobSheet({ project, money = null, onClose, onSaved }) {
  const canCost = Object.prototype.hasOwnProperty.call(project, 'contractValue');
  const saved = useMemo(() => savedOf(project), [project]);
  const { draft, patch, dirty: jobDirty, reset: resetJob } = useDraft(saved);
  const books = useBooksDraft(project, money);
  // Round Three item 2 (11/11/2026): the client, an Intacct customer - its own call under the one Save.
  const client = useClientDraft(project, books.show);
  // Round Three item 3: the labor cost codes, with the Books rows' gate.
  const labor = useLaborCodesDraft(project, books.show);
  const dirty = jobDirty || books.dirty || client.dirty || labor.dirty;
  const reset = () => { resetJob(); books.reset(); client.reset(); labor.reset(); };
  const people = useNexusPeople();
  const properties = useProperties();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invalid = invalidReason(draft, saved) || books.invalid || client.invalid;
  const moved = targetMoved(saved, draft);

  const save = async () => {
    if (!dirty || busy || invalid) return;
    setBusy(true); setError('');
    try {
      const next = jobDirty ? await api.updateConstructionProject(project.id, changesFor(saved, draft, { canCost })) : project;
      if (books.dirty) await books.save();
      if (client.dirty) await client.save();
      if (labor.dirty) await labor.save();
      setBusy(false);
      onSaved?.(next);
    } catch (e) {
      setBusy(false);
      setError(e.message || 'Could not save the job.');
    }
  };

  const propertyOptions = (properties || []).map((p) => ({
    id: p.id, label: p.parentName ? `${p.parentName} - ${p.name}` : p.name,
    hint: [p.city, p.state].filter(Boolean).join(', '),
  }));
  const linked = draft.propertyId && !propertyOptions.some((o) => o.id === draft.propertyId);
  const hasPoint = !!(Number(draft.latitude) && Number(draft.longitude));

  return (
    <Modal title="Edit Job" onClose={onClose} width={720} isDirty={dirty} onSave={save}>
      {error && <ErrorBanner message={error} onRetry={() => setError('')} />}
      {/* flexShrink 0: the sheet body is a flex column, and a card allowed to
          shrink there clips its own rows. */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
      <SettingCard>
        <SettingRow title="Name" htmlFor="job-name"
          control={<input id="job-name" aria-label="Name" className="form-input" style={{ width: 'min(280px, 52vw)' }} value={draft.name}
            onChange={(e) => patch({ name: e.target.value })} />} />
        <SettingRow title="Job Type" htmlFor="job-type" desc="A Work Order shows its steps, field record and closeout; a Project every section."
          control={(
            <select id="job-type" aria-label="Job Type" className="form-input" value={draft.jobType} onChange={(e) => patch({ jobType: e.target.value })} style={{ width: 150 }}>
              {Object.entries(JOB_TYPE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          )} />
        <SettingRow title="Jobsite" desc="Paste the jobsite's Google Maps link - the weather is read at that exact point.">
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <WorkSiteLinkPanel link={project.latitude && project.longitude ? 'placed' : ''} point={null} resolve={api.resolveProjectLink} what="jobsite"
              onResolved={({ point }) => patch({
                latitude: point.lat.toFixed(6), longitude: point.lng.toFixed(6),
                address: point.address || draft.address,
              })} />
            <label htmlFor="job-address" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>Address</label>
            <input id="job-address" aria-label="Address" className="form-input" value={draft.address}
              onChange={(e) => patch({ address: e.target.value })} placeholder="Street, City, State ZIP" />
            {hasPoint && (
              <a href={googleMapsUrl(draft.latitude, draft.longitude)} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                Open in Google Maps <ExternalLink size={11} />
              </a>
            )}
          </div>
        </SettingRow>
        <SettingRow title="Status" htmlFor="job-status" desc="On Hold and Complete jobs get no weather notices or weekly drafts."
          control={(
            <select id="job-status" aria-label="Status" className="form-input" value={draft.status} onChange={(e) => patch({ status: e.target.value })} style={{ width: 150 }}>
              {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          )} />
        <SettingRow title="Phase" htmlFor="job-phase" desc="Foundation, Framing, Finishes..."
          control={<input id="job-phase" aria-label="Phase" className="form-input" style={{ width: 'min(200px, 40vw)' }} value={draft.phase}
            onChange={(e) => patch({ phase: e.target.value })} placeholder="e.g. Framing" />} />
        <SettingRow title="Percent Complete" desc="The superintendent's judgment against the schedule."
          control={<NumberBox value={draft.percentComplete} min={0} max={100} unit="%" label="Percent Complete"
            onChange={(v) => patch({ percentComplete: v })} />} />
        <SettingRow title="Start" desc="The day work began on site."
          control={<DateField value={draft.startOn} onChange={(v) => patch({ startOn: v || '' })} placeholder="Pick a Date" title="Start" />} />
        <SettingRow title="Target Finish" desc="A job past this day and not complete reads Late."
          control={<DateField value={draft.targetFinishOn} onChange={(v) => patch({ targetFinishOn: v || '' })} placeholder="Pick a Date" title="Target Finish" />} />
        {moved && (
          <SettingRow title="Why Did It Move?" htmlFor="job-move-reason" desc="Kept on the record and said on the health row and the weekly report.">
            <input id="job-move-reason" aria-label="Why Did It Move?" className="form-input" style={{ width: '100%' }} value={draft.changeReason}
              onChange={(e) => patch({ changeReason: e.target.value })} placeholder="e.g. Rain, inspection failed, owner change" maxLength={300} />
          </SettingRow>
        )}
        <SettingRow title="Units" desc="Storage units in the finished building - for cost per unit."
          control={<NumberBox value={draft.units} min={0} max={100000} width={96} label="Units" onChange={(v) => patch({ units: v })} />} />
        <SettingRow title="Square Feet" desc="Gross building area - for cost per square foot."
          control={<NumberBox value={draft.squareFeet} min={0} max={10000000} width={110} unit="sq ft" label="Square Feet" onChange={(v) => patch({ squareFeet: v })} />} />
        {canCost && (
          <SettingRow title="Contract Value" htmlFor="job-cv" desc="Managers only - never shown to the crew."
            control={(
              <span className="nx-set-number">
                <span className="nx-set-number-unit">$</span>
                <input id="job-cv" aria-label="Contract Value" className="form-input" type="number" min={0} step="1" style={{ width: 140 }}
                  value={draft.contractValue} onChange={(e) => patch({ contractValue: e.target.value })} />
              </span>
            )} />
        )}
        <SettingRow title="Property" htmlFor="job-property" desc="The Asset Management property this job is on.">
          <select id="job-property" aria-label="Property" className="form-input" style={{ width: '100%' }} value={draft.propertyId}
            onChange={(e) => patch({ propertyId: e.target.value })} disabled={properties === null}>
            <option value="">{properties === null ? 'Loading…' : 'No Property'}</option>
            {linked && <option value={draft.propertyId}>Linked Property</option>}
            {propertyOptions.map((o) => <option key={o.id} value={o.id}>{o.label}{o.hint ? ` (${o.hint})` : ''}</option>)}
          </select>
        </SettingRow>
      </SettingCard>
      {client.show && <ClientRows client={client} />}
      {books.show && <BooksRows books={books} />}
      {labor.show && <LaborCodesRows labor={labor} />}
      <SettingCard>
        <SettingRow title="Crew" desc="Who files daily logs on this job.">
          <div style={{ width: '100%' }} data-job-team="crew">
            <PersonMultiSelect value={draft.workerEmails} people={people} onChange={(v) => patch({ workerEmails: v })} placeholder="Add crew" addTitle="Add crew" />
          </div>
        </SettingRow>
        <SettingRow title="Managers" desc="Who reviews the logs and publishes the weekly report. With none, the company's managers review.">
          <div style={{ width: '100%' }} data-job-team="managers">
            <PersonMultiSelect value={draft.managerEmails} people={people} onChange={(v) => patch({ managerEmails: v })} placeholder="Add managers" addTitle="Add managers" />
          </div>
        </SettingRow>
        <SettingRow title="Superintendent" desc="Who runs the site day to day. They get the morning reminder when yesterday's daily log is missing; with none, the managers do.">
          <select aria-label="Superintendent" className="form-input" style={{ width: 'min(260px, 60vw)' }} value={draft.superintendentEmail}
            onChange={(e) => patch({ superintendentEmail: e.target.value })} data-job-team="superintendent">
            <option value="">None - the managers</option>
            {[...new Set([...(draft.managerEmails || []), ...(draft.workerEmails || [])])].map((em) => (
              <option key={em} value={em}>{(people.find((p) => (p.email || '').toLowerCase() === em) || {}).name || em}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="Executives" desc="Who receives each published weekly report.">
          <div style={{ width: '100%' }} data-job-team="executives">
            <PersonMultiSelect value={draft.executiveEmails} people={people} onChange={(v) => patch({ executiveEmails: v })} placeholder="Add executives" addTitle="Add executives" />
          </div>
        </SettingRow>
      </SettingCard>
      </div>
      {dirty && invalid && (
        <div role="alert" style={{ marginTop: 12, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-red))' }}>{invalid}</div>
      )}
      <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={reset} saveDisabled={!!invalid}
        note="Changes save together." />
    </Modal>
  );
}
