import { describe, it, expect } from 'vitest';
import { PATH_TO_VIEW, VIEW_TO_PATH, purchaseRedirect, addressFor } from './routes';

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

// Purchase Requisition moved from Item Management to Workday (Neil, Oct 22
// 2026): every old address lands on Workday > Purchase Requests.
describe('purchase requisition redirects', () => {
  it('sends the retired Purchase view to the Workday tab, opening the form for New Request', () => {
    expect(purchaseRedirect('purchase', null)).toEqual({ view: 'myhr', sub: 'purchase' });
    expect(purchaseRedirect('purchase', 'log')).toEqual({ view: 'myhr', sub: 'purchase' });
    expect(purchaseRedirect('purchase', 'new')).toEqual({ view: 'myhr', sub: 'purchase:new' });
  });

  it("sends Item Management's old Purchase Requests tab there too, at either address", () => {
    expect(purchaseRedirect('inventory', 'purchasereqs')).toEqual({ view: 'myhr', sub: 'purchase' });
    expect(purchaseRedirect(PATH_TO_VIEW.itemmanagement, 'purchasereqs')).toEqual({ view: 'myhr', sub: 'purchase' });
  });

  it('leaves every other address alone', () => {
    expect(purchaseRedirect('inventory', 'catalog')).toBeNull();
    expect(purchaseRedirect('myhr', 'purchase')).toBeNull();
    expect(purchaseRedirect('dashboard', null)).toBeNull();
  });
});

// An email's /support?ticket=<id> is rewritten to /help-center on load; the
// ticket id must survive that first rewrite (Oct 28 2026), and only that one.
describe('addressFor', () => {
  it('keeps the query and hash on the first rewrite of the opened address', () => {
    expect(addressFor(`/${VIEW_TO_PATH.support}`, { first: true, search: '?ticket=abc', hash: '' })).toBe('/help-center?ticket=abc');
    expect(addressFor('/help-center/documentation', { first: true, search: '?doc=workday&section=w-1', hash: '#x' }))
      .toBe('/help-center/documentation?doc=workday&section=w-1#x');
  });

  it('starts clean on every later navigation', () => {
    expect(addressFor('/tasks', { first: false, search: '?ticket=abc' })).toBe('/tasks');
    expect(addressFor('/tasks')).toBe('/tasks');
  });
});
