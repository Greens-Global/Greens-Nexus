import { describe, it, expect } from 'vitest';
import { teamsChatUrl, teamsCallUrl, teamsVideoUrl, canReachOnTeams } from './teamsLinks';

describe('Teams deep links', () => {
  it('builds the 1:1 chat link, trimmed and encoded', () => {
    expect(teamsChatUrl(' Ana@greensglobal.com ')).toBe('https://teams.microsoft.com/l/chat/0/0?users=Ana%40greensglobal.com');
  });
  it('carries a prefilled message, encoded', () => {
    expect(teamsChatUrl('a@x.com', 'Hi Ana, about your time sheet:\n- 2 items'))
      .toBe('https://teams.microsoft.com/l/chat/0/0?users=a%40x.com&message=Hi%20Ana%2C%20about%20your%20time%20sheet%3A%0A-%202%20items');
  });
  it('builds the call and video links', () => {
    expect(teamsCallUrl('a@x.com')).toBe('https://teams.microsoft.com/l/call/0/0?users=a%40x.com');
    expect(teamsVideoUrl('a@x.com')).toBe('https://teams.microsoft.com/l/call/0/0?users=a%40x.com&withVideo=true');
  });
  it('reaches internal staff with a work email only', () => {
    expect(canReachOnTeams({ email: 'a@x.com' })).toBe(true);
    expect(canReachOnTeams({ email: 'a@x.com', external: true })).toBe(false);
    expect(canReachOnTeams({ email: 'a@x.com', isExternal: true })).toBe(false);
    expect(canReachOnTeams({ email: 'a@x.com', kind: 'guest' })).toBe(false);
    expect(canReachOnTeams({ email: '' })).toBe(false);
    expect(canReachOnTeams(null)).toBe(false);
    expect(canReachOnTeams('a@x.com')).toBe(true);
  });
  it('never offers to message yourself', () => {
    expect(canReachOnTeams({ email: 'Me@x.com' }, 'me@x.com')).toBe(false);
    expect(canReachOnTeams({ email: 'you@x.com' }, 'me@x.com')).toBe(true);
  });
});
