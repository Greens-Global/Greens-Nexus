// The bookmarks parser (11/08/2026): every browser's export is the same
// Netscape DL / DT / A shape with H3 folders, so one nested fixture covers
// Chrome, Edge, Firefox and Safari.
import { describe, it, expect } from 'vitest';
import { parseBookmarks } from './bookmarks';

const FIXTURE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" LAST_MODIFIED="2" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://www.greensglobal.com/" ADD_DATE="3" ICON="data:image/png;base64,AAA=">Greens Global</A>
        <DT><H3 ADD_DATE="4">Banking</H3>
        <DL><p>
            <DT><A HREF="https://www.bankofamerica.com/">Bank of America</A>
            <DT><A HREF="http://bankofamerica.com">Bank of America (dupe)</A>
            <DT><A HREF="https://www.fidelity.com/">Fidelity</A>
        </DL><p>
        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
        <DT><A HREF="chrome://settings/">Settings</A>
        <DT><A HREF="file:///Users/me/notes.txt">Notes</A>
    </DL><p>
    <DT><A HREF="https://outlook.office.com/mail/">Outlook</A>
    <DT><A HREF="https://nameless.example.com/"></A>
</DL><p>`;

describe('parseBookmarks', () => {
  it('reads every http(s) link with its nearest folder, drops the rest, de-duplicates by normalized URL', () => {
    const rows = parseBookmarks(FIXTURE);
    expect(rows.map((r) => [r.title, r.folder])).toEqual([
      ['Greens Global', 'Bookmarks bar'],
      ['Bank of America', 'Banking'],
      ['Fidelity', 'Banking'],
      ['Outlook', ''],
      ['nameless.example.com', ''],   // no text: the host stands in
    ]);
    expect(rows[1].url).toBe('https://www.bankofamerica.com/');
  });

  it('skips what the person already has', () => {
    const rows = parseBookmarks(FIXTURE, ['https://fidelity.com', 'http://www.greensglobal.com']);
    expect(rows.map((r) => r.title)).toEqual(['Bank of America', 'Outlook', 'nameless.example.com']);
  });

  it('an empty or non-bookmark file is no rows', () => {
    expect(parseBookmarks('')).toEqual([]);
    expect(parseBookmarks('<p>hello</p>')).toEqual([]);
  });
});
