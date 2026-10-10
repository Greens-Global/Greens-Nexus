import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OrgChartLens from './OrgChartLens';

// The directory reloads every minute and hands the chart new objects with the
// same shape. That must not refold what the viewer opened or closed; a filter
// change (a new shape) starts again from the default folding.
const P = (email, name, managerEmail = '') => ({
  email, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1], jobTitle: 'Analyst', department: 'Accounting',
  departmentRole: '', company: 'co1', companyName: 'Greens Co', managerEmail, managerName: '', mobile: '', officePhone: '',
  photoUrl: '', status: 'active', availability: null, division: '',
});
const people = () => [P('bo@x', 'Bo Boss'), P('sam@x', 'Sam Staff', 'bo@x'), P('kim@x', 'Kim Kay', 'sam@x'), P('lee@x', 'Lee Leave', 'bo@x')];
const onChart = () => [...screen.getByRole('region', { name: 'Organization chart' }).querySelectorAll('[data-orgkey]')].map((n) => n.getAttribute('data-orgkey')).sort();

describe('Org Chart lens', () => {
  it('keeps the viewer folding through a refresh and resets it on a new shape', () => {
    const props = { query: '', me: 'lee@x', selected: '', onSelect: vi.fn(), mobile: false, canOpenPeople: false };
    const { rerender } = render(<OrgChartLens {...props} people={people()} />);
    expect(onChart()).toEqual(['bo@x', 'lee@x', 'sam@x']);
    fireEvent.click(screen.getByRole('button', { name: "Show Sam Staff's team (1)" }));
    expect(onChart()).toContain('kim@x');

    rerender(<OrgChartLens {...props} people={people()} />);          // the minute refresh
    expect(onChart()).toContain('kim@x');

    rerender(<OrgChartLens {...props} people={[...people(), P('ann@x', 'Ann Able', 'bo@x')]} />);   // a new shape
    expect(onChart()).toEqual(['ann@x', 'bo@x', 'lee@x', 'sam@x']);
  });

  it('does not reopen a team the viewer folded when a refresh arrives during a search', () => {
    const props = { query: 'kim', me: '', selected: '', onSelect: vi.fn(), mobile: false, canOpenPeople: false };
    const { rerender } = render(<OrgChartLens {...props} people={people()} />);
    expect(onChart()).toContain('kim@x');                               // the search unfolded Sam's team
    fireEvent.click(screen.getByRole('button', { name: "Hide Sam Staff's team (1)" }));
    expect(onChart()).not.toContain('kim@x');
    rerender(<OrgChartLens {...props} people={people()} />);
    expect(onChart()).not.toContain('kim@x');
  });
});
