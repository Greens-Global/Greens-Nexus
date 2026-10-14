import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// One notes timeline (Neil, Oct 14): newest first, each with who and when;
// anyone who can see the candidate adds a note.

let history = [
  { kind: 'move', fromStage: '', toStage: 'applied', note: 'Candidate added', byName: 'Hana Hr', createdAt: '2026-10-01T16:00:00Z' },
  { kind: 'note', fromStage: 'applied', toStage: 'applied', note: 'Strong resume', byName: 'Hana Hr', createdAt: '2026-10-02T16:00:00Z' },
  { kind: 'interview', fromStage: '', toStage: 'interview', note: 'Scored 82/100. Clear and organized.', byName: 'Neil K', createdAt: '2026-10-05T16:00:00Z' },
];
const add = vi.fn(() => { history = [...history, { kind: 'note', note: 'Checked references', byName: 'Hana Hr', createdAt: '2026-10-06T16:00:00Z' }]; return Promise.resolve({ ok: true }); });
vi.mock('../api', () => ({ api: {
  getCandidateHistory: () => Promise.resolve(history),
  addCandidateNote: (...a) => add(...a),
} }));
const { default: CandidateNotes } = await import('./CandidateNotes');

describe('CandidateNotes', () => {
  it('shows every note, move and interview with who wrote it, and adds a note', async () => {
    render(<CandidateNotes candidateId="c1" />);
    await waitFor(() => expect(screen.getByText('Strong resume')).toBeTruthy());
    expect(screen.getByText('Interview finished')).toBeTruthy();
    expect(screen.getByText(/Scored 82\/100/)).toBeTruthy();
    expect(screen.getAllByText(/Hana Hr ·/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Checked references' } });
    fireEvent.click(screen.getByText('Add Note'));
    await waitFor(() => expect(screen.getByText('Checked references')).toBeTruthy());
    expect(add).toHaveBeenCalledWith('c1', 'Checked references');
  });
});
