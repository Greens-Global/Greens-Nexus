// Sheets: what goes on and comes off the clipboard. Excel and Google Sheets
// both put tab-separated text there (quoted when a value holds a tab, a
// newline or a quote) and an HTML table; we write both and read either.

/** Tab-separated text -> rows of strings. */
export function parseTSV(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], cell = '', i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i += 1; continue; }
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i += 1; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue; }
    cell += ch; i += 1;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const quote = (v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toTSV = (rows) => rows.map((r) => r.map((v) => quote(String(v ?? ''))).join('\t')).join('\n');

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** rows of {text, s} -> an HTML table Excel and Google Sheets read with bold / italic / colors. */
export function toHTML(rows) {
  const css = (s = {}) => [s.b && 'font-weight:bold', s.i && 'font-style:italic', s.u && 'text-decoration:underline',
    s.fc && `color:${s.fc}`, s.bg && `background:${s.bg}`, s.ha && `text-align:${s.ha}`].filter(Boolean).join(';');
  return `<table>${rows.map((r) => `<tr>${r.map((c) => `<td${css(c.s) ? ` style="${css(c.s)}"` : ''}>${esc(c.text)}</td>`).join('')}</tr>`).join('')}</table>`;
}

/** An HTML table (pasted from a web page with no plain text) -> rows of strings. */
export function parseHTMLTable(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  return Array.from(table.rows, (tr) => Array.from(tr.cells, (td) => td.textContent.replace(/\u00a0/g, ' ').trim()));
}
