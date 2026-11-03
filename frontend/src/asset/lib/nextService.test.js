import { describe, it, expect } from 'vitest';
import { nextService, currentOdometer, dayOf } from './nextService.js';
import { assetSignals } from './assetMetrics.js';
import { collectCriticalDates } from './criticalItems.js';
import { fleetFactsFor, lastChangeOf } from './fleetCards.js';
import { RECORD_TYPES } from './recordTypes.jsx';

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
    expect(sig).toEqual({ l: 'Service', v: 'Overdue', t: 'bad', by: 'date' });
  });
});

describe('nextService - the newest target supersedes (review 11/02/2026)', () => {
  it('a fresh service that sets only a date ends an older mileage target', () => {
    const store = { vservice: [
      svc({ date: '2026-05-01', mileage: '8000', nextMileage: '13000' }),
      svc({ date: '2026-10-20', mileage: '13400', nextDue: '2027-04-20' }),
    ] };
    const s = nextService(van, store, TODAY);
    expect(s.by).toBe('date');
    expect(s.state).toBe('live');
    expect(s.milesLeft).toBeNull();
    expect(s.dueDate).toBe('2027-04-20');
    expect(assetSignals(van, store).find((x) => x.l === 'Service').v).toBe('Current');
  });

  it('a fresh service that sets only miles ends an older date target', () => {
    const store = { vservice: [
      svc({ date: '2026-04-01', nextDue: '2026-10-01' }),
      svc({ date: '2026-09-28', mileage: '9000', nextMileage: '14000' }),
    ] };
    const s = nextService(van, store, TODAY);
    expect(s.by).toBe('miles');
    expect(s.state).toBe('live');
    expect(s.dueDate).toBe('');
    expect(s.note).toBe('5,000 mi to next service');
  });

  it('drops a target a later service already passed (done, not overdue)', () => {
    const byDate = { vservice: [
      { propertyId: 'e1', date: '2026-04-01', nextDue: '2026-09-01', type: 'Inspection' },
      { propertyId: 'e1', date: '2026-09-03', type: 'Repair' },
    ] };
    expect(nextService(loader, byDate, TODAY)).toBeNull();
    const byMiles = { vservice: [
      svc({ date: '2026-03-01', mileage: '5000', nextMileage: '10000' }),
      svc({ date: '2026-09-01', mileage: '10200', type: 'Brakes' }),
    ] };
    expect(nextService(van, byMiles, TODAY)).toBeNull();
  });

  it('uses the asset fields only when no service row names a target', () => {
    const legacy = { ...loader, lastServiceDate: '2026-08-02', nextServiceDate: '2026-12-02' };
    const store = { vservice: [{ propertyId: 'e1', date: '2026-09-01', nextDue: '2027-03-01' }] };
    expect(nextService(legacy, store, TODAY).dueDate).toBe('2027-03-01');
    // A service logged after the old due date completes it.
    const done = { vservice: [{ propertyId: 'e1', date: '2026-12-05', type: 'Repair' }] };
    expect(nextService(legacy, done, TODAY)).toBeNull();
  });
});

describe('nextService - garbled values', () => {
  it('ignores a next odometer at or below the service odometer', () => {
    const store = { vservice: [svc({ date: '2026-08-01', mileage: '13000', nextMileage: '500' })], odometer: [{ propertyId: 'v1', date: '2026-10-01', mileage: '14000' }] };
    expect(nextService(van, store, TODAY)).toBeNull();
  });

  it('skips an odometer typo so it cannot pin "overdue"', () => {
    const store = {
      vservice: [svc({ date: '2026-08-01', mileage: '8000', nextMileage: '13000' })],
      odometer: [
        { propertyId: 'v1', date: '2026-10-01', mileage: '11880' },
        { propertyId: 'v1', date: '2026-10-15', mileage: '118800' },   // an extra digit
      ],
    };
    expect(currentOdometer(van, store)).toBe(11880);
    expect(nextService(van, store, TODAY).state).toBe('live');
    // A new vehicle going 100 -> 300 mi is real, not a typo.
    expect(currentOdometer(van, { odometer: [{ propertyId: 'v1', mileage: '100' }, { propertyId: 'v1', mileage: '300' }] })).toBe(300);
  });

  it('treats an impossible date as no date', () => {
    expect(dayOf('2026-13-45')).toBeNull();
    expect(dayOf('02/30/2026')).toBeNull();
    expect(dayOf('2026-02-28').getDate()).toBe(28);
    expect(nextService(loader, { vservice: [{ propertyId: 'e1', date: '2026-09-01', nextDue: '2026-13-45' }] }, TODAY)).toBeNull();
  });

  it('never tracks miles for equipment', () => {
    const store = { vservice: [{ propertyId: 'e1', date: '2026-08-01', mileage: '100', nextMileage: '600' }] };
    expect(nextService({ ...loader, odometer: '700' }, store, TODAY)).toBeNull();
  });
});

