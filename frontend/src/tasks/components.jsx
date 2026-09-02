// Task Module - shared UI atoms (inline-styled to match the export's light theme).
import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronDown, ChevronLeft, ChevronRight, Plus,
  ListTree, MessageSquare, Paperclip, Download, CalendarDays, UserPlus,
  LayoutGrid, List } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, colorForKey, initialsOf, statusChip, priorityChip, btn, chip, STATUS_META, input as inputStyle } from './theme';
import { fmtDate, teamInProject, teamProjectIds } from './lib';
import { rootZoom } from '../lib/utils';
import { matchPeople, onEnterPickFirst } from '../lib/peopleSearch';
import { useTasks } from './TasksContext';
import PersonHover from '../components/PersonHoverCard';
// Photos live in lib/peoplePhotos so the header avatar shares this one cache.
import { usePhotoMap } from '../lib/peoplePhotos';

// `card={false}` opts a call site out of the hover card - for avatars that are
// already inside an interactive row (menu items, pickers), where a second click
// target and a floating card would fight the control they sit in.
export function Avatar({ email, name, size = 26, card = true }) {
  const photos = usePhotoMap();
  const label = name || email || '';
  const photo = email ? photos[email.toLowerCase()] : '';
  const img = photo ? (
    <img src={photo} alt={label} title={card ? undefined : label} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, objectFit: 'cover', display: 'inline-block',
    }} />
  ) : (
    <div title={card ? undefined : label} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: colorForKey(email || label), color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 700,
    }}>{initialsOf(label)}</div>
  );
  // The card carries the name itself, so the native title tooltip is dropped
  // when it is on - two overlapping tooltips otherwise.
  return <PersonHover email={email} name={label} disabled={!card}>{img}</PersonHover>;
}

export function StatusChip({ status }) {
  // Reflect custom statuses (Manage → Custom Statuses) in addition to built-ins.
  const { statusMeta } = useTasks();
  const m = statusMeta?.[status];
  if (m) return <span style={{ ...chip(m.color, m.tint) }}>{m.label}</span>;
  const { label, ...s } = statusChip(status);
  return <span style={s}>{label}</span>;
}
export function PriorityChip({ priority }) {
  const { label, ...s } = priorityChip(priority);
  return <span style={s}>{label}</span>;
}

// Single floating "+" action, styled like the create segment of MobileTaskBar
// (bottom-center pill), for mobile pages that only need one action - no
// filter/view segments. Replaces an inline header "+" so it stays reachable
// one-thumb while scrolled, matching the Task pages' mobile pattern.
export function MobileFab({ onClick, title = 'Create' }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{
      // Every caller (ProjectsView/PortfoliosView/TemplatesView) lives inside
      // the Task module, which now always shows its own bottom tab bar on
      // mobile (MobileNav.jsx's TASK_ACTIONS) - float above it, same as
      // MobileTaskBar.jsx's identical offset.
      position: 'fixed', left: '50%', bottom: 'calc(64px + env(safe-area-inset-bottom) + 18px)', transform: 'translateX(-50%)',
      width: 58, height: 52, borderRadius: 16, border: `1px solid ${NX.border}`,
      background: NX.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 10px 30px rgba(0,0,0,0.22)', zIndex: 2500, cursor: 'pointer', fontFamily: FONT,
    }}><Plus size={22} /></button>
  );
}

