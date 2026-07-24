/* eslint-disable react-hooks/refs -- renders a live auto-lock countdown from a last-activity ref (ticked by state); a safe intentional ref read the React-Compiler rule flags */
/* Credential Vault — main module screen. 1:1 functional port of the standalone
   credential-vault-dev app onto the Nexus backend: company vault (reveal/copy/
   share/approvals/trash/import), strictly-private personal vault, and a full
   activity log. Secrets only ever arrive via explicit reveal calls and are held
   in memory for the timed reveal window only. */
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Shield, ShieldCheck, ShieldAlert, Eye, Copy, Check, Search, Bell, Plus,
  KeyRound, Clock, AlertTriangle, History, ChevronDown, X, RefreshCw, Users,
  Building2, Lock, MapPin, CheckCircle2, XCircle, List, LayoutGrid, Settings,
  Repeat2, CalendarClock, Trash2, HeartPulse, Upload, User, Pencil,
  ExternalLink, Share2,
} from "lucide-react";
import { api } from "../api";
import { ensureStepUp } from "../stepup/StepUp";
import { useRole } from "../contexts/RoleContext";
import { useNameResolver } from "../lib/useNameResolver";
import {
  DEFAULT_DEPTS, TYPES, SETTINGS, iconFor, tierStyle, actionStyle, agoLabel,
  Dot, Empty, Dropdown, Modal, StatPill, ViewBtn, Select, ResizeHandle,
  SecretControls, TeamsIcon, MsLogo,
  ConfirmModal, AddModal, EditModal, ImportModal, ManagePanel,
  PersonalAddModal, RequestAccessModal, ApproveAccessModal,
} from "./vaultShared";
import "./credvault.css";

const TabBtn = ({ active, onClick, children }) => (
  <button onClick={onClick} className={`cv-tab${active ? " active" : ""}`}>{children}</button>
);

