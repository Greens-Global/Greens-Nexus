// People > New > From Hiring (Neil, 11/13/2026): the candidates closest to
// joining - At Offer, then At Decision - and a pick opens that candidate's
// card in Hiring. It never hires anyone itself.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getCandidates: vi.fn(), updateCandidate: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import FromHiringSheet, { hiringReady } from './FromHiringSheet';

const cand = (id, firstName, stage, over = {}) => ({ id, firstName, lastName: 'Test', stage, roleTitle: 'Site Manager', ...over });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('From Hiring', () => {
  it('keeps only Offer and Decision, never someone already hired, inactive or with a record', () => {
    const groups = hiringReady([
      cand('a', 'Ana', 'offer'), cand('b', 'Bo', 'decision'), cand('c', 'Cy', 'interview'),
      cand('d', 'Di', 'hired'), cand('e', 'Ed', 'offer', { inactive: true }), cand('f', 'Fe', 'offer', { employeeId: 'x' }),
    ]);
    expect(groups.map((g) => [g.stage, g.rows.map((r) => r.id)])).toEqual([['offer', ['a']], ['decision', ['b']]]);
  });

  it('opens the picked candidate in Hiring and changes nothing', async () => {
    apiMock.getCandidates.mockResolvedValue([cand('a', 'Ana', 'offer')]);
    const onOpenCandidate = vi.fn();
    render(<FromHiringSheet onOpenCandidate={onOpenCandidate} onOpenHiring={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Ana Test/ }));
    expect(onOpenCandidate).toHaveBeenCalledWith('a');
    expect(apiMock.updateCandidate).not.toHaveBeenCalled();
  });

  it('says where to start when nobody is close', async () => {
    apiMock.getCandidates.mockResolvedValue([cand('c', 'Cy', 'interview')]);
    render(<FromHiringSheet onOpenCandidate={vi.fn()} onOpenHiring={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('No one is at Offer or Decision')).toBeTruthy();
  });
});
