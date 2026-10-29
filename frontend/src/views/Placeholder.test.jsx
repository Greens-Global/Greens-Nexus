import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Placeholder from './Placeholder';
import { PATH_TO_VIEW } from '../lib/routes';

afterEach(cleanup);

describe('an unknown address', () => {
  it('says the page was not found - never a mock module screen', () => {
    const onBack = vi.fn();
    render(<Placeholder viewName="nope" onBack={onBack} />);
    expect(screen.getByText('Page Not Found')).toBeTruthy();
    expect(screen.queryByText(/Sub-Application|Handshake|pipelines/i)).toBeNull();
    fireEvent.click(screen.getByText('Go to Dashboard'));
    expect(onBack).toHaveBeenCalled();
  });

  it('/people opens the People module', () => {
    expect(PATH_TO_VIEW.people).toBe('hr');
  });
});
