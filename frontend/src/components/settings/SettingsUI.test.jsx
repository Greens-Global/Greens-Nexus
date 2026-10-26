import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwitchRow, SettingRow, NumberBox } from './SettingsUI';

// The Settings building blocks (Oct 25 2026): the switch is a real checkbox
// (role switch) that the whole row toggles, and a row keeps its control.
describe('SettingsUI', () => {
  it('is a checkbox with role switch, named by its title, and the row toggles it', () => {
    const onChange = vi.fn();
    render(<SwitchRow id="s1" title="Alert managers before overtime" desc="Off unless turned on here." checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Alert managers before overtime' });
    expect(sw.checked).toBe(false);
    fireEvent.click(screen.getByText('Off unless turned on here.'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing while disabled', () => {
    const onChange = vi.fn();
    render(<SwitchRow id="s2" title="A manager approves a release" checked disabled onChange={onChange} />);
    expect(screen.getByRole('switch').disabled).toBe(true);
  });

  it('keeps a number box and its unit together on the right of a row', () => {
    const onChange = vi.fn();
    render(<SettingRow title="Left Early" desc="Minutes before the end." control={<NumberBox label="Left early" value="15" unit="minutes" onChange={onChange} />} />);
    fireEvent.change(screen.getByLabelText('Left early'), { target: { value: '20' } });
    expect(onChange).toHaveBeenCalledWith('20');
    expect(screen.getByText('minutes')).toBeTruthy();
  });
});
