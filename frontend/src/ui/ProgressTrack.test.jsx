import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressTrack, { clampProgress, trackState, nodeText } from './ProgressTrack';

// Progress track (Neil, 11/02/2026): the one progress bar for new work.
const bar = () => screen.getByRole('progressbar');
const wrap = (c) => c.container.firstChild;
const fill = (c) => c.container.querySelector('.nx-track-fill');
const marker = (c) => c.container.querySelector('.nx-track-marker');

describe('ProgressTrack', () => {
  it('clamps the value to 0..1', () => {
    expect(clampProgress(-0.4)).toBe(0);
    expect(clampProgress(1.7)).toBe(1);
    expect(clampProgress('0.25')).toBe(0.25);
    expect(clampProgress(NaN)).toBe(0);
    expect(clampProgress(undefined)).toBe(0);
    const c = render(<ProgressTrack value={1.6} state="live" label="Shift" />);
    expect(fill(c).style.width).toBe('100%');
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
    c.unmount();
    const d = render(<ProgressTrack value={-2} label="Shift" />);
    expect(fill(d).style.width).toBe('0%');
    expect(bar().getAttribute('aria-valuenow')).toBe('0');
  });

  it('is live while moving and done at 1 with no explicit state', () => {
    expect(trackState(0.5)).toBe('live');
    expect(trackState(1)).toBe('done');
    expect(trackState(3)).toBe('done');
    expect(trackState(1, 'live')).toBe('live');
    expect(trackState(0.4, 'bogus')).toBe('live');
    const c = render(<ProgressTrack value={0.5} />);
    expect(wrap(c).className).toContain('is-live');
    c.unmount();
    const d = render(<ProgressTrack value={1} />);
    expect(wrap(d).className).toContain('is-done');
  });

  it('takes an explicit overdue or idle state', () => {
    const c = render(<ProgressTrack value={1} state="overdue" note={<b>410 mi past due</b>} />);
    expect(wrap(c).className).toContain('is-overdue');
    c.unmount();
    const d = render(<ProgressTrack value={0} state="idle" />);
    expect(wrap(d).className).toContain('is-idle');
  });

  it('carries the progressbar aria attributes, valuetext from the note', () => {
    render(
      <ProgressTrack value={0.672} label="Today's shift" start="9:02 AM" end="5:30 PM"
        note={<><b>4h 16m left</b> in today&apos;s shift</>} />,
    );
    const b = bar();
    expect(b.getAttribute('aria-label')).toBe("Today's shift");
    expect(b.getAttribute('aria-valuemin')).toBe('0');
    expect(b.getAttribute('aria-valuemax')).toBe('100');
    expect(b.getAttribute('aria-valuenow')).toBe('67');
    expect(b.getAttribute('aria-valuetext')).toBe("4h 16m left in today's shift");
    expect(screen.getByText('9:02 AM')).toBeTruthy();
    expect(screen.getByText('5:30 PM')).toBeTruthy();
  });

  it('falls back to a percent for valuetext, and takes an override', () => {
    const c = render(<ProgressTrack value={0.45} label="Tasks" />);
    expect(bar().getAttribute('aria-valuetext')).toBe('45%');
    c.unmount();
    render(<ProgressTrack value={0.45} label="Tasks" valueText="14 of 31 done" note="ignored" />);
    expect(bar().getAttribute('aria-valuetext')).toBe('14 of 31 done');
  });

  it('shows the marker while live and hides it when done', () => {
    const c = render(<ProgressTrack value={0.5} marker />);
    expect(marker(c)).not.toBeNull();
    expect(marker(c).style.left).toBe('50%');
    c.unmount();
    const d = render(<ProgressTrack value={1} marker />);
    expect(marker(d)).toBeNull();
    d.unmount();
    const e = render(<ProgressTrack value={0.3} state="done" marker />);
    expect(marker(e)).toBeNull();
    e.unmount();
    const f = render(<ProgressTrack value={0.5} />);
    expect(marker(f)).toBeNull();
  });

  it('has a small size and no note row without a note', () => {
    const c = render(<ProgressTrack value={0.2} size="sm" />);
    expect(wrap(c).className).toContain('is-sm');
    expect(c.container.querySelector('.nx-track-note')).toBeNull();
    expect(c.container.querySelector('.nx-track-ends')).toBeNull();
  });

  it('reads nested text for nodeText', () => {
    expect(nodeText(<span>a <b>b</b> {3}</span>)).toBe('a b 3');
    expect(nodeText(null)).toBe('');
  });
});
