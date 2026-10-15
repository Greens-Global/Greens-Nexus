import { describe, it, expect } from 'vitest';
import { PATH_TO_VIEW, VIEW_TO_PATH } from './routes';

// The address-bar aliases. Insights (Neil, Oct 14 2026): the module reads
// /insights; old /bi links (bookmarks, emails) still open it; the view id
// stays 'bi' because it is the stored access grant.
describe('route aliases', () => {
  it('Insights lives at /insights and /bi still resolves', () => {
    expect(VIEW_TO_PATH.bi).toBe('insights');
    expect(PATH_TO_VIEW.insights).toBe('bi');
    expect(PATH_TO_VIEW.bi).toBe('bi');
  });

  it('every alias written to the address bar parses back to its view', () => {
    for (const [view, path] of Object.entries(VIEW_TO_PATH)) expect(PATH_TO_VIEW[path]).toBe(view);
  });
});
