import { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Globe, Pencil, ShieldOff, ShieldCheck, Send, MailPlus } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks } from '../components/AsyncState';
import { formatDate } from '../lib/datetime';

// ── External Users (Entra B2B guest allowlist) - Roles & Access panel ────────
// Partner-company people (MCD, Aarav Construction, OSM, ...) who sign in as
// Entra B2B guests. Being a tenant guest alone grants NOTHING: the backend only
// accepts a guest whose email is enrolled here as an active row
// (auth.apply_external_policy, default-deny). Access is limited to the
// external-safe module set and they never appear in people pickers.

const field = { width: '100%', padding: '9px 12px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 13.5, fontFamily: 'Inter,sans-serif', boxSizing: 'border-box' };
const label = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 5, display: 'block' };

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

// Entra invitation delivery state (stored server-side: sent/failed/manual).
function InvitePill({ status }) {
  if (!status) return null;
  const s = status === 'sent' ? { text: 'Invite Sent', color: 'hsl(var(--color-green))', bg: 'hsla(var(--color-green),0.12)' }
    : status === 'manual' ? { text: 'Invited Manually', color: 'var(--muted)', bg: 'color-mix(in srgb, var(--muted) 12%, transparent)' }
      : { text: 'Invite Failed', color: 'hsl(var(--color-red))', bg: 'hsla(var(--color-red),0.10)' };
  return (
    <span title={status === 'failed' ? 'The Microsoft invitation email could not be sent - use Resend Invite after fixing the Graph permission, or invite manually in Entra.' : ''}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>
      {s.text}
    </span>
  );
}

function GrantPill({ id, level, labelOf }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {labelOf(id)}
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{level === 'editor' ? 'Editor' : 'Viewer'}</span>
    </span>
  );
}

