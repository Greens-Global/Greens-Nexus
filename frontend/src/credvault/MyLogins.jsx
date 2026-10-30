// Credentials - My Logins (Oct 29 2026): the everyday list. Only what the
// person can open, favorites first, then what they used lately, then the rest
// by department - each row with Copy Username, Copy Password and Open, so a
// password is one click from the list (the spreadsheet was). Rows they can
// see but not open sit folded at the bottom with Request Access. The screen
// owns the gated calls; this file lays the list out.
import { useState } from "react";
import { Search, X, Star, Clock, Copy, Check, KeyRound, ExternalLink, ChevronDown, ChevronRight, Send, ShieldAlert, Lock, ShieldCheck } from "lucide-react";
import { ACCESS_LABEL, groupLogins, healthFlags, healthTone, siteOf, timeLeft } from "./vaultModel";
import { Monogram } from "./vaultCards";

/** The site's own icon when the row has a link, else the department monogram. */
export function SiteIcon({ cred, depts, size = 38 }) {
  const [broken, setBroken] = useState(false);
  const host = siteOf(cred.url);
  if (!host || broken) return <Monogram name={cred.name} dept={cred.dept} depts={depts} size={size} />;
  return <img className="cv-site-icon" style={{ width: size, height: size }} src={`https://icon.horse/icon/${host}`} alt="" onError={() => setBroken(true)} loading="lazy" />;
}

function RowActions({ cred, done, onCopyUser, onCopyPassword, onOpenSite, onCopyCode }) {
  const hasUser = cred.username && cred.username !== "-";
  const site = siteOf(cred.url);
  return (
    <span className="cv-login-actions">
      {hasUser && (
        <button type="button" className={`cv-btn${done === `${cred.id}:u` ? " is-done" : ""}`} title={`Copy username ${cred.username}`} aria-label={`Copy username for ${cred.name}`} onClick={() => onCopyUser(cred)}>
          {done === `${cred.id}:u` ? <Check size={13} /> : <Copy size={13} />} User
        </button>
      )}
      <button type="button" className={`cv-btn${done === `${cred.id}:p` ? " is-done" : ""}`} title="Copy the password (logged)" aria-label={`Copy password for ${cred.name}`} onClick={() => onCopyPassword(cred)}>
        {done === `${cred.id}:p` ? <Check size={13} /> : <KeyRound size={13} />} Password
      </button>
      {cred.hasTotp && (
        <button type="button" className={`cv-btn${done === `${cred.id}:t` ? " is-done" : ""}`} title="Copy the current authenticator code" aria-label={`Copy code for ${cred.name}`} onClick={() => onCopyCode(cred)}>
          {done === `${cred.id}:t` ? <Check size={13} /> : <ShieldCheck size={13} />} Code
        </button>
      )}
      {site && (
        <button type="button" className="cv-btn" title={`Copy the password and open ${site}`} aria-label={`Open ${cred.name}`} onClick={() => onOpenSite(cred)}>
          <ExternalLink size={13} /> Open
        </button>
      )}
    </span>
  );
}

function Row({ cred, depts, active, favorite, now, nameOf, done, onOpen, onToggleFavorite, ...actions }) {
  const flags = healthFlags(cred);
  const tone = healthTone(cred);
  return (
    <div className={`cv-login${active ? " is-active" : ""}`} data-login={cred.id}>
      <button type="button" className="cv-login-open" onClick={() => onOpen(cred.id)} aria-current={active ? "true" : undefined} aria-label={`${cred.name} details`}>
        <SiteIcon cred={cred} depts={depts} />
      </button>
      <button type="button" className="cv-login-open cv-login-main" onClick={() => onOpen(cred.id)} style={{ display: "block" }}>
        <div className="cv-login-name">
          <span>{cred.name}</span>
          {cred.tier === "Critical" && <span className="cv-chip cv-chip-xs tone-bad"><ShieldAlert size={10} /> Critical</span>}
          {flags.length > 0 && <span className={`cv-dot tone-${tone}`} title={flags.map((f) => f.label).join(", ")} />}
          {favorite && <Star size={11} className="cv-prow-star" fill="currentColor" />}
        </div>
        <div className="cv-login-sub">
          {cred.username && cred.username !== "-" ? cred.username : siteOf(cred.url) || cred.dept}
          {cred.access === "shared" && cred.grantUntil ? <> · <Clock size={10} style={{ verticalAlign: -1 }} /> {timeLeft(cred.grantUntil - now)} left</> : null}
          {cred.access === "person" ? <> · shared with you by {nameOf(cred.owner)}</> : null}
        </div>
      </button>
      <RowActions cred={cred} done={done} {...actions} />
    </div>
  );
}

