// Health by Department on a phone (11/15/2026 phone pass): nine columns broke
// every heading into single letters at 390px, so each department is one row -
// its logins and only the counts that are not zero, in words - with a total.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HealthList } from './Overview';

const row = (dept, over = {}) => ({ dept, total: 1, critical: 0, breached: 0, weak: 0, reused: 0, overdue: 0, expiring: 0, noBackup: 0, ...over });

describe('HealthList', () => {
  it('names only what needs fixing, totals it, and a department opens its list', () => {
    const onPickDept = vi.fn();
    render(<HealthList health={[row('Accounting', { critical: 1, expiring: 1, noBackup: 1 }), row('Marketing', { total: 2 })]} fDept="" onPickDept={onPickDept} />);
    const acct = screen.getByRole('button', { name: 'Show Accounting' });
    expect(acct.textContent).toBe('Accounting1 login1 Critical1 Expiring1 No Backup');
    expect(screen.getByRole('button', { name: 'Show Marketing' }).textContent).toBe('Marketing2 loginsNothing to fix');
    expect(screen.getByText('Total').closest('.cv-health-list-row').textContent).toBe('Total3 logins1 Critical1 Expiring1 No Backup');
    fireEvent.click(acct);
    expect(onPickDept).toHaveBeenCalledWith('Accounting');
  });

  it('one department: no total row', () => {
    render(<HealthList health={[row('IT')]} fDept="IT" onPickDept={() => {}} />);
    expect(screen.queryByText('Total')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show IT' }).className).toContain('is-active');
  });
});
