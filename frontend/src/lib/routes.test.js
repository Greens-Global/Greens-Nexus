import { describe, it, expect } from 'vitest';
import { PATH_TO_VIEW, VIEW_TO_PATH, purchaseRedirect, addressFor, tabAddress, TAB_ADDRESSES } from './routes';

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

// Credential Vault is Credentials (Neil, Oct 28 2026): the address reads
// /credentials, old /credvault links still land, the stored id stays.
describe('credentials address', () => {
  it('writes /credentials and reads both addresses as the credvault view', () => {
    expect(VIEW_TO_PATH.credvault).toBe('credentials');
    expect(PATH_TO_VIEW.credentials).toBe('credvault');
    expect(PATH_TO_VIEW.credvault).toBe('credvault');
  });
});

// A module tab's obvious address (11/05/2026): /notes was Page Not Found
// because Notes is a Dashboard tab.
describe('tab addresses', () => {
  it('/notes opens Dashboard > Notes, and /notes/<id> that note', () => {
    expect(tabAddress('notes', null)).toEqual({ view: 'dashboard', sub: 'notes' });
    expect(tabAddress('notes', 'n42')).toEqual({ view: 'dashboard', sub: 'notes:n42' });
  });

  it('lands the other obvious tab addresses on their tab', () => {
    expect(tabAddress('time-sheet', null)).toEqual({ view: 'myhr', sub: 'timesheet' });
    expect(tabAddress('time-off', 'x')).toEqual({ view: 'myhr', sub: 'timeoff' });
    expect(tabAddress('shift-planner', null)).toEqual({ view: 'shifts', sub: 'schedule' });
    expect(tabAddress('org-chart', null)).toEqual({ view: 'hr', sub: 'hr-org' });
    expect(tabAddress('nexus-sign', null)).toEqual({ view: 'documents', sub: 'documents-esign' });
    expect(tabAddress('pdf-tools', null)).toEqual({ view: 'documents', sub: 'documents-pdf' });
  });

  it('never shadows a real module or its address alias', () => {
    for (const alias of Object.keys(TAB_ADDRESSES)) expect(PATH_TO_VIEW[alias]).toBeUndefined();
    expect(tabAddress('dashboard', 'notes')).toBeNull();
    expect(tabAddress('toString', null)).toBeNull();
    expect(tabAddress(null, null)).toBeNull();
  });
});
