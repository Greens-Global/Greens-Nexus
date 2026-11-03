import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PeopleReports from './PeopleReports';

// People > Reports (Neil, Teams 11/02/2026): Company Directory, Employees and
// Contractors render over the module's rows, the filters narrow them, and the
// numbers never include pay.

const EMPLOYEES = [
  { id: 'e1', firstName: 'Amy', lastName: 'Lee', employeeCode: 'GG-001', jobTitle: 'Site Manager',
    department: 'Storage', company: 'co-1', workEmail: 'amy@greensstorage.com', phone: '555-0100',
    location: 'Escondido', employmentType: 'full_time', status: 'active', startDate: '2024-06-01',
    country: 'US', managerEmail: 'boss@greensglobal.com', identityType: 'internal' },
  { id: 'e2', firstName: 'Carl', lastName: 'Jones', employeeCode: 'GG-002', employmentType: 'contractor',
    company: 'co-1', workEmail: 'carl@greensglobal.com', status: 'active', startDate: '2026-01-05',
    country: 'US', contractor: { billing_client: 'Acme Build', contract_end: '2026-12-31', rate: '95' },
    identityType: 'internal' },
  { id: 'e3', firstName: 'Gone', lastName: 'Guy', employmentType: 'full_time', company: 'co-2',
    status: 'offboarded', identityType: 'internal' },
];
const EXTERNALS = [
  { id: 'x1', firstName: 'Pat', lastName: 'Partner', identityType: 'external',
    externalCompany: 'Acme LLC', workEmail: 'pat@acme.com', status: 'active' },
];
const ENTITIES = [{ id: 'co-1', name: 'Greens Storage' }, { id: 'co-2', name: 'Oversite' }];

const mount = () => render(<PeopleReports employees={EMPLOYEES} externals={EXTERNALS} entities={ENTITIES} />);

describe('People Reports', () => {
  it('shows the Company Directory with externals, Active by default', () => {
    mount();
    expect(screen.getByText('Amy Lee')).toBeTruthy();
    expect(screen.getByText('Pat Partner')).toBeTruthy();          // externals are part of the directory
    expect(screen.getByText('Acme LLC')).toBeTruthy();             // their partner company, not an entity
    expect(screen.queryByText('Gone Guy')).toBeNull();             // Left is hidden until Status says otherwise
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } });
    expect(screen.getByText('Gone Guy')).toBeTruthy();
  });

  it('Employees excludes contractors and externals; Contractors has the engagement, never the rate', () => {
    mount();
    fireEvent.click(screen.getByText('Employees'));
    expect(screen.getByText('Amy Lee')).toBeTruthy();
    expect(screen.queryByText('Carl Jones')).toBeNull();
    expect(screen.queryByText('Pat Partner')).toBeNull();
    fireEvent.click(screen.getByText('Contractors'));
    expect(screen.getByText('Carl Jones')).toBeTruthy();
    expect(screen.getByText('Acme Build')).toBeTruthy();
    expect(screen.getByText('12/31/2026')).toBeTruthy();           // US date, never ISO
    expect(screen.queryByText('Amy Lee')).toBeNull();
    expect(screen.queryByText(/95/)).toBeNull();                   // the rate stays off every report
  });

  it('filters by company and search, and counts what shows', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-1' } });
    expect(screen.getByText('Amy Lee')).toBeTruthy();
    expect(screen.queryByText('Pat Partner')).toBeNull();          // externals belong to no entity
    fireEvent.change(screen.getByLabelText('Search the report'), { target: { value: 'nobody-matches' } });
    expect(screen.getByText('No one matches these filters.')).toBeTruthy();
    expect(screen.getByText('0 people')).toBeTruthy();
  });
});
