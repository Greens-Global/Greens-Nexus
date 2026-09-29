import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PersonSearchSelect from './PersonSearchSelect';

// Company Manager(s) picker (Sep 29): a dropdown you can also type into.

const groups = [
  { label: 'Nexus People', people: [{ email: 'charmi@greensglobal.com', name: 'Charmi Shah' }, { email: 'neil@greensglobal.com', name: 'Neil Kadakia' }] },
  { label: 'External Users', people: [{ email: 'owner@gmail.com', name: 'Pat Owner' }] },
];

const setup = () => {
  const onPick = vi.fn();
  render(<PersonSearchSelect groups={groups} onPick={onPick} placeholder="+ add a manager" />);
  return { onPick, input: screen.getByPlaceholderText('+ add a manager') };
};

describe('PersonSearchSelect', () => {
  it('opens the whole list, grouped, like a dropdown', () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(screen.getByText('Nexus People')).toBeTruthy();
    expect(screen.getByText('External Users')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('narrows by name or email as you type', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'kadak' } });
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Neil Kadakianeil@greensglobal.com']);
    fireEvent.change(input, { target: { value: 'gmail' } });
    expect(screen.getByText('Pat Owner')).toBeTruthy();
    expect(screen.queryByText('Nexus People')).toBeNull();   // an emptied group drops its caption
  });

  it('picks with the mouse or the keyboard', () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText('Charmi Shah'));
    expect(onPick).toHaveBeenLastCalledWith('charmi@greensglobal.com');
    fireEvent.change(input, { target: { value: 'pat' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('owner@gmail.com');
  });

  it('says so when nothing matches', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('No one matches "zzz".')).toBeTruthy();
  });
});
