import { describe, it, expect } from 'vitest';
import { egnyteRedirect, PATH_TO_VIEW, VIEW_TO_PATH } from './routes';

// Files (Neil, 11/10/2026): the Documents module took in the Egnyte browser
// and is called Files. /files is its address; /documents still opens it; the
// old Files module's links (view 'egnyte') land on Browse Files.
describe('Files addresses', () => {
  it('writes /files and still reads /documents', () => {
    expect(VIEW_TO_PATH.documents).toBe('files');
    expect(PATH_TO_VIEW.files).toBe('documents');
    expect(PATH_TO_VIEW.documents).toBe('documents');
  });

  it('sends the old Files module to Browse Files, and Wiring to Wiring', () => {
    expect(egnyteRedirect('egnyte', null)).toEqual({ view: 'documents', sub: 'documents-files' });
    expect(egnyteRedirect('egnyte', 'browse')).toEqual({ view: 'documents', sub: 'documents-files' });
    expect(egnyteRedirect('egnyte', 'wiring')).toEqual({ view: 'documents', sub: 'documents-wiring' });
    expect(egnyteRedirect('documents', 'documents-browse')).toBe(null);
  });
});
