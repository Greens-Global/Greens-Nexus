// Credential Vault - the modals (Oct 14 2026 rebuild): add / edit a company
// credential, CSV import, share with someone, request access. Built on the
// Tasks module's Modal (phone sheet, focus, unsaved-changes prompt) and its
// PersonSelect (the curated Nexus People list).
import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Download, CheckCircle2, AlertCircle, Share2, Send, Users, Building2, X, Eye, EyeOff } from "lucide-react";
import { api } from "../api";
import { Modal, PersonSelect, DateField } from "../tasks/components";
import { Field, PasswordField, TYPES, TIERS, parseCSV } from "./vaultShared";
import { DURATIONS, ROTATION_CHOICES, audienceKey } from "./vaultModel";

const EMPTY = { name: "", dept: "", type: "Password", tier: "Standard", username: "", secret: "", url: "", note: "", owner: "", backupOwner: "", rotationMax: 90, expiresAt: "" };
const deptAudience = (dept) => (dept ? [{ kind: "department", value: dept, level: "open", label: `Everyone in ${dept}` }] : []);

// Who may open the credential (Oct 29 2026, vault_access.py): rows of
// company / department / Access Group / person, each openable or view-only.
// A new credential starts with its own department and follows the Department
// box until the owner touches the list.
export function AudiencePicker({ value, onChange, people, tier, nameOf = (e) => e }) {
  const [opts, setOpts] = useState({ companies: [], departments: [], groups: [] });
  const [pick, setPick] = useState("");
  const [person, setPerson] = useState("");
  useEffect(() => { api.cvAudienceOptions().then((o) => setOpts({ companies: o?.companies || [], departments: o?.departments || [], groups: o?.groups || [] })).catch(() => {}); }, []);
  const has = (a) => value.some((x) => audienceKey(x) === audienceKey(a));
  const add = (a) => { if (!has(a)) onChange([...value, { level: "open", ...a }]); };
  const deptNames = [...new Set(opts.departments.map((d) => d.name))];
  function addPicked(v) {
    setPick("");
    if (!v) return;
    const [kind, ...rest] = v.split(":"); const val = rest.join(":");
    if (kind === "company") add({ kind, value: val, label: val ? `Everyone at ${opts.companies.find((c) => c.id === val)?.name || ""}` : "Everyone, every company" });
    if (kind === "department") add({ kind, value: val, label: `Everyone in ${val}` });
    if (kind === "group") add({ kind, value: val, label: opts.groups.find((g) => g.id === val)?.name || "Access Group" });
  }
  return (
    <div className="cv-audience" data-audience-picker="">
      {value.length === 0 && <p className="cv-hint">Only the owners and admins. Add who else may open it.</p>}
      {value.map((a) => (
        <div className="cv-person" key={audienceKey(a)} data-audience={audienceKey(a)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            {a.kind === "person" ? <Users size={13} /> : <Building2 size={13} />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.kind === "person" ? nameOf(a.value) : a.label}</span>
            {tier === "Critical" && a.kind !== "person" && <span className="cv-chip cv-chip-xs tone-warn" title="Critical: only named people open it">Ignored for Critical</span>}
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <button type="button" className={`cv-chip cv-chip-xs${a.level === "view" ? "" : " tone-ok"}`} style={{ cursor: "pointer", border: "none" }}
              title={a.level === "view" ? "Sees the login, never the password - click to let them open it" : "Can open the password - click to make it view only"}
              aria-label={`${a.level === "view" ? "View only" : "Can open"}: ${a.label || a.value}`}
              onClick={() => onChange(value.map((x) => (audienceKey(x) === audienceKey(a) ? { ...x, level: x.level === "view" ? "open" : "view" } : x)))}>
              {a.level === "view" ? <><EyeOff size={11} /> View Only</> : <><Eye size={11} /> Can Open</>}
            </button>
            <button type="button" className="cv-iconbtn is-danger" aria-label={`Remove ${a.label || a.value}`} onClick={() => onChange(value.filter((x) => audienceKey(x) !== audienceKey(a)))}><X size={13} /></button>
          </span>
        </div>
      ))}
      <div className="cv-form-grid" style={{ marginTop: 8 }}>
        <select value={pick} onChange={(e) => addPicked(e.target.value)} className="cv-ipt" aria-label="Add a company, department or group">
          <option value="">Add a company, department or group…</option>
          {opts.companies.length > 0 && <optgroup label="Everyone at">{opts.companies.map((c) => <option key={c.id} value={`company:${c.id}`}>{c.name}</option>)}</optgroup>}
          {deptNames.length > 0 && <optgroup label="Departments">{deptNames.map((d) => <option key={d} value={`department:${d}`}>{d}</option>)}</optgroup>}
          {opts.groups.length > 0 && <optgroup label="Access Groups">{opts.groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup>}
        </select>
        <PersonSelect value={person} onChange={(v) => { setPerson(""); if (v) add({ kind: "person", value: v, label: v }); }} people={people} placeholder="Add a person" />
      </div>
    </div>
  );
}

export function CredentialForm({ cred, depts, people, myEmail, nameOf, onClose, onSave }) {
  const editing = !!cred;
  const [form, setForm] = useState(() => editing
    ? { ...EMPTY, name: cred.name, dept: cred.dept || "", type: cred.type, tier: cred.tier, username: cred.username === "-" ? "" : cred.username, url: cred.url || "", note: cred.note || "", owner: cred.owner || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, expiresAt: cred.expiresAt || "",
      // A credential from before audiences (no rows) is still opened by its own
      // department unless Critical - show that, so saving writes it out as a row.
      audiences: cred.audiences?.length ? cred.audiences : (cred.tier === "Critical" ? [] : deptAudience(cred.dept || "")) }
    : { ...EMPTY, dept: depts[0] || "", owner: myEmail, audiences: deptAudience(depts[0] || "") });
  const [initial] = useState(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // The department box leads the audience until the owner edits the list.
  const setDept = (d) => setForm((f) => ({ ...f, dept: d, audiences: JSON.stringify(f.audiences) === JSON.stringify(deptAudience(f.dept)) ? deptAudience(d) : f.audiences }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const valid = form.name.trim() && (editing || form.secret) && form.dept;
  const deptChoices = useMemo(() => (form.dept && !depts.includes(form.dept) ? [form.dept, ...depts] : depts), [depts, form.dept]);

  async function save() {
    if (!valid) { setError(editing ? "A name and a department are needed." : "A name, a department and a password are needed."); return; }
    setSaving(true); setError("");
    try {
      await onSave({ ...form, customExpiry: form.rotationMax !== 90, audiences: form.audiences.map(({ kind, value, level }) => ({ kind, value, level })) });
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
              <select value={form.dept} onChange={(e) => setDept(e.target.value)} className="cv-ipt">
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
              <DateField value={form.expiresAt} onChange={(v) => set("expiresAt", v || "")} placeholder="MM/DD/YYYY" title="Hard expiry (API keys, certificates)" />
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
          <Field label="Who Can Open It">
            <AudiencePicker value={form.audiences} onChange={(v) => set("audiences", v)} people={people} tier={form.tier} nameOf={nameOf} />
          </Field>
          <p className="cv-hint">
            {form.tier === "Critical"
              ? "Critical: only the owners, the department head, admins and the people named above open it. Everyone else asks, and the owner (or the head, or an admin) approves timed access."
              : "Everyone else with Credentials can see that this login exists and ask for timed access. The department's head and backup head manage it along with the owners."}
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
          <span>{email ? nameOf(email) : "They"} will see the password in their own Credentials screen for {d.label.toLowerCase()}, then it disappears. They need the Credentials grant to open the screen. You can end the access early from the drawer.</span>
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
