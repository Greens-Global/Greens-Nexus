import { describe, it, expect } from 'vitest';
import { parseTypedTime, applyTypedTime, inputToTyped, orderIssue, shiftDays } from './timeTyping';

describe('parseTypedTime', () => {
  it.each([
    ['730p', { h: 19, m: 30, ampm: 'PM' }],
    ['7:30 PM', { h: 19, m: 30, ampm: 'PM' }],
    ['7:30pm', { h: 19, m: 30, ampm: 'PM' }],
    ['7p', { h: 19, m: 0, ampm: 'PM' }],
    ['12a', { h: 0, m: 0, ampm: 'AM' }],
    ['12:15p', { h: 12, m: 15, ampm: 'PM' }],
    ['1930', { h: 19, m: 30, ampm: 'PM' }],
    ['0715', { h: 7, m: 15, ampm: '' }],
    ['7:30', { h: 7, m: 30, ampm: '' }],
    ['7', { h: 7, m: 0, ampm: '' }],
    ['8.30 a.m.', { h: 8, m: 30, ampm: 'AM' }],
  ])('%s', (text, want) => expect(parseTypedTime(text)).toEqual(want));
  it.each(['', 'abc', '25:00', '7:75', '13p', '99'])('refuses %s', (text) => expect(parseTypedTime(text)).toBeNull());
});

describe('applyTypedTime', () => {
  it('keeps the punch day and reads AM / PM given', () => {
    expect(applyTypedTime('2026-11-04T07:02', '730p')).toBe('2026-11-04T19:30');
  });
  it('takes the half of the day closest to the old time when none is typed', () => {
    expect(applyTypedTime('2026-11-04T07:02', '730')).toBe('2026-11-04T07:30');
    expect(applyTypedTime('2026-11-04T15:30', '345')).toBe('2026-11-04T15:45');
    expect(applyTypedTime('2026-11-04T11:50', '1205')).toBe('2026-11-04T12:05');
  });
  it('is empty for text it cannot read', () => expect(applyTypedTime('2026-11-04T07:02', 'soon')).toBe(''));
});

describe('helpers', () => {
  it('inputToTyped', () => {
    expect(inputToTyped('2026-11-04T00:05')).toBe('12:05 AM');
    expect(inputToTyped('2026-11-04T13:00')).toBe('1:00 PM');
  });
  it('shiftDays crosses a month', () => expect(shiftDays('2026-10-31T01:00', 1)).toBe('2026-11-01T01:00'));
  it('orderIssue flags an out before its in and offers the next day', () => {
    expect(orderIssue('out', '2026-11-04T01:00', '2026-11-04T22:00')).toEqual({
      message: 'Out 1:00 AM is before In 10:00 PM.', nextDay: '2026-11-05T01:00' });
    expect(orderIssue('out', '2026-11-04T16:00', '2026-11-04T07:00')).toBeNull();
    expect(orderIssue('in', '2026-11-04T17:00', '2026-11-04T16:00').message).toBe('In 5:00 PM is after Out 4:00 PM.');
  });
});
