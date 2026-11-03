// A job's money on the screen (Neil, 11/03/2026, plan phase 4). The figures
// and who may see them are the server's (backend/construction_money.py,
// routers/construction_money.py); this file only says them and builds the
// words - every POSTED figure opens its ledger lines through the
// Accounting side panel (LinesPanel, lineQuery from reportModel.js, with the
// job's Project-Job as `project`), and on to the source entry (EntryDetail).
// Worked-out figures (forecast, variance, percent) never drill. The
// drill-downs are moneyDrill.js, loaded only with the Money tab.
import { useEffect, useMemo, useState } from 'react';
import { useRole } from '../../contexts/RoleContext';
import { useDraft } from '../../lib/useDraft';
import { api } from '../../api';
import { formatAmount } from '../../components/accounting/Amount';
import { useLoad } from './job';

/** "$51,300.00" / "($1,200.00)" - the accounting figure with its dollar sign. */
export function usd(value) {
  const v = Math.round((Number(value) || 0) * 100) / 100;
  return v < 0 ? `($${formatAmount(-v)})` : `$${formatAmount(v)}`;
}

/**
 * The job's Money read, for managers and above only - a crew member's
 * screen never asks. { data, error, reload }; data.allowed false = no tab,
 * no line, no figure.
 */
export function useJobMoney(project) {
  const { can } = useRole() || {};
  const manager = !!can?.('manager');
  const id = project?.id || '';
  const out = useLoad(() => (manager && id ? api.getJobMoney(id) : { allowed: false }), `${id}:${manager}`);
  return out;
}

/**
 * The progress track of Actual against Budget: red once the job is Over
 * Budget, else still moving. Over Budget is the server's rule (actual +
 * requested, not yet billed past the budget), so the Overview, the tab and
 * the dashboard card always agree.
 */
export function spendTrack(m) {
  const budget = Number(m?.budget?.amount) || 0;
  const actual = Number(m?.actual?.amount) || 0;
  if (!budget || !m?.actual) return null;
  const over = !!m.overBudget;
  const committed = Number(m?.committed?.amount) || 0;
  return { value: Math.min(actual / budget, 1), state: over ? 'overdue' : 'live', over, actual, budget, committed, by: actual + committed - budget };
}

export const REQUEST_STAGE = {
  requested: 'Requested, Not Yet Billed',
  posting: 'Approved, Posting Soon',
  received: 'Received',
  paid: 'Paid',
};

/**
 * The Edit Job sheet's Books rows (managers with Accounting access): the
 * job's Project-Job code and entity as a draft beside the saved mapping, saved
 * with the sheet's one Save (PUT .../books). `show` false = no rows at all.
 */
export function useBooksDraft(project, money) {
  const m = money?.data;
  const show = !!(m?.allowed && m?.canMap);
  const saved = useMemo(() => ({ intacctProjectId: m?.link?.project || '', intacctEntity: m?.link?.entity || '' }), [m]);
  const { draft, patch, dirty, reset } = useDraft(saved);
  const save = () => api.mapJobBooks(project.id, { intacctProjectId: draft.intacctProjectId.trim(), intacctEntity: draft.intacctEntity });
  const half = !!draft.intacctProjectId.trim() !== !!draft.intacctEntity;
  const invalid = show && dirty && half ? 'Pick both the Project-Job and the entity it books to.' : '';
  return { show, draft, patch, dirty: show && dirty, reset, save, invalid };
}

/** The picker's lists: the entities the caller reads and that entity's Project-Job codes. */
export function useBookChoices(entity, on) {
  const [state, setState] = useState({ key: null, data: null, error: '' });
  const key = on ? entity || '-' : null;
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    api.getBookProjects(entity)
      .then((data) => { if (live) setState({ key: entity || '-', data, error: '' }); })
      .catch((e) => { if (live) setState({ key: entity || '-', data: null, error: e?.message || 'Could not read the books.' }); });
    return () => { live = false; };
  }, [entity, on]);
  return state.key === key ? state : { key, data: null, error: '' };
}
