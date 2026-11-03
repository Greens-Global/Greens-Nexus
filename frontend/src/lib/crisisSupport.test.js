import { describe, it, expect } from 'vitest';
import { detectCrisis, normalize, crisisResources, crisisCheck, __setCrisisHost } from './crisisSupport';

// Same cases as backend/test_crisis_support.py - the two detectors must agree.
const TRUE_POSITIVES = [
  'I want to kill myself',
  'i think about killing myself every night',
  "I've been having suicidal thoughts",
  'thinking about suicide',
  'I want to end my life',
  "I'm going to take my own life",
  'I just want to die',
  'honestly i wanna die',
  "I don't want to live anymore",
  'I do not want to wake up tomorrow',
  'There is no reason to live',
  'Everyone would be better off without me',
  "I'd be better off dead",
  'I want to end it all',
  'I have been self-harming again',
  'self harm',
  'I feel like hurting myself',
  "I'm thinking about cutting myself",
  'I cut myself on purpose last night',
  'I want to hang myself',
  'I might take an overdose',
  'KILL MYSELF',
  'I don’t want to live',
  'main khudkushi kar lunga',
  'mar jana chahta hoon',
  'ab jeena nahi chahti',
  'Need help with payroll. Also I want to kill myself.',
  'suicide prevention training is due, and honestly I am suicidal',
];

const FALSE_POSITIVES = [
  '',
  null,
  'Please kill the stuck print job',
  'This traffic is killing me',
  'I cut myself on the box cutter while opening a shipment',
  'I hurt myself lifting the pallet, need an incident form',
  'The battery died on the scanner',
  'Our deadline is going to kill us',
  'Dead battery in the company truck',
  'I am dying to know when payroll runs',
  'Can we schedule the suicide prevention training for Monday?',
  'Suicide awareness week poster request',
  'Please end the meeting early',
  'Shoot myself a reminder to file the expense',
  'The kill switch on the conveyor is broken',
  'Life insurance question about my policy',
  'We need to end this contract',
  'I could die of embarrassment after that presentation',
];

describe('detectCrisis', () => {
  it.each(TRUE_POSITIVES)('matches %s', (msg) => { expect(detectCrisis(msg)).toBe(true); });
  it.each(FALSE_POSITIVES)('does not match %s', (msg) => { expect(detectCrisis(msg)).toBe(false); });
  it('normalizes like the server', () => { expect(normalize("Don't  STOP-now!")).toBe(' dont stop now '); });
});

describe('crisisResources', () => {
  it('shows the US lines for a US person', () => {
    const r = crisisResources('US');
    expect(r.map((b) => b.country)).toEqual(['US']);
    expect(r[0].lines[0].name).toContain('988');
    expect(r[0].emergency.number).toBe('911');
  });
  it('shows Tele-MANAS for India', () => {
    const r = crisisResources('India');
    expect(r.map((b) => b.country)).toEqual(['IN']);
    expect(r[0].lines[0].detail).toContain('14416');
    expect(r[0].emergency.number).toBe('112');
  });
  it('shows both when the country is unknown', () => {
    expect(crisisResources('').map((b) => b.country)).toEqual(['US', 'IN']);
    expect(crisisResources(undefined).map((b) => b.country)).toEqual(['US', 'IN']);
  });
});

describe('crisisCheck', () => {
  it('waits for the acknowledgment when the text matches', async () => {
    let shown = null;
    __setCrisisHost((o) => { shown = o; });
    const p = crisisCheck('I want to end my life');
    await Promise.resolve();
    expect(shown).not.toBeNull();
    shown.onDone();
    await expect(p).resolves.toBe(true);
    __setCrisisHost(null);
  });
  it('resolves at once when nothing matches, or with no host', async () => {
    __setCrisisHost(() => { throw new Error('should not show'); });
    await expect(crisisCheck('Where is my pay stub?')).resolves.toBe(false);
    __setCrisisHost(null);
    await expect(crisisCheck('I want to end my life')).resolves.toBe(true);
  });
});
