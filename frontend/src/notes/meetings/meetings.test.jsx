// Meeting Notes (Neil, 11/12/2026) - the meeting clock on a note's lines,
// the pure helpers, and the Notes page's Meetings sheet, band and transcript.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteShare: vi.fn(),
  noteVersions: vi.fn(), notePresence: vi.fn(), noteMentions: vi.fn(),
  getPeopleDirectory: vi.fn(),
  meetingsAccess: vi.fn(), meetingAlerts: vi.fn(), createTask: vi.fn(), meetingsDay: vi.fn(), meetingNoteOpen: vi.fn(), meetingOfNote: vi.fn(), meetingTranscript: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import { buildExtensions } from '../noteExtensions';
import { MEET_LATE_MS } from './meetingClock';
import { attendeeList, cueIndexAt, dayBounds, meetingPhase, speakerShares } from './meetingModel';
import NotesPage from '../NotesPage';

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MEETING = {
  subject: 'Weekly Ops', start: iso(NOW - 10 * 60 * 1000), end: iso(NOW + 20 * 60 * 1000),
  organizer: 'neil@greensglobal.com', invited: true, mine: true, joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
  attendees: [{ email: 'neil@greensglobal.com', name: 'Neil' }, { email: 'bob@greensglobal.com', name: 'Bob B.' }, { email: 'vendor@outside.com', name: 'Vendor' }],
};
const NOTE = {
  id: 'note_m', kind: 'note', title: 'Weekly Ops', body: '<p data-at="1794495720">Gate codes by Friday</p>', day: '2026-11-12', tags: [], color: '',
  pinned: false, owner: 'neil@greensglobal.com', mine: true, can: 'owner', shared: false, sharedWith: [], trashedAt: '', rev: 1,
  updatedAt: new Date().toISOString(), updatedBy: 'neil@greensglobal.com', source: { kind: 'meeting', id: 'mtg_1', label: 'Weekly Ops', url: '' },
};

describe('meeting model', () => {
  it('reads a local day as two instants a day apart', () => {
    const { start, end } = dayBounds('2026-11-12');
    expect(Date.parse(end) - Date.parse(start)).toBe(24 * 3600 * 1000);
    expect(new Date(start).getDate()).toBe(12);
  });
  it('points a line at the last cue said before it', () => {
    const cues = [{ at: 100 }, { at: 160 }, { at: 220 }];
    expect(cueIndexAt(cues, 50)).toBe(0);
    expect(cueIndexAt(cues, 170)).toBe(1);
    expect(cueIndexAt(cues, 999)).toBe(2);
    expect(cueIndexAt([], 10)).toBe(-1);
  });
  it('knows upcoming, live and ended', () => {
    expect(meetingPhase(MEETING, NOW)).toBe('live');
    expect(meetingPhase(MEETING, NOW - 3600 * 1000)).toBe('upcoming');
    expect(meetingPhase(MEETING, NOW + 3600 * 1000)).toBe('ended');
  });
  it('names the invite from Nexus People, leaving the caller out', () => {
    const list = attendeeList(MEETING, [{ email: 'bob@greensglobal.com', name: 'Bob Brown' }], 'neil@greensglobal.com');
    expect(list).toEqual([
      { email: 'bob@greensglobal.com', name: 'Bob Brown', inNexus: true },
      { email: 'vendor@outside.com', name: 'Vendor', inNexus: false },
    ]);
  });
  it('splits talk time by words', () => {
    expect(speakerShares([{ speaker: 'A', text: 'one two three' }, { speaker: 'B', text: 'four' }]))
      .toEqual([{ name: 'A', pct: 75 }, { name: 'B', pct: 25 }]);
  });
});

