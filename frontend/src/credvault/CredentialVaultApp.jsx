/* Credential Vault - the module screen (Oct 14 2026 rebuild).

   One list with a left rail of collections (All, Owned by Me, Shared With Me,
   Favorites, Needs Attention, each department, Trash) and a right-side drawer
   for the selected credential. The API says per row what the caller may do
   (access / canReveal / canEdit - department scope, Neil Oct 14 2026); this
   screen only renders that. Company secrets arrive through explicit reveal
   calls behind the SMS/Email code gate (VaultOtpModal), one code per window
   ("Verified until <time>" in the header), and are held in memory for the
   open drawer only. Tabs: Vault, Personal, Approvals, Activity. Deep links
   arrive as `activeSub` (vaultModel.parseSub) from the bell and the header
   search. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Shield, ShieldCheck, Search, Plus, Upload, Star, Trash2, Users, Share2, Heart, Building2, Layers, KeyRound,
  CheckCircle2, XCircle, ArrowUpDown, History,
} from "lucide-react";
import { api } from "../api";
import { dialog } from "../ui/dialog";
import { SkeletonBlocks } from "../components/AsyncState";
import ModuleTabs from "../components/ModuleTabs";
import { useRole } from "../contexts/RoleContext";
import { useNameResolver } from "../lib/useNameResolver";
import { formatDateTime } from "../lib/datetime";
import { usePeople } from "../tasks/components";
import { VaultOtpModal, DEFAULT_DEPTS, TYPES, TIERS, iconFor, agoLabel, actionStyle } from "./vaultShared";
import {
  ACCESS_LABEL, ACCESS_TONE, collectionsFor, filterCredentials, sortCredentials, healthFlags, healthTone,
  parseSub, verifiedLabel, readFavorites, writeFavorites, logMatches, live,
} from "./vaultModel";
import CredentialDrawer from "./CredentialDrawer";
import { CredentialForm, ImportModal, ShareModal, RequestModal } from "./CredentialForm";
import PersonalVault from "./PersonalVault";
import "./credvault.css";

const RAIL_ICON = { all: Layers, mine: KeyRound, shared: Share2, favorites: Heart, attention: ShieldCheck, trash: Trash2 };
const LOG_ACTIONS = ["All", "Revealed", "Copied", "Created", "Edited", "Shared", "Requested", "Denied", "Revoked", "Transferred", "Removed", "Recovered", "Imported", "Offboarded"];

export default function CredentialVaultApp({ activeSub, onSubChange: _onSubChange }) {
  const { myEmail, can, canAccessModule } = useRole();
  const isAdmin = can("administrator");
  const canWrite = canAccessModule("credvault", "administrator", "editor");
  const nameOf = useNameResolver();
  const people = usePeople();

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
  const [fType, setFType] = useState("All");
  const [fTier, setFTier] = useState("All");
  const [sort, setSort] = useState({ col: "name", dir: "asc" });
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [favorites, setFavorites] = useState(readFavorites);
  const [revealed, setRevealed] = useState(null);          // { id, secret, previousSecret?, prevRotatedAt? }
  const [form, setForm] = useState(null);                  // { cred | null }
  const [importOpen, setImportOpen] = useState(false);
  const [shareFor, setShareFor] = useState(null);
  const [requestFor, setRequestFor] = useState(null);
  const [otpGate, setOtpGate] = useState(null);            // { run }
  const [toast, setToast] = useState(null);
  const [logFilter, setLogFilter] = useState({ query: "", action: "All", from: "", to: "" });
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef(null);

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
    if (credId) { setCollection("all"); setSelectedId(credId); }
  }, []);
  useEffect(() => { applySub(activeSub); }, [activeSub, applySub]);
  useEffect(() => {
    const h = (e) => { if (e.detail?.view === "credvault") applySub(e.detail.sub); };
    window.addEventListener("nexus:navigate", h);
    return () => window.removeEventListener("nexus:navigate", h);
  }, [applySub]);
  // Tabs are local: pushing them through onSubChange made every switch a
  // history entry whose breadcrumb read "Credential Vault / Credential Vault".
  // Deep links still arrive through activeSub; onSubChange stays accepted for
  // App's sake and is left alone.
  function changeTab(key) { setTab(key); }

  // ── derived ─────────────────────────────────────────────────────────────
  const ctx = useMemo(() => ({ favorites, myEmail }), [favorites, myEmail]);
  const collections = useMemo(() => collectionsFor(creds, ctx), [creds, ctx]);
  const rows = useMemo(() => sortCredentials(filterCredentials(creds, { collection, query, type: fType, tier: fTier, ...ctx }), sort), [creds, collection, query, fType, fTier, ctx, sort]);
  const selected = useMemo(() => creds.find((c) => c.id === selectedId) || null, [creds, selectedId]);
  const depts = useMemo(() => {
    const set = new Set(hrDepts.length ? hrDepts : DEFAULT_DEPTS);
    live(creds).forEach((c) => c.dept && set.add(c.dept));
    return [...set];
  }, [creds, hrDepts]);
  const verified = otp.verified && otp.until > now;
  const attention = collections.find((c) => c.key === "attention")?.count || 0;
  const checkedEditable = rows.filter((c) => checked.has(c.id) && c.canEdit && !c.deletedAt);
  const visibleLog = useMemo(() => logs.filter((e) => logMatches(e, logFilter)), [logs, logFilter]);

  // Closing the drawer drops the revealed secret with it.
  function closeDrawer() { setSelectedId(null); setRevealed(null); }

  // ── the code gate ───────────────────────────────────────────────────────
  // One verified code opens a window (Settings > Security); inside it every
  // reveal / share / approve runs straight away. The window is checked at
  // click time (not against the 30 s clock), and an action the API still
  // refuses with vault_otp_required - the window lapsed between the chip and
  // the click - re-opens the gate with the same action instead of a toast.
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
    try { await api.cvDelete(c.id); closeDrawer(); await refresh(); flash(`${c.name} moved to the trash.`); } catch (e) { flash(e?.message || "Could not remove.", "info"); }
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
    try { await api.cvPurge(c.id); closeDrawer(); await refresh(); flash(`${c.name} deleted permanently.`, "info"); } catch (e) { flash(e?.message || "Could not delete.", "info"); }
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
  function sortBy(col) { setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" })); }

  if (loading) return <div style={{ padding: "16px 0" }}><SkeletonBlocks count={6} height={52} /></div>;

  const tabs = [
    { key: "vault", label: "Vault" },
    { key: "personal", label: "Personal" },
    ...((isAdmin || requests.length || creds.some((c) => c.canEdit)) ? [{ key: "approvals", label: "Approvals", badge: requests.length || null }] : []),
    { key: "activity", label: "Activity" },
  ];
  const editableInView = rows.filter((c) => c.canEdit && !c.deletedAt);
  const allChecked = editableInView.length > 0 && editableInView.every((c) => checked.has(c.id));

  return (
    <div className="cv-root">
      <header className="cv-head">
        <div className="cv-head-title">
          <div className="dk-chip" style={{ width: 34, height: 34, borderRadius: 10, background: "var(--text-primary)", color: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}><Shield size={16} /></div>
          <div>
            <h2>Credential Vault</h2>
            <p>{live(creds).length} shared credential{live(creds).length === 1 ? "" : "s"}{attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}</p>
          </div>
        </div>
        <div className="cv-head-actions">
          {verified
            ? <span className="cv-chip tone-ok" title="Reveals and approvals inside this window do not ask for another code"><ShieldCheck size={12} /> {verifiedLabel(otp.until, now)}</span>
            : <span className="cv-chip tone-muted" title="The first reveal asks for a code by text or email"><Shield size={12} /> Code on First Reveal</span>}
          <label className="cv-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search credentials…" aria-label="Search credentials" />
          </label>
          {canWrite && <button type="button" className="cv-btn" onClick={() => setImportOpen(true)}><Upload size={14} /> Import</button>}
          {canWrite && <button type="button" className="cv-btn-dark" onClick={() => setForm({ cred: null })}><Plus size={14} /> Add</button>}
        </div>
      </header>

      {loadError && (
        <div className="cv-callout tone-warn"><span>Could not load the vault.</span><button type="button" className="cv-btn" style={{ marginLeft: "auto", padding: "3px 10px" }} onClick={() => refresh().catch(() => setLoadError(true))}>Retry</button></div>
      )}

      <ModuleTabs tabs={tabs} active={tab} onChange={changeTab} />

      {tab === "vault" && (
        <div className="cv-layout">
          <nav className="cv-rail" aria-label="Collections">
            {collections.filter((c) => !c.dept).map((c) => c.key === "trash" ? null : <RailItem key={c.key} c={c} active={collection === c.key} onClick={() => setCollection(c.key)} />)}
            {collections.some((c) => c.dept) && <div className="cv-rail-caption">Departments</div>}
            {collections.filter((c) => c.dept).map((c) => <RailItem key={c.key} c={c} active={collection === c.key} onClick={() => setCollection(c.key)} />)}
            <div className="cv-rail-caption" />
            {collections.filter((c) => c.key === "trash").map((c) => <RailItem key={c.key} c={c} active={collection === c.key} onClick={() => setCollection(c.key)} />)}
          </nav>
          <div className="cv-rail-phone scroll-tabs" role="tablist" aria-label="Collections">
            {collections.map((c) => (
              <button key={c.key} type="button" role="tab" aria-selected={collection === c.key} className={`cv-chip is-button${collection === c.key ? " is-active" : ""}`} onClick={() => setCollection(c.key)}>{c.label} {c.count ? <span className="cv-rail-count">{c.count}</span> : null}</button>
            ))}
          </div>

          <section className="cv-main">
            <div className="cv-toolbar">
              <select className="cv-select" value={fType} onChange={(e) => setFType(e.target.value)} aria-label="Type"><option value="All">All Types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <select className="cv-select" value={fTier} onChange={(e) => setFTier(e.target.value)} aria-label="Tier"><option value="All">All Tiers</option>{TIERS.map((t) => <option key={t}>{t}</option>)}</select>
              <select className="cv-select" value={sort.col} onChange={(e) => setSort({ col: e.target.value, dir: "asc" })} aria-label="Sort by">
                <option value="name">Sort: Name</option><option value="dept">Sort: Department</option><option value="owner">Sort: Owner</option><option value="rotated">Sort: Oldest Rotation</option><option value="health">Sort: Needs Attention</option>
              </select>
              <span className="cv-count">{rows.length} shown</span>
            </div>
            {checkedEditable.length > 0 && (
              <div className="cv-bulk">
                <span>{checkedEditable.length} selected</span>
                <button type="button" className="cv-btn cv-btn-danger" onClick={trashChecked}><Trash2 size={13} /> Move to Trash</button>
                <button type="button" className="cv-btn" onClick={() => setChecked(new Set())}>Clear</button>
              </div>
            )}

            <div className="cv-list">
              {rows.length > 0 && (
                <div className="cv-list-head">
                  <div className="cv-check-slot">{editableInView.length > 0 && collection !== "trash" && (
                    <input type="checkbox" className="cv-check" aria-label="Select all you can edit" checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = !allChecked && editableInView.some((c) => checked.has(c.id)); }}
                      onChange={() => setChecked(allChecked ? new Set() : new Set(editableInView.map((c) => c.id)))} />)}
                  </div>
                  <div />
                  <button type="button" onClick={() => sortBy("name")}>Credential <ArrowUpDown size={11} /></button>
                  <button type="button" onClick={() => sortBy("owner")}>Owner <ArrowUpDown size={11} /></button>
                  <span>Access</span>
                  <span />
                </div>
              )}
              {rows.length === 0 && (
                <div className="cv-empty">
                  <strong>{collection === "trash" ? "The trash is empty" : query ? "No credentials match" : collection === "shared" ? "Nothing shared with you right now" : collection === "favorites" ? "No favorites yet" : collection === "attention" ? "All clear" : "No credentials here yet"}</strong>
                  {collection === "favorites" ? "Star a credential to keep it at hand." : collection === "attention" ? "Nothing you can open is weak, reused, overdue or expiring." : query ? "Try another name, username, link or owner." : canWrite && collection !== "trash" ? "Add one, or import a CSV." : ""}
                </div>
              )}
              {rows.map((c) => {
                const tone = c.canReveal ? healthTone(c) : "muted";
                const flag = c.canReveal ? healthFlags(c)[0] : null;
                const Icon = iconFor(c.dept);
                return (
                  <div key={c.id} id={`cred-row-${c.id}`} className={`cv-row${selectedId === c.id ? " is-selected" : ""}`} role="button" tabIndex={0}
                    onClick={() => setSelectedId(c.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(c.id); } }}>
                    <div className="cv-check-slot" onClick={(e) => e.stopPropagation()}>
                      {c.canEdit && !c.deletedAt && <input type="checkbox" className="cv-check" aria-label={`Select ${c.name}`} checked={checked.has(c.id)} onChange={() => toggleChecked(c.id)} />}
                    </div>
                    <span className={`cv-dot tone-${tone}`} title={c.canReveal ? (healthFlags(c).map((f) => f.label).join(", ") || "Healthy") : "Request access to see its health"} />
                    <div className="cv-row-main">
                      <div className="cv-name">
                        <span>{c.name}</span>
                        {c.tier !== "Standard" && <span className={`cv-chip ${c.tier === "Critical" ? "tone-bad" : "tone-warn"}`}>{c.tier}</span>}
                      </div>
                      <div className="cv-sub">
                        <Icon size={11} style={{ verticalAlign: -1, marginRight: 4, opacity: .7 }} />{c.dept || "No department"}
                        {c.canReveal && c.username && c.username !== "-" ? ` · ${c.username}` : ""}
                        {flag ? <> · <span className={`tone-${flag.tone}`}>{flag.label}</span></> : null}
                      </div>
                    </div>
                    <div className="cv-row-owner" title={c.owner}>{c.owner ? nameOf(c.owner) : "-"}</div>
                    <span className={`cv-chip tone-${ACCESS_TONE[c.access] || "muted"}`}>{c.deletedAt ? "In Trash" : ACCESS_LABEL[c.access]}</span>
                    <button type="button" className={`cv-star${favorites.has(c.id) ? " is-on" : ""}`} aria-label={favorites.has(c.id) ? `Remove ${c.name} from Favorites` : `Add ${c.name} to Favorites`} aria-pressed={favorites.has(c.id)}
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(c.id); }}><Star size={15} fill={favorites.has(c.id) ? "currentColor" : "none"} /></button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* Mounted once the tab is first opened and kept mounted after, hidden
          behind the other tabs: its unlock window must survive a trip to
          Vault and back (one unlock per window, Neil Oct 14 2026). */}
      {personalSeen.current && <div hidden={tab !== "personal"}><PersonalVault myEmail={myEmail} flash={flash} /></div>}

      {tab === "approvals" && (
        <div className="cv-cards">
          {requests.length === 0 && <div className="cv-list cv-empty"><strong>No requests waiting</strong>When someone asks for a credential you own, it shows up here.</div>}
          {requests.map((r) => (
            <div key={r.id} className="cv-card">
              <div style={{ width: 40, height: 40, borderRadius: 12, background: "var(--cv-info-bg)", color: "var(--cv-info)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Users size={18} /></div>
              <div className="cv-card-main">
                <b>{r.cred}</b>
                <p>{r.requestedBy} asks for {r.duration.toLowerCase()} of access · {r.dept} · {agoLabel(r.ts)}{r.sharedToEmail && r.sharedToEmail !== r.requestedByEmail ? ` · for ${nameOf(r.sharedToEmail)}` : ""}</p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="cv-btn cv-btn-danger" onClick={() => deny(r)}><XCircle size={14} /> Decline</button>
                <button type="button" className="cv-btn-dark" onClick={() => approve(r)}><CheckCircle2 size={14} /> Approve</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "activity" && (
        <div className="cv-list">
          <div className="cv-toolbar" style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
            <History size={15} style={{ color: "var(--text-secondary)" }} />
            <input className="cv-ipt" style={{ width: 200, padding: "6px 10px", fontSize: 12.5 }} placeholder="Search activity…" aria-label="Search activity" value={logFilter.query} onChange={(e) => setLogFilter((f) => ({ ...f, query: e.target.value }))} />
            <select className="cv-select" value={logFilter.action} onChange={(e) => setLogFilter((f) => ({ ...f, action: e.target.value }))} aria-label="Action">{LOG_ACTIONS.map((a) => <option key={a} value={a}>{a === "All" ? "All Actions" : a}</option>)}</select>
            <input type="date" className="cv-select" aria-label="From" value={logFilter.from} onChange={(e) => setLogFilter((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" className="cv-select" aria-label="To" value={logFilter.to} onChange={(e) => setLogFilter((f) => ({ ...f, to: e.target.value }))} />
            <span className="cv-count">{visibleLog.length} event{visibleLog.length === 1 ? "" : "s"}</span>
          </div>
          {visibleLog.length === 0 && <div className="cv-empty">No activity matches.</div>}
          <div className="cv-divide">
            {visibleLog.map((e) => {
              const linked = e.credId && creds.some((c) => c.id === e.credId);
              return (
                <div key={e.id} className={`cv-log-row cv-row-hover${linked ? " is-link" : ""}`} onClick={() => linked && setSelectedId(e.credId)}
                  role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} onKeyDown={(e2) => { if (linked && (e2.key === "Enter" || e2.key === " ")) { e2.preventDefault(); setSelectedId(e.credId); } }}>
                  <span className="cv-avatar">{(e.actor || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div><b style={{ fontWeight: 500 }}>{e.actor}</b> <span style={{ ...actionStyle(e.action), borderRadius: 6, padding: "1px 6px", fontSize: 11.5, fontWeight: 500 }}>{e.action}</span> <span style={{ color: "var(--text-secondary)" }}>{e.cred}</span></div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                      {e.dept !== "-" ? e.dept : ""}
                      {Array.isArray(e.detail) && e.detail.length > 0 && <span className="cv-diff" style={{ paddingLeft: e.dept !== "-" ? 8 : 0 }}>{e.detail.map((d, i) => <span key={i} style={{ marginRight: 10 }}>{d.field}: {d.from ? <><s>{d.from}</s> → </> : null}{d.to}</span>)}</span>}
                    </div>
                  </div>
                  <time title={formatDateTime(e.ts)}>{agoLabel(e.ts)}</time>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected && (
        <CredentialDrawer key={selected.id} cred={selected} logs={logs} myEmail={myEmail} nameOf={nameOf}
          favorite={favorites.has(selected.id)} onToggleFavorite={() => toggleFavorite(selected.id)}
          revealed={revealed?.id === selected.id ? revealed : null}
          onReveal={() => gated(() => reveal(selected))} onHide={() => setRevealed(null)} onCopiedSecret={() => copiedSecret(selected)}
          onEdit={() => setForm({ cred: selected })} onTrash={() => trash(selected)} onRestore={() => restore(selected)} onPurge={() => purge(selected)}
          onShare={() => setShareFor(selected)} onRequest={() => setRequestFor(selected)} onChanged={() => refresh().catch(() => {})}
          onClose={closeDrawer} />
      )}

      {form && <CredentialForm cred={form.cred} depts={depts} people={people} myEmail={myEmail} onClose={() => setForm(null)} onSave={saveCredential} />}
      {importOpen && <ImportModal depts={depts} onClose={() => setImportOpen(false)} onImport={importRows} />}
      {shareFor && <ShareModal cred={shareFor} people={people.filter((p) => p.email !== myEmail)} nameOf={nameOf} onClose={() => setShareFor(null)} onSubmit={(email, ms, label) => share(shareFor, email, ms, label)} />}
      {requestFor && <RequestModal cred={requestFor} nameOf={nameOf} onClose={() => setRequestFor(null)} onSubmit={(ms, label) => request(requestFor, ms, label)} />}
      {otpGate && <VaultOtpModal onClose={() => setOtpGate(null)} onVerified={afterOtp} />}

      {toast && <div className={`cv-toast${toast.kind === "info" ? " cv-toast-info" : ""}`} role="status"><ShieldCheck size={15} /> {toast.msg}</div>}
    </div>
  );
}

function RailItem({ c, active, onClick }) {
  const Icon = c.dept ? Building2 : (RAIL_ICON[c.key] || Layers);
  return (
    <button type="button" className={`cv-rail-item${active ? " is-active" : ""}`} onClick={onClick} aria-current={active ? "true" : undefined}>
      <Icon size={14} />
      <span className="cv-rail-label">{c.label}</span>
      {c.count ? <span className="cv-rail-count">{c.count}</span> : null}
    </button>
  );
}
