import { describe, it, expect, afterEach } from 'vitest';
import { openNotificationTarget } from './openTarget';
import { takePendingOpen, __clearPendingOpen } from './pendingOpen';

// A notice about the employee's OWN Time Sheet opens its period (Oct 22: a
// bonus on a past period opened the current one, where it was not).
afterEach(() => __clearPendingOpen());

describe('openNotificationTarget - my own Time Sheet', () => {
  it('hands the period to my Time Sheet', () => {
    openNotificationTarget({ view: 'timeclock', sub: 'timecard', email: 'me@x.com', start: '2026-09-20', payType: 'hourly' });
    expect(takePendingOpen('myTimecard')).toEqual({ start: '2026-09-20', payType: 'hourly' });
    expect(takePendingOpen('timecard')).toBeNull();
  });

  it('leaves a manager notice to People > Time', () => {
    openNotificationTarget({ view: 'hr', sub: 'hr-time', timecard: 'emp@x.com', start: '2026-09-20' });
    expect(takePendingOpen('myTimecard')).toBeNull();
    expect(takePendingOpen('timecard')).toEqual({ email: 'emp@x.com', start: '2026-09-20', payType: '' });
  });
});
