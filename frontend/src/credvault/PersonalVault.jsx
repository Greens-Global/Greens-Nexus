// Passwords - the Personal section of the one list (Neil, 11/18/2026; it was
// its own tab since the Oct 14 2026 rebuild). Private to the signed-in
// account: nobody else, admins included, can read it. It sits folded and
// locked in the list; one password unlock opens it for the server's window
// (Settings > Security, Personal Vault unlock time) and it locks itself when
// that window ends or on Lock Now. Passwords stay readable while unlocked -
// no per-row timer. The list's search narrows it once it is open; "+ New >
// Personal Login" (`addSignal`) unlocks first when it has to.
import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, Eye, EyeOff, Copy, Check, Pencil, ShieldCheck, ExternalLink } from "lucide-react";
import { api } from "../api";
import HoldButton from "../ui/HoldButton";
import { formatTime } from "../lib/datetime";
import { Modal } from "../tasks/components";
import { PersonalLockGate, Field, PasswordField, TYPES } from "./vaultShared";
import { Monogram } from "./vaultCards";

function PersonalForm({ row, onClose, onSave }) {
  const editing = !!row;
  const [form, setForm] = useState({ name: row?.name || "", url: row?.url || "", username: row?.username === "-" ? "" : row?.username || "", secret: "", type: row?.type || "Password", note: row?.note || "" });
  const [initial] = useState(form);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.name.trim() && (editing || form.secret);
  async function save() { if (!valid) return; setBusy(true); try { await onSave(form); } finally { setBusy(false); } }
  return (
    <Modal title={editing ? "Edit Personal Login" : "Add Personal Login"} onClose={onClose} isDirty={JSON.stringify(form) !== JSON.stringify(initial)} onSave={valid ? save : undefined} width="clamp(440px, 44vw, 620px)"
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
        <PasswordField value={form.secret} onChange={(v) => set("secret", v)} required={!editing} label={editing ? "New Password" : "Password"} placeholder={editing ? "Unchanged if left blank" : "Enter or generate a password"} />
        <Field label="Link"><input value={form.url} onChange={(e) => set("url", e.target.value)} className="cv-ipt" placeholder="https://… (Open signs you in from the list)" /></Field>
        <Field label="Note"><input value={form.note} onChange={(e) => set("note", e.target.value)} className="cv-ipt" placeholder="Security question, recovery hint…" /></Field>
        <p className="cv-hint"><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Encrypted and private - not visible to any admin or team member.</p>
      </div>
    </Modal>
  );
}

