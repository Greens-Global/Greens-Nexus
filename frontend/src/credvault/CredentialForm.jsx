// Credential Vault - the modals (Oct 14 2026 rebuild): add / edit a company
// credential, CSV import, share with someone, request access. Built on the
// Tasks module's Modal (phone sheet, focus, unsaved-changes prompt) and its
// PersonSelect (the curated Nexus People list).
import { useMemo, useRef, useState } from "react";
import { Upload, Download, CheckCircle2, AlertCircle, Share2, Send } from "lucide-react";
import { Modal, PersonSelect } from "../tasks/components";
import { Field, PasswordField, TYPES, TIERS, parseCSV } from "./vaultShared";
import { DURATIONS, ROTATION_CHOICES } from "./vaultModel";

const EMPTY = { name: "", dept: "", type: "Password", tier: "Standard", username: "", secret: "", url: "", note: "", owner: "", backupOwner: "", rotationMax: 90, expiresAt: "" };

export function CredentialForm({ cred, depts, people, myEmail, onClose, onSave }) {
  const editing = !!cred;
  const [form, setForm] = useState(() => editing
    ? { ...EMPTY, name: cred.name, dept: cred.dept || "", type: cred.type, tier: cred.tier, username: cred.username === "-" ? "" : cred.username, url: cred.url || "", note: cred.note || "", owner: cred.owner || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, expiresAt: cred.expiresAt || "" }
    : { ...EMPTY, dept: depts[0] || "", owner: myEmail });
  const [initial] = useState(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const valid = form.name.trim() && (editing || form.secret) && form.dept;
  const deptChoices = useMemo(() => (form.dept && !depts.includes(form.dept) ? [form.dept, ...depts] : depts), [depts, form.dept]);

  async function save() {
    if (!valid) { setError(editing ? "A name and a department are needed." : "A name, a department and a password are needed."); return; }
    setSaving(true); setError("");
    try {
      await onSave({ ...form, customExpiry: form.rotationMax !== 90 });
    } catch (e) { setError(e?.message || "Could not save."); setSaving(false); return; }
    setSaving(false);
  }

  return (
    <Modal title={editing ? "Edit Credential" : "Add Credential"} onClose={onClose} isDirty={dirty} onSave={valid ? save : undefined}
      width="clamp(480px, 56vw, 760px)"
      footer={<>
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 12.5, marginRight: "auto" }}>{error}</span>}
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={save} disabled={!valid || saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Save Credential"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 0, animation: "none" }}>
        <div className="cv-form-stack">
          <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" placeholder="e.g. Stripe Dashboard" autoFocus /></Field>
          <div className="cv-form-grid">
            <Field label="Department" required>
              <select value={form.dept} onChange={(e) => set("dept", e.target.value)} className="cv-ipt">
                {!form.dept && <option value="">- Choose -</option>}
                {deptChoices.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          </div>
          <div className="cv-form-grid">
            <Field label="Username"><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" autoComplete="off" /></Field>
            <Field label="Tier">
              <select value={form.tier} onChange={(e) => set("tier", e.target.value)} className="cv-ipt">{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
            </Field>
          </div>
          <PasswordField value={form.secret} onChange={(v) => set("secret", v)} required={!editing}
            label={editing ? "New Password" : "Password"} placeholder={editing ? "Leave blank to keep the current password" : "Enter or generate a password"} />
          {editing && form.secret && <p className="cv-hint">Saving a new password counts as a rotation. The current one is kept as the previous password until the next rotation.</p>}
          <Field label="Link"><input value={form.url} onChange={(e) => set("url", e.target.value)} className="cv-ipt" placeholder="https://…" /></Field>
          <Field label="Notes"><textarea value={form.note} onChange={(e) => set("note", e.target.value)} className="cv-ipt" placeholder="Recovery hints, who to call, what this login is for. Shown only to people who can open the password." /></Field>
          <div className="cv-form-grid">
            <Field label="Rotate Every">
              <div className="cv-segment">
                {ROTATION_CHOICES.map((d) => <button key={d} type="button" className={`cv-btn${form.rotationMax === d ? " is-on" : ""}`} onClick={() => set("rotationMax", d)}>{d}d</button>)}
              </div>
            </Field>
            <Field label="Expires On">
              <input type="date" value={form.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} className="cv-ipt" />
            </Field>
          </div>
          <div className="cv-form-grid">
            <Field label="Owner">
              <PersonSelect value={form.owner} onChange={(v) => set("owner", v || myEmail)} people={people} placeholder="Choose the owner" />
            </Field>
            <Field label="Backup Owner">
              <PersonSelect value={form.backupOwner} onChange={(v) => set("backupOwner", v || "")} people={people.filter((p) => p.email !== form.owner)} placeholder="Nobody" />
            </Field>
          </div>
          <p className="cv-hint">
            {form.tier === "Critical"
              ? "Critical: only the owners and admins open it; everyone else asks and the owner (or an admin) approves timed access."
              : `Everyone in ${form.dept || "the department"} can open this credential. People in other departments can see it exists and ask for access.`}
          </p>
        </div>
      </div>
    </Modal>
  );
}

const TEMPLATE = `name,department,type,username,secret,tier,url,note
Stripe Dashboard,Accounting,Password,pay@example.com,CHANGE-ME-1!,High,https://dashboard.stripe.com,Finance team login
Jira,IT,Password,admin@example.com,CHANGE-ME-2!,Standard,https://example.atlassian.net,
`;

export function ImportModal({ depts, onClose, onImport }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const rows = useMemo(() => {
    if (!raw.trim()) return [];
    return parseCSV(raw).map((r) => {
      const errors = [];
      if (!r.name) errors.push("name");
      if (!r.department) errors.push("department");
      if (r.type && !TYPES.includes(r.type)) errors.push("type");
      if (r.tier && !TIERS.includes(r.tier)) errors.push("tier");
      if (!r.secret) errors.push("secret");
      return { data: { ...r, type: r.type || "Password", tier: r.tier || "Standard" }, valid: errors.length === 0, errors };
    });
  }, [raw]);
  const valid = rows.filter((r) => r.valid);
  const newDepts = [...new Set(valid.map((r) => r.data.department))].filter((d) => !depts.includes(d));
  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "credential-vault-import.csv"; a.click(); URL.revokeObjectURL(url);
  };
  const onFile = (e) => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => setRaw(String(rd.result)); rd.readAsText(f); };
  async function go() { setBusy(true); try { await onImport(valid.map((r) => r.data)); } finally { setBusy(false); } }

  return (
    <Modal title="Import Credentials" onClose={onClose} isDirty={!!raw.trim()} onSave={valid.length ? go : undefined} width="clamp(560px, 62vw, 900px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose CSV</button>
        <button type="button" className="cv-btn-dark" onClick={go} disabled={!valid.length || busy}>{busy ? "Importing…" : `Import ${valid.length || ""} Credential${valid.length === 1 ? "" : "s"}`}</button>
      </>}>
      <div className="cv-root" style={{ gap: 12, animation: "none" }}>
        <p className="cv-hint">Columns: name, department, type, username, secret, tier, url, note. Type and tier are optional. You become the owner of every imported credential.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="cv-btn" onClick={downloadTemplate}><Download size={14} /> Download Template</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        </div>
        {rows.length > 0 && (
          <div className="cv-list">
            <div style={{ padding: "8px 12px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              {valid.length} ready · {rows.length - valid.length} need fixing
            </div>
            <div className="cv-divide" style={{ maxHeight: 260, overflowY: "auto" }}>
              {rows.map((r, i) => (
                <div key={i} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  {r.valid ? <CheckCircle2 size={15} style={{ color: "var(--cv-ok)", flexShrink: 0 }} /> : <AlertCircle size={15} style={{ color: "var(--cv-bad)", flexShrink: 0 }} />}
                  <span className="cv-truncate" style={{ fontWeight: 500, flex: 1 }}>{r.data.name || <span style={{ color: "var(--text-muted)" }}>- no name -</span>}</span>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{r.data.department} · {r.data.tier}</span>
                  {!r.valid && <span style={{ fontSize: 11.5, color: "var(--cv-bad)", flexShrink: 0 }}>check: {r.errors.join(", ")}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {newDepts.length > 0 && <div className="cv-callout tone-warn"><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>New department name{newDepts.length > 1 ? "s" : ""}: {newDepts.join(", ")}. Only people whose People record uses the same spelling will be able to open these.</span></div>}
      </div>
    </Modal>
  );
}

export function ShareModal({ cred, people, nameOf, onClose, onSubmit }) {
  const [email, setEmail] = useState("");
  const [duration, setDuration] = useState("4h");
  const [busy, setBusy] = useState(false);
  const d = DURATIONS.find((x) => x.key === duration);
  async function go() { if (!email) return; setBusy(true); try { await onSubmit(email, d.ms, d.label); } finally { setBusy(false); } }
  return (
    <Modal title="Share Access" onClose={onClose} isDirty={!!email} onSave={email ? go : undefined} width="clamp(420px, 40vw, 560px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={go} disabled={!email || busy}><Share2 size={14} /> {busy ? "Sharing…" : "Share"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 14, animation: "none" }}>
        <p className="cv-hint" style={{ marginTop: -4 }}>{cred.name} · {cred.dept}</p>
        <Field label="Share With" required><PersonSelect value={email} onChange={(v) => setEmail(v || "")} people={people} placeholder="Choose a person" /></Field>
        <Field label="For">
          <div className="cv-segment">{DURATIONS.map((x) => <button key={x.key} type="button" className={`cv-btn${duration === x.key ? " is-on" : ""}`} onClick={() => setDuration(x.key)}>{x.label}</button>)}</div>
        </Field>
        <div className="cv-callout">
          <span>{email ? nameOf(email) : "They"} will see the password in their own Credential Vault for {d.label.toLowerCase()}, then it disappears. They need the Credential Vault grant to open the screen. You can end the access early from the drawer.</span>
        </div>
      </div>
    </Modal>
  );
}

export function RequestModal({ cred, nameOf, onClose, onSubmit }) {
  const [duration, setDuration] = useState("4h");
  const [busy, setBusy] = useState(false);
  const d = DURATIONS.find((x) => x.key === duration);
  async function go() { setBusy(true); try { await onSubmit(d.ms, d.label); } finally { setBusy(false); } }
  return (
    <Modal title="Request Access" onClose={onClose} width="clamp(420px, 40vw, 560px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={go} disabled={busy}><Send size={14} /> {busy ? "Sending…" : "Send Request"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 14, animation: "none" }}>
        <p className="cv-hint" style={{ marginTop: -4 }}>{cred.name} · {cred.dept} · owned by {nameOf(cred.owner)}</p>
        <Field label="For">
          <div className="cv-segment">{DURATIONS.map((x) => <button key={x.key} type="button" className={`cv-btn${duration === x.key ? " is-on" : ""}`} onClick={() => setDuration(x.key)}>{x.label}</button>)}</div>
        </Field>
        <div className="cv-callout"><span>{nameOf(cred.owner)} or an admin approves this. You get a bell notification when they decide, and the password shows here for {d.label.toLowerCase()} from then.</span></div>
      </div>
    </Modal>
  );
}
