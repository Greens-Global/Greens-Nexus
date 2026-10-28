import { describe, it, expect } from 'vitest';
import {
  describeTrigger, describeCondition, describeConditions, describeStep, describeWorkflow,
  describeRecipients, durationWords, describeValue,
} from './text';

const CATALOG = {
  entities: [
    {
      key: 'employee', label: 'Employee', module: 'hr',
      fields: [
        { key: 'name', label: 'Name', type: 'text', visibility: 'all' },
        { key: 'department', label: 'Department', type: 'text', visibility: 'all' },
        { key: 'status', label: 'Status', type: 'select', options: [{ key: 'active', label: 'Active' }, { key: 'left', label: 'Left' }], visibility: 'all' },
        { key: 'start_date', label: 'Start Date', type: 'date', visibility: 'all' },
        { key: 'remote', label: 'Remote', type: 'bool', visibility: 'all' },
        { key: 'pay', label: 'Pay', type: 'money', visibility: 'comp' },
      ],
      dates: [{ key: 'probation.end', label: 'Probation End', yearly: false }, { key: 'start_date', label: 'Start Date', yearly: true }],
      people: [{ key: 'manager', label: 'Manager' }],
    },
    {
      key: 'time_off', label: 'Time Off Request', module: 'time',
      fields: [{ key: 'status', label: 'Status', type: 'select', options: ['Pending', 'Approved', 'Rejected'], visibility: 'all' }],
      dates: [], people: [],
    },
  ],
  events: [
    { key: 'hr.time_off.decided', entity: 'time_off', label: 'Time off is decided', module: 'time', group: 'Time Off', changes: ['status'], volume: 'normal' },
    { key: 'hr.employee.started', entity: 'employee', label: 'An employee starts', module: 'hr', group: 'People', changes: [], volume: 'low' },
  ],
  actions: [
    {
      key: 'notify', label: 'Send Notification', module: 'core', needsPerson: true, adminOnly: false,
      params: [
        { key: 'to', label: 'To', type: 'recipients', required: true },
        { key: 'title', label: 'Title', type: 'template', required: true },
        { key: 'body', label: 'Body', type: 'template', required: false },
      ],
    },
    {
      key: 'email', label: 'Send Email', module: 'core', needsPerson: true, adminOnly: false,
      params: [
        { key: 'to', label: 'To', type: 'recipients', required: true },
        { key: 'subject', label: 'Subject', type: 'template', required: true },
      ],
    },
    {
      key: 'tasks.create', label: 'Create Task', module: 'tasks', needsPerson: true, adminOnly: false,
      params: [
        { key: 'project', label: 'Project', type: 'entity_ref', required: true, options: [{ key: 'p1', label: 'Onboarding' }] },
        { key: 'assignee', label: 'Assign To', type: 'person', required: true },
        { key: 'title', label: 'Title', type: 'template', required: true },
      ],
    },
  ],
  listSources: [{ key: 'hr.direct_reports', label: 'Direct Reports', entity: 'employee', module: 'hr', params: [] }],
  operators: {},
  filters: [],
};

const employee = CATALOG.entities[0];

describe('describeTrigger', () => {
  it('reads an event with its filters', () => {
    expect(describeTrigger({ kind: 'event', event: 'hr.time_off.decided' }, CATALOG)).toBe('When time off is decided');
    expect(describeTrigger({ kind: 'event', event: 'hr.time_off.decided', filters: [{ field: 'status', op: 'changed_to', value: 'Approved' }] }, CATALOG))
      .toBe('When time off is decided, only when Status changed to Approved');
  });
  it('names an unknown event by key and an empty trigger honestly', () => {
    expect(describeTrigger({ kind: 'event', event: 'x.y' }, CATALOG)).toBe('When x.y');
    expect(describeTrigger({ kind: 'event' }, CATALOG)).toBe('When an event happens (not chosen yet)');
    expect(describeTrigger(null, CATALOG)).toBe('When something happens (not chosen yet)');
  });
  it('reads schedules in 12-hour time', () => {
    expect(describeTrigger({ kind: 'schedule', every: 'day', time: '08:00' }, CATALOG)).toBe('Every day at 8:00 AM');
    expect(describeTrigger({ kind: 'schedule', every: 'week', days: [1, 5], time: '17:30' }, CATALOG)).toBe('Every week on Monday and Friday at 5:30 PM');
    expect(describeTrigger({ kind: 'schedule', every: 'month', days: [1, 15, 22], time: '09:00' }, CATALOG)).toBe('Every month on the 1st, 15th and 22nd at 9:00 AM');
    expect(describeTrigger({ kind: 'schedule', every: 'day' }, CATALOG)).toBe('Every day');
  });
  it('reads date triggers with their offset', () => {
    expect(describeTrigger({ kind: 'date', entity: 'employee', field: 'probation.end', offsetDays: -14, time: '08:00' }, CATALOG))
      .toBe('14 days before Probation End of employee at 8:00 AM');
    expect(describeTrigger({ kind: 'date', entity: 'employee', field: 'start_date', offsetDays: 0 }, CATALOG))
      .toBe('On Start Date of employee');
    expect(describeTrigger({ kind: 'date', entity: 'employee', field: 'start_date', offsetDays: 1 }, CATALOG))
      .toBe('1 day after Start Date of employee');
  });
  it('reads a manual trigger', () => {
    expect(describeTrigger({ kind: 'manual', entity: 'employee' }, CATALOG)).toBe('Started by hand on an employee');
    expect(describeTrigger({ kind: 'manual' }, CATALOG)).toBe('Started by hand on a record');
  });
});

