// Note templates (Neil, 11/06/2026): what New From Template starts a note
// from. The built-in starters are plain note HTML in the editor's own shapes
// (headings, lists, checklists), so nothing is stored for them and a starter
// can change without touching anyone's notes. A person's own templates are
// their notes marked Use as Template (view=templates, kind 'note') - picking
// one copies it. Titles carry today's date in US format (lib/datetime).
import { formatDate } from '../lib/datetime';

const h = (text) => `<h2>${text}</h2>`;
const p = (text = '') => `<p>${text}</p>`;
const bullets = (n = 1) => `<ul>${'<li><p></p></li>'.repeat(n)}</ul>`;
const checks = (n = 1) => `<ul data-type="taskList">${'<li data-type="taskItem" data-checked="false"><p></p></li>'.repeat(n)}</ul>`;
const today = () => formatDate(new Date());

export const NOTE_TEMPLATES = [
  {
    key: 'meeting', label: 'Meeting Notes', hint: 'Who came, the agenda, decisions and action items',
    title: () => `Meeting - ${today()}`,
    body: () => [h('Attendees'), p('Type @ to add people.'), h('Agenda'), bullets(2), h('Notes'), p(), h('Decisions'), bullets(1), h('Action Items'), checks(2)].join(''),
  },
  {
    key: 'one-on-one', label: '1:1', hint: 'Wins, priorities, blockers and feedback',
    title: () => `1:1 - ${today()}`,
    body: () => [h('Wins'), bullets(1), h('Priorities This Week'), bullets(2), h('Blockers'), bullets(1), h('Feedback'), p(), h('Action Items'), checks(2)].join(''),
  },
  {
    key: 'site-walk', label: 'Site Walk', hint: 'What you saw on site, safety and punch items',
    title: () => `Site Walk - ${today()}`,
    body: () => [h('Where'), p('Type [[ to link the job.'), h('Conditions'), p(), h('Observations'), bullets(2), h('Safety'), bullets(1), h('Punch Items'), checks(3), h('Follow-Ups'), checks(1)].join(''),
  },
  {
    key: 'handover', label: 'Shift Handover', hint: 'What got done and what the next shift needs to know',
    title: () => `Shift Handover - ${today()}`,
    body: () => [h('Done This Shift'), bullets(2), h('Still In Progress'), bullets(1), h('Watch Out For'), bullets(1), h('Next Shift'), checks(2)].join(''),
  },
  {
    key: 'incident', label: 'Incident Debrief', hint: 'What happened, why, and what changes',
    title: () => `Incident Debrief - ${today()}`,
    body: () => [h('What Happened'), p(), h('Timeline'), bullets(3), h('Impact'), p(), h('Root Cause'), p(), h('What We Will Change'), checks(2), h('Related'), p('Type [[ to link the ticket, task or job.')].join(''),
  },
  {
    key: 'weekly', label: 'Weekly Review', hint: 'Wins, problems and next week\'s priorities',
    title: () => `Weekly Review - ${today()}`,
    body: () => [h('Wins'), bullets(2), h('Problems'), bullets(1), h('Numbers'), p(), h('Next Week\'s Priorities'), checks(3)].join(''),
  },
];

export const noteTemplate = (key) => NOTE_TEMPLATES.find((t) => t.key === key) || null;
