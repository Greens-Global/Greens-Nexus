// The Help Center search bar's drop-down (Oct 2026) - loaded on first focus
// (HelpCenterSearch.jsx). Ask Nexus leads; then the guide and the Knowledge
// Base, through the same search, access filter and corpus as the Help panel.
import { useMemo } from 'react';
import { Sparkles, BookOpen, ListChecks, Layers, Lightbulb, ShieldCheck, FileText, GraduationCap } from 'lucide-react';
import { searchDocs, resultPath, SOURCE_LABEL } from './docsSearch';
import { useDocAccess } from './docsAccess';
import { useKbCorpus } from './kbCorpus';
import { useSearchMissLogger } from './helpLog';
import { openDoc } from './openDoc';
import { openKb } from './openKb';

const KIND_ICON = {
  module: BookOpen, walkthrough: ListChecks, feature: Layers, tip: Lightbulb, manager: ShieldCheck,
  'kb-doc': FileText, course: GraduationCap,
};

const row = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 12px', border: 'none', borderRadius: 8,
  background: 'none', color: 'var(--ink)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
};

export default function HelpCenterResults({ query, onAsk, onClose }) {
  const { allow } = useDocAccess();
  const kb = useKbCorpus(true);
  const q = query.trim();
  const results = useMemo(
    () => (q ? searchDocs(query, { limit: 8, perDoc: 2, allow, kb: kb.corpus }) : []),
    [q, query, allow, kb.corpus],
  );
  useSearchMissLogger(q, results.length, kb.status !== 'loading');

  const pick = (r) => {
    onClose();
    if (r.source === 'kb') openKb('doc', r.kbId);
    else if (r.source === 'course') openKb('course', r.kbId);
    else openDoc(r.docId, r.anchor);
  };

  return (
    <div role="listbox" aria-label="Help results"
      style={{ position: 'absolute', top: 56, left: 0, right: 0, zIndex: 30, background: 'var(--card)', border: '1px solid var(--line)',
        borderRadius: 12, boxShadow: '0 12px 32px rgba(15,23,42,0.14)', padding: 6, maxHeight: 'min(60vh, 460px)', overflowY: 'auto' }}>
      <button type="button" role="option" aria-selected="false" onClick={onAsk} style={row} className="hc-result">
        <Sparkles size={16} style={{ color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>Ask Nexus: "{q}"</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>A written answer from the guides and the Knowledge Base</span>
        </span>
      </button>
      {results.map((r) => {
        const Icon = KIND_ICON[r.kind] || BookOpen;
        return (
          <button key={r.id} type="button" role="option" aria-selected="false" onClick={() => pick(r)} style={row} className="hc-result">
            <Icon size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.title}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.source === 'guide' ? resultPath(r) : (r.snippet || r.meta)}
              </span>
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 999, padding: '1px 8px', flexShrink: 0 }}>
              {SOURCE_LABEL[r.source] || 'Guide'}
            </span>
          </button>
        );
      })}
      {!results.length && kb.status !== 'loading' && (
        <div style={{ padding: '8px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
          No guide or Knowledge Base page matches "{q}". Ask Nexus above, or file a ticket.
        </div>
      )}
      {kb.status === 'loading' && <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--muted)' }}>Also searching the Knowledge Base...</div>}
    </div>
  );
}
