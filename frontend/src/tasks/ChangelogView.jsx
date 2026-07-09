// "What's new" changelog — a company-wide feed of release notes, reached from the
// top-right profile dropdown (NOT the Tasks module). Standalone: it manages its
// own state via api.js + useRole/useNameResolver, so it needs no TasksProvider.
// Renders as a full-screen overlay. The backend stores each entry as a free-form
// `payload` dict, so the field shape below is authoritative.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Plus, Bug, Flame, ShieldAlert, TrendingUp, Wrench, ArrowUpCircle,
  Heart, MessageSquare, Send, Pencil, Trash2, GitBranch, Layers, CalendarDays,
  CheckCircle2, User, Tag, X,
} from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { useNameResolver } from '../lib/useNameResolver';
import { NX, FONT, chip, card, btn, input as inputStyle } from './theme';
import { Avatar, EmptyState, Modal } from './components';

// ── Change-type metadata (ported from changelogMeta.ts) ──────────────────────
const CHANGE_TYPE_META = {
  'Bug Fix':         { color: NX.red,    tint: '#fde5e5', icon: Bug },
  'Performance':     { color: NX.amber,  tint: '#fdefd7', icon: TrendingUp },
  'New Feature':     { color: NX.green,  tint: '#e3f5ea', icon: Sparkles },
  'Security Update': { color: NX.pink,   tint: '#fbe3ef', icon: ShieldAlert },
  'Hotfix':          { color: '#ea580c', tint: '#ffe4d6', icon: Flame },
  'Maintenance':     { color: NX.purple, tint: '#efe6fd', icon: Wrench },
  'Improvement':     { color: NX.blue,   tint: '#e0eafe', icon: ArrowUpCircle },
};
const CHANGE_TYPES = Object.keys(CHANGE_TYPE_META);
const ENVIRONMENTS = ['Production', 'Staging', 'Beta'];
const typeMeta = (t) => CHANGE_TYPE_META[t] || { color: NX.dim, tint: NX.border2, icon: Sparkles };

