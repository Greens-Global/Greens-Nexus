// Settings rail (Oct 2026): who owns the workflow, which companies it
// covers, who it runs as (Global Admins), enrollment and the caps, what to
// do when a step fails. Enrollment and error handling live in the
// definition's `settings`; owner, scope and run-as are the workflow's own
// (the owner changes through Reown, the rest travel with the draft).
import { ChipMultiSelect, PersonMultiSelect, PersonSelect } from '../../tasks/components';
import { NumberBox, SettingCard, SettingRow, SwitchRow } from '../../components/settings/SettingsUI';
import StepList from './StepList';
import { fieldLabel, hint, select } from '../lib/text.builder-helpers';

export default function RailSettings({ workflow, meta, onMeta, definition, onDefinition, ctx, people, companies, isGlobalAdmin, onReown }) {
  const s = definition.settings || {};
  const setS = (patch) => onDefinition({ ...definition, settings: { ...s, ...patch } });
  const suppress = s.suppress || { people: [], companies: [] };
  const companyOptions = (companies || []).map((c) => ({ id: String(c.id ?? c.value), label: c.name || c.label }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SettingCard>
        <SettingRow title="Owner" desc="Runs as this person; their access decides what the workflow may do."
          control={<PersonSelect value={meta.ownerEmail || ''} onChange={(v) => { if (v && v !== meta.ownerEmail) onReown(v); }} people={people} allowNone={false} placeholder="Choose an owner" ariaLabel="Owner" />} />
        <SettingRow title="Applies To" desc="One company, or every company the owner can see."
          control={(
            <select value={meta.companyId || ''} onChange={(e) => onMeta({ companyId: e.target.value })} aria-label="Applies To" style={select}>
              <option value="">Every Company</option>
              {companyOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )} />
        {isGlobalAdmin && (
          <SettingRow title="Run As" desc="Nexus runs without a person's token: no Teams posts, every record it may touch."
            control={(
              <select value={meta.runAs || 'owner'} onChange={(e) => onMeta({ runAs: e.target.value })} aria-label="Run As" style={select}>
                <option value="owner">The Owner</option>
                <option value="nexus">Nexus</option>
              </select>
            )} />
        )}
      </SettingCard>

      <div>
        <div style={{ ...fieldLabel, marginBottom: 6 }}>Enrollment</div>
        <SettingCard>
          <SwitchRow id="wf-once" title="Once Per Record" desc="A record goes through this workflow one time only, whatever happens to it later." checked={!!s.oncePerSubject} onChange={(v) => setS({ oncePerSubject: v })} />
          <SettingRow title="Cooldown" desc="Skip the same record if it ran this recently. 0 = no cooldown."
            control={<NumberBox value={s.cooldownHours ?? 0} onChange={(v) => setS({ cooldownHours: Number(v) || 0 })} min={0} max={8760} unit="hours" label="Cooldown hours" />} />
          <SwitchRow id="wf-logskips" title="Log Skipped Runs" desc="Keep a run for events the conditions turned away, so Runs shows why nothing happened." checked={!!s.logSkips} onChange={(v) => setS({ logSkips: v })} />
          <SwitchRow id="wf-downstream" title="Allow Other Workflows To Follow" desc="What this workflow changes may start other workflows (off keeps chains from looping)." checked={!!s.allowDownstream} onChange={(v) => setS({ allowDownstream: v })} />
          <SettingRow title="Runs Per Hour" desc="Over this the workflow pauses itself and tells the owner."
            control={<NumberBox value={s.maxRunsPerHour ?? 100} onChange={(v) => setS({ maxRunsPerHour: Number(v) || 0 })} min={1} max={10000} label="Runs per hour" />} />
          <SettingRow title="Recipients Per Run" desc="A step that would reach more people than this fails instead of sending."
            control={<NumberBox value={s.maxRecipients ?? 50} onChange={(v) => setS({ maxRecipients: Number(v) || 0 })} min={1} max={5000} label="Recipients per run" />} />
          <SettingRow title="Never For These People" desc="Records about these people are skipped.">
            <PersonMultiSelect value={suppress.people || []} onChange={(v) => setS({ suppress: { ...suppress, people: v } })} people={people} placeholder="Choose people" />
          </SettingRow>
          {!!companyOptions.length && (
            <SettingRow title="Never For These Companies" desc="Records in these companies are skipped.">
              <ChipMultiSelect value={(suppress.companies || []).map(String)} onChange={(v) => setS({ suppress: { ...suppress, companies: v } })} options={companyOptions} placeholder="Choose companies" />
            </SettingRow>
          )}
        </SettingCard>
      </div>

      <div>
        <div style={{ ...fieldLabel, marginBottom: 6 }}>When A Step Fails</div>
        <SettingCard>
          <SettingRow title="On Error" desc="Stop the run, or carry on with the next step."
            control={(
              <select value={s.onError || 'stop'} onChange={(e) => setS({ onError: e.target.value })} aria-label="On Error" style={select}>
                <option value="stop">Stop The Run</option>
                <option value="continue">Keep Going</option>
              </select>
            )} />
          <SettingRow title="Then Do" desc="Steps that run after a failure - tell the owner, file a ticket.">
            <StepList steps={s.faultSteps || []} onChange={(steps) => setS({ faultSteps: steps })} ctx={ctx} depth={1} emptyText="Nothing extra happens on a failure." addLabel="Add Step" />
          </SettingRow>
        </SettingCard>
      </div>

      {workflow?.pausedReason && <div style={hint}>Paused: {workflow.pausedReason}</div>}
    </div>
  );
}
