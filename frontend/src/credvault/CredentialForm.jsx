// Credential Vault - the modals (Oct 14 2026 rebuild): add / edit a company
// credential, CSV import, share with someone, request access. Built on the
// Tasks module's Modal (phone sheet, focus, unsaved-changes prompt) and its
// PersonSelect (the curated Nexus People list).
import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, CheckCircle2, AlertCircle, Share2, Send, Users, Building2, X, Eye, EyeOff, Check } from "lucide-react";
import { api } from "../api";
import { Modal, PersonSelect, PersonMultiSelect, DateField } from "../tasks/components";
import { Field, PasswordField, TYPES, TIERS } from "./vaultShared";
import { DURATIONS, ROTATION_CHOICES, audienceKey, siteOf, localDay } from "./vaultModel";
import { formatDate, formatTime } from "../lib/datetime";
import { FIELDS, guessMap, applyMap, validateRows, findDuplicates, toPayload } from "./importModel";

const EMPTY = { name: "", dept: "", type: "Password", tier: "Standard", username: "", secret: "", url: "", note: "", owner: "", backupOwner: "", rotationMax: 90, expiresAt: "", totpSecret: "", clearTotp: false, siteId: "" };
// The department's own audience row. With several companies the key carries the
// company ("co-1:Operations"), the same key the picker's chips use - a plain
// "Operations" beside it listed the department twice (11/13/2026).
const deptAudience = (dept, companyId = "") => (dept ? [{ kind: "department", value: companyId ? `${companyId}:${dept}` : dept, level: "open", label: `Everyone in ${dept}` }] : []);
const deptName = (a) => String(a.value || "").split(":").pop();
// Work sites a company uses (or every site when the login has no company yet).
export const sitesFor = (sites, companyId) => sites.filter((x) => !companyId || !x.companyIds?.length || x.companyIds.includes(companyId));

