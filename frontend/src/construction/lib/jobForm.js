// The Edit Job / New Project form's data (Neil, 11/03/2026): the Nexus People
// list for the crew and manager pickers, the Asset Management properties the
// caller may link, and the PATCH body - only what changed, in the server's
// snake_case. Kept out of the component file so it stays fast-refresh clean.
import { useEffect, useState } from 'react';
import { api } from '../../api';

// The curated Nexus People directory ({ email, name }) - never M365.
export function useNexusPeople() {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getPeopleDirectory?.())
      .then((r) => { if (live) setPeople((Array.isArray(r) ? r : []).filter((p) => p && p.email)); })
      .catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, []);
  return people;
}

// Properties a job may be linked to: Asset Management's own list for the
// ticket forms (/ticket-properties - private ones only for those who may
// see them). null while loading.
export function useProperties() {
  const [list, setList] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.getTicketProperties?.())
      .then((r) => { if (live) setList((r && r.properties) || []); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  return list;
}

export const savedOf = (p) => ({
  name: p.name || '',
  jobType: p.jobType || 'project',
  units: p.units ? String(p.units) : '',
  squareFeet: p.squareFeet ? String(p.squareFeet) : '',
  // Round Two: why the target finish moved - asked only when it does.
  changeReason: '',
  address: p.address || '',
  latitude: p.latitude ? String(p.latitude) : '',
  longitude: p.longitude ? String(p.longitude) : '',
  status: p.status || 'active',
  phase: p.phase || '',
  percentComplete: String(Math.round(p.percentComplete || 0)),
  startOn: p.startOn || '',
  targetFinishOn: p.targetFinishOn || '',
  contractValue: p.contractValue == null ? '' : String(p.contractValue || ''),
  propertyId: p.propertyId || '',
  workerEmails: p.workerEmails || [],
  managerEmails: p.managerEmails || [],
  executiveEmails: p.executiveEmails || [],
  superintendentEmail: p.superintendentEmail || '',
});

const FIELDS = {
  name: 'name', jobType: 'job_type', address: 'address', status: 'status', phase: 'phase', startOn: 'start_on',
  targetFinishOn: 'target_finish_on', propertyId: 'property_id', workerEmails: 'worker_emails',
  managerEmails: 'manager_emails', executiveEmails: 'executive_emails',
  superintendentEmail: 'superintendent_email',
};

export function changesFor(saved, draft, { canCost }) {
  const out = {};
  for (const [k, key] of Object.entries(FIELDS)) {
    if (JSON.stringify(saved[k]) !== JSON.stringify(draft[k])) out[key] = draft[k];
  }
  if (saved.percentComplete !== draft.percentComplete) out.percent_complete = Number(draft.percentComplete || 0);
  if (saved.units !== draft.units) out.units = Number(draft.units || 0);
  if (saved.squareFeet !== draft.squareFeet) out.square_feet = Number(draft.squareFeet || 0);
  // The reason rides only when given; the server refuses a move without one.
  if (targetMoved(saved, draft) && String(draft.changeReason || '').trim()) out.change_reason = String(draft.changeReason).trim();
  if (canCost && saved.contractValue !== draft.contractValue) out.contract_value = Number(draft.contractValue || 0);
  if ((saved.latitude !== draft.latitude || saved.longitude !== draft.longitude)
      && draft.latitude !== '' && draft.longitude !== '') {
    out.latitude = Number(draft.latitude);
    out.longitude = Number(draft.longitude);
  }
  return out;
}

// A target finish that was set and now changes (the first date needs no reason).
export const targetMoved = (saved, draft) => !!saved.targetFinishOn && draft.targetFinishOn !== saved.targetFinishOn;

// '' when the draft can be saved, else the sentence that says why not.
export function invalidReason(draft, saved = null) {
  const pct = Number(draft.percentComplete);
  if (!String(draft.name || '').trim()) return 'Give the job a name.';
  if (Number.isNaN(pct) || pct < 0 || pct > 100) return 'Percent complete is between 0 and 100.';
  if (draft.startOn && draft.targetFinishOn && draft.targetFinishOn < draft.startOn) return 'The target finish cannot be before the start.';
  if (saved && targetMoved(saved, draft) && !String(draft.changeReason || '').trim()) return 'Say why the target finish moved.';
  return '';
}