export function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 20px', color: NX.dim }}>
      {Icon && <Icon size={34} style={{ color: NX.faint, marginBottom: 12 }} />}
      <div style={{ fontSize: 15, fontWeight: 600, color: NX.ink }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

// Centered modal (portal to body so it isn't clipped by overflow containers).
// `isDirty` + `onSave`: an unintentional exit (overlay click, Escape, the X
// button) used to discard in-progress edits with no warning - the explicit
// footer Cancel button still discards straight away, since that's a deliberate
// choice, but these three are easy to trigger by accident and silently threw
// the edit away (Aug 18 - "when we click outside... it should ask us for
// 'Do you want to save'"). With isDirty unset (the default) a modal behaves
// exactly as before.
export function Modal({ title, onClose, children, footer, width = 'clamp(520px, 60vw, 980px)', isDirty = false, onSave }) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestClose = () => { if (isDirty) setConfirmClose(true); else onClose(); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isDirty]);
  const saveAndClose = async () => {
    if (!onSave) { setConfirmClose(false); onClose(); return; }
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); setConfirmClose(false); }
  };
  return createPortal(
    <div className="nx-tasks-portal" onClick={requestClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '7vh 16px',
      fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderRadius: 16, width, maxWidth: '100%', maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 24px 70px rgba(17,24,39,0.30)', overflow: 'hidden',
        border: `1px solid ${NX.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: `1px solid ${NX.border2}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: NX.ink }}>{title}</div>
          <button onClick={requestClose} style={{ ...btn('ghost'), padding: 6, borderRadius: 8 }} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>{children}</div>
        {footer && <div style={{ padding: '12px 20px', borderTop: `1px solid ${NX.border2}`, background: NX.surface2, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{footer}</div>}
      </div>
      {confirmClose && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: 'fixed', inset: 0, zIndex: 4600, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(17,24,39,0.25)',
        }}>
          <div style={{
            background: NX.surface, borderRadius: 14, width: 340, maxWidth: '90vw', padding: 20,
            boxShadow: '0 24px 70px rgba(17,24,39,0.30)', border: `1px solid ${NX.border}`,
          }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: NX.ink, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 12.5, color: NX.dim, marginBottom: 18, lineHeight: 1.5 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button style={btn('ghost')} onClick={() => setConfirmClose(false)}>Keep Editing</button>
              <button style={btn('ghost')} onClick={onClose}>Discard</button>
              <button style={{ ...btn('primary'), opacity: saving ? 0.6 : 1, pointerEvents: saving ? 'none' : 'auto' }} onClick={saveAndClose}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// Closes a dropdown on an outside click (or Escape) instead of onMouseLeave -
// a panel sits below its trigger with a small gap, so moving the cursor from
// the trigger toward the panel crosses that gap and would close it before it
// can be clicked. Accepts one ref or an array of refs (trigger + portaled panel).
export function useClickOutside(refs, onOutside, active) {
  useEffect(() => {
    if (!active) return;
    const list = Array.isArray(refs) ? refs : [refs];
    const onDown = (e) => { if (list.every((r) => r.current && !r.current.contains(e.target))) onOutside(); };
    const onKey = (e) => { if (e.key === 'Escape') onOutside(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [active, onOutside]);
}

// True on phone-width viewports. Matches the 640px breakpoint the task module's
// CSS uses, so JS-side layout decisions stay in step with the media queries.
export function useIsMobile(query = '(max-width: 640px)') {
  const [match, setMatch] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatch(e.matches);
    setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

// A date field that always READS as mm/dd/yyyy.
//
// A bare <input type="date"> renders in the browser/OS locale (dd-mm-yyyy here),
// and no CSS or attribute can change that. So the value is displayed as our own
// formatted text and the native input is kept, invisible, on top of it - clicks
// still open the OS calendar (showPicker), keyboard and mobile pickers still
// work, and we don't reimplement a calendar.
// ── Nexus calendar picker (replaces the native OS date popup) ────────────────
const CAL_WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CAL_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Years shown per page in the zoomed-out year grid - 12 keeps the same 3x4
// shape as the month grid, so the two levels feel like one control.
const CAL_YEAR_PAGE = 12;
const pad2 = (n) => String(n).padStart(2, '0');
const dateToISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isoToDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const sameYMD = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Popover calendar rendered to a portal, fixed-positioned near the trigger and
// flipped up when there isn't room below - so it works inside modals/sheets too.
function CalendarPopover({ value, onChange, onClose, anchorRect, anchorRef }) {
  const selected = value ? isoToDate(value) : null;
  const today = new Date();
  const [cursor, setCursor] = useState(() => { const b = selected || today; return new Date(b.getFullYear(), b.getMonth(), 1); });
  // Zoom level, iOS-style: days -> months -> years. Clicking the month in the
  // title zooms out to that year's months, clicking the year zooms out to a
  // page of years, and picking one zooms straight back in. Lets you cross
  // years in two clicks instead of paging a month at a time.
  const [zoom, setZoom] = useState('days');
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose, anchorRef]);

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setDate(1 - offset + i); return d; });

  const W = 300, H = 372;
  // anchorRect / innerWidth are in the OUTER space, W and H are CSS lengths in
  // the INNER one - see rootZoom. Scale up to compare, divide the result back.
  const z = rootZoom();
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - W * z - 8)) / z;
  const flipUp = anchorRect.bottom + 6 + H * z > window.innerHeight && anchorRect.top > H * z;
  const vpos = flipUp
    ? { bottom: (window.innerHeight - anchorRect.top + 6) / z }
    : { top: (anchorRect.bottom + 6) / z };
  const navBtn = { ...btn('ghost'), padding: 5, color: NX.dim };
  const linkBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: NX.blue, fontWeight: 600, fontSize: 13, fontFamily: FONT, padding: '4px 6px' };
  // The title reads as text until hovered - it is a zoom-out control, but a
  // calendar header that looks like a button is noisier than one that behaves
  // like one only when reached for.
  const titleBtn = { background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 14, fontWeight: 700, color: NX.ink, padding: '3px 6px', borderRadius: 7, whiteSpace: 'nowrap' };
  const cellBtn = { height: 46, borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT };

  // Year pages are aligned to fixed blocks so paging is stable - the same year
  // always sits in the same page rather than the grid re-centering on cursor.
  const yearStart = Math.floor(cursor.getFullYear() / CAL_YEAR_PAGE) * CAL_YEAR_PAGE;
  // The arrows step whatever the current zoom shows: a month, a year, or a
  // whole page of years.
  const step = (dir) => setCursor((c) => (
    zoom === 'days' ? new Date(c.getFullYear(), c.getMonth() + dir, 1)
      : zoom === 'months' ? new Date(c.getFullYear() + dir, c.getMonth(), 1)
      : new Date(c.getFullYear() + dir * CAL_YEAR_PAGE, c.getMonth(), 1)
  ));
  const stepLabel = (dir) => {
    const unit = zoom === 'days' ? 'month' : zoom === 'months' ? 'year' : 'years';
    return `${dir < 0 ? 'Previous' : 'Next'} ${unit}`;
  };

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', left, width: W, ...vpos, background: NX.surface, border: `1px solid ${NX.border}`,
      borderRadius: 14, boxShadow: '0 16px 44px rgba(0,0,0,0.22)', zIndex: 5000, padding: 14, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {zoom === 'days' && (
            <button onClick={() => setZoom('months')} style={titleBtn} title="Pick a month">{CAL_MONTHS[cursor.getMonth()]}</button>
          )}
          <button onClick={() => setZoom(zoom === 'years' ? 'days' : 'years')} style={titleBtn}
            title={zoom === 'years' ? 'Back to days' : 'Pick a year'}>
            {zoom === 'years' ? `${yearStart} - ${yearStart + CAL_YEAR_PAGE - 1}` : cursor.getFullYear()}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => step(-1)} style={navBtn} aria-label={stepLabel(-1)}><ChevronLeft size={18} /></button>
          <button onClick={() => step(1)} style={navBtn} aria-label={stepLabel(1)}><ChevronRight size={18} /></button>
        </div>
      </div>

      {zoom === 'days' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', marginBottom: 4 }}>
            {CAL_WEEK.map((w) => <div key={w} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: NX.faint, padding: '4px 0' }}>{w}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
            {days.map((d, i) => {
              const inMonth = d.getMonth() === cursor.getMonth();
              const isToday = sameYMD(d, today);
              const isSel = sameYMD(d, selected);
              return (
                <button key={i} onClick={() => { onChange(dateToISO(d)); onClose(); }} style={{
                  height: 36, borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13,
                  fontWeight: (isSel || isToday) ? 700 : 500, fontFamily: FONT,
                  background: isSel ? NX.primary : 'transparent',
                  color: isSel ? '#fff' : (inMonth ? NX.ink : NX.faint),
                  boxShadow: isToday && !isSel ? `inset 0 0 0 1.5px ${NX.blue}` : 'none',
                }}>{d.getDate()}</button>
              );
            })}
          </div>
        </>
      )}

      {zoom === 'months' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
          {CAL_MONTHS_SHORT.map((label, i) => {
            const isNow = today.getFullYear() === cursor.getFullYear() && today.getMonth() === i;
            const isSel = !!selected && selected.getFullYear() === cursor.getFullYear() && selected.getMonth() === i;
            return (
              <button key={label} onClick={() => { setCursor(new Date(cursor.getFullYear(), i, 1)); setZoom('days'); }}
                style={{ ...cellBtn, background: isSel ? NX.primary : 'transparent', color: isSel ? '#fff' : NX.ink,
                  boxShadow: isNow && !isSel ? `inset 0 0 0 1.5px ${NX.blue}` : 'none' }}>{label}</button>
            );
          })}
        </div>
      )}

      {zoom === 'years' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
          {Array.from({ length: CAL_YEAR_PAGE }, (_, i) => yearStart + i).map((y) => {
            const isNow = today.getFullYear() === y;
            const isSel = !!selected && selected.getFullYear() === y;
            return (
              <button key={y} onClick={() => { setCursor(new Date(y, cursor.getMonth(), 1)); setZoom('months'); }}
                style={{ ...cellBtn, background: isSel ? NX.primary : 'transparent', color: isSel ? '#fff' : NX.ink,
                  boxShadow: isNow && !isSel ? `inset 0 0 0 1.5px ${NX.blue}` : 'none' }}>{y}</button>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, borderTop: `1px solid ${NX.border2}`, paddingTop: 8 }}>
        <button onClick={() => { onChange(null); onClose(); }} style={linkBtn}>Clear</button>
        <button onClick={() => { onChange(dateToISO(today)); onClose(); }} style={linkBtn}>Today</button>
      </div>
    </div>,
    document.body,
  );
}

// `compact` = a table/list cell rather than a form field (My Tasks, the rich
// Task List, the Task Detail drawer's Due Date row, Data Quality): an unset
// date shows Asana's own empty-state - a calendar glyph inside a dashed
// circle, clickable to set one - instead of a text placeholder + separate
// icon. A date once set shows as plain text, same as before. Form inputs
// (Create/Edit Task, filters, recurrence end date) keep the old look, since a
// tiny circle reads as broken sitting inside a full-width boxed field.
export function DateField({ value, onChange, placeholder = '-', color, style, title, disabled, compact = false }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const openCal = () => {
    if (disabled) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) { setRect(r); setOpen(true); }
  };
  const toggle = (e) => { if (disabled) return; e.stopPropagation(); open ? setOpen(false) : openCal(); };

  if (compact && !value) {
    return (
      <span style={{ position: 'relative', display: 'inline-flex', ...style }}>
        <button ref={btnRef} type="button" title={title || 'Set date'} disabled={disabled} onClick={toggle}
          style={{
            width: 24, height: 24, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
            background: 'transparent', color: NX.faint, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, cursor: disabled ? 'default' : 'pointer', flexShrink: 0,
          }}
        ><CalendarDays size={13} strokeWidth={2} /></button>
        {open && rect && <CalendarPopover value={value} onChange={onChange} onClose={() => setOpen(false)} anchorRect={rect} anchorRef={btnRef} />}
      </span>
    );
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, ...style }}>
      <button
        ref={btnRef} type="button" title={title || 'Set date'} disabled={disabled}
        onClick={toggle}
        style={{
          flex: 1, textAlign: 'left', border: 'none', background: 'transparent', padding: 0, margin: 0, cursor: disabled ? 'default' : 'pointer',
          fontFamily: FONT, fontSize: 'inherit', fontWeight: 'inherit', whiteSpace: 'nowrap',
          color: color || (value ? NX.ink : NX.faint),
        }}
      >{value ? fmtDate(value) : placeholder}</button>
      {!(compact && value) && (
        <CalendarDays
          size={15} strokeWidth={2} color={NX.faint}
          style={{ flexShrink: 0, cursor: disabled ? 'default' : 'pointer' }}
          onClick={toggle}
        />
      )}
      {open && rect && <CalendarPopover value={value} onChange={onChange} onClose={() => setOpen(false)} anchorRect={rect} anchorRef={btnRef} />}
    </span>
  );
}

