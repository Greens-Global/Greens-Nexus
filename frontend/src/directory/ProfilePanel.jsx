// One person's contact card - the right pane of the Contact Directory. The
// same panel whichever lens (Departments / Reporting Line) found the person,
// so there is one place to learn.
//
// Reach-me-first (Neil, 10/09): Teams Chat / Call / Video lead; email next;
// the mobile and office numbers sit below them as plain copyable details.
import { useEffect, useState } from 'react';
import {
  MessageSquare, Phone, Video, Mail, Copy, Check, Smartphone, Building2, MapPin, Clock, Link2,
  Star, Download, User, ListTodo, Network, ArrowLeft, Users,
} from 'lucide-react';
import { NX, FONT } from '../tasks/theme';
import {
  teamsChat, teamsCall, teamsVideo, mailto, telHref, initialsOf, hueOf, AVAILABILITY_META, presenceOf,
  chainUp, directReports, byLastName, localTimeLabel, offsetFromViewer, vCardOf, downloadText, safeFileName,
} from './lib';

export function Avatar({ p, size = 40, radius }) {
  const r = radius ?? Math.round(size * 0.28);
  // Teams presence wins the dot (it is what the person's Teams shows right
  // now); Nexus availability colors it when Graph has nothing for them.
  const pr = presenceOf(p.presence);
  const av = p.availability ? AVAILABILITY_META[p.availability.state] : null;
  const dotColor = pr?.color || av?.color;
  const dotTitle = pr ? `Teams: ${pr.label}` : p.availability?.label;
  const dot = dotColor && size >= 28 ? (
    <span title={dotTitle} style={{
      position: 'absolute', right: -2, bottom: -2, width: Math.max(10, size * 0.28), height: Math.max(10, size * 0.28),
      borderRadius: '50%', background: dotColor, border: '2px solid var(--card)',
    }} />
  ) : null;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      {p.photoUrl
        ? <img src={p.photoUrl} alt="" loading="lazy" style={{ width: size, height: size, borderRadius: r, objectFit: 'cover', display: 'block' }} />
        : (
          <span style={{
            width: size, height: size, borderRadius: r, background: `hsla(${hueOf(p.email)},0.13)`, color: `hsl(${hueOf(p.email)})`,
            fontSize: Math.round(size * 0.36), fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>{initialsOf(p)}</span>
        )}
      {dot}
    </span>
  );
}

export function RoleBadge({ role }) {
  if (!role) return null;
  const lead = role === 'lead';
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '.03em', padding: '1px 7px', borderRadius: 999, marginLeft: 6, verticalAlign: 'middle',
      background: lead ? 'rgba(22,163,74,0.12)' : NX.border2, color: lead ? '#15803d' : NX.dim,
    }}>{lead ? 'Lead' : 'Backup'}</span>
  );
}

export function AvailabilityChip({ availability, size = 'sm' }) {
  if (!availability) return null;
  const m = AVAILABILITY_META[availability.state] || AVAILABILITY_META.out;
  const big = size === 'lg';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: big ? '6px 12px' : '2px 8px', borderRadius: 999,
      background: m.tint, color: m.color, fontSize: big ? 13 : 11, fontWeight: 700, whiteSpace: big ? 'normal' : 'nowrap',
      flexWrap: big ? 'wrap' : 'nowrap', maxWidth: '100%',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
      {availability.label}
      {big && availability.detail && <span style={{ fontWeight: 500, opacity: 0.9 }}>{availability.detail}</span>}
    </span>
  );
}

function CopyButton({ value, label }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ }
  };
  return (
    <button type="button" onClick={copy} title={`Copy ${label}`} aria-label={`Copy ${label}`} style={{
      border: 'none', background: 'transparent', color: done ? NX.green : NX.faint, cursor: 'pointer', padding: 3, borderRadius: 6,
      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    }}>
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

const PRIMARY = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '10px 6px',
  borderRadius: 11, textDecoration: 'none', fontFamily: FONT, fontSize: 12, fontWeight: 700, minWidth: 0,
  background: 'rgba(91,95,199,0.12)', color: '#4b53bc', border: '1px solid transparent',
};
const SECONDARY = { ...PRIMARY, background: NX.surface2, color: NX.ink, border: `1px solid ${NX.border}` };

function Person({ p, onSelect, me }) {
  return (
    <button type="button" onClick={() => onSelect(p.email)} className="dir-pill" title={p.jobTitle || p.email} style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, padding: '3px 10px 3px 3px', borderRadius: 999, cursor: 'pointer',
      border: `1px solid ${p.email === me ? NX.primary : NX.border}`, background: NX.surface, fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
      color: NX.ink, maxWidth: '100%',
    }}>
      <Avatar p={p} size={22} radius={7} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}{p.email === me ? ' (you)' : ''}</span>
    </button>
  );
}

