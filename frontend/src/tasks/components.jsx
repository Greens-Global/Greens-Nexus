// Task Module — shared UI atoms (inline-styled to match the export's light theme).
import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api } from '../api';
import { NX, FONT, colorForKey, initialsOf, statusChip, priorityChip, btn, chip, STATUS_META, input as inputStyle } from './theme';
import { fmtDate } from './lib';
import { useTasks } from './TasksContext';

// People profile photos, fetched once per session and shared by every Avatar.
// Module-scope cache + subscriber set so avatars that mounted before the
// directory arrived re-render when it does.
let _photoMap = null;
let _photoPromise = null;
const _photoSubs = new Set();
function usePhotoMap() {
  const [, force] = useState(0);
  useEffect(() => {
    if (_photoMap) return undefined;
    if (!_photoPromise) {
      _photoPromise = api.getPeopleDirectory().then((rows) => {
        _photoMap = {};
        for (const r of rows || []) if (r.email) _photoMap[r.email.toLowerCase()] = r.photoUrl || '';
        _photoSubs.forEach((f) => f((x) => x + 1));
      }).catch(() => { _photoMap = {}; });
    }
    _photoSubs.add(force);
    return () => _photoSubs.delete(force);
  }, []);
  return _photoMap || {};
}

export function Avatar({ email, name, size = 26 }) {
  const photos = usePhotoMap();
  const label = name || email || '';
  const photo = email ? photos[email.toLowerCase()] : '';
  if (photo) {
    return <img src={photo} alt={label} title={label} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, objectFit: 'cover', display: 'inline-block',
    }} />;
  }
  return (
    <div title={label} style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: colorForKey(email || label), color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 700,
    }}>{initialsOf(label)}</div>
  );
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
// (bottom-center pill), for mobile pages that only need one action — no
// filter/view segments. Replaces an inline header "+" so it stays reachable
// one-thumb while scrolled, matching the Task pages' mobile pattern.
export function MobileFab({ onClick, title = 'Create' }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{
      position: 'fixed', left: '50%', bottom: 18, transform: 'translateX(-50%)',
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
export function Modal({ title, onClose, children, footer, width = 560 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="nx-tasks-portal" onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 4000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '7vh 16px',
      fontFamily: FONT, animation: 'fadeIn 0.13s ease',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: NX.surface, borderRadius: 14, width, maxWidth: '100%', maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.28)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: `1px solid ${NX.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: NX.ink }}>{title}</div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto' }}>{children}</div>
        {footer && <div style={{ padding: '13px 20px', borderTop: `1px solid ${NX.border}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// Closes a dropdown on an outside click (or Escape) instead of onMouseLeave —
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
// formatted text and the native input is kept, invisible, on top of it — clicks
// still open the OS calendar (showPicker), keyboard and mobile pickers still
// work, and we don't reimplement a calendar.
// ── Nexus calendar picker (replaces the native OS date popup) ────────────────
const CAL_WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');
const dateToISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isoToDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const sameYMD = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// Popover calendar rendered to a portal, fixed-positioned near the trigger and
// flipped up when there isn't room below — so it works inside modals/sheets too.
function CalendarPopover({ value, onChange, onClose, anchorRect, anchorRef }) {
  const selected = value ? isoToDate(value) : null;
  const today = new Date();
  const [cursor, setCursor] = useState(() => { const b = selected || today; return new Date(b.getFullYear(), b.getMonth(), 1); });
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
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - W - 8));
  const flipUp = anchorRect.bottom + 6 + H > window.innerHeight && anchorRect.top > H;
  const vpos = flipUp ? { bottom: window.innerHeight - anchorRect.top + 6 } : { top: anchorRect.bottom + 6 };
  const navBtn = { ...btn('ghost'), padding: 5, color: NX.dim };
  const linkBtn = { background: 'transparent', border: 'none', cursor: 'pointer', color: NX.blue, fontWeight: 600, fontSize: 13, fontFamily: FONT, padding: '4px 6px' };

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', left, width: W, ...vpos, background: NX.surface, border: `1px solid ${NX.border}`,
      borderRadius: 14, boxShadow: '0 16px 44px rgba(0,0,0,0.22)', zIndex: 5000, padding: 14, fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>{CAL_MONTHS[cursor.getMonth()]} {cursor.getFullYear()}</div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} style={navBtn} aria-label="Previous month"><ChevronLeft size={18} /></button>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} style={navBtn} aria-label="Next month"><ChevronRight size={18} /></button>
        </div>
      </div>
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, borderTop: `1px solid ${NX.border2}`, paddingTop: 8 }}>
        <button onClick={() => { onChange(null); onClose(); }} style={linkBtn}>Clear</button>
        <button onClick={() => { onChange(dateToISO(today)); onClose(); }} style={linkBtn}>Today</button>
      </div>
    </div>,
    document.body,
  );
}

