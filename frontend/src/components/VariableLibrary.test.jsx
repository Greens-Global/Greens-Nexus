import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The Variable Library panel (requirement 5.2): "Browse available variables.
// Select a variable. Insert it into the template. Ideally drag and drop. The
// user should not have to manually type complex curly-brace variables every
// time."
//
// The endpoint behind it is covered by test_document_module_requirements.py;
// this is the half a person actually touches - that the list renders grouped,
// that search narrows it, that clicking inserts a TOKEN (never "{{token}}"
// text), and that a drag carries the token on our own private MIME type.

const getDocVariables = vi.fn();
vi.mock('../api', () => ({ api: { getDocVariables: (...a) => getDocVariables(...a) } }));

const VariableLibrary = (await import('./VariableLibrary')).default;
const { VARIABLE_DRAG_TYPE } = await import('../lib/mergeFieldTypes');

const VARIABLES = [
  { token: 'full_name', label: 'Full name', group: 'Person', source: 'builtin', usedBy: [] },
  { token: 'company_legal', label: 'Company legal name', group: 'Company', source: 'builtin', usedBy: ['NDA'] },
  { token: 'principal.amount', label: 'Principal Amount', group: 'Principal', source: 'template', usedBy: ['Promissory Note'] },
  { token: 'agreement.date', label: 'Date', group: 'Agreement', source: 'template', usedBy: ['Promissory Note'] },
];

const setup = (props = {}) => {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  render(<VariableLibrary open onClose={onClose} onInsert={onInsert} {...props} />);
  return { onInsert, onClose };
};

describe('the Variable Library', () => {
  beforeEach(() => { getDocVariables.mockReset().mockResolvedValue(VARIABLES); });

  it('lists the variables, grouped by taxonomy', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Principal Amount')).toBeTruthy());
    for (const group of ['Person', 'Company', 'Principal', 'Agreement']) {
      expect(screen.getByText(group), group).toBeTruthy();
    }
    // The token is shown next to the label, so the author can see the name
    // that will end up in the document.
    expect(screen.getByText('principal.amount')).toBeTruthy();
  });

  it('inserts the token when a variable is clicked', async () => {
    const { onInsert } = setup();
    await waitFor(() => expect(screen.getByText('Principal Amount')).toBeTruthy());
    fireEvent.click(screen.getByText('Principal Amount'));
    // The TOKEN, not "{{principal.amount}}" - the caller turns it into a
    // mergeField node, which is what makes a typo impossible.
    expect(onInsert).toHaveBeenCalledWith('principal.amount');
  });

  it('narrows the list as you search', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Principal Amount')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Search variables…'), { target: { value: 'principal' } });
    expect(screen.getByText('Principal Amount')).toBeTruthy();
    expect(screen.queryByText('Full name')).toBeNull();
  });

  it('says so when nothing matches, rather than looking broken', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Full name')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Search variables…'), { target: { value: 'zzzz' } });
    expect(screen.getByText(/No variable matches/)).toBeTruthy();
  });

  it('carries the token on a drag, on our own MIME type', async () => {
    setup();
    await waitFor(() => expect(screen.getByText('Principal Amount')).toBeTruthy());
    const row = screen.getByText('Principal Amount').closest('button');
    const types = {};
    fireEvent.dragStart(row, { dataTransfer: { setData: (t, v) => { types[t] = v; }, effectAllowed: '' } });
    expect(types[VARIABLE_DRAG_TYPE]).toBe('principal.amount');
    // ...plus a plain-text fallback for a drop outside the editor.
    expect(types['text/plain']).toBe('{{principal.amount}}');
  });

  it('shows a variable this document defines before it reaches any template', async () => {
    getDocVariables.mockResolvedValue([]);
    setup({ localVariables: ['borrower.name'] });
    await waitFor(() => expect(screen.getByText('borrower.name')).toBeTruthy());
    expect(screen.getByText('Borrower')).toBeTruthy();   // grouped by its prefix
  });

  it('does not duplicate a local variable the server already knows', async () => {
    setup({ localVariables: ['principal.amount'] });
    await waitFor(() => expect(screen.getAllByText('principal.amount').length).toBe(1));
  });

  it('reports a failure instead of showing an empty library', async () => {
    getDocVariables.mockRejectedValue(new Error('Network down'));
    setup();
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());
  });

  it('renders nothing at all while closed', () => {
    const { container } = render(<VariableLibrary open={false} onClose={() => {}} onInsert={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(getDocVariables).not.toHaveBeenCalled();
  });
});
