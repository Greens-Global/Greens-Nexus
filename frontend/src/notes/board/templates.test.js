// Board templates (11/02/2026): each is a valid scene the API accepts, and
// says what it promises.
import { describe, it, expect } from 'vitest';
import { TEMPLATES, templateByKey, templateScene } from './templates';
import { parseScene, SCENE_TYPE } from './scene';

describe('board templates', () => {
  it('offers Blank, Grid, Kanban, Timeline and Floor Plan, each a parseable nexus-board scene', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['blank', 'grid', 'kanban', 'timeline', 'floorplan']);
    for (const t of TEMPLATES) {
      const str = templateScene(t.key);
      const s = parseScene(str);
      expect(s, t.key).not.toBeNull();
      expect(s.type).toBe(SCENE_TYPE);
      expect(s.look).toBe('clean');
      expect(JSON.parse(str).elements.every((e) => e.id && e.type && typeof e.x === 'number' && typeof e.y === 'number')).toBe(true);
      expect(str.length).toBeLessThan(100_000);
    }
  });

  it('Blank is empty; Grid and Floor Plan turn the grid on', () => {
    expect(parseScene(templateScene('blank')).elements).toEqual([]);
    expect(parseScene(templateScene('grid')).appState.gridModeEnabled).toBe(true);
    expect(parseScene(templateScene('floorplan')).appState).toMatchObject({ gridModeEnabled: true, gridSize: 20 });
  });

  it('Kanban has three frames named To Do, Doing and Done', () => {
    const frames = parseScene(templateScene('kanban')).elements.filter((e) => e.type === 'frame');
    expect(frames.map((f) => f.name)).toEqual(['To Do', 'Doing', 'Done']);
    expect(new Set(frames.map((f) => f.x)).size).toBe(3);
    // the frame names are the headings - no text inside repeats them
    expect(parseScene(templateScene('kanban')).elements.filter((e) => e.type === 'text')).toEqual([]);
  });

  it('Grid is an empty board with the grid on (no stray title)', () => {
    expect(parseScene(templateScene('grid')).elements).toEqual([]);
  });

  it('the copy reads in the house words', () => {
    expect(templateByKey('grid').hint).toBe('Snaps to a grid for tidy diagrams');
    expect(templateByKey('kanban').hint).toBe('To Do, Doing and Done columns');
    expect(templateByKey('timeline').hint).toBe('Seven weeks from this Sunday, dated');
    const texts = parseScene(templateScene('floorplan')).elements.filter((e) => e.type === 'text').map((e) => e.text);
    expect(texts).toContain('Each grid square is 1 ft. Draw walls with the thick line, doors as arcs, and labels in gray.');
  });

  it('Timeline carries seven dated ticks in US format', () => {
    const texts = parseScene(templateScene('timeline')).elements.filter((e) => e.type === 'text').map((e) => e.text);
    const dates = texts.filter((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t));
    expect(dates).toHaveLength(7);
  });

  it('an unknown key falls back to Blank', () => {
    expect(templateByKey('nope').key).toBe('blank');
  });
});
