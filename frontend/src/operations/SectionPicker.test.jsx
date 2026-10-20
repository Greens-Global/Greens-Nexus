import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MultiPicker, SectionPicker } from './SectionPicker';

const OPTS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }];

describe('Operations section dropdowns', () => {
  it('switches with a labeled select', () => {
    const onChange = vi.fn();
    render(<SectionPicker label="View" value="a" options={OPTS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'c' } });
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('caps a multi-select and disables what is past the cap', () => {
    function Host() {
      const [v, setV] = useState(['a']);
      return <MultiPicker label="Group By" value={v} options={OPTS} onChange={setV} max={2} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Group By/ }));
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]);
    expect(screen.getByRole('button', { name: /Alpha, Beta/ })).toBeTruthy();
    expect(screen.getAllByRole('checkbox')[2].disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Group By' })).toBeNull();
  });
});
