import { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Send, Pencil, ShieldOff, ShieldCheck, Trash2, Globe, MailPlus } from 'lucide-react';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate } from '../lib/datetime';
import { SkeletonBlocks } from '../components/AsyncState';
import { COUNTRY_CODES, splitPhone, joinPhone } from '../lib/countryCodes';

// ── External users - invite modal + person-panel section (Aug 18 rework) ─────
// Externals live in the Roles & Access PEOPLE tab like everyone else (Visesh:
// "external users should be in the people tab ... this has to go through roles
// and access just like any normal employee"). This file holds only what is
// genuinely external-specific: the Invite External User modal (email/name/
// company/expiry - NO grant picking; access is assigned through the normal
// job-role/group machinery on the person panel) and the panel section with
// invite status + Resend Invite / Deactivate / Remove.

const field = { width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 13.5, fontFamily: 'Inter,sans-serif', boxSizing: 'border-box' };
const label = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 5, display: 'block' };
const actionBtn = (color, borderColor) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: `1px solid ${borderColor || 'var(--line)'}`, background: 'transparent', color: color || 'var(--ink)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' });

// Small "External" identity chip for people lists.
export function ExternalBadge() {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.12)', padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap' }}>
      External
    </span>
  );
}

// Entra invitation delivery state (stored server-side: sent/accepted/failed/manual).
// 'accepted' is stamped by external_auth.activate_verify the moment the invite
// link is redeemed - it supersedes 'sent' so the panel stops saying "Invite
// Sent" once the person has actually finished activating their account.
export function InvitePill({ status }) {
  if (!status) return null;
  const s = status === 'accepted' ? { text: 'Invitation Accepted', color: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' }
    : status === 'sent' ? { text: 'Invite Sent', color: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' }
    : status === 'manual' ? { text: 'Invited Manually', color: 'var(--muted)', bg: 'color-mix(in srgb, var(--muted) 12%, transparent)' }
      : { text: 'Invite Failed', color: 'hsl(var(--color-red))', bg: 'hsla(var(--color-red),0.10)' };
  return (
    <span title={status === 'failed' ? 'The Microsoft invitation email could not be sent - use Resend Invite after fixing the Graph permission, or invite manually in Entra.' : ''}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>
      {s.text}
    </span>
  );
}

// Invite / edit modal. `initial` = null for a new external user, or the row
// being edited. No access controls here on purpose - grants happen on the
// person panel through job roles and groups, same as any employee.
export function InviteExternalModal({ initial, onClose, onSaved }) {
  const editing = !!initial;
  const [email, setEmail] = useState(initial?.email || '');
  const [firstName, setFirstName] = useState(initial?.firstName || '');
  const [lastName, setLastName] = useState(initial?.lastName || '');
  const [company, setCompany] = useState(initial?.company || '');
  const [expiresAt, setExpiresAt] = useState(initial?.expiresAt || '');
  const initialPhone = splitPhone(initial?.phone);
  const [phoneDial, setPhoneDial] = useState(initialPhone.dial);
  const [phoneRest, setPhoneRest] = useState(initialPhone.rest);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    if (!editing && (!email.trim() || !email.includes('@'))) { setError('A valid email address is required.'); return; }
    if (!firstName.trim()) { setError('First name is required.'); return; }
    setSaving(true);
    const phone = joinPhone(phoneDial, phoneRest);
    try {
      const result = editing
        ? await api.updateExternalUser(initial.email, { first_name: firstName, last_name: lastName, company, expires_at: expiresAt, phone })
        : await api.createExternalUser({ email: email.trim(), first_name: firstName, last_name: lastName, company, expires_at: expiresAt, phone });
      onSaved(result);
    } catch (e) {
      setError(e?.message || 'Could not save - try again.');
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div style={{ width: 440, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 16, border: '1px solid var(--line)', padding: 24, fontFamily: 'Inter,sans-serif' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>{editing ? 'Edit External User' : 'Invite External User'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}><X size={17} /></button>
        </div>

        <div style={{ display: 'grid', gap: 13 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <span style={label}>First name</span>
              <input style={field} value={firstName} onChange={e => setFirstName(e.target.value)} />
            </div>
            <div>
              <span style={label}>Last name</span>
              <input style={field} value={lastName} onChange={e => setLastName(e.target.value)} />
            </div>
          </div>
          <div>
            <span style={label}>Email (the invitation is sent to this address)</span>
            <input style={{ ...field, opacity: editing ? 0.6 : 1 }} type="email" value={email} disabled={editing}
              placeholder="name@partnercompany.com" onChange={e => setEmail(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <span style={label}>Company</span>
              <input style={field} value={company} placeholder="e.g. Aarav Construction" onChange={e => setCompany(e.target.value)} />
            </div>
            <div>
              <span style={label}>Access expires (optional)</span>
              <input style={field} type="date" value={expiresAt.slice(0, 10)} onChange={e => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <div>
            <span style={label}>Mobile phone (optional - one-time codes go by text once verified)</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <select style={{ ...field, width: 132, flexShrink: 0 }} value={phoneDial} onChange={e => setPhoneDial(e.target.value)}>
                {COUNTRY_CODES.map(c => (
                  <option key={c.iso} value={c.dial}>{c.name} ({c.dial})</option>
                ))}
              </select>
              <input style={field} type="tel" value={phoneRest} placeholder="555 555 1234" onChange={e => setPhoneRest(e.target.value)} />
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Saving emails them a branded Nexus invitation with a one-time activation link - no Microsoft account needed. They start with no access - assign a job role or groups on their People card, exactly like an employee. Whatever you grant, they still never appear in people pickers, never receive company-wide notifications, and in Tasks and Tickets only see items they are assigned to, following, or raised themselves.
          </div>

          {error && <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', fontWeight: 600 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 3 }}>
            <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {saving && <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />}
              {editing ? 'Save Changes' : 'Send Invite'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Surfaces the invite outcome that rides along on create/resend responses. */
export function inviteOutcomeToast(result, toastOk, toastErr) {
  if (result?.inviteStatus === 'sent') toastOk?.(`Invitation email sent to ${result.email}`);
  else if (result?.inviteStatus === 'failed') toastErr?.(result.inviteMessage || 'Saved, but the invitation email could not be sent - use Resend Invite after fixing the Microsoft Graph permission, or invite manually in Entra.');
  else if (result?.inviteStatus === 'manual') toastOk?.(result.inviteMessage || 'Saved - already in the Microsoft tenant, no invitation needed');
  else toastOk?.('Saved');
}

// ONE implementation of the lifecycle actions, shared by the person-card
// section (Roles & Access) and the People module's External tab list - the
// two surfaces must never drift apart in behavior or copy.
export function useExternalActions({ onChanged, onRemoved, toastOk, toastErr }) {
  const [busyEmail, setBusyEmail] = useState('');

  const run = async (email, fn) => {
    setBusyEmail(email);
    try { await fn(); } finally { setBusyEmail(''); }
  };

  const resend = (ext) => run(ext.email, async () => {
    try {
      const r = await api.resendExternalInvite(ext.email);
      inviteOutcomeToast({ ...r, inviteMessage: r.inviteMessage }, toastOk, toastErr);
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'The invitation could not be sent'); }
  });

  const setStatus = (ext, status) => run(ext.email, async () => {
    try {
      await api.updateExternalUser(ext.email, { status });
      toastOk?.(status === 'active' ? `${ext.name} reactivated` : `${ext.name} deactivated - they can no longer sign in`);
      onChanged?.();
    } catch (e) { toastErr?.(e?.message || 'Could not update'); }
  });

  const remove = (ext) => run(ext.email, async () => {
    const ok = await dialog.confirm(
      `Remove ${ext.name} from Nexus entirely? Deactivate keeps their record and can be reversed - Remove erases them completely, and they would have to be re-invited from scratch. Tasks and comments they took part in are kept.`,
      { title: 'Remove External User', confirmText: 'Remove Permanently', danger: true });
    if (!ok) return;
    try {
      await api.removeExternalUser(ext.email);
      toastOk?.(`${ext.name} removed from Nexus`);
      onRemoved?.();
    } catch (e) { toastErr?.(e?.message || 'Could not remove'); }
  });

  return { busyEmail, resend, setStatus, remove };
}


// The external-specific section of a person's panel in the People tab:
// company/expiry/invite state plus Resend Invite, Edit, Deactivate/Reactivate,
// and the permanent Remove. Everything below it on the panel (job role, tier,
// groups) is the same machinery every employee gets.
export function ExternalPersonSection({ ext, onChanged, onRemoved, toastOk, toastErr }) {
  const [editOpen, setEditOpen] = useState(false);
  const expired = ext.expiresAt && ext.expiresAt.slice(0, 10) < new Date().toISOString().slice(0, 10);
  const { busyEmail, resend: doResend, setStatus: doSetStatus, remove: doRemove } =
    useExternalActions({ onChanged, onRemoved, toastOk, toastErr });
  const busy = busyEmail === ext.email;
  const resend = () => doResend(ext);
  const setStatus = (status) => doSetStatus(ext, status);
  const remove = () => doRemove(ext);

  return (
    <div style={{ border: '1px solid hsla(var(--color-blue),0.35)', background: 'hsla(var(--color-blue),0.05)', borderRadius: 12, padding: '12px 14px', margin: '12px 0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ExternalBadge />
        <InvitePill status={ext.inviteStatus} />
        {ext.status !== 'active' && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'color-mix(in srgb, var(--muted) 12%, transparent)', padding: '2px 10px', borderRadius: 20 }}>Deactivated</span>
        )}
        {expired && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'hsl(var(--color-red))', background: 'hsla(var(--color-red),0.10)', padding: '2px 10px', borderRadius: 20 }}>Expired</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
        {ext.company ? `${ext.company} · ` : ''}{ext.email}
        {ext.phone ? ` · ${ext.phone}${ext.phoneVerifiedAt ? ' (verified)' : ''}` : ''}
        {ext.expiresAt ? ` · access expires ${formatDate(ext.expiresAt)}` : ''}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
        Partner guest account. Grant access below with a job role or groups, like any employee. They never appear in people pickers and only see tasks and tickets they take part in.
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 10 }}>
        <button onClick={resend} disabled={busy} title="Send the Microsoft invitation email again" style={actionBtn()}>
          <Send size={13} /> Resend Invite
        </button>
        <button onClick={() => setEditOpen(true)} disabled={busy} title="Edit name, company, or expiry" style={actionBtn()}>
          <Pencil size={13} /> Edit
        </button>
        {ext.status === 'active' ? (
          <button onClick={() => setStatus('inactive')} disabled={busy} style={actionBtn('hsl(var(--color-red))', 'hsla(var(--color-red),0.4)')}>
            <ShieldOff size={13} /> Deactivate
          </button>
        ) : (
          <button onClick={() => setStatus('active')} disabled={busy} style={actionBtn('hsl(var(--color-green))', 'hsla(var(--color-green),0.4)')}>
            <ShieldCheck size={13} /> Reactivate
          </button>
        )}
        <button onClick={remove} disabled={busy} title="Erase them from Nexus entirely - cannot be undone" style={actionBtn('hsl(var(--color-red))', 'hsla(var(--color-red),0.4)')}>
          <Trash2 size={13} /> Remove
        </button>
      </div>
      {editOpen && (
        <InviteExternalModal initial={ext}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); toastOk?.('Saved'); onChanged?.(); }} />
      )}
    </div>
  );
}


function StatusBadge({ user }) {
  const expired = user.expiresAt && user.expiresAt.slice(0, 10) < new Date().toISOString().slice(0, 10);
  const s = user.status !== 'active' ? { text: 'Inactive', color: 'var(--muted)', bg: 'color-mix(in srgb, var(--muted) 12%, transparent)' }
    : expired ? { text: 'Expired', color: 'hsl(var(--color-red))', bg: 'hsla(var(--color-red),0.10)' }
      : { text: 'Active', color: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{s.text}
    </span>
  );
}


// ── The External tab list (People module, Aug 18 - Visesh: "there should be
// an external tab"). The PRIMARY home for external users: invite, status,
// lifecycle actions. Access GRANTS stay on the Roles & Access person card
// (job roles / groups), which is the other surface these same pieces render
// on - one implementation, two placements.
export default function ExternalUsersPanel({ toastOk, toastErr, onChanged }) {
  const [users, setUsers] = useState(null);
  const [editing, setEditing] = useState(undefined);   // undefined=closed, null=new, obj=edit
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.getExternalUsers()
      .then(rows => { setUsers(rows); setError(''); onChanged?.(rows); })
      .catch(() => setError('Could not load external users.'));
  }, [onChanged]);
  useEffect(() => { load(); }, [load]);

  const { busyEmail, resend, setStatus, remove } = useExternalActions({
    onChanged: load, onRemoved: load, toastOk, toastErr,
  });

  if (error) return <div style={{ padding: 24, fontSize: 13.5, color: 'var(--muted)' }}>{error}</div>;
  if (!users) return <SkeletonBlocks count={3} height={64} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 640, lineHeight: 1.55 }}>
          Partner-company people who sign in passwordlessly with a one-time code. Inviting someone sends them a branded activation email; they only ever see the modules granted to them, never appear in people pickers or the directory, and never receive company-wide notifications. Grant access on their card in Roles & Access, like any employee.
        </div>
        <button className="primary-btn" onClick={() => setEditing(null)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          <MailPlus size={15} /> Invite External User
        </button>
      </div>

      {users.length === 0 ? (
        <div style={{ padding: '44px 20px', textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 14 }}>
          <Globe size={26} style={{ color: 'var(--muted)', marginBottom: 9 }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', marginBottom: 5 }}>No external users yet</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 380, margin: '0 auto', lineHeight: 1.5 }}>
            Invite each partner contact here - they get an activation email and sign in with a one-time code.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 9 }}>
          {users.map(u => (
            <div key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderRadius: 13, border: '1px solid var(--line)', background: 'var(--card)', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 220, flex: '1 1 240px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{u.name}</span>
                  <ExternalBadge />
                  <StatusBadge user={u} />
                  <InvitePill status={u.inviteStatus} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {u.email}{u.company ? ` · ${u.company}` : ''}
                  {u.phone ? ` · ${u.phone}${u.phoneVerifiedAt ? ' (verified)' : ''}` : ''}
                  {u.expiresAt ? ` · expires ${formatDate(u.expiresAt)}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, flexShrink: 0, flexWrap: 'wrap' }}>
                <button onClick={() => resend(u)} disabled={busyEmail === u.email} title="Send a fresh activation email" style={actionBtn()}>
                  <Send size={13} /> Resend Invite
                </button>
                <button onClick={() => setEditing(u)} disabled={busyEmail === u.email} title="Edit name, company, phone, or expiry" style={actionBtn()}>
                  <Pencil size={13} /> Edit
                </button>
                {u.status === 'active' ? (
                  <button onClick={() => setStatus(u, 'inactive')} disabled={busyEmail === u.email} style={actionBtn('hsl(var(--color-red))', 'hsla(var(--color-red),0.4)')}>
                    <ShieldOff size={13} /> Deactivate
                  </button>
                ) : (
                  <button onClick={() => setStatus(u, 'active')} disabled={busyEmail === u.email} style={actionBtn('hsl(var(--color-green))', 'hsla(var(--color-green),0.4)')}>
                    <ShieldCheck size={13} /> Reactivate
                  </button>
                )}
                <button onClick={() => remove(u)} disabled={busyEmail === u.email} title="Erase them from Nexus entirely - cannot be undone" style={actionBtn('hsl(var(--color-red))', 'hsla(var(--color-red),0.4)')}>
                  <Trash2 size={13} /> Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <InviteExternalModal initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(result) => {
            setEditing(undefined);
            inviteOutcomeToast(result, toastOk, toastErr);
            load();
          }} />
      )}
    </div>
  );
}
