// Credential Vault - the modals (Oct 14 2026 rebuild): add / edit a company
// credential, CSV import, share with someone, request access. Built on the
// Tasks module's Modal (phone sheet, focus, unsaved-changes prompt) and its
// PersonSelect (the curated Nexus People list).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Download, CheckCircle2, AlertCircle, Share2, Send, Users, Building2, X, Eye, EyeOff, Check, RefreshCw } from "lucide-react";
import { api, saveBlob } from "../api";
import { Modal, PersonSelect, PersonMultiSelect, DateField, ChipMultiSelect } from "../tasks/components";
import { Field, PasswordField, TYPES, TIERS } from "./vaultShared";
import { DURATIONS, ROTATION_CHOICES, audienceKey, siteOf, localDay } from "./vaultModel";
import { formatDate, formatTime } from "../lib/datetime";
import { FIELDS, guessMap, applyMap, validateRows, findDuplicates, toPayload } from "./importModel";

const EMPTY = { name: "", dept: "", type: "Password", tier: "Standard", username: "", secret: "", url: "", note: "", owner: "", backupOwner: "", rotationMax: 90, expiresAt: "", totpSecret: "", clearTotp: false, siteId: "" };
// The department's own audience row. With several companies the key carries the
// company ("co-1:Operations"), the same key the picker's chips use - a plain
// "Operations" beside it listed the department twice (11/13/2026).
const deptAudience = (dept, companyId = "") => (dept ? [{ kind: "department", value: companyId ? `${companyId}:${dept}` : dept, level: "open", label: `Everyone in ${dept}` }] : []);
const splitDept = (v) => { const s = String(v || ""); const i = s.indexOf(":"); return i < 0 ? ["", s] : [s.slice(0, i), s.slice(i + 1)]; };
const deptName = (a) => splitDept(a.value)[1];
const DAY = 86400000;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Work sites of the companies picked (or every site when none is picked yet).
export const sitesFor = (sites, companyIds) => {
  const ids = (Array.isArray(companyIds) ? companyIds : [companyIds]).filter(Boolean);
  return sites.filter((x) => !ids.length || !x.companyIds?.length || x.companyIds.some((c) => ids.includes(c)));
};

