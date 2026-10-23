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

  it('a built-in is Filled By Nexus, read-only, never NEW', () => {
    const builtins = { first_name: { label: 'First name', when: 'person' }, job_title: { label: 'Job title', when: 'person' } };
    render(<TemplateFieldsPanel fieldDefs={[]} tokens={['first_name', 'pan_number']} highlight={['pan_number']}
      docTokens={['first_name', 'job_title', 'pan_number']} builtins={builtins}
      onChange={() => {}} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Filled By Nexus')).toBeTruthy();
    const row = screen.getByTestId('nexus-first_name');
    expect(row.textContent).toContain("From the person's profile");
    expect(row.querySelector('select')).toBeNull();
    expect(screen.queryByLabelText('Who fills First name')).toBeNull();
    expect(screen.getByTestId('nexus-job_title')).toBeTruthy();
    expect(screen.getAllByText('NEW')).toHaveLength(1);          // only the custom one
    // ...and the custom one is guessed as Text, not Number.
    expect(screen.getByLabelText('Type for Pan Number').value).toBe('text');
  });

  it('who fills reads in plain words and keeps the stored values', () => {
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={[{ token: 'pan_number', label: 'PAN', type: 'text', source: 'person' }]}
      onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    const sel = screen.getByLabelText('Who fills PAN');
    expect([...sel.options].map(o => o.textContent)).toEqual(
      ['Whoever Makes The Document', 'The New Hire (Intake Form)', 'HR At The Offer']);
    expect(sel.value).toBe('person');
    expect(screen.getByText(/Asked on the new hire's intake form/)).toBeTruthy();
    fireEvent.change(sel, { target: { value: 'hr' } });
    expect(onChange.mock.calls[0][0][0].source).toBe('hr');
  });

  it('a new field starts from the setting another template gave it', () => {
    const shared = { pan_number: { templateName: 'NDA', type: 'text', source: 'person', required: true, sensitive: true } };
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={[]} tokens={['pan_number']} shared={shared}
      onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Who fills Pan Number').value).toBe('person');
    expect(screen.getByText('Same as in NDA')).toBeTruthy();
  });

  it('warns when another template defines it differently, and brings it in step', () => {
    const shared = { pan_number: { templateName: 'NDA', type: 'text', source: 'person', required: true, sensitive: true } };
    const onChange = vi.fn();
    render(<TemplateFieldsPanel fieldDefs={[{ token: 'pan_number', label: 'PAN', type: 'number', source: '' }]} shared={shared}
      onChange={onChange} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/Defined differently in NDA/)).toBeTruthy();
    fireEvent.click(screen.getByText('Use The Same Setting'));
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ token: 'pan_number', label: 'PAN', type: 'text', source: 'person', required: true, sensitive: true });
  });

  it('says so when the template has no variables yet', () => {
    render(<TemplateFieldsPanel fieldDefs={[]} onChange={() => {}} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no variables yet/)).toBeTruthy();
  });
});
