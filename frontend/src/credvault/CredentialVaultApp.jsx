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
   Tabs (Oct 29 2026): My Logins (the everyday list - what I can open, copy
   from the row, Open the site), Personal, Overview (the company numbers and
   the audit table, for owners, heads and admins), Approvals, Activity. Deep
   links arrive as `activeSub` (vaultModel.parseSub) from the bell and the
   header search; a credential link lands in My Logins with it open. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyRound, ShieldCheck, Shield, Search, Plus, Upload, Star, Trash2, Users, ChevronRight, ChevronDown, X,
  CheckCircle2, XCircle, History, Lock, Inbox, LayoutList, LayoutDashboard,
} from "lucide-react";
import { api } from "../api";
import { ensureStepUp, isStepUpRequired } from "../stepup/StepUp";
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
  parseSub, verifiedLabel, readFavorites, writeFavorites, logMatches, live, readRecents, noteRecent, siteOf,
} from "./vaultModel";
import { Monogram } from "./vaultCards";
import MyLogins from "./MyLogins";
import Overview from "./Overview";
import CredentialSheet, { CredentialDetail } from "./CredentialDrawer";
import { CredentialForm, ImportWizard, ShareModal, RequestModal } from "./CredentialForm";
import PersonalVault from "./PersonalVault";
import { Pager } from "./vaultShared";
import "./credvault.css";

