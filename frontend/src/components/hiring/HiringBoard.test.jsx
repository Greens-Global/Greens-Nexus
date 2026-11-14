import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The board fits a 1280px window (11/14/2026): one next-step chip per card,
// one summary line, and Hired + Rejected folded into two count tiles that
// still list everyone and still take a dropped card.

vi.mock('../../api', () => ({ api: {} }));
const { nextStep, boardSummary, closedGroups, ClosedColumn, CandidateCard } = await import('./HiringBoard');

const NOW = Date.parse('2026-11-14T15:00:00Z');
const ago = d => new Date(NOW - d * 86400000).toISOString();

describe('nextStep', () => {
  it('reads each stage from what the card already has', () => {
    expect(nextStep({ stage: 'applied', source: 'LinkedIn', createdAt: ago(0) }, NOW).text).toBe('LinkedIn - New Today');
    expect(nextStep({ stage: 'applied', source: 'Indeed', createdAt: ago(3) }, NOW).text).toBe('Indeed - 3 Days Ago');
    expect(nextStep({ stage: 'screening' }, NOW)).toMatchObject({ text: 'Schedule Interview', needsYou: true });
    expect(nextStep({ stage: 'interview', interview: { status: 'scheduled', at: '2026-11-18T17:00:00Z' } }, NOW).text)
      .toMatch(/^11\/18\/2026 \d{1,2}:\d{2} (AM|PM)$/);
    expect(nextStep({ stage: 'decision', decisionWaiting: 2 }, NOW).text).toBe('Waiting On 2 Votes');
    expect(nextStep({ stage: 'decision', decisionWaiting: 0 }, NOW)).toMatchObject({ text: 'Ready To Decide', needsYou: true });
    expect(nextStep({ stage: 'offer', offerState: 'none' }, NOW)).toMatchObject({ text: 'No Offer Letter Set Up', tone: 'red' });
    expect(nextStep({ stage: 'offer', offerState: 'out' }, NOW).text).toBe('Offer Letter Out');
    expect(nextStep({ stage: 'offer', offerState: 'signed' }, NOW).text).toBe('Offer Signed');
    expect(nextStep({ stage: 'hired' }, NOW)).toBeNull();
  });
});

const board = [
  { id: 'a', firstName: 'Lena', lastName: 'Fischer', stage: 'applied', createdAt: ago(0), stageSince: ago(0) },
  { id: 's', firstName: 'Elena', lastName: 'Vasquez', stage: 'screening', stageSince: ago(9) },
  { id: 'i', firstName: 'Hannah', lastName: 'Kim', stage: 'interview', stageSince: ago(1), interview: { status: 'scheduled', at: ago(-2) } },
  { id: 'o', firstName: 'Grace', lastName: 'Liu', stage: 'offer', offerState: 'none', stageSince: ago(2) },
  { id: 'h', firstName: 'Ravi', lastName: 'Shah', stage: 'hired', stageSince: ago(4) },
  { id: 'h2', firstName: 'Old', lastName: 'Hire', stage: 'hired', stageSince: ago(90) },
  { id: 'r', firstName: 'Owen', lastName: 'Price', stage: 'rejected', stageSince: ago(5) },
  { id: 'gone', firstName: 'Gone', lastName: 'Away', stage: 'rejected', inactive: true },
];

describe('the board', () => {
  it('one summary line', () => {
    expect(boardSummary(board, NOW).text).toBe('4 in progress · 1 interview this week · 2 need you');
  });

  it('a card shows the full name, one chip, its days in its title and a dot at 7+ days', () => {
    const onOpen = vi.fn();
    const { container } = render(<div>
      <CandidateCard c={board[1]} onOpen={onOpen} now={NOW} draggable />
      <CandidateCard c={board[0]} onOpen={onOpen} now={NOW} />
    </div>);
    const [stale, fresh] = container.querySelectorAll('button[data-candidate]');
    expect(stale.textContent).toContain('Elena Vasquez');
    expect(stale.getAttribute('title')).toBe('In Screening 9 days - drag to another stage');
    expect(stale.querySelector('[data-stale]')).toBeTruthy();
    expect(fresh.querySelector('[data-stale]')).toBeNull();
    expect(stale.querySelectorAll('[data-step-chip]').length).toBe(1);
    fireEvent.click(stale);
    expect(onOpen).toHaveBeenCalledWith(board[1]);
  });

  it('Hired and Rejected fold into two tiles that list them and open their cards', () => {
    expect(closedGroups(board, NOW).hiredRecent.map(c => c.id)).toEqual(['h']);
    const onOpen = vi.fn();
    render(<ClosedColumn candidates={board} now={NOW} dragOver="" onDragState={() => {}} onDrop={() => {}} onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: '1 Hired - Last 30 Days' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 Rejected' }));
    expect(screen.queryByText('Gone Away')).toBeNull();          // off the board stays off
    fireEvent.click(screen.getByText('Owen Price'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'r' }));
    fireEvent.click(screen.getByRole('button', { name: '1 Hired - Last 30 Days' }));
    expect(screen.getByText('Old Hire')).toBeTruthy();            // an earlier hire is still reachable
  });

  it('a card dropped on the Rejected tile goes to Rejected, as before', () => {
    const onDrop = vi.fn();
    render(<ClosedColumn candidates={board} now={NOW} dragOver="" onDragState={() => {}} onDrop={onDrop} onOpen={() => {}} />);
    const data = { types: ['text/x-candidate'], getData: () => 's' };
    const tile = screen.getByRole('button', { name: '1 Rejected' });
    fireEvent.dragOver(tile, { dataTransfer: data });
    fireEvent.drop(tile, { dataTransfer: data });
    expect(onDrop).toHaveBeenCalledWith('s', 'rejected');
  });
});
