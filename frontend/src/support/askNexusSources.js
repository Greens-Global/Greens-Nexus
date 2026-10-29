// The guide sections Ask Nexus answers from (Help Center, Oct 2026). The
// written guide lives here in the browser (docsContent.js), so the asker's own
// search picks the sections - only pages their role can read (docsAccess
// `allow`) - and sends their text with the question. The server adds the
// Knowledge Base pages the person may read and caps everything again
// (backend/routers/help_center.py).
import { DOCS } from './docsContent';
import { searchDocs, resultPath } from './docsSearch';
import { openDoc } from './openDoc';
import { openKb } from './openKb';

export const GUIDE_SECTIONS = 6;
const TEXT_MAX = 4000;

function sectionText(r) {
  const doc = DOCS.find((d) => d.id === r.docId);
  if (!doc) return (r.body || []).join('\n');
  if (r.kind === 'module') {
    return [doc.tagline, doc.purpose, doc.where, ...(doc.gains || []),
      (doc.walkthroughs || []).length ? `Step-by-step guides: ${doc.walkthroughs.map((w) => w.title).join(', ')}.` : '',
      (doc.features || []).map((f) => `${f.name}: ${f.desc}`).join('\n')].filter(Boolean).join('\n');
  }
  if (r.kind === 'walkthrough') return [`${doc.name} > ${r.title}`, ...(r.body || []).map((s, i) => `${i + 1}. ${s}`)].join('\n');
  if (r.kind === 'manager') return [r.title, ...(r.body || []).map((p) => `- ${p}`)].join('\n');
  return (r.body || []).join('\n');
}

/** [{id, title, text}] for a question - the guide sections it is about. */
export function guideFor(question, allow) {
  const hits = searchDocs(question, { limit: GUIDE_SECTIONS, perDoc: 3, allow, sources: ['guide'] });
  return hits.map((r) => ({
    id: r.anchor ? `${r.docId}#${r.anchor}` : r.docId,
    title: resultPath(r),
    text: sectionText(r).slice(0, TEXT_MAX),
  }));
}

/** Open an answer's source where it lives. */
export function openSource(s) {
  if (!s) return;
  if (s.kind === 'kb') { openKb('page', s.id); return; }
  const [docId, anchor = null] = String(s.id || '').split('#');
  openDoc(docId, anchor);
}