// Loads the Nexus People directory once (deduped in api.js) → [{email,name}] for pickers.
// The curated Nexus People list. `includeExternal` adds guest/external
// identities, which the directory withholds by default - a task's Assignee and
// Collaborators offer them (Sagar, Sept 2 2026: externals do the work and need
// to be on it), while every other picker in the module keeps the staff-only
// list. `external: true` rides along so a picker can label them.
export function usePeople(includeExternal = false) {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory(includeExternal).then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({
        email: (u.email || '').toLowerCase(),
        name: u.name || u.display_name || u.email,
        external: !!u.external,
      })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, [includeExternal]);
  return people;
}

// "Nobody yet", in the shape of an avatar: a dashed circle with a person-plus
// inside - the same dashed-circle-plus the Collaborators row uses to ADD
// someone, which is exactly what this cell is inviting (Sagar, Sept 2 2026).
// It replaces both the empty cell in the task lists (which read as data still
// loading) and the word "Unassigned" in the ticket list, so an unassigned row
// looks the same everywhere and lines up with the avatars above and below it.
export function UnassignedAvatar({ size = 24, title = 'Unassigned' }) {
  return (
    <span title={title} aria-label={title} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      border: `1.5px dashed ${NX.border}`, color: NX.faint, boxSizing: 'border-box',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}><UserPlus size={Math.round(size * 0.5)} /></span>
  );
}

// The badge on a guest/external identity wherever one can be picked. Small and
// quiet - it labels the row, it isn't a warning.
export function ExternalTag() {
  return (
    <span style={{
      flexShrink: 0, fontSize: 10, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase',
      color: NX.amber, background: 'rgba(217,119,6,0.14)', borderRadius: 5, padding: '1px 5px',
    }}>External</span>
  );
}

// A compact dropdown that picks a person (email) from the directory.
// Prettify an email into a display name when the person isn't in the loaded
// directory: "sagar.shoundik@greensglobal.com" → "Sagar Shoundik".
function emailToName(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return email || '';
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || email;
}

