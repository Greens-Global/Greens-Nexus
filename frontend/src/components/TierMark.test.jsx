import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TierMark, { TIER_WORDS } from './TierMark';

// The tier mark (Neil, 11/02/2026): a Super Administrator, an Administrator
// and a Manager each carry one small icon after their name wherever names
// appear - never a chip, never the tier word as text. Employees and
// supervisors carry nothing.

afterEach(cleanup);

describe('TierMark', () => {
  it('draws one mark per top tier, named for assistive tech and the tooltip', () => {
    render(<div><TierMark tier="super" /><TierMark tier="admin" /><TierMark tier="manager" /></div>);
    for (const word of ['Super Administrator', 'Administrator', 'Manager']) {
      const mark = screen.getByLabelText(word);
      expect(mark.getAttribute('title')).toBe(word);
      expect(mark.querySelector('svg')).toBeTruthy();
    }
    expect(TIER_WORDS).toEqual({ super: 'Super Administrator', admin: 'Administrator', manager: 'Manager' });
  });

  it('never writes the tier as text', () => {
    const { container } = render(<TierMark tier="super" />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for an employee, a supervisor, a blank or an unknown tier', () => {
    const { container } = render(<div><TierMark tier="" /><TierMark tier="employee" /><TierMark tier="supervisor" /><TierMark /><TierMark tier="owner" /></div>);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('a caller may name the tooltip', () => {
    render(<TierMark tier="admin" title="Administrator of Greens India" />);
    expect(screen.getByLabelText('Administrator of Greens India').getAttribute('title')).toBe('Administrator of Greens India');
  });
});
