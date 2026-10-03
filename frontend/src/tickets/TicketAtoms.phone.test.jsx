import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Ticket question inputs on a phone (Oct 3): answer chips at least 36px tall,
// checklist rows a thumb can hit with a 20px box, and the decimal number pad
// for number questions. Desktop keeps its compact chips.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));

const { TypeFieldInput } = await import('./TicketAtoms');

function setPhone(isPhone) {
  window.matchMedia = (q) => ({
    matches: isPhone && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}
const realMatchMedia = window.matchMedia;
afterEach(() => { cleanup(); window.matchMedia = realMatchMedia; });

const RADIO = { key: 'r', type: 'radio', options: ['One User', 'Whole Team'] };
const MULTI = { key: 'm', type: 'multiselect', options: ['Email', 'Teams'] };
const CHECK = { key: 'c', type: 'checklist', items: ['Restarted', 'Checked cable'] };
const NUM = { key: 'n', type: 'number', prefix: '$' };

describe('TypeFieldInput on a phone', () => {
  it('makes radio and multiselect chips at least 36px tall', () => {
    setPhone(true);
    render(<><TypeFieldInput field={RADIO} value="" onChange={vi.fn()} /><TypeFieldInput field={MULTI} value={[]} onChange={vi.fn()} /></>);
    for (const name of ['One User', 'Whole Team', 'Email', 'Teams']) {
      expect(screen.getByRole('button', { name }).style.minHeight).toBe('36px');
    }
  });

  it('gives checklist items a 20px box in a 40px row', () => {
    setPhone(true);
    render(<TypeFieldInput field={CHECK} value={[]} onChange={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: 'Restarted' });
    expect(box.style.width).toBe('20px');
    expect(box.style.height).toBe('20px');
    expect(box.closest('label').style.minHeight).toBe('40px');
  });

  it('asks for the decimal pad on number questions', () => {
    setPhone(true);
    render(<TypeFieldInput field={NUM} value="" onChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton').getAttribute('inputmode')).toBe('decimal');
  });
});

describe('TypeFieldInput on a desktop', () => {
  it('keeps the compact chips and the browser checkbox', () => {
    setPhone(false);
    render(<><TypeFieldInput field={RADIO} value="" onChange={vi.fn()} /><TypeFieldInput field={CHECK} value={[]} onChange={vi.fn()} /></>);
    expect(screen.getByRole('button', { name: 'One User' }).style.minHeight).toBe('');
    expect(screen.getByRole('checkbox', { name: 'Restarted' }).style.width).toBe('');
  });
});