describe('describeCondition', () => {
  it('uses the field label, the operator words and the typed value', () => {
    expect(describeCondition({ field: 'department', op: 'is', value: 'Sales' }, employee)).toBe("Department is 'Sales'");
    expect(describeCondition({ field: 'status', op: 'is_any_of', value: ['active', 'left'] }, employee)).toBe('Status is any of Active or Left');
    expect(describeCondition({ field: 'start_date', op: 'after', value: '2026-11-12' }, employee)).toBe('Start Date is after 11/12/2026');
    expect(describeCondition({ field: 'start_date', op: 'within_next_days', value: 7 }, employee)).toBe('Start Date is within the next 7 days');
    expect(describeCondition({ field: 'remote', op: 'is', value: true }, employee)).toBe('Remote is Yes');
    expect(describeCondition({ field: 'pay', op: 'gt', value: 50000 }, employee)).toBe('Pay is greater than $50,000.00');
    expect(describeCondition({ field: 'manager', op: 'is_empty' }, employee)).toBe('Manager is empty');
    expect(describeCondition({ field: 'subject.status', op: 'changed' }, employee)).toBe('Status changed');
  });
  it('falls back to a readable key and says when the value is missing', () => {
    expect(describeCondition({ field: 'cost_center', op: 'is', value: 'A1' }, null)).toBe("Cost center is 'A1'");
    expect(describeCondition({ field: 'department', op: 'is' }, employee)).toBe('Department is (not set yet)');
    expect(describeCondition(null, employee)).toBe('a condition (not set yet)');
  });
  it('joins rows with and, groups with or', () => {
    expect(describeConditions([[{ field: 'department', op: 'is', value: 'Sales' }, { field: 'remote', op: 'is', value: false }], [{ field: 'status', op: 'is', value: 'left' }]], employee))
      .toBe("Department is 'Sales' and Remote is No, or Status is Left");
    expect(describeConditions([], employee)).toBe('');
    expect(describeConditions([[]], employee)).toBe('');
  });
});

describe('describeStep', () => {
  it('reads an action with its recipients and template', () => {
    expect(describeStep({ id: 's1', kind: 'action', action: 'email', params: { to: [{ kind: 'manager' }, { kind: 'hr_contact' }], subject: 'Probation ends in 14 days' }, enabled: true }, CATALOG))
      .toBe("Send Email to their manager and the HR contact: 'Probation ends in 14 days'");
    expect(describeStep({ id: 's2', kind: 'action', action: 'notify', params: { to: [{ kind: 'self' }], title: 'Welcome {{ subject.name }}' } }, CATALOG))
      .toBe("Send Notification to the person: 'Welcome {{ subject.name }}'");
  });
  it('reads a task step with its project and assignee', () => {
    expect(describeStep({ id: 's3', kind: 'action', action: 'tasks.create', params: { project: 'p1', assignee: { kind: 'person', name: 'Priya Shah', value: 'priya@x.com' }, title: 'Order a laptop' } }, CATALOG))
      .toBe("Create Task for Priya Shah (Project: Onboarding): 'Order a laptop'");
  });
  it('marks a skipped step and names an unknown action by key', () => {
    expect(describeStep({ id: 's4', kind: 'action', action: 'email', params: { to: 'manager' }, enabled: false }, CATALOG)).toBe('Skipped: Send Email to their manager');
    expect(describeStep({ id: 's5', kind: 'action', action: 'tickets.close', params: {} }, CATALOG)).toBe('Tickets Close');
    expect(describeStep({ id: 's6', kind: 'action' }, CATALOG)).toBe('Do something (not chosen yet)');
  });
  it('reads the other kinds', () => {
    expect(describeStep({ id: 'a', kind: 'approval', params: { approvers: [{ kind: 'manager' }], mode: 'any', question: 'Approve the laptop?', options: ['Approve', 'Decline'] } }, CATALOG))
      .toBe("Ask their manager for approval: 'Approve the laptop?' (Approve / Decline)");
    expect(describeStep({ id: 'b', kind: 'approval', params: { approvers: [{ kind: 'role', value: 'hr_contact' }], mode: 'all', options: ['Yes', 'No'] } }, CATALOG))
      .toBe('Ask everyone with the role Hr Contact for approval (Yes / No), everyone must answer');
    expect(describeStep({ id: 'c', kind: 'wait', params: { mode: 'duration', minutes: 120 } }, CATALOG)).toBe('Wait 2 hours');
    expect(describeStep({ id: 'd', kind: 'wait', params: { mode: 'business_morning' } }, CATALOG)).toBe('Wait until the next business morning');
    expect(describeStep({ id: 'e', kind: 'wait', params: { mode: 'until', field: 'probation.end', offsetDays: -1 }, entityDef: employee }, CATALOG)).toBe('Wait until 1 day before Probation End');
    expect(describeStep({ id: 'f', kind: 'for_each', source: { key: 'hr.direct_reports', params: {} }, as: 'item' }, CATALOG)).toBe('For each of Direct Reports');
    expect(describeStep({ id: 'g', kind: 'stop' }, CATALOG)).toBe('Stop');
    expect(describeStep({ id: 'h', kind: 'if', conditions: [[{ field: 'department', op: 'is', value: 'Sales' }]] }, CATALOG)).toBe("If Department is 'Sales'");
    expect(describeStep({ id: 'i', kind: 'if', conditions: [] }, CATALOG)).toBe('If (no condition yet)');
  });
});

