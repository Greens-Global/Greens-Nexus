import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Ticket AI (Oct 2026): render smoke for the AI Summary card, the Suggested
// Help Topic chips and the AI Features settings panel. Off / failing = renders
// nothing, never a crash; model text is shown as text, never as HTML.

const SUMMARY = {
  available: true, audience: 'internal', includesInternal: true, stale: false,
  generatedAt: '2026-10-19T14:05:00Z', generatedBy: 'Sam Patel',
  summary: { issue: 'Laptop will not boot <b>now</b>', tried: 'Asked for a photo.', state: 'Waiting on requester.', next_step: 'Review the photo.' },
};

vi.mock('../api', () => ({
  api: {
    getTicketAiStatus: vi.fn(() => Promise.resolve({ summaries: true, suggestions: true, aiRanking: true })),
    getTicketAiSummary: vi.fn(() => Promise.resolve({ available: true, summary: null })),
    makeTicketAiSummary: vi.fn(() => Promise.resolve(SUMMARY)),
    suggestTicketTopics: vi.fn(() => Promise.resolve({ suggestions: [{ topic: 'Printer or Scanner', reason: 'Mentions "printer"' }] })),
    getTicketSuggestedTopic: vi.fn(() => Promise.resolve({ suggestions: [{ topic: 'Phone', reason: 'A call' }] })),
    getTicketAiSettings: vi.fn(() => Promise.resolve({ enabled: true, keyConfigured: false })),
    setTicketAiSettings: vi.fn((enabled) => Promise.resolve({ enabled, keyConfigured: false })),
  },
}));

const { api } = await import('../api');
const { TicketAiSummary, SuggestedTopicChips, DrawerSuggestedTopic } = await import('./TicketAi');
const TicketAiSettings = (await import('./TicketAiSettings')).default;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('TicketAiSummary', () => {
  it('renders Summarize, then the summary as text with its US date stamp', async () => {
    render(<TicketAiSummary ticketId="t1" canWorkQueue />);
    const go = await screen.findByRole('button', { name: /Summarize/ });
    fireEvent.click(go);
    await screen.findByText('Waiting on requester.');
    expect(api.makeTicketAiSummary).toHaveBeenCalledWith('t1', false);
    // Markup from the model is shown literally, not rendered.
    expect(screen.getByText('Laptop will not boot <b>now</b>')).toBeTruthy();
    expect(screen.getByText(/Updated 10\/19\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(api.makeTicketAiSummary).toHaveBeenLastCalledWith('t1', true));
  });

  it('shows a friendly line when the model fails, and keeps rendering', async () => {
    api.makeTicketAiSummary.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('The AI summary could not be made right now - try again in a minute.'), { status: 424 })));
    render(<TicketAiSummary ticketId="t1" canWorkQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /Summarize/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be made right now/);
    expect(screen.getByTestId('ticket-ai-summary')).toBeTruthy();
  });

  it('renders nothing for someone off the desk, or when AI is off', async () => {
    const { container } = render(<TicketAiSummary ticketId="t1" canWorkQueue={false} />);
    await waitFor(() => expect(api.getTicketAiStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    expect(api.getTicketAiSummary).not.toHaveBeenCalled();
    cleanup();
    api.getTicketAiStatus.mockImplementationOnce(() => Promise.resolve({ summaries: false, suggestions: false }));
    const second = render(<TicketAiSummary ticketId="t1" canWorkQueue />);
    await waitFor(() => expect(api.getTicketAiStatus).toHaveBeenCalledTimes(2));
    expect(second.container.innerHTML).toBe('');
  });

  it('renders nothing when the status call fails', async () => {
    api.getTicketAiStatus.mockImplementationOnce(() => Promise.reject(new Error('down')));
    const { container } = render(<TicketAiSummary ticketId="t1" canWorkQueue />);
    await waitFor(() => expect(api.getTicketAiStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

describe('SuggestedTopicChips', () => {
  it('asks after the debounce and fills the topic only on a click', async () => {
    const onPick = vi.fn();
    render(<SuggestedTopicChips subject="Printer jam" description="<p>The printer will not print</p>" departmentId="d-it" value="" onPick={onPick} />);
    const chip = await screen.findByRole('button', { name: 'Printer or Scanner' }, { timeout: 2000 });
    expect(api.suggestTicketTopics).toHaveBeenCalledWith(expect.objectContaining({ department_id: 'd-it', description: 'The printer will not print' }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(onPick).toHaveBeenCalledWith('Printer or Scanner');
  });

  it('does not ask for short text or without a department', async () => {
    render(<SuggestedTopicChips subject="hi" description="" departmentId="d-it" value="" onPick={() => {}} />);
    render(<SuggestedTopicChips subject="Printer jam today" description="" departmentId="" value="" onPick={() => {}} />);
    await new Promise((r) => setTimeout(r, 900));
    expect(api.suggestTicketTopics).not.toHaveBeenCalled();
    expect(screen.queryByTestId('suggested-topics')).toBeNull();
  });
});

describe('DrawerSuggestedTopic', () => {
  it('offers a topic for a ticket without one', async () => {
    const onApply = vi.fn();
    render(<DrawerSuggestedTopic ticketId="t1" hasTopic={false} canWorkQueue onApply={onApply} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Phone' }));
    expect(onApply).toHaveBeenCalledWith('Phone');
  });

  it('asks nothing once the ticket has a topic', async () => {
    render(<DrawerSuggestedTopic ticketId="t1" hasTopic canWorkQueue onApply={() => {}} />);
    await waitFor(() => expect(api.getTicketAiStatus).toHaveBeenCalled());
    expect(api.getTicketSuggestedTopic).not.toHaveBeenCalled();
  });
});

describe('TicketAiSettings', () => {
  it('renders the switch and saves a flip', async () => {
    render(<TicketAiSettings />);
    const sw = await screen.findByRole('switch', { name: 'AI Features' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/No AI key is set/)).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(api.setTicketAiSettings).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'AI Features' }).getAttribute('aria-checked')).toBe('false'));
  });
});