const LOG_ACTIONS = ["All", "Revealed", "Copied", "Created", "Edited", "Shared", "Requested", "Denied", "Revoked", "Transferred", "Removed", "Recovered", "Imported", "Offboarded"];
const TAB_KEYS = ["all", "mine", "shared", "favorites", "attention", "nobackup", "trash"];
const CLIP_SECONDS = 30;
const LOG_PAGE = 20;           // Activity rows per page       // a copied password is wiped from the clipboard after this

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
  const [orgOpts, setOrgOpts] = useState({ companies: [], departments: [] });   // Settings > Companies, for the form and the Overview filter
  const [fCompany, setFCompany] = useState("");
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
    api.cvAudienceOptions().then((o) => setOrgOpts({ companies: o?.companies || [], departments: o?.departments || [] })).catch(() => {});
  }, [refresh]);

  // ── ui state ────────────────────────────────────────────────────────────
  const [tab, setTab] = useState("logins");
  const landed = useRef(false);
  const personalSeen = useRef(false);
  if (tab === "personal") personalSeen.current = true;
  const [collection, setCollection] = useState("all");
  // Non-admins have no "All Credentials": their list opens on Owned by Me.
  useEffect(() => { if (!loading && !isAdmin && collection === "all") setCollection("mine"); }, [loading, isAdmin, collection]);
  const [query, setQuery] = useState("");
  const [fDept, setFDept] = useState("");
  const [fType, setFType] = useState("All");
  const [fTier, setFTier] = useState("All");
  const [sort, setSort] = useState({ col: "name", dir: "asc" });
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [favorites, setFavorites] = useState(readFavorites);
  const [recents, setRecents] = useState(readRecents);
  const [loginQuery, setLoginQuery] = useState("");
  const [done, setDone] = useState("");                    // "<id>:u" | "<id>:p" - the row button that just copied
  const [clipLeft, setClipLeft] = useState(0);
  const clipTimer = useRef(null);
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
    const { tab: t, credId, collection: col, create } = parseSub(sub);
    if (!t) return;
    setTab(t === "vault" ? (credId ? "logins" : "overview") : t);
    if (col) setCollection(col);
    if (credId) { setCollection("all"); setFDept(""); setSelectedId(credId); }
    if (create && canWrite) setForm({ cred: null });
  }, [canWrite]);
  useEffect(() => { applySub(activeSub); }, [activeSub, applySub]);
  useEffect(() => {
    const h = (e) => { if (e.detail?.view === "credvault") applySub(e.detail.sub); };
    window.addEventListener("nexus:navigate", h);
    return () => window.removeEventListener("nexus:navigate", h);
  }, [applySub]);

  // ── derived ─────────────────────────────────────────────────────────────
  const ctx = useMemo(() => ({ favorites, myEmail }), [favorites, myEmail]);
  // Overview scope (Pranshu, Oct 29 2026): a Global Admin sees every login;
  // an owner, backup owner or department head sees the ones they manage plus
  // what is shared with them - never the whole company's list or health.
  const inScope = useCallback((c) => isAdmin || c.canEdit || c.access === "shared" || c.access === "person", [isAdmin]);
  const scoped = useMemo(() => creds.filter(inScope), [creds, inScope]);
  const collections = useMemo(() => collectionsFor(scoped, ctx), [scoped, ctx]);
  const countOf = (key) => collections.find((c) => c.key === key)?.count || 0;
  const liveRows = useMemo(() => live(scoped).filter((c) => !fCompany || c.companyId === fCompany), [scoped, fCompany]);
  const depts = useMemo(() => {
    const set = new Set(hrDepts.length ? hrDepts : DEFAULT_DEPTS);
    liveRows.forEach((c) => c.dept && set.add(c.dept));
    return [...set];
  }, [liveRows, hrDepts]);
  const deptsInUse = useMemo(() => [...new Set(liveRows.map((c) => c.dept).filter(Boolean))].sort(), [liveRows]);
  const rows = useMemo(() => {
    const base = filterCredentials(scoped, { collection, query, type: fType, tier: fTier, ...ctx }).filter((c) => !fCompany || c.companyId === fCompany);
    return sortCredentials(fDept ? base.filter((c) => c.dept === fDept) : base, sort);
  }, [scoped, collection, query, fType, fTier, fDept, fCompany, ctx, sort]);
  const selected = useMemo(() => creds.find((c) => c.id === selectedId) || null, [creds, selectedId]);
  const verified = otp.verified && otp.until > now;
  const attention = countOf("attention");
  const checkedEditable = rows.filter((c) => checked.has(c.id) && c.canEdit && !c.deletedAt);
  const visibleLog = useMemo(() => logs.filter((e) => logMatches(e, logFilter)), [logs, logFilter]);
  // Activity is paged, 20 a page (Pranshu, Oct 29 2026); a filter change goes back to page 1.
  const [logPage, setLogPage] = useState(1);
  useEffect(() => { setLogPage(1); }, [logFilter]);
  const logPages = Math.max(1, Math.ceil(visibleLog.length / LOG_PAGE));
  const pagedLog = visibleLog.slice((logPage - 1) * LOG_PAGE, logPage * LOG_PAGE);
  const sharedWithMe = countOf("shared");
  const canManage = isAdmin || creds.some((c) => c.canEdit);
  // The landing tab is decided once the list is in: Overview for owners,
  // heads and admins - unless a deep link already picked a place.
  useEffect(() => {
    if (loading || landed.current) return;
    landed.current = true;
    if (canManage && !parseSub(activeSub).tab) setTab("overview");
  }, [loading, canManage, activeSub]);
  useEffect(() => {
    if (!clipLeft) return undefined;
    const t = setTimeout(() => setClipLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [clipLeft]);

  // Closing the detail drops the revealed secret with it.
  function closeDetail() { setSelectedId(null); setRevealed(null); }
  function open(id) { setSelectedId(id); setTab((t) => (t === "overview" ? t : "logins")); }
  // The clipboard: write, say so on the row, and wipe it after CLIP_SECONDS
  // so a password does not sit there all afternoon (Bitwarden's default).
  async function clip(text, key) {
    try { await navigator.clipboard?.writeText(text); } catch { /* blocked */ }
    setDone(key); setTimeout(() => setDone((d) => (d === key ? "" : d)), 1600);
    clearTimeout(clipTimer.current);
    setClipLeft(CLIP_SECONDS);
    clipTimer.current = setTimeout(() => { navigator.clipboard?.writeText("").catch?.(() => {}); setClipLeft(0); }, CLIP_SECONDS * 1000);
  }
  function used(id) { setRecents(noteRecent(id)); }

  // ── the code gate ───────────────────────────────────────────────────────
  // One verified code opens a window (Settings > Security); inside it every
  // reveal / share / approve runs straight away. The window is checked at
  // click time, and an action the API still refuses with vault_otp_required
  // re-opens the gate with the same action instead of a toast.
  function gated(run) {
    const wrapped = () => run().catch(async (e) => {
      if (e?.detail?.code === "vault_otp_required") { setOtp({ verified: false, until: null }); setOtpGate({ run: wrapped }); return; }
      // Critical + Settings > Security step-up (Oct 29 2026): run the Entra
      // challenge, then the same action again.
      if (isStepUpRequired(e)) { const r = await ensureStepUp(); if (r.ok) return wrapped(); if (!r.cancelled) flash("Verification did not complete.", "info"); return; }
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
  const otpError = (e) => e?.detail?.code === "vault_otp_required" || isStepUpRequired(e);
  async function reveal(c) {
    try {
      const res = await api.cvReveal(c.id);
      setRevealed({ id: c.id, ...res });
      api.cvLogs().then(setLogs).catch(() => {});
    } catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not reveal.", "info"); }
  }
  function copiedSecret(c) { used(c.id); api.cvCopied(c.id).then(() => api.cvLogs().then(setLogs)).catch(() => {}); flash("Password copied. This was logged."); }
  function copyUser(c) { clip(c.username, `${c.id}:u`); used(c.id); }
  // Copy Password from the row: reveal (behind the code gate), copy, log - the
  // password is never shown and never kept.
  function copyPassword(c) {
    gated(async () => {
      try { const res = await api.cvReveal(c.id); await clip(res.secret, `${c.id}:p`); copiedSecret(c); }
      catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not copy.", "info"); }
    });
  }
  // Copy Code from the row: the current authenticator code, behind the same gate.
  function copyCode(c) {
    gated(async () => {
      try { const r = await api.cvTotp(c.id); await clip(r.code, `${c.id}:t`); used(c.id); flash(`Code copied - good for ${r.left}s.`); }
      catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not get the code.", "info"); }
    });
  }
  // Open: copy the password, then open the site - the username is in the
  // toast, so signing in is paste, type, done. (The clipboard cannot be
  // written once the new tab takes focus, so the copy comes first.)
  function openSite(c) {
    const site = siteOf(c.url);
    gated(async () => {
      try {
        const res = await api.cvReveal(c.id);
        await clip(res.secret, `${c.id}:p`);
        used(c.id); api.cvCopied(c.id).then(() => api.cvLogs().then(setLogs)).catch(() => {});
        window.open(c.url, "_blank", "noopener,noreferrer");
        flash(`Password copied - paste it on ${site}.${c.username && c.username !== "-" ? ` Username: ${c.username}` : ""}`);
      } catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not open.", "info"); }
    });
  }

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
  // The wizard shows the result itself and closes on Done; this only sends
  // the rows and refreshes the list behind it.
  async function importRows(list) {
    const res = await api.cvImport(list);
    refresh().catch(() => {});
    return res;
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
  // Held on the drawer's Delete Permanently (Neil, Oct 30 2026): no dialog;
  // a refusal throws so the button rewinds with the reason.
  async function purge(c) {
    try { await api.cvPurge(c.id); } catch (e) { throw new Error(e?.message || "Could not delete.", { cause: e }); }
    closeDetail(); await refresh(); flash(`${c.name} deleted permanently.`, "info");
  }
  async function share(c, body) {
    setShareFor(null);
    await gated(async () => {
      try {
        const r = await api.cvShare(c.id, body);
        await refresh();
        const who = body.recipients.length === 1 && !body.departments.length ? nameOf(body.recipients[0]) : `${r?.granted ?? ""} ${r?.granted === 1 ? "person" : "people"}`.trim();
        flash(`${c.name} shared with ${who} ${body.durationLabel.startsWith("Until") ? body.durationLabel.toLowerCase() : `for ${body.durationLabel.toLowerCase()}`}.`);
      } catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not share.", "info"); }
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
  function pickCollection(key) { setCollection(key === "all" && !isAdmin ? "mine" : key); setFDept(""); }

  if (loading) return <div style={{ padding: "16px 0" }}><SkeletonBlocks count={6} height={52} /></div>;

  // Overview leads for the people who have it (Pranshu, Oct 29 2026: the
  // numbers first, then the list); everyone else opens on My Logins.
  const tabs = [
    ...(canManage ? [{ key: "overview", label: "Overview", Icon: LayoutDashboard }] : []),
    { key: "logins", label: "My Logins", Icon: KeyRound },
    { key: "personal", label: "Personal", Icon: Lock },
    ...((isAdmin || requests.length || tab === "approvals" || creds.some((c) => c.canEdit)) ? [{ key: "approvals", label: "Approvals", Icon: Inbox, badge: requests.length || null }] : []),
    { key: "activity", label: "Activity", Icon: History },
  ];
  if (tab === "overview" && !canManage) setTab("logins");
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
            <h2>Credentials</h2>
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
                  <button type="button" role="menuitem" className="cv-menu-item" onClick={() => { setAddMenu(false); setImportOpen(true); }}><Upload size={14} /> Import From a Spreadsheet</button>
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

      {tab === "logins" && (
        <div className={`wkc cv-directory cv-master is-logins${isMobile ? " is-mobile" : ""}`}>
          <MyLogins rows={creds} depts={deptsInUse} favorites={favorites} recents={recents} query={loginQuery} onQuery={setLoginQuery}
            selectedId={selectedId} now={now} nameOf={nameOf} done={done} clipLeft={clipLeft}
            onOpen={open} onToggleFavorite={toggleFavorite} onCopyUser={copyUser} onCopyPassword={copyPassword} onOpenSite={openSite} onCopyCode={copyCode} onRequest={setRequestFor} />
          {!isMobile && (
            <div className="cv-pane">
              {selected ? <CredentialDetail key={selected.id} {...detailProps} /> : (
                <div className="cv-pane-empty">
                  <KeyRound size={30} style={{ opacity: .25, display: "block", margin: "0 auto 10px" }} />
                  <div className="cv-pane-empty-title">Copy from the row, or open a login</div>
                  <div>User and Password copy straight from the list; Open copies the password and opens the site. Click a name for everything else.</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "overview" && canManage && (<>
        <Overview rows={liveRows} depts={deptsInUse} attention={attention} sharedWithMe={sharedWithMe} requests={requests.length} fDept={fDept} nameOf={nameOf} everyone={isAdmin}
          onPickDept={(d) => { setCollection("all"); setFDept((cur) => (cur === d ? "" : d)); listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
          onPickCollection={(k) => { pickCollection(k); listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
          onOpen={open} onApprovals={tabs.some((t) => t.key === "approvals") ? () => setTab("approvals") : undefined} />

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
            {orgOpts.companies.length > 1 && (
              <select className="form-input cv-dir-select" value={fCompany} onChange={(e) => setFCompany(e.target.value)} aria-label="Company">
                <option value="">All companies</option>{orgOpts.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
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
            {TAB_KEYS.filter((key) => isAdmin || key !== "all").map((key) => {
              const c = collections.find((x) => x.key === key); if (!c) return null;
              const Icon = { all: LayoutList, mine: KeyRound, shared: Users, favorites: Star, attention: ShieldCheck, nobackup: Users, trash: Trash2 }[key];
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
                  <strong>{collection === "trash" ? "The trash is empty" : query || fDept ? "No credentials match" : collection === "shared" ? "Nothing shared with you right now" : collection === "favorites" ? "No favorites yet" : collection === "attention" ? "All clear" : collection === "nobackup" ? "Every login has a backup owner" : "No credentials here yet"}</strong>
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
            {pagedLog.map((e) => {
              const linked = e.credId && creds.some((c) => c.id === e.credId);
              return (
                <div key={e.id} className={`cv-log-row${linked ? " is-link" : ""}`} onClick={() => linked && open(e.credId)}
                  role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} onKeyDown={(e2) => { if (linked && (e2.key === "Enter" || e2.key === " ")) { e2.preventDefault(); open(e.credId); } }}>
                  <span className="cv-avatar">{(e.actor || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div><b style={{ fontWeight: 600 }}>{e.actor}</b> <span style={{ ...actionStyle(e.action), borderRadius: 6, padding: "1px 7px", fontSize: 11.5, fontWeight: 600 }}>{e.action}</span> <span style={{ color: "var(--text-secondary)" }}>{e.cred}</span></div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                      {e.dept !== "-" ? e.dept : ""}
                      {e.ip ? <span title={e.userAgent || ""} style={{ paddingLeft: e.dept !== "-" ? 8 : 0 }}>from {e.ip}</span> : null}
                      {Array.isArray(e.detail) && e.detail.length > 0 && <span className="cv-diff" style={{ paddingLeft: e.dept !== "-" ? 8 : 0 }}>{e.detail.map((d, i) => <span key={i} style={{ marginRight: 10 }}>{d.field}: {d.from ? <><s>{d.from}</s> → </> : null}{d.to}</span>)}</span>}
                    </div>
                  </div>
                  <time title={formatDateTime(e.ts)}>{agoLabel(e.ts)}</time>
                  {linked && <ChevronRight size={14} className="cv-prow-chev" />}
                </div>
              );
            })}
          </div>
          <Pager page={logPage} pages={logPages} total={visibleLog.length} size={LOG_PAGE} onPage={setLogPage} />
        </div>
      )}

      {selected && isMobile && <CredentialSheet key={selected.id} {...detailProps} />}
      {form && <CredentialForm cred={form.cred} depts={depts} people={people} myEmail={myEmail} nameOf={nameOf} companies={orgOpts.companies} deptRows={orgOpts.departments} myCompanyId={orgOpts.companies.length === 1 ? orgOpts.companies[0].id : ""} onClose={() => setForm(null)} onSave={saveCredential} />}
      {importOpen && <ImportWizard depts={depts} people={people} myEmail={myEmail} existing={creds} nameOf={nameOf} onClose={() => setImportOpen(false)} onImport={importRows} />}
      {shareFor && <ShareModal cred={shareFor} people={people.filter((p) => p.email !== myEmail)} nameOf={nameOf} deptRows={orgOpts.departments} companies={orgOpts.companies} onClose={() => setShareFor(null)} onSubmit={(body) => share(shareFor, body)} />}
      {requestFor && <RequestModal cred={requestFor} nameOf={nameOf} onClose={() => setRequestFor(null)} onSubmit={(ms, label) => request(requestFor, ms, label)} />}
      {otpGate && <VaultOtpModal onClose={() => setOtpGate(null)} onVerified={afterOtp} />}

      {toast && <div className={`cv-toast${toast.kind === "info" ? " cv-toast-info" : ""}`} role="status"><ShieldCheck size={15} /> {toast.msg}</div>}
    </div>
  );
}
