// Credential Vault - one credential in full (Oct 14 2026 rebuild): sign-in
// (username, password behind the identity check, previous password for
// owners), details, who has access, its history, and the owner's actions.
// On a desktop it renders in place beside the list (CredentialDetail); on a
// phone the same content slides in as a full-screen sheet (CredentialSheet).
// The screen owns the data and the gated calls; this file only lays them out.
import { useEffect, useRef, useState } from "react";
import {
  X, Copy, Check, Eye, EyeOff, ExternalLink, Pencil, Trash2, RefreshCw, Share2, KeyRound, Star,
  ShieldAlert, Clock, UserMinus, Lock, Send, ShieldCheck,
} from "lucide-react";
import { api } from "../api";
import { useDialogFocus, trapTab } from "../lib/useDialogFocus";
import { formatDate, formatDateTime } from "../lib/datetime";
import { TeamsIcon, agoLabel, actionStyle, Pager } from "./vaultShared";
import { ACCESS_LABEL, ACCESS_TONE, healthFlags, rotationDaysLeft, rotationDueDate, timeLeft } from "./vaultModel";
import { Monogram } from "./vaultCards";

function CopyButton({ text, onCopied, title = "Copy", disabled = false }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="cv-iconbtn" title={title} aria-label={title} disabled={disabled || !text}
      onClick={() => { try { navigator.clipboard?.writeText(text); } catch { /* clipboard blocked */ } setDone(true); setTimeout(() => setDone(false), 1400); onCopied?.(); }}>
      {done ? <Check size={14} style={{ color: "var(--cv-ok)" }} /> : <Copy size={14} />}
    </button>
  );
}

// The authenticator code (Oct 29 2026): comes with the reveal, counts down,
// and fetches the next one when it rolls over while the drawer is open.
function TotpRow({ credId, first, onCopied }) {
  const [totp, setTotp] = useState(first);
  const [left, setLeft] = useState(first.left);
  useEffect(() => { setTotp(first); setLeft(first.left); }, [first]);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left > 0) return;
    api.cvTotp(credId).then((r) => { setTotp(r); setLeft(r.left); }).catch(() => setLeft(30));
  }, [left, credId]);
  return (
    <div className="cv-field" data-totp="">
      <span className="cv-field-label">Code</span>
      <span className="cv-field-value cv-mono is-open" style={{ letterSpacing: ".18em", fontWeight: 700 }}>{totp.code.slice(0, 3)} {totp.code.slice(3)}</span>
      <span className="cv-hint" style={{ minWidth: 60, textAlign: "right" }}>{Math.max(0, left)}s</span>
      <div className="cv-field-actions"><CopyButton text={totp.code} title="Copy Code" onCopied={onCopied} /></div>
    </div>
  );
}