// Mirrors task_util.PROJECT_ROLE_RANK - a role only ever implies everything
// ranked below it. Labels/descriptions match Asana's own Share dialog exactly
// (per the reference screenshots) so this reads as a direct parity build.
export const PROJECT_ROLES = {
  owner:     { label: 'Project admin', rank: 4, description: 'Can change settings, modify, or delete the project.' },
  editor:    { label: 'Editor',        rank: 3, description: 'Can add, edit, and delete anything in the project.' },
  commenter: { label: 'Commenter',     rank: 2, description: "Can comment, but can't edit anything in the project." },
  viewer:    { label: 'Viewer',        rank: 1, description: "Can view, but can't add comments or edit the project." },
};
const PROJECT_ROLE_ORDER = ['owner', 'editor', 'commenter', 'viewer'];

// Rendered to a portal, fixed-positioned against the trigger's own rect -
// same technique as CalendarPopover above. The plain-nested-dropdown version
// got clipped by the Share modal's "Who has access" list, which needs its own
// overflow-y:auto scrollbar; a position:absolute child can never escape that.
function RolePickerPanel({ anchorRect, value, onChange, onClose }) {
  const ref = useRef(null);
  useClickOutside(ref, onClose, true);
  const W = 260, H = 260;
  // Same outer/inner split as CalendarPopover above - see rootZoom.
  const z = rootZoom();
  const left = Math.max(8, Math.min(anchorRect.right - W * z, window.innerWidth - W * z - 8)) / z;
  const flipUp = anchorRect.bottom + 6 + H * z > window.innerHeight && anchorRect.top > H * z;
  const vpos = flipUp
    ? { bottom: (window.innerHeight - anchorRect.top + 6) / z }
    : { top: (anchorRect.bottom + 6) / z };
  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', left, width: W, ...vpos, background: NX.surface,
      border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
      zIndex: 4100, padding: 6, fontFamily: FONT,
    }}>
      {PROJECT_ROLE_ORDER.map((key) => (
        <div key={key} onClick={() => { onChange(key); onClose(); }}
          style={{ display: 'flex', gap: 8, padding: '7px 8px', borderRadius: 8, cursor: 'pointer',
                  background: key === value ? NX.hover : 'transparent' }}>
          <div style={{ width: 16, flexShrink: 0, paddingTop: 1 }}>{key === value && <Check size={14} style={{ color: NX.blue }} />}</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{PROJECT_ROLES[key].label}</div>
            <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 1 }}>{PROJECT_ROLES[key].description}</div>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// Per-person/per-team role dropdown for the Share panel - same shape as
// Asana's (label + one-line description, checkmark on the current value).
function RolePicker({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const meta = PROJECT_ROLES[value] || PROJECT_ROLES.editor;
  const toggle = () => {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) { setRect(r); setOpen(true); }
  };
  return (
    <>
      <button ref={btnRef} type="button" disabled={disabled} onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
                cursor: disabled ? 'default' : 'pointer', fontFamily: FONT, fontSize: 13,
                color: disabled ? NX.faint : NX.ink, padding: '4px 6px' }}>
        {meta.label}{!disabled && <ChevronDown size={13} style={{ color: NX.faint }} />}
      </button>
      {open && rect && (
        <RolePickerPanel anchorRect={rect} value={value} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// Full "Share" dialog - Asana parity: invite by email with a role, an
// Searchable team picker for the Share panel. PersonSelect is people-shaped
// (email is its key, it renders an Avatar) and is used in eight other places, so
// teams get their own small control rather than a risky generalization.
function TeamPicker({ teams, value, onChange, placeholder = 'Add a team…' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const chosen = teams.find((t) => t.id === value) || null;
  const shown = q ? teams.filter((t) => (t.name || '').toLowerCase().includes(q.toLowerCase())) : teams;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {chosen && <span style={{ width: 9, height: 9, borderRadius: 3, background: chosen.color || NX.dim, flexShrink: 0 }} />}
          <span style={{ color: chosen ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {chosen ? chosen.name : placeholder}
          </span>
        </span>
        <ChevronDown size={15} style={{ color: NX.faint }} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={() => setOpen(false)}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teams…"
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {shown.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>No teams match.</div>}
          {shown.map((t) => (
            <div key={t.id} onClick={() => { onChange(t.id); setOpen(false); setQ(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: t.color || NX.dim, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              <span style={{ fontSize: 11.5, color: NX.faint }}>{(t.memberIds || []).length} people</span>
            </div>
          ))}
        </SelectMenu>
      )}
    </div>
  );
}

// org-wide/private toggle, and a "Who has access" list (owner fixed, each
// individual member and each project-scoped Team with its own role dropdown
// + remove). Roles are ENFORCED server-side (task_util.require_project_role),
// not cosmetic - a non-owner's edits here will 403; PermissionError below
// surfaces that inline instead of failing silently.
function ShareProjectModal({ project, teams, people, onClose }) {
  const { updateProject, updateTeam } = useTasks();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [inviteTeam, setInviteTeam] = useState('');
  const [teamRole, setTeamRole] = useState('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  const ownerEmail = (project.ownerId || '').toLowerCase();
  const memberRoles = project.memberRoles || {};
  const memberEmails = (project.memberIds || []).filter((em) => em.toLowerCase() !== ownerEmail);
  const projectTeams = (teams || []).filter((t) => teamInProject(t, project.id));

  const run = async (fn) => {
    setError(''); setBusy(true);
    try { await fn(); }
    catch (e) { setError(e?.message || 'That action needs Project admin access.'); }
    finally { setBusy(false); }
  };

  const setMemberRole = (email, role) => run(() =>
    updateProject(project.id, { member_roles: { ...memberRoles, [email]: role } }));

  const removeMember = (email) => run(() => {
    const nextRoles = { ...memberRoles };
    delete nextRoles[email];
    return updateProject(project.id, {
      member_roles: nextRoles,
      member_emails: (project.memberIds || []).filter((em) => em !== email),
    });
  });

  const setTeamRoleFor = (team, role) => run(() => updateTeam(team.id, { access_role: role }));

  // Granting a team access = adding this project to the team's project list.
  // Teams the project already has are filtered out of the picker, so the same
  // team can't be added twice.
  const availableTeams = (teams || []).filter((t) => !teamInProject(t, project.id));
  const addTeam = () => {
    const team = availableTeams.find((t) => t.id === inviteTeam);
    if (!team) return;
    run(async () => {
      await updateTeam(team.id, {
        project_ids: [...teamProjectIds(team), project.id],
        access_role: teamRole,
      });
      setInviteTeam('');
    });
  };
  // Drop THIS project only. Sending project_id:'' would clear the team's whole
  // project list, so removing IT from one project would silently revoke it from
  // every other project it serves.
  const removeTeam = (team) => run(() => updateTeam(team.id, {
    project_ids: teamProjectIds(team).filter((id) => id !== project.id),
  }));

  const invite = () => {
    const email = (inviteEmail || '').trim().toLowerCase();
    if (!email) return;
    run(async () => {
      await updateProject(project.id, { member_roles: { ...memberRoles, [email]: inviteRole } });
      setInviteEmail('');
    });
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(window.location.href).catch(() => {});
  };

  return (
    <Modal title={`Share ${project.name}`} onClose={onClose} width={480}>
      {error && (
        <div style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626', fontSize: 12.5, padding: '8px 10px',
                     borderRadius: 8, marginBottom: 14 }}>{error}</div>
      )}

      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Invite With Email</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <PersonSelect value={inviteEmail} onChange={(em) => setInviteEmail(em || '')}
            people={people} placeholder="Add people from Nexus…" />
        </div>
        <RolePicker value={inviteRole} onChange={setInviteRole} />
        <button type="button" disabled={busy || !inviteEmail} onClick={invite} style={btn('primary')}>Invite</button>
      </div>

      {/* Teams get access as a unit - everyone on the team inherits it, which is
          how a whole department is granted a project in one step instead of
          inviting each person. */}
      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Add a Team</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <TeamPicker teams={availableTeams} value={inviteTeam} onChange={setInviteTeam}
            placeholder={availableTeams.length ? 'Search teams…' : 'Every team already has access'} />
        </div>
        <RolePicker value={teamRole} onChange={setTeamRole} />
        <button type="button" disabled={busy || !inviteTeam} onClick={addTeam} style={btn('primary')}>Add</button>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Access Settings</div>
      <select value={project.accessLevel || 'org'} disabled={busy}
        onChange={(e) => run(() => updateProject(project.id, { access_level: e.target.value }))}
        style={{ ...inputStyle, width: '100%', marginBottom: 16 }}>
        <option value="restricted">Private - only people/teams listed below</option>
        <option value="org">Org-wide - everyone at Nexus can see this project</option>
      </select>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Who Has Access</span>
      </div>
      <div className="nx-scroll" style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderBottom: `1px solid ${NX.border}` }}>
          <Avatar email={ownerEmail} name={personFor(ownerEmail).name} size={26} />
          <span style={{ flex: 1, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {personFor(ownerEmail).name}
          </span>
          <span style={{ fontSize: 13, color: NX.faint, padding: '4px 6px' }}>Project admin</span>
        </div>
        {projectTeams.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderBottom: `1px solid ${NX.border}` }}>
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: NX.surface2, flexShrink: 0,
                         display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: NX.dim }}>
              {t.name?.[0]?.toUpperCase() || 'T'}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              <div style={{ fontSize: 11.5, color: NX.faint }}>{(t.memberIds || []).length} people</div>
            </div>
            <RolePicker value={t.accessRole || 'editor'} onChange={(r) => setTeamRoleFor(t, r)} disabled={busy} />
            <button type="button" disabled={busy} onClick={() => removeTeam(t)} title="Remove team from this project"
              style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><X size={14} /></button>
          </div>
        ))}
        {memberEmails.map((em) => (
          <div key={em} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderBottom: `1px solid ${NX.border}` }}>
            <Avatar email={em} name={personFor(em).name} size={26} />
            <span style={{ flex: 1, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {personFor(em).name}
            </span>
            <RolePicker value={memberRoles[em] || 'editor'} onChange={(r) => setMemberRole(em, r)} disabled={busy} />
            <button type="button" disabled={busy} onClick={() => removeMember(em)} title="Remove access"
              style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><X size={14} /></button>
          </div>
        ))}
        {!projectTeams.length && !memberEmails.length && (
          <div style={{ padding: '14px 10px', fontSize: 12.5, color: NX.faint, textAlign: 'center' }}>
            Only the project admin has access so far.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={copyLink} style={btn('outline')}>Copy project link</button>
      </div>
    </Modal>
  );
}

// "Who has access" - the avatar-stack trigger in the project header, mirroring
// Asana's Share button/dialog. Sourced from the same three grants
// task_util.visible_project_ids() actually reads (owner, TaskProject.member_
// emails, TaskTeam rosters), so the stack is never wrong about who can see the
// project - clicking it opens the full editable Share panel (ShareProjectModal).
export function ProjectAccessButton({ project, teams, people }) {
  const [shareOpen, setShareOpen] = useState(false);
  if (!project) return null;
  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  const ownerEmail = (project.ownerId || '').toLowerCase();
  const memberEmails = Array.isArray(project.memberIds) ? project.memberIds : [];
  const projectTeams = (teams || []).filter((t) => teamInProject(t, project.id));
  const allEmails = Array.from(new Set(
    [ownerEmail, ...memberEmails, ...projectTeams.flatMap((t) => t.memberIds || [])].filter(Boolean)
  ));
  const stackShown = allEmails.slice(0, 3);
  const overflow = allEmails.length - stackShown.length;
  return (
    <>
      <button type="button" onClick={() => setShareOpen(true)} title="Share - manage who has access"
        style={{ display: 'flex', alignItems: 'center', background: 'none', border: `1px solid ${NX.border}`, borderRadius: 20, padding: '3px 8px 3px 3px', cursor: 'pointer', fontFamily: FONT }}>
        <span style={{ display: 'flex' }}>
          {stackShown.map((em, i) => (
            <span key={em} style={{ marginLeft: i === 0 ? 0 : -8, display: 'flex', border: `2px solid ${NX.surface}`, borderRadius: '50%' }}>
              <Avatar email={em} name={personFor(em).name} size={24} />
            </span>
          ))}
        </span>
        {overflow > 0 && <span style={{ marginLeft: 6, fontSize: 12, color: NX.dim, fontWeight: 600 }}>+{overflow}</span>}
        <span style={{ marginLeft: stackShown.length ? 6 : 0, fontSize: 12.5, color: NX.dim, fontWeight: 600 }}>Share</span>
      </button>
      {shareOpen && (
        <ShareProjectModal project={project} teams={teams} people={people} onClose={() => setShareOpen(false)} />
      )}
    </>
  );
}

// Menu panel shared by the three select controls below. Rendered in a PORTAL at
// fixed coordinates rather than absolutely inside the field: an absolutely
// positioned panel is clipped by whatever scroll container it lives in, which
// is why the Members search results in the Create-a-Team modal were invisible
// until you scrolled the modal (Sagar, Aug 26). Flips above the field when
// there is no room below, and caps its height to the space actually there.
// It also owns dismissal - a click inside a portal is NOT inside the field's
// own ref, so each field cannot judge "outside" for itself any more.
function SelectMenu({ anchorRef, onClose, children, minWidth = 0 }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      // anchor rect / innerHeight are in the OUTER space, CSS lengths in the
      // INNER one - see rootZoom (same dance as CalendarPopover).
      const z = rootZoom();
      const GAP = 4, EDGE = 8, MAX = 280;
      const below = window.innerHeight - a.bottom - GAP - EDGE;
      const above = a.top - GAP - EDGE;
      const up = below < above && below < MAX * z;
      // A menu is at least as wide as its trigger, and at least `minWidth` -
      // a narrow trigger (the bulk bar's "Assign...") would otherwise hand its
      // own width to the menu and truncate every name to "Ash Ben...".
      // Then kept inside the viewport: widening rightwards off-screen would
      // trade one unreadable menu for another.
      const room = window.innerWidth / z - EDGE * 2;
      const width = Math.min(Math.max(a.width / z, minWidth), room);
      const left = Math.max(EDGE / z, Math.min(a.left / z, window.innerWidth / z - EDGE / z - width));
      setPos({
        left, width,
        maxHeight: Math.max(140, Math.min(MAX, (up ? above : below) / z)),
        ...(up ? { bottom: (window.innerHeight - a.top + GAP) / z } : { top: (a.bottom + GAP) / z }),
      });
    };
    place();
    // Capture phase so the modal's own scroll container re-places it too.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef, minWidth]);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose, anchorRef]);
  if (!pos) return null;
  return createPortal(
    <div ref={ref} className="nx-scroll" style={{
      position: 'fixed', left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
      ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
      background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10,
      boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 5000, overflowY: 'auto', fontFamily: FONT,
    }}>
      {children}
    </div>,
    document.body,
  );
}

