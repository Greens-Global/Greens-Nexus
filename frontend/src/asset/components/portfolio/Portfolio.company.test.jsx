import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Portfolio } from './Portfolio.jsx';
import { NO_COMPANY, companyOptions, companyName, needsCompany } from '../../lib/companies.js';

// The portfolio's Company filter and "Needs a Company" (Neil, 11/03/2026):
// one company's assets, or the live assets with no company set - a linked
// parcel included, since each is set on its own.

const COMPANIES = [
  { id: 'c1', name: 'Greens Storage', assignable: true },
  { id: 'c2', name: 'Other Co', assignable: false },
];
const ASSETS = [
  { id: 'p1', kind: 'property', name: 'Temecula', city: 'Temecula', state: 'CA', companyId: 'c1' },
  { id: 'p2', kind: 'property', name: 'Austin', city: 'Austin', state: 'TX', companyId: 'c2' },
  { id: 'p3', kind: 'property', name: 'Georgetown', city: 'Georgetown', state: 'TX' },
  { id: 'p4', kind: 'property', name: 'Georgetown Yard', city: 'Georgetown', state: 'TX', parentId: 'p2', companyId: 'c2' },
];

function Harness({ initial = '' }) {
  const [companyFilter, setCompanyFilter] = useState(initial);
  const [typeFilter, setTypeFilter] = useState('');
  return (
    <Portfolio props={ASSETS} openProperty={() => {}} typeFilter={typeFilter} setTypeFilter={setTypeFilter} serverOk
      companies={COMPANIES} companyFilter={companyFilter} setCompanyFilter={setCompanyFilter} />
  );
}


afterEach(cleanup);

describe('Portfolio - Company filter', () => {
  it('lists each company with its count and Needs a Company', () => {
    render(<Harness />);
    const select = screen.getByRole('combobox', { name: 'Company' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['All Companies', 'Greens Storage (1)', 'Other Co (2)', 'Needs a Company (1)']);
  });

  it('narrows to one company', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Company' }), { target: { value: 'c1' } });
    expect(screen.getByText('Temecula')).toBeTruthy();
    expect(screen.queryByText('Austin')).toBeNull();
    expect(screen.queryByText('Georgetown')).toBeNull();
  });

  it('Needs a Company shows the assets with none, a linked parcel included', () => {
    const parcelLess = ASSETS.map((a) => (a.id === 'p4' ? { ...a, companyId: '' } : a));
    function H() {
      const [c, setC] = useState(NO_COMPANY);
      return <Portfolio props={parcelLess} openProperty={() => {}} typeFilter="" setTypeFilter={() => {}} serverOk companies={COMPANIES} companyFilter={c} setCompanyFilter={setC} />;
    }
    render(<H />);
    expect(screen.getByText('Georgetown')).toBeTruthy();
    expect(screen.getByText('Georgetown Yard')).toBeTruthy();
    expect(screen.queryByText('Temecula')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Clear Filters/ }));
    expect(screen.getByText('Temecula')).toBeTruthy();
  });
});

describe('lib/companies', () => {
  it('names companies, offers only assignable ones and finds the blanks', () => {
    expect(companyName(COMPANIES, 'c2')).toBe('Other Co');
    expect(companyName(COMPANIES, '')).toBe('');
    expect(companyName(COMPANIES, 'gone')).toBe('Unknown Company');
    expect(companyOptions(COMPANIES, '', false).options.map((o) => o.v)).toEqual(['', 'c1']);
    expect(companyOptions(COMPANIES, 'c1', false).options.map((o) => o.v)).toEqual(['c1']);
    expect(companyOptions(COMPANIES, 'c1', true).options.map((o) => o.v)).toEqual(['', 'c1']);
    expect(companyOptions(COMPANIES, 'c2', false)).toEqual({ options: [{ v: 'c2', l: 'Other Co' }, { v: 'c1', l: 'Greens Storage' }], locked: true });
    expect(needsCompany({ id: 'x' })).toBe(true);
    expect(needsCompany({ id: 'x', deleted: true })).toBe(false);
    expect(needsCompany({ id: 'x', companyId: 'c1' })).toBe(false);
  });
});
