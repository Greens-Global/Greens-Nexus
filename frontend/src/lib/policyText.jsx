import { formatDate } from './datetime';

// The sign-in policy's text (backend/routers/policy.py) is plain text with a
// tiny markdown subset: "## " starts a heading, "- " or "* " a bullet, and a
// blank line separates paragraphs. Rendered as React text nodes only - never
// as HTML - so nothing an admin types can inject markup. Shared by the
// sign-in gate (PolicyGate.jsx) and the editor's preview in Settings.
export function parsePolicy(body) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push({ t: 'ul', items: list }); list = null; } };
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const b = line.match(/^[-*]\s+(.*)$/);
    if (h) { flushPara(); flushList(); blocks.push({ t: 'h', text: h[1] }); }
    else if (b) { flushPara(); (list ||= []).push(b[1]); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return blocks;
}

// "2026-09-26" -> "09/26/2026"; "2026-09-26.2" -> "09/26/2026 (revision 2)".
export function formatPolicyVersion(v) {
  const [day, rev] = String(v || '').split('.');
  const d = formatDate(day, v || '');
  return rev ? `${d} (revision ${rev})` : d;
}

export function PolicyText({ body }) {
  return parsePolicy(body).map((b, i) => {
    if (b.t === 'h') return <div key={i} style={{ fontSize: 13.5, fontWeight: 800, margin: '14px 0 4px' }}>{b.text}</div>;
    if (b.t === 'ul') {
      return (
        <ul key={i} style={{ margin: '0 0 10px', paddingLeft: 20, fontSize: 13, lineHeight: 1.6, color: 'var(--ink)' }}>
          {b.items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>
      );
    }
    return <p key={i} style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>{b.text}</p>;
  });
}