// One load of the form's companies, departments and Access Groups, shared by
// every picker on screen. A failed load says so with Retry (11/13/2026: during
// a dev deploy the form read "No departments set up" when the call had failed).
let optsPromise = null;
let optsAt = 0;
const OPTS_TTL_MS = 60000;   // one load per form, shared by its pickers; a new company shows on the next open
export function useAudienceOptions() {
  const [state, setState] = useState({ opts: { companies: [], departments: [], groups: [] }, loaded: false, error: false });
  const load = useCallback((fresh = false) => {
    if (fresh || !optsPromise || Date.now() - optsAt > OPTS_TTL_MS) { optsPromise = api.cvAudienceOptions(); optsAt = Date.now(); }
    setState((s) => ({ ...s, error: false }));
    optsPromise
      .then((o) => setState({ opts: { companies: o?.companies || [], departments: o?.departments || [], groups: o?.groups || [], me: o?.me || null }, loaded: true, error: false }))
      .catch(() => { optsPromise = null; setState((s) => ({ ...s, loaded: true, error: true })); });
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, retry: () => load(true) };
}

/** Tests only: forget the shared load. */
export function resetAudienceOptions() { optsPromise = null; optsAt = 0; }

function LoadFailed({ onRetry }) {
  return (
    <span className="cv-hint" role="alert" style={{ color: "var(--cv-bad)", display: "inline-flex", alignItems: "center", gap: 8 }}>
      Could not load the companies and departments.
      <button type="button" className="cv-link" onClick={onRetry}><RefreshCw size={12} /> Retry</button>
    </span>
  );
}

const Chip = ({ on, children, onClick, title, disabled = false }) => (
  <button type="button" className={`cv-pick${on ? " is-on" : ""}`} aria-pressed={on} onClick={onClick} title={title} disabled={disabled}>{on && <Check size={11} />}{children}</button>
);

// Company, Department and Access Groups (Pranshu, 11/13/2026): dropdowns.
// Company (several, or All) first; Department (several, or All) opens once a
// company is picked and lists only its departments; Access Groups is optional
// - none picked = everyone in those departments, a group picked keeps it to
// that group's members (only_group rows, vault_access.py). These picks ARE
// who may open the login. `cos` (the companies picked) is the caller's, since
// a company can be picked before any department.
const ALL = "*";
export function ScopePicker({ value, onChange, cos, onCos, homeCo = "", errors = {}, optsState }) {
  const { opts, error, retry, loaded } = optsState;
  const multi = opts.companies.length > 1;
  const keyOf = audienceKey;
  const has = (a) => value.some((x) => keyOf(x) === keyOf(a));
  const coName = (id) => opts.companies.find((c) => c.id === id)?.name || "";
  const coAud = (id) => ({ kind: "company", value: id, level: "open", label: `Everyone at ${coName(id)}` });
  const dKey = (d) => (multi && d.companyId ? `${d.companyId}:${d.name}` : d.name);
  const deptAud = (d) => ({ kind: "department", value: dKey(d), level: "open", label: `Everyone in ${d.name}${multi && d.companyId ? ` at ${coName(d.companyId)}` : ""}` });
  // A plain "Operations" row (older logins) is the department of the login's own company.
  const coOfRow = (a) => (a.kind === "company" ? a.value : (splitDept(a.value)[0] || homeCo));
  const scopeRow = (a) => a.kind === "company" || a.kind === "department";
  const everyone = value.some((a) => a.kind === "company" && !a.value);
  const allIds = opts.companies.map((c) => c.id);
  const allCos = allIds.length > 1 && allIds.every((id) => cos.includes(id));
  const depts = opts.departments.filter((d) => !multi || cos.includes(d.companyId));
  const allDepts = cos.length > 0 && (everyone || cos.every((id) => has(coAud(id))));
  const deptOn = (d) => has(deptAud(d)) || (multi && d.companyId === homeCo && has({ kind: "department", value: d.name }));

  function pickCompanies(next) {
    let ids = next;
    if (next.includes(ALL) && !allCos) ids = allIds;                 // All picked
    else if (allCos && !next.includes(ALL)) ids = [];                 // All removed
    else ids = next.filter((x) => x !== ALL);
    onCos(ids);
    const kept = value.filter((a) => !(scopeRow(a) && a.value && !ids.includes(coOfRow(a))));
    const add = allDepts && !everyone ? ids.filter((id) => !kept.some((a) => a.kind === "company" && a.value === id)).map(coAud) : [];
    onChange([...kept, ...add]);
  }
  function pickDepartments(next) {
    const inScope = (a) => scopeRow(a) && (!a.value || cos.includes(coOfRow(a)) || !multi);
    if (next.includes(ALL) && !allDepts) { onChange([...value.filter((a) => !inScope(a)), ...cos.map(coAud)]); return; }
    if (allDepts && !next.includes(ALL)) { onChange(value.filter((a) => !inScope(a))); return; }
    const rows = depts.filter((d) => next.includes(dKey(d))).map(deptAud);
    onChange([...value.filter((a) => !inScope(a)), ...rows]);
  }
  // Access Groups: those with people in the departments picked (all of them
  // with All departments or none picked), plus any already chosen.
  const pickedDepts = new Set(value.filter((a) => a.kind === "department").map((a) => deptName(a).toLowerCase()));
  const onlyIds = value.filter((a) => a.kind === "only_group").map((a) => a.value);
  const groupOpts = opts.groups.filter((g) => allDepts || !pickedDepts.size || onlyIds.includes(g.id)
    || (g.departments || []).some((d) => pickedDepts.has(d.toLowerCase())));
  function pickGroups(ids) {
    const rows = ids.map((id) => ({ kind: "only_group", value: id, level: "open", label: `Only ${opts.groups.find((g) => g.id === id)?.name || "an Access Group"}` }));
    onChange([...value.filter((a) => a.kind !== "only_group"), ...rows]);
  }
  if (error) return <LoadFailed onRetry={retry} />;
  return (
    <>
      <Field label="Company" required as="div" error={errors.cos}>
        <div className={`cv-pick-box${errors.cos ? " is-error" : ""}`} data-scope="companies">
          {!loaded ? <span className="cv-hint">Loading…</span> : opts.companies.length === 0
            ? <span className="cv-hint">No companies set up under Settings &gt; Companies.</span>
            : <ChipMultiSelect value={allCos ? [ALL] : cos} onChange={pickCompanies} placeholder="Pick a company" searchPlaceholder="Search companies…"
                options={[...(allIds.length > 1 ? [{ id: ALL, label: "All Companies" }] : []), ...opts.companies.map((c) => ({ id: c.id, label: c.name }))]} />}
        </div>
      </Field>
      {cos.length > 0 && (<>
        <Field label="Department" required as="div" error={errors.depts}>
          <div className={`cv-pick-box${errors.depts ? " is-error" : ""}`} data-scope="departments">
            {depts.length === 0
              ? <span className="cv-hint">No departments set up for {cos.length === 1 ? coName(cos[0]) : "these companies"} under Settings &gt; Companies.</span>
              : <ChipMultiSelect value={allDepts ? [ALL] : depts.filter(deptOn).map(dKey)} onChange={pickDepartments} placeholder="Pick a department" searchPlaceholder="Search departments…"
                  options={[{ id: ALL, label: "All Departments" }, ...depts.map((d) => ({ id: dKey(d), label: `${d.name}${multi && cos.length > 1 && d.companyId ? ` · ${coName(d.companyId)}` : ""}` }))]} />}
          </div>
        </Field>
        {opts.groups.length > 0 && (
          <Field label="Access Groups" as="div">
            <div data-scope="groups">
              <ChipMultiSelect value={onlyIds} onChange={pickGroups} options={groupOpts.map((g) => ({ id: g.id, label: g.name }))}
                placeholder="All (optional)" placeholderInk searchPlaceholder="Search Access Groups…" emptyText="No Access Group has people in these departments." />
              <span className="cv-hint" style={{ display: "block", marginTop: 4 }}>
                {onlyIds.length ? "Only members of these groups, in the departments above, can open it." : "None picked = everyone in the departments above. Pick groups to keep it to their members."}
              </span>
            </div>
          </Field>
        )}
      </>)}
    </>
  );
}

// Who may open the credential (Oct 29 2026, vault_access.py): rows of
// company / department / Access Group / person, each openable or view-only.
// `scopeAbove` (the credential form, 11/13/2026): companies and departments
// are picked at the top of the form, so this adds only Access Groups and
// people - and lists every row with its level either way.
export function AudiencePicker({ value, onChange, people, tier, nameOf = (e) => e, companyId = "", scopeAbove = false, optsState }) {
  const own = useAudienceOptions();
  const { opts, error, retry } = optsState || own;
  const [person, setPerson] = useState("");
  const [allGroups, setAllGroups] = useState(false);
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
  return (
    <div className="cv-audience" data-audience-picker="">
      {error && <LoadFailed onRetry={retry} />}
      {!scopeAbove && (<>
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
            {!error && deptRows.length === 0 && <span className="cv-hint">No departments set up under Settings &gt; Companies.</span>}
            {deptRows.map((d) => <Chip key={`${d.companyId}:${d.name}`} on={deptOn(d)} onClick={() => toggleDept(d)}>{d.name}{multi && pickedCompanies.length !== 1 && d.companyId ? <span className="cv-pick-sub"> · {companyName(d.companyId)}</span> : null}</Chip>)}
          </div>
        </div>
      </>)}
      {!scopeAbove && opts.groups.length > 0 && (
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

// The companies a login's rows point at - where the Company chips start.
function companiesOf(audiences, homeCo, allIds) {
  if (audiences.some((a) => a.kind === "company" && !a.value)) return allIds;
  const ids = audiences.flatMap((a) => (a.kind === "company" ? [a.value] : a.kind === "department" ? [splitDept(a.value)[0] || homeCo] : []));
  return [...new Set(ids.filter(Boolean))];
}

// What is wrong with the form, field by field (11/13/2026: say what to fix, in red).
export function formErrors(form, { editing, cos, scopeRows }) {
  const e = {};
  if (!form.name.trim()) e.name = "Give the login a name.";
  if (!cos.length) e.cos = "Pick at least one company.";
  else if (!scopeRows.length) e.depts = "Pick at least one department, or All.";
  if (!editing && !form.secret) e.secret = "Enter or generate a password.";
  if (form.url.trim() && !/^https?:\/\/\S+$/i.test(form.url.trim())) e.url = "The link must start with http:// or https:// - for example https://portal.example.com";
  return e;
}

export function CredentialForm({ cred, people, myEmail, nameOf, onClose, onSave, companies = [], sites = [], myCompanyId = "" }) {
  const editing = !!cred;
  const optsState = useAudienceOptions();
  const allIds = useMemo(() => optsState.opts.companies.map((c) => c.id), [optsState.opts.companies]);
  const homeCo = cred?.companyId || myCompanyId || "";
  const [form, setForm] = useState(() => editing
    ? { ...EMPTY, name: cred.name, dept: cred.dept || "", type: cred.type, tier: cred.tier, username: cred.username === "-" ? "" : cred.username, url: cred.url || "", note: cred.note || "", owner: cred.owner || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, expiresAt: cred.expiresAt || "", siteId: cred.siteId || "",
      // A credential from before audiences (no rows) is still opened by its own
      // department unless Critical - show that, so saving writes it out as a row.
      audiences: cred.audiences?.length ? cred.audiences : (cred.tier === "Critical" ? [] : deptAudience(cred.dept || "", companies.length > 1 ? homeCo : "")) }
    : { ...EMPTY, owner: myEmail, audiences: [] });
  // The companies picked. A new login starts on the person's own company (or
  // the only one); its departments are theirs to pick.
  const [cos, setCos] = useState(() => (editing ? companiesOf(form.audiences, homeCo, companies.map((c) => c.id)) : (homeCo ? [homeCo] : companies.length === 1 ? [companies[0].id] : [])));
  // A new login starts on the person's own company and department (11/13/2026),
  // else on the only company there is; set once, when the options arrive.
  const started = useRef(editing);
  useEffect(() => {
    if (started.current || !optsState.loaded) return;
    started.current = true;
    const me = optsState.opts.me || {};
    const co = me.companyId || (allIds.length === 1 ? allIds[0] : "");
    if (!co) return;
    setCos([co]);
    if (me.dept && me.companyId === co) {
      const multi = allIds.length > 1;
      setForm((f) => (f.audiences.length ? f : { ...f, audiences: deptAudience(me.dept, multi ? co : "") }));
    }
  }, [optsState.loaded, optsState.opts.me, allIds]);
  const [initial] = useState(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState({});   // a weak / leaked password, from the server
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); if (serverErrors[k]) setServerErrors((e) => ({ ...e, [k]: "" })); };
  const setAudiences = (v) => set("audiences", v);
  const scopeRows = form.audiences.filter((a) => a.kind === "department" || a.kind === "company");
  const errors = formErrors(form, { editing, cos, scopeRows });
  const shown = { ...(showErrors ? errors : {}), ...Object.fromEntries(Object.entries(serverErrors).filter(([, v]) => v)) };
  const siteChoices = sitesFor(sites, cos);
  // Expires On follows Rotate Every (11/13/2026) until a date is picked by hand.
  const fromLastChange = editing && !form.secret && !!cred.rotatedAt;
  const rotatedFrom = fromLastChange ? new Date(cred.rotatedAt) : new Date();
  const autoExpiry = isoDay(new Date(rotatedFrom.getTime() + form.rotationMax * DAY));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  async function save() {
    if (Object.keys(errors).length) {
      setShowErrors(true); setError("Fix the fields marked in red.");
      requestAnimationFrame(() => document.querySelector("[data-field-error]")?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
      return;
    }
    setSaving(true); setError("");
    // The login's home department and company: the first ones picked (heads, grouping, the list).
    const firstDept = form.audiences.find((a) => a.kind === "department");
    const companyId = (firstDept && splitDept(firstDept.value)[0]) || cos[0] || homeCo;
    const dept = firstDept ? deptName(firstDept) : form.dept;
    try {
      await onSave({ ...form, dept, companyId, url: form.url.trim(), expiresAt: form.expiresAt === autoExpiry ? "" : form.expiresAt,
        customExpiry: form.rotationMax !== 90, audiences: form.audiences.map(({ kind, value, level }) => ({ kind, value, level })) });
    } catch (e) {
      if (e?.detail?.field) {
        setServerErrors({ [e.detail.field]: e.detail.message });
        requestAnimationFrame(() => document.querySelector("[data-field-error]")?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
      }
      setError(e?.detail?.field ? "Fix the fields marked in red." : e?.message || "Could not save."); setSaving(false); return;
    }
    setSaving(false);
  }

  return (
    <Modal title={editing ? "Edit Credential" : "Add Credential"} onClose={onClose} isDirty={dirty} onSave={save}
      width="clamp(480px, 56vw, 760px)"
      footer={<>
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 13, marginRight: "auto" }} role="status">{error}</span>}
        <button type="button" className="cv-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="cv-btn-dark" onClick={save} disabled={saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Save Credential"}</button>
      </>}>
      <div className="cv-root" style={{ gap: 0, animation: "none" }}>
        <div className="cv-form-stack">
          <Field label="Name" required error={shown.name}><input value={form.name} onChange={(e) => set("name", e.target.value)} className={`cv-ipt${shown.name ? " cv-ipt-error" : ""}`} aria-invalid={shown.name ? true : undefined} placeholder="e.g. Stripe Dashboard" autoFocus /></Field>
          <ScopePicker value={form.audiences} onChange={setAudiences} cos={cos} onCos={(next) => { setCos(next); if (!sitesFor(sites, next).some((x) => x.id === form.siteId)) set("siteId", ""); }}
            homeCo={homeCo} errors={shown} optsState={optsState} />
          <div className="cv-form-grid">
            <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Tier">
              <select value={form.tier} onChange={(e) => set("tier", e.target.value)} className="cv-ipt">{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
            </Field>
          </div>
          {(siteChoices.length > 0 || form.siteId) && (
            <Field label="Location">
              <select value={form.siteId} onChange={(e) => set("siteId", e.target.value)} className="cv-ipt" aria-label="Location">
                <option value="">Not Site Specific</option>
                {siteChoices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Username"><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" autoComplete="off" /></Field>
          <PasswordField value={form.secret} onChange={(v) => set("secret", v)} required={!editing} error={shown.secret}
            label={editing ? "New Password" : "Password"} placeholder={editing ? "Leave blank to keep the current password" : "Enter or generate a password"} />
          {editing && form.secret && <p className="cv-hint">Saving a new password counts as a rotation. The current one is kept as the previous password until the next rotation.</p>}
          <Field label="Link" error={shown.url}><input value={form.url} onChange={(e) => set("url", e.target.value)} className={`cv-ipt${shown.url ? " cv-ipt-error" : ""}`} aria-invalid={shown.url ? true : undefined} placeholder="https://…" /></Field>
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
            <Field label="Rotate Every" as="div">
              <div className="cv-segment">
                {ROTATION_CHOICES.map((d) => <button key={d} type="button" className={`cv-btn${form.rotationMax === d ? " is-on" : ""}`} onClick={() => set("rotationMax", d)}>{d}d</button>)}
              </div>
            </Field>
            <Field label="Expires On" as="div">
              <div data-expires={form.expiresAt || autoExpiry}>
                <DateField value={form.expiresAt || autoExpiry} onChange={(v) => set("expiresAt", v || "")} placeholder="MM/DD/YYYY" title="Follows Rotate Every - pick a date to set your own" />
              </div>
              <span className="cv-hint" style={{ display: "block", marginTop: 4 }}>
                {form.expiresAt && form.expiresAt !== autoExpiry
                  ? <>Your own date. <button type="button" className="cv-link" onClick={() => set("expiresAt", "")}>Follow Rotate Every</button></>
                  : `${form.rotationMax} days from ${fromLastChange ? "the last change" : "today"}.`}
              </span>
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
          <Field label="Who Can Access" as="div">
            <AudiencePicker value={form.audiences} onChange={setAudiences} people={people} tier={form.tier} nameOf={nameOf} companyId={cos[0] || homeCo} scopeAbove optsState={optsState} />
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

export function ImportWizard({ depts, sites = [], departments = [], people, myEmail, existing = [], nameOf = (e) => e, onClose, onImport }) {
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
  const reviewed = useMemo(() => findDuplicates(validateRows(mapped, { defaultDept, companies, departments }), existing), [mapped, defaultDept, companies, departments, existing]);
  const [templateBusy, setTemplateBusy] = useState(false);
  async function downloadTemplate() {
    setTemplateBusy(true); setError("");
    try { const { blob, filename } = await api.cvImportTemplate(); saveBlob(blob, filename || "credentials-import-template.xlsx"); }
    catch (e) { setError(e?.message || "Could not download the template."); }
    setTemplateBusy(false);
  }
  const ready = reviewed.filter((r) => r.ok && !(skipDups && r.duplicateOf));
  const dups = reviewed.filter((r) => r.duplicateOf);
  const bad = reviewed.filter((r) => !r.ok);
  const mapOk = map.name != null && map.secret != null;

  async function run() {
    setBusy(true); setError("");
    try {
      const res = await onImport(ready.map((r) => toPayload(r, { backupOwner, ownDept, audiences: extra, companyId, siteId })));
      setResult({ imported: res?.imported || 0, skipped: res?.skipped || 0, sent: ready.length, bad: bad.length, dups: skipDups ? dups.length : 0, refused: res?.refused || [] });
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
            <span className="cv-hint">Best: the template - its Company column lists your companies and Department only that company&apos;s departments. Any other Excel (.xlsx, .xls) or CSV works too; you match its columns on the next step. The first sheet is read; passwords stay in your browser until you click Import.</span>
            <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <button type="button" className="cv-btn" onClick={downloadTemplate} disabled={templateBusy}><Download size={14} /> {templateBusy ? "Preparing…" : "Download the Template"}</button>
              <button type="button" className="cv-btn-dark" onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose File</button>
            </span>
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
            {result.refused.length > 0 && (
              <div className="cv-callout tone-warn" style={{ marginTop: 12, textAlign: "left" }} data-import-refused="">
                <span><b>{result.refused.length} left out:</b> {result.refused.map((r) => `${r.name} (${r.reason})`).join("; ")}.</span>
              </div>
            )}
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