export function DateField({ value, onChange, placeholder = '—', color, style, title, disabled }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const openCal = () => {
    if (disabled) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) { setRect(r); setOpen(true); }
  };
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', ...style }}>
      <button
        ref={btnRef} type="button" title={title || 'Set date'} disabled={disabled}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openCal(); }}
        style={{
          border: 'none', background: 'transparent', padding: 0, margin: 0, cursor: disabled ? 'default' : 'pointer',
          fontFamily: FONT, fontSize: 'inherit', fontWeight: 'inherit', whiteSpace: 'nowrap',
          color: color || (value ? NX.ink : NX.faint),
        }}
      >{value ? fmtDate(value) : placeholder}</button>
      {open && rect && <CalendarPopover value={value} onChange={onChange} onClose={() => setOpen(false)} anchorRect={rect} anchorRef={btnRef} />}
    </span>
  );
}

// Loads the Nexus People directory once (deduped in api.js) → [{email,name}] for pickers.
export function usePeople() {
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return people;
}

// A compact dropdown that picks a person (email) from the directory.
// Prettify an email into a display name when the person isn't in the loaded
// directory: "sagar.shoundik@greensglobal.com" → "Sagar Shoundik".
function emailToName(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return email || '';
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || email;
}

// Mirrors task_util.PROJECT_ROLE_RANK — a role only ever implies everything
// ranked below it. Labels/descriptions match Asana's own Share dialog exactly
// (per the reference screenshots) so this reads as a direct parity build.
export const PROJECT_ROLES = {
  owner:     { label: 'Project admin', rank: 4, description: 'Can change settings, modify, or delete the project.' },
  editor:    { label: 'Editor',        rank: 3, description: 'Can add, edit, and delete anything in the project.' },
  commenter: { label: 'Commenter',     rank: 2, description: "Can comment, but can't edit anything in the project." },
  viewer:    { label: 'Viewer',        rank: 1, description: "Can view, but can't add comments or edit the project." },
};
const PROJECT_ROLE_ORDER = ['owner', 'editor', 'commenter', 'viewer'];