describe('Health Status Service signal - miles band', () => {
  const store = (odo) => ({ vservice: [svc({ date: '2026-08-01', mileage: '8000', nextMileage: '13000' })], odometer: [{ propertyId: 'v1', date: '2026-11-01', mileage: odo }] });
  const sig = (odo) => assetSignals(van, store(odo)).find((x) => x.l === 'Service');
  it('warns within 500 mi', () => {
    expect(sig('12950')).toEqual({ l: 'Service', v: '50 mi left', t: 'warn', by: 'miles' });
  });
  it('warns at 90% of the way even with more than 500 mi left', () => {
    // 5,000 mi interval: 4,600 in is 92%, 400 left; use a longer interval for the % case.
    const long = { vservice: [svc({ date: '2026-08-01', mileage: '10000', nextMileage: '20000' })], odometer: [{ propertyId: 'v1', mileage: '19200' }] };
    expect(assetSignals(van, long).find((x) => x.l === 'Service')).toEqual({ l: 'Service', v: '800 mi left', t: 'warn', by: 'miles' });
  });
  it('is due now at exactly the target', () => {
    expect(sig('13000')).toEqual({ l: 'Service', v: 'Due Now', t: 'warn', by: 'miles' });
  });
  it('is current well under', () => {
    expect(sig('10000')).toEqual({ l: 'Service', v: 'Current', t: 'ok' });
  });
});

describe('Critical Items - one Service row per asset, from nextService', () => {
  it('lists the current target only, never a superseded row', () => {
    const store = {
      properties: [{ ...loader }],
      vservice: [
        { propertyId: 'e1', date: '2026-01-01', nextDue: '2026-04-01', type: 'Inspection' },
        { propertyId: 'e1', date: '2026-04-02', nextDue: '2027-01-15', type: 'Scheduled Maintenance' },
      ],
    };
    const rows = collectCriticalDates(store).filter((x) => x.cat === 'Service');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'e1', label: 'Next Service Due', date: '2027-01-15', detail: 'Scheduled Maintenance' });
  });
});

describe('fleetFactsFor', () => {
  it('works out every fleet asset in one pass and skips properties', () => {
    const logs = [
      { propertyId: 'v1', ts: '2026-10-30T10:00:00.000Z', user: 'neil@greensglobal.com' },
      { propertyId: 'v1', ts: '2026-11-01T10:00:00.000Z' },
    ];
    const facts = fleetFactsFor([{ ...van, odometer: '11880', _rev: '2026-11-02T09:00:00+00:00' }, { id: 'p1', name: 'Greens Austin' }], {
      vservice: [svc({ date: '2026-08-01', mileage: '8000', nextMileage: '13000' })], logs,
    });
    expect(Object.keys(facts)).toEqual(['v1']);
    expect(facts.v1.service.note).toBe('1,120 mi to next service');
    expect(facts.v1.odometer).toBe(11880);
    // A person's newest log entry beats the row stamp (which machine writes also move).
    expect(facts.v1.changed).toBe('2026-10-30T10:00:00.000Z');
  });

  it('falls back to the row stamp, then to any log entry', () => {
    expect(lastChangeOf({ id: 'v1', _rev: '2026-11-02T09:00:00+00:00' }, [{ propertyId: 'v1', ts: '2026-11-01T10:00:00.000Z' }])).toBe('2026-11-02T09:00:00+00:00');
    expect(lastChangeOf({ id: 'v1' }, [{ propertyId: 'v1', ts: '2026-11-01T10:00:00.000Z' }])).toBe('2026-11-01T10:00:00.000Z');
    expect(lastChangeOf({ id: 'v1' }, [])).toBe('');
  });
});

describe('Service log Next Due column', () => {
  it('shows the next odometer for a vehicle only', () => {
    const col = RECORD_TYPES.vservice.cols.find((c) => c.label === 'Next Due');
    const row = { nextDue: '2026-12-01', nextMileage: '13000' };
    expect(col.mono(row, { kind: 'vehicle' })).toBe('12/01/2026 or 13,000 mi');
    expect(col.mono(row, { kind: 'equipment' })).toBe('12/01/2026');
    expect(col.mono({}, { kind: 'vehicle' })).toBe('-');
  });
});
