import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  LABEL_TONES, TONE_KEYS, DEFAULT_TONE_KEYS, labelKey, cleanLabel, labelTone, labelToneKey, defaultToneKey,
  labelName, canonicalLabel, mergeLabels, labelsInUse, mergeLabelLists, labelSuggestions,
} from './labels';
import { EMPTY_FILTER, matchesFilter, groupTasks, groupAddDefaults } from './lib';

// Labels done right (Oct 22 2026): one identity per label whatever its case,
// a color with zero setup, the company's overrides, and the filter and the
// List's group-by that read them.

const task = (id, tags) => ({ id, title: id, status: 'not_started', priority: 'medium', tags });

describe('label identity', () => {
  it('is trimmed, collapsed and case-insensitive', () => {
    expect(labelKey('  Q4   Close ')).toBe('q4 close');
    expect(cleanLabel('  Q4   Close ')).toBe('Q4 Close');
    expect(labelKey('URGENT')).toBe(labelKey('urgent'));
    expect(labelKey(null)).toBe('');
  });
});

describe('labelTone', () => {
  it('is deterministic and case-insensitive', () => {
    expect(labelTone('Urgent')).toEqual(labelTone('urgent'));
    expect(labelTone('  URGENT ')).toEqual(labelTone('urgent'));
    expect(labelTone('Client')).toEqual(labelTone('Client'));
  });

  it('hashes to the same tone as the server (task_labels.default_tone)', () => {
    // The vectors test_task_labels.py checks against default_tone.
    expect(defaultToneKey('urgent')).toBe('red');
    expect(defaultToneKey('client')).toBe('blue');
    expect(defaultToneKey('marketing')).toBe('green');
    expect(defaultToneKey('café')).toBe('indigo');
  });

  it('only hands out the ten default tones, spread across them', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => defaultToneKey(`label ${i}`)));
    expect([...seen].every((k) => DEFAULT_TONE_KEYS.includes(k))).toBe(true);
    expect(seen.size).toBe(10);
    expect(DEFAULT_TONE_KEYS).not.toContain('slate');
  });

  it('answers theme-aware CSS variables plus a hex accent', () => {
    const t = labelTone('urgent');
    expect(t).toEqual({ tone: 'red', fg: 'var(--nx-tag-red-fg)', bg: 'var(--nx-tag-red-bg)',
      border: 'var(--nx-tag-red-border)', dot: LABEL_TONES.red.dot });
    expect(t.dot).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('a company override wins, by key; an unknown tone falls back to the default', () => {
    const map = { urgent: { name: 'Urgent', color: 'teal' }, odd: { name: 'Odd', color: 'chartreuse' } };
    expect(labelToneKey('URGENT', map)).toBe('teal');
    expect(labelToneKey('odd', map)).toBe(defaultToneKey('odd'));
    expect(labelToneKey('client', map)).toBe(defaultToneKey('client'));
    expect(labelName('urgent', map)).toBe('Urgent');
    expect(labelName(' client ', map)).toBe('client');
  });
});

describe('the palette in style.css', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');
  const tail = css.slice(css.indexOf('Task labels (tasks/labels.js'));
  const block = (selector) => {
    const at = tail.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return tail.slice(at, tail.indexOf('}', at));
  };
  const light = block(':root');
  const dark = block('[data-theme="dark"]');

  it('declares every tone for the light and the dark theme, as labels.js has them', () => {
    for (const k of TONE_KEYS) {
      for (const p of ['fg', 'bg', 'border']) {
        expect(light).toContain(`--nx-tag-${k}-${p}: ${LABEL_TONES[k].light[p]};`);
        expect(dark).toContain(`--nx-tag-${k}-${p}: ${LABEL_TONES[k].dark[p]};`);
      }
    }
  });

  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

  it('reads well: label text on its own tint is at least 6:1 in both themes (WCAG AA is 4.5)', () => {
    for (const k of TONE_KEYS) {
      expect(contrast(LABEL_TONES[k].light.fg, LABEL_TONES[k].light.bg)).toBeGreaterThanOrEqual(6);
      expect(contrast(LABEL_TONES[k].dark.fg, LABEL_TONES[k].dark.bg)).toBeGreaterThanOrEqual(6);
      // Soft, never solid: the light tint is pale, the dark one deep.
      expect(lum(LABEL_TONES[k].light.bg)).toBeGreaterThan(0.75);
      expect(lum(LABEL_TONES[k].dark.bg)).toBeLessThan(0.05);
    }
  });
});

