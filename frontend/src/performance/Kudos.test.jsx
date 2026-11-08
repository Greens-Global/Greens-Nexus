import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Kudos thanks, the value tag and the Teams switch (Neil, 11/08/2026):
// the thanks row under a kudos, the send form's picker and switch, the
// recipient's moment card and the Dashboard widget.

const m = {
  perfKudos: vi.fn(), perfKudosGive: vi.fn(), perfKudosThank: vi.fn(), perfKudosUnthank: vi.fn(),
  perfKudosUnseen: vi.fn(), perfKudosSeen: vi.fn(), getPeopleDirectory: vi.fn(),
};
let actAs = null;
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }),
  getActAsSessionId: () => actAs,
}));

const confetti = vi.fn(() => () => {});
vi.mock('../ui/Confetti', () => ({ burstConfetti: (...a) => confetti(...a) }));

const { KudosCard, GiveKudosModal, KudosWidget, thanksSentence } = await import('./Kudos');
const KudosMoment = (await import('./KudosMoment')).default;

const ME = 'erin@x.com';
const CTX = { email: ME, name: 'Erin Test' };
const K = {
  id: 'k1', fromEmail: 'pat@x.com', fromName: 'Pat Test', toEmail: 'sam@x.com', toName: 'Sam Lee', message: 'Saved the Friday close',
  value: 'Ownership', createdAt: '2026-10-29T10:00:00+00:00', seenAt: '', thanksCount: 2, myThanks: null, can: { hide: false, thank: true },
  thanks: [{ email: 'marco@x.com', name: 'Marco Diaz', note: 'Well earned' }, { email: 'ana@x.com', name: 'Ana Ruiz', note: '' }],
};

beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  confetti.mockClear();
  m.getPeopleDirectory.mockResolvedValue([]);
  actAs = null;
});

describe('Kudos thanks row', () => {
  it('names who added their thanks, opens the notes, adds mine with a note and takes it back', async () => {
    m.perfKudos.mockResolvedValue({ items: [K], receivedLast90: 0, values: [], teamsChat: false });
    const mine = { ...K, myThanks: { note: 'Me too' }, can: { hide: false, thank: false },
      thanks: [...K.thanks, { email: ME, name: 'Erin Test', note: 'Me too' }], thanksCount: 3 };
    m.perfKudosThank.mockResolvedValue(mine);
    m.perfKudosUnthank.mockResolvedValue(K);
    render(<KudosCard ctx={CTX} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.getByText('Ownership')).toBeTruthy();
    fireEvent.click(screen.getByText('Marco and Ana added their thanks'));
    expect(screen.getByText('Well earned')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Your Thanks' }));
    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: 'Me too' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(m.perfKudosThank).toHaveBeenCalledWith('k1', 'Me too'));
    expect(await screen.findByText(/You added your thanks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take Back' }));
    await waitFor(() => expect(m.perfKudosUnthank).toHaveBeenCalledWith('k1'));
    expect(await screen.findByRole('button', { name: 'Add Your Thanks' })).toBeTruthy();
  });

  it('the sender gets no Add Your Thanks', async () => {
    m.perfKudos.mockResolvedValue({ items: [{ ...K, thanks: [], thanksCount: 0, can: { hide: true, thank: false } }], receivedLast90: 0 });
    render(<KudosCard ctx={{ email: 'pat@x.com' }} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Your Thanks' })).toBeNull();
  });

  it('reads the names like a sentence', () => {
    expect(thanksSentence(['Marco'])).toBe('Marco');
    expect(thanksSentence(['Marco', 'Ana'])).toBe('Marco and Ana');
    expect(thanksSentence(['Marco', 'Ana', 'Lee'])).toBe('Marco, Ana and Lee');
    expect(thanksSentence(['Marco', 'Ana', 'Lee', 'Jo', 'Sam'])).toBe('Marco, Ana and 3 others');
  });
});

describe('Give Kudos form', () => {
  it('offers the company values and the Teams switch, and sends both', async () => {
    m.perfKudosGive.mockResolvedValue({ ...K, toName: 'Sam Lee' });
    const given = vi.fn();
    render(<GiveKudosModal me={ME} to="sam@x.com" values={['Ownership', 'Safety First']} teamsChat onGiven={given} />);
    fireEvent.click(screen.getByRole('button', { name: 'Safety First' }));
    expect(screen.getByRole('button', { name: 'Safety First' }).getAttribute('aria-pressed')).toBe('true');
    const sw = screen.getByRole('switch', { name: 'Also post to Teams' });
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    fireEvent.change(screen.getByPlaceholderText(/Stayed late/), { target: { value: 'Caught the leak before the weekend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Kudos' }));
    await waitFor(() => expect(m.perfKudosGive).toHaveBeenCalledWith({ to: 'sam@x.com', message: 'Caught the leak before the weekend', value: 'Safety First', post_teams: false }));
    await waitFor(() => expect(given).toHaveBeenCalled());
  });

  it('shows no picker and no switch when the company has neither', () => {
    render(<GiveKudosModal me={ME} to="sam@x.com" values={[]} teamsChat={false} />);
    expect(screen.queryByRole('group', { name: /Which value/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('The recipient moment', () => {
  it('shows an unseen kudos once; Say Thanks posts the reply, Close marks seen', async () => {
    const k2 = { ...K, id: 'k2', fromName: 'Dana Whitfield', message: 'Great walkthrough', value: '' };
    m.perfKudosUnseen.mockResolvedValue([{ ...K, toEmail: ME }, k2]);
    m.perfKudosThank.mockResolvedValue({});
    m.perfKudosSeen.mockResolvedValue({ ok: true });
    render(<KudosMoment />);
    expect(await screen.findByRole('dialog', { name: 'Pat Test sent you kudos' })).toBeTruthy();
    // The confetti fires once per card, a beat after it arrives (Neil, 11/08/2026).
    expect(confetti).not.toHaveBeenCalled();
    await waitFor(() => expect(confetti).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Ownership')).toBeTruthy();
    expect(screen.getByText('Saved the Friday close')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Thank you!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Say Thanks' }));
    await waitFor(() => expect(m.perfKudosThank).toHaveBeenCalledWith('k1', 'Thank you!'));
    expect(await screen.findByRole('dialog', { name: 'Dana Whitfield sent you kudos' })).toBeTruthy();
    await waitFor(() => expect(confetti).toHaveBeenCalledTimes(2));   // the next card, once more; never on Say Thanks itself
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(m.perfKudosSeen).toHaveBeenCalledWith('k2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The same load never shows those two again, even after a remount.
    render(<KudosMoment />);
    await waitFor(() => expect(m.perfKudosUnseen).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never shows under Act As', async () => {
    actAs = 'sess-1';
    m.perfKudosUnseen.mockResolvedValue([{ ...K, id: 'k9' }]);
    render(<KudosMoment />);
    await new Promise(r => setTimeout(r, 0));
    expect(m.perfKudosUnseen).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Kudos widget', () => {
  it('renders the feed with the value and thanks, and See All', async () => {
    m.perfKudos.mockResolvedValue({ items: [K], receivedLast90: 0 });
    render(<KudosWidget me={ME} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.getByText('Ownership')).toBeTruthy();
    expect(screen.getByText('Marco and Ana added their thanks')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Your Thanks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See All' })).toBeTruthy();
  });
});
