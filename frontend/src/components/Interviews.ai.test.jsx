import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// AI is off unless switched on for the server (ai_switch, Neil Oct 29 2026):
// Hiring then shows no AI comparison, no Final Round and no AI buttons in the
// Interview Room (11/14/2026).

const ctl = { ai: false };
const rows = [
  { id: 'iv1', candidateName: 'Ana Bell', candidateStage: 'decision', totalScore: 81, templateName: 'Analyst', at: '2026-11-02T17:00:00Z' },
  { id: 'iv2', candidateName: 'Bo Chan', candidateStage: 'interview', totalScore: 52, templateName: 'Analyst', at: '2026-11-03T17:00:00Z' },
];
const scored = { id: 'iv1', status: 'completed', at: '2026-11-02T17:00:00Z', answers: [], hasTranscript: true };
vi.mock('../api', () => ({
  api: {
    hiringOptions: () => Promise.resolve({ aiEnabled: ctl.ai }),
    ivTemplates: () => Promise.resolve([]),
    ivLeaderboard: () => Promise.resolve(rows),
    ivList: () => Promise.resolve([scored]),
    getCandidateHistory: () => Promise.resolve([]),
  },
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'hr@x.com' }) }));

const { LeaderboardModal, InterviewPanel } = await import('./Interviews');
const { resetHiringAiForTests } = await import('./hiring/useHiringAi');

describe('AI in Hiring follows the AI switch', () => {
  beforeEach(() => resetHiringAiForTests());

  it('AI off: no comparison and no Final Round on the Leaderboard', async () => {
    ctl.ai = false;
    render(<LeaderboardModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Ana Bell')).toBeTruthy());
    expect(screen.queryByText('AI: Whom Should We Hire?')).toBeNull();
    expect(screen.queryByText('Final Round')).toBeNull();
  });

  it('AI on: the comparison and Final Round are there, in Title Case', async () => {
    ctl.ai = true;
    render(<LeaderboardModal onClose={() => {}} />);
    expect(await screen.findByText('AI: Whom Should We Hire?')).toBeTruthy();
    expect(screen.getAllByText('Final Round').length).toBe(2);
  });

  it('AI off: the Interview Room has no Auto-Fill or Calibrate Score, and finishing is not scoring', async () => {
    ctl.ai = false;
    render(<InterviewPanel candidate={{ id: 'c1', firstName: 'Ana', lastName: 'Bell' }} onClose={() => {}} />);
    expect(await screen.findByText('Finish Interview')).toBeTruthy();
    expect(screen.getByText('Transcript')).toBeTruthy();
    expect(screen.queryByText('AI Auto-Fill Answers')).toBeNull();
    expect(screen.queryByText('Calibrate Score')).toBeNull();
    expect(screen.queryByText('Score Interview')).toBeNull();
  });
});
