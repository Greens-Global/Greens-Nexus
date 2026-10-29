import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { openNotificationTarget, setOpenTargetViewer } from './openTarget';
import { takePendingOpen, __clearPendingOpen } from './pendingOpen';

// Oct 29 2026 review: a workflow notice about a salary advance carries one
// link for everyone - the person's card in People > Time. Sent to the person
// themself (or a bell stored before they got their own link), it lands on
// their own Time Sheet.
let navs;
const onNav = (e) => navs.push(e.detail);
beforeEach(() => { navs = []; window.addEventListener('nexus:navigate', onNav); });
afterEach(() => { window.removeEventListener('nexus:navigate', onNav); __clearPendingOpen(); setOpenTargetViewer(''); });

describe('openNotificationTarget - a People > Time link to my own card', () => {
  it('opens my own Time Sheet instead', () => {
    setOpenTargetViewer('Amy@X.com');
    openNotificationTarget({ view: 'hr', sub: 'hr-time', timecard: 'amy@x.com' });
    expect(navs).toEqual([{ view: 'timeclock', sub: 'timesheet' }]);
    expect(takePendingOpen('timecard')).toBeNull();
  });

  it('keeps the period it names', () => {
    setOpenTargetViewer('amy@x.com');
    openNotificationTarget({ view: 'hr', sub: 'hr-time', timecard: 'amy@x.com', start: '2026-10-04', payType: 'hourly' });
    expect(navs).toEqual([{ view: 'timeclock', sub: 'timesheet' }]);
    expect(takePendingOpen('myTimecard')).toEqual({ start: '2026-10-04', payType: 'hourly' });
  });

  it("still opens someone else's card in People > Time", () => {
    setOpenTargetViewer('hana@x.com');
    openNotificationTarget({ view: 'hr', sub: 'hr-time', timecard: 'amy@x.com' });
    expect(navs).toEqual([]);
    expect(takePendingOpen('timecard')).toEqual({ email: 'amy@x.com', start: '', payType: '' });
  });
});
