// Credential Vault - the modals (Oct 14 2026 rebuild): add / edit a company
// credential, CSV import, share with someone, request access. Built on the
// Tasks module's Modal (phone sheet, focus, unsaved-changes prompt) and its
// PersonSelect (the curated Nexus People list).
import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, CheckCircle2, AlertCircle, Share2, Send, Users, Building2, X, Eye, EyeOff } from "lucide-react";
import { api } from "../api";
import { Modal, PersonSelect, DateField } from "../tasks/components";
import { Field, PasswordField, TYPES, TIERS } from "./vaultShared";
import { DURATIONS, ROTATION_CHOICES, audienceKey, siteOf } from "./vaultModel";
import { FIELDS, guessMap, applyMap, validateRows, findDuplicates, toPayload } from "./importModel";

const EMPTY = { name: "", dept: "", type: "Password", tier: "Standard", username: "", secret: "", url: "", note: "", owner: "", backupOwner: "", rotationMax: 90, expiresAt: "", totpSecret: "", clearTotp: false };
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
          <Field label={cred?.hasTotp && !form.clearTotp ? "Authenticator Key (set)" : "Authenticator Key"}>
            {cred?.hasTotp && !form.clearTotp ? (
              <div className="cv-form-grid" style={{ alignItems: "center" }}>
                <input value={form.totpSecret} onChange={(e) => set("totpSecret", e.target.value)} className="cv-ipt" placeholder="Leave blank to keep the current key" autoComplete="off" />
                <button type="button" className="cv-btn" onClick={() => set("clearTotp", true)}>Remove Authenticator</button>
              </div>
            ) : (
              <input value={form.totpSecret} onChange={(e) => { set("totpSecret", e.target.value); set("clearTotp", false); }} className="cv-ipt" placeholder="The text under the site's QR code, or the otpauth:// link" autoComplete="off" />
            )}
            <p className="cv-hint" style={{ marginTop: 4 }}>For logins with two-step sign-in: whoever can open this credential gets the current 6-digit code too, so nobody waits on one person's phone.</p>
          </Field>
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

// ── Import (Oct 29 2026): the Excel sheet people actually have ─────────────
// Four steps: pick the file (.xlsx, .xls or .csv), match its columns to our
// fields (guessed from the headers, corrected on screen), review - what is
// missing, what the vault already holds, the department to fall back to, a
// backup owner and who can open them - then the result, with a nudge to
// retire the spreadsheet. Passwords stay in the browser until Import.
const STEP_TITLES = ["Choose the File", "Match the Columns", "Review", "Done"];

