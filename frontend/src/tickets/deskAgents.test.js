import { describe, it, expect } from 'vitest';
import { agentOptions } from './deskAgents';

describe('agentOptions', () => {
  it('lists the agents, and a current choice who is no longer one, marked', () => {
    const agents = [{ email: 'sam@x.com', name: 'Sam Patel' }];
    expect(agentOptions(agents, 'sam@x.com')).toEqual([{ email: 'sam@x.com', name: 'Sam Patel' }]);
    expect(agentOptions(agents, 'Left@x.com', [{ email: 'left@x.com', name: 'Lee Left' }])).toEqual([
      { email: 'sam@x.com', name: 'Sam Patel' }, { email: 'left@x.com', name: 'Lee Left (not on the desk)' }]);
    expect(agentOptions(undefined, '')).toEqual([]);
  });
});
