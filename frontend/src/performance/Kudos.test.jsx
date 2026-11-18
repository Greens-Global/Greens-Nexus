import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Kudos thanks, the value tag and the Teams switch (Neil, 11/08/2026):
// the thanks row under a kudos, the send form's picker and switch, the
// recipient's moment card and the Dashboard widget.

const m = {
  perfKudos: vi.fn(), perfKudosGive: vi.fn(), perfKudosThank: vi.fn(), perfKudosUnthank: vi.fn(), perfKudosOptions: vi.fn(),
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
  value: 'Ownership', createdAt: '2026-10-29T10:00:00+00:00', seenAt: '', thanksCount: 2, myThanks: null, can: { hide: false, thank: true, takeBack: false },
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
    m.perfKudos.mockResolvedValue({ items: [K], receivedLast90: 0 });
    const mine = { ...K, myThanks: { note: 'Me too' }, can: { hide: false, thank: false, takeBack: true },
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

  it('shows thanks that came from Teams with their emoji, the outside count and Open in Teams (11/12/2026)', async () => {
    const fromTeams = { ...K, teams: { url: 'https://teams.example/m1', others: 2, type: 'channel' },
      thanks: [{ email: 'marco@x.com', name: 'Marco Diaz', note: 'Well deserved', via: 'teams', reaction: '\u2764\ufe0f' },
        { email: 'ana@x.com', name: 'Ana Ruiz', note: '', via: '', reaction: '\u{1F44F}' }] };
    m.perfKudos.mockResolvedValue({ items: [fromTeams], receivedLast90: 0 });
    render(<KudosCard ctx={CTX} />);
    const row = await screen.findByRole('button', { name: /Marco and Ana added their thanks/ });
    expect(row.textContent).toContain('\u2764\ufe0f \u{1F44F}');
    expect(screen.getByText('2 people on Teams reacted')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open in Teams' });
    expect(link.getAttribute('href')).toBe('https://teams.example/m1');
    expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.click(row);
    expect(screen.getByText(/on Teams$/)).toBeTruthy();
  });

  it('a kudos never posted to Teams shows no Teams line', async () => {
    m.perfKudos.mockResolvedValue({ items: [{ ...K, teams: null }], receivedLast90: 0 });
    render(<KudosCard ctx={CTX} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open in Teams' })).toBeNull();
    expect(screen.queryByText(/on Teams reacted/)).toBeNull();
  });

  it('the sender gets no Add Your Thanks', async () => {
    m.perfKudos.mockResolvedValue({ items: [{ ...K, thanks: [], thanksCount: 0, can: { hide: true, thank: false } }], receivedLast90: 0 });
    render(<KudosCard ctx={{ email: 'pat@x.com' }} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Your Thanks' })).toBeNull();
  });

  it("the recipient's own thanks is the reply - Say Thanks, and no Take Back on it", async () => {
    const replied = { ...K, toEmail: ME, myThanks: { note: 'Thank you' }, can: { hide: false, thank: false, takeBack: false },
      thanks: [...K.thanks, { email: ME, name: 'Erin Test', note: 'Thank you' }] };
    m.perfKudos.mockResolvedValue({ items: [{ ...K, toEmail: ME }, replied].map((k, i) => ({ ...k, id: `k${i}` })), receivedLast90: 2 });
    render(<KudosCard ctx={CTX} />);
    expect(await screen.findByRole('button', { name: 'Say Thanks' })).toBeTruthy();
    expect(screen.getByText(/You said thanks/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take Back' })).toBeNull();
  });

  it('reads the names like a sentence', () => {
    expect(thanksSentence(['Marco'])).toBe('Marco');
    expect(thanksSentence(['Marco', 'Ana'])).toBe('Marco and Ana');
    expect(thanksSentence(['Marco', 'Ana', 'Lee'])).toBe('Marco, Ana and Lee');
    expect(thanksSentence(['Marco', 'Ana', 'Lee', 'Jo', 'Sam'])).toBe('Marco, Ana and 3 others');
  });
});

describe('Give Kudos form', () => {
  it("offers the recipient's company values and the Teams switch once a recipient is picked, and sends both", async () => {
    m.perfKudosOptions.mockResolvedValue({ values: ['Ownership', 'Safety First'], teamsChat: true, teamsPlace: 'Greens > Shout-Outs' });
    m.perfKudosGive.mockResolvedValue({ ...K, toName: 'Sam Lee' });
    const given = vi.fn();
    render(<GiveKudosModal me={ME} to="sam@x.com" onGiven={given} />);
    await waitFor(() => expect(m.perfKudosOptions).toHaveBeenCalledWith('sam@x.com'));
    fireEvent.click(await screen.findByRole('button', { name: 'Safety First' }));
    expect(screen.getByRole('button', { name: 'Safety First' }).getAttribute('aria-pressed')).toBe('true');
    const sw = screen.getByRole('switch', { name: 'Also post to Teams' });
    expect(screen.getByText(/Greens > Shout-Outs/)).toBeTruthy();   // where it will go
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    fireEvent.change(screen.getByPlaceholderText(/Stayed late/), { target: { value: 'Caught the leak before the weekend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Kudos' }));
    await waitFor(() => expect(m.perfKudosGive).toHaveBeenCalledWith({ to: 'sam@x.com', message: 'Caught the leak before the weekend', value: 'Safety First', post_teams: false }));
    await waitFor(() => expect(given).toHaveBeenCalled());
  });

  it("shows no picker and no switch when the recipient's company has neither, or before a recipient is picked", async () => {
    m.perfKudosOptions.mockResolvedValue({ values: [], teamsChat: false });
    const { unmount } = render(<GiveKudosModal me={ME} to="sam@x.com" />);
    await waitFor(() => expect(m.perfKudosOptions).toHaveBeenCalledWith('sam@x.com'));
    expect(screen.queryByRole('group', { name: /Which value/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    m.perfKudosOptions.mockClear();
    render(<GiveKudosModal me={ME} />);
    await new Promise(r => setTimeout(r, 0));
    expect(m.perfKudosOptions).not.toHaveBeenCalled();
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
  it('asks for six rows, renders the value and thanks and See All, and says when a thank fails', async () => {
    m.perfKudos.mockResolvedValue({ items: [K], receivedLast90: 0 });
    m.perfKudosThank.mockRejectedValue(new Error('You already added your thanks.'));
    render(<KudosWidget me={ME} />);
    expect(await screen.findByText('Saved the Friday close')).toBeTruthy();
    expect(m.perfKudos).toHaveBeenCalledWith({ scope: 'company', limit: 6 });
    expect(screen.getByText('Ownership')).toBeTruthy();
    expect(screen.getByText('Marco and Ana added their thanks')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See All' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Your Thanks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('You already added your thanks.');
  });
});
