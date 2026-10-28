// A team Time Sheet opens in the EMPLOYEE's zone (Visesh, Oct 20 2026):
// India time for India-based staff, California for US staff. No switch and
// nothing remembered (Oct 28 2026).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useEmployeeZone, useDisplayTz, setDisplayTz, currentTzOption } from './displayTz';

function Card({ zoneKey, self = false }) {
  const tz = useDisplayTz();
  useEmployeeZone(!self, zoneKey);
  return <span data-testid="tz">{tz.key}</span>;
}

describe('useEmployeeZone', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    setDisplayTz('california');
  });

  it('opens an India-based employee in India time and a US employee in California time', () => {
    const india = render(<Card zoneKey="india" />);
    expect(india.getByTestId('tz').textContent).toBe('india');
    india.unmount();
    expect(currentTzOption().key).toBe('california');   // leaving puts the default back
    const us = render(<Card zoneKey="california" />);
    expect(us.getByTestId('tz').textContent).toBe('california');
  });

  it('ignores a choice an old switch saved (Oct 28 2026)', () => {
    localStorage.setItem('nexus:timecardTz:for:india', 'california');
    localStorage.setItem('nexus:timecardTz', 'india');
    const a = render(<Card zoneKey="india" />);
    expect(a.getByTestId('tz').textContent).toBe('india');
    a.unmount();
    expect(currentTzOption().key).toBe('california');
    const b = render(<Card zoneKey="" />);
    expect(b.getByTestId('tz').textContent).toBe('california');
  });

  it('does nothing on your own card or without a zone from the server', () => {
    const a = render(<Card zoneKey="india" self />);
    expect(a.getByTestId('tz').textContent).toBe('california');
    a.unmount();
    const b = render(<Card zoneKey="" />);
    expect(b.getByTestId('tz').textContent).toBe('california');
  });
});
