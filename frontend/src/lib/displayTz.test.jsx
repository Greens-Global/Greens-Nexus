// A team Time Sheet opens in the EMPLOYEE's zone (Visesh, Oct 20 2026):
// India time for India-based staff, California for US staff, unless the
// viewer flipped the switch on that kind of employee before.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
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
    localStorage.clear();
  });

  it('opens an India-based employee in India time and a US employee in California time', () => {
    const india = render(<Card zoneKey="india" />);
    expect(india.getByTestId('tz').textContent).toBe('india');
    india.unmount();
    expect(currentTzOption().key).toBe('california');   // leaving puts the app-wide choice back
    const us = render(<Card zoneKey="california" />);
    expect(us.getByTestId('tz').textContent).toBe('california');
  });

  it('remembers the viewer\'s manual choice per employee zone', () => {
    const a = render(<Card zoneKey="india" />);
    act(() => setDisplayTz('california'));
    expect(a.getByTestId('tz').textContent).toBe('california');
    a.unmount();
    expect(localStorage.getItem('nexus:timecardTz:for:india')).toBe('california');
    const b = render(<Card zoneKey="india" />);
    expect(b.getByTestId('tz').textContent).toBe('california');
    b.unmount();
    // US staff are untouched by the India choice.
    const c = render(<Card zoneKey="california" />);
    expect(c.getByTestId('tz').textContent).toBe('california');
  });

  it('does nothing on your own card or without a zone from the server', () => {
    const a = render(<Card zoneKey="india" self />);
    expect(a.getByTestId('tz').textContent).toBe('california');
    a.unmount();
    const b = render(<Card zoneKey="" />);
    expect(b.getByTestId('tz').textContent).toBe('california');
  });

  it('works when storage is blocked', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      const a = render(<Card zoneKey="india" />);
      expect(a.getByTestId('tz').textContent).toBe('india');
      a.unmount();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
