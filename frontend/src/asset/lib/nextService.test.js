import { describe, it, expect } from 'vitest';
import { nextService, currentOdometer } from './nextService.js';
import { assetSignals } from './assetMetrics.js';

// The one next-service rule (fleet cards, Neil 11/02/2026).
const TODAY = new Date(2026, 10, 2); // 11/02/2026
const van = { id: 'v1', kind: 'vehicle', name: 'Ford Transit 250', odometer: '' };
const loader = { id: 'e1', kind: 'equipment', name: 'Bobcat S650', hours: '1204' };
const svc = (fields) => ({ propertyId: 'v1', type: 'Oil Change', ...fields });

describe('nextService', () => {
  it('is null with no service data - no fake bar', () => {
    expect(nextService(van, {}, TODAY)).toBeNull();
    expect(nextService(van, { vservice: [svc({ date: '2026-09-01' })] }, TODAY)).toBeNull();
    expect(nextService(loader, { vservice: [] }, TODAY)).toBeNull();
    // A property never has one.
    expect(nextService({ id: 'p1', name: 'Greens Austin' }, { vservice: [{ propertyId: 'p1', date: '2026-01-01', nextDue: '2026-12-01' }] }, TODAY)).toBeNull();
  });

  it('tracks by date from the last service to the next one', () => {
    // 09/01 -> 12/01 is 91 days; 11/02 is 62 days in.
    const s = nextService(loader, { vservice: [{ propertyId: 'e1', date: '2026-09-01', nextDue: '2026-12-01' }] }, TODAY);
    expect(s.by).toBe('date');
    expect(s.state).toBe('live');
    expect(s.track).toBe(true);
    expect(s.value).toBeCloseTo(62 / 91, 2);
    expect(s.note).toBe('Due 12/01/2026');
    expect(s.daysLeft).toBe(29);
  });

  it('uses the newest service row that names a next date', () => {
    const s = nextService(loader, { vservice: [
      { propertyId: 'e1', date: '2026-03-01', nextDue: '2026-06-01' },   // superseded
      { propertyId: 'e1', date: '2026-06-02', nextDue: '2026-12-02' },
      { propertyId: 'e1', date: '2026-10-01', type: 'Repair' },          // no next date
    ] }, TODAY);
    expect(s.dueDate).toBe('2026-12-02');
    expect(s.state).toBe('live');
  });

  it('falls back to the asset fields when the log has no next date', () => {
    const s = nextService({ ...loader, lastServiceDate: '2026-08-02', nextServiceDate: '2026-12-02' }, {}, TODAY);
    expect(s.note).toBe('Due 12/02/2026');
    expect(s.value).toBeCloseTo(92 / 122, 2);
  });

  it('is overdue (red, full) once the date has passed', () => {
    const s = nextService(loader, { vservice: [{ propertyId: 'e1', date: '2026-04-01', nextDue: '2026-10-21' }] }, TODAY);
    expect(s.state).toBe('overdue');
    expect(s.value).toBe(1);
    expect(s.note).toBe('12 days past due');
  });

  it('shows the note but no bar for a future date with nothing to measure from', () => {
    const s = nextService({ ...loader, snapshot: [{ group: 'Service', fields: [{ label: 'Next Service Due', value: '2026-11-14' }] }] }, {}, TODAY);
    expect(s.track).toBe(false);
    expect(s.note).toBe('Due 11/14/2026');
  });

  it('tracks by miles from the service odometer to the next one', () => {
    const store = {
      vservice: [svc({ date: '2026-08-01', mileage: '8000', nextMileage: '13000' })],
      odometer: [{ propertyId: 'v1', date: '2026-10-30', mileage: '11880' }],
    };
    expect(currentOdometer(van, store)).toBe(11880);
    const s = nextService(van, store, TODAY);
    expect(s.by).toBe('miles');
    expect(s.state).toBe('live');
    expect(s.value).toBeCloseTo(3880 / 5000, 3);
    expect(s.note).toBe('1,120 mi to next service');
    expect(s.milesLeft).toBe(1120);
  });

  it('is overdue by miles once the odometer passes the target', () => {
    const s = nextService({ ...van, odometer: '67891' }, { vservice: [svc({ date: '2026-05-01', mileage: '62481', nextMileage: '67481' })] }, TODAY);
    expect(s.state).toBe('overdue');
    expect(s.value).toBe(1);
    expect(s.note).toBe('410 mi past due');
  });

  it('reads the legacy interval fields', () => {
    const s = nextService({ ...van, odometer: '34562', nextServiceMi: '37572', serviceIntervalMi: '5000' }, {}, TODAY);
    expect(s.note).toBe('3,010 mi to next service');
    expect(s.value).toBeCloseTo((34562 - 32572) / 5000, 3);
  });

  it('needs a current odometer to track miles', () => {
    expect(nextService(van, { vservice: [svc({ date: '2026-08-01', nextMileage: '13000' })] }, TODAY)).toBeNull();
  });

  it('takes whichever comes first when both a date and miles are on file', () => {
    const store = { vservice: [svc({ date: '2026-08-01', mileage: '8000', nextMileage: '13000', nextDue: '2026-10-31' })], odometer: [{ propertyId: 'v1', date: '2026-10-30', mileage: '9000' }] };
    const s = nextService(van, store, TODAY);
    expect(s.by).toBe('date');           // the date is past, 4,000 mi are left
    expect(s.state).toBe('overdue');
    expect(s.milesLeft).toBe(4000);
    expect(s.dueDate).toBe('2026-10-31');
  });

  it('feeds the Health Status Service signal', () => {
    const store = { vservice: [{ propertyId: 'e1', date: '2026-04-01', nextDue: '2026-10-21' }] };
    const sig = assetSignals(loader, store).find((x) => x.l === 'Service');
    expect(sig).toEqual({ l: 'Service', v: 'Overdue', t: 'bad' });
  });
});