export default function CredentialVaultApp() {
  const { myEmail, can, canAccessModule } = useRole();
  const isAdmin = can("administrator");
  const canWrite = canAccessModule("credvault", "administrator", "editor");
  const nameOf = useNameResolver();
  const maskedPhone = "••• ••• ••••";

  // ── Server data ────────────────────────────────────────────────────────────
  const [allCreds, setAllCreds] = useState([]);
  const [log, setLog] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [accessGrants, setAccessGrants] = useState([]);
  const [personalCreds, setPersonalCreds] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const credentials = useMemo(() => allCreds.filter((c) => !c.deletedAt), [allCreds]);
  const trash = useMemo(() => allCreds.filter((c) => c.deletedAt), [allCreds]);

  const refresh = useCallback(async () => {
    const [creds, logs, reqs, grants] = await Promise.all([
      api.cvCredentials(), api.cvLogs(), api.cvRequests(), api.cvGrants(),
    ]);
    setAllCreds(creds); setLog(logs); setApprovals(reqs); setAccessGrants(grants);
    setLoadError(false);
  }, []);
  const refreshPersonal = useCallback(() => api.cvPersonal().then(setPersonalCreds).catch(() => {}), []);

  useEffect(() => {
    refresh().catch(() => setLoadError(true)).finally(() => setLoading(false));
    refreshPersonal();
    api.getRolesDirectory().then((rows) => setPeople(rows || [])).catch(() => {});
  }, [refresh, refreshPersonal]);

  // ── UI state (mirrors the standalone app) ─────────────────────────────────
  const [tab, setTab] = useState("vault");
  const [view, setView] = useState("list");
  const [query, setQuery] = useState("");
  const [fDept, setFDept] = useState("All");
  const [fType, setFType] = useState("All");
  const [atRiskOnly, setAtRiskOnly] = useState(false);
  const [riskFilter, setRiskFilter] = useState(null); // 'breached'|'weak'|'reused'|'expiring'
  const [sort, setSort] = useState({ col: null, dir: "asc" });
  const [colWidths, setColWidths] = useState([28, 24, 16, 16, 16]);
  const [notifications, setNotifications] = useState([]);
  const [revealed, setRevealed] = useState({});            // { id: { until, secret } }
  const [revealedGrants, setRevealedGrants] = useState({}); // { grantId: secret }
  const [requestingAccessFor, setRequestingAccessFor] = useState(null);
  const [approvingRequest, setApprovingRequest] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [copiedUser, setCopiedUser] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [highlightedId, setHighlightedId] = useState(null);
  const [logFrom, setLogFrom] = useState("");
  const [logTo, setLogTo] = useState("");
  const [vaultMode, setVaultMode] = useState("company");
  const [personalVaultUnlocked, setPersonalVaultUnlocked] = useState(false);
  const [showPersonalAdd, setShowPersonalAdd] = useState(false);
  const [personalRevealed, setPersonalRevealed] = useState({}); // { id: { until, secret } }
  const [personalCopiedId, setPersonalCopiedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [menu, setMenu] = useState(null); // 'notif' | 'add'
  const personalLastActivityRef = useRef(null);

  const personalActivated = personalCreds.length > 0;

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  // Expire timed reveals (and drop the secrets from memory)
  useEffect(() => {
    setRevealed((p) => { const n = {}; let ch = false; for (const k in p) { if (p[k].until > now) n[k] = p[k]; else ch = true; } return ch ? n : p; });
    setPersonalRevealed((p) => { const n = {}; let ch = false; for (const k in p) { if (p[k].until > now) n[k] = p[k]; else ch = true; } return ch ? n : p; });
  }, [now]);

  useEffect(() => { setEditMode(false); setSelectedIds(new Set()); }, [tab]);

  // Rotation-due reminders into the module bell — once per day
  useEffect(() => {
    if (!credentials.length || !myEmail) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = `gv_rot_notified_${myEmail}_${today}`;
    try { if (localStorage.getItem(key)) return; } catch { /* private mode */ }
    const due = credentials.filter((c) => {
      const remaining = (c.rotationMax || SETTINGS.rotationDays) - c.rotatedDays;
      return c.owner === myEmail && remaining > 0 && remaining <= 10;
    });
    if (!due.length) return;
    due.forEach((c) => {
      const remaining = (c.rotationMax || SETTINGS.rotationDays) - c.rotatedDays;
      notify(`${c.name} (${c.dept}) — password rotation due in ${remaining} day${remaining === 1 ? "" : "s"}. Please rotate before it expires.`, "rotation");
    });
    try { localStorage.setItem(key, "1"); } catch { /* private mode */ }
  }, [credentials, myEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset personal-vault activity on unlock + track interaction + auto-lock 2 min
  useEffect(() => { if (personalVaultUnlocked) personalLastActivityRef.current = Date.now(); }, [personalVaultUnlocked]);
  useEffect(() => {
    if (!personalVaultUnlocked) return;
    const bump = () => { personalLastActivityRef.current = Date.now(); };
    ["mousemove", "keydown", "click", "touchstart"].forEach((ev) => document.addEventListener(ev, bump, { passive: true }));
    return () => ["mousemove", "keydown", "click", "touchstart"].forEach((ev) => document.removeEventListener(ev, bump));
  }, [personalVaultUnlocked]);
  useEffect(() => {
    if (!personalVaultUnlocked) return;
    const AUTO_LOCK_MS = 2 * 60 * 1000;
    const timer = setInterval(() => {
      if (personalLastActivityRef.current && Date.now() - personalLastActivityRef.current >= AUTO_LOCK_MS) {
        setPersonalVaultUnlocked(false);
        setVaultMode("company");
        setPersonalRevealed({});
        setToast({ msg: "Personal Vault auto-locked due to 2 minutes of inactivity.", kind: "info" });
        setTimeout(() => setToast(null), 4000);
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [personalVaultUnlocked]);

  // Clicking anywhere non-interactive clears the at-risk filter
  useEffect(() => {
    if (!atRiskOnly) return;
    const handler = (e) => {
      const interactive = e.target.closest('button, input, select, a, label, [role="button"]');
      if (!interactive) { setAtRiskOnly(false); setRiskFilter(null); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [atRiskOnly]);

  useEffect(() => {
    if (!highlightedId) return;
    const el = document.getElementById("cred-row-" + highlightedId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightedId(null), 3000);
    return () => clearTimeout(t);
  }, [highlightedId]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const flash = (msg, kind = "ok") => { setToast({ msg, kind }); setTimeout(() => setToast(null), 2800); };
  const notify = (text, type = "change") => setNotifications((n) => [{ id: "n" + Date.now() + Math.random(), text, type, recipients: type === "change" ? "managers + IT" : null, channel: type === "change" ? "Nexus bell" : null, ts: Date.now(), read: false }, ...n]);
  const dismissNotif = (id) => setNotifications((n) => n.filter((x) => x.id !== id));
  const clearNotifs = () => setNotifications([]);
  const markAllRead = () => setNotifications((n) => n.map((x) => ({ ...x, read: true })));
  const unread = notifications.filter((n) => !n.read).length;

  const depts = useMemo(() => {
    const set = new Set(DEFAULT_DEPTS);
    credentials.forEach((c) => c.dept && set.add(c.dept));
    return [...set];
  }, [credentials]);

  const isExpiring = (c) => c.expiresInDays != null && c.expiresInDays < 30;
  const isStale = (c) => c.rotatedDays > (c.rotationMax || SETTINGS.rotationDays);
  const rotationDaysLeft = (c) => (c.rotationMax || SETTINGS.rotationDays) - c.rotatedDays;
  const isRotationDueSoon = (c) => { const left = rotationDaysLeft(c); return left > 0 && left <= 10; };
  const rotationExpiryDate = (c) => { const d = new Date(Date.now() + rotationDaysLeft(c) * 86400000); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) }); };
  const healthFlags = (c) => { const f = []; if (SETTINGS.breachScan && c.breached) f.push("Breached"); if (c.strength === "weak") f.push("Weak"); if (c.reused) f.push("Reused"); if (isExpiring(c)) f.push(`Expires ${c.expiresInDays}d`); if (isRotationDueSoon(c)) f.push(`Rotation due in ${rotationDaysLeft(c)}d`); if (isStale(c)) f.push("Rotation overdue"); return f; };
  const healthDot = (c) => ((SETTINGS.breachScan && c.breached) || c.strength === "weak") ? "#f43f5e" : (c.reused || isExpiring(c) || isStale(c) || isRotationDueSoon(c)) ? "#f59e0b" : "#10b981";

  const canModify = (c) => myEmail === c.owner || (c.backupOwner && myEmail === c.backupOwner);

  const visibleCreds = useMemo(() => {
    const filtered = credentials.filter((c) => {
      if (fDept !== "All" && c.dept !== fDept) return false;
      if (fType !== "All" && c.type !== fType) return false;
      if (atRiskOnly && healthFlags(c).length === 0) return false;
      if (riskFilter === "breached" && !(SETTINGS.breachScan && c.breached)) return false;
      if (riskFilter === "weak" && c.strength !== "weak") return false;
      if (riskFilter === "reused" && !c.reused) return false;
      if (riskFilter === "expiring" && !isStale(c) && !isRotationDueSoon(c)) return false;
      if (query && !(`${c.name} ${c.username} ${c.dept}`.toLowerCase().includes(query.toLowerCase()))) return false;
      if (editMode && !canModify(c)) return false;
      return true;
    });
    if (!sort.col) return filtered;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sort.col === "name") cmp = (a.name || "").localeCompare(b.name || "");
      else if (sort.col === "dept") cmp = (a.dept || "").localeCompare(b.dept || "");
      else if (sort.col === "owner") cmp = (a.owner || "").localeCompare(b.owner || "");
      else if (sort.col === "lastUpdated") cmp = (a.rotatedDays || 999) - (b.rotatedDays || 999);
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [credentials, fDept, fType, atRiskOnly, riskFilter, query, sort, editMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleLog = useMemo(() => log.filter((e) => {
    if (e.dept === "—" && !isAdmin && e.actorEmail !== myEmail) return false;
    if (logFrom && e.ts) { const from = new Date(logFrom).setHours(0, 0, 0, 0); if (e.ts < from) return false; }
    if (logTo && e.ts) { const to = new Date(logTo).setHours(23, 59, 59, 999); if (e.ts > to) return false; }
    return true;
  }), [log, isAdmin, myEmail, logFrom, logTo]);

  const stats = useMemo(() => ({
    total: credentials.length,
    atRisk: credentials.filter((c) => healthFlags(c).length).length,
  }), [credentials]); // eslint-disable-line react-hooks/exhaustive-deps

  const healthSummary = useMemo(() => ({
    breached: credentials.filter((c) => SETTINGS.breachScan && c.breached).length,
    weak: credentials.filter((c) => c.strength === "weak").length,
    reused: credentials.filter((c) => c.reused).length,
    expiring: credentials.filter((c) => isStale(c) || isRotationDueSoon(c)).length,
  }), [credentials]); // eslint-disable-line react-hooks/exhaustive-deps

  const credState = (c) => {
    const r = revealed[c.id];
    const isOpen = r && r.until > now;
    return {
      isOpen,
      secret: isOpen ? r.secret : null,
      remaining: isOpen ? Math.ceil((r.until - now) / 1000) : 0,
      lockedForRole: c.tier === "Critical" && !isAdmin && SETTINGS.requireApprovalCritical,
    };
  };

  function goToCredential(credId, credName) {
    const found = credentials.find((c) => c.id === credId) || credentials.find((c) => c.name === credName);
    if (!found) return;
    setFDept("All"); setFType("All"); setAtRiskOnly(false); setRiskFilter(null);
    setView("list");
    setTab("vault");
    setVaultMode("company");
    setTimeout(() => setHighlightedId(found.id), 50);
  }

  // ── Actions (server-backed) ───────────────────────────────────────────────
  async function requestReveal(c) {
    // Real, server-enforced step-up MFA before any secret is decrypted. One
    // verification unlocks a short window (covers a burst of reveals).
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) flash("Identity check didn’t complete — nothing was revealed.", "info"); return; }
    try {
      const res = await api.cvReveal(c.id);
      if (res.approvalRequired) { flash("Access request sent to a Global Admin.", "info"); refresh().catch(() => {}); return; }
      setRevealed((r) => ({ ...r, [c.id]: { until: Date.now() + SETTINGS.revealSeconds * 1000, secret: res.secret } }));
      flash(`Identity confirmed. Unmasked for ${SETTINGS.revealSeconds}s.`);
      api.cvLogs().then(setLog).catch(() => {});
    } catch (e) { flash(e.message || "Reveal failed.", "info"); }
  }
  function copySecret(c) {
    const st = credState(c);
    if (!st.secret) return;
    try { navigator.clipboard && navigator.clipboard.writeText(st.secret); } catch { /* clipboard blocked */ }
    setCopiedId(c.id);
    setTimeout(() => setCopiedId((x) => (x === c.id ? null : x)), 1500);
    api.cvCopied(c.id).then(() => api.cvLogs().then(setLog)).catch(() => {});
    flash("Copied to clipboard. This action was logged.");
  }
  async function addCredential(form) {
    try {
      await api.cvCreate(form);
      setShowAdd(false);
      await refresh();
      notify(`${form.name} (${form.dept}) was added by you.`);
      flash(`${form.name} added. Managers + IT notified.`);
    } catch (e) { flash(e.message || "Could not save the credential.", "info"); }
  }
  async function updateCredential(id, form) {
    try {
      await api.cvUpdate(id, form);
      setEditingCred(null);
      await refresh();
      flash(`${form.name} updated.`);
    } catch (e) { flash(e.message || "Could not update the credential.", "info"); }
  }
  async function deleteCredential(c) {
    try {
      await api.cvDelete(c.id);
      setConfirmDel(null);
      await refresh();
      notify(`${c.name} (${c.dept}) was removed by you.`);
      flash(`${c.name} moved to trash.`);
    } catch (e) { flash(e.message || "Could not remove the credential.", "info"); }
  }
  async function deleteSelected() {
    const count = selectedIds.size;
    try {
      await api.cvBulkDelete([...selectedIds]);
      setSelectedIds(new Set());
      await refresh();
      notify(`${count} credential${count === 1 ? "" : "s"} removed by you.`);
      flash(`${count} credential${count === 1 ? "" : "s"} moved to trash.`);
    } catch (e) { flash(e.message || "Bulk delete failed.", "info"); }
  }
  async function importCredentials(rows) {
    try {
      const res = await api.cvImport(rows);
      setShowImport(false);
      await refresh();
      notify(`${res.imported} credentials were imported by you.`);
      flash(`Imported ${res.imported} credentials. Managers + IT notified.`);
    } catch (e) { flash(e.message || "Import failed.", "info"); }
  }
  async function requestAccess(cred, durationMs, durationLabel, recipientEmail) {
    try {
      const res = await api.cvShare(cred.id, { recipientEmail, durationMs, durationLabel });
      setRequestingAccessFor(null);
      await refresh();
      if (res.granted) flash(`Access granted to ${recipientEmail} for ${cred.name} (${durationLabel}).`);
      else { flash(`Share request sent to ${nameOf(cred.owner)} for ${cred.name}.`); notify(`You asked to share ${cred.name} with ${recipientEmail}.`, "access"); }
    } catch (e) { flash(e.message || "Share failed.", "info"); }
  }
  async function decideRequest(a, decision) {
    if (decision === "approve") { setApprovingRequest(a); return; }
    try {
      await api.cvDenyRequest(a.id);
      setApprovingRequest(null);
      await refresh();
      flash(`Denied access for ${a.cred}.`, "info");
    } catch (e) { flash(e.message || "Could not deny the request.", "info"); }
  }
  async function confirmGrant(a) {
    try {
      await api.cvApproveRequest(a.id);
      setApprovingRequest(null);
      await refresh();
      const recipient = a.sharedToEmail || a.requestedByEmail;
      flash(`Approved. ${recipient} now has ${a.duration} access to ${a.cred}.`);
    } catch (e) { flash(e.message || "Could not approve the request.", "info"); }
  }
  async function revealGrant(g) {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) flash("Identity check didn’t complete.", "info"); return; }
    try {
      const res = await api.cvGrantReveal(g.id);
      setRevealedGrants((prev) => ({ ...prev, [g.id]: res.secret }));
      flash("Identity verified. Shared password is now visible.");
    } catch (e) { flash(e.message || "Reveal failed.", "info"); }
  }

  // Personal vault
  async function handlePersonalVaultToggle() {
    if (vaultMode === "personal" && personalVaultUnlocked) { setVaultMode("company"); return; }
    if (!personalVaultUnlocked) {
      const up = await ensureStepUp();
      if (!up.ok) { if (!up.cancelled) flash("Identity check didn’t complete.", "info"); return; }
      unlockPersonalVault();
      return;
    }
    setVaultMode("personal");
  }
  function unlockPersonalVault() {
    setPersonalVaultUnlocked(true);
    setVaultMode("personal");
    flash(personalActivated ? "Personal Vault unlocked." : "Personal Vault activated. Encrypted and private — not accessible to anyone else.");
  }
  function lockPersonalVault() {
    setPersonalVaultUnlocked(false);
    setVaultMode("company");
    setPersonalRevealed({});
    flash("Personal Vault locked.", "info");
  }
  async function addPersonalCredential(form) {
    try {
      await api.cvPersonalCreate(form);
      setShowPersonalAdd(false);
      await refreshPersonal();
      flash("Personal credential saved. Encrypted and visible only to you.");
    } catch (e) { flash(e.message || "Could not save.", "info"); }
  }
  async function deletePersonalCredential(id) {
    try {
      await api.cvPersonalDelete(id);
      await refreshPersonal();
      flash("Personal credential permanently deleted.");
    } catch (e) { flash(e.message || "Could not delete.", "info"); }
  }
  async function revealPersonal(c) {
    const up = await ensureStepUp();
    if (!up.ok) { if (!up.cancelled) flash("Identity check didn’t complete.", "info"); return; }
    try {
      const res = await api.cvPersonalReveal(c.id);
      setPersonalRevealed((r) => ({ ...r, [c.id]: { until: Date.now() + SETTINGS.revealSeconds * 1000, secret: res.secret } }));
    } catch (e) { flash(e.message || "Reveal failed.", "info"); }
  }
  function copyPersonalSecret(c) {
    const r = personalRevealed[c.id];
    if (!r || r.until <= now) return;
    try { navigator.clipboard && navigator.clipboard.writeText(r.secret); } catch { /* clipboard blocked */ }
    setPersonalCopiedId(c.id);
    setTimeout(() => setPersonalCopiedId((x) => (x === c.id ? null : x)), 1500);
    flash("Copied to clipboard.");
  }

  const [editingCred, setEditingCred] = useState(null);
  const myGrants = accessGrants.filter((g) => g.expiresAt > now);
  const showApprovalsTab = isAdmin || credentials.some((c) => c.owner === myEmail) || approvals.length > 0;
  const activeFilters = (fDept !== "All" ? 1 : 0) + (fType !== "All" ? 1 : 0) + (atRiskOnly ? 1 : 0) + (riskFilter ? 1 : 0);

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "50vh" }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid var(--border-color)", borderTopColor: "var(--text-primary)", animation: "spin 0.7s linear infinite" }} />
    </div>
  );

  return (
    <div className="cv-root" style={{ animation: "fadeIn var(--transition-normal) ease-in-out" }}>
      {/* ── Module header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingBottom: 14, borderBottom: "1px solid var(--border-color)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <div style={{ height: 32, width: 32, borderRadius: 8, background: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Shield size={16} style={{ color: "var(--bg-card)" }} />
          </div>
          <span style={{ fontWeight: 600, fontSize: 15.5 }}>Credential Vault</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {/* Notifications */}
          <Dropdown open={menu === "notif"} width={336}
            onToggle={() => { const opening = menu !== "notif"; setMenu(opening ? "notif" : null); if (opening) setTimeout(markAllRead, 800); }}
            trigger={
              <span style={{ position: "relative", height: 36, width: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }} className="cv-row-hover">
                <Bell size={16} />
                {unread > 0 && <span className="cv-pulse" style={{ position: "absolute", top: 6, right: 6, height: 8, width: 8, borderRadius: "50%", background: "var(--cv-rose)" }} />}
              </span>
            }>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border-color)" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>Notifications {unread > 0 && <span style={{ marginLeft: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 999, background: "var(--cv-rose-bg)", color: "var(--cv-rose)", fontSize: 11, fontWeight: 700, padding: "1px 6px" }}>{unread}</span>}</span>
              <div style={{ display: "flex", gap: 8 }}>
                {unread > 0 && <button onClick={markAllRead} style={{ background: "none", border: "none", fontSize: 11.5, color: "var(--text-muted)", cursor: "pointer" }}>Mark All Read</button>}
                {notifications.length > 0 && <button onClick={clearNotifs} style={{ background: "none", border: "none", fontSize: 11.5, color: "var(--text-muted)", cursor: "pointer" }}>Clear All</button>}
              </div>
            </div>
            {notifications.filter((n) => n.type === "rotation").length > 0 && (<>
              <div style={{ padding: "8px 12px 4px", fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--cv-amber)", display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={13} /> Rotation alerts</div>
              <div style={{ maxHeight: 176, overflowY: "auto" }}>
                {notifications.filter((n) => n.type === "rotation").map((n) => (
                  <div key={n.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 12px", borderRadius: 8, margin: "0 4px", background: !n.read ? "var(--cv-amber-bg)" : "transparent" }}>
                    <AlertTriangle size={13} style={{ color: "var(--cv-amber)", flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13, lineHeight: 1.4, margin: 0, fontWeight: !n.read ? 500 : 400, color: !n.read ? "var(--text-primary)" : "var(--text-secondary)" }}>{n.text}</p>
                      <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "2px 0 0" }}>{agoLabel(n.ts)}</p>
                    </div>
                    <button onClick={() => dismissNotif(n.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, marginTop: 2 }}><X size={13} /></button>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: "1px solid var(--border-color)", margin: "4px 0" }} />
            </>)}
            <div style={{ padding: "8px 12px 4px", fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}><Bell size={13} /> Activity</div>
            {notifications.filter((n) => n.type !== "rotation").length === 0 && (
              <div style={{ padding: "20px 12px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>No recent activity. Credential changes notify all managers + IT.</div>
            )}
            <div style={{ maxHeight: 240, overflowY: "auto", paddingBottom: 4 }}>
              {notifications.filter((n) => n.type !== "rotation").map((n) => (
                <div key={n.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 12px", borderRadius: 8, margin: "0 4px", background: !n.read ? "var(--bg-secondary)" : "transparent" }}>
                  <div style={{ height: 24, width: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2, background: "var(--bg-secondary)" }}>
                    {n.type === "access" ? <Share2 size={12} style={{ color: "var(--cv-violet)" }} /> : <Bell size={12} style={{ color: "var(--text-muted)" }} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13, lineHeight: 1.4, margin: 0, fontWeight: !n.read ? 500 : 400, color: !n.read ? "var(--text-primary)" : "var(--text-secondary)" }}>{n.text}</p>
                    <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "2px 0 0", display: "flex", alignItems: "center", gap: 4 }}>
                      {n.recipients && <><Users size={11} />{n.recipients} · via {n.channel} · </>}{agoLabel(n.ts)}
                    </p>
                  </div>
                  <button onClick={() => dismissNotif(n.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, marginTop: 2 }}><X size={13} /></button>
                </div>
              ))}
            </div>
          </Dropdown>

          <button onClick={() => setShowManage(true)} className="cv-btn"><Settings size={15} /> <span className="cv-md-flex">Manage</span></button>
          {canWrite && (
            <Dropdown open={menu === "add"} onToggle={() => setMenu(menu === "add" ? null : "add")} width={176}
              trigger={<span className="cv-btn-dark"><Plus size={15} /> <span className="cv-md-flex">Add</span> <ChevronDown size={13} /></span>}>
              <button onClick={() => { setShowAdd(true); setMenu(null); }} className="cv-row-hover" style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, borderRadius: 8, padding: "8px 10px", fontSize: 13.5, background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}><Plus size={15} style={{ color: "var(--text-secondary)" }} /> New credential</button>
              <button onClick={() => { setShowImport(true); setMenu(null); }} className="cv-row-hover" style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, borderRadius: 8, padding: "8px 10px", fontSize: 13.5, background: "none", border: "none", color: "var(--text-primary)", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}><Upload size={15} style={{ color: "var(--text-secondary)" }} /> Batch import</button>
            </Dropdown>
          )}
        </div>
      </div>

      {loadError && (
        <div style={{ marginTop: 16, borderRadius: 12, border: "1px solid var(--cv-rose-line)", background: "var(--cv-rose-bg)", padding: "10px 14px", fontSize: 13, color: "var(--cv-rose)", display: "flex", alignItems: "center", gap: 8 }}>
          <AlertTriangle size={15} /> Could not load the vault. <button onClick={() => refresh().catch(() => setLoadError(true))} className="cv-btn" style={{ padding: "3px 10px" }}>Retry</button>
        </div>
      )}

      {/* ── Stat strip ── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 18 }}>
        <StatPill icon={<KeyRound size={15} />} value={stats.total} label="Credentials" />
        <StatPill icon={<HeartPulse size={15} />} value={stats.atRisk} label="At-risk" warn={stats.atRisk > 0} active={atRiskOnly}
          onClick={() => { setTab("vault"); setAtRiskOnly((v) => !v); setRiskFilter(null); }} />
      </div>

      {/* ── Tabs ── */}
      <div className="scroll-tabs" style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 4, borderBottom: "1px solid var(--border-color)", flexWrap: "wrap" }}>
        <TabBtn active={tab === "vault"} onClick={() => setTab("vault")}>Vault</TabBtn>
        {showApprovalsTab && (
          <TabBtn active={tab === "approvals"} onClick={() => setTab("approvals")}>
            Approvals {approvals.length > 0 && <span style={{ marginLeft: 2, display: "inline-flex", height: 18, minWidth: 18, alignItems: "center", justifyContent: "center", borderRadius: 999, background: "var(--cv-rose)", padding: "0 5px", fontSize: 11, fontWeight: 600, color: "#fff" }}>{approvals.length}</span>}
          </TabBtn>
        )}
        <TabBtn active={tab === "log"} onClick={() => setTab("log")}>Activity Log</TabBtn>
        <TabBtn active={tab === "trash"} onClick={() => setTab("trash")}>
          Trash {trash.length > 0 && <span style={{ marginLeft: 2, display: "inline-flex", height: 18, minWidth: 18, alignItems: "center", justifyContent: "center", borderRadius: 999, background: "var(--text-muted)", padding: "0 5px", fontSize: 11, fontWeight: 600, color: "var(--bg-card)" }}>{trash.length}</span>}
        </TabBtn>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingBottom: 4 }}>
          <div style={{ position: "relative" }}>
            <Search size={15} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search credentials…"
              style={{ borderRadius: 12, background: "var(--bg-secondary)", border: "1px solid transparent", padding: "8px 12px 8px 34px", fontSize: 13.5, outline: "none", width: 200, color: "var(--text-primary)", fontFamily: "inherit" }} />
          </div>
          {tab === "vault" && editMode && selectedIds.size > 0 && (
            <button onClick={deleteSelected} className="cv-btn" style={{ background: "var(--cv-rose-bg)", borderColor: "var(--cv-rose-line)", color: "var(--cv-rose)" }}>
              <Trash2 size={15} /> Delete ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* ══ VAULT TAB ══ */}
      {tab === "vault" && (<>
        {/* Vault mode toggle */}
        <div style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 2, borderRadius: 12, border: "1px solid var(--border-color)", background: "var(--bg-secondary)", padding: 4 }}>
          <button onClick={() => setVaultMode("company")}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 16px", borderRadius: 8, fontSize: 13.5, fontWeight: 500, border: "none", cursor: "pointer", fontFamily: "inherit", transition: "all .15s", background: vaultMode === "company" ? "var(--bg-card)" : "transparent", color: vaultMode === "company" ? "var(--text-primary)" : "var(--text-secondary)", boxShadow: vaultMode === "company" ? "var(--shadow-sm)" : "none" }}>
            <Building2 size={13} /> Company Vault
          </button>
          <button onClick={handlePersonalVaultToggle}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 16px", borderRadius: 8, fontSize: 13.5, fontWeight: 500, border: "none", cursor: "pointer", fontFamily: "inherit", transition: "all .15s", background: vaultMode === "personal" && personalVaultUnlocked ? "var(--cv-indigo)" : "transparent", color: vaultMode === "personal" && personalVaultUnlocked ? "#fff" : "var(--text-secondary)", boxShadow: vaultMode === "personal" && personalVaultUnlocked ? "var(--shadow-sm)" : "none" }}>
            <Lock size={13} /> Personal Vault
            {personalActivated && !personalVaultUnlocked && <span style={{ fontSize: 11, opacity: 0.55 }}>(locked)</span>}
          </button>
        </div>

        {vaultMode === "company" && (<>
          {/* Filter toolbar */}
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Select value={fDept} onChange={setFDept} icon={<Building2 size={13} />} options={["All", ...depts]} label="Department" />
            <Select value={fType} onChange={setFType} icon={<KeyRound size={13} />} options={["All", ...TYPES]} label="Type" />
            {activeFilters > 0 && <button onClick={() => { setFDept("All"); setFType("All"); setAtRiskOnly(false); setRiskFilter(null); }} style={{ background: "none", border: "none", fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{visibleCreds.length} shown</span>
              <div style={{ display: "flex", alignItems: "center", borderRadius: 12, border: "1px solid var(--border-color)", background: "var(--bg-card)", padding: 2 }}>
                <ViewBtn active={view === "list"} onClick={() => setView("list")} title="List"><List size={15} /></ViewBtn>
                <ViewBtn active={view === "tiles"} onClick={() => setView("tiles")} title="Tiles"><LayoutGrid size={15} /></ViewBtn>
              </div>
            </div>
          </div>

          {/* At-risk sub-filters */}
          {atRiskOnly && (
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {[
                { key: "breached", label: "Breached", count: healthSummary.breached, icon: <ShieldAlert size={15} /> },
                { key: "weak", label: "Weak", count: healthSummary.weak, icon: <AlertTriangle size={15} /> },
                { key: "reused", label: "Reused", count: healthSummary.reused, icon: <Repeat2 size={15} /> },
                { key: "expiring", label: "Expiring / overdue", count: healthSummary.expiring, icon: <CalendarClock size={15} /> },
              ].map(({ key, label, count, icon }) => (
                <button key={key} onClick={() => setRiskFilter((f) => (f === key ? null : key))}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, borderRadius: 12, padding: "8px 16px", fontSize: 13.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all .12s", background: riskFilter === key ? "var(--cv-rose-bg)" : "var(--bg-card)", border: `1px solid ${riskFilter === key ? "var(--cv-rose)" : "var(--cv-rose-line)"}`, color: "var(--cv-rose)" }}>
                  <span style={{ opacity: .7 }}>{icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 15, lineHeight: 1 }}>{count}</span>
                  <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>{label}</span>
                </button>
              ))}
            </div>
          )}

          {editMode && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, borderRadius: 12, background: "var(--cv-sky-bg)", border: "1px solid var(--cv-sky-line)", padding: "10px 16px", fontSize: 13.5, color: "var(--cv-sky)" }}>
              <Pencil size={15} style={{ flexShrink: 0 }} />
              Showing only credentials you own — others are hidden while editing.
            </div>
          )}

          {/* Temporary shared credentials */}
          {myGrants.length > 0 && (
            <div style={{ marginTop: 12, borderRadius: 16, border: "1px solid var(--cv-violet-line)", background: "var(--cv-violet-bg)", overflow: "hidden" }}>
              <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--cv-violet-line)", display: "flex", alignItems: "center", gap: 8 }}>
                <Share2 size={15} style={{ color: "var(--cv-violet)" }} />
                <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--cv-violet)" }}>Shared with Me</span>
                <span style={{ marginLeft: 4, fontSize: 11.5, color: "var(--cv-violet)", opacity: .8 }}>— temporary access, auto-expires</span>
              </div>
              <div className="cv-divide">
                {myGrants.map((g) => {
                  const ms = Math.max(0, g.expiresAt - now);
                  const h = Math.floor(ms / 3600000);
                  const m = Math.floor((ms % 3600000) / 60000);
                  const s = Math.floor((ms % 60000) / 1000);
                  const timeLeft = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
                  const secret = revealedGrants[g.id];
                  return (
                    <div key={g.id} style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ height: 36, width: 36, borderRadius: 12, background: "var(--cv-violet-bg)", border: "1px solid var(--cv-violet-line)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <KeyRound size={15} style={{ color: "var(--cv-violet)" }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{g.credName}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>Shared by <span style={{ fontWeight: 500 }}>{g.grantedBy}</span></div>
                      </div>
                      <div className="cv-mono" style={{ fontSize: 13.5, background: "var(--bg-card)", borderRadius: 12, border: "1px solid var(--cv-violet-line)", padding: "8px 12px", letterSpacing: secret ? "normal" : "0.2em", userSelect: "all", minWidth: 128, textAlign: "center" }}>
                        {secret || "••••••••"}
                      </div>
                      {!secret
                        ? <button onClick={() => revealGrant(g)} className="cv-iconbtn cv-hover-violet" title="Verify identity to reveal"><Eye size={14} style={{ color: "var(--cv-violet)" }} /></button>
                        : <button onClick={() => { try { navigator.clipboard.writeText(secret); } catch { /* blocked */ } flash("Copied to clipboard."); }} className="cv-iconbtn cv-hover-violet" title="Copy"><Copy size={14} style={{ color: "var(--cv-violet)" }} /></button>}
                      <div className="cv-mono" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--cv-violet)", background: "var(--bg-card)", border: "1px solid var(--cv-violet-line)", borderRadius: 8, padding: "6px 10px", minWidth: 72, justifyContent: "center" }}>
                        <Clock size={12} style={{ flexShrink: 0 }} />{timeLeft}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleCreds.length === 0 && <Empty>{editMode ? "You don't own any credentials yet." : "No credentials match these filters."}</Empty>}

            {/* LIST */}
            {view === "list" && visibleCreds.length > 0 && (
              <div className="cv-card" style={{ overflow: "hidden" }} data-table-container>
                <div className="cv-md-only" style={{ borderBottom: "1px solid var(--border-color)", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", color: "var(--text-muted)", gridTemplateColumns: colWidths.map((w) => `${w}fr`).join(" ") }}>
                  <div style={{ position: "relative", display: "flex", alignItems: "center", padding: "10px 16px" }}>
                    {editMode && (() => { const mc = visibleCreds.filter(canModify); const allSel = mc.length > 0 && mc.every((c) => selectedIds.has(c.id)); const someSel = mc.some((c) => selectedIds.has(c.id)); return mc.length > 0 ? <input type="checkbox" ref={(el) => { if (el) el.indeterminate = someSel && !allSel; }} checked={allSel} onChange={() => setSelectedIds(allSel ? new Set() : new Set(mc.map((c) => c.id)))} style={{ marginRight: 8, height: 15, width: 15, accentColor: "var(--text-primary)", cursor: "pointer" }} /> : null; })()}
                    <button onClick={() => setSort((s) => s.col === "name" ? { col: "name", dir: s.dir === "asc" ? "desc" : "asc" } : { col: "name", dir: "asc" })} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer" }}>Credential Name <span style={{ fontWeight: 400 }}>{sort.col === "name" ? (sort.dir === "asc" ? "↑" : "↓") : "↑↓"}</span></button>
                    <ResizeHandle colIndex={0} colWidths={colWidths} setColWidths={setColWidths} />
                  </div>
                  <div style={{ position: "relative", padding: "10px 16px", display: "flex", alignItems: "center" }}>
                    Username
                    <ResizeHandle colIndex={1} colWidths={colWidths} setColWidths={setColWidths} />
                  </div>
                  <div style={{ position: "relative", padding: "10px 16px", display: "flex", alignItems: "center" }}>
                    <button onClick={() => setSort((s) => s.col === "dept" ? { col: "dept", dir: s.dir === "asc" ? "desc" : "asc" } : { col: "dept", dir: "asc" })} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer" }}>Department <span style={{ fontWeight: 400 }}>{sort.col === "dept" ? (sort.dir === "asc" ? "↑" : "↓") : "↑↓"}</span></button>
                    <ResizeHandle colIndex={2} colWidths={colWidths} setColWidths={setColWidths} />
                  </div>
                  <div style={{ position: "relative", padding: "10px 16px", display: "flex", alignItems: "center" }}>
                    Password
                    <ResizeHandle colIndex={3} colWidths={colWidths} setColWidths={setColWidths} />
                  </div>
                  <div style={{ position: "relative", padding: "10px 16px", display: "flex", alignItems: "center" }}>
                    <button onClick={() => setSort((s) => s.col === "owner" ? { col: "owner", dir: s.dir === "asc" ? "desc" : "asc" } : { col: "owner", dir: "asc" })} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer" }}>Owner <span style={{ fontWeight: 400 }}>{sort.col === "owner" ? (sort.dir === "asc" ? "↑" : "↓") : "↑↓"}</span></button>
                  </div>
                </div>
                <div className="cv-divide">
                  {visibleCreds.map((c) => {
                    const DeptIcon = iconFor(c.dept); const st = credState(c);
                    const mod = canModify(c);
                    return (
                      <div key={c.id} id={`cred-row-${c.id}`} className={`cv-row-hover${highlightedId === c.id ? " cv-highlight" : ""}`}
                        style={{ display: "grid", alignItems: "center", padding: "12px 0", gridTemplateColumns: colWidths.map((w) => `${w}fr`).join(" "), transition: "background .5s" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, padding: "0 16px" }}>
                          {editMode && mod && <input type="checkbox" checked={selectedIds.has(c.id)} onChange={(e) => setSelectedIds((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} style={{ height: 15, width: 15, accentColor: "var(--text-primary)", flexShrink: 0, cursor: "pointer" }} />}
                          <Dot color={healthDot(c)} title={healthFlags(c).join(", ") || "Healthy"} />
                          <div style={{ height: 32, width: 32, borderRadius: 8, background: "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><DeptIcon size={15} style={{ color: "var(--text-secondary)" }} /></div>
                          <div style={{ minWidth: 0 }}>
                            <div className="cv-truncate" style={{ fontWeight: 600, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                              {c.name}
                              {c.tier !== "Standard" && <span style={{ ...tierStyle(c.tier), fontSize: 10, fontWeight: 600, borderRadius: 6, padding: "1px 6px", flexShrink: 0 }}>{c.tier}</span>}
                            </div>
                            {isStale(c) && <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11.5, color: "var(--cv-rose)", fontWeight: 500 }}><RefreshCw size={11} />Overdue · was due {rotationExpiryDate(c)}</span>}
                            {!isStale(c) && isRotationDueSoon(c) && <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11.5, color: "var(--cv-amber)", fontWeight: 500 }}><RefreshCw size={11} />Due {rotationExpiryDate(c)} ({rotationDaysLeft(c)}d left)</span>}
                            {c.url && !isStale(c) && !isRotationDueSoon(c) && <a href={c.url} target="_blank" rel="noopener noreferrer" className="cv-link" style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11.5 }}>Link<ExternalLink size={11} /></a>}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 16px", minWidth: 0 }}>
                          <span className="cv-truncate" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{c.username}</span>
                          <button onClick={() => { try { navigator.clipboard.writeText(c.username); } catch { /* blocked */ } setCopiedUser(c.id); setTimeout(() => setCopiedUser((x) => (x === c.id ? null : x)), 1500); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0, display: "flex" }} title="Copy username">
                            {copiedUser === c.id ? <Check size={12} style={{ color: "var(--cv-emerald)" }} /> : <Copy size={12} style={{ color: "var(--text-muted)" }} />}
                          </button>
                        </div>
                        <div className="cv-truncate" style={{ padding: "0 16px", fontSize: 13.5, color: "var(--text-secondary)" }}>{c.dept}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px", minWidth: 0 }}>
                          <span className="cv-mono cv-truncate" style={{ fontSize: st.isOpen ? 12 : 13.5, color: st.isOpen ? "var(--text-primary)" : "var(--text-muted)", letterSpacing: st.isOpen ? "normal" : "0.2em" }}>{st.isOpen ? st.secret : "• • • •"}</span>
                          {st.isOpen && <span style={{ fontSize: 11.5, color: "var(--cv-amber)", flexShrink: 0 }}>{st.remaining}s</span>}
                          <SecretControls c={c} state={st} onReveal={requestReveal} onCopy={copySecret} copiedId={copiedId}
                            onDelete={editMode && mod ? () => setConfirmDel(c) : null}
                            onEdit={editMode && mod ? () => setEditingCred(c) : null}
                            onRequestAccess={() => setRequestingAccessFor(c)} />
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 16px", fontSize: 13.5, color: "var(--text-secondary)", minWidth: 0 }}>
                          <User size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                          <span className="cv-truncate">{c.owner ? nameOf(c.owner) : "—"}</span>
                          {c.owner && (
                            <a href={`https://teams.microsoft.com/l/chat/0/0?users=${c.owner}`} target="_blank" rel="noopener noreferrer" title={`Chat with ${nameOf(c.owner)} on Teams`} style={{ flexShrink: 0, marginLeft: 2, display: "flex" }}>
                              <TeamsIcon size={19} />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TILES */}
            {view === "tiles" && visibleCreds.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                {visibleCreds.map((c) => {
                  const DeptIcon = iconFor(c.dept); const st = credState(c);
                  const mod = canModify(c);
                  return (
                    <div key={c.id} className="cv-card" style={{ padding: 16, display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        {editMode && mod && <input type="checkbox" checked={selectedIds.has(c.id)} onChange={(e) => setSelectedIds((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} style={{ height: 15, width: 15, marginTop: 4, accentColor: "var(--text-primary)", flexShrink: 0, cursor: "pointer" }} />}
                        <div style={{ height: 36, width: 36, borderRadius: 8, background: "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><DeptIcon size={15} style={{ color: "var(--text-secondary)" }} /></div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="cv-truncate" style={{ fontWeight: 600, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}><Dot color={healthDot(c)} title={healthFlags(c).join(", ") || "Healthy"} />{c.name}</div>
                          <div className="cv-truncate" style={{ fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                            {c.dept} · {c.owner ? nameOf(c.owner) : "—"}
                            {c.owner && <a href={`https://teams.microsoft.com/l/chat/0/0?users=${c.owner}`} target="_blank" rel="noopener noreferrer" title={`Chat with ${nameOf(c.owner)} on Teams`} style={{ display: "flex" }}><TeamsIcon size={15} /></a>}
                          </div>
                          {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" className="cv-link" style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11.5, marginTop: 2 }}>Link<ExternalLink size={11} /></a>}
                        </div>
                      </div>
                      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="cv-mono cv-truncate" style={{ fontSize: 12, color: "var(--text-secondary)", borderRadius: 6, background: "var(--bg-secondary)", border: "1px solid var(--border-color)", padding: "4px 8px", flex: 1 }}>{st.isOpen ? st.secret : "••••••••"}</span>
                        {st.isOpen && <span style={{ fontSize: 11.5, color: "var(--cv-amber)", flexShrink: 0 }}>{st.remaining}s</span>}
                        <SecretControls c={c} state={st} onReveal={requestReveal} onCopy={copySecret} copiedId={copiedId}
                          onDelete={editMode && mod ? () => setConfirmDel(c) : null}
                          onEdit={editMode && mod ? () => setEditingCred(c) : null}
                          onRequestAccess={() => setRequestingAccessFor(c)} />
                      </div>
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Users size={11} />{c.sharedWith}</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: isStale(c) ? "var(--cv-rose)" : isRotationDueSoon(c) ? "var(--cv-amber)" : "inherit", fontWeight: isStale(c) || isRotationDueSoon(c) ? 500 : 400 }}>
                          <RefreshCw size={11} />{isStale(c) ? `Overdue · ${rotationExpiryDate(c)}` : isRotationDueSoon(c) ? `Due ${rotationExpiryDate(c)}` : c.rotatedDays === 0 ? "Today" : `${c.rotatedDays}d`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>)}

        {/* ── Personal vault ── */}
        {vaultMode === "personal" && personalVaultUnlocked && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ height: 28, width: 28, borderRadius: 8, background: "var(--cv-indigo)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Lock size={13} style={{ color: "#fff" }} /></div>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>Personal Vault</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 999, background: "var(--cv-blue-bg)", border: "1px solid var(--cv-blue-line)", padding: "2px 10px", fontSize: 11.5, color: "var(--cv-blue)", fontWeight: 500, flexShrink: 0 }}>
                  <MsLogo size={12} />
                  {myEmail}
                </span>
                {(() => { const remaining = personalLastActivityRef.current ? Math.max(0, 2 * 60 * 1000 - (now - personalLastActivityRef.current)) : 0; return remaining < 30000 && remaining > 0 ? <span className="cv-pulse" style={{ fontSize: 11.5, fontWeight: 500, color: "var(--cv-amber)" }}>Auto-locking in {Math.ceil(remaining / 1000)}s</span> : remaining > 0 ? <span style={{ fontSize: 11.5, color: "var(--text-muted)", opacity: .6 }}>Locks in {Math.floor(remaining / 60000)}:{String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}</span> : null; })()}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => setShowPersonalAdd(true)} className="cv-btn-dark cv-btn-indigo"><Plus size={15} /> Add</button>
                <button onClick={lockPersonalVault} className="cv-btn"><Lock size={15} /> Lock vault</button>
              </div>
            </div>

            {personalCreds.length === 0 && (
              <div style={{ borderRadius: 16, border: "1px dashed var(--cv-indigo-line)", background: "var(--cv-indigo-bg)", padding: 40, textAlign: "center" }}>
                <div style={{ height: 48, width: 48, borderRadius: 16, background: "var(--cv-indigo-bg)", border: "1px solid var(--cv-indigo-line)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}><Lock size={22} style={{ color: "var(--cv-indigo)" }} /></div>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>No Personal Credentials Yet</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Add passwords that are completely private — not visible to admins or your team.</div>
                <button onClick={() => setShowPersonalAdd(true)} className="cv-btn-dark cv-btn-indigo" style={{ marginTop: 16 }}><Plus size={15} /> Add Credential</button>
              </div>
            )}

            {personalCreds.length > 0 && (
              <div className="cv-card" style={{ overflow: "hidden", borderColor: "var(--cv-indigo-line)" }}>
                <div className="cv-md-only" style={{ gridTemplateColumns: "4fr 3fr 2fr 2fr 1fr", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border-color)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--text-muted)", background: "var(--cv-indigo-bg)" }}>
                  <div>Name</div><div style={{ textAlign: "center" }}>Username</div><div style={{ textAlign: "center" }}>Type</div><div style={{ textAlign: "center" }}>Password</div><div />
                </div>
                <div className="cv-divide">
                  {personalCreds.map((c) => {
                    const r = personalRevealed[c.id];
                    const isOpen = r && r.until > now;
                    const remaining = isOpen ? Math.ceil((r.until - now) / 1000) : 0;
                    return (
                      <div key={c.id} className="cv-row-hover" style={{ display: "grid", gridTemplateColumns: "4fr 3fr 2fr 2fr 1fr", gap: 12, padding: "12px 16px", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          <div style={{ height: 28, width: 28, borderRadius: 8, background: "var(--cv-indigo-bg)", border: "1px solid var(--cv-indigo-line)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><KeyRound size={13} style={{ color: "var(--cv-indigo)" }} /></div>
                          <div style={{ minWidth: 0 }}>
                            <div className="cv-truncate" style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
                            {c.note && <div className="cv-truncate" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.note}</div>}
                          </div>
                        </div>
                        <div className="cv-md-flex" style={{ justifyContent: "center", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span className="cv-truncate" style={{ fontSize: 12, color: "var(--text-secondary)" }}>{c.username}</span>
                          <button onClick={() => { try { navigator.clipboard.writeText(c.username); } catch { /* blocked */ } }} title="Copy username" style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}><Copy size={12} style={{ color: "var(--text-muted)" }} /></button>
                        </div>
                        <div className="cv-md-flex" style={{ justifyContent: "center" }}>
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)", background: "var(--bg-secondary)", borderRadius: 6, padding: "2px 8px" }}>{c.type}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                          <span className="cv-mono" style={{ fontSize: isOpen ? 12 : 13.5, color: isOpen ? "var(--text-primary)" : "var(--text-muted)", letterSpacing: isOpen ? "normal" : "0.2em" }}>{isOpen ? r.secret : "• • • •"}</span>
                          {isOpen && <span style={{ fontSize: 11.5, color: "var(--cv-amber)", flexShrink: 0 }}>{remaining}s</span>}
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            {!isOpen && <button onClick={() => revealPersonal(c)} title="Reveal" className="cv-iconbtn"><Eye size={14} /></button>}
                            {isOpen && <button onClick={() => copyPersonalSecret(c)} title="Copy" className="cv-iconbtn">{personalCopiedId === c.id ? <Check size={14} style={{ color: "var(--cv-emerald)" }} /> : <Copy size={14} />}</button>}
                          </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button onClick={() => deletePersonalCredential(c.id)} title="Delete permanently" className="cv-iconbtn cv-hover-rose"><Trash2 size={14} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <ShieldCheck size={13} style={{ color: "var(--cv-indigo)" }} />
              Bound to <span style={{ color: "var(--cv-indigo)", fontWeight: 500 }}>{myEmail}</span> via Microsoft Entra ID · Encrypted at rest · Not accessible to any other account, admin, or team member
            </div>
          </div>
        )}
      </>)}

      {/* ══ ACTIVITY LOG TAB ══ */}
      {tab === "log" && (
        <div className="cv-card" style={{ marginTop: 16, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <History size={15} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>Activity Log</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
                <span>From</span>
                <input type="date" value={logFrom} onChange={(e) => setLogFrom(e.target.value)} className="cv-ipt" style={{ width: "auto", padding: "4px 8px", fontSize: 11.5, borderRadius: 8 }} />
                <span>To</span>
                <input type="date" value={logTo} onChange={(e) => setLogTo(e.target.value)} className="cv-ipt" style={{ width: "auto", padding: "4px 8px", fontSize: 11.5, borderRadius: 8 }} />
                {(logFrom || logTo) && <button onClick={() => { setLogFrom(""); setLogTo(""); }} style={{ background: "none", border: "none", color: "var(--text-muted)", textDecoration: "underline", cursor: "pointer", fontSize: 11.5, fontFamily: "inherit" }}>Clear</button>}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{visibleLog.length} events · retained {SETTINGS.logRetentionDays}d</span>
            </div>
          </div>
          {visibleLog.length === 0 && <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>No activity yet.</div>}
          <div className="cv-divide">
            {visibleLog.map((e) => {
              const linked = credentials.find((c) => c.id === e.credId) || credentials.find((c) => c.name === e.cred);
              return (
                <div key={e.id} onClick={() => linked && goToCredential(e.credId, e.cred)}
                  className={`cv-group${linked ? " cv-row-amber" : ""}`}
                  style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: linked ? "pointer" : "default" }}>
                  <div style={{ height: 32, width: 32, borderRadius: "50%", background: "var(--bg-secondary)", color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{(e.actor || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5 }}>
                      <span style={{ fontWeight: 500 }}>{e.actor}</span>{" "}
                      <span style={{ ...actionStyle(e.action), borderRadius: 6, padding: "2px 6px", fontSize: 11.5, fontWeight: 500 }}>{e.action}</span>{" "}
                      <span style={{ color: "var(--text-secondary)", textDecoration: linked ? "underline dotted" : "none", textUnderlineOffset: 2 }}>{e.cred}</span>
                    </div>
                    {Array.isArray(e.detail) && e.detail.length > 0 && (
                      <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 2 }}>
                        {e.detail.map((d) => (
                          <span key={d.field} style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                            <span style={{ fontWeight: 500 }}>{d.field}:</span>{" "}
                            <span style={{ textDecoration: "line-through", color: "var(--text-muted)" }}>{d.from}</span>
                            {" → "}
                            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{d.to}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                      <span>{e.dept}</span>
                      {e.loc && <><span style={{ opacity: .5 }}>·</span><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><MapPin size={11} />{e.loc}</span></>}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    {linked && <span className="cv-group-hover" style={{ fontSize: 11.5, color: "var(--cv-amber)", fontWeight: 500 }}>View →</span>}
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{agoLabel(e.ts)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ APPROVALS TAB ══ */}
      {tab === "approvals" && showApprovalsTab && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {approvals.length === 0 && <Empty>No pending access requests.</Empty>}
          {approvals.map((a) => (
            <div key={a.id} className="cv-card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div style={{ height: 44, width: 44, borderRadius: 12, background: "var(--cv-violet-bg)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Share2 size={19} style={{ color: "var(--cv-violet)" }} /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{a.cred}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{a.requestedBy} wants {a.sharedToEmail === a.requestedByEmail ? "access" : "to share"} · {a.dept} · {a.duration} · {agoLabel(a.ts)}</div>
                {a.sharedToEmail && a.sharedToEmail !== a.requestedByEmail && <div style={{ fontSize: 11.5, color: "var(--cv-violet)", marginTop: 2, fontWeight: 500 }}>→ {a.sharedToEmail}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => decideRequest(a, "deny")} className="cv-btn cv-btn-danger"><XCircle size={15} /> Deny</button>
                <button onClick={() => decideRequest(a, "approve")} className="cv-btn-dark cv-btn-violet"><CheckCircle2 size={15} /> Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══ TRASH TAB ══ */}
      {tab === "trash" && (
        <div className="cv-card" style={{ marginTop: 16, overflow: "hidden" }}>
          <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 8 }}>
            <Trash2 size={15} style={{ color: "var(--text-secondary)" }} />
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>Trash</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>{trash.length} item{trash.length !== 1 ? "s" : ""}</span>
          </div>
          {trash.length === 0 && <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>Trash is empty.</div>}
          <div className="cv-divide">
            {trash.map((c) => {
              const DeptIcon = iconFor(c.dept);
              const daysElapsed = c.deletedAt ? Math.floor((Date.now() - c.deletedAt) / 86400000) : 0;
              const mod = canModify(c) || isAdmin;
              return (
                <div key={c.id} style={{ padding: "12px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ height: 32, width: 32, borderRadius: 8, background: "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, opacity: .5 }}><DeptIcon size={15} style={{ color: "var(--text-secondary)" }} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13.5, color: "var(--text-secondary)", textDecoration: "line-through" }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.dept} · {c.username}</div>
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)", flexShrink: 0 }}>Deleted {daysElapsed === 0 ? "today" : `${daysElapsed}d ago`}</span>
                  <button onClick={async () => { try { await api.cvRestore(c.id); await refresh(); flash(`${c.name} recovered from trash.`); } catch (err) { flash(err.message || "Recover failed.", "info"); } }}
                    className="cv-btn" style={{ background: "var(--cv-emerald-bg)", borderColor: "var(--cv-emerald-line)", color: "var(--cv-emerald)", flexShrink: 0 }}>
                    <RefreshCw size={13} /> Recover
                  </button>
                  {mod && (
                    <button onClick={async () => { try { await api.cvPurge(c.id); await refresh(); flash(`${c.name} permanently deleted.`, "info"); } catch (err) { flash(err.message || "Delete failed.", "info"); } }}
                      className="cv-btn cv-btn-danger" style={{ flexShrink: 0 }}>
                      <X size={13} /> Delete permanently
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {/* Secret reveals + personal-vault unlock now use real Entra step-up MFA
          (ensureStepUp) at the action point — the old client-side re-auth modals
          were removed as they enforced nothing server-side. */}
      {confirmDel && <ConfirmModal cred={confirmDel} onClose={() => setConfirmDel(null)} onConfirm={() => deleteCredential(confirmDel)} />}
      {showAdd && <AddModal onClose={() => setShowAdd(false)} onSave={addCredential} depts={depts} userName={nameOf(myEmail)} userEmail={myEmail} people={people} />}
      {editingCred && <EditModal cred={editingCred} onClose={() => setEditingCred(null)} onSave={updateCredential} depts={depts} ownerName={nameOf(editingCred.owner || myEmail)} people={people} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onImport={importCredentials} depts={depts} />}
      {showManage && <ManagePanel onClose={() => setShowManage(false)} isAdmin={isAdmin} editMode={editMode} onToggleEdit={() => { setEditMode((v) => !v); setSelectedIds(new Set()); }} />}
      {showPersonalAdd && <PersonalAddModal onClose={() => setShowPersonalAdd(false)} onSave={addPersonalCredential} />}
      {requestingAccessFor && <RequestAccessModal cred={requestingAccessFor} userEmail={myEmail} ownerName={nameOf(requestingAccessFor.owner)} onClose={() => setRequestingAccessFor(null)} onSubmit={requestAccess} />}
      {approvingRequest && <ApproveAccessModal request={approvingRequest} onClose={() => setApprovingRequest(null)} onConfirm={confirmGrant} onDeny={(a) => { decideRequest(a, "deny"); setApprovingRequest(null); }} maskedPhone={maskedPhone} />}

      {toast && (
        <div className={`cv-toast${toast.kind === "info" ? " cv-toast-info" : ""}`}>
          <ShieldCheck size={15} /> {toast.msg}
        </div>
      )}
    </div>
  );
}
