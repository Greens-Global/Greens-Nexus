import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CrisisSupportHost, { CrisisSupportCard, setCrisisCountry } from './CrisisSupportCard';
import { crisisCheck } from '../lib/crisisSupport';

describe('CrisisSupportCard', () => {
  it('shows the US lines for a US person and acknowledges', () => {
    const onDone = vi.fn();
    render(<CrisisSupportCard country="US" onDone={onDone} />);
    expect(screen.getByRole('heading', { name: 'You Are Not Alone' })).toBeTruthy();
    expect(screen.getByText('988 Suicide & Crisis Lifeline')).toBeTruthy();
    expect(screen.queryByText('Tele-MANAS')).toBeNull();
    expect(screen.getByText('Call 988').getAttribute('href')).toBe('tel:988');
    fireEvent.click(screen.getByRole('button', { name: 'I Understand' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('shows both countries when the country is unknown', () => {
    render(<CrisisSupportCard country="" onDone={() => {}} />);
    expect(screen.getByText('988 Suicide & Crisis Lifeline')).toBeTruthy();
    expect(screen.getByText('Tele-MANAS')).toBeTruthy();
    expect(screen.getByText('112')).toBeTruthy();
  });

  it('the host holds a send until the person acknowledges', async () => {
    setCrisisCountry('IN');
    render(<CrisisSupportHost />);
    let done = false;
    let p;
    await act(async () => { p = crisisCheck('I want to kill myself').then(() => { done = true; }); });
    expect(screen.getByText('Tele-MANAS')).toBeTruthy();
    expect(done).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'I Understand' })); await p; });
    expect(done).toBe(true);
    expect(screen.queryByText('Tele-MANAS')).toBeNull();
    setCrisisCountry('');
  });
});