// The server owns these three; everything else lives inside the payload we author.
function payloadOf(entry) {
  const { id, createdAt, updatedAt, ...rest } = entry || {};
  return rest;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function Changelog({ onClose }) {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();
  const [changelog, setChangelog] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [composer, setComposer] = useState(null); // null | { entry? }

  const reload = () => api.getTaskChangelog().then((r) => setChangelog(r || [])).catch(() => {});
  useEffect(() => { reload(); }, []);

  // Self-contained data layer (no TasksProvider): the free-form `payload` body
  // has no camel keys the context would remap, so we call api.js directly.
  const createChangelog = async (d) => { const r = await api.createTaskChangelog(d); setChangelog((p) => [r, ...p]); return r; };
  const updateChangelog = async (id, patch) => { const r = await api.updateTaskChangelog(id, patch); setChangelog((p) => p.map((x) => (x.id === id ? r : x))); return r; };
  const deleteChangelog = async (id) => { await api.deleteTaskChangelog(id); setChangelog((p) => p.filter((x) => x.id !== id)); };
  const getChangelogComments = (id) => api.getTaskChangelogComments(id);
  const addChangelogComment = (id, body) => api.addTaskChangelogComment(id, { body });

  // Esc closes the overlay, but only when no nested entry/composer modal is open
  // (those handle their own Esc).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !openId && !composer) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, composer, onClose]);

  const entries = useMemo(
    () => (changelog || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
    [changelog],
  );
  const openEntry = entries.find((e) => e.id === openId) || null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, fontFamily: FONT, color: NX.ink, background: NX.canvas, display: 'flex', flexDirection: 'column', animation: 'fadeIn 0.13s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${NX.border}`, background: NX.surface }}>
        <Sparkles size={18} style={{ color: NX.blue }} />
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>What's new</div>
          <div style={{ fontSize: 12, color: NX.dim }}>Release notes and product updates.</div>
        </div>
        <button style={{ ...btn('primary'), marginLeft: 'auto' }} onClick={() => setComposer({})}><Plus size={15} />New entry</button>
        <button onClick={onClose} title="Close" aria-label="Close" style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><X size={18} /></button>
      </div>

      {/* Feed */}
      <div className="nx-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', background: NX.canvas, padding: 16 }}>
        {entries.length === 0 ? (
          <EmptyState icon={Sparkles} title="Nothing shipped yet" hint="Add the first entry to start the changelog." />
        ) : (
          <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {entries.map((e) => (
              <EntryCard key={e.id} entry={e} nameOf={nameOf} onOpen={() => setOpenId(e.id)} />
            ))}
          </div>
        )}
      </div>

      {openEntry && (
        <DetailModal
          entry={openEntry}
          nameOf={nameOf}
          myEmail={myEmail}
          onClose={() => setOpenId(null)}
          onEdit={() => setComposer({ entry: openEntry })}
          onDelete={async () => {
            if (!window.confirm('Delete this entry? This cannot be undone.')) return;
            setOpenId(null);
            await deleteChangelog(openEntry.id).catch(() => {});
          }}
          updateChangelog={updateChangelog}
          getChangelogComments={getChangelogComments}
          addChangelogComment={addChangelogComment}
        />
      )}

      {composer && (
        <ComposerModal
          entry={composer.entry}
          myEmail={myEmail}
          onClose={() => setComposer(null)}
          createChangelog={createChangelog}
          updateChangelog={updateChangelog}
        />
      )}
    </div>,
    document.body,
  );
}

// ── Feed card ────────────────────────────────────────────────────────────────
function EntryCard({ entry, nameOf, onOpen }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const tags = entry.tags || [];
  const likes = (entry.likedByEmails || []).length;
  return (
    <div
      onClick={onOpen}
      style={{ ...card, padding: 18, cursor: 'pointer', transition: 'box-shadow 0.13s' }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={chip(meta.color, meta.tint)}><Icon size={12} />{entry.type || 'Update'}</span>
        {entry.module && <span style={{ fontSize: 12, fontWeight: 600, color: NX.dim }}>{entry.module}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: NX.faint }}>{fmtDate(entry.createdAt || entry.releasedAt)}</span>
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: NX.ink }}>{entry.title || 'Untitled'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 3, fontSize: 12, color: NX.dim }}>
        {entry.version && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'monospace' }}><GitBranch size={12} />{entry.version}</span>}
        {entry.environment && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: NX.green }} />{entry.environment}</span>}
      </div>
      {entry.description && (
        <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.55, color: NX.ink, whiteSpace: 'pre-wrap',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {entry.description}
        </p>
      )}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {tags.slice(0, 4).map((t) => (
            <span key={t} style={{ fontSize: 11, fontWeight: 600, color: NX.dim, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '2px 8px' }}>{t}</span>
          ))}
          {tags.length > 4 && <span style={{ fontSize: 11, color: NX.faint, padding: '2px 4px' }}>+{tags.length - 4}</span>}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${NX.border2}`, fontSize: 12, color: NX.dim }}>
        {entry.authorId && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Avatar email={entry.authorId} name={nameOf(entry.authorId)} size={20} />{nameOf(entry.authorId)}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Heart size={13} style={{ color: likes ? NX.red : NX.faint }} />{likes || 0}</span>
      </div>
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────
function DetailModal({ entry, nameOf, myEmail, onClose, onEdit, onDelete, updateChangelog, getChangelogComments, addChangelogComment }) {
  const meta = typeMeta(entry.type);
  const Icon = meta.icon;
  const tags = entry.tags || [];
  const whatsChanged = entry.whatsChanged || [];
  const liked = (entry.likedByEmails || []).includes(myEmail);
  const likeCount = (entry.likedByEmails || []).length;

  const toggleLike = () => {
    const set = new Set(entry.likedByEmails || []);
    liked ? set.delete(myEmail) : set.add(myEmail);
    updateChangelog(entry.id, { payload: { ...payloadOf(entry), likedByEmails: [...set] } }).catch(() => {});
  };

  const header = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={chip(meta.color, meta.tint)}><Icon size={12} />{entry.type || 'Update'}</span>
    </span>
  );

  return (
    <Modal title={header} onClose={onClose} width={640}>
      <div style={{ fontFamily: FONT }}>
        <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: NX.ink }}>{entry.title || 'Untitled'}</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 8, fontSize: 12.5, color: NX.dim }}>
          {entry.module && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Layers size={13} style={{ color: NX.faint }} />{entry.module}</span>}
          {entry.version && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'monospace' }}><GitBranch size={13} style={{ color: NX.faint }} />{entry.version}</span>}
          {entry.environment && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: NX.green }} />{entry.environment}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays size={13} style={{ color: NX.faint }} />{fmtDateTime(entry.releasedAt || entry.createdAt)}</span>
        </div>

        {/* Admin actions — shown to everyone for now. */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={toggleLike} style={{ ...btn('outline'), color: liked ? NX.red : NX.dim }}>
            <Heart size={14} style={{ fill: liked ? NX.red : 'none' }} />{liked ? 'Liked' : 'Like'}{likeCount ? ` · ${likeCount}` : ''}
          </button>
          <button onClick={onEdit} style={{ ...btn('outline') }}><Pencil size={14} />Edit</button>
          <button onClick={onDelete} style={{ ...btn('outline'), color: NX.red }}><Trash2 size={14} />Delete</button>
        </div>

        {entry.description && (
          <Section label="Description">
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: NX.ink, whiteSpace: 'pre-wrap' }}>{entry.description}</p>
          </Section>
        )}

        {whatsChanged.length > 0 && (
          <Section label="What's changed">
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {whatsChanged.map((line, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: NX.ink }}>
                  <CheckCircle2 size={15} style={{ color: NX.green, flexShrink: 0, marginTop: 1 }} />{line}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {entry.businessImpact && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, background: '#e0eafe', color: NX.blue, borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
            <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 1 }} />{entry.businessImpact}
          </div>
        )}
        {entry.userImpact && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, color: NX.dim, fontSize: 13 }}>
            <User size={15} style={{ color: NX.faint, flexShrink: 0, marginTop: 1 }} />{entry.userImpact}
          </div>
        )}

        {tags.length > 0 && (
          <Section label="Tags">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tags.map((t) => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: NX.ink, border: `1px solid ${NX.border}`, borderRadius: 999, padding: '3px 10px' }}>
                  <Tag size={11} style={{ color: NX.faint }} />{t}
                </span>
              ))}
            </div>
          </Section>
        )}

        {entry.authorId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${NX.border}`, fontSize: 13, color: NX.dim }}>
            <Avatar email={entry.authorId} name={nameOf(entry.authorId)} size={24} />
            <span>Published by <span style={{ fontWeight: 600, color: NX.ink }}>{nameOf(entry.authorId)}</span></span>
          </div>
        )}

        <CommentsThread
          entryId={entry.id}
          nameOf={nameOf}
          getChangelogComments={getChangelogComments}
          addChangelogComment={addChangelogComment}
        />
      </div>
    </Modal>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: NX.faint, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