export default function PersonalVault({ myEmail, flash, query = "", addSignal = 0, openSignal = 0 }) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [unlockedUntil, setUnlockedUntil] = useState(0);       // ms; 0 = locked
  const [gate, setGate] = useState(false);
  const [form, setForm] = useState(null);                      // null | { row }
  const [open, setOpen] = useState({});                        // id -> secret
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const unlocked = unlockedUntil > now;
  const wantAdd = useRef(false);
  const root = useRef(null);

  const load = useCallback(() => api.cvPersonal().then((r) => { setRows(r || []); setLoaded(true); }).catch(() => setLoaded(true)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (unlockedUntil && unlockedUntil <= now) { setOpen({}); setUnlockedUntil(0); flash("Personal Vault locked.", "info"); }
  }, [now, unlockedUntil, flash]);
  // "+ New > Personal Login": the form when it is open, the unlock first when it is not.
  const seenAdd = useRef(addSignal);
  useEffect(() => {
    if (addSignal === seenAdd.current) return;
    seenAdd.current = addSignal;
    if (unlockedUntil > Date.now()) setForm({ row: null }); else { wantAdd.current = true; setGate(true); }
  }, [addSignal, unlockedUntil]);
  // A deep link to Personal (the old tab's address, a bell): bring it into view and ask to unlock.
  const seenOpen = useRef(0);
  useEffect(() => {
    if (!openSignal || openSignal === seenOpen.current) return;
    seenOpen.current = openSignal;
    root.current?.scrollIntoView?.({ block: "center" });
    if (!(unlockedUntil > Date.now())) setGate(true);
  }, [openSignal, unlockedUntil]);

  function lock() { setOpen({}); setUnlockedUntil(0); flash("Personal Vault locked.", "info"); }
  function onUnlocked(res) {
    setGate(false);
    setUnlockedUntil(Date.now() + ((res?.expiresInSec || 600) * 1000));
    flash("Personal Vault unlocked.");
    if (wantAdd.current) { wantAdd.current = false; setForm({ row: null }); }
  }
  const relock = (e) => { if (e?.status === 403) { setUnlockedUntil(0); setGate(true); return true; } return false; };
  async function reveal(r) {
    try { const res = await api.cvPersonalReveal(r.id); setOpen((o) => ({ ...o, [r.id]: res.secret })); }
    catch (e) { if (!relock(e)) flash(e?.message || "Could not reveal.", "info"); }
  }
  function copy(text, id) {
    try { navigator.clipboard?.writeText(text); } catch { /* blocked */ }
    setCopied(id); setTimeout(() => setCopied((c) => (c === id ? "" : c)), 1400);
  }
  // Copy from the row: fetched for the copy when it is not on screen, never shown.
  async function copyPassword(r) {
    let secret = open[r.id];
    if (!secret) {
      try { secret = (await api.cvPersonalReveal(r.id)).secret; }
      catch (e) { if (!relock(e)) flash(e?.message || "Could not copy.", "info"); return; }
    }
    copy(secret, r.id);
  }
  // Open (Oct 29 2026): copy the password, then open the site - same as the
  // company rows. The clipboard cannot be written once the new tab has focus.
  async function openSite(r) {
    let secret = open[r.id];
    if (!secret) {
      try { secret = (await api.cvPersonalReveal(r.id)).secret; }
      catch (e) { if (!relock(e)) flash(e?.message || "Could not open.", "info"); return; }
    }
    copy(secret, r.id);
    window.open(r.url, "_blank", "noopener,noreferrer");
    flash(`Password copied - paste it on the site.${r.username && r.username !== "-" ? ` Username: ${r.username}` : ""}`);
  }
  async function save(f) {
    if (form?.row) await api.cvPersonalUpdate(form.row.id, f); else await api.cvPersonalCreate(f);
    setForm(null); setOpen((o) => { const n = { ...o }; if (form?.row) delete n[form.row.id]; return n; });
    await load();
    flash(form?.row ? "Personal login updated." : "Saved to your Personal Vault.");
  }
  // Held on the row (Neil, Oct 30 2026 - hold to confirm): one record, no
  // dialog. A refusal throws so the button rewinds with the reason.
  async function remove(r) {
    try { await api.cvPersonalDelete(r.id); } catch (e) { throw new Error(e?.message || "Could not delete.", { cause: e }); }
    await load(); flash("Deleted.");
  }

  const gateEl = gate && <PersonalLockGate userEmail={myEmail} onClose={() => { wantAdd.current = false; setGate(false); }} onUnlocked={onUnlocked} />;

  if (!unlocked) {
    const none = loaded && rows.length === 0;
    return (
      <div ref={root} data-personal="locked">
        <button type="button" className="cv-fold" onClick={() => setGate(true)} aria-expanded="false"
          title={`Your own passwords, encrypted and bound to ${myEmail}. Not visible to any admin or team member.`}>
          <Lock size={14} />
          <span><strong>Personal</strong> - {loaded && rows.length ? `${rows.length}, ` : ""}private to you</span>
          <span className="cv-fold-hint">{none ? "Set Up Personal Vault" : "Unlock"}</span>
        </button>
        {gateEl}
      </div>
    );
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => { const hay = `${r.name} ${r.username} ${r.note} ${r.url} ${r.type}`.toLowerCase(); return words.every((w) => hay.includes(w)); });

  return (
    <section ref={root} data-personal="open">
      <h3 className="cv-sec cv-sec-row">
        <span>Personal</span>
        <span className="cv-sec-note">private to you - unlocked, locks at {formatTime(new Date(unlockedUntil))}</span>
        <button type="button" className="cv-sum-btn" onClick={lock}>Lock Now</button>
        <button type="button" className="cv-sum-btn" onClick={() => setForm({ row: null })}>Add</button>
      </h3>
      {rows.length === 0 && <div className="cv-none"><strong>Nothing here yet</strong><span>Add the passwords only you should hold. They never leave this account.</span></div>}
      {rows.length > 0 && shown.length === 0 && <div className="cv-none"><span>No personal login matches.</span></div>}
      {shown.map((r) => {
        const secret = open[r.id];
        const hasUser = r.username && r.username !== "-";
        return (
          <div key={r.id} className="cv-l" data-personal-row={r.id}>
            <span className="cv-l-open is-plain">
              <Monogram name={r.name} dept="" depts={[]} size={34} />
              <span className="cv-l-main">
                <span className="cv-l-name"><span>{r.name}</span></span>
                <span className="cv-l-sub">{[hasUser ? r.username : "no username", r.type && r.type !== "Password" ? r.type : "", r.note].filter(Boolean).join(" - ")}</span>
                {secret && <span className="cv-mono cv-l-secret">{secret}</span>}
              </span>
            </span>
            <span className="cv-l-acts">
              {hasUser && <button type="button" className={`cv-l-btn is-x${copied === r.id + ":u" ? " is-done" : ""}`} title="Copy Username" aria-label="Copy Username" onClick={() => copy(r.username, r.id + ":u")}>{copied === r.id + ":u" ? <Check size={13} /> : <Copy size={13} />} User</button>}
              {secret
                ? <button type="button" className="cv-l-btn is-x" title="Hide" aria-label="Hide Password" onClick={() => setOpen((o) => { const n = { ...o }; delete n[r.id]; return n; })}><EyeOff size={13} /> Hide</button>
                : <button type="button" className="cv-l-btn is-x" title="Reveal" aria-label="Reveal Password" onClick={() => reveal(r)}><Eye size={13} /> Show</button>}
              <button type="button" className="cv-l-btn is-x" title="Edit" aria-label="Edit" onClick={() => setForm({ row: r })}><Pencil size={13} /> Edit</button>
              <span className="is-x"><HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete ${r.name}`} onConfirm={() => remove(r)}
                fallbackMessage={`Delete ${r.name} from your Personal Vault? There is no trash for personal logins.`} /></span>
              {r.url && <button type="button" className={`cv-l-btn is-x${copied === r.id ? " is-done" : ""}`} title="Copy Password" aria-label="Copy Password" onClick={() => copyPassword(r)}>{copied === r.id ? <Check size={13} /> : <Copy size={13} />} Password</button>}
              {r.url
                ? <button type="button" className="cv-l-btn" title="Copy the password and open the site" aria-label={`Open ${r.name}`} onClick={() => openSite(r)}><ExternalLink size={13} /> Open</button>
                : <button type="button" className={`cv-l-btn${copied === r.id ? " is-done" : ""}`} title="Copy Password" aria-label="Copy Password" onClick={() => copyPassword(r)}>{copied === r.id ? <Check size={13} /> : <Copy size={13} />} Copy</button>}
            </span>
          </div>
        );
      })}
      <p className="cv-hint cv-personal-foot"><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Bound to {myEmail} via Microsoft Entra ID - encrypted at rest - readable by this account only.</p>
      {form && <PersonalForm row={form.row} onClose={() => setForm(null)} onSave={save} />}
      {gateEl}
    </section>
  );
}
