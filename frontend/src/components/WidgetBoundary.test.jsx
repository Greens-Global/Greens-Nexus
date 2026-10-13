// Render-smoke for the shell's widget boundary: a widget outside the routed
// view that throws must be contained (its neighbors keep rendering), reported
// to the error trail, and given another try when resetKey changes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../lib/errorReporter', () => ({ reportError }));

import WidgetBoundary, { NavFallback } from './WidgetBoundary';

let broken = true;
function Flaky() {
  if (broken) throw new Error('widget blew up');
  return <div>Widget OK</div>;
}

describe('WidgetBoundary', () => {
  beforeEach(() => {
    broken = true;
    reportError.mockClear();
  });

  it('renders its child untouched when nothing throws', () => {
    broken = false;
    render(<WidgetBoundary name="t"><Flaky /></WidgetBoundary>);
    expect(screen.getByText('Widget OK')).toBeTruthy();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('contains a crash: nothing in its place, the sibling still renders, the error is reported', () => {
    const { container } = render(
      <>
        <div data-testid="slot"><WidgetBoundary name="toasts"><Flaky /></WidgetBoundary></div>
        <div>Sibling Content</div>
      </>
    );
    expect(screen.getByText('Sibling Content')).toBeTruthy();
    expect(container.querySelector('[data-testid="slot"]').innerHTML).toBe('');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe('toasts: widget blew up');
  });

  it('shows the fallback it was given', () => {
    render(<WidgetBoundary name="nav" fallback={<NavFallback as="nav" className="mobile-nav" />}><Flaky /></WidgetBoundary>);
    expect(screen.getByRole('alert').className).toBe('mobile-nav');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('tries the child again when resetKey changes, and not before', () => {
    const { rerender } = render(<WidgetBoundary resetKey="a"><Flaky /></WidgetBoundary>);
    expect(screen.queryByText('Widget OK')).toBeNull();
    broken = false;
    rerender(<WidgetBoundary resetKey="a"><Flaky /></WidgetBoundary>);
    expect(screen.queryByText('Widget OK')).toBeNull();
    rerender(<WidgetBoundary resetKey="b"><Flaky /></WidgetBoundary>);
    expect(screen.getByText('Widget OK')).toBeTruthy();
  });

  it('a reporter that throws does not break the fallback', () => {
    reportError.mockImplementationOnce(() => { throw new Error('reporter down'); });
    render(<><WidgetBoundary><Flaky /></WidgetBoundary><div>Still Here</div></>);
    expect(screen.getByText('Still Here')).toBeTruthy();
  });
});