export function CredentialDetail({
  cred, logs, myEmail, nameOf, depts = [], favorite, onToggleFavorite,
  revealed, onReveal, onHide, onCopiedSecret,
  onEdit, onTrash, onRestore, onPurge, onShare, onRequest, onClose, onChanged, sheet = false,
}) {
  const [access, setAccess] = useState(null);
  const [showPrev, setShowPrev] = useState(false);
  // The drawer keeps its own second clock for the grant countdowns, so the
  // list behind it is not re-rendered every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const inTrash = !!cred.deletedAt;
  const flags = healthFlags(cred);

  // The parent keys this drawer by credential id, so state starts fresh per
  // credential; this only fetches who has access (owners only).
  useEffect(() => {
    if (!cred.canEdit) return undefined;
    let alive = true;
    api.cvAccess(cred.id).then((a) => { if (alive) setAccess(a); }).catch(() => {});
    return () => { alive = false; };
  }, [cred.id, cred.canEdit, cred.sharedWith]);


  async function revoke(g) {
    try { await api.cvRevokeGrant(g.id); setAccess((a) => a && { ...a, grants: a.grants.filter((x) => x.id !== g.id) }); onChanged?.(); }
    catch { /* the screen's toast handles API errors elsewhere; keep the row */ }
  }

  const left = rotationDaysLeft(cred);
  // History, 10 a page (Pranshu, Oct 29 2026).
  const allHistory = logs.filter((e) => e.credId === cred.id);
  const [histPage, setHistPage] = useState(1);
  const histPages = Math.max(1, Math.ceil(allHistory.length / 10));
  const history = allHistory.slice((histPage - 1) * 10, histPage * 10);

  return (
    <div className={`cv-detail${sheet ? " is-sheet" : ""}`} role={sheet ? undefined : "region"} aria-label={sheet ? undefined : cred.name}>
        <div className="cv-drawer-head">
          <Monogram name={cred.name} dept={cred.dept} depts={depts} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>{cred.name}</h3>
            {cred.url && /^https?:\/\//i.test(cred.url) && <a className="cv-link cv-detail-domain" href={cred.url} target="_blank" rel="noopener noreferrer">{cred.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}<ExternalLink size={11} /></a>}
            <div className="cv-drawer-chips">
              <span className={`cv-chip tone-${ACCESS_TONE[cred.access] || "muted"}`}>{ACCESS_LABEL[cred.access] || cred.access}</span>
              {cred.tier !== "Standard" && <span className={`cv-chip ${cred.tier === "Critical" ? "tone-bad" : "tone-warn"}`}><ShieldAlert size={12} /> {cred.tier}</span>}
              {cred.dept && <span className="cv-chip">{cred.dept}</span>}
              <span className="cv-chip">{cred.type}</span>
              {inTrash && <span className="cv-chip tone-bad"><Trash2 size={12} /> In Trash</span>}
              {flags.map((f) => <span key={f.key} className={`cv-chip tone-${f.tone}`}>{f.label}</span>)}
            </div>
          </div>
          {!inTrash && (
            <button type="button" className={`cv-star${favorite ? " is-on" : ""}`} aria-label={favorite ? "Remove from Favorites" : "Add to Favorites"} aria-pressed={favorite} onClick={onToggleFavorite}>
              <Star size={17} fill={favorite ? "currentColor" : "none"} />
            </button>
          )}
          <button type="button" className="cv-iconbtn" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="cv-drawer-body">
          {/* Sign-in */}
          <section className="cv-section">
            <div className="cv-section-title">Sign-In</div>
            {(cred.canReveal || cred.access === "view") && (
              <div className="cv-field">
                <span className="cv-field-label">Username</span>
                <span className="cv-field-value" title={cred.username}>{cred.username || "-"}</span>
                <div className="cv-field-actions"><CopyButton text={cred.username} title="Copy Username" /></div>
              </div>
            )}
            {cred.canReveal ? (<>
              <div className="cv-field">
                <span className="cv-field-label">Password</span>
                <span className={`cv-field-value cv-mono ${revealed ? "is-open" : "is-secret"}`}>{revealed ? revealed.secret : "••••••••••"}</span>
                <div className="cv-field-actions">
                  {!inTrash && (revealed
                    ? <button type="button" className="cv-iconbtn" title="Hide" aria-label="Hide Password" onClick={onHide}><EyeOff size={14} /></button>
                    : <button type="button" className="cv-iconbtn" title="Reveal" aria-label="Reveal Password" onClick={onReveal}><Eye size={14} /></button>)}
                  <CopyButton text={revealed?.secret} title="Copy Password" disabled={!revealed} onCopied={onCopiedSecret} />
                </div>
              </div>
              {revealed?.totp && <TotpRow credId={cred.id} first={revealed.totp} onCopied={onCopiedSecret} />}
              {!revealed && cred.hasTotp && !inTrash && <p className="cv-hint" style={{ marginTop: -4 }}><ShieldCheck size={11} style={{ verticalAlign: -1 }} /> This login has two-step sign-in: Reveal also shows the current authenticator code.</p>}
              {revealed?.previousSecret && (
                <div className="cv-field" style={{ background: "var(--bg-secondary)" }}>
                  <span className="cv-field-label">Previous</span>
                  <span className={`cv-field-value cv-mono ${showPrev ? "is-open" : "is-secret"}`}>{showPrev ? revealed.previousSecret : "••••••••••"}</span>
                  <div className="cv-field-actions">
                    <button type="button" className="cv-iconbtn" title={showPrev ? "Hide" : "Show the password before the last rotation"} aria-label="Toggle Previous Password" onClick={() => setShowPrev((v) => !v)}>{showPrev ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                    <CopyButton text={revealed.previousSecret} title="Copy Previous Password" disabled={!showPrev} />
                  </div>
                </div>
              )}
              {revealed?.previousSecret && revealed.prevRotatedAt && <p className="cv-hint">Previous password kept from the rotation on {formatDate(revealed.prevRotatedAt)}. It goes when the password is rotated again.</p>}
              {!revealed && !inTrash && <p className="cv-hint"><Lock size={11} style={{ verticalAlign: -1 }} /> Revealing is logged. The first reveal asks for a code by text or email.</p>}
            </>) : (
              <div className="cv-callout tone-info">
                <KeyRound size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {cred.access === "view" ? "You can see this login but not its password. " : cred.tier === "Critical" ? "This is a Critical credential. " : "This credential is not shared with you. "}
                  Ask {nameOf(cred.owner)} for timed access - they, the department head or an admin approve it, and it appears here when they do.
                </span>
              </div>
            )}
          </section>

          {/* Details */}
          <section className="cv-section">
            <div className="cv-section-title">Details</div>
            <dl className="cv-kv">
              <dt>Last Rotated</dt>
              <dd>{cred.rotatedAt ? formatDate(cred.rotatedAt) : "-"} {cred.rotatedDays === 0 ? "(today)" : cred.rotatedAt ? `(${cred.rotatedDays}d ago)` : ""}</dd>
              <dt>Rotate Every</dt>
              <dd>{cred.rotationMax || 90} days · {left < 0 ? <span style={{ color: "var(--cv-bad)", fontWeight: 500 }}>overdue since {rotationDueDate(cred)}</span> : left <= 10 ? <span style={{ color: "var(--cv-warn)", fontWeight: 500 }}>due {rotationDueDate(cred)}</span> : `due ${rotationDueDate(cred)}`}</dd>
              {cred.expiresAt && <><dt>Expires</dt><dd>{formatDate(cred.expiresAt)}{cred.expiresInDays != null && cred.expiresInDays < 0 ? " (expired)" : ""}</dd></>}
              <dt>Added</dt><dd>{cred.createdAt ? formatDate(cred.createdAt) : "-"}</dd>
            </dl>
            {cred.note && <div className="cv-note" style={{ marginTop: 10 }}>{cred.note}</div>}
          </section>

          {/* Access */}
          <section className="cv-section">
            <div className="cv-section-title">
              <span>Access</span>
              {cred.canEdit && !inTrash && <button type="button" className="cv-btn" style={{ padding: "3px 9px", fontSize: 12 }} onClick={onShare}><Share2 size={13} /> Share</button>}
            </div>
            <div className="cv-person">
              <span>{nameOf(cred.owner)} <span className="cv-muted">· Owner</span></span>
              {cred.owner && cred.owner !== myEmail && <a href={`https://teams.microsoft.com/l/chat/0/0?users=${cred.owner}`} target="_blank" rel="noopener noreferrer" title={`Chat with ${nameOf(cred.owner)} on Teams`} style={{ display: "flex" }}><TeamsIcon size={18} /></a>}
            </div>
            {cred.backupOwner && <div className="cv-person"><span>{nameOf(cred.backupOwner)} <span className="cv-muted">· Backup Owner</span></span></div>}
            {access?.heads?.filter((h) => h !== cred.owner && h !== cred.backupOwner).map((h) => (
              <div className="cv-person" key={h}><span>{nameOf(h)} <span className="cv-muted">· Department Head</span></span></div>
            ))}
            {/* Who may open it (Oct 29 2026): the audience rows, or the old department rule when there are none. */}
            {(cred.audiences || []).filter((a) => cred.tier !== "Critical" || a.kind === "person").map((a) => (
              <div className="cv-person" key={`${a.kind}:${a.value}`}>
                <span>{a.kind === "person" ? nameOf(a.value) : a.label} <span className="cv-muted">· {a.level === "view" ? "View only" : a.kind === "person" ? "Can open" : "Everyone in it can open"}</span></span>
              </div>
            ))}
            {!(cred.audiences || []).length && cred.dept && cred.tier !== "Critical" && <div className="cv-person"><span>Everyone in {cred.dept} <span className="cv-muted">· Department</span></span></div>}
            {cred.tier === "Critical" && <div className="cv-person"><span className="cv-muted">Critical: only the owners, the department head, admins, the people named here and people given timed access can open this.</span></div>}
            {access?.grants?.map((g) => (
              <div className="cv-person" key={g.id}>
                <span>{g.name} <span className="cv-muted">· <Clock size={11} style={{ verticalAlign: -1 }} /> {timeLeft(g.expiresAt - now)} left</span></span>
                <button type="button" className="cv-iconbtn is-danger" title="End this access now" aria-label={`End access for ${g.name}`} onClick={() => revoke(g)}><UserMinus size={14} /></button>
              </div>
            ))}
            {access?.pending?.map((p) => (
              <div className="cv-person" key={p.id}><span>{p.name} <span className="cv-muted">· asked for {p.duration} · {agoLabel(p.ts)}</span></span><span className="cv-chip tone-warn">Waiting</span></div>
            ))}
            {cred.access === "shared" && cred.grantUntil && <div className="cv-person"><span>You <span className="cv-muted">· shared access, {timeLeft(cred.grantUntil - now)} left</span></span></div>}
            {!cred.canReveal && !inTrash && (
              <button type="button" className="cv-btn-dark" style={{ marginTop: 10 }} onClick={onRequest}><Send size={14} /> Request Access</button>
            )}
          </section>

          {/* History */}
          <section className="cv-section">
            <div className="cv-section-title">History</div>
            {allHistory.length === 0 ? <p className="cv-hint">Nothing logged yet.</p> : (
              <div className="cv-history">
                {history.map((e) => (
                  <div key={e.id}>
                    <div className="cv-history-row">
                      <b>{e.actor}</b>
                      <span style={{ ...actionStyle(e.action), borderRadius: 6, padding: "0 6px", fontSize: 11.5, fontWeight: 500 }}>{e.action}</span>
                      {e.ip ? <span className="cv-muted" title={e.userAgent || ""} style={{ fontSize: 11 }}>from {e.ip}</span> : null}
                      <time title={formatDateTime(e.ts)}>{agoLabel(e.ts)}</time>
                    </div>
                    {Array.isArray(e.detail) && e.detail.length > 0 && (
                      <div className="cv-diff">
                        {e.detail.map((d, i) => <span key={i} style={{ marginRight: 10 }}>{d.field}: {d.from ? <><s>{d.from}</s> → </> : null}{d.to}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <Pager page={histPage} pages={histPages} total={allHistory.length} size={10} onPage={setHistPage} compact />
          </section>
        </div>

        {(cred.canEdit) && (
          <div className="cv-drawer-foot">
            {inTrash ? (<>
              <button type="button" className="cv-btn" onClick={onRestore}><RefreshCw size={14} /> Recover</button>
              <span className="cv-spacer" />
              <button type="button" className="cv-btn cv-btn-danger" onClick={onPurge}><Trash2 size={14} /> Delete Permanently</button>
            </>) : (<>
              <button type="button" className="cv-btn" onClick={onEdit}><Pencil size={14} /> Edit</button>
              <span className="cv-spacer" />
              <button type="button" className="cv-btn cv-btn-danger" onClick={onTrash}><Trash2 size={14} /> Move to Trash</button>
            </>)}
          </div>
        )}
    </div>
  );
}

/** Phone: the same detail as a full-screen sheet with its own focus and Escape. */
export default function CredentialSheet(props) {
  const panelRef = useRef(null);
  useDialogFocus(panelRef);
  const { onClose, cred } = props;
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="cv-drawer-overlay" onMouseDown={onClose} />
      <aside className="cv-drawer" role="dialog" aria-modal="true" aria-label={cred.name} ref={panelRef} tabIndex={-1} onKeyDown={trapTab}>
        <CredentialDetail {...props} sheet />
      </aside>
    </>
  );
}