describe('spelling and merging', () => {
  const map = { urgent: { name: 'Urgent', color: '' } };
  it('stores the existing spelling when there is one', () => {
    expect(canonicalLabel('URGENT', map)).toBe('Urgent');
    expect(canonicalLabel('client', null, [{ key: 'client', name: 'Client' }])).toBe('Client');
    expect(canonicalLabel('client', null, ['Client'])).toBe('Client');
    expect(canonicalLabel('  brand   new ', null, [])).toBe('brand new');
    expect(canonicalLabel('   ', map)).toBe('');
  });

  it('merges by key, keeping order', () => {
    expect(mergeLabels(['Urgent', 'Client'], ['urgent', 'New'])).toEqual(['Urgent', 'Client', 'New']);
    expect(mergeLabels(['Urgent', 'Client'], [], ['URGENT'])).toEqual(['Client']);
    expect(mergeLabels(['a', 'A', ' '])).toEqual(['a']);
  });

  it('tallies labels in use with the most common spelling', () => {
    const rows = labelsInUse([task('1', ['Urgent']), task('2', ['urgent', 'Client']), task('3', ['Urgent', 'URGENT'])]);
    expect(rows).toEqual([{ key: 'client', name: 'Client', count: 1 }, { key: 'urgent', name: 'Urgent', count: 3 }]);
    expect(mergeLabelLists([{ key: 'urgent', name: 'Urgent', count: 5 }], rows).map((r) => [r.key, r.count]))
      .toEqual([['client', 1], ['urgent', 5]]);
  });

  it('suggests labels not on the task, prefix matches first, then the most used', () => {
    const known = [{ key: 'urgent', name: 'Urgent', count: 2 }, { key: 'not urgent', name: 'Not Urgent', count: 9 },
      { key: 'client', name: 'Client', count: 4 }];
    expect(labelSuggestions(known, 'urg').map((r) => r.name)).toEqual(['Urgent', 'Not Urgent']);
    expect(labelSuggestions(known, '').map((r) => r.name)).toEqual(['Not Urgent', 'Client', 'Urgent']);
    expect(labelSuggestions(known, '', ['CLIENT']).map((r) => r.name)).toEqual(['Not Urgent', 'Urgent']);
  });
});

describe('the Labels filter', () => {
  const urgent = task('1', ['Urgent']);
  const client = task('2', ['client']);
  const none = task('3', []);
  it('matches ANY of the picked labels, case-insensitively', () => {
    const f = { ...EMPTY_FILTER, tags: ['urgent', 'Client'] };
    expect([urgent, client, none].filter((t) => matchesFilter(t, f)).map((t) => t.id)).toEqual(['1', '2']);
    expect(matchesFilter(urgent, { ...EMPTY_FILTER, tags: ['URGENT'] })).toBe(true);
    expect(matchesFilter(none, { ...EMPTY_FILTER, tags: [] })).toBe(true);
    expect(matchesFilter({ ...none, tags: undefined }, { ...EMPTY_FILTER, tags: ['x'] })).toBe(false);
  });
});

describe('Group by Label', () => {
  const both = task('both', ['Urgent', 'client']);
  const one = task('one', ['URGENT']);
  const bare = task('bare', []);
  const map = { client: { name: 'Client', color: 'purple' } };

  it('lists a task under each of its labels, A-Z, with No Label last', () => {
    const groups = groupTasks([bare, both, one], 'label', { labelMap: map });
    expect(groups.map((g) => g.label)).toEqual(['Client', 'Urgent', 'No Label']);
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([['both'], ['both', 'one'], ['bare']]);
    // Keys never collide with another grouping's (status 'completed' etc.).
    expect(groups.map((g) => g.key)).toEqual(['label:client', 'label:urgent', '-']);
    expect(groups[0].color).toBe(LABEL_TONES.purple.dot);
    expect(groups[0].labelName).toBe('Client');
    expect(groups[2].labelName).toBeUndefined();
  });

  it('a task carrying one label twice is listed once under it', () => {
    const groups = groupTasks([task('x', ['a', 'A'])], 'label');
    expect(groups).toHaveLength(1);
    expect(groups[0].tasks).toHaveLength(1);
  });

  it('omits No Label when every task has one', () => {
    expect(groupTasks([one], 'label').map((g) => g.label)).toEqual(['URGENT']);
  });

  it('an inline add in a label group carries that label; No Label carries none', () => {
    const [clientGroup, , noLabel] = groupTasks([bare, both, one], 'label', { labelMap: map });
    expect(groupAddDefaults('label', clientGroup.key, clientGroup)).toEqual({ tags: ['Client'] });
    expect(groupAddDefaults('label', noLabel.key, noLabel)).toEqual({});
  });
});
