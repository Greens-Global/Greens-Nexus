/* Credential Vault - the module screen (Oct 14 2026 rebuild, People-screen
   grammar). Page header with the module chip and one green primary action;
   a stat strip (KPI tiles, departments, what rotates next); then the
   directory card: search and filters in its head, collection tabs, and a
   master-detail body - credentials on the left, the selected one open in
   place on the right. Phones get the list and a full-screen sheet.

   The API says per row what the caller may do (access / canReveal /
   canEdit - department scope, Neil Oct 14 2026); this screen only renders
   that. Company secrets arrive through explicit reveal calls behind the
   SMS/Email code gate (VaultOtpModal), one code per window ("Verified until
   <time>" in the header), and are held in memory for the open detail only.
   Tabs: Vault, Personal, Approvals, Activity. Deep links arrive as
   `activeSub` (vaultModel.parseSub) from the bell and the header search. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyRound, ShieldCheck, Shield, Search, Plus, Upload, Star, Trash2, Users, ChevronRight, ChevronDown, X,
  CheckCircle2, XCircle, History, Lock, Building2, RefreshCw, Inbox, LayoutList,
} from "lucide-react";
import { api } from "../api";
import { dialog } from "../ui/dialog";
import { SkeletonBlocks } from "../components/AsyncState";
import ModuleTabs from "../components/ModuleTabs";
import { useRole } from "../contexts/RoleContext";
import { useNameResolver } from "../lib/useNameResolver";
import { useIsMobile } from "../lib/useIsMobile";
import { formatDateTime } from "../lib/datetime";
import { usePeople, useClickOutside } from "../tasks/components";
import { VaultOtpModal, DEFAULT_DEPTS, TYPES, TIERS, agoLabel, actionStyle } from "./vaultShared";
import {
  ACCESS_LABEL, ACCESS_TONE, collectionsFor, filterCredentials, sortCredentials, healthFlags, healthTone,
  parseSub, verifiedLabel, readFavorites, writeFavorites, logMatches, live,
} from "./vaultModel";
import { KpiTile, StatCard, DeptBars, RotationList, Monogram } from "./vaultCards";
import CredentialSheet, { CredentialDetail } from "./CredentialDrawer";
import { CredentialForm, ImportModal, ShareModal, RequestModal } from "./CredentialForm";
import PersonalVault from "./PersonalVault";
import "./credvault.css";

const LOG_ACTIONS = ["All", "Revealed", "Copied", "Created", "Edited", "Shared", "Requested", "Denied", "Revoked", "Transferred", "Removed", "Recovered", "Imported", "Offboarded"];
const TAB_KEYS = ["all", "mine", "shared", "favorites", "attention", "trash"];

export default function CredentialVaultApp({ activeSub }) {
  const { myEmail, can, canAccessModule } = useRole();
  const isAdmin = can("administrator");
  const canWrite = canAccessModule("credvault", "administrator", "editor");
  const nameOf = useNameResolver();
  const people = usePeople();
  const isMobile = useIsMobile("(max-width: 900px)");

  // ── data ────────────────────────────────────────────────────────────────
  const [creds, setCreds] = useState([]);
  const [requests, setRequests] = useState([]);
  const [logs, setLogs] = useState([]);
  const [otp, setOtp] = useState({ verified: false, until: null });
  const [hrDepts, setHrDepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(async () => {
    const [c, r, l, o] = await Promise.all([api.cvCredentials(), api.cvRequests(), api.cvLogs(), api.cvOtpStatus().catch(() => ({ verified: false }))]);
    setCreds(c || []); setRequests(r || []); setLogs(l || []); setOtp(o || { verified: false });
    setLoadError(false);
  }, []);
  useEffect(() => {
    refresh().catch(() => setLoadError(true)).finally(() => setLoading(false));
    api.getProjectDepartments().then((rows) => setHrDepts((rows || []).map((d) => d.name).filter(Boolean))).catch(() => {});
  }, [refresh]);

  // ── ui state ────────────────────────────────────────────────────────────
  const [tab, setTab] = useState("vault");
  const personalSeen = useRef(false);
  if (tab === "personal") personalSeen.current = true;
  const [collection, setCollection] = useState("all");
  const [query, setQuery] = useState("");
  const [fDept, setFDept] = useState("");
  const [fType, setFType] = useState("All");
  const [fTier, setFTier] = useState("All");
  const [sort, setSort] = useState({ col: "name", dir: "asc" });
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [favorites, setFavorites] = useState(readFavorites);
  const [revealed, setRevealed] = useState(null);          // { id, secret, previousSecret?, prevRotatedAt? }
  const [form, setForm] = useState(null);                  // { cred | null }
  const [importOpen, setImportOpen] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const addRef = useRef(null);
  useClickOutside([addRef], () => setAddMenu(false), addMenu);
  const [shareFor, setShareFor] = useState(null);
  const [requestFor, setRequestFor] = useState(null);
  const [otpGate, setOtpGate] = useState(null);            // { run }
  const [toast, setToast] = useState(null);
  const [logFilter, setLogFilter] = useState({ query: "", action: "All", from: "", to: "" });
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { writeFavorites(favorites); }, [favorites]);
  useEffect(() => { setChecked(new Set()); }, [collection, tab]);

  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Deep links: the bell / header search set `activeSub`; a repeat click on the
  // same destination arrives as a window event while the sub does not change.
  const applySub = useCallback((sub) => {
    const { tab: t, credId, collection: col } = parseSub(sub);
    if (!t) return;
    setTab(t);
    if (col) setCollection(col);
    if (credId) { setCollection("all"); setFDept(""); setSelectedId(credId); }
  }, []);
  useEffect(() => { applySub(activeSub); }, [activeSub, applySub]);
  useEffect(() => {
    const h = (e) => { if (e.detail?.view === "credvault") applySub(e.detail.sub); };
    window.addEventListener("nexus:navigate", h);
    return () => window.removeEventListener("nexus:navigate", h);
  }, [applySub]);

  // ── derived ─────────────────────────────────────────────────────────────
  const ctx = useMemo(() => ({ favorites, myEmail }), [favorites, myEmail]);
  const collections = useMemo(() => collectionsFor(creds, ctx), [creds, ctx]);
  const countOf = (key) => collections.find((c) => c.key === key)?.count || 0;
  const liveRows = useMemo(() => live(creds), [creds]);
  const depts = useMemo(() => {
    const set = new Set(hrDepts.length ? hrDepts : DEFAULT_DEPTS);
    liveRows.forEach((c) => c.dept && set.add(c.dept));
    return [...set];
  }, [liveRows, hrDepts]);
  const deptsInUse = useMemo(() => [...new Set(liveRows.map((c) => c.dept).filter(Boolean))].sort(), [liveRows]);
  const rows = useMemo(() => {
    const base = filterCredentials(creds, { collection, query, type: fType, tier: fTier, ...ctx });
    return sortCredentials(fDept ? base.filter((c) => c.dept === fDept) : base, sort);
  }, [creds, collection, query, fType, fTier, fDept, ctx, sort]);
  const selected = useMemo(() => creds.find((c) => c.id === selectedId) || null, [creds, selectedId]);
  const verified = otp.verified && otp.until > now;
  const attention = countOf("attention");
  const checkedEditable = rows.filter((c) => checked.has(c.id) && c.canEdit && !c.deletedAt);
  const visibleLog = useMemo(() => logs.filter((e) => logMatches(e, logFilter)), [logs, logFilter]);
  const sharedWithMe = countOf("shared");

  // Closing the detail drops the revealed secret with it.
  function closeDetail() { setSelectedId(null); setRevealed(null); }
  function open(id) { setSelectedId(id); setTab("vault"); }

  // ── the code gate ───────────────────────────────────────────────────────
  // One verified code opens a window (Settings > Security); inside it every
  // reveal / share / approve runs straight away. The window is checked at
  // click time, and an action the API still refuses with vault_otp_required
  // re-opens the gate with the same action instead of a toast.
  function gated(run) {
    const wrapped = () => run().catch((e) => {
      if (e?.detail?.code === "vault_otp_required") { setOtp({ verified: false, until: null }); setOtpGate({ run: wrapped }); return; }
      throw e;
    });
    if (otp.verified && otp.until > Date.now()) return wrapped();
    setOtpGate({ run: wrapped });
    return undefined;
  }
  async function afterOtp() {
    const g = otpGate; setOtpGate(null);
    api.cvOtpStatus().then(setOtp).catch(() => {});
    if (g) await g.run();
  }

  // ── actions ─────────────────────────────────────────────────────────────
  const otpError = (e) => e?.detail?.code === "vault_otp_required";
  async function reveal(c) {
    try {
      const res = await api.cvReveal(c.id);
      setRevealed({ id: c.id, ...res });
      api.cvLogs().then(setLogs).catch(() => {});
    } catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not reveal.", "info"); }
  }
  function copiedSecret(c) { api.cvCopied(c.id).then(() => api.cvLogs().then(setLogs)).catch(() => {}); flash("Password copied. This was logged."); }

  async function saveCredential(f) {
    if (form?.cred) {
      await api.cvUpdate(form.cred.id, f);
      if (f.owner && f.owner !== form.cred.owner) await api.cvTransfer(form.cred.id, f.owner);
      flash(`${f.name} updated.`);
    } else {
      const res = await api.cvCreate(f);
      if (f.owner && f.owner !== myEmail) await api.cvTransfer(res.id, f.owner);
      flash(`${f.name} added.`);
      setSelectedId(res.id);
    }
    setForm(null); setRevealed(null);
    await refresh();
  }
  async function importRows(list) {
    try { const res = await api.cvImport(list); setImportOpen(false); await refresh(); flash(`Imported ${res.imported} credential${res.imported === 1 ? "" : "s"}.`); }
    catch (e) { flash(e?.message || "Import failed.", "info"); }
  }
  async function trash(c) {
    const ok = await dialog.confirm(`Move ${c.name} to the trash? It can be recovered from there.`, { title: "Move to Trash", confirmText: "Move to Trash", danger: true });
    if (!ok) return;
    try { await api.cvDelete(c.id); closeDetail(); await refresh(); flash(`${c.name} moved to the trash.`); } catch (e) { flash(e?.message || "Could not remove.", "info"); }
  }
  async function trashChecked() {
    const n = checkedEditable.length;
    const ok = await dialog.confirm(`Move ${n} credential${n === 1 ? "" : "s"} to the trash?`, { title: "Move to Trash", confirmText: "Move to Trash", danger: true });
    if (!ok) return;
    try { await api.cvBulkDelete(checkedEditable.map((c) => c.id)); setChecked(new Set()); await refresh(); flash(`${n} moved to the trash.`); } catch (e) { flash(e?.message || "Could not remove.", "info"); }
  }
  async function restore(c) {
    try { await api.cvRestore(c.id); await refresh(); flash(`${c.name} recovered.`); } catch (e) { flash(e?.message || "Could not recover.", "info"); }
  }
  async function purge(c) {
    const ok = await dialog.confirm(`Delete ${c.name} permanently? This cannot be undone.`, { title: "Delete Permanently", confirmText: "Delete Permanently", danger: true });
    if (!ok) return;
    try { await api.cvPurge(c.id); closeDetail(); await refresh(); flash(`${c.name} deleted permanently.`, "info"); } catch (e) { flash(e?.message || "Could not delete.", "info"); }
  }
  async function share(c, email, ms, label) {
    setShareFor(null);
    await gated(async () => {
      try { await api.cvShare(c.id, { recipientEmail: email, durationMs: ms, durationLabel: label }); await refresh(); flash(`${c.name} shared with ${nameOf(email)} for ${label.toLowerCase()}.`); }
      catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not share.", "info"); }
    });
  }
  async function request(c, ms, label) {
    setRequestFor(null);
    try {
      const res = await api.cvRequest(c.id, { durationMs: ms, durationLabel: label });
      flash(res.pending ? `Your request for ${c.name} is still waiting on ${nameOf(c.owner)}.` : `Asked ${nameOf(c.owner)} for ${c.name}. You will get a bell when they decide.`);
      api.cvLogs().then(setLogs).catch(() => {});
    } catch (e) { flash(e?.message || "Could not send the request.", "info"); }
  }
  function approve(r) {
    gated(async () => {
      try { await api.cvApproveRequest(r.id); await refresh(); flash(`Approved. ${r.requestedBy} has ${r.duration.toLowerCase()} of access to ${r.cred}.`); }
      catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not approve.", "info"); }
    });
  }
  async function deny(r) {
    try { await api.cvDenyRequest(r.id); await refresh(); flash(`Declined ${r.requestedBy}'s request for ${r.cred}.`, "info"); } catch (e) { flash(e?.message || "Could not decline.", "info"); }
  }
  function toggleFavorite(id) { setFavorites((f) => { const n = new Set(f); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function toggleChecked(id) { setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function pickCollection(key) { setCollection(key); setFDept(""); }

  if (loading) return <div style={{ padding: "16px 0" }}><SkeletonBlocks count={6} height={52} /></div>;

  const tabs = [
    { key: "vault", label: "Vault", Icon: KeyRound },
    { key: "personal", label: "Personal", Icon: Lock },
    ...((isAdmin || requests.length || tab === "approvals" || creds.some((c) => c.canEdit)) ? [{ key: "approvals", label: "Approvals", Icon: Inbox, badge: requests.length || null }] : []),
    { key: "activity", label: "Activity", Icon: History },
  ];
  const editableInView = rows.filter((c) => c.canEdit && !c.deletedAt);
  const allChecked = editableInView.length > 0 && editableInView.every((c) => checked.has(c.id));
  const detailProps = selected && {
    cred: selected, logs, myEmail, nameOf, depts: deptsInUse,
    favorite: favorites.has(selected.id), onToggleFavorite: () => toggleFavorite(selected.id),
    revealed: revealed?.id === selected.id ? revealed : null,
    onReveal: () => gated(() => reveal(selected)), onHide: () => setRevealed(null), onCopiedSecret: () => copiedSecret(selected),
    onEdit: () => setForm({ cred: selected }), onTrash: () => trash(selected), onRestore: () => restore(selected), onPurge: () => purge(selected),
    onShare: () => setShareFor(selected), onRequest: () => setRequestFor(selected), onChanged: () => refresh().catch(() => {}),
    onClose: closeDetail,
  };

  return (
    <div className="cv-root">
      {/* ── page header (People grammar: module chip, title, one primary action) ── */}
      <div className="view-header cv-view-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span className="cv-module-chip"><KeyRound size={19} /></span>
          <div className="view-title-group">
            <h2>Credential Vault</h2>
            <p>Company logins, kept by their owners and opened by the people who need them</p>
          </div>
        </div>
        <div className="cv-header-actions">
          {verified
            ? <span className="cv-chip tone-ok cv-chip-lg" title="Reveals and approvals inside this window do not ask for another code"><ShieldCheck size={13} /> {verifiedLabel(otp.until, now)}</span>
            : <span className="cv-chip cv-chip-lg" title="The first reveal asks for a code by text or email"><Shield size={13} /> Code on First Reveal</span>}
          {canWrite && (
            <div ref={addRef} style={{ position: "relative" }}>
              <button type="button" className="primary-btn" onClick={() => setAddMenu((v) => !v)} aria-haspopup="menu" aria-expanded={addMenu}>
                <Plus size={15} /> Add Credential <ChevronDown size={14} />
              </button>
              {addMenu && (
                <div className="cv-menu" role="menu">
                  <button type="button" role="menuitem" className="cv-menu-item" onClick={() => { setAddMenu(false); setForm({ cred: null }); }}><Plus size={14} /> New Credential</button>
                  <button type="button" role="menuitem" className="cv-menu-item" onClick={() => { setAddMenu(false); setImportOpen(true); }}><Upload size={14} /> Import From CSV</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ModuleTabs tabs={tabs} active={tab} onChange={setTab} />

      {loadError && (
        <div className="cv-callout tone-warn"><span>Could not load the vault.</span><button type="button" className="secondary-btn" style={{ marginLeft: "auto" }} onClick={() => refresh().catch(() => setLoadError(true))}>Retry</button></div>
      )}

      {tab === "vault" && (<>
        {/* ── stat strip ── */}
        <div className="cv-stats">
          <div className="cv-kpis">
            <KpiTile solid label="Credentials" value={liveRows.length} sub={`${deptsInUse.length} department${deptsInUse.length === 1 ? "" : "s"}`} onGo={() => { pickCollection("all"); listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} goTitle="See every credential" />
            <KpiTile label="Needs Attention" value={attention} tone={attention ? "warn" : undefined} sub={attention ? "weak, reused, overdue or expiring" : "nothing to fix"} onGo={() => pickCollection("attention")} goTitle="Show what needs attention" />
            <KpiTile label="Shared With Me" value={sharedWithMe} sub={sharedWithMe ? "timed access, ends by itself" : "no shared access right now"} onGo={() => pickCollection("shared")} goTitle="Show what was shared with me" />
            <KpiTile label="Awaiting Approval" value={requests.length} tone={requests.length ? "warn" : undefined} sub={requests.length ? "requests for you to decide" : "no requests waiting"} onGo={tabs.some((t) => t.key === "approvals") ? () => setTab("approvals") : undefined} goTitle="Open Approvals" />
          </div>
          <StatCard Icon={Building2} title="By Department" meta={`${deptsInUse.length} total`}>
            <DeptBars rows={liveRows} depts={deptsInUse} active={fDept} onPick={(d) => { setCollection("all"); setFDept((cur) => (cur === d ? "" : d)); }} />
          </StatCard>
          <StatCard Icon={RefreshCw} title="Rotates Next" meta="soonest first">
            <RotationList rows={liveRows} onPick={open} />
          </StatCard>
        </div>

        {/* ── directory card ── */}
        <div className="wkc cv-directory" ref={listRef}>
          <div className="cv-dir-head">
            <span className="wkc-chip"><LayoutList size={14} /></span>
            <span className="wkc-title">Credentials</span>
            <span className="cv-count-pill">{rows.length}</span>
            <label className="search-bar cv-dir-search">
              <Search size={13} style={{ flexShrink: 0 }} />
              <input placeholder="Search credentials…" aria-label="Search credentials" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}><X size={13} /></button>}
            </label>
            <select className="form-input cv-dir-select" value={fDept} onChange={(e) => setFDept(e.target.value)} aria-label="Department">
              <option value="">All departments</option>{deptsInUse.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select className="form-input cv-dir-select" value={fType} onChange={(e) => setFType(e.target.value)} aria-label="Type">
              <option value="All">All types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select className="form-input cv-dir-select" value={fTier} onChange={(e) => setFTier(e.target.value)} aria-label="Tier">
              <option value="All">All tiers</option>{TIERS.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select className="form-input cv-dir-select" value={sort.col} onChange={(e) => setSort({ col: e.target.value, dir: "asc" })} aria-label="Sort by">
              <option value="name">Name A-Z</option><option value="dept">Department</option><option value="owner">Owner</option><option value="rotated">Oldest rotation</option><option value="health">Needs attention first</option>
            </select>
          </div>
          <div className="cv-dir-tabs scroll-tabs" role="tablist" aria-label="Collections">
            {TAB_KEYS.map((key) => {
              const c = collections.find((x) => x.key === key); if (!c) return null;
              const Icon = { all: LayoutList, mine: KeyRound, shared: Users, favorites: Star, attention: ShieldCheck, trash: Trash2 }[key];
              return (
                <button key={key} type="button" role="tab" aria-selected={collection === key} className={`cv-dir-tab${collection === key ? " is-active" : ""}`} onClick={() => pickCollection(key)}>
                  <Icon size={13} /> {c.label} <span className="cv-dir-tab-n">{c.count}</span>
                </button>
              );
            })}
            {checkedEditable.length > 0 && (
              <span className="cv-bulk-inline">
                {checkedEditable.length} selected
                <button type="button" className="secondary-btn cv-danger-text" onClick={trashChecked}><Trash2 size={13} /> Move to Trash</button>
                <button type="button" className="secondary-btn" onClick={() => setChecked(new Set())}>Clear</button>
              </span>
            )}
          </div>

          <div className={`cv-master${isMobile ? " is-mobile" : ""}`}>
            <div className="cv-rows">
              {rows.length > 0 && !isMobile && editableInView.length > 0 && collection !== "trash" && (
                <label className="cv-rows-selectall">
                  <input type="checkbox" className="cv-check" aria-label="Select all you can edit" checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = !allChecked && editableInView.some((c) => checked.has(c.id)); }}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(editableInView.map((c) => c.id)))} />
                  <span>Select all you can edit</span>
                </label>
              )}
              {rows.length === 0 && (
                <div className="cv-empty">
                  <KeyRound size={28} style={{ opacity: .25, display: "block", margin: "0 auto 10px" }} />
                  <strong>{collection === "trash" ? "The trash is empty" : query || fDept ? "No credentials match" : collection === "shared" ? "Nothing shared with you right now" : collection === "favorites" ? "No favorites yet" : collection === "attention" ? "All clear" : "No credentials here yet"}</strong>
                  {collection === "favorites" ? "Star a credential to keep it at hand." : collection === "attention" ? "Nothing you can open is weak, reused, overdue or expiring." : query || fDept ? "Try another name, username, link, owner or department." : canWrite && collection !== "trash" ? "Add one, or import a CSV." : ""}
                </div>
              )}
              {rows.map((c) => {
                const flags = c.canReveal ? healthFlags(c) : [];
                const tone = c.canReveal ? healthTone(c) : "muted";
                const active = selectedId === c.id;
                return (
                  <div key={c.id} id={`cred-row-${c.id}`} className={`cv-prow${active ? " is-active" : ""}`}>
                    {c.canEdit && !c.deletedAt && !isMobile && (
                      <span className="cv-prow-check">
                        <input type="checkbox" className="cv-check" aria-label={`Select ${c.name}`} checked={checked.has(c.id)} onChange={() => toggleChecked(c.id)} />
                      </span>
                    )}
                    <button type="button" className="cv-prow-btn" onClick={() => open(c.id)} aria-current={active ? "true" : undefined}>
                    <Monogram name={c.name} dept={c.dept} depts={deptsInUse} />
                    <div className="cv-prow-main">
                      <div className="cv-prow-name">
                        <span className="cv-truncate">{c.name}</span>
                        {c.tier !== "Standard" && <span className={`cv-chip cv-chip-xs ${c.tier === "Critical" ? "tone-bad" : "tone-warn"}`}>{c.tier}</span>}
                        {favorites.has(c.id) && <Star size={12} className="cv-prow-star" fill="currentColor" />}
                      </div>
                      <div className="cv-prow-sub">
                        {c.dept || "No department"}
                        {c.canReveal && c.username && c.username !== "-" ? <> · <span className="cv-truncate-inline">{c.username}</span></> : null}
                        {!c.canReveal && !c.deletedAt ? <> · <span className="cv-muted">owned by {nameOf(c.owner)}</span></> : null}
                      </div>
                      {flags.length > 0 && <div className="cv-prow-flags">{flags.slice(0, 2).map((f) => <span key={f.key} className={`cv-chip cv-chip-xs tone-${f.tone}`}>{f.label}</span>)}</div>}
                    </div>
                    <span className={`cv-chip cv-chip-xs tone-${c.deletedAt ? "bad" : ACCESS_TONE[c.access] || "muted"} cv-prow-access`}>{c.deletedAt ? "In Trash" : ACCESS_LABEL[c.access]}</span>
                    <span className={`cv-dot tone-${tone}`} title={c.canReveal ? (flags.map((f) => f.label).join(", ") || "Healthy") : "Ask for access to see its health"} />
                    <ChevronRight size={14} className="cv-prow-chev" />
                    </button>
                  </div>
                );
              })}
            </div>
            {!isMobile && (
              <div className="cv-pane">
                {selected ? <CredentialDetail key={selected.id} {...detailProps} /> : (
                  <div className="cv-pane-empty">
                    <KeyRound size={30} style={{ opacity: .25, display: "block", margin: "0 auto 10px" }} />
                    <div className="cv-pane-empty-title">Pick a credential</div>
                    <div>Its sign-in, access and history open right here - no page hopping.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </>)}

      {/* Mounted once the tab is first opened and kept mounted after, hidden
          behind the other tabs: its unlock window must survive a trip to
          Vault and back (one unlock per window, Neil Oct 14 2026). */}
      {personalSeen.current && <div hidden={tab !== "personal"}><PersonalVault myEmail={myEmail} flash={flash} active={tab === "personal"} /></div>}

      {tab === "approvals" && (
        <div className="wkc">
          <div className="wkc-head"><span className="wkc-chip"><Inbox size={14} /></span><span className="wkc-title">Approvals</span><span className="wkc-meta">{requests.length} waiting</span></div>
          {requests.length === 0 && <div className="cv-empty"><CheckCircle2 size={28} style={{ opacity: .25, display: "block", margin: "0 auto 10px" }} /><strong>No requests waiting</strong>When someone asks for a credential you own, it shows up here.</div>}
          {requests.map((r) => (
            <div key={r.id} className="cv-req">
              <Monogram name={r.cred} dept={r.dept} depts={deptsInUse} size={40} />
              <div className="cv-req-main">
                <b>{r.cred}</b>
                <p><strong>{r.requestedBy}</strong> asks for {r.duration.toLowerCase()} of access · {r.dept} · {agoLabel(r.ts)}{r.sharedToEmail && r.sharedToEmail !== r.requestedByEmail ? ` · for ${nameOf(r.sharedToEmail)}` : ""}</p>
              </div>
              <div className="cv-req-actions">
                <button type="button" className="secondary-btn cv-danger-text" onClick={() => deny(r)}><XCircle size={14} /> Decline</button>
                <button type="button" className="primary-btn" onClick={() => approve(r)}><CheckCircle2 size={14} /> Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "activity" && (
        <div className="wkc">
          <div className="cv-dir-head">
            <span className="wkc-chip"><History size={14} /></span>
            <span className="wkc-title">Activity</span>
            <span className="cv-count-pill">{visibleLog.length}</span>
            <label className="search-bar cv-dir-search">
              <Search size={13} style={{ flexShrink: 0 }} />
              <input placeholder="Search activity…" aria-label="Search activity" value={logFilter.query} onChange={(e) => setLogFilter((f) => ({ ...f, query: e.target.value }))} />
            </label>
            <select className="form-input cv-dir-select" value={logFilter.action} onChange={(e) => setLogFilter((f) => ({ ...f, action: e.target.value }))} aria-label="Action">{LOG_ACTIONS.map((a) => <option key={a} value={a}>{a === "All" ? "All actions" : a}</option>)}</select>
            <input type="date" className="form-input cv-dir-select" aria-label="From" value={logFilter.from} onChange={(e) => setLogFilter((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" className="form-input cv-dir-select" aria-label="To" value={logFilter.to} onChange={(e) => setLogFilter((f) => ({ ...f, to: e.target.value }))} />
          </div>
          {visibleLog.length === 0 && <div className="cv-empty"><strong>No activity matches</strong>Try another person, credential, action or date range.</div>}
          <div className="cv-divide">
            {visibleLog.map((e) => {
              const linked = e.credId && creds.some((c) => c.id === e.credId);
              return (
                <div key={e.id} className={`cv-log-row${linked ? " is-link" : ""}`} onClick={() => linked && open(e.credId)}
                  role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} onKeyDown={(e2) => { if (linked && (e2.key === "Enter" || e2.key === " ")) { e2.preventDefault(); open(e.credId); } }}>
                  <span className="cv-avatar">{(e.actor || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div><b style={{ fontWeight: 600 }}>{e.actor}</b> <span style={{ ...actionStyle(e.action), borderRadius: 6, padding: "1px 7px", fontSize: 11.5, fontWeight: 600 }}>{e.action}</span> <span style={{ color: "var(--text-secondary)" }}>{e.cred}</span></div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                      {e.dept !== "-" ? e.dept : ""}
                      {Array.isArray(e.detail) && e.detail.length > 0 && <span className="cv-diff" style={{ paddingLeft: e.dept !== "-" ? 8 : 0 }}>{e.detail.map((d, i) => <span key={i} style={{ marginRight: 10 }}>{d.field}: {d.from ? <><s>{d.from}</s> → </> : null}{d.to}</span>)}</span>}
                    </div>
                  </div>
                  <time title={formatDateTime(e.ts)}>{agoLabel(e.ts)}</time>
                  {linked && <ChevronRight size={14} className="cv-prow-chev" />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected && isMobile && <CredentialSheet key={selected.id} {...detailProps} />}
      {form && <CredentialForm cred={form.cred} depts={depts} people={people} myEmail={myEmail} onClose={() => setForm(null)} onSave={saveCredential} />}
      {importOpen && <ImportModal depts={depts} onClose={() => setImportOpen(false)} onImport={importRows} />}
      {shareFor && <ShareModal cred={shareFor} people={people.filter((p) => p.email !== myEmail)} nameOf={nameOf} onClose={() => setShareFor(null)} onSubmit={(email, ms, label) => share(shareFor, email, ms, label)} />}
      {requestFor && <RequestModal cred={requestFor} nameOf={nameOf} onClose={() => setRequestFor(null)} onSubmit={(ms, label) => request(requestFor, ms, label)} />}
      {otpGate && <VaultOtpModal onClose={() => setOtpGate(null)} onVerified={afterOtp} />}

      {toast && <div className={`cv-toast${toast.kind === "info" ? " cv-toast-info" : ""}`} role="status"><ShieldCheck size={15} /> {toast.msg}</div>}
    </div>
  );
}
