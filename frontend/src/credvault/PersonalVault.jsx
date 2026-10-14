// Credential Vault - the Personal Vault tab (Oct 14 2026 rebuild). Private to
// the signed-in account: nobody else, admins included, can read it. One
// password unlock opens it for the server's window (Settings > Security,
// Personal Vault unlock time); it locks itself when that window ends or on
// Lock Now. Passwords stay readable while unlocked - no per-row timer.
import { useCallback, useEffect, useState } from "react";
import { Lock, Unlock, Plus, Eye, EyeOff, Copy, Check, Pencil, Trash2, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { dialog } from "../ui/dialog";
import { formatTime } from "../lib/datetime";
import { Modal } from "../tasks/components";
import { PersonalLockGate, Field, PasswordField, TYPES, MsLogo } from "./vaultShared";

function PersonalForm({ row, onClose, onSave }) {
  const editing = !!row;
  const [form, setForm] = useState({ name: row?.name || "", username: row?.username === "-" ? "" : row?.username || "", secret: "", type: row?.type || "Password", note: row?.note || "" });
  const [initial] = useState(form);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.name.trim() && (editing || form.secret);
  async function save() { if (!valid) return; setBusy(true); try { await onSave(form); } finally { setBusy(false); } }
  return (
    <Modal title={editing ? "Edit Personal Credential" : "Add Personal Credential"} onClose={onClose} isDirty={JSON.stringify(form) !== JSON.stringify(initial)} onSave={valid ? save : undefined} width="clamp(440px, 44vw, 620px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={save} disabled={!valid || busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <div className="cv-root cv-form-stack" style={{ animation: "none" }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" placeholder="e.g. Personal Gmail, Home Wi-Fi" autoFocus /></Field>
        <div className="cv-form-grid">
          <Field label="Username / Email"><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" autoComplete="off" /></Field>
          <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        </div>
        <PasswordField value={form.secret} onChange={(v) => set("secret", v)} required={!editing} label={editing ? "New Password" : "Password"} placeholder={editing ? "Leave blank to keep the current password" : "Enter or generate a password"} />
        <Field label="Note"><input value={form.note} onChange={(e) => set("note", e.target.value)} className="cv-ipt" placeholder="Security question, recovery hint…" /></Field>
        <div className="cv-callout tone-info"><ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>Encrypted and private - not visible to any admin or team member.</span></div>
      </div>
    </Modal>
  );
}

export default function PersonalVault({ myEmail, flash, active = true }) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [unlockedUntil, setUnlockedUntil] = useState(0);       // ms; 0 = locked
  const [gate, setGate] = useState(false);
  const [form, setForm] = useState(null);                      // null | { row }
  const [open, setOpen] = useState({});                        // id -> secret
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const unlocked = unlockedUntil > now;

  const load = useCallback(() => api.cvPersonal().then((r) => { setRows(r || []); setLoaded(true); }).catch(() => setLoaded(true)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // The tab stays mounted behind the others (one unlock per window), so the
  // auto-lock only speaks up when this tab is the one on screen.
  useEffect(() => {
    if (unlockedUntil && unlockedUntil <= now) { setOpen({}); setUnlockedUntil(0); if (active) flash("Personal Vault locked.", "info"); }
  }, [now, unlockedUntil, flash, active]);

  function lock() { setOpen({}); setUnlockedUntil(0); flash("Personal Vault locked.", "info"); }
  function onUnlocked(res) {
    setGate(false);
    setUnlockedUntil(Date.now() + ((res?.expiresInSec || 600) * 1000));
    flash("Personal Vault unlocked.");
  }
  async function reveal(r) {
    try { const res = await api.cvPersonalReveal(r.id); setOpen((o) => ({ ...o, [r.id]: res.secret })); }
    catch (e) { if (e?.status === 403) { setUnlockedUntil(0); setGate(true); } else flash(e?.message || "Could not reveal.", "info"); }
  }
  function copy(text, id) {
    try { navigator.clipboard?.writeText(text); } catch { /* blocked */ }
    setCopied(id); setTimeout(() => setCopied((c) => (c === id ? "" : c)), 1400);
  }
  async function save(f) {
    if (form?.row) await api.cvPersonalUpdate(form.row.id, f); else await api.cvPersonalCreate(f);
    setForm(null); setOpen((o) => { const n = { ...o }; if (form?.row) delete n[form.row.id]; return n; });
    await load();
    flash(form?.row ? "Personal credential updated." : "Saved to your Personal Vault.");
  }
  async function remove(r) {
    const ok = await dialog.confirm(`Delete ${r.name} from your Personal Vault? There is no trash for personal credentials.`, { title: "Delete Personal Credential", confirmText: "Delete", danger: true });
    if (!ok) return;
    try { await api.cvPersonalDelete(r.id); await load(); flash("Deleted."); } catch (e) { flash(e?.message || "Could not delete.", "info"); }
  }

  if (!unlocked) {
    return (
      <div className="cv-list" style={{ padding: "40px 20px", textAlign: "center" }}>
        <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--cv-info-bg)", color: "var(--cv-info)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}><Lock size={22} /></div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Personal Vault</div>
        <p className="cv-hint" style={{ margin: "6px auto 16px", maxWidth: 420 }}>
          {loaded && rows.length ? `${rows.length} private credential${rows.length === 1 ? "" : "s"}, ` : "Your own passwords, "}
          encrypted and bound to <span style={{ display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: -1 }}><MsLogo size={11} /> {myEmail}</span>. Not visible to any admin or team member.
        </p>
        <button type="button" className="cv-btn-dark cv-btn-indigo" onClick={() => setGate(true)}><Unlock size={14} /> {loaded && rows.length === 0 ? "Set Up Personal Vault" : "Unlock"}</button>
        {gate && <PersonalLockGate userEmail={myEmail} onClose={() => setGate(false)} onUnlocked={onUnlocked} />}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="cv-toolbar">
        <span className="cv-chip tone-info"><Unlock size={12} /> Unlocked · locks at {formatTime(new Date(unlockedUntil))}</span>
        <span className="cv-count">{rows.length} credential{rows.length === 1 ? "" : "s"}</span>
        <button type="button" className="cv-btn" onClick={lock}><Lock size={14} /> Lock Now</button>
        <button type="button" className="cv-btn-dark cv-btn-indigo" onClick={() => setForm({ row: null })}><Plus size={14} /> Add</button>
      </div>
      {rows.length === 0 ? (
        <div className="cv-list cv-empty"><strong>Nothing here yet</strong>Add the passwords only you should hold. They never leave this account.</div>
      ) : (
        <div className="cv-list">
          {rows.map((r, i) => {
            const secret = open[r.id];
            return (
              <div key={r.id} className="cv-row" style={{ gridTemplateColumns: "32px minmax(0,1fr) auto", cursor: "default", borderTop: i === 0 ? "none" : undefined }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: "var(--cv-info-bg)", color: "var(--cv-info)", display: "flex", alignItems: "center", justifyContent: "center" }}><KeyRound size={14} /></div>
                <div className="cv-row-main">
                  <div className="cv-name"><span>{r.name}</span><span className="cv-chip">{r.type}</span></div>
                  <div className="cv-sub">
                    {r.username && r.username !== "-" ? r.username : "no username"}{r.note ? ` · ${r.note}` : ""}
                  </div>
                  <div className="cv-mono" style={{ marginTop: 4, fontSize: secret ? 13 : 13.5, letterSpacing: secret ? "normal" : ".2em", color: secret ? "var(--text-primary)" : "var(--text-muted)", wordBreak: "break-all" }}>{secret || "••••••••"}</div>
                </div>
                <div className="cv-field-actions" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {r.username && r.username !== "-" && <button type="button" className="cv-iconbtn" title="Copy Username" aria-label="Copy Username" onClick={() => copy(r.username, r.id + ":u")}>{copied === r.id + ":u" ? <Check size={14} style={{ color: "var(--cv-ok)" }} /> : <Copy size={14} />}</button>}
                  {secret
                    ? <button type="button" className="cv-iconbtn" title="Hide" aria-label="Hide Password" onClick={() => setOpen((o) => { const n = { ...o }; delete n[r.id]; return n; })}><EyeOff size={14} /></button>
                    : <button type="button" className="cv-iconbtn" title="Reveal" aria-label="Reveal Password" onClick={() => reveal(r)}><Eye size={14} /></button>}
                  <button type="button" className="cv-iconbtn" title="Copy Password" aria-label="Copy Password" disabled={!secret} onClick={() => copy(secret, r.id)}>{copied === r.id ? <Check size={14} style={{ color: "var(--cv-ok)" }} /> : <Copy size={14} />}</button>
                  <button type="button" className="cv-iconbtn" title="Edit" aria-label="Edit" onClick={() => setForm({ row: r })}><Pencil size={14} /></button>
                  <button type="button" className="cv-iconbtn is-danger" title="Delete" aria-label="Delete" onClick={() => remove(r)}><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="cv-hint" style={{ display: "flex", alignItems: "center", gap: 6 }}><ShieldCheck size={13} /> Bound to {myEmail} via Microsoft Entra ID · encrypted at rest · readable by this account only.</p>
      {form && <PersonalForm row={form.row} onClose={() => setForm(null)} onSave={save} />}
      {gate && <PersonalLockGate userEmail={myEmail} onClose={() => setGate(false)} onUnlocked={onUnlocked} />}
    </div>
  );
}
