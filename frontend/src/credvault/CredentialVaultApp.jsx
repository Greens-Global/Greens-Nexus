/* Passwords - the screen (Neil, 11/18/2026; plan
   https://claude.ai/artifact/3vdxK7zcuFPeiKkVvKc1xu). The module that was
   Credentials (five tabs of its own in the left menu's Work group) is a
   Dashboard tab beside Notes and Links, and ONE list: a search box, one
   sentence, one row per login (LoginList). What the five tabs held:

     My Logins  - the page itself.
     Personal   - a folded, locked section of the same list (PersonalVault).
     Overview   - its tiles are the sentence above the list and its
                  collections the sentence's phrases; the department table,
                  the bars and Rotates Next are in "..." > Export for an Audit.
     Approvals  - Dashboard > Approvals, where these requests were already
                  listed; Approve asks for the code there (lib/approvalActions).
                  An outside guest has no Dashboard, so `standalone` keeps a
                  Requests sheet for them.
     Activity   - "..." > Activity, a sheet.

   The six filter dropdowns are the search (every word typed is looked for
   across name, username, site, department, location, company, type, tier,
   owner and state); the sorts and Select Several (bulk Move to Trash) are in
   "..."; a login opens as a sheet from the right, never a side pane.

   Nothing about access changed: the API still says per row what the caller
   may do (access / canReveal / canEdit); company secrets arrive only through
   explicit reveal calls behind the SMS / Email code gate (VaultOtpModal), one
   code per window ("Verified until <time>"), and are held in memory for the
   open login only. Deep links arrive as `activeSub` (vaultModel.parseSub)
   from the bell and the header search. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, ShieldCheck, Upload, Trash2, History, Lock, Download, ListChecks } from "lucide-react";
import { api } from "../api";
import { ensureStepUp, isStepUpRequired } from "../stepup/StepUp";
import { dialog } from "../ui/dialog";
import { SkeletonBlocks } from "../components/AsyncState";
import NewButton from "../components/NewButton";
import { useRole } from "../contexts/RoleContext";
import { useNameResolver } from "../lib/useNameResolver";
import { useIsMobile } from "../lib/useIsMobile";
import { usePeople } from "../tasks/components";
import { VaultOtpModal, DEFAULT_DEPTS } from "./vaultShared";
import {
  parseSub, verifiedLabel, readFavorites, writeFavorites, live, readRecents, noteRecent, siteOf, secondOwners, LIST_VIEWS, SORTS,
} from "./vaultModel";
import LoginList from "./LoginList";
import MoreMenu from "./MoreMenu";
import { ActivitySheet, RequestsSheet } from "./VaultSheets";
import { exportAudit } from "./auditExport";
import CredentialSheet from "./CredentialDrawer";
import HeadCodeModal from "./HeadCode";
import { CredentialForm, ImportWizard, ShareModal, RequestModal } from "./CredentialForm";
import PersonalVault from "./PersonalVault";
import "./credvault.css";

const CLIP_SECONDS = 30;       // a copied password is wiped from the clipboard after this

export default function CredentialVaultApp({ activeSub, standalone = false }) {
  const { myEmail, can, canAccessModule } = useRole();
  const isAdmin = can("administrator");
  const canWrite = canAccessModule("credvault", "administrator", "editor");
  const nameOf = useNameResolver();
  const people = usePeople();
  const isMobile = useIsMobile("(max-width: 900px)");

  // ── data ────────────────────────────────────────────────────────────────
  const [rawCreds, setCreds] = useState([]);
  const [requests, setRequests] = useState([]);
  const [logs, setLogs] = useState([]);
  const [otp, setOtp] = useState({ verified: false, until: null });
  const [hrDepts, setHrDepts] = useState([]);
  const [orgOpts, setOrgOpts] = useState({ companies: [], departments: [], sites: [] });   // Settings > Companies / Locations, for the form and the search
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
    api.cvAudienceOptions().then((o) => setOrgOpts({ companies: o?.companies || [], departments: o?.departments || [], sites: o?.sites || [] })).catch(() => {});
  }, [refresh]);

  // ── ui state ────────────────────────────────────────────────────────────
  const [view, setView] = useState("all");                 // the sentence's phrase in force, or "trash"
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name");
  const [selectedId, setSelectedId] = useState(null);
  const [selecting, setSelecting] = useState(false);       // "..." > Select Several
  const [checked, setChecked] = useState(() => new Set());
  const [favorites, setFavorites] = useState(readFavorites);
  const [recents, setRecents] = useState(readRecents);
  const [done, setDone] = useState("");                    // "<id>:u" | "<id>:p" | "<id>:t" - the button that just copied
  const [clipLeft, setClipLeft] = useState(0);
  const clipTimer = useRef(null);
  const [revealed, setRevealed] = useState(null);          // { id, secret, previousSecret?, prevRotatedAt? }
  const [form, setForm] = useState(null);                  // { cred | null }
  const [importOpen, setImportOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [personalAdd, setPersonalAdd] = useState(0);       // bumped by "+ New > Personal Login"
  const [personalOpen, setPersonalOpen] = useState(0);     // bumped by a deep link to Personal
  const [shareFor, setShareFor] = useState(null);
  const [requestFor, setRequestFor] = useState(null);
  const [otpGate, setOtpGate] = useState(null);            // { run }
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { writeFavorites(favorites); }, [favorites]);
  useEffect(() => { setChecked(new Set()); }, [view, selecting]);

  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Deep links: the bell / header search set `activeSub`; a repeat click on the
  // same destination arrives as a window event while the sub does not change.
  // The old tab addresses still land: a collection is a phrase of the
  // sentence, Activity its sheet, Personal its section. "approvals" is
  // Dashboard > Approvals (App sends it there); a guest gets the Requests sheet.
  const applySub = useCallback((sub) => {
    const { tab: t, credId, collection: col, create } = parseSub(sub);
    if (!t) return;
    if (t === "activity") setActivityOpen(true);
    if (t === "personal") setPersonalOpen((n) => n + 1);
    if (t === "approvals" && standalone) setRequestsOpen(true);
    if (col) { setQuery(""); setView(LIST_VIEWS.includes(col) ? col : "all"); }
    if (credId) setSelectedId(credId);
    if (create && canWrite) setForm({ cred: null });
  }, [canWrite, standalone]);
  useEffect(() => { applySub(activeSub); }, [activeSub, applySub]);
  useEffect(() => {
    const h = (e) => {
      const d = e.detail || {};
      if (d.view === "credvault") applySub(d.sub);
      else if (d.view === "dashboard" && /^passwords:/.test(d.sub || "")) applySub(d.sub.slice("passwords:".length));
    };
    window.addEventListener("nexus:navigate", h);
    return () => window.removeEventListener("nexus:navigate", h);
  }, [applySub]);

  // ── derived ─────────────────────────────────────────────────────────────
  // Each login carries its location's and company's names, so the search, the row and the sheet can use them.
  const creds = useMemo(() => {
    const sites = Object.fromEntries(orgOpts.sites.map((x) => [x.id, x.name]));
    const cos = Object.fromEntries(orgOpts.companies.map((x) => [x.id, x.name]));
    return rawCreds.map((c) => ({ ...c, siteName: c.siteId ? sites[c.siteId] || "" : "", companyName: c.companyId ? cos[c.companyId] || "" : "" }));
  }, [rawCreds, orgOpts.sites, orgOpts.companies]);
  const depts = useMemo(() => {
    const set = new Set(hrDepts.length ? hrDepts : DEFAULT_DEPTS);
    live(creds).forEach((c) => c.dept && set.add(c.dept));
    return [...set];
  }, [creds, hrDepts]);
  const deptsInUse = useMemo(() => [...new Set(live(creds).map((c) => c.dept).filter(Boolean))].sort(), [creds]);
  const selected = useMemo(() => creds.find((c) => c.id === selectedId) || null, [creds, selectedId]);
  const verified = otp.verified && otp.until > now;
  const checkedEditable = creds.filter((c) => checked.has(c.id) && c.canEdit && !c.deletedAt);
  const canManage = isAdmin || creds.some((c) => c.canEdit);
  // The audit file covers what the person manages (Pranshu, Oct 29 2026): a
  // Super Administrator every login; an owner, backup owner or department head
  // the ones they manage plus what is shared with them.
  const auditScope = useMemo(() => live(creds).filter((c) => isAdmin || c.canEdit || c.access === "shared" || c.access === "person"), [creds, isAdmin]);
  // Requests for a login I own. Inside Nexus they are decided in Dashboard >
  // Approvals, which never lists my own ask; the count here matches it.
  const waiting = standalone ? requests.length : requests.filter((r) => (r.requestedByEmail || "").toLowerCase() !== (myEmail || "").toLowerCase()).length;
  useEffect(() => {
    if (!clipLeft) return undefined;
    const t = setTimeout(() => setClipLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [clipLeft]);

  // Closing the detail drops the revealed secret with it.
  function closeDetail() { setSelectedId(null); setRevealed(null); }
  function open(id) { setActivityOpen(false); setSelectedId(id); }
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
  // `skip`: a login of my own department opens without the code (homeDept,
  // 11/13/2026); if the server still asks, the catch below opens the gate.
  function gated(run, skip = false) {
    const wrapped = () => run().catch(async (e) => {
      if (e?.detail?.code === "vault_otp_required") { setOtp({ verified: false, until: null }); setOtpGate({ run: wrapped }); return; }
      // Critical + Settings > Security step-up (Oct 29 2026): run the Entra
      // challenge, then the same action again.
      if (isStepUpRequired(e)) { const r = await ensureStepUp(); if (r.ok) return wrapped(); if (!r.cancelled) flash("Verification did not complete.", "info"); return; }
      throw e;
    });
    if (skip || (otp.verified && otp.until > Date.now())) return wrapped();
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
    }, c.homeDept);
  }
  // Copy Code from the row: the current authenticator code, behind the same gate.
  function copyCode(c) {
    gated(async () => {
      try { const r = await api.cvTotp(c.id); await clip(r.code, `${c.id}:t`); used(c.id); flash(`Code copied - good for ${r.left}s.`); }
      catch (e) { if (otpError(e)) throw e; flash(e?.message || "Could not get the code.", "info"); }
    }, c.homeDept);
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
    }, c.homeDept);
  }

  // The department head's code (11/13/2026): a change the server answers with
  // head_code_required opens the code card; once it is confirmed the same
  // change runs again. Cancel rejects, so the form / button keeps its state.
  const [headGate, setHeadGate] = useState(null);
  function withHead(run, action) {
    return run().catch((e) => {
      if (e?.detail?.code !== "head_code_required") throw e;
      return new Promise((resolve, reject) => setHeadGate({
        scopes: e.detail.scopes || [], action,
        done: () => { setHeadGate(null); withHead(run, action).then(resolve, reject); },
        cancel: () => { setHeadGate(null); reject(new Error("Not saved - it waits for the department head's code.")); },
      }));
    });
  }
  async function saveCredential(f) {
    if (form?.cred) {
      await withHead(() => api.cvUpdate(form.cred.id, f), `change ${f.name}`);
      if (f.owner && f.owner !== form.cred.owner) await withHead(() => api.cvTransfer(form.cred.id, f.owner), `hand ${f.name} to a new owner`);
      flash(`${f.name} updated.`);
    } else {
      const res = await withHead(() => api.cvCreate(f), `add ${f.name}`);
      if (f.owner && f.owner !== myEmail) await withHead(() => api.cvTransfer(res.id, f.owner), `hand ${f.name} to a new owner`);
      flash(`${f.name} added.`);
      setSelectedId(res.id);
    }
    setForm(null); setRevealed(null);
    await refresh();
  }
  // The wizard shows the result itself and closes on Done; this only sends
  // the rows and refreshes the list behind it.
  async function importRows(list) {
    const res = await withHead(() => api.cvImport(list), `import ${list.length} login${list.length === 1 ? "" : "s"}`);
    refresh().catch(() => {});
    return res;
  }
  async function trash(c) {
    const second = secondOwners(c, myEmail);
    const ok = await dialog.confirm(`Move ${c.name} to the trash? It can be recovered from there.${second.length ? ` To delete it for good, ${second.map(nameOf).join(" or ")} or an admin confirms - not you.` : ""}`, { title: "Move to Trash", confirmText: "Move to Trash", danger: true });
    if (!ok) return;
    try { await withHead(() => api.cvDelete(c.id), `move ${c.name} to the trash`); closeDetail(); await refresh(); flash(`${c.name} moved to the trash.`); } catch (e) { flash(e?.message || "Could not remove.", "info"); }
  }
  async function trashChecked() {
    const n = checkedEditable.length;
    if (!n) return;
    const ok = await dialog.confirm(`Move ${n} login${n === 1 ? "" : "s"} to the trash? They can be recovered from there.`, { title: "Move to Trash", confirmText: "Move to Trash", danger: true });
    if (!ok) return;
    try { await withHead(() => api.cvBulkDelete(checkedEditable.map((c) => c.id)), `move ${n} logins to the trash`); setChecked(new Set()); setSelecting(false); await refresh(); flash(`${n} moved to the trash.`); } catch (e) { flash(e?.message || "Could not remove.", "info"); }
  }
  async function restore(c) {
    try { await withHead(() => api.cvRestore(c.id), `recover ${c.name}`); await refresh(); flash(`${c.name} recovered.`); } catch (e) { flash(e?.message || "Could not recover.", "info"); }
  }
  // Held on the drawer's Delete Permanently (Neil, Oct 30 2026): no dialog;
  // a refusal throws so the button rewinds with the reason.
  async function purge(c) {
    try { await withHead(() => api.cvPurge(c.id), `delete ${c.name} for good`); } catch (e) { throw new Error(e?.message || "Could not delete.", { cause: e }); }
    closeDetail(); await refresh(); flash(`${c.name} deleted permanently.`, "info");
  }
  async function share(c, body) {
    setShareFor(null);
    await gated(async () => {
      try {
        const r = await withHead(() => api.cvShare(c.id, body), `share ${c.name}`);
        await refresh();
        const total = (r?.granted || 0) + (r?.external || 0);
        const who = body.recipients.length === 1 && !body.departments.length && !(body.externals || []).length ? nameOf(body.recipients[0]) : `${total} ${total === 1 ? "person" : "people"}`;
        flash(`${c.name} shared with ${who} ${body.durationLabel.startsWith("Until") ? body.durationLabel.toLowerCase() : `for ${body.durationLabel.toLowerCase()}`}.${r?.external ? ` ${r.external} outside Nexus got an email link.` : ""}`);
        if (r?.devLinks?.length) console.info("[credvault] local test links (no email here):", r.devLinks);
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
  function openWaiting() {
    if (standalone) { setRequestsOpen(true); return; }
    window.dispatchEvent(new CustomEvent("nexus:navigate", { detail: { view: "dashboard", sub: "approvals:access" } }));
  }
  function pickNew(key) {
    if (key === "cred") setForm({ cred: null });
    else if (key === "import") setImportOpen(true);
    else if (key === "personal") { setView("all"); setSelecting(false); setPersonalAdd((n) => n + 1); }
  }
  function pickMore(key) {
    if (key === "activity") setActivityOpen(true);
    else if (key === "trash") { setSelecting(false); setQuery(""); setView("trash"); }
    else if (key === "export") exportAudit(auditScope, nameOf);
    else if (key === "select") { if (view === "trash") setView("all"); setSelecting(true); }
    else if (key.startsWith("sort:")) setSort(key.slice(5));
  }

  if (loading) return <div style={{ padding: "16px 0" }}><SkeletonBlocks count={6} height={52} /></div>;

  const hasTrash = isAdmin || creds.some((c) => c.canEdit || c.deletedAt);
  const newItems = [
    ...(canWrite ? [{ key: "cred", label: "Login", hint: "A login, key or code for the company", Icon: KeyRound }] : []),
    { key: "personal", label: "Personal Login", hint: "Private to you", Icon: Lock },
    ...(canWrite ? [{ key: "import", label: "Import From a Spreadsheet...", hint: "Many at once, from a CSV or Excel file", Icon: Upload }] : []),
  ];
  const moreItems = [
    { key: "activity", label: "Activity", hint: "Who opened, copied, shared or changed what", Icon: History },
    ...(hasTrash ? [{ key: "trash", label: "Trash", hint: "Recover a login, or delete it for good", Icon: Trash2 }] : []),
    ...(canManage ? [{ key: "export", label: "Export for an Audit", hint: "Who can open what, health by department, what rotates next - no passwords", Icon: Download }] : []),
    ...(creds.some((c) => c.canEdit && !c.deletedAt) ? [{ key: "select", label: "Select Several", hint: "Move many to the trash at once", Icon: ListChecks }] : []),
    ...SORTS.map(([k, label], i) => ({ key: `sort:${k}`, label: `Sort by ${label}`, checked: sort === k, sep: i === 0 })),
  ];
  const detailProps = selected && {
    cred: selected, logs, myEmail, nameOf, depts: deptsInUse, siteName: selected.siteName || "", done,
    favorite: favorites.has(selected.id), onToggleFavorite: () => toggleFavorite(selected.id),
    revealed: revealed?.id === selected.id ? revealed : null,
    onReveal: () => gated(() => reveal(selected), selected.homeDept), onHide: () => setRevealed(null), onCopiedSecret: () => copiedSecret(selected),
    onCopyPassword: () => copyPassword(selected), onCopyCode: () => copyCode(selected),
    onEdit: () => setForm({ cred: selected }), onTrash: () => trash(selected), onRestore: () => restore(selected), onPurge: () => purge(selected),
    onShare: () => setShareFor(selected), onRequest: () => setRequestFor(selected), onChanged: () => refresh().catch(() => {}),
    onClose: closeDetail,
  };

  return (
    <div className="cv-root">
      {loadError && (
        <p className="cv-load-error" role="alert">Could not load your logins. <button type="button" className="secondary-btn" onClick={() => refresh().catch(() => setLoadError(true))}>Retry</button></p>
      )}

      <LoginList rows={creds} depts={deptsInUse} favorites={favorites} recents={recents} query={query} onQuery={setQuery}
        view={view} onView={setView} sort={sort} onSort={setSort} selectedId={selectedId} now={now} nameOf={nameOf} myEmail={myEmail} done={done} clipLeft={clipLeft}
        verified={verified ? verifiedLabel(otp.until, now) : ""} everyone={isAdmin} waiting={waiting} onWaiting={openWaiting} autoFocus={!isMobile}
        selecting={selecting} checked={checked} onCheck={toggleChecked} onTrashChecked={trashChecked} onDoneSelecting={() => setSelecting(false)}
        onOpen={open} onCopyUser={copyUser} onCopyPassword={copyPassword} onOpenSite={openSite} onCopyCode={copyCode} onRequest={setRequestFor}
        // No page title (Neil, 11/06/2026): the module bar names the place. "+ New"
        // and "..." close the search row - one first row, nothing floating above it.
        actions={<><NewButton title="Add a login" items={newItems} onPick={pickNew} compact={isMobile} /><MoreMenu items={moreItems} onPick={pickMore} /></>}>
        {/* Always mounted, so its unlock window survives a filter and back (one unlock per window, Neil Oct 14 2026). */}
        <PersonalVault myEmail={myEmail} flash={flash} query={query} addSignal={personalAdd} openSignal={personalOpen} />
      </LoginList>

      {activityOpen && <ActivitySheet logs={logs} canOpen={(id) => creds.some((c) => c.id === id)} onOpen={open} onClose={() => setActivityOpen(false)} />}
      {requestsOpen && <RequestsSheet requests={requests} depts={deptsInUse} nameOf={nameOf} onApprove={approve} onDeny={deny} onClose={() => setRequestsOpen(false)} />}
      {selected && <CredentialSheet key={selected.id} {...detailProps} />}
      {form && <CredentialForm cred={form.cred} people={people} myEmail={myEmail} nameOf={nameOf} companies={orgOpts.companies} sites={orgOpts.sites} myCompanyId={orgOpts.companies.length === 1 ? orgOpts.companies[0].id : ""} onClose={() => setForm(null)} onSave={saveCredential} />}
      {importOpen && <ImportWizard depts={depts} sites={orgOpts.sites} departments={orgOpts.departments} people={people} myEmail={myEmail} existing={creds} nameOf={nameOf} onClose={() => setImportOpen(false)} onImport={importRows} />}
      {headGate && <HeadCodeModal scopes={headGate.scopes} action={headGate.action} onDone={headGate.done} onCancel={headGate.cancel} />}
      {shareFor && <ShareModal cred={shareFor} people={people.filter((p) => p.email !== myEmail)} nameOf={nameOf} onClose={() => setShareFor(null)} onSubmit={(body) => share(shareFor, body)} />}
      {requestFor && <RequestModal cred={requestFor} nameOf={nameOf} onClose={() => setRequestFor(null)} onSubmit={(ms, label) => request(requestFor, ms, label)} />}
      {otpGate && <VaultOtpModal onClose={() => setOtpGate(null)} onVerified={afterOtp} />}

      {toast && <div className={`cv-toast${toast.kind === "info" ? " cv-toast-info" : ""}`} role="status"><ShieldCheck size={15} /> {toast.msg}</div>}
    </div>
  );
}
