// A job description as people read it (Oct 27 2026). The editor is plain
// text: a blank line starts a new paragraph, and a block whose every line
// starts with "- " (or * or a bullet) is a list - the same rule the server
// uses for the careers page HTML and the JobPosting data
// (hiring_openings.description_html). Text only - nothing typed is ever
// rendered as markup.
const BULLET = /^\s*[-*•]\s+/;

function descriptionBlocks(text) {
  return String(text || '').trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) return null;
    if (lines.every((l) => BULLET.test(l))) return { list: lines.map((l) => l.replace(BULLET, '').trim()) };
    return { lines: lines.map((l) => l.trim()) };
  }).filter(Boolean);
}

export default function JobDescription({ text, style }) {
  const blocks = descriptionBlocks(text);
  if (!blocks.length) return <p style={{ color: 'var(--muted, #6b7280)', margin: 0, ...style }}>No description yet.</p>;
  return (
    <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--ink, #111827)', ...style }}>
      {blocks.map((b, i) => (b.list
        ? <ul key={i} style={{ margin: '0 0 14px', paddingLeft: 22 }}>{b.list.map((li, j) => <li key={j} style={{ marginBottom: 4 }}>{li}</li>)}</ul>
        : <p key={i} style={{ margin: '0 0 14px' }}>{b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}{l}</span>)}</p>))}
    </div>
  );
}
