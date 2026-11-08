// Screens (11/07/2026): a realistic Nexus screen drawn from data, with its callouts.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Figure, { FIGURE_TEMPLATES } from './Figure';

afterEach(cleanup);

describe('screen figure', () => {
  it('draws the rail, the header, the clock and the callouts', () => {
    render(<Figure kind="screen" data={FIGURE_TEMPLATES.screen} />);
    expect(screen.getByRole('img', { name: 'Workday screen' })).toBeTruthy();
    expect(document.querySelector('.kb-scr-nav.on').textContent).toBe('Workday');
    expect(document.querySelector('.kb-scr-tabs .on').textContent).toBe('Overview');
    expect(document.querySelector('.kb-scr-clock.in')).toBeTruthy();
    expect(screen.getByText('Punched in at 8:02 AM')).toBeTruthy();
    expect(document.querySelectorAll('.kb-scr-n').length).toBe(4);   // two on the buttons, two in the legend
    expect(screen.getByText('Punch Out').closest('.kb-scr-btn').classList.contains('pri')).toBe(true);
  });
  it('draws a phone with a dialog over the page, a banner and a list', () => {
    render(<Figure kind="screen" data={{ title: 'Early', device: 'phone', module: 'Workday', badge: 1,
      parts: [
        { kind: 'banner', tone: 'warn', text: 'A Time Sheet is waiting for your signature.', buttons: ['Open'] },
        { kind: 'list', title: 'Open Tickets', items: [{ label: 'Gate 2 keypad not responding', note: 'Expect a reply by 11/08/2026 9:00 AM', badge: 'In Progress', tone: 'live' }] },
        { kind: 'dialog', title: 'Early Clock-In', text: 'Your shift starts at 9:00 AM, about 25 minutes from now. Clock in anyway?', buttons: ['Not Yet', { label: 'Clock In Anyway', primary: true }] },
      ] }} />);
    expect(document.querySelector('.kb-scr--phone')).toBeTruthy();
    expect(document.querySelector('.kb-scr-rail')).toBeNull();
    expect(document.querySelector('.kb-scr-banner.warn')).toBeTruthy();
    expect(document.querySelector('.kb-scr-badge.live').textContent).toBe('In Progress');
    expect(document.querySelector('.kb-scr-dialog')).toBeTruthy();
    expect(document.querySelector('.kb-scr-body.under')).toBeTruthy();
    expect(screen.getByText('Clock In Anyway')).toBeTruthy();
    expect(document.querySelector('.kb-scr-ico.bell em').textContent).toBe('1');
  });
});
