// The approval kinds added for "make sure all approvals go into that approval
// box" (Neil, 10/28/2026): each inline action calls the module's EXISTING
// api.js method with what that module's own screen sends.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
const rec = (name) => vi.fn((...args) => { calls.push([name, ...args]); return Promise.resolve({ ok: true }); });

vi.mock('../api', () => ({
  api: {
    updateTask: rec('updateTask'),
    respondTaskDue: rec('respondTaskDue'),
    decideTicketApproval: rec('decideTicketApproval'),
    resolveItemExtension: rec('resolveItemExtension'),
    acceptAssignment: rec('acceptAssignment'),
    declineAssignment: rec('declineAssignment'),
    decideTaskMemberRequest: rec('decideTaskMemberRequest'),
    decideTeamApproval: rec('decideTeamApproval'),
    approveRoleChange: rec('approveRoleChange'),
    declineRoleChange: rec('declineRoleChange'),
    decideAccountingPartnerChange: rec('decideAccountingPartnerChange'),
    cvDenyRequest: rec('cvDenyRequest'),
  },
}));

const { runApproval, runsInline, bulkAction, doneWord } = await import('./approvalActions');

const row = (kind, actions = []) => ({ kind, id: 'x1', actions });

describe('the new approval kinds call their module endpoints', () => {
  beforeEach(() => { calls.length = 0; });

  it.each([
    ['task_approval', 'approve', '', ['updateTask', 'x1', { approval_status: 'approved' }]],
    ['task_approval', 'changes', '', ['updateTask', 'x1', { approval_status: 'changes_requested' }]],
    ['task_approval', 'reject', '', ['updateTask', 'x1', { approval_status: 'rejected' }]],
    ['task_date_ask', 'approve', '', ['respondTaskDue', 'x1', true, '']],
    ['task_date_ask', 'decline', 'Keep Friday', ['respondTaskDue', 'x1', false, 'Keep Friday']],
    ['ticket_approval', 'approve', '', ['decideTicketApproval', 'x1', 'approve', '']],
    ['ticket_approval', 'reject', 'Not budgeted', ['decideTicketApproval', 'x1', 'reject', 'Not budgeted']],
    ['item_extension', 'approve', '', ['resolveItemExtension', 'x1', { action: 'approve', note: '' }]],
    ['item_extension', 'reject', 'Needed back', ['resolveItemExtension', 'x1', { action: 'reject', note: 'Needed back' }]],
    ['assignment_accept', 'accept', '', ['acceptAssignment', 'x1', {}]],
    ['assignment_accept', 'decline', 'Not mine', ['declineAssignment', 'x1', { note: 'Not mine' }]],
    ['task_member_request', 'approve', '', ['decideTaskMemberRequest', 'x1', 'approved']],
    ['task_member_request', 'deny', '', ['decideTaskMemberRequest', 'x1', 'rejected']],
    ['task_team_approval', 'approve', '', ['decideTeamApproval', 'x1', 'approved']],
    ['task_team_approval', 'send_back', '', ['decideTeamApproval', 'x1', 'rejected']],
    ['role_change', 'approve', '', ['approveRoleChange', 'x1']],
    ['role_change', 'decline', 'Wrong role', ['declineRoleChange', 'x1', 'Wrong role']],
    ['accounting_partner_change', 'approve', '', ['decideAccountingPartnerChange', 'x1', 'approve', '']],
    ['accounting_partner_change', 'decline', 'Typo', ['decideAccountingPartnerChange', 'x1', 'decline', 'Typo']],
    ['credvault_request', 'deny', '', ['cvDenyRequest', 'x1']],
  ])('%s %s', async (kind, key, note, expected) => {
    await runApproval(row(kind), key, note);
    expect(calls).toEqual([expected]);
  });

  it('rows that need their module only open it', () => {
    for (const kind of ['item_checkout', 'assignment_return', 'kb_review', 'construction_log_review', 'hr_packet_verify']) {
      expect(runsInline(row(kind), 'approve')).toBe(false);
      expect(runsInline(row(kind), 'open')).toBe(false);
    }
    // The vault approves behind its code step: Review opens it, Deny is inline.
    expect(runsInline(row('credvault_request'), 'approve')).toBe(false);
    expect(runsInline(row('credvault_request'), 'deny')).toBe(true);
  });

  it('a one-click yes joins Approve Selected; a note-taking reject does not', () => {
    const approve = { key: 'approve', label: 'Approve', tone: 'primary', note: 'none' };
    const reject = { key: 'reject', label: 'Reject', tone: 'plain', note: 'required' };
    expect(bulkAction(row('ticket_approval', [approve, reject]))?.key).toBe('approve');
    expect(bulkAction(row('item_checkout', [{ key: 'open', label: 'Review', tone: 'plain', note: 'none' }]))).toBe(null);
  });

  it('names the new decisions in the Undo toast', () => {
    expect(doneWord('deny')).toBe('Denied');
    expect(doneWord('changes')).toBe('Changes requested');
    expect(doneWord('send_back')).toBe('Sent back');
  });
});
