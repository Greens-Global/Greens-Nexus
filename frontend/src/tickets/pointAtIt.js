// Point At It (Neil, 11/12/2026): anyone filing a ticket clicks the thing
// that is wrong, and the ticket gets a picture of it and ONE line saying
// where it is:
//
//   Where: Tasks > Home (/tasks/home) - button "Add Task" [src/tasks/Home.jsx:120]
//
// The picture is an ordinary ticket attachment; the line is ordinary text
// (the bracket only where the build carries source marks). Nothing here is
// Build Mode's own - no grant, no pin. A developer who later sends the
// ticket to Claude Code gets the place back from that line
// (backend/build_mode_tickets.py parse_where - keep the two in step).
//
// Plain DOM on purpose: the person may have to walk to another screen first
// (Browse), and that unmounts the ticket form - this layer must outlive it,
// exactly as the screen recorder's pill does. Sensitive fields (passwords,
// card and account numbers...) are blacked out before the picture exists,
// by the same rule Build Mode uses.
import { elementAt, describeTarget, rectOf, OWN_ATTR, preloadSourceFiles, resolveSource } from '../devnotes/lib/capture';
import { grabAreaFrame, makeShots, AREA_PAD } from '../devnotes/lib/screenshot';
import { sensitiveRects } from '../devnotes/lib/privacy';
import { MODULES } from '../contexts/RoleContext';

const LABELS = Object.fromEntries((MODULES || []).map((m) => [m.id, m.label]));
const KIND = { button: 'button', a: 'link', input: 'field', select: 'field', textarea: 'field', img: 'picture', svg: 'icon', th: 'column', td: 'cell', tr: 'row', label: 'label' };
const clean = (s, max) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/** What was clicked, in words: `button "Add Task"`. Never a `[`, a `(` or a line break (the Where line's own marks). */
export function whatOf(target) {
  const tag = String(target?.tag || '').toLowerCase();
  const role = target?.attrs?.role === 'button' ? 'button' : (KIND[tag] || 'area');
  const text = clean(target?.text || target?.attrs?.['aria-label'] || target?.attrs?.placeholder || target?.attrs?.title, 60).replace(/[[\]()"]/g, '');
  return text ? `${role} "${text}"` : role;
}

/** The Where line for a described target at a path. */
export function whereLine(target, path = '/') {
  const route = String(path || '/').split('?')[0].split('/').filter(Boolean)[0] || '';
  const crumb = clean(target?.breadcrumb, 80).replace(/[()[\]]/g, '');
  const mod = LABELS[route] || '';
  const label = [mod, crumb && crumb !== mod ? crumb : ''].filter(Boolean).join(' > ') || 'Nexus';
  const src = target?.source?.file ? ` [${target.source.file}:${target.source.line || 1}]` : '';
  return `Where: ${label} (${String(path || '/').replace(/[\s()]/g, '')}) - ${whatOf(target)}${src}`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WHERE_P = /<p>Where: [^<]*<\/p>/;
/** The description with the Where line as its last paragraph - one line only, a second pointing replaces the first. */
export function withWhere(html, line) {
  const p = `<p>${esc(line)}</p>`;
  const cur = String(html || '');
  return WHERE_P.test(cur) ? cur.replace(WHERE_P, p) : cur + p;
}

const css = (el, style) => Object.assign(el.style, style);
const BTN = { font: "600 13px 'Inter', sans-serif", height: '30px', padding: '0 12px', borderRadius: '8px', border: '1px solid #d1d5db', background: '#fff', color: '#111827', cursor: 'pointer' };

/**
 * Let the person click one thing on the page. Resolves { file, where, target }
 * (file null when no picture could be taken) or null on Cancel / Escape.
 */
export function pointAtIt() {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let mode = 'point';
    const root = document.createElement('div');
    root.setAttribute(OWN_ATTR, '');
    root.setAttribute('data-testid', 'point-at-it');
    css(root, { position: 'fixed', inset: '0', zIndex: '5995', cursor: 'crosshair' });
    const box = document.createElement('div');
    box.setAttribute(OWN_ATTR, '');
    box.className = 'bm-hover';
    css(box, { display: 'none', zIndex: '5996' });
    const pill = document.createElement('div');
    pill.setAttribute(OWN_ATTR, '');
    pill.setAttribute('role', 'toolbar');
    pill.setAttribute('aria-label', 'Point At It');
    css(pill, { position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)', zIndex: '5997', display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px 10px 8px 14px', borderRadius: '12px', background: '#111827', color: '#fff', font: "13px 'Inter', sans-serif",
      boxShadow: '0 10px 30px rgba(0,0,0,.28)', cursor: 'default', maxWidth: 'calc(100vw - 24px)' });
    const words = document.createElement('span');
    const browse = document.createElement('button');
    browse.type = 'button';
    css(browse, BTN);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    css(cancel, { ...BTN, background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,.35)' });
    pill.append(words, browse, cancel);

    const paint = () => {
      const pointing = mode === 'point';
      words.textContent = pointing ? 'Click the thing that is wrong.' : 'Go to the screen it is on, then press Point.';
      browse.textContent = pointing ? 'Browse First' : 'Point';
      root.style.pointerEvents = pointing ? 'auto' : 'none';
      if (!pointing) box.style.display = 'none';
    };
    const done = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.remove(); box.remove(); pill.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      if (!el) { box.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      css(box, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const onPick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      let target = describeTarget(el);
      const rect = rectOf(el);
      // A source mark is a number until the build's file table is in (it is
      // loaded for Build Mode only). Ask for it; a mark that still has no
      // path is left out - "file #155" tells nobody anything.
      if (target.source) {
        await preloadSourceFiles();
        const source = resolveSource(target.source);
        target = { ...target, source: /^file #\d+$/.test(source?.file || '') ? null : source };
      }
      const where = whereLine(target, window.location.pathname);
      // Our layer goes before the picture is taken; the pill says what is happening.
      root.style.display = 'none'; box.style.display = 'none';
      words.textContent = 'Taking the picture…';
      browse.style.display = 'none'; cancel.style.display = 'none';
      let file = null;
      try {
        const boxes = sensitiveRects();
        const frame = await grabAreaFrame(el, rect);
        if (frame) {
          const shots = await makeShots({ frame, rect, vp: { w: window.innerWidth, h: window.innerHeight }, boxes, whole: false, pad: AREA_PAD,
            markup: { items: [{ type: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: '#ef4444', width: 3 }] } });
          if (shots?.element) file = new File([shots.element], `pointed-${Date.now()}.png`, { type: 'image/png' });
        }
      } catch { file = null; }
      done({ file, where, target });
    };
    root.addEventListener('mousemove', onMove);
    root.addEventListener('click', onPick);
    browse.addEventListener('click', (e) => { e.stopPropagation(); mode = mode === 'point' ? 'browse' : 'point'; paint(); });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); done(null); });
    document.addEventListener('keydown', onKey, true);
    paint();
    document.body.append(root, box, pill);
  });
}
