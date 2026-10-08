import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Amount, { AmountInput, Figure, formatAmount, parseAmountInput } from './Amount';

// The number rules Charmi asked for on 09/30, as tests: thousands separators,
// two decimals, parentheses for a negative, and the reserved ) slot.
describe('formatAmount', () => {
  it('two decimals, comma separators, parentheses for a negative', () => {
    expect(formatAmount(248310.42)).toBe('248,310.42');
    expect(formatAmount(-27680.64)).toBe('(27,680.64)');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount('12')).toBe('12.00');
    expect(formatAmount(1234.567)).toBe('1,234.57');
  });
  it('rounds to the cent before deciding the sign: -0.001 is 0.00, never (0.00)', () => {
    expect(formatAmount(-0.001)).toBe('0.00');
    expect(formatAmount(null)).toBe('0.00');
    expect(formatAmount('abc')).toBe('0.00');
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
  it('positive, negative and zero share the .num class; only a negative drops the ghost ) slot', () => {
    const { container } = render(<><Amount value={1234.5} /><Amount value={-20} /><Amount value={0} /></>);
    const spans = [...container.querySelectorAll('span.num')];
    expect(spans.map((s) => [s.textContent, s.classList.contains('neg')])).toEqual([['1,234.50', false], ['(20.00)', true], ['0.00', false]]);
  });
  it('a zero is a dash on a statement, blank in a debit or credit column, 0.00 by default', () => {
    const { container } = render(<><Amount value={0} zero="dash" /><Amount value={0} zero="blank" /><Amount value={0} /><Amount value={-0.004} zero="dash" /></>);
    expect([...container.querySelectorAll('span.num')].map((s) => s.textContent)).toEqual(['-', '', '0.00', '-']);
    expect(container.querySelector('span.neg')).toBeNull();
  });
  it('a preformatted figure keeps its text and marks a parenthesized one as negative', () => {
    const { container } = render(<><Figure text="(12.0%)" /><Figure text="19.8%" /><Figure text={null} /></>);
    const spans = [...container.querySelectorAll('span.num')];
    expect(spans.map((s) => [s.textContent, s.classList.contains('neg')])).toEqual([['(12.0%)', true], ['19.8%', false], ['', false]]);
  });
  it('AmountInput resolves shorthand when the field is left and shows the figure formatted', () => {
    let got = null;
    render(<AmountInput aria-label="Balance" value={''} onChange={(v) => { got = v; }} />);
    const box = screen.getByLabelText('Balance');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '5k' } });
    fireEvent.blur(box);
    expect(got).toBe(5000);
    expect(box.value).toBe('5,000.00');
    fireEvent.change(box, { target: { value: '(250)' } });
    fireEvent.blur(box);
    expect(got).toBe(-250);
    expect(box.value).toBe('(250.00)');
  });
});