function Row({ icon: Icon, label, children }) {
  return (
    <>
      <dt style={{ display: 'flex', alignItems: 'center', gap: 6, color: NX.faint, fontSize: 12, fontWeight: 600 }}>
        <Icon size={13} /> {label}
      </dt>
      <dd style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, color: NX.ink, fontSize: 13 }}>{children}</dd>
    </>
  );
}

export default function ProfilePanel({
  person, people, byEmail, me, pinned, onPin, onSelect, onBack, onDepartment, onViewChart,
  canOpenPeople, onOpenPeople, canOpenTasks, onOpenTasks, mobile,
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);   // the local clock below
    return () => clearInterval(id);
  }, []);
  if (!person) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, color: NX.faint, textAlign: 'center', padding: 24 }}>
        <Users size={30} style={{ opacity: 0.4, marginBottom: 10 }} />
        <div style={{ fontWeight: 600, color: NX.ink, marginBottom: 4 }}>Pick a person</div>
        <div style={{ fontSize: 13, maxWidth: 280 }}>Search by name, title, department or office, or browse the list to open someone's card.</div>
      </div>
    );
  }
  const p = person;
  const up = chainUp(p, byEmail);
  const reports = directReports(p, people);
  const peers = people.filter((x) => x.department && x.department === p.department && x.email !== p.email
    && x.email !== (p.managerEmail || '').toLowerCase() && (x.managerEmail || '').toLowerCase() !== p.email).sort(byLastName);
  const place = [p.city, p.state].filter(Boolean).join(', ');
  const isPinned = pinned.includes(p.email);
  const clock = p.timeZone ? localTimeLabel(p.timeZone) : '';
  const offset = p.timeZone ? offsetFromViewer(p.timeZone) : '';
  const saveCard = () => downloadText(`${safeFileName(p.name)}.vcf`, vCardOf(p), 'text/vcard');

  return (
    <div style={{ fontFamily: FONT, color: NX.ink }}>
      {mobile && (
        <button type="button" onClick={onBack} className="dir-tool" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px solid ${NX.border}`, background: NX.surface, color: NX.ink, fontWeight: 600, fontSize: 13.5, cursor: 'pointer', padding: '8px 14px', borderRadius: 9, marginBottom: 14, fontFamily: FONT, minHeight: 40 }}>
          <ArrowLeft size={16} /> Back to List
        </button>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <Avatar p={p} size={76} radius={20} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 800, lineHeight: 1.2, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              {p.name}{p.email === me && <span style={{ fontSize: 12, color: NX.faint, fontWeight: 600, marginLeft: 6 }}>(you)</span>}
            </h3>
            <button type="button" onClick={() => onPin(p.email)} title={isPinned ? 'Unpin' : 'Pin to the top of your list'} aria-pressed={isPinned} style={{
              border: 'none', background: 'none', cursor: 'pointer', color: isPinned ? '#d97706' : NX.faint, padding: 4, flexShrink: 0,
            }}>
              <Star size={17} fill={isPinned ? '#d97706' : 'none'} />
            </button>
          </div>
          {(p.jobTitle || p.designation) && (
            <div style={{ fontSize: 13.5, color: NX.dim, marginTop: 2 }}>
              {p.jobTitle}{p.designation && p.designation !== p.jobTitle ? ` · ${p.designation}` : ''}
            </div>
          )}
          <div style={{ fontSize: 12.5, color: NX.faint, marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: '0 6px', alignItems: 'center' }}>
            {p.department && (
              <button type="button" onClick={() => onDepartment?.(p.department)} style={{ border: 'none', background: 'none', padding: 0, color: NX.dim, fontFamily: FONT, fontSize: 12.5, fontWeight: 600, cursor: onDepartment ? 'pointer' : 'default' }}>
                {p.department}<RoleBadge role={p.departmentRole} />
              </button>
            )}
            {p.division && <span>· {p.division}</span>}
            {p.companyName && <span>· {p.companyName}</span>}
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {presenceOf(p.presence) && (
              <span title="Teams status" style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 700,
                background: 'rgba(91,95,199,0.12)', color: '#4b53bc',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: presenceOf(p.presence).color, flexShrink: 0 }} />
                {presenceOf(p.presence).label}
              </span>
            )}
            {p.availability
              ? <AvailabilityChip availability={p.availability} size="lg" />
              : p.status === 'onboarding'
                ? <span style={{ fontSize: 12, fontWeight: 700, color: NX.blue, background: 'rgba(37,99,235,0.10)', padding: '4px 10px', borderRadius: 999 }}>Starting Soon</span>
                : p.status === 'inactive'
                  ? <span style={{ fontSize: 12, fontWeight: 700, color: NX.dim, background: NX.border2, padding: '4px 10px', borderRadius: 999 }}>Inactive</span>
                  : null}
          </div>
        </div>
      </div>

      {/* Teams first, email beside it. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 7, marginTop: 16 }}>
        <a href={teamsChat(p.email)} target="_blank" rel="noreferrer" style={PRIMARY} className="dir-action"><MessageSquare size={17} />Chat</a>
        <a href={teamsCall(p.email)} target="_blank" rel="noreferrer" style={PRIMARY} className="dir-action"><Phone size={17} />Call</a>
        <a href={teamsVideo(p.email)} target="_blank" rel="noreferrer" style={PRIMARY} className="dir-action"><Video size={17} />Video</a>
        <a href={mailto(p.email)} style={SECONDARY} className="dir-action"><Mail size={17} />Email</a>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: mobile ? 'minmax(70px, auto) minmax(0, 1fr)' : 'minmax(96px, auto) minmax(0, 1fr)', gap: mobile ? '10px 8px' : '9px 14px', margin: '18px 0 0', alignItems: 'center' }}>
        <Row icon={Mail} label="Email">
          <a href={mailto(p.email)} style={{ color: NX.ink, textDecoration: 'none', overflowWrap: 'anywhere', minWidth: 0, fontSize: mobile ? 12.5 : 13 }}>{p.email}</a>
          <CopyButton value={p.email} label="email" />
        </Row>
        {p.officePhone && (
          <Row icon={Phone} label="Office">
            <a href={telHref(p.officePhone)} style={{ color: mobile ? NX.primary : NX.ink, textDecoration: 'none' }}>{p.officePhone}</a>
            <CopyButton value={p.officePhone} label="office phone" />
          </Row>
        )}
        {p.mobile && (
          <Row icon={Smartphone} label="Mobile">
            <a href={telHref(p.mobile)} style={{ color: mobile ? NX.primary : NX.ink, textDecoration: 'none' }}>{p.mobile}</a>
            <CopyButton value={p.mobile} label="mobile" />
          </Row>
        )}
        {(p.location || place || p.country) && (
          <Row icon={MapPin} label="Location">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{[p.location, place, p.country].filter(Boolean).join(' · ')}</span>
          </Row>
        )}
        {clock && (
          <Row icon={Clock} label="Local Time">
            <span>{clock}</span>
            {offset && <span style={{ color: NX.faint, fontSize: 12 }}>({offset} from you)</span>}
          </Row>
        )}
        {p.companyName && <Row icon={Building2} label="Company"><span>{p.companyName}</span></Row>}
        {p.linkedinUrl && (
          <Row icon={Link2} label="LinkedIn">
            <a href={p.linkedinUrl} target="_blank" rel="noreferrer" style={{ color: NX.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.linkedinUrl.replace(/^https?:\/\/(www\.)?/, '')}</a>
          </Row>
        )}
      </dl>

      <Section icon={Network} title="Reports To">
        {up.length
          ? up.map((m, i) => (
            <span key={m.email} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
              {i > 0 && <span style={{ color: NX.faint, fontSize: 12 }}>›</span>}
              <Person p={m} onSelect={onSelect} me={me} />
            </span>
          ))
          : <span style={{ color: NX.faint, fontSize: 12.5 }}>No manager on record</span>}
      </Section>
      {reports.length > 0 && (
        <Section icon={Users} title={`Direct Reports (${reports.length})`}>
          {reports.map((r) => <Person key={r.email} p={r} onSelect={onSelect} me={me} />)}
        </Section>
      )}
      {peers.length > 0 && (
        <Section icon={Building2} title={`Also in ${p.department}`}>
          {peers.slice(0, 12).map((r) => <Person key={r.email} p={r} onSelect={onSelect} me={me} />)}
          {peers.length > 12 && (
            <button type="button" onClick={() => onDepartment?.(p.department)} style={{ border: 'none', background: 'none', color: NX.primary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              +{peers.length - 12} more
            </button>
          )}
        </Section>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 18, paddingTop: 14, borderTop: `1px solid ${NX.border}` }}>
        <Tool icon={Download} onClick={saveCard}>Save Contact</Tool>
        {onViewChart && <Tool icon={Network} onClick={() => onViewChart(p)}>View on Chart</Tool>}
        {canOpenTasks && <Tool icon={ListTodo} onClick={() => onOpenTasks(p)}>View Tasks</Tool>}
        {canOpenPeople && <Tool icon={User} onClick={() => onOpenPeople(p)}>Open in People</Tool>}
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint, marginBottom: 8 }}>
        <Icon size={12} /> {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function Tool({ icon: Icon, onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="dir-tool" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: 8, border: `1px solid ${NX.border}`,
      background: NX.surface, color: NX.ink, fontFamily: FONT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    }}>
      <Icon size={14} /> {children}
    </button>
  );
}
