// A record reference param (Oct 2026): the catalog serves most option
// sources as arrays and the control shows a select for them; only
// "task_projects" is loaded by the builder; a source it does not know keeps
// the paste-an-id box.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { api } = vi.hoisted(() => ({ api: { getTaskProjects: vi.fn(() => Promise.resolve([{ id: 'p1', name: 'Launch' }])) } }));
vi.mock('../../api', () => ({ api }));

import ParamControl from './ParamControl';

const ctx = { catalog: { entities: [], events: [], actions: [], listSources: [], operators: {}, filters: [] }, people: [], companies: [] };

describe('EntityRefControl', () => {
  it('renders a select when the catalog served the options as an array', () => {
    const param = { key: 'template', label: 'Checklist', type: 'entity_ref', required: true, options: [{ value: 'onboarding', label: 'Onboarding' }, { value: 'tpl-1', label: 'Sales - Onboarding, Greens' }] };
    render(<ParamControl id="p" param={param} value="tpl-1" onChange={() => {}} ctx={ctx} />);
    const sel = screen.getByLabelText('Checklist');
    expect(sel.tagName).toBe('SELECT');
    expect(sel.value).toBe('tpl-1');
    expect(screen.getByText('Sales - Onboarding, Greens')).toBeTruthy();
    expect(api.getTaskProjects).not.toHaveBeenCalled();
  });

  it('keeps a saved id the list no longer has, marked', () => {
    const param = { key: 'template', label: 'Letter', type: 'entity_ref', required: true, options: [{ value: 'visa_noc', label: 'Visa NOC' }] };
    render(<ParamControl id="p" param={param} value="old_key" onChange={() => {}} ctx={ctx} />);
    expect(screen.getByLabelText('Letter').value).toBe('old_key');
    expect(screen.getByText('old_key (not in the list)')).toBeTruthy();
  });

  it('loads task projects itself', async () => {
    const param = { key: 'project', label: 'Project', type: 'entity_ref', required: true, options: 'task_projects' };
    render(<ParamControl id="p" param={param} value="" onChange={() => {}} ctx={ctx} />);
    await waitFor(() => expect(screen.getByText('Launch')).toBeTruthy());
    expect(screen.getByLabelText('Project').tagName).toBe('SELECT');
  });

  it('keeps the paste-an-id box for a source it does not know', () => {
    const param = { key: 'ref', label: 'Record', type: 'entity_ref', required: true, options: 'mystery_source' };
    render(<ParamControl id="p" param={param} value="" onChange={() => {}} ctx={ctx} />);
    const box = screen.getByLabelText('Record');
    expect(box.tagName).toBe('INPUT');
    expect(screen.getByText('Enter the id of the record this step uses.')).toBeTruthy();
  });
});
