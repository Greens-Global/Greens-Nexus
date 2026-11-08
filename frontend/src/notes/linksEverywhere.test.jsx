// Record links everywhere (Neil, 11/07/2026): a [[ chip shown from saved HTML
// in a comment keeps only a valid ref and opens its record; a public ticket
// reply loses its chips to plain words; the task / ticket editor offers [[
// only where asked; Mentioned In lists tasks and tickets; a checklist line
// that links a task ticks itself from the task and completes it when ticked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteMentions: vi.fn(), searchTaskModule: vi.fn(), searchJobs: vi.fn(), kbSearch: vi.fn(),
  searchTickets: vi.fn(), taskStates: vi.fn(), updateTask: vi.fn(), getPeopleDirectory: vi.fn(async () => []),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));

import { sanitizeRichHtml } from '../tasks/lib';
import { unlinkRecords } from '../lib/recordRef';
import RichDescription from '../tasks/RichDescription';
import MentionedIn from '../components/MentionedIn';
import NoteEditor from './NoteEditor';

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  apiMock.notesList.mockResolvedValue({ notes: [] });
  apiMock.searchTaskModule.mockResolvedValue({ tasks: [] });
  apiMock.searchJobs.mockResolvedValue({ jobs: [] });
  apiMock.kbSearch.mockResolvedValue({ results: [] });
  apiMock.searchTickets.mockResolvedValue({ tickets: [] });
  apiMock.taskStates.mockResolvedValue({ tasks: {} });
  apiMock.updateTask.mockResolvedValue({});
});

const editorOf = () => waitFor(() => { const el = document.querySelector('.ProseMirror'); if (!el?.editor) throw new Error('no editor'); return el.editor; });

describe('a chip in saved HTML', () => {
  it('keeps a valid chip without an href, reachable by keyboard, and opens it', async () => {
    const out = sanitizeRichHtml('<p><a data-type="recordLink" data-ref="ticket:k1" href="https://evil.example" title="Gate">Gate</a></p>');
    expect(out).toContain('data-ref="ticket:k1"');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('tabindex="0"');
    const box = document.createElement('div');
    box.innerHTML = out;
    document.body.appendChild(box);
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    fireEvent.click(box.querySelector('a'));
    await waitFor(() => expect(seen).toEqual([{ view: 'tickets', sub: undefined }]));
    window.removeEventListener('nexus:navigate', on);
    box.remove();
  });

  it('drops a bad ref and keeps an ordinary link', () => {
    const out = sanitizeRichHtml('<p><a data-type="recordLink" data-ref="payroll:1" href="https://ok.example/x">x</a></p>');
    expect(out).not.toContain('data-ref');
    expect(out).not.toContain('data-type');
    expect(out).toContain('href="https://ok.example/x"');
  });

  it('turns chips back into words for a public reply', () => {
    expect(unlinkRecords('<p>See <a data-ref="task:t1" title="Gate" data-type="recordLink">Gate</a> now</p>')).toBe('<p>See Gate now</p>');
  });
});

describe('[[ in the task and ticket editor', () => {
  it('offers tasks and tickets and puts a chip', async () => {
    apiMock.searchTickets.mockResolvedValue({ tickets: [{ id: 'k1', code: '000042', subject: 'Gate is stuck', status: 'open' }] });
    const onChange = vi.fn();
    render(<RichDescription value="<p></p>" onChange={onChange} recordLinks />);
    const editor = await editorOf();
    await act(async () => { editor.chain().focus().insertContent('[[gate').run(); });
    expect(await screen.findByText('Gate is stuck')).toBeTruthy();
    expect(screen.getByText('#000042')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('Gate is stuck'));
    const html = onChange.mock.calls.at(-1)[0];
    expect(html).toContain('data-ref="ticket:k1"');
    expect(html).not.toContain('[[');
  });

  it('offers nothing where record links are off', async () => {
    render(<RichDescription value="<p></p>" onChange={vi.fn()} />);
    const editor = await editorOf();
    await act(async () => { editor.chain().focus().insertContent('[[gate').run(); });
    await new Promise((r) => setTimeout(r, 250));
    expect(apiMock.searchTickets).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Link to a Record' })).toBeNull();
  });
});

describe('Mentioned In', () => {
  it('lists tasks and tickets, and says when only a comment links it', async () => {
    apiMock.noteMentions.mockResolvedValue({ items: [
      { kind: 'ticket', id: 'k1', code: '000042', title: 'Gate is stuck', via: 'comment', done: false },
      { kind: 'task', id: 't9', title: 'Order the motor', via: '', done: true },
    ], total: 2 });
    render(<MentionedIn refKey="kb:p1" />);
    expect(await screen.findByText('Mentioned In (2)')).toBeTruthy();
    expect(screen.getByText('#000042 Gate is stuck')).toBeTruthy();
    expect(screen.getByText('in a comment')).toBeTruthy();
    expect(screen.getByText('Order the motor')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });
});

const BOX = (checked) => `<ul data-type="taskList"><li data-type="taskItem" data-checked="${checked}"><p><a data-type="recordLink" data-ref="task:t1" title="Order the motor">Order the motor</a></p></li></ul>`;

describe('a checklist line that is a task', () => {
  it('ticks itself when the task was finished somewhere else', async () => {
    apiMock.taskStates.mockResolvedValue({ tasks: { t1: { done: true } } });
    const onChange = vi.fn();
    render(<NoteEditor value={BOX(false)} onChange={onChange} onMakeTask={vi.fn()} />);
    await waitFor(() => expect(apiMock.taskStates).toHaveBeenCalledWith(['t1']), { timeout: 2000 });
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-checked="true"'));
  });

  it('completes the task when the box is ticked, and leaves a reader alone', async () => {
    render(<NoteEditor value={BOX(false)} onChange={vi.fn()} onMakeTask={vi.fn()} />);
    await editorOf();
    const input = await waitFor(() => { const el = document.querySelector('ul[data-type="taskList"] > li input[type="checkbox"]'); if (!el) throw new Error('no box'); return el; });
    await act(async () => { fireEvent.click(input); });
    await waitFor(() => expect(apiMock.updateTask).toHaveBeenCalledWith('t1', { completed: true }));
  });

  it('turns the line it made a task from into a linked checklist line', async () => {
    const onChange = vi.fn();
    const onMakeTask = vi.fn(async () => ({ id: 't7', title: 'Call the vendor' }));
    render(<NoteEditor value="<p>Call the vendor</p>" onChange={onChange} onMakeTask={onMakeTask} />);
    const editor = await editorOf();
    await act(async () => { editor.commands.setTextSelection(3); });
    await act(async () => { fireEvent.mouseDown(screen.getAllByRole('button', { name: /Make a Task/ })[0]); });
    await waitFor(() => expect(onMakeTask).toHaveBeenCalled());
    expect(onMakeTask.mock.calls[0][0]).toBe('Call the vendor');
    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] || '';
      expect(html).toContain('data-ref="task:t7"');
      expect(html).toContain('data-type="taskItem"');
    });
  });
});
