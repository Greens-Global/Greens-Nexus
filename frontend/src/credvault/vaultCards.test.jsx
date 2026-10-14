import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeptBars, RotationList, Monogram, deptColor, DEPT_COLORS } from './vaultCards';

const cred = (over = {}) => ({ id: 'c', name: 'Stripe', dept: 'Accounting', canReveal: true, rotatedAt: '2026-10-01', rotatedDays: 10, rotationMax: 90, ...over });

describe('stat cards', () => {
  it('ranks departments by count and filters on click', () => {
    const rows = [cred(), cred({ id: 'a', dept: 'IT' }), cred({ id: 'b', dept: 'IT' })];
    const onPick = vi.fn();
    render(<DeptBars rows={rows} depts={['Accounting', 'IT']} active="" onPick={onPick} />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels[0]).toContain('IT');
    expect(labels[0]).toContain('2');
    fireEvent.click(screen.getByTitle('Show Accounting'));
    expect(onPick).toHaveBeenCalledWith('Accounting');
    expect(deptColor('IT', ['Accounting', 'IT'])).toBe(DEPT_COLORS[1]);
    expect(deptColor('Unknown', ['Accounting'])).toBe(DEPT_COLORS[0]);     // never undefined
  });

  it('lists what rotates next, overdue first, and only what you can open', () => {
    const rows = [
      cred({ id: 'ok', name: 'Fresh', rotatedDays: 5 }),
      cred({ id: 'late', name: 'Overdue', rotatedDays: 100 }),
      cred({ id: 'soon', name: 'Soon', rotatedDays: 85 }),
      cred({ id: 'hidden', name: 'Hidden', rotatedDays: 200, canReveal: false }),
    ];
    const onPick = vi.fn();
    render(<RotationList rows={rows} onPick={onPick} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names[0]).toContain('Overdue');
    expect(names[0]).toContain('10d overdue');
    expect(names[1]).toContain('Soon');
    expect(names.join(' ')).not.toContain('Hidden');
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onPick).toHaveBeenCalledWith('late');
  });

  it('makes a two-letter monogram', () => {
    const { container } = render(<><Monogram name="Stripe Dashboard" dept="Accounting" depts={['Accounting']} /><Monogram name="Jira" dept="IT" depts={['IT']} /><Monogram name="" dept="" depts={[]} /></>);
    expect([...container.querySelectorAll('.cv-mono-tile')].map((t) => t.textContent)).toEqual(['SD', 'JI', '?']);
  });
});