// Add / edit modal. `initial` = null for a new external user, or the row being edited.
function ExternalUserModal({ initial, meta, onClose, onSaved }) {
  const editing = !!initial;
  const [email, setEmail] = useState(initial?.email || '');
  const [firstName, setFirstName] = useState(initial?.firstName || '');
  const [lastName, setLastName] = useState(initial?.lastName || '');
  const [company, setCompany] = useState(initial?.company || '');
  const [expiresAt, setExpiresAt] = useState(initial?.expiresAt || '');
  const [grants, setGrants] = useState(() => {
    const src = editing ? initial.modules : (meta?.defaults || []);
    return new Map((src || []).map(g => [g.id, g.level]));
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id) => setGrants(prev => {
    const next = new Map(prev);
    next.has(id) ? next.delete(id) : next.set(id, 'viewer');
    return next;
  });
  const setLevel = (id, level) => setGrants(prev => new Map(prev).set(id, level));

  const save = async () => {
    setError('');
    if (!editing && (!email.trim() || !email.includes('@'))) { setError('A valid email address is required.'); return; }
    if (!firstName.trim()) { setError('First name is required.'); return; }
    setSaving(true);
    try {
      const modules = [...grants].map(([id, level]) => ({ id, level }));
      const result = editing
        ? await api.updateExternalUser(initial.email, { first_name: firstName, last_name: lastName, company, expires_at: expiresAt, modules })
        : await api.createExternalUser({ email: email.trim(), first_name: firstName, last_name: lastName, company, expires_at: expiresAt, modules });
      onSaved(result);
    } catch (e) {
      setError(e?.message || 'Could not save - try again.');
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }} onClick={onClose}>
      <div style={{ width: 480, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 16, border: '1px solid var(--line)', padding: 24, fontFamily: 'Inter,sans-serif' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>{editing ? 'Edit External User' : 'Invite External User'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4 }}><X size={17} /></button>
        </div>

        <div style={{ display: 'grid', gap: 13 }}>
          <div>
            <span style={label}>Email (the Microsoft invitation is sent to this address)</span>
            <input style={{ ...field, opacity: editing ? 0.6 : 1 }} type="email" value={email} disabled={editing}
              placeholder="name@partnercompany.com" onChange={e => setEmail(e.target.value)} />
          </div>
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
            <span style={label}>What they can open</span>
            <div style={{ display: 'grid', gap: 6 }}>
              {(meta?.modules || []).map(m => {
                const on = grants.has(m.id);
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 9, border: '1px solid var(--line)', background: on ? 'var(--paper)' : 'transparent' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, cursor: 'pointer', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(m.id)} />
                      {m.label}
                    </label>
                    {on && (
                      <select value={grants.get(m.id)} onChange={e => setLevel(m.id, e.target.value)}
                        style={{ ...field, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
                        {(meta?.levels || ['viewer', 'editor']).map(lv => (
                          <option key={lv} value={lv}>{lv === 'editor' ? 'Editor' : 'Viewer'}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 7, lineHeight: 1.5 }}>
              External users only ever see these modules - no people pickers, no dashboards, no HR or company data. In Tasks and Tickets they see only items they are assigned to, following, or raised themselves. Documents and Knowledge Base show ALL shared company content to any grant holder - grant those only when that is intended. Saving sends them a Microsoft invitation email automatically.
            </div>
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

export default function ExternalUsersPanel({ toastOk, toastErr }) {
  const [users, setUsers] = useState(null);
  const [meta, setMeta] = useState(null);
  const [editing, setEditing] = useState(undefined);   // undefined=closed, null=new, obj=edit
  const [busyEmail, setBusyEmail] = useState('');
  const [error, setError] = useState('');

  const labelOf = useCallback((id) => (meta?.modules || []).find(m => m.id === id)?.label || id, [meta]);

  const load = useCallback(() => {
    api.getExternalUsers().then(setUsers).catch(() => setError('Could not load external users.'));
    api.getExternalUsersMeta().then(setMeta).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (u, status) => {
    setBusyEmail(u.email);
    try {
      await api.updateExternalUser(u.email, { status });
      toastOk?.(status === 'active' ? `${u.name} reactivated` : `${u.name} deactivated - they can no longer sign in`);
      load();
    } catch (e) {
      toastErr?.(e?.message || 'Could not update');
    } finally {
      setBusyEmail('');
    }
  };

  const resendInvite = async (u) => {
    setBusyEmail(u.email);
    try {
      const r = await api.resendExternalInvite(u.email);
      if (r.inviteStatus === 'sent') toastOk?.(`Invitation email sent to ${u.email}`);
      else if (r.inviteStatus === 'manual') toastOk?.(r.inviteMessage || 'Already in the Microsoft tenant - no invitation needed');
      else toastErr?.(r.inviteMessage || 'The invitation could not be sent');
      load();
    } catch (e) {
      toastErr?.(e?.message || 'The invitation could not be sent');
    } finally {
      setBusyEmail('');
    }
  };

  // Enrollment saved; the invite outcome rides along on the create response.
  const onModalSaved = (result) => {
    setEditing(undefined);
    if (result?.inviteStatus === 'sent') toastOk?.(`Invitation email sent to ${result.email}`);
    else if (result?.inviteStatus === 'failed') toastErr?.(result.inviteMessage || 'Added, but the invitation email could not be sent - use Resend Invite after fixing the Microsoft Graph permission, or invite manually in Entra.');
    else if (result?.inviteStatus === 'manual') toastOk?.(result.inviteMessage || 'Added - already in the Microsoft tenant, no invitation needed');
    else toastOk?.('Saved');
    load();
  };

  if (error) return <div style={{ padding: 24, fontSize: 13.5, color: 'var(--muted)' }}>{error}</div>;
  if (!users) return <SkeletonBlocks count={3} height={64} />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.55 }}>
          Partner-company people who sign in with their own email as Microsoft guests. Inviting someone here sends them the Microsoft invitation email AND puts them on the Nexus allowlist - they only ever see the modules granted below, never appear in people pickers, and never receive company-wide notifications.
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
            Invite each partner contact here - they get a Microsoft invitation email and can then sign in with their own address.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 9 }}>
          {users.map(u => (
            <div key={u.email} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderRadius: 13, border: '1px solid var(--line)', background: 'var(--card)', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 190, flex: '1 1 190px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>{u.name}</span>
                  <StatusBadge user={u} />
                  <InvitePill status={u.inviteStatus} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {u.email}{u.company ? ` · ${u.company}` : ''}
                  {u.expiresAt ? ` · expires ${formatDate(u.expiresAt)}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: '2 1 260px' }}>
                {u.modules.length
                  ? u.modules.map(g => <GrantPill key={g.id} id={g.id} level={g.level} labelOf={labelOf} />)
                  : <span style={{ fontSize: 12, color: 'var(--muted)' }}>No modules granted</span>}
              </div>
              <div style={{ display: 'flex', gap: 7, flexShrink: 0, flexWrap: 'wrap' }}>
                <button onClick={() => resendInvite(u)} disabled={busyEmail === u.email} title="Send the Microsoft invitation email again"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                  <Send size={13} /> Resend Invite
                </button>
                <button onClick={() => setEditing(u)} title="Edit access"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid var(--line)', background: 'transparent', color: 'var(--ink)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                  <Pencil size={13} /> Edit
                </button>
                {u.status === 'active' ? (
                  <button onClick={() => setStatus(u, 'inactive')} disabled={busyEmail === u.email}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid hsla(var(--color-red),0.4)', background: 'transparent', color: 'hsl(var(--color-red))', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                    <ShieldOff size={13} /> Deactivate
                  </button>
                ) : (
                  <button onClick={() => setStatus(u, 'active')} disabled={busyEmail === u.email}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid hsla(var(--color-green),0.4)', background: 'transparent', color: 'hsl(var(--color-green))', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
                    <ShieldCheck size={13} /> Reactivate
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing !== undefined && (
        <ExternalUserModal initial={editing} meta={meta}
          onClose={() => setEditing(undefined)}
          onSaved={onModalSaved} />
      )}
    </div>
  );
}