function Section({ Icon, title, rows, children }) {
  if (!rows.length) return null;
  return (<>
    <div className="cv-login-head"><Icon size={12} /> {title} <span className="cv-login-head-n">{rows.length}</span></div>
    {children}
  </>);
}

export default function MyLogins({
  rows, depts, favorites, recents, query, onQuery, selectedId, now, nameOf, done, clipLeft,
  onOpen, onToggleFavorite, onCopyUser, onCopyPassword, onOpenSite, onCopyCode, onRequest,
}) {
  const [showLocked, setShowLocked] = useState(false);
  const g = groupLogins(rows, { favorites, recents, query });
  const attention = rows.filter((c) => c.canReveal && !c.deletedAt && healthFlags(c).length).length;
  const shared = rows.filter((c) => (c.access === "shared" || c.access === "person") && !c.deletedAt).length;
  const rowProps = (c) => ({ cred: c, depts, active: selectedId === c.id, favorite: favorites.has(c.id), now, nameOf, done, onOpen, onToggleFavorite, onCopyUser, onCopyPassword, onOpenSite, onCopyCode });
  return (
    <div className="cv-rows cv-logins" data-my-logins="">
      <div className="cv-login-strip">
        <label className="search-bar">
          <Search size={13} style={{ flexShrink: 0 }} />
          <input placeholder="Search my logins…" aria-label="Search my logins" value={query} onChange={(e) => onQuery(e.target.value)} autoFocus />
          {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onQuery("")}><X size={13} /></button>}
        </label>
        {clipLeft > 0 && <span className="cv-clip-chip" title="The clipboard is wiped when this reaches zero"><Copy size={11} /> Clipboard clears in {clipLeft}s</span>}
        {attention > 0 && <span className="cv-chip cv-chip-xs tone-warn" title="Weak, reused, overdue or expiring - open the login to see which">{attention} need{attention === 1 ? "s" : ""} attention</span>}
        {shared > 0 && <span className="cv-chip cv-chip-xs tone-ok">Shared with you: {shared}</span>}
      </div>

      {g.total === 0 && (
        <div className="cv-empty">
          <Lock size={28} style={{ opacity: .25, display: "block", margin: "0 auto 10px" }} />
          <strong>{query ? "No logins match" : "Nothing you can open yet"}</strong>
          {query ? "Try another name, username or site." : g.locked.length ? "The logins below exist but are not shared with you - ask their owners." : "When a login is shared with you or your department, it shows up here."}
        </div>
      )}

      <Section Icon={Star} title="Favorites" rows={g.favorites}>{g.favorites.map((c) => <Row key={c.id} {...rowProps(c)} />)}</Section>
      <Section Icon={Clock} title="Recently Used" rows={g.recent}>{g.recent.map((c) => <Row key={c.id} {...rowProps(c)} />)}</Section>
      {g.byDept.map((d) => (
        <Section key={d.dept} Icon={KeyRound} title={d.dept} rows={d.rows}>{d.rows.map((c) => <Row key={c.id} {...rowProps(c)} />)}</Section>
      ))}

      {g.locked.length > 0 && (<>
        <button type="button" className="cv-locked-toggle" onClick={() => setShowLocked((v) => !v)} aria-expanded={showLocked}>
          {showLocked ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Not shared with you <span className="cv-login-head-n">{g.locked.length}</span>
          <span style={{ marginLeft: "auto", fontSize: 12 }}>{showLocked ? "" : "Ask the owner for timed access"}</span>
        </button>
        {showLocked && g.locked.map((c) => (
          <div className="cv-login" key={c.id} data-login={c.id}>
            <button type="button" className="cv-login-open" onClick={() => onOpen(c.id)} aria-label={`${c.name} details`}><SiteIcon cred={c} depts={depts} /></button>
            <button type="button" className="cv-login-open cv-login-main" onClick={() => onOpen(c.id)} style={{ display: "block" }}>
              <div className="cv-login-name"><span>{c.name}</span>{c.tier === "Critical" && <span className="cv-chip cv-chip-xs tone-bad">Critical</span>}<span className="cv-chip cv-chip-xs tone-muted">{ACCESS_LABEL[c.access]}</span></div>
              <div className="cv-login-sub">{c.dept} · owned by {nameOf(c.owner)}{c.access === "view" && c.username && c.username !== "-" ? ` · ${c.username}` : ""}</div>
            </button>
            <span className="cv-login-actions">
              <button type="button" className="cv-btn" onClick={() => onRequest(c)} aria-label={`Request access to ${c.name}`}><Send size={13} /> Request Access</button>
            </span>
          </div>
        ))}
      </>)}
    </div>
  );
}
