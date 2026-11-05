import { describe, it, expect } from 'vitest';
import { formatHM, formatHoursHM, formatHMWords, formatHoursWords } from './hoursText';

describe('formatHM', () => {
  it('reads minutes as hours:minutes', () => {
    expect(formatHM(495)).toBe('8:15');
    expect(formatHM(480)).toBe('8:00');
    expect(formatHM(5)).toBe('0:05');
    expect(formatHM(0)).toBe('0:00');
    expect(formatHM(2645)).toBe('44:05');
  });
  it('rounds to the minute and never shows a decimal', () => {
    expect(formatHM(464.6)).toBe('7:45');
    expect(formatHM(59.5)).toBe('1:00');
  });
  it('signs negatives, and positives when asked', () => {
    expect(formatHM(-90)).toBe('-1:30');
    expect(formatHM(90, { sign: true })).toBe('+1:30');
    expect(formatHM(0, { sign: true })).toBe('0:00');
  });
  it('treats missing values as zero', () => {
    expect(formatHM(null)).toBe('0:00');
    expect(formatHM(undefined)).toBe('0:00');
    expect(formatHM('abc')).toBe('0:00');
  });
});

describe('formatHoursHM', () => {
  it('reads decimal hours as hours:minutes', () => {
    expect(formatHoursHM(8.25)).toBe('8:15');
    expect(formatHoursHM(44.08)).toBe('44:05');
    expect(formatHoursHM(-0.5)).toBe('-0:30');
    expect(formatHoursHM(1.5, { sign: true })).toBe('+1:30');
  });
});

describe('formatHMWords', () => {
  it('reads minutes as hours and minutes in words', () => {
    expect(formatHMWords(450)).toBe('7h 30m');
    expect(formatHMWords(480)).toBe('8h 00m');
    expect(formatHMWords(5)).toBe('0h 05m');
    expect(formatHMWords(-75)).toBe('-1h 15m');
    expect(formatHMWords(75, { sign: true })).toBe('+1h 15m');
    expect(formatHMWords(null)).toBe('0h 00m');
    expect(formatHMWords(75030)).toBe('1,250h 30m');
  });
  it('drops 00m on whole hours when compact', () => {
    expect(formatHMWords(960, { compact: true })).toBe('16h');
    expect(formatHMWords(2250, { compact: true })).toBe('37h 30m');
    expect(formatHMWords(-300, { compact: true })).toBe('-5h');
    expect(formatHMWords(330, { compact: true, sign: true })).toBe('+5h 30m');
    expect(formatHoursWords(16, { compact: true })).toBe('16h');
  });
});

describe('formatHoursWords', () => {
  it('reads decimal hours in words', () => {
    expect(formatHoursWords(312.5)).toBe('312h 30m');
    expect(formatHoursWords(8.5)).toBe('8h 30m');
    expect(formatHoursWords(1250)).toBe('1,250h 00m');
  });
});

describe('big and odd values', () => {
  it('groups the hours of a big total and never prints Infinity', () => {
    expect(formatHM(740730)).toBe('12,345:30');
    expect(formatHM(Infinity)).toBe('0:00');
    expect(formatHMWords(NaN)).toBe('0h 00m');
  });
});
