import { describe, it, expect } from 'vitest';
import {
  TYPE_FIELDS, TICKET_TYPE_ORDER, defaultIntakeType, isItDepartment, intakeFieldsFor,
  intakeDefaults, richToPlain, localDateTimeNow,
} from './ticketMeta';

// The Oct 1 2026 intake rules at the config layer (Neil's ticket review).

describe('intake config (Oct 1)', () => {
  it('defaults the type to Incident, and falls back when an admin removed it', () => {
    expect(defaultIntakeType()).toBe('incident');
    const saved = [...TICKET_TYPE_ORDER];
    try {
      TICKET_TYPE_ORDER.splice(0, TICKET_TYPE_ORDER.length, 'bug', 'other');
      expect(defaultIntakeType()).toBe('bug');
    } finally {
      TICKET_TYPE_ORDER.splice(0, TICKET_TYPE_ORDER.length, ...saved);
    }
  });

  it('recognizes the IT department by name, case-insensitively', () => {
    ['IT', 'it', 'I.T.', 'IT Support', 'Information Technology', ' information technology '].forEach((n) =>
      expect(isItDepartment(n), n).toBe(true));
    ['', 'Facilities', 'Italian Office', 'Security', 'Audit'].forEach((n) =>
      expect(isItDepartment(n), n).toBe(false));
  });

  it('asks for an error message only for IT, on bugs and incidents', () => {
    for (const type of ['bug', 'incident']) {
      expect(intakeFieldsFor(type, 'IT').map((f) => f.key)).toContain('errorMessage');
      expect(intakeFieldsFor(type, 'Facilities').map((f) => f.key)).not.toContain('errorMessage');
      expect(intakeFieldsFor(type, '').map((f) => f.key)).not.toContain('errorMessage');
    }
  });

  it('asks no intake question as chips, even from an admin field list saved earlier', () => {
    for (const type of TICKET_TYPE_ORDER) {
      intakeFieldsFor(type, 'IT').forEach((f) => expect(f.type, `${type}.${f.key}`).not.toBe('radio'));
    }
    const saved = TYPE_FIELDS.incident;
    try {
      // What an override saved before Oct 1 looks like: radios, no flags.
      TYPE_FIELDS.incident = [
        { key: 'impact', label: 'Who is affected?', type: 'radio', options: ['One User', 'Multiple Users'], req: true },
        { key: 'errorMessage', label: 'Error message, if you saw one', type: 'text' },
      ];
      const f = intakeFieldsFor('incident', 'Facilities');
      expect(f.map((x) => [x.key, x.type])).toEqual([['impact', 'select']]);
      expect(intakeDefaults('incident').impact).toBe('One User');
    } finally {
      TYPE_FIELDS.incident = saved;
    }
  });

  it('keeps the stored option values of the incident questions', () => {
    const impact = TYPE_FIELDS.incident.find((f) => f.key === 'impact');
    expect(impact.options).toEqual(['One User', 'Multiple Users', 'Department', 'Entire Organization']);
    const worked = TYPE_FIELDS.incident.find((f) => f.key === 'workedBefore');
    expect(worked.options).toEqual(['Yes, it stopped recently', 'No, it never worked', 'Not sure']);
  });

  it('pre-answers Who is affected? and When did it start?, without overwriting an answer', () => {
    const d = intakeDefaults('incident');
    expect(d.impact).toBe('One User');
    expect(d.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(intakeDefaults('incident', { impact: 'Department' }).impact).toBeUndefined();
    // Not required: the start time can be cleared.
    expect(TYPE_FIELDS.incident.find((f) => f.key === 'occurredAt').req).toBeFalsy();
  });

  it('formats now as a local datetime-local value', () => {
    expect(localDateTimeNow(new Date(2026, 9, 1, 9, 5))).toBe('2026-10-01T09:05');
  });

  it('turns a rich description into plain text, and leaves plain text alone', () => {
    expect(richToPlain('<p>Hello <strong>there</strong></p><ul><li>one</li><li>two &amp; three</li></ul>'))
      .toBe('Hello there\none\ntwo & three');
    expect(richToPlain('just text')).toBe('just text');
    expect(richToPlain('')).toBe('');
  });
});
