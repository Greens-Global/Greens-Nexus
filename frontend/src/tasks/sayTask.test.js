// Say It (Neil, Oct 30 2026): the spoken-sentence parser. Today is pinned to
// Thursday 10/29/2026 so every relative date has one right answer.
import { describe, it, expect } from 'vitest';
import { parseSpokenTask } from './sayTask';

const TODAY = '2026-10-29';   // a Thursday
const people = [
  { email: 'bob@greensglobal.com', name: 'Bob Brown' },
  { email: 'alice@greensglobal.com', name: 'Alice Wong' },
  { email: 'sam.lee@greensglobal.com', name: 'Sam Lee' },
  { email: 'sam.ortiz@greensglobal.com', name: 'Sam Ortiz' },
  { email: 'sarah@greensglobal.com', name: 'Sarah Diaz' },
];
const say = (text, extra = {}) => parseSpokenTask(text, { people, today: TODAY, myEmail: 'neil@greensglobal.com', ...extra });

describe('the whole sentence', () => {
  it('fills name, date, priority and person from one sentence', () => {
    const r = say('Call the HVAC vendor about the leak Friday, high priority, for Bob');
    expect(r.title).toBe('Call the HVAC vendor about the leak');
    expect(r.dueOn).toBe('2026-10-30');
    expect(r.priority).toBe('high');
    expect(r.assigneeIds).toEqual(['bob@greensglobal.com']);
    expect(r.matched.map((m) => m.kind).sort()).toEqual(['assignee', 'date', 'priority']);
    expect(r.matched.find((m) => m.kind === 'date').words).toBe('Friday');
  });

  it('keeps a sentence with nothing to read as the name, capitalized, and fills nothing else', () => {
    const r = say('order more gloves for the crew.');
    expect(r).toMatchObject({ title: 'Order more gloves for the crew', dueOn: '', priority: '', assigneeIds: [], matched: [] });
  });

  it('drops the opener and says "me" is the speaker', () => {
    const r = say('Remind me to renew the permit tomorrow, assign it to me');
    expect(r.title).toBe('Renew the permit');
    expect(r.dueOn).toBe('2026-10-30');
    expect(r.assigneeIds).toEqual(['neil@greensglobal.com']);
  });

  it('empty in, empty out', () => {
    expect(say('   ')).toEqual({ title: '', dueOn: '', priority: '', assigneeIds: [], matched: [] });
  });
});

describe('dates', () => {
  const due = (t) => say(`Pay the invoice ${t}`).dueOn;
  it('reads the relative words', () => {
    expect(due('today')).toBe('2026-10-29');
    expect(due('tonight')).toBe('2026-10-29');
    expect(due('tomorrow')).toBe('2026-10-30');
    expect(due('by tomorrow morning')).toBe('2026-10-30');
    expect(due('the day after tomorrow')).toBe('2026-10-31');
    expect(due('in 3 days')).toBe('2026-11-01');
    expect(due('in two weeks')).toBe('2026-11-12');
    expect(due('in a week')).toBe('2026-11-05');
    expect(due('in a couple of days')).toBe('2026-10-31');
    expect(due('next week')).toBe('2026-11-02');
    expect(due('by the end of the week')).toBe('2026-10-30');
    expect(due('end of the month')).toBe('2026-10-31');
  });
  it('weekdays: the next one after today; said on that weekday it is next week', () => {
    expect(due('on Monday')).toBe('2026-11-02');
    expect(due('Thursday')).toBe('2026-11-05');            // today is Thursday
    expect(due('this Saturday')).toBe('2026-10-31');
    expect(due('next Friday')).toBe('2026-11-06');          // Friday of next week
    expect(due('next Monday')).toBe('2026-11-02');
  });
  it('month and day, US numbers, and a passed date moves to next year', () => {
    expect(due('on November 3rd')).toBe('2026-11-03');
    expect(due('Nov 3')).toBe('2026-11-03');
    expect(due('by the 15th of December')).toBe('2026-12-15');
    expect(due('due 11/3')).toBe('2026-11-03');
    expect(due('on 1/5/2027')).toBe('2027-01-05');
    expect(due('on March 2')).toBe('2027-03-02');           // March 2026 has gone
    expect(due('on 2/30')).toBe('');                       // not a date
  });
  it('never sets a past date', () => {
    expect(due('on 1/5/2025')).toBe('');
  });
  it('takes the date words (and their "by the") out of the name', () => {
    expect(say('Pay the invoice by the end of the week').title).toBe('Pay the invoice');
    expect(say('Pay the invoice the day after tomorrow').title).toBe('Pay the invoice');
    expect(say('Due Friday send the bid package').title).toBe('Send the bid package');
  });
});

describe('priority', () => {
  it('reads urgent and the three levels', () => {
    expect(say('Fix the gate asap').priority).toBe('urgent');
    expect(say('Fix the gate, it\'s urgent').title).toBe('Fix the gate');
    expect(say('Fix the gate as soon as possible').priority).toBe('urgent');
    expect(say('Fix the gate high priority').priority).toBe('high');
    expect(say('Fix the gate, low priority').priority).toBe('low');
    expect(say('Fix the gate with normal priority').priority).toBe('medium');
    expect(say('Fix the gate with normal priority').title).toBe('Fix the gate');
    expect(say('Ask Bob about the roof by Nov 3, it is urgent')).toMatchObject({ title: 'Ask Bob about the roof', priority: 'urgent', dueOn: '2026-11-03' });
  });
  it('"urgent" inside a name is the name', () => {
    expect(say('Urgent care appointment tomorrow')).toMatchObject({ title: 'Urgent care appointment', priority: '' });
  });
});

describe('assignee', () => {
  it('matches a full name or a first name one person has, and chains "and"', () => {
    expect(say('Walk the site for Alice Wong').assigneeIds).toEqual(['alice@greensglobal.com']);
    expect(say('Walk the site, assigned to Sarah').assigneeIds).toEqual(['sarah@greensglobal.com']);
    const r = say('Walk the site for Bob and Alice tomorrow');
    expect(r.assigneeIds).toEqual(['bob@greensglobal.com', 'alice@greensglobal.com']);
    expect(r.title).toBe('Walk the site');
    expect(r.dueOn).toBe('2026-10-30');
  });
  it('two people with that first name: nobody picked, the words stay', () => {
    const r = say('Call the plumber for Sam');
    expect(r.assigneeIds).toEqual([]);
    expect(r.title).toBe('Call the plumber for Sam');
    expect(say('Call the plumber for Sam Ortiz').assigneeIds).toEqual(['sam.ortiz@greensglobal.com']);
  });
  it('a possessive or a "to" recipient is not the assignee', () => {
    expect(say('Order flowers for Sarah\'s birthday').assigneeIds).toEqual([]);
    const r = say('Send the report to Bob');
    expect(r.assigneeIds).toEqual([]);
    expect(r.title).toBe('Send the report to Bob');
  });
  it('someone not in Nexus People is left in the name', () => {
    expect(say('Book the room for Jordan').title).toBe('Book the room for Jordan');
  });
});

describe('undoing a chip', () => {
  it('ignore puts the words back in the name', () => {
    const r = say('Call the vendor Friday for Bob', { ignore: ['date'] });
    expect(r.dueOn).toBe('');
    expect(r.title).toBe('Call the vendor Friday');
    expect(r.assigneeIds).toEqual(['bob@greensglobal.com']);
  });
});