// ── Comments ─────────────────────────────────────────────────────────────────
function CommentsThread({ entryId, nameOf, getChangelogComments, addChangelogComment }) {
  const [comments, setComments] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = () => getChangelogComments(entryId).then(setComments).catch(() => setComments([]));
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [entryId]);

  const submit = async () => {
    const b = body.trim();
    if (!b || busy) return;
    setBusy(true);
    setBody('');
    await addChangelogComment(entryId, b).catch(() => {});
    await reload();
    setBusy(false);
  };

  const list = (comments || []).slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${NX.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 12 }}>
        <MessageSquare size={15} style={{ color: NX.faint }} />Comments{comments ? ` (${list.length})` : ''}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          rows={2}
          placeholder="Add a comment… (⌘/Ctrl+Enter)"
          style={{ ...inputStyle, resize: 'vertical', fontSize: 13 }}
        />
        <button onClick={submit} disabled={!body.trim() || busy} style={{ ...btn('primary'), alignSelf: 'flex-end', opacity: !body.trim() || busy ? 0.5 : 1 }}>
          <Send size={14} />Add comment
        </button>
      </div>

      {comments === null ? (
        <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ color: NX.faint, fontSize: 13, textAlign: 'center', padding: 20 }}>No comments yet. Be the first.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 10 }}>
              <Avatar email={c.authorId} name={nameOf(c.authorId)} size={26} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: NX.ink }}>{nameOf(c.authorId)}</span>
                  <span style={{ fontSize: 11, color: NX.faint }}>{c.createdAt ? fmtDateTime(c.createdAt) : ''}</span>
                </div>
                <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', fontSize: 13, color: NX.dim }}>{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Composer (create / edit) ─────────────────────────────────────────────────
function nowLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ComposerModal({ entry, myEmail, onClose, createChangelog, updateChangelog }) {
  const editing = !!entry;
  const p = payloadOf(entry || {});
  const [title, setTitle] = useState(p.title || '');
  const [description, setDescription] = useState(p.description || '');
  const [type, setType] = useState(p.type || 'New Feature');
  const [module, setModule] = useState(p.module || '');
  const [version, setVersion] = useState(p.version || '');
  const [environment, setEnvironment] = useState(p.environment || 'Production');
  const [tags, setTags] = useState((p.tags || []).join(', '));
  const [whatsChanged, setWhatsChanged] = useState((p.whatsChanged || []).join('\n'));
  const [businessImpact, setBusinessImpact] = useState(p.businessImpact || '');
  const [userImpact, setUserImpact] = useState(p.userImpact || '');
  const [saving, setSaving] = useState(false);

  const canSave = title.trim() && description.trim() && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const payload = {
      ...p, // preserve any fields we don't edit (likedByEmails, images, links…)
      title: title.trim(),
      description: description.trim(),
      type,
      module: module.trim(),
      version: version.trim(),
      environment,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      whatsChanged: whatsChanged.split('\n').map((l) => l.trim()).filter(Boolean),
      businessImpact: businessImpact.trim(),
      userImpact: userImpact.trim(),
      authorId: p.authorId || myEmail,
      releasedAt: p.releasedAt || nowLocalISO(),
    };
    try {
      if (editing) await updateChangelog(entry.id, { payload });
      else await createChangelog({ payload });
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const footer = (
    <>
      <button onClick={onClose} style={btn('outline')}>Cancel</button>
      <button onClick={save} disabled={!canSave} style={{ ...btn('primary'), opacity: canSave ? 1 : 0.5 }}>
        {editing ? 'Save changes' : 'Publish'}
      </button>
    </>
  );

  return (
    <Modal title={editing ? 'Edit entry' : 'New entry'} onClose={onClose} width={620} footer={footer}>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Fixed leave balance calculation" style={inputStyle} />
      </Field>
      <Field label="Description" hint="Plain English — this is what everyone reads.">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="What changed, and why it matters." style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Category">
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Module">
          <input value={module} onChange={(e) => setModule(e.target.value)} placeholder="e.g. HR, Tasks" style={inputStyle} />
        </Field>
        <Field label="Version">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. v2.8.1" style={inputStyle} />
        </Field>
        <Field label="Environment">
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            {ENVIRONMENTS.map((e2) => <option key={e2} value={e2}>{e2}</option>)}
          </select>
        </Field>
      </div>

      <Field label="What's changed" hint="One bullet per line.">
        <textarea value={whatsChanged} onChange={(e) => setWhatsChanged(e.target.value)} rows={3} placeholder={'Create recurring tasks\nSelect an end date'} style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>
      <Field label="Tags" hint="Comma-separated.">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. UI, Automation" style={inputStyle} />
      </Field>
      <Field label="Business impact" hint="Optional — one line.">
        <input value={businessImpact} onChange={(e) => setBusinessImpact(e.target.value)} placeholder="e.g. Saves HR staff time each month." style={inputStyle} />
      </Field>
      <Field label="User impact" hint="Optional — one line.">
        <input value={userImpact} onChange={(e) => setUserImpact(e.target.value)} placeholder="e.g. A new option appears when creating a task." style={inputStyle} />
      </Field>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: NX.faint, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
