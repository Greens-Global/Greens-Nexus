import { describe, it, expect } from 'vitest';
import { parseSub, buildSub, tabFor } from './sub';

describe('workflows sub', () => {
  it('parses every screen and the two id forms', () => {
    expect(parseSub('overview')).toEqual({ screen: 'overview' });
    expect(parseSub('list')).toEqual({ screen: 'list' });
    expect(parseSub('automations')).toEqual({ screen: 'automations' });
    expect(parseSub('runs')).toEqual({ screen: 'runs' });
    expect(parseSub('templates')).toEqual({ screen: 'templates' });
    expect(parseSub('catalog')).toEqual({ screen: 'catalog' });
    expect(parseSub('settings')).toEqual({ screen: 'settings' });
    expect(parseSub('wf:abc-123')).toEqual({ screen: 'builder', id: 'abc-123' });
    expect(parseSub('run:r9')).toEqual({ screen: 'run', id: 'r9' });
  });

  it('carries a run to replay on the builder canvas', () => {
    expect(parseSub('wf:abc:run:r9')).toEqual({ screen: 'builder', id: 'abc', runId: 'r9' });
    expect(parseSub('wf:abc:run:')).toEqual({ screen: 'builder', id: 'abc' });
    expect(parseSub('wf::run:r9')).toEqual({ screen: 'overview' });
    expect(buildSub('builder', 'abc', 'r9')).toBe('wf:abc:run:r9');
    expect(buildSub('builder', 'abc', '')).toBe('wf:abc');
    expect(parseSub(buildSub('builder', 'x', 'y'))).toEqual({ screen: 'builder', id: 'x', runId: 'y' });
    expect(tabFor('wf:abc:run:r9')).toBe('list');
  });

  it('lands unknown, empty and bare prefixes on Overview', () => {
    expect(parseSub(null)).toEqual({ screen: 'overview' });
    expect(parseSub('')).toEqual({ screen: 'overview' });
    expect(parseSub('nope')).toEqual({ screen: 'overview' });
    expect(parseSub('wf:')).toEqual({ screen: 'overview' });
    expect(parseSub('run:')).toEqual({ screen: 'overview' });
  });

  it('builds the sub back', () => {
    expect(buildSub('builder', 'abc')).toBe('wf:abc');
    expect(buildSub('run', 'r1')).toBe('run:r1');
    expect(buildSub('runs')).toBe('runs');
    expect(buildSub('builder')).toBe('list');
    expect(buildSub('bogus')).toBe('overview');
    expect(parseSub(buildSub('builder', 'x'))).toEqual({ screen: 'builder', id: 'x' });
  });

  it('lights the tab a screen belongs to', () => {
    expect(tabFor('wf:1')).toBe('list');
    expect(tabFor('run:1')).toBe('runs');
    expect(tabFor('automations')).toBe('automations');
    expect(tabFor(null)).toBe('overview');
  });
});
