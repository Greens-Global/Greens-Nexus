import { describe, it, expect } from 'vitest';
import { placeOf, placeOptions, placeKeyFor, inPlace, placeLabel, allPlaceLabels } from './changelogPlaces';

// What's New's Module filter follows the site's navigation (Neil, 11/04/2026).
// The module text is whatever a PR title started with, so these are real ones.
const at = (module, title = 'Something changed') => placeOf({ module, title });

describe('placeOf', () => {
  it('reads "Section > Page" and "Section - Page"', () => {
    expect(at('Dashboard > Approvals').label).toBe('Dashboard - Approvals');
    expect(at('Workday - Time Sheet').label).toBe('Workday - Time Sheet');
    expect(at('People > Reports').label).toBe('People - Reports');
  });

  it('puts a page named by its own words under its section', () => {
    expect(at('Time Sheets to Review').label).toBe('People - Time');
    expect(at('Payroll Export Codes').label).toBe('Settings - Time & Pay');      // longer than "payroll"
    expect(at('Time Off prod feedback').label).toBe('Workday - Time Off');
    expect(at('Shifts Phase 3a').label).toBe('Team - Shift Planner');
    expect(at('Filing & Sorting').label).toBe('Files - Filing & Sorting');
    expect(at('Approvals inbox').label).toBe('Dashboard - Approvals');
  });

  it('a bare page label counts only beside its section', () => {
    expect(at('Reports').label).toBe('Accounting - Reports');                    // "reports" is Accounting's own word
    expect(at('Tickets', 'Ops review: reports builder').label).toBe('Tickets');   // not a Reports page from the title
  });

  it('a section by name, with the page from the title', () => {
    expect(at('HR', 'Redesigned Org Chart').label).toBe('People - Organizational Chart');
    expect(at('Time Clock', 'Request Fixes for Missed Punches').label).toBe('Workday');
    expect(at('Accounting Oct 22').label).toBe('Accounting');
  });

  it('a module that names nothing hands over to the title', () => {
    expect(at('General', 'Hiring form answers fill the People profile').label).toBe('People - Hiring');
    expect(at('Oct 28 batch', 'Ticket Reports: CSV').label).toBe('Tickets - Reports');
    expect(at('General', 'AI is off unless Neil turns it on').label).toBe('Across Nexus');
  });

  it('keeps the app-wide work in Across Nexus, even when its title names a module', () => {
    expect(at('Bundle budget', '15900 -> 16200 KB').label).toBe('Across Nexus');
    expect(at('Sidebar', 'The time clock lives at its foot').label).toBe('Across Nexus');
    expect(at('People Pickers Everywhere').label).toBe('Across Nexus');
  });

  it('the Screen picked on the update decides the section', () => {
    expect(placeOf({ module: 'Misc', title: 'x', screen: 'tickets' }).label).toBe('Tickets');
    expect(placeOf({ module: 'Time Sheet', title: 'x', screen: 'timeclock' }).label).toBe('Workday - Time Sheet');
  });

  it('IT is a section only by its exact name', () => {
    expect(at('IT').label).toBe('IT');
    expect(at('General', 'Make it faster').label).toBe('Across Nexus');
  });
});

describe('the filter', () => {
  const entries = [
    { module: 'Workday', title: 'a' }, { module: 'Time Sheet', title: 'b' }, { module: 'Timesheets', title: 'c' },
    { module: 'Dashboard > Approvals', title: 'd' }, { module: 'Tickets', title: 'e' },
  ];

  it('lists sections in the navigation order, each followed by its pages, with counts', () => {
    expect(placeOptions(entries).map((o) => `${o.label} ${o.count}`)).toEqual([
      'Dashboard 1', 'Dashboard - Approvals 1', 'Workday 3', 'Workday - Time Sheet 2', 'Tickets 1',
    ]);
  });

  it('a section takes in its pages; a page only itself', () => {
    const ts = placeOf(entries[1]);
    expect(inPlace(ts, 'myhr')).toBe(true);
    expect(inPlace(ts, 'myhr/timesheet')).toBe(true);
    expect(inPlace(placeOf(entries[0]), 'myhr/timesheet')).toBe(false);
  });

  it('an old link with a raw module name lands on its place', () => {
    expect(placeKeyFor('Time Sheets to Review')).toBe('hr/time');
    expect(placeKeyFor('myhr/timesheet')).toBe('myhr/timesheet');
    expect(placeKeyFor('tickets')).toBe('tickets');
    expect(placeLabel('myhr/timesheet')).toBe('Workday - Time Sheet');
  });

  it('suggests every place to an author', () => {
    expect(allPlaceLabels()).toContain('Workday - Time Sheet');
    expect(allPlaceLabels()).toContain('Dashboard - Notes');
  });
});