export function PersonSelect({ value, onChange, people, placeholder = 'Unassigned', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const sel = people.find((p) => p.email === value);
  // A value can be set to someone not in the loaded directory (e.g. the current
  // user before the People directory has loaded / when it's empty). Still show
  // them - derive a display name from the email - rather than the placeholder.
  const chosen = sel || (value ? { email: value, name: emailToName(value) } : null);
  const filtered = matchPeople(people, q);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {chosen ? <Avatar email={chosen.email} name={chosen.name} size={20} card={false} /> : null}
          <span style={{ color: chosen ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis' }}>{chosen ? chosen.name : placeholder}</span>
        </span>
        <ChevronDown size={15} style={{ color: NX.faint }} />
      </button>
      {open && !disabled && (
        <SelectMenu anchorRef={ref} onClose={() => setOpen(false)}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
            onKeyDown={onEnterPickFirst(filtered, (p) => { onChange(p.email); setOpen(false); })}
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          <div onClick={() => { onChange(null); setOpen(false); }} style={{ padding: '8px 12px', fontSize: 13, color: NX.dim, cursor: 'pointer' }}>Unassigned</div>
          {filtered.map((p) => (
            <div key={p.email} onClick={() => { onChange(p.email); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: p.email === value ? NX.hover : 'transparent' }}>
              <Avatar email={p.email} name={p.name} size={22} card={false} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {p.email === value && <Check size={14} style={{ color: NX.blue }} />}
            </div>
          ))}
        </SelectMenu>
      )}
    </div>
  );
}

// Multi-select sibling of PersonSelect - same directory, search and avatars, but
// picks stay selected and the menu stays open so several people can be added in
// one go. `value` is an array of emails; onChange receives a new array.
export function PersonMultiSelect({ value, onChange, people, placeholder = 'Select people', addTitle = 'Add people' }) {
  const [open, setOpen] = useState(false);
  // Phones: the menu is a panel over the form, so it hides the very field it
  // just wrote to - close it once a name is picked. Desktop keeps it open,
  // where it sits beside the field and adding three people in a row is the
  // point of a multi-select.
  const isMobile = useIsMobile();
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const queryRef = useRef(null);
  const emails = Array.isArray(value) ? value : [];
  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  // Unfiltered (no query) still wants A-Z, so it's the flat directory order,
  // not "first name prefix" ranking - matchPeople only ranks when there's a
  // query to rank against; the alphabetical fallback lives here.
  const filtered = q ? matchPeople(people, q)
    : people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' }));
  const toggle = (em) => onChange(emails.includes(em) ? emails.filter((x) => x !== em) : [...emails, em]);
  // Removing a chip leaves the menu up - you're still editing the list; only
  // adding a name is the "done, get out of the way" moment.
  const pick = (em) => {
    const adding = !emails.includes(em);
    toggle(em);
    if (!adding) return;
    // The name is on the trigger now, so the query that found it is spent -
    // clear it (and take focus back) so the next name can just be typed.
    setQ('');
    if (isMobile) setOpen(false);
    else queryRef.current?.focus();
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', height: 'auto', minHeight: 36, padding: '5px 10px' }}>
        {/* Chips scroll past ~3 rows rather than growing the field without bound -
            in a narrow grid column each chip takes its own row. */}
        <span className="nx-scroll" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
          {emails.length === 0 && <span style={{ color: NX.faint }}>{placeholder}</span>}
          {emails.map((em) => {
            const p = personFor(em);
            return (
              <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 7px 2px 2px', fontSize: 12, color: NX.ink }}>
                <Avatar email={p.email} name={p.name} size={18} card={false} />
                {p.name}
                {/* A span, not a button - this sits inside the dropdown trigger button. */}
                <span role="button" tabIndex={0} title={`Remove ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); toggle(em); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggle(em); } }}
                  style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint }}>
                  <X size={11} />
                </span>
              </span>
            );
          })}
          {/* The same dashed person-plus the Collaborators row uses. "Add
              another one of these" is what people look for after a chip; the
              chevron alone reads as "replace", not "add" (Sagar, Aug 26).
              A span, not a button - it sits inside the dropdown trigger, and
              its click opens that same menu. */}
          <span role="button" tabIndex={0} title={addTitle} aria-label={addTitle}
            onClick={(e) => { e.stopPropagation(); setOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setOpen(true); } }}
            style={{
              width: 22, height: 22, borderRadius: '50%', border: `1.5px dashed ${NX.border}`,
              color: NX.faint, cursor: 'pointer', flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <UserPlus size={12} />
          </span>
        </span>
        <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={() => setOpen(false)}>
          <input ref={queryRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…"
            onKeyDown={onEnterPickFirst(filtered, (p) => pick(p.email))}
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {filtered.map((p) => {
            const on = emails.includes(p.email);
            return (
              <div key={p.email} onClick={() => pick(p.email)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: on ? NX.hover : 'transparent' }}>
                <Avatar email={p.email} name={p.name} size={22} card={false} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {/* Externals are offered here, so say which they are - putting a
                    partner on a task is a different decision from putting a
                    colleague on it. */}
                {p.external && <ExternalTag />}
                {on && <Check size={14} style={{ color: NX.blue }} />}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>
              {q ? `No people match “${q}”.` : 'No people in the directory.'}
            </div>
          )}
        </SelectMenu>
      )}
    </div>
  );
}

// A one-shot searchable picker: the trigger always shows its placeholder and
// picking fires `onPick` rather than storing a value. Built for the bulk-action
// bar, whose "Assign..." and "Move To..." were native <select>s - fine at ten
// options, unusable at the ~150 people and ~90 projects a real workspace has,
// where finding one meant scrolling a list you cannot type into.
//
// Options are `{ id, label }`; `keywords` on an option adds extra searchable
// text (an email, say) that is matched but not displayed. An option marked
// `header: true` is a group caption instead: it renders as a small label, is
// not clickable, and drops out of a search (its members carry their own
// searchable text, and a caption left stranded above no results reads as a
// group that came back empty).
export function SearchSelect({
  options, onPick, placeholder = 'Select...', searchPlaceholder = 'Search...',
  emptyText = 'Nothing to choose from.', buttonStyle, renderOption, menuMinWidth = 260,
  value,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const query = q.trim().toLowerCase();
  const shown = query
    ? options.filter((o) => !o.header && `${o.label || ''} ${o.keywords || ''}`.toLowerCase().includes(query))
    : options;
  const close = () => { setOpen(false); setQ(''); };
  // Two roles in one control. Given `value` it is a FIELD: the trigger shows
  // the current selection and a tick marks it in the list. Without one it is a
  // COMMAND (the bulk bar's "Assign..."), whose trigger always reads as its
  // placeholder because nothing stays selected.
  const chosen = value !== undefined ? options.find((o) => o.id === value) : null;
  const label = value !== undefined ? (chosen?.label || placeholder) : placeholder;
  const muted = value !== undefined && !chosen;
  return (
    // minWidth:0 on the wrapper as well as the label: dropped into a flex or
    // grid cell (the task table's Project column) this div is the flex item,
    // and an item that will not shrink past its content painted a long project
    // name straight over the Due Date column.
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" onClick={() => (open ? close() : setOpen(true))}
        title={typeof label === 'string' ? label : undefined}
        style={{ ...btn('outline'), justifyContent: 'space-between', gap: 8, overflow: 'hidden', fontWeight: value !== undefined ? 400 : undefined, ...buttonStyle }}>
        {/* minWidth:0 is what actually lets the label ellipsis: a flex child
            floors at its content width without it, so a long project name
            spilled out of a table cell and over the next column instead. */}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted ? NX.faint : undefined }}>{label}</span>
        <ChevronDown size={15} style={{ flexShrink: 0, opacity: 0.75 }} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={close} minWidth={menuMinWidth}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder}
            style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {shown.map((o) => (o.header ? (
            <div key={o.id} style={{
              padding: '9px 12px 4px', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em',
              textTransform: 'uppercase', color: NX.faint, cursor: 'default', userSelect: 'none',
            }}>{o.label}</div>
          ) : (
            <div key={o.id} onClick={() => { onPick(o.id); close(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink }}
              onMouseEnter={(e) => { e.currentTarget.style.background = NX.hover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              {renderOption ? renderOption(o) : (
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              )}
              {value !== undefined && o.id === value && <Check size={14} style={{ color: NX.blue, flexShrink: 0 }} />}
            </div>
          )))}
          {shown.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>
              {query ? `No matches for “${q.trim()}”.` : emptyText}
            </div>
          )}
        </SelectMenu>
      )}
    </div>
  );
}

// Generic sibling of PersonMultiSelect for non-people options (projects, tags…).
// Same grammar - chips in the trigger, a searchable checkbox menu below - so a
// long list collapses to one control instead of a scrolling wall of checkboxes
// that pushes the rest of a modal off screen.
// `options` is [{ id, label }]; `value`/`onChange` are arrays of ids.
export function ChipMultiSelect({ value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Search…', emptyText = 'Nothing to choose from.' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const ids = Array.isArray(value) ? value : [];
  const labelFor = (id) => options.find((o) => o.id === id)?.label || id;
  const filtered = q ? options.filter((o) => (o.label || '').toLowerCase().includes(q.toLowerCase())) : options;
  const toggle = (id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', height: 'auto', minHeight: 36, padding: '5px 10px', textAlign: 'left' }}>
        <span className="nx-scroll" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
          {ids.length === 0 && <span style={{ color: NX.faint, fontWeight: 400 }}>{placeholder}</span>}
          {ids.map((id) => (
            <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 7px', fontSize: 12, color: NX.ink, maxWidth: '100%' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelFor(id)}</span>
              {/* A span, not a button - this sits inside the dropdown trigger button. */}
              <span role="button" tabIndex={0} title={`Remove ${labelFor(id)}`}
                onClick={(e) => { e.stopPropagation(); toggle(id); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggle(id); } }}
                style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint, flexShrink: 0 }}>
                <X size={11} />
              </span>
            </span>
          ))}
        </span>
        <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
      {open && (
        <SelectMenu anchorRef={ref} onClose={() => setOpen(false)}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {filtered.map((o) => {
            const on = ids.includes(o.id);
            return (
              <div key={o.id} onClick={() => toggle(o.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: on ? NX.hover : 'transparent' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                {on && <Check size={14} style={{ color: NX.blue, flexShrink: 0 }} />}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>
              {q ? `No matches for “${q}”.` : emptyText}
            </div>
          )}
        </SelectMenu>
      )}
    </div>
  );
}

// ── Task count badges ────────────────────────────────────────────────────────
// Subtasks, comments and attachments as icon + count, shown only when there is
// something to show. Shared so every list speaks the same badge language: the
// Task List had these and My Tasks did not, so the same task looked emptier
// depending on which screen you opened it from.
//
// A count of zero renders nothing rather than a "0" - a row of zeroes is noise
// on the majority of tasks, and their absence is already the answer.
export function TaskCountBadges({ t, store, size = 12 }) {
  const subs = (t.subtaskIds || [])
    .map((id) => store?.taskById?.[id] || store?.tasks?.find((x) => x.id === id))
    .filter(Boolean);
  const subsDone = subs.filter((s) => s.completed).length;
  const comments = (t.commentIds || []).length;
  const files = (t.attachmentIds || []).length;
  if (!subs.length && !comments && !files) return null;

  const badge = { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: NX.faint, flexShrink: 0 };
  return (
    <>
      {subs.length > 0 && (
        <span title={`${subsDone}/${subs.length} subtasks done`} style={{ ...badge, gap: 4 }}>
          <ListTree size={size} />{subsDone}/{subs.length}
        </span>
      )}
      {comments > 0 && (
        <span title={`${comments} comment${comments === 1 ? '' : 's'}`} style={badge}>
          <MessageSquare size={size} />{comments}
        </span>
      )}
      {files > 0 && (
        <span title={`${files} attachment${files === 1 ? '' : 's'}`} style={badge}>
          <Paperclip size={size} />{files}
        </span>
      )}
    </>
  );
}

// ── Attachment viewer ────────────────────────────────────────────────────────
// In-app viewer (ported from the tickets module): images, videos and PDFs open
// over the drawer instead of a new tab; files with no inline renderer (docx,
// xlsx…) get a clean download card rather than a broken embed. Escape is
// captured so it closes the viewer without also closing the drawer underneath.
// Older rows only carry kind image/doc, so the renderer also sniffs the file
// extension to give videos and PDFs their proper treatment.
export function AttachmentViewer({ att, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  if (!att) return null;
  const probe = `${att.name || ''} ${att.url || ''}`;
  const isPdf = /\.pdf($|\?)/i.test(probe);
  const isVideo = att.kind === 'video' || /\.(mp4|webm|mov|m4v)($|\?)/i.test(probe);
  const isImage = att.kind === 'image' || /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(probe);
  const body = isImage ? (
    <img src={att.url} alt={att.name} style={{ maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8 }} />
  ) : isVideo ? (
    <video src={att.url} controls autoPlay style={{ maxWidth: '92vw', maxHeight: '78vh', borderRadius: 8, background: '#000' }} />
  ) : isPdf ? (
    <iframe src={att.url} title={att.name} style={{ width: '92vw', height: '78vh', border: 'none', borderRadius: 8, background: '#fff' }} />
  ) : (
    <div onClick={(e) => e.stopPropagation()} style={{ background: NX.surface, borderRadius: 14, padding: '34px 44px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, maxWidth: '86vw' }}>
      <Paperclip size={30} style={{ color: NX.faint }} />
      <div style={{ fontSize: 14.5, fontWeight: 700, color: NX.ink, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
      <div style={{ fontSize: 12.5, color: NX.dim }}>No inline preview for this file type.</div>
      <a href={att.url} download={att.name} style={{ ...btn('primary'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Download size={14} /> Download
      </a>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 5500, background: 'rgba(9,14,11,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONT }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 20px', color: '#fff' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
        <span style={{ fontSize: 12, opacity: 0.65 }}>{att.size}</span>
        <span style={{ flex: 1 }} />
        {att.url && <a href={att.url} download={att.name} title="Download" style={{ color: '#fff', opacity: 0.8, display: 'flex' }}><Download size={16} /></a>}
        <button onClick={onClose} aria-label="Close viewer" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff', display: 'flex', padding: 4 }}><X size={19} /></button>
      </div>
      <div onClick={(e) => e.stopPropagation()}>{body}</div>
    </div>
  );
}

// ── Grid / list switcher ─────────────────────────────────────────────────────
// List first: it is the default on every screen that uses this, so the control
// reads in the same order as the choice people land on.
export const VIEW_TABS = [
  { key: 'list', icon: List, label: 'List' },
  { key: 'grid', icon: LayoutGrid, label: 'Grid' },
];

/** The segmented Grid|List control shared by Projects, Portfolios, Teams and
 *  Templates. It started as one copy inside ProjectsView; the moment a second
 *  screen wanted it, keeping it there would have meant four switchers drifting
 *  apart in padding, radius and active-state shadow. Callers own the `view`
 *  value (all four persist it per user via useTableValue), this owns the look. */
export function ViewToggle({ view, onChange, isMobile = false, style }) {
  return (
    <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, background: NX.border2, borderRadius: 9, padding: 2, flexShrink: 0, ...style }}>
      {VIEW_TABS.map((tb) => (
        <button key={tb.key} onClick={() => onChange(tb.key)} title={`${tb.label} View`}
          aria-pressed={view === tb.key}
          style={{
            ...btn('ghost'), padding: isMobile ? '5px 8px' : '6px 10px', borderRadius: 7, whiteSpace: 'nowrap',
            background: view === tb.key ? NX.surface : 'transparent',
            color: view === tb.key ? NX.ink : NX.dim,
            boxShadow: view === tb.key ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
          }}><tb.icon size={15} />{!isMobile && ` ${tb.label}`}</button>
      ))}
    </div>
  );
}
