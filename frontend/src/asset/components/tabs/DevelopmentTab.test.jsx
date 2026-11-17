import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ASSETS } from './fixture.test-data.js';
import { DevelopmentTab, permitOpen, permitOurs, approvalsOf } from './DevelopmentTab.jsx';

afterEach(cleanup);

describe('DevelopmentTab', () => {
  it('groups the pipeline by stage with approvals, permits and the ball in our court', () => {
    const openAsset = vi.fn();
    render(<DevelopmentTab assets={ASSETS} openAsset={openAsset} />);
    expect(screen.getByText('2 properties in the pipeline')).toBeTruthy();
    expect(screen.getByText('1 permit waiting on us')).toBeTruthy();
    expect(screen.getByText('1 without a timeline')).toBeTruthy();
    expect(screen.getByText('Entitlement')).toBeTruthy();
    expect(screen.getByText('Renovation')).toBeTruthy();
    expect(screen.getByText('1 of 2 approvals')).toBeTruthy();
    expect(screen.getByText('Ours')).toBeTruthy();
    expect(screen.getByText('No timeline')).toBeTruthy();
    fireEvent.click(screen.getByText('Greens Storage, Temecula'));
    expect(openAsset).toHaveBeenCalledWith('tem', 'timeline');
  });

  it('Permits and Timelines modes list one row each', () => {
    render(<DevelopmentTab assets={ASSETS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Permits' }));
    expect(screen.getByText('Grading')).toBeTruthy();
    expect(screen.getByText('01/15/2027')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Timelines' }));
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.queryByText('CUP')).toBeNull();
  });

  it('reads permit and approval rules', () => {
    expect(permitOpen({ 'Permit Status': 'Approved' })).toBe(false);
    expect(permitOpen({ 'Permit Status': 'N/A' })).toBe(false);
    expect(permitOpen({ 'Permit Status': 'Under Review' })).toBe(true);
    expect(permitOurs({ 'Ball in whose Court': 'Ours' })).toBe(true);
    expect(permitOurs({ 'Ball in whose Court': 'City' })).toBe(false);
    expect(approvalsOf(ASSETS[1])).toEqual({ done: 1, na: 1, total: 3, required: 2 });
  });

  it('says so when nothing is in development', () => {
    render(<DevelopmentTab assets={[ASSETS[0]]} />);
    expect(screen.getByText(/No property is in development right now/)).toBeTruthy();
  });
});