export function ImportWizard({ depts, people, myEmail, existing = [], nameOf = (e) => e, onClose, onImport }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [sheet, setSheet] = useState(null);            // { headers: [], rows: [[]] , sheets: [names], name }
  const [map, setMap] = useState({});
  const [defaultDept, setDefaultDept] = useState(depts[0] || "");
  const [backupOwner, setBackupOwner] = useState("");
  const [everyone, setEveryone] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [skipDups, setSkipDups] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => { api.cvAudienceOptions().then((o) => { setCompanies(o?.companies || []); setCompanyId((o?.companies || [])[0]?.id || ""); }).catch(() => {}); }, []);

  async function readFile(f) {
    setError("");
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
      if (!grid.length) { setError("The sheet is empty."); return; }
      const headers = grid[0].map((h) => String(h ?? "").trim());
      setSheet({ headers, rows: grid.slice(1), name: wb.SheetNames[0], sheets: wb.SheetNames.length });
      setMap(guessMap(headers));
      setFile(f);
      setStep(1);
    } catch { setError("Could not read that file. Save it as .xlsx or .csv and try again."); }
  }
  const mapped = useMemo(() => (sheet ? applyMap(sheet.rows, map) : []), [sheet, map]);
  const reviewed = useMemo(() => findDuplicates(validateRows(mapped, { defaultDept }), existing), [mapped, defaultDept, existing]);
  const ready = reviewed.filter((r) => r.ok && !(skipDups && r.duplicateOf));
  const dups = reviewed.filter((r) => r.duplicateOf);
  const bad = reviewed.filter((r) => !r.ok);
  const mapOk = map.name != null && map.secret != null;

  async function run() {
    setBusy(true); setError("");
    try {
      const res = await onImport(ready.map((r) => toPayload(r, { backupOwner, everyone, companyId })));
      setResult({ imported: res?.imported || 0, skipped: res?.skipped || 0, sent: ready.length, bad: bad.length, dups: skipDups ? dups.length : 0 });
      setStep(3);
    } catch (e) { setError(e?.message || "Import failed."); }
    setBusy(false);
  }
  const Steps = (
    <div className="cv-steps" aria-label="Steps">
      {STEP_TITLES.map((t, i) => <span key={t} className={`cv-step${i === step ? " is-on" : i < step ? " is-done" : ""}`}>{i < step ? <CheckCircle2 size={13} /> : <span className="cv-step-n">{i + 1}</span>} {t}</span>)}
    </div>
  );
  return (
    <Modal title="Import Logins From a Spreadsheet" onClose={onClose} isDirty={step > 0 && step < 3} width="clamp(560px, 64vw, 920px)"
      footer={<>
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 12.5, marginRight: "auto" }}>{error}</span>}
        {step === 3 ? <button type="button" className="cv-btn-dark" onClick={onClose}>Done</button> : (<>
          <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
          {step > 0 && <button type="button" className="cv-btn" onClick={() => setStep(step - 1)}>Back</button>}
          {step === 1 && <button type="button" className="cv-btn-dark" onClick={() => setStep(2)} disabled={!mapOk}>Review {mapped.length} Row{mapped.length === 1 ? "" : "s"}</button>}
          {step === 2 && <button type="button" className="cv-btn-dark" onClick={run} disabled={busy || !ready.length}>{busy ? "Importing…" : `Import ${ready.length} Login${ready.length === 1 ? "" : "s"}`}</button>}
        </>)}
      </>}>
      <div className="cv-root cv-form-stack" style={{ animation: "none" }}>
        {Steps}
        {step === 0 && (
          <div className="cv-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}>
            <Upload size={26} style={{ opacity: .5 }} />
            <strong>Drop your password spreadsheet here</strong>
            <span className="cv-hint">Excel (.xlsx, .xls) or CSV. Any column names - you match them on the next step. The first sheet is read; passwords stay in your browser until you click Import.</span>
            <button type="button" className="cv-btn-dark" onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose File</button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }} style={{ display: "none" }} />
          </div>
        )}
        {step === 1 && sheet && (<>
          <p className="cv-hint"><b>{file?.name}</b> · sheet "{sheet.name}"{sheet.sheets > 1 ? ` (first of ${sheet.sheets})` : ""} · {sheet.rows.length} row{sheet.rows.length === 1 ? "" : "s"}. Say which column holds what; Name and Password are needed.</p>
          <div className="cv-map">
            {FIELDS.map((f) => (
              <label key={f.key} className="cv-map-row">
                <span className="cv-map-label">{f.label}{f.required && <span style={{ color: "var(--cv-bad)" }}> *</span>}</span>
                <select className="cv-ipt" value={map[f.key] ?? ""} onChange={(e) => setMap((m) => { const n = { ...m }; if (e.target.value === "") delete n[f.key]; else n[f.key] = Number(e.target.value); return n; })} aria-label={`Column for ${f.label}`}>
                  <option value="">{f.required ? "- choose a column -" : "- not in the sheet -"}</option>
                  {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
                <span className="cv-map-sample">{map[f.key] != null ? String(sheet.rows[0]?.[map[f.key]] ?? "") : ""}</span>
              </label>
            ))}
          </div>
        </>)}
        {step === 2 && (<>
          <div className="cv-form-grid">
            <Field label="Department When the Sheet Has None">
              <select value={defaultDept} onChange={(e) => setDefaultDept(e.target.value)} className="cv-ipt">
                <option value="">- none -</option>{depts.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Backup Owner for Every Login">
              <PersonSelect value={backupOwner} onChange={(v) => setBackupOwner(v || "")} people={people.filter((p) => p.email !== myEmail)} placeholder="Nobody" />
            </Field>
          </div>
          <Field label="Who Can Open Them">
            <div className="cv-segment" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <button type="button" className={`cv-btn${!everyone ? " is-on" : ""}`} onClick={() => setEveryone(false)}>Each login's department</button>
              <button type="button" className={`cv-btn${everyone ? " is-on" : ""}`} onClick={() => setEveryone(true)} disabled={!companies.length}>Everyone at {companies.length > 1 ? "a company" : companies[0]?.name || "the company"}</button>
            </div>
            {everyone && companies.length > 1 && (
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="cv-ipt" style={{ marginTop: 8 }} aria-label="Company">{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            )}
          </Field>
          <p className="cv-hint">You own every imported login. Change the owner, audience or tier on any of them afterwards.</p>
          <div className="cv-import-summary">
            <span className="cv-chip tone-ok"><CheckCircle2 size={12} /> {ready.length} ready</span>
            {dups.length > 0 && (
              <label className="cv-chip tone-warn" style={{ cursor: "pointer", gap: 6 }}>
                <input type="checkbox" checked={skipDups} onChange={(e) => setSkipDups(e.target.checked)} style={{ margin: 0 }} /> skip {dups.length} already in the vault
              </label>
            )}
            {bad.length > 0 && <span className="cv-chip tone-bad"><AlertCircle size={12} /> {bad.length} will be left out</span>}
          </div>
          <div className="cv-list" style={{ maxHeight: 300, overflowY: "auto" }}>
            {reviewed.map((r) => (
              <div key={r.line} className="cv-row" style={{ gridTemplateColumns: "22px minmax(0,1fr) auto", borderTop: "none", borderBottom: "1px solid var(--line)" }} data-import-row={r.line}>
                {r.ok && !(skipDups && r.duplicateOf) ? <CheckCircle2 size={15} style={{ color: "var(--cv-ok)" }} /> : <AlertCircle size={15} style={{ color: r.ok ? "var(--cv-warn)" : "var(--cv-bad)" }} />}
                <div className="cv-row-main">
                  <div className="cv-name"><span>{r.name || <i style={{ color: "var(--text-muted)" }}>no name</i>}</span>{r.tier !== "Standard" && <span className="cv-chip cv-chip-xs">{r.tier}</span>}</div>
                  <div className="cv-sub">{[r.dept, r.username, siteOf(r.url)].filter(Boolean).join(" · ") || "-"}</div>
                </div>
                <span className="cv-hint" style={{ textAlign: "right" }}>
                  {r.problems.join(", ")}{r.duplicateOf ? `${r.problems.length ? " · " : ""}already in the vault as ${r.duplicateOf.name}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>)}
        {step === 3 && result && (
          <div className="cv-empty" style={{ padding: "28px 20px" }}>
            <CheckCircle2 size={34} style={{ color: "var(--cv-ok)", display: "block", margin: "0 auto 10px" }} />
            <strong>{result.imported} login{result.imported === 1 ? "" : "s"} imported</strong>
            {result.skipped + result.dups > 0 ? `${result.skipped + result.dups} already in the vault were skipped. ` : ""}{result.bad > 0 ? `${result.bad} row${result.bad === 1 ? "" : "s"} had no name, password or department and were left out. ` : ""}
            <p className="cv-hint" style={{ marginTop: 12 }}>They are in My Logins now, owned by you{backupOwner ? ` with ${nameOf(backupOwner)} as backup` : ""}. The spreadsheet can go: delete it, and tell the team the vault is the place from now on.</p>
          </div>
        )}
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