describe('describeWorkflow', () => {
  it('reads the whole recipe top to bottom with nested lanes indented', () => {
    const definition = {
      v: 1,
      trigger: { kind: 'event', event: 'hr.employee.started' },
      conditions: [[{ field: 'department', op: 'is', value: 'Sales' }]],
      steps: [
        { id: '1', kind: 'action', action: 'email', params: { to: [{ kind: 'manager' }], subject: 'New hire' }, enabled: true },
        {
          id: '2', kind: 'if', conditions: [[{ field: 'remote', op: 'is', value: true }]], enabled: true,
          then: [{ id: '3', kind: 'action', action: 'notify', params: { to: [{ kind: 'hr_contact' }], title: 'Ship the laptop' } }],
          else: [{ id: '4', kind: 'wait', params: { mode: 'duration', minutes: 1440 } }],
        },
        {
          id: '5', kind: 'approval', params: { approvers: [{ kind: 'manager' }], question: 'Ready?', options: ['Approve', 'Decline'] },
          branches: { Approve: [{ id: '6', kind: 'stop' }], Decline: [], expired: [{ id: '7', kind: 'action', action: 'notify', params: { to: 'global_admins', title: 'No answer' } }] },
        },
        { id: '8', kind: 'for_each', source: { key: 'hr.direct_reports' }, as: 'item', steps: [{ id: '9', kind: 'stop' }] },
      ],
      settings: { faultSteps: [{ id: 'f', kind: 'action', action: 'notify', params: { to: 'owner', title: 'It broke' } }] },
    };
    expect(describeWorkflow(definition, CATALOG)).toEqual([
      'When an employee starts',
      "Only if Department is 'Sales'",
      "Send Email to their manager: 'New hire'",
      'If Remote is Yes',
      '  Then',
      "    Send Notification to the HR contact: 'Ship the laptop'",
      '  Else',
      '    Wait 1 day',
      "Ask their manager for approval: 'Ready?' (Approve / Decline)",
      '  If Approve',
      '    Stop',
      '  If nobody answers',
      "    Send Notification to the Global Admins: 'No answer'",
      'For each of Direct Reports',
      '  Stop',
      'If a step fails',
      "  Send Notification to the owner: 'It broke'",
    ]);
  });
  it('says so when there is nothing yet', () => {
    expect(describeWorkflow({ v: 1 }, CATALOG)).toEqual(['When something happens (not chosen yet)', 'Do nothing yet']);
    expect(describeWorkflow(null, null)).toEqual(['When something happens (not chosen yet)', 'Do nothing yet']);
  });
});

describe('helpers', () => {
  it('words recipients of every kind', () => {
    expect(describeRecipients([{ kind: 'self' }, { kind: 'department', value: 'Sales' }, { kind: 'team', value: 'Austin' }, { kind: 'company', value: 'Greens' }, { kind: 'person', value: 'a@b.com' }]))
      .toBe('the person, the Sales department, the Austin team, everyone at Greens and a@b.com');
    expect(describeRecipients([])).toBe('nobody yet');
    expect(describeRecipients('hr_contact')).toBe('the HR contact');
  });
  it('words durations', () => {
    expect(durationWords(45)).toBe('45 minutes');
    expect(durationWords(60)).toBe('1 hour');
    expect(durationWords(90)).toBe('1 hour and 30 minutes');
    expect(durationWords(2880)).toBe('2 days');
    expect(durationWords(0)).toBe('no time');
  });
  it('formats dates US style and money with cents', () => {
    expect(describeValue('2026-10-04', { type: 'date' })).toBe('10/04/2026');
    expect(describeValue(1234.5, { type: 'money' })).toBe('$1,234.50');
    expect(describeValue('x', { type: 'text' })).toBe("'x'");
  });
});
