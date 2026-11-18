import { describe, it, expect } from 'vitest';
import { collectCriticalDates } from './criticalItems.js';

// Only a live permit can need renewing: a closed / finaled / expired permit, or an
// expiration more than a year gone, is history and never reaches Overdue.
const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

describe('permit expirations', () => {
  const store = {
    properties: [{ id: 'p1', name: 'Site', kind: 'property', permits: [
      { 'Permit / Approval Type': 'Live', 'Permit Status': 'Issued', 'Permit Expiration Date': iso(-20) },
      { 'Permit / Approval Type': 'Closed', 'Permit Status': 'Closed', 'Permit Expiration Date': iso(-20) },
      { 'Permit / Approval Type': 'Finaled', 'Permit Status': 'Finaled', 'Permit Expiration Date': iso(10) },
      { 'Permit / Approval Type': 'Already Expired', 'Permit Status': 'Issued Expired', 'Permit Expiration Date': iso(-40) },
      { 'Permit / Approval Type': 'Ancient', 'Permit Status': 'Open', 'Permit Expiration Date': '2013-06-18' },
    ] }],
  };
  const permits = collectCriticalDates(store).filter((x) => x.cat === 'Permit');

  it('keeps a live permit', () => {
    expect(permits.map((x) => x.detail)).toContain('Live');
  });
  it('drops closed, finaled, already-expired and year-old permits', () => {
    expect(permits.map((x) => x.detail)).toEqual(['Live']);
  });
});