// Who may open the credential (Oct 29 2026, vault_access.py): rows of
// company / department / Access Group / person, each openable or view-only.
// A new credential starts with its own department and follows the Department
// box until the owner touches the list.
export function AudiencePicker({ value, onChange, people, tier, nameOf = (e) => e, companyId = "" }) {
  const [opts, setOpts] = useState({ companies: [], departments: [], groups: [] });
  const [person, setPerson] = useState("");
  const [allGroups, setAllGroups] = useState(false);
  useEffect(() => { api.cvAudienceOptions().then((o) => setOpts({ companies: o?.companies || [], departments: o?.departments || [], groups: o?.groups || [] })).catch(() => {}); }, []);
  const keyOf = audienceKey;
  const has = (a) => value.some((x) => keyOf(x) === keyOf(a));
  const toggle = (a) => onChange(has(a) ? value.filter((x) => keyOf(x) !== keyOf(a)) : [...value, { level: "open", ...a }]);
  const companyName = (id) => opts.companies.find((c) => c.id === id)?.name || "";
  const pickedCompanies = value.filter((a) => a.kind === "company" && a.value).map((a) => a.value);
  const everyCompany = value.some((a) => a.kind === "company" && !a.value);
  // Departments offered: those of the companies picked above, else of the
  // credential's own company, else every company's. One company in Nexus =
  // plain names; several = "IT · Greens Nexus", stored as "companyId:IT".
  const scopeIds = pickedCompanies.length ? pickedCompanies : companyId ? [companyId] : opts.companies.map((c) => c.id);
  const multi = opts.companies.length > 1;
  const deptRows = opts.departments.filter((d) => !multi || scopeIds.includes(d.companyId));
  const deptAud = (d) => ({ kind: "department", value: multi && d.companyId ? `${d.companyId}:${d.name}` : d.name, label: `Everyone in ${d.name}${multi && d.companyId ? ` at ${companyName(d.companyId)}` : ""}` });
  // A plain "Operations" row (older logins) is the same department as its own company's chip.
  const plainOf = (d) => ({ kind: "department", value: d.name });
  const isOwnPlain = (d, x) => multi && d.companyId === companyId && keyOf(x) === keyOf(plainOf(d));
  const deptOn = (d) => has(deptAud(d)) || value.some((x) => isOwnPlain(d, x));
  const toggleDept = (d) => (deptOn(d)
    ? onChange(value.filter((x) => keyOf(x) !== keyOf(deptAud(d)) && !isOwnPlain(d, x)))
    : toggle(deptAud(d)));
  // Access Groups follow the departments picked (11/13/2026): only the groups
  // whose people work there, plus any already chosen; Show All lists the rest.
  const pickedDepts = new Set(value.filter((a) => a.kind === "department").map((a) => deptName(a).toLowerCase()));
  const groupHas = (g) => has({ kind: "group", value: g.id });
  const shownGroups = allGroups || !pickedDepts.size ? opts.groups
    : opts.groups.filter((g) => groupHas(g) || (g.departments || []).some((d) => pickedDepts.has(d.toLowerCase())));
  const Chip = ({ on, children, onClick, title }) => (
    <button type="button" className={`cv-pick${on ? " is-on" : ""}`} aria-pressed={on} onClick={onClick} title={title}>{on && <Check size={11} />}{children}</button>
  );
  return (
    <div className="cv-audience" data-audience-picker="">
      <div className="cv-pick-group">
        <span className="cv-pick-label">Companies</span>
        <div className="cv-pick-row">
          <Chip on={everyCompany} onClick={() => toggle({ kind: "company", value: "", label: "Everyone, every company" })}>All Companies</Chip>
          {opts.companies.map((c) => <Chip key={c.id} on={pickedCompanies.includes(c.id)} onClick={() => toggle({ kind: "company", value: c.id, label: `Everyone at ${c.name}` })}>{c.name}</Chip>)}
        </div>
      </div>
      <div className="cv-pick-group">
        <span className="cv-pick-label">Departments{multi && pickedCompanies.length ? ` at ${pickedCompanies.map(companyName).join(", ")}` : ""}</span>
        <div className="cv-pick-row">
          {deptRows.length === 0 && <span className="cv-hint">No departments set up under Settings &gt; Companies.</span>}
          {deptRows.map((d) => { return <Chip key={`${d.companyId}:${d.name}`} on={deptOn(d)} onClick={() => toggleDept(d)}>{d.name}{multi && pickedCompanies.length !== 1 && d.companyId ? <span className="cv-pick-sub"> · {companyName(d.companyId)}</span> : null}</Chip>; })}
        </div>
      </div>
      {opts.groups.length > 0 && (
        <div className="cv-pick-group" data-groups-shown={shownGroups.length}>
          <span className="cv-pick-label">Access Groups{pickedDepts.size && !allGroups ? " in These Departments" : ""}</span>
          <div className="cv-pick-row">
            {shownGroups.length === 0 && <span className="cv-hint">No Access Group has people in the departments picked.</span>}
            {shownGroups.map((g) => <Chip key={g.id} on={groupHas(g)} onClick={() => toggle({ kind: "group", value: g.id, label: g.name })}>{g.name}</Chip>)}
            {pickedDepts.size > 0 && shownGroups.length < opts.groups.length && !allGroups && (
              <button type="button" className="cv-link" onClick={() => setAllGroups(true)}>Show All Groups ({opts.groups.length})</button>
            )}
            {allGroups && pickedDepts.size > 0 && <button type="button" className="cv-link" onClick={() => setAllGroups(false)}>Only These Departments</button>}
          </div>
        </div>
      )}
      <div className="cv-pick-group">
        <span className="cv-pick-label">People</span>
        <PersonSelect value={person} onChange={(v) => { setPerson(""); if (v && !has({ kind: "person", value: v })) onChange([...value, { kind: "person", value: v, level: "open", label: v }]); }} people={people} placeholder="Add a person" />
      </div>
      {value.length === 0 ? <p className="cv-hint">Only the owners, the department head and admins. Pick who else may open it above.</p> : (
        <div className="cv-audience-rows">
          {value.map((a) => (
            <div className="cv-person" key={keyOf(a)} data-audience={keyOf(a)}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                {a.kind === "person" ? <Users size={13} /> : <Building2 size={13} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.kind === "person" ? nameOf(a.value) : a.label}</span>
                {tier === "Critical" && a.kind !== "person" && <span className="cv-chip cv-chip-xs tone-warn" title="Critical: only named people open it">Ignored for Critical</span>}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <button type="button" className={`cv-chip cv-chip-xs${a.level === "view" ? "" : " tone-ok"}`} style={{ cursor: "pointer", border: "none" }}
                  title={a.level === "view" ? "Sees the login, never the password - click to let them open it" : "Can open the password - click to make it view only"}
                  aria-label={`${a.level === "view" ? "View only" : "Can open"}: ${a.label || a.value}`}
                  onClick={() => onChange(value.map((x) => (keyOf(x) === keyOf(a) ? { ...x, level: x.level === "view" ? "open" : "view" } : x)))}>
                  {a.level === "view" ? <><EyeOff size={11} /> View Only</> : <><Eye size={11} /> Can Open</>}
                </button>
                <button type="button" className="cv-iconbtn is-danger" aria-label={`Remove ${a.label || a.value}`} onClick={() => onChange(value.filter((x) => keyOf(x) !== keyOf(a)))}><X size={13} /></button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CredentialForm({ cred, depts, people, myEmail, nameOf, onClose, onSave, companies = [], deptRows = [], sites = [], myCompanyId = "" }) {
  const editing = !!cred;
  const multi = companies.length > 1;
  const ownAud = (dept, companyId) => deptAudience(dept, multi ? companyId : "");
  const [form, setForm] = useState(() => editing
    ? { ...EMPTY, name: cred.name, dept: cred.dept || "", type: cred.type, tier: cred.tier, username: cred.username === "-" ? "" : cred.username, url: cred.url || "", note: cred.note || "", owner: cred.owner || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, expiresAt: cred.expiresAt || "", companyId: cred.companyId || myCompanyId || "", siteId: cred.siteId || "",
      // A credential from before audiences (no rows) is still opened by its own
      // department unless Critical - show that, so saving writes it out as a row.
      audiences: cred.audiences?.length ? cred.audiences : (cred.tier === "Critical" ? [] : deptAudience(cred.dept || "")) }
    : { ...EMPTY, dept: depts[0] || "", owner: myEmail, audiences: ownAud(depts[0] || "", myCompanyId || companies[0]?.id || ""), companyId: myCompanyId || companies[0]?.id || "" });
  const [initial] = useState(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // The department box leads the audience until the owner edits the list.
  const follows = (f) => JSON.stringify(f.audiences) === JSON.stringify(ownAud(f.dept, f.companyId));
  const setDept = (d) => setForm((f) => ({ ...f, dept: d, audiences: follows(f) ? ownAud(d, f.companyId) : f.audiences }));
  const setCompany = (co) => setForm((f) => ({ ...f, companyId: co, audiences: follows(f) ? ownAud(f.dept, co) : f.audiences,
    siteId: sitesFor(sites, co).some((x) => x.id === f.siteId) ? f.siteId : "" }));
  const siteChoices = sitesFor(sites, form.companyId);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const valid = form.name.trim() && (editing || form.secret) && form.dept;
  // Departments follow the Company box when Nexus knows them per company.
  const deptChoices = useMemo(() => {
    const own = deptRows.filter((d) => !form.companyId || d.companyId === form.companyId).map((d) => d.name);
    const base = own.length ? [...new Set(own)] : depts;
    return form.dept && !base.includes(form.dept) ? [form.dept, ...base] : base;
  }, [depts, deptRows, form.companyId, form.dept]);

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
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 13, marginRight: "auto" }}>{error}</span>}
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={save} disabled={!valid || saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Save Credential"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 0, animation: "none" }}>
        <div className="cv-form-stack">
          <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" placeholder="e.g. Stripe Dashboard" autoFocus /></Field>
          <div className="cv-form-grid">
            {companies.length > 0 && (
              <Field label="Company" required>
                <select value={form.companyId} onChange={(e) => setCompany(e.target.value)} className="cv-ipt" aria-label="Company">
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Department" required>
              <select value={form.dept} onChange={(e) => setDept(e.target.value)} className="cv-ipt">
                {!form.dept && <option value="">- Choose -</option>}
                {deptChoices.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          </div>
          {(siteChoices.length > 0 || form.siteId) && (
            <Field label="Location">
              <select value={form.siteId} onChange={(e) => set("siteId", e.target.value)} className="cv-ipt" aria-label="Location">
                <option value="">Not Site Specific</option>
                {siteChoices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
          )}
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
            <AudiencePicker value={form.audiences} onChange={(v) => set("audiences", v)} people={people} tier={form.tier} nameOf={nameOf} companyId={form.companyId} />
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

export function ImportWizard({ depts, sites = [], people, myEmail, existing = [], nameOf = (e) => e, onClose, onImport }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [sheet, setSheet] = useState(null);            // { headers: [], rows: [[]] , sheets: [names], name }
  const [map, setMap] = useState({});
  const [defaultDept, setDefaultDept] = useState(depts[0] || "");
  const [backupOwner, setBackupOwner] = useState("");
  // Who opens them (11/13/2026: the sheet said Operations and nothing else
  // could be picked until after the import): each login's own department,
  // plus anyone picked here - departments, companies, groups, people.
  const [ownDept, setOwnDept] = useState(true);
  const [extra, setExtra] = useState([]);
  const [siteId, setSiteId] = useState("");
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
      const res = await onImport(ready.map((r) => toPayload(r, { backupOwner, ownDept, audiences: extra, companyId, siteId })));
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
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 13, marginRight: "auto" }}>{error}</span>}
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
          <div className="cv-form-grid">
            {companies.length > 1 && (
              <Field label="Company">
                <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); if (!sitesFor(sites, e.target.value).some((x) => x.id === siteId)) setSiteId(""); }} className="cv-ipt" aria-label="Company">{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </Field>
            )}
            {sitesFor(sites, companyId).length > 0 && (
              <Field label="Location for Every Login">
                <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="cv-ipt" aria-label="Location for every login">
                  <option value="">Not Site Specific</option>
                  {sitesFor(sites, companyId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </Field>
            )}
          </div>
          <Field label="Who Can Open Them">
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13 }}>
              <input type="checkbox" checked={ownDept} onChange={(e) => setOwnDept(e.target.checked)} /> Everyone in each login's own department
            </label>
            <AudiencePicker value={extra} onChange={setExtra} people={people} nameOf={nameOf} companyId={companyId} />
          </Field>
          <p className="cv-hint">You own every imported login.{!ownDept && !extra.length ? " Nobody else is picked, so only you, the department heads and admins open them." : ""} Change the owner, audience or tier on any of them afterwards.</p>
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

// How long (Oct 29 2026): the presets, or a custom end date and hour -
// shares often run "from now until the project ends".
export function DurationPicker({ value, onChange }) {
  const [mode, setMode] = useState(value?.custom ? "custom" : "preset");
  const [day, setDay] = useState(value?.day || "");
  const [hour, setHour] = useState(value?.hour ?? 17);
  const pick = (x) => { setMode("preset"); onChange({ key: x.key, ms: x.ms, label: x.label }); };
  function custom(d = day, h = hour) {
    setDay(d); setHour(h); setMode("custom");
    const end = localDay(d);
    if (!end) { onChange(null); return; }
    const at = end + h * 3600000;
    const ms = at - Date.now();
    onChange(ms > 60000 ? { key: "custom", custom: true, day: d, hour: h, ms, label: `Until ${formatDate(new Date(at))} ${formatTime(new Date(at))}` } : null);
  }
  return (
    <div>
      <div className="cv-segment">
        {DURATIONS.map((x) => <button key={x.key} type="button" className={`cv-btn${mode === "preset" && value?.key === x.key ? " is-on" : ""}`} onClick={() => pick(x)}>{x.label}</button>)}
        <button type="button" className={`cv-btn${mode === "custom" ? " is-on" : ""}`} onClick={() => custom()}>Until a Date</button>
      </div>
      {mode === "custom" && (
        <div className="cv-form-grid" style={{ marginTop: 8 }}>
          <DateField value={day} onChange={(v) => custom(v || "", hour)} placeholder="MM/DD/YYYY" noPast title="Last day of access" />
          <select className="cv-ipt" value={hour} onChange={(e) => custom(day, Number(e.target.value))} aria-label="Ends at">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h === 0 ? "12:00 AM" : h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`}</option>)}
          </select>
        </div>
      )}
      {mode === "custom" && !value && day && <p className="cv-hint" style={{ marginTop: 6 }}>Pick a day and hour in the future.</p>}
    </div>
  );
}

// Share (Oct 29 2026): several people and whole departments in one go, for
// the same time; the screen passes the departments it knows (per company).
export function ShareModal({ cred, people, nameOf, deptRows = [], companies = [], onClose, onSubmit }) {
  const [emails, setEmails] = useState([]);
  const [depts, setDepts] = useState([]);                 // "companyId:Name" or "Name"
  const [dur, setDur] = useState({ key: "4h", ms: 14400000, label: "4 Hours" });
  const [busy, setBusy] = useState(false);
  const multi = companies.length > 1;
  const mine = deptRows.filter((d) => !multi || !cred.companyId || d.companyId === cred.companyId);
  const keyOf = (d) => (multi && d.companyId ? `${d.companyId}:${d.name}` : d.name);
  const ready = (emails.length || depts.length) && dur;
  async function go() { if (!ready) return; setBusy(true); try { await onSubmit({ recipients: emails, departments: depts, durationMs: dur.ms, durationLabel: dur.label }); } finally { setBusy(false); } }
  return (
    <Modal title="Share Access" onClose={onClose} isDirty={emails.length > 0 || depts.length > 0} onSave={ready ? go : undefined} width="clamp(480px, 48vw, 640px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={go} disabled={!ready || busy}><Share2 size={14} /> {busy ? "Sharing…" : "Share"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 14, animation: "none" }}>
        <p className="cv-hint" style={{ marginTop: -4 }}>{cred.name} · {cred.dept}</p>
        <Field label="People"><PersonMultiSelect value={emails} onChange={(v) => setEmails(v || [])} people={people} placeholder="Add people" /></Field>
        {mine.length > 0 && (
          <Field label="Whole Departments">
            <div className="cv-pick-row">
              {mine.map((d) => { const k = keyOf(d); const on = depts.includes(k); return (
                <button key={k} type="button" className={`cv-pick${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => setDepts(on ? depts.filter((x) => x !== k) : [...depts, k])}>{on && <Check size={11} />}{d.name}{multi && !cred.companyId && d.companyId ? <span className="cv-pick-sub"> · {companies.find((c) => c.id === d.companyId)?.name || ""}</span> : null}</button>
              ); })}
            </div>
          </Field>
        )}
        <Field label="For"><DurationPicker value={dur} onChange={setDur} /></Field>
        <div className="cv-callout">
          <span>{emails.length + depts.length ? "They" : "The people you pick"} will see the password on their own My Logins {dur ? (dur.custom ? dur.label.toLowerCase() : `for ${dur.label.toLowerCase()}`) : ""}, then it leaves their list. They need the Credentials grant to open the screen. Every recipient gets a bell.</span>
        </div>
      </div>
    </Modal>
  );
}

export function RequestModal({ cred, nameOf, onClose, onSubmit }) {
  const [d, setD] = useState({ key: "4h", ms: 14400000, label: "4 Hours" });
  const [busy, setBusy] = useState(false);
  async function go() { if (!d) return; setBusy(true); try { await onSubmit(d.ms, d.label); } finally { setBusy(false); } }
  return (
    <Modal title="Request Access" onClose={onClose} width="clamp(420px, 40vw, 560px)"
      footer={<>
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={go} disabled={busy}><Send size={14} /> {busy ? "Sending…" : "Send Request"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 14, animation: "none" }}>
        <p className="cv-hint" style={{ marginTop: -4 }}>{cred.name} · {cred.dept} · owned by {nameOf(cred.owner)}</p>
        <Field label="For"><DurationPicker value={d} onChange={setD} /></Field>
        <div className="cv-callout"><span>{nameOf(cred.owner)} or an admin approves this. You get a bell notification when they decide, and the password shows here for {d.label.toLowerCase()} from then.</span></div>
      </div>
    </Modal>
  );
}
