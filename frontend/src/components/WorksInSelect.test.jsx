import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorksInSelect from './WorksInSelect';

// Works In (Neil, 11/04/2026): three places; an older saved place is kept as it was.
describe('WorksInSelect', () => {
  it('offers the three places and hands back country + state', () => {
    const onChange = vi.fn();
    render(<label>Works In<WorksInSelect country="IN" region="" onChange={onChange} /></label>);
    const sel = screen.getByLabelText('Works In');
    expect([...sel.options].map(o => o.textContent)).toEqual(['United States - CA', 'United States - TX', 'India']);
    fireEvent.change(sel, { target: { value: 'US-TX' } });
    expect(onChange).toHaveBeenCalledWith({ country: 'US', region: 'TX' });
  });

  it('shows a place saved before the three as it was, and never changes it by itself', () => {
    const onChange = vi.fn();
    render(<label>Works In<WorksInSelect country="US" region="" emptyLabel="Any Place" onChange={onChange} /></label>);
    const sel = screen.getByLabelText('Works In');
    expect(sel.value).toBe('US-');
    expect(sel.options[1].textContent).toBe('United States - Anywhere');
    fireEvent.change(sel, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ country: '', region: '' });
  });
});
