import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TemplateFieldsPanel from './TemplateFieldsPanel';

// Pasting from Word / importing a .docx guesses each variable's type from its
// name. This panel is where those guesses get confirmed or corrected, so the
// Nexus Sign fill form asks for the right kind of value.

const DEFS = [
  { token: 'full_name', label: 'Full Name', type: 'person', required: true },
  { token: 'start_date', label: 'Start Date', type: 'date', required: true },
];

describe('TemplateFieldsPanel', () => {
  it('lists every field with its token and type', () => {
    render(<TemplateFieldsPanel fieldDefs={DEFS} onChange={() => {}} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Full Name')).toBeTruthy();
    expect(screen.getByText('{{start_date}}')).toBeTruthy();
    expect(screen.getByLabelText('Type for Start Date').value).toBe('date');
  });

  it('changing a type saves the whole list, in document order', () => {
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={DEFS} onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Type for Full Name'), { target: { value: 'text' } });
    const next = onChange.mock.calls[0][0];
    expect(next.map(f => f.token)).toEqual(['full_name', 'start_date']);
    expect(next[0].type).toBe('text');
    expect(next[0].label).toBe('Full Name');      // nothing else about the field changes
  });

  it('shows a token found in the text that has no definition, and adds it when typed', () => {
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={DEFS} tokens={['full_name', 'salary']} highlight={['salary']}
      onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText('{{salary}}')).toBeTruthy();
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByLabelText('Type for Salary').value).toBe('currency');   // guessed from the name
    fireEvent.change(screen.getByLabelText('Type for Salary'), { target: { value: 'number' } });
    const next = onChange.mock.calls[0][0];
    expect(next.map(f => f.token)).toEqual(['full_name', 'start_date', 'salary']);
    expect(next[2].type).toBe('number');
  });

  it('a placed field (signature) is never marked required', () => {
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={DEFS} onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Type for Full Name'), { target: { value: 'signature' } });
    expect(onChange.mock.calls[0][0][0].required).toBe(false);
  });

  it('the pencil hands the field to the full editor', () => {
    const onEdit = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={DEFS} onChange={() => {}} onEdit={onEdit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Edit Start Date'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ token: 'start_date' }));
  });

  it('says so when the template has no variables yet', () => {
    render(<TemplateFieldsPanel fieldDefs={[]} onChange={() => {}} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no variables yet/)).toBeTruthy();
  });
});
