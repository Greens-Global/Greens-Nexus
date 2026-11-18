import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Performance > Kudos on Teams (Neil, 11/12/2026: a channel per
// company): the Teams picker in place of the old chat id box, a channel by
// default, one Save row, and the old chat id read back as a chat.

const m = { perfSettings: vi.fn(), perfSettingsSave: vi.fn(), timeMyChannels: vi.fn(), timeMyChats: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => m[k] || (() => Promise.resolve({})) }) }));
vi.mock('../teamsGraph', () => ({
  graphTokenSilent: vi.fn(), graphTokenInteractive: vi.fn(), listMyChats: vi.fn(), channelTokenInteractive: vi.fn(), listMyChannels: vi.fn(),
}));

const { PerformanceKudosChatSettings } = await import('./PerformanceSettings');

const CHANNEL = { type: 'channel', id: '19:kudos@thread.tacv2', name: 'Shout-Outs', teamId: 'team-1', teamName: 'Greens' };
const meta = (kudosTeams) => ({ settings: { kudosTeams }, override: false, canEdit: true, companies: [] });

beforeEach(() => Object.values(m).forEach(f => f.mockReset()));

describe('Kudos on Teams settings', () => {
  it('picks a channel and saves it with one Save', async () => {
    m.perfSettings.mockResolvedValue(meta({}));
    m.timeMyChannels.mockResolvedValue({ channels: [{ channelId: CHANNEL.id, channelName: 'Shout-Outs', teamId: 'team-1', teamName: 'Greens' }] });
    m.perfSettingsSave.mockResolvedValue(meta(CHANNEL));
    const toastOk = vi.fn();
    render(<PerformanceKudosChatSettings toastOk={toastOk} />);
    // Nothing picked opens on Channel, and Save waits for a change.
    expect((await screen.findByRole('radio', { name: 'Channel' })).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Bind A Channel/ }));
    fireEvent.change(await screen.findByLabelText('Teams channel'), { target: { value: CHANNEL.id } });
    expect(screen.getByText('Greens › Shout-Outs')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.perfSettingsSave).toHaveBeenCalledWith({ company: '', settings: { kudosTeams: CHANNEL }, reset: false }));
    expect(toastOk).toHaveBeenCalledWith('Saved.');
  });

  it('shows the chat id saved before the picker as a chat, and clearing saves nothing picked', async () => {
    m.perfSettings.mockResolvedValue(meta({ type: 'chat', id: '19:org@thread.v2', name: '', teamId: '', teamName: '' }));
    m.perfSettingsSave.mockResolvedValue(meta({}));
    render(<PerformanceKudosChatSettings company="co-1" />);
    expect(await screen.findByText('Group chat')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Group Chat' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Change Or Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.perfSettingsSave).toHaveBeenCalledWith({ company: 'co-1', settings: { kudosTeams: {} }, reset: false }));
  });
});
