import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Amount, { AmountInput, formatAmount, formatScaled, formatShort, parseAmountInput } from './Amount';

// The typography brief's number rules, as tests.
describe('formatAmount', () => {
  it('two decimals, comma separators, parentheses for a negative', () => {
    expect(formatAmount(248310.42)).toBe('248,310.42');
    expect(formatAmount(-3418.07)).toBe('(3,418.07)');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount('12')).toBe('12.00');
  });
  it('display scales never touch the cents of the exact figure', () => {
    expect(formatScaled(319892.35, 'whole')).toBe('319,892');
    expect(formatScaled(319892.35, 'thousands')).toBe('320');
    expect(formatScaled(-1500, 'thousands')).toBe('(2)');
    expect(formatScaled(319892.35, 'exact')).toBe('319,892.35');
  });
  it('KPI cards round: $321K, $1.2M', () => {
    expect(formatShort(321400)).toBe('$321K');
    expect(formatShort(1234567)).toBe('$1.2M');
    expect(formatShort(-2500)).toBe('($2,500)');
  });
});

describe('parseAmountInput', () => {
  it('takes shorthand, math and parentheses', () => {
    expect(parseAmountInput('5k')).toBe(5000);
    expect(parseAmountInput('1.2m')).toBe(1200000);
    expect(parseAmountInput('=1200*3')).toBe(3600);
    expect(parseAmountInput('=(10+5)*2k')).toBe(30000);
    expect(parseAmountInput('(250)')).toBe(-250);
    expect(parseAmountInput('$1,234.50')).toBe(1234.5);
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('=alert(1)')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
  });
});

describe('<Amount />', () => {
  it('reserves the ) slot on positives and zero, shows a dash for zero on statements', () => {
    const { container } = render(<><Amount value={1234.5} /><Amount value={-20} /><Amount value={0} zero="dash" /><Amount value={0} /></>);
    const spans = container.querySelectorAll('span.num');
    expect([...spans].map((s) => [s.textContent, s.classList.contains('neg')])).toEqual([['1,234.50', false], ['(20.00)', true], ['–', false], ['0.00', false]]);
  });
  it('AmountInput resolves shorthand when the field is left', () => {
    let got = null;
    render(<AmountInput aria-label="Balance" value={''} onChange={(v) => { got = v; }} />);
    const box = screen.getByLabelText('Balance');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '5k' } });
    fireEvent.blur(box);
    expect(got).toBe(5000);
    expect(box.value).toBe('5,000.00');
  });
});