// Rendered to a portal, fixed-positioned against the trigger's own rect —
// same technique as CalendarPopover above. The plain-nested-dropdown version
// got clipped by the Share modal's "Who has access" list, which needs its own
// overflow-y:auto scrollbar; a position:absolute child can never escape that.
function RolePickerPanel({ anchorRect, value, onChange, onClose }) {
  const ref = useRef(null);
  useClickOutside(ref, onClose, true);
  const W = 260;
  const left = Math.max(8, Math.min(anchorRect.right - W, window.innerWidth - W - 8));
  const H = 260;
  const flipUp = anchorRect.bottom + 6 + H > window.innerHeight && anchorRect.top > H;
  const vpos = flipUp ? { bottom: window.innerHeight - anchorRect.top + 6 } : { top: anchorRect.bottom + 6 };
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

// Per-person/per-team role dropdown for the Share panel — same shape as
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

// Full "Share" dialog — Asana parity: invite by email with a role, an
// org-wide/private toggle, and a "Who has access" list (owner fixed, each
// individual member and each project-scoped Team with its own role dropdown
// + remove). Roles are ENFORCED server-side (task_util.require_project_role),
// not cosmetic — a non-owner's edits here will 403; PermissionError below
// surfaces that inline instead of failing silently.
function ShareProjectModal({ project, teams, people, onClose }) {
  const { updateProject, updateTeam } = useTasks();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  const ownerEmail = (project.ownerId || '').toLowerCase();
  const memberRoles = project.memberRoles || {};
  const memberEmails = (project.memberIds || []).filter((em) => em.toLowerCase() !== ownerEmail);
  const projectTeams = (teams || []).filter((t) => t.projectId === project.id);

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

  const setTeamRole = (team, role) => run(() => updateTeam(team.id, { access_role: role }));
  const removeTeam = (team) => run(() => updateTeam(team.id, { project_id: '' }));

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

      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Invite with email</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <PersonSelect value={inviteEmail} onChange={(em) => setInviteEmail(em || '')}
            people={people} placeholder="Add people from Nexus…" />
        </div>
        <RolePicker value={inviteRole} onChange={setInviteRole} />
        <button type="button" disabled={busy || !inviteEmail} onClick={invite} style={btn('primary')}>Invite</button>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Access settings</div>
      <select value={project.accessLevel || 'org'} disabled={busy}
        onChange={(e) => run(() => updateProject(project.id, { access_level: e.target.value }))}
        style={{ ...inputStyle, width: '100%', marginBottom: 16 }}>
        <option value="restricted">Private — only people/teams listed below</option>
        <option value="org">Org-wide — everyone at Nexus can see this project</option>
      </select>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>Who has access</span>
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
            <RolePicker value={t.accessRole || 'editor'} onChange={(r) => setTeamRole(t, r)} disabled={busy} />
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

// "Who has access" — the avatar-stack trigger in the project header, mirroring
// Asana's Share button/dialog. Sourced from the same three grants
// task_util.visible_project_ids() actually reads (owner, TaskProject.member_
// emails, TaskTeam rosters), so the stack is never wrong about who can see the
// project — clicking it opens the full editable Share panel (ShareProjectModal).
export function ProjectAccessButton({ project, teams, people }) {
  const [shareOpen, setShareOpen] = useState(false);
  if (!project) return null;
  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  const ownerEmail = (project.ownerId || '').toLowerCase();
  const memberEmails = Array.isArray(project.memberIds) ? project.memberIds : [];
  const projectTeams = (teams || []).filter((t) => t.projectId === project.id);
  const allEmails = Array.from(new Set(
    [ownerEmail, ...memberEmails, ...projectTeams.flatMap((t) => t.memberIds || [])].filter(Boolean)
  ));
  const stackShown = allEmails.slice(0, 3);
  const overflow = allEmails.length - stackShown.length;
  return (
    <>
      <button type="button" onClick={() => setShareOpen(true)} title="Share — manage who has access"
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

export function PersonSelect({ value, onChange, people, placeholder = 'Unassigned', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const sel = people.find((p) => p.email === value);
  // A value can be set to someone not in the loaded directory (e.g. the current
  // user before the People directory has loaded / when it's empty). Still show
  // them — derive a display name from the email — rather than the placeholder.
  const chosen = sel || (value ? { email: value, name: emailToName(value) } : null);
  const filtered = q ? people.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : people;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)}
        style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {chosen ? <Avatar email={chosen.email} name={chosen.name} size={20} /> : null}
          <span style={{ color: chosen ? NX.ink : NX.faint, overflow: 'hidden', textOverflow: 'ellipsis' }}>{chosen ? chosen.name : placeholder}</span>
        </span>
        <ChevronDown size={15} style={{ color: NX.faint }} />
      </button>
      {open && !disabled && (
        <div className="nx-scroll" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, maxHeight: 280, overflowY: 'auto' }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          <div onClick={() => { onChange(null); setOpen(false); }} style={{ padding: '8px 12px', fontSize: 13, color: NX.dim, cursor: 'pointer' }}>Unassigned</div>
          {filtered.map((p) => (
            <div key={p.email} onClick={() => { onChange(p.email); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: p.email === value ? NX.hover : 'transparent' }}>
              <Avatar email={p.email} name={p.name} size={22} />
              <span style={{ flex: 1 }}>{p.name}</span>
              {p.email === value && <Check size={14} style={{ color: NX.blue }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Multi-select sibling of PersonSelect — same directory, search and avatars, but
// picks stay selected and the menu stays open so several people can be added in
// one go. `value` is an array of emails; onChange receives a new array.
export function PersonMultiSelect({ value, onChange, people, placeholder = 'Select people' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const emails = Array.isArray(value) ? value : [];
  const personFor = (em) => people.find((p) => p.email === em) || { email: em, name: emailToName(em) };
  const filtered = q ? people.filter((p) => (p.name + p.email).toLowerCase().includes(q.toLowerCase())) : people;
  const toggle = (em) => onChange(emails.includes(em) ? emails.filter((x) => x !== em) : [...emails, em]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn('outline'), width: '100%', justifyContent: 'space-between', height: 'auto', minHeight: 36, padding: '5px 10px' }}>
        {/* Chips scroll past ~3 rows rather than growing the field without bound —
            in a narrow grid column each chip takes its own row. */}
        <span className="nx-scroll" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
          {emails.length === 0 && <span style={{ color: NX.faint }}>{placeholder}</span>}
          {emails.map((em) => {
            const p = personFor(em);
            return (
              <span key={em} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: NX.surface2, border: `1px solid ${NX.border}`, borderRadius: 20, padding: '2px 7px 2px 2px', fontSize: 12, color: NX.ink }}>
                <Avatar email={p.email} name={p.name} size={18} />
                {p.name}
                {/* A span, not a button — this sits inside the dropdown trigger button. */}
                <span role="button" tabIndex={0} title={`Remove ${p.name}`}
                  onClick={(e) => { e.stopPropagation(); toggle(em); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggle(em); } }}
                  style={{ display: 'inline-flex', cursor: 'pointer', color: NX.faint }}>
                  <X size={11} />
                </span>
              </span>
            );
          })}
        </span>
        <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} />
      </button>
      {open && (
        <div className="nx-scroll" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', zIndex: 50, maxHeight: 280, overflowY: 'auto' }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" style={{ width: '100%', border: 'none', borderBottom: `1px solid ${NX.border}`, padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: FONT, boxSizing: 'border-box', background: 'transparent', color: NX.ink }} />
          {filtered.map((p) => {
            const on = emails.includes(p.email);
            return (
              <div key={p.email} onClick={() => toggle(p.email)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer', color: NX.ink, background: on ? NX.hover : 'transparent' }}>
                <Avatar email={p.email} name={p.name} size={22} />
                <span style={{ flex: 1 }}>{p.name}</span>
                {on && <Check size={14} style={{ color: NX.blue }} />}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: NX.faint }}>
              {q ? `No people match “${q}”.` : 'No people in the directory.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
