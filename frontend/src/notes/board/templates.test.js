// Board templates (11/02/2026): each is a valid scene the API accepts, and
// says what it promises.
import { describe, it, expect } from 'vitest';
import { TEMPLATES, templateByKey, templateScene } from './templates';
import { parseScene, SCENE_TYPE } from './scene';

describe('board templates', () => {
  it('offers Blank, Grid, Kanban, Timeline and Floor Plan, each a parseable nexus-board scene', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['blank', 'grid', 'kanban', 'timeline', 'floorplan', 'retro', 'kickoff', 'swot', 'fishbone', 'sitewalk', 'huddle']);
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
    // the frame names are the column headings - no text repeats them; the only
    // words are the board's own title and what it is for (Neil, 11/12/2026)
    const words = parseScene(templateScene('kanban')).elements.filter((e) => e.type === 'text').map((e) => e.text);
    expect(words).toEqual(['Kanban', 'One sticky per piece of work. Move it right as it moves on.']);
  });

  it('every template with sections opens with a title and one line saying what it is for; Blank and Grid stay empty', () => {
    for (const key of ['kanban', 'retro', 'kickoff', 'swot', 'fishbone', 'sitewalk', 'huddle', 'timeline', 'floorplan']) {
      const els = parseScene(templateScene(key)).elements;
      // the two topmost lines of words: the title, then what the board is for
      const [title, ...rest] = els.filter((e) => e.type === 'text').sort((a, b) => a.y - b.y);
      const top = Math.min(...els.filter((e) => e.type !== 'text').map((e) => e.y));
      expect(title.fontSize, key).toBe(28);
      expect(title.y, key).toBeLessThan(top);
      const purpose = rest.filter((e) => e.y < top && e.text.length > 12);
      expect(purpose.length, key).toBeGreaterThanOrEqual(1);
      for (const e of [title, ...purpose]) expect(e.text, key).not.toMatch(/[\u2014\u2013]/);
    }
    expect(parseScene(templateScene('blank')).elements).toEqual([]);
    expect(parseScene(templateScene('grid')).elements).toEqual([]);
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

  const frameNames = (key) => parseScene(templateScene(key)).elements.filter((e) => e.type === 'frame').map((f) => f.name);
  const texts = (key) => parseScene(templateScene(key)).elements.filter((e) => e.type === 'text').map((e) => e.text);

  it('the facilitation templates carry their named frames', () => {
    expect(frameNames('retro')).toEqual(['What Went Well', 'What Did Not', 'What We Will Try']);
    expect(frameNames('kickoff')).toEqual(['Goals', 'Scope', 'People and Roles', 'Risks', 'First Milestones']);
    expect(frameNames('swot')).toEqual(['Strengths', 'Weaknesses', 'Opportunities', 'Threats']);
    expect(frameNames('sitewalk')).toEqual(['Stop 1', 'Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Stop 6']);
    expect(frameNames('huddle')).toEqual(['Wins', 'Priorities This Week', 'Blockers', 'Shout-Outs']);
    for (const key of ['retro', 'kickoff', 'swot', 'sitewalk', 'huddle']) {
      const frames = parseScene(templateScene(key)).elements.filter((e) => e.type === 'frame');
      // no two frames overlap
      expect(new Set(frames.map((f) => `${f.x},${f.y}`)).size, key).toBe(frames.length);
    }
  });

  it('Fishbone has a spine, a Problem head and six labeled bones', () => {
    const els = parseScene(templateScene('fishbone')).elements;
    expect(els.filter((e) => e.type === 'line')).toHaveLength(7);
    expect(texts('fishbone')).toEqual(expect.arrayContaining(['Problem', 'People', 'Process', 'Equipment', 'Materials', 'Site', 'Weather', 'Write each cause on a sticky along its bone.']));
  });

  it('Site Walk and Weekly Huddle are dated in US format', () => {
    expect(texts('sitewalk').filter((t) => /^\d{2}\/\d{2}\/\d{4}$/.test(t))).toHaveLength(1);
    expect(texts('sitewalk')).toContain('Drop a photo and a sticky in each stop.');
    expect(texts('huddle').some((t) => /^Week of \d{2}\/\d{2}\/\d{4}$/.test(t))).toBe(true);
  });

  it('no template copy uses an em dash', () => {
    for (const t of TEMPLATES) {
      expect(`${t.label} ${t.hint} ${texts(t.key).join(' ')}`, t.key).not.toMatch(/—/);
    }
  });

  it('an unknown key falls back to Blank', () => {
    expect(templateByKey('nope').key).toBe('blank');
  });
});