describe('meeting clock', () => {
  let editor;
  const make = (content = '<p></p>') => {
    editor = new Editor({ extensions: buildExtensions(''), content });
    return editor;
  };
  afterEach(() => { editor?.destroy(); editor = null; });

  it('stamps the line being written while the meeting runs', () => {
    make();
    editor.storage.meetingClock.meeting = { startMs: NOW - 60000, endMs: NOW + 60000 };
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('Rent roll closed');
    const at = editor.getJSON().content[0].attrs.at;
    expect(at).toMatch(/^\d{10}$/);
    expect(Math.abs(Number(at) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    expect(editor.getHTML()).toContain(`data-at="${at}"`);
  });

  it('stamps nothing outside the meeting, or without one', () => {
    make();
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('Before');
    expect(editor.getJSON().content[0].attrs.at).toBeNull();
    editor.storage.meetingClock.meeting = { startMs: NOW - 7200000, endMs: NOW - MEET_LATE_MS - 60000 };
    editor.commands.insertContent(' still');
    expect(editor.getJSON().content[0].attrs.at).toBeNull();
  });

  it('never stamps someone else\'s live typing', () => {
    make();
    editor.storage.meetingClock.meeting = { startMs: NOW - 60000, endMs: NOW + 60000 };
    editor.storage.meetingClock.isRemote = () => true;
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('Theirs');
    expect(editor.getJSON().content[0].attrs.at).toBeNull();
  });

  it('keeps a stamp through the HTML round trip and starts a new line unstamped', () => {
    make('<p data-at="1794495720">Gate codes</p><p data-at="12">bad</p>');
    expect(editor.getJSON().content[0].attrs.at).toBe('1794495720');
    expect(editor.getJSON().content[1].attrs.at).toBeNull();
    editor.commands.setTextSelection(11);
    editor.commands.splitBlock();
    const blocks = editor.getJSON().content;
    expect(blocks[0].attrs.at).toBe('1794495720');
    expect(blocks[1].attrs.at).toBeNull();
  });
});

describe('Notes page - meetings', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(apiMock).forEach((f) => f.mockReset?.());
    apiMock.getPeopleDirectory.mockResolvedValue([{ email: 'bob@greensglobal.com', name: 'Bob Brown' }]);
    apiMock.notesList.mockResolvedValue({ notes: [NOTE], counts: { all: 1 }, tags: [] });
    apiMock.noteGet.mockResolvedValue(NOTE);
    apiMock.notePresence.mockResolvedValue({ people: [], rev: 1 });
    apiMock.noteMentions.mockResolvedValue({ items: [], notes: [] });
    apiMock.meetingOfNote.mockResolvedValue(MEETING);
    apiMock.meetingsAccess.mockResolvedValue({ enabled: true, alerts: false });
  });

  it('lets a person opt in to the Transcript Ready bell from the Meetings sheet', async () => {
    apiMock.meetingsDay.mockResolvedValue({ enabled: true, meetings: [] });
    apiMock.meetingAlerts.mockResolvedValue({ on: true });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Meetings/ }));
    const sw = await screen.findByRole('switch', { name: 'Tell Me When a Transcript Is Ready' });
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(apiMock.meetingAlerts).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/you get a bell when a transcript is ready/)).toBeTruthy();
  });

  it('shows Last Time with the open tasks, and highlights with Make a Task', async () => {
    apiMock.meetingOfNote.mockResolvedValue({
      ...MEETING, transcriptReady: true,
      previous: { noteId: 'note_prev', title: 'Weekly Ops', start: '2026-11-05T15:00:00Z', latest: true,
        openTasks: [{ id: 't1', title: 'Send rent roll', code: 'T-12' }] },
    });
    apiMock.meetingTranscript.mockResolvedValue({ cues: [
      { at: 1794495600, speaker: 'Neil', text: 'Rent roll first.' },
      { at: 1794495700, speaker: 'Bob Brown', text: 'I will fix the gate codes by Friday.' },
    ], recordings: 0, chatThreadId: '', transcripts: 1, truncated: false,
    highlights: { actions: [{ i: 1, at: 1794495700, speaker: 'Bob Brown', text: 'I will fix the gate codes by Friday.', due: 'by Friday' }],
      decisions: [], questions: [] } });
    apiMock.createTask.mockResolvedValue({ id: 'task_9' });
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes:note_m" onSubChange={onSubChange} />);
    expect(await screen.findByText('Last Time:')).toBeTruthy();
    expect(screen.getByText('1 open task')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send rent roll/ })).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Weekly Ops · 11\/05\/2026/ }));
    expect(onSubChange).toHaveBeenCalledWith('notes:note_prev');

    fireEvent.click(screen.getByRole('button', { name: /^Transcript/ }));
    expect(await screen.findByRole('tab', { name: /Highlights/, selected: true })).toBeTruthy();
    expect(screen.getByText('Possible Action Items')).toBeTruthy();
    expect(screen.getByText('by Friday')).toBeTruthy();
    const panel = within(screen.getByRole('complementary', { name: 'Transcript' }));
    fireEvent.click(panel.getByRole('button', { name: /Make a Task/ }));
    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: 'I will fix the gate codes by Friday.', assignee_emails: ['neil@greensglobal.com'] })));
    expect(await panel.findByRole('button', { name: /Open Task/ })).toBeTruthy();
    // The time on a highlight shows it in the full transcript.
    fireEvent.click(panel.getByTitle('See it in the transcript'));
    expect(await screen.findByRole('tab', { name: 'Transcript', selected: true })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.nt-tx-list li.is-hit')?.textContent).toContain('gate codes'));
  });

  it('shows no Meetings button to someone it is not turned on for', async () => {
    apiMock.meetingsAccess.mockResolvedValue({ enabled: false });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    await waitFor(() => expect(apiMock.meetingsAccess).toHaveBeenCalled());
    await screen.findByRole('button', { name: /New Note/ });
    expect(screen.queryByRole('button', { name: /^Meetings/ })).toBeNull();
  });

  it('lists the day\'s Teams meetings and opens a meeting\'s notes', async () => {
    apiMock.meetingsDay.mockResolvedValue({ enabled: true, meetings: [{
      eventId: 'evt1', icalUid: 'u1', subject: 'Weekly Ops', start: MEETING.start, end: MEETING.end,
      organizer: { email: 'neil@greensglobal.com', name: 'Neil' }, isOrganizer: true, attendees: [{ email: 'bob@greensglobal.com', name: 'Bob' }],
      joinUrl: MEETING.joinUrl, noteId: '' }] });
    apiMock.meetingNoteOpen.mockResolvedValue({ noteId: 'note_m', created: true });
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Meetings/ }));
    expect(await screen.findByText('You organized · 1 person invited')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Join/ }).getAttribute('href')).toBe(MEETING.joinUrl);
    fireEvent.click(screen.getByRole('button', { name: /Take Notes/ }));
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('notes:note_m'));
    expect(apiMock.meetingNoteOpen).toHaveBeenCalledWith('evt1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('says so quietly when the calendar is not connected', async () => {
    apiMock.meetingsDay.mockResolvedValue({ enabled: false, reason: 'Nexus cannot read Outlook calendars yet', meetings: [] });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Meetings/ }));
    expect(await screen.findByText('Your calendar is not connected yet')).toBeTruthy();
  });

  it('shows the band, shares with attendees in Nexus People, and opens the transcript at a line\'s time', async () => {
    apiMock.noteShare.mockResolvedValue({ ...NOTE, sharedWith: [{ email: 'bob@greensglobal.com', can: 'read' }] });
    apiMock.meetingTranscript.mockResolvedValue({ cues: [
      { at: 1794495600, speaker: 'Neil', text: 'Rent roll first.' },
      { at: 1794495700, speaker: 'Bob Brown', text: 'I will fix the gate codes by Friday.' },
    ], recordings: 1, chatThreadId: '19:meeting_abc@thread.v2', transcripts: 1, truncated: false });
    render(<NotesPage activeSub="notes:note_m" onSubChange={vi.fn()} />);
    expect(await screen.findByText('In Progress')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Share With Attendees/ }));
    await waitFor(() => expect(apiMock.noteShare).toHaveBeenCalledTimes(1));
    expect(apiMock.noteShare).toHaveBeenCalledWith('note_m', 'bob@greensglobal.com', 'read');   // never the outside vendor

    const stamp = await waitFor(() => {
      const b = document.querySelector('button.nt-at');
      expect(b).toBeTruthy();
      return b;
    });
    fireEvent.mouseDown(stamp);
    expect(await screen.findByText('I will fix the gate codes by Friday.')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.nt-tx-list li.is-hit')?.textContent).toContain('gate codes'));
    expect(screen.getByRole('link', { name: /Recording in Teams/ }).getAttribute('href')).toContain('/l/chat/19%3Ameeting_abc%40thread.v2/0');
  });
});
