import { describe, it, expect } from 'vitest';
import { summarizeCategories, hasNewFeature } from './changelogCategories';
import { canEditWhatsNew } from './whatsNewAccess';

describe('update categories, in words', () => {
  it('names each category with its count, features first, in plain English', () => {
    expect(summarizeCategories({ 'Bug Fix': 3, 'New Feature': 2 })).toBe('2 new features and 3 bug fixes');
    expect(summarizeCategories({ 'New Feature': 1 })).toBe('1 new feature');
    expect(summarizeCategories({ 'Bug Fix': 1, Improvement: 2, 'Security Update': 1 }))
      .toBe('2 improvements, 1 security update and 1 bug fix');
  });

  it('folds unknown types into "other updates" and says nothing for nothing', () => {
    expect(summarizeCategories({ 'Bug Fix': 1, Mystery: 2 })).toBe('1 bug fix and 2 other updates');
    expect(summarizeCategories({})).toBe('');
  });

  it('knows a new feature when it sees one', () => {
    expect(hasNewFeature({ 'New Feature': 1 })).toBe(true);
    expect(hasNewFeature({ 'Bug Fix': 4 })).toBe(false);
  });
});

describe("who may change What's New", () => {
  it('an administrator, or anyone with the Tasks or Tickets grant - nobody else', () => {
    expect(canEditWhatsNew({ can: (r) => r === 'administrator' })).toBe(true);
    expect(canEditWhatsNew({ can: () => false, myGrantedModules: new Map([['tickets', 'viewer']]) })).toBe(true);
    expect(canEditWhatsNew({ can: () => false, myGrantedModules: new Map([['support', 'viewer']]) })).toBe(false);
    expect(canEditWhatsNew({})).toBe(false);
  });
});
