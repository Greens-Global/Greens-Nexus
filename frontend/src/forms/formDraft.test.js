import { describe, it, expect, beforeEach } from 'vitest';
import { draftKey, loadDraft, saveDraft, clearDraft } from './formDraft';

// The unsent-form draft belongs to the person signed in: two people on one
// crew tablet never see each other's answers (forms/formDraft.js).

beforeEach(() => { localStorage.clear(); });

describe('formDraft', () => {
  it('keys the draft by the signed-in email and the template', () => {
    expect(draftKey('t1', 'Pat@Greensglobal.com')).toBe('nexus.formDraft.pat@greensglobal.com.t1');
    expect(draftKey('t1')).toBe('nexus.formDraft.t1');
  });

  it('two emails do not share a draft', () => {
    saveDraft('t1', { entryKey: 'key-pat-0001', answers: { plate: 'PAT' }, title: 'Vehicle Check' }, 'pat@greensglobal.com');
    expect(loadDraft('t1', 'sam@greensglobal.com')).toBeNull();
    expect(loadDraft('t1')).toBeNull();
    saveDraft('t1', { entryKey: 'key-sam-0001', answers: { plate: 'SAM' }, title: 'Vehicle Check' }, 'sam@greensglobal.com');
    expect(loadDraft('t1', 'pat@greensglobal.com').answers.plate).toBe('PAT');
    expect(loadDraft('t1', 'sam@greensglobal.com').entryKey).toBe('key-sam-0001');
    clearDraft('t1', 'sam@greensglobal.com');
    expect(loadDraft('t1', 'sam@greensglobal.com')).toBeNull();
    expect(loadDraft('t1', 'pat@greensglobal.com').answers.plate).toBe('PAT');
  });
});
