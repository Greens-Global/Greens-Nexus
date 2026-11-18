// Passwords - the one list (Neil, 11/18/2026; plan
// https://claude.ai/artifact/3vdxK7zcuFPeiKkVvKc1xu). A search box, one
// sentence, one row per login:
//   - Search is the filter: every word typed is looked for across the name,
//     username, site, department, location, company, type, tier, owner and
//     state (vaultModel.loginHaystack). "/" jumps to it, Enter opens the
//     first result.
//   - The sentence is the menu: its phrases are the old collections; a click
//     filters the list, a phrase at zero is not shown.
//   - One button a row: Open (copies the password, opens the site, says the
//     username) or Copy when there is no site. User, Password and Code show on
//     hover or keyboard focus; a touch screen has no hover, so it keeps them
//     all under the name (the 11/15/2026 phone pass). A click on the row opens
//     the login as a sheet.
//   - States are words on the row's own line ("rotation 12 days overdue").
// The screen (CredentialVaultApp) owns the data and every gated call; this
// file lays the list out.
import { useEffect, useRef, useState } from "react";
import { Search, X, Star, Copy, Check, KeyRound, ExternalLink, ChevronDown, ChevronRight, Send, ShieldCheck, Trash2 } from "lucide-react";
import { ACCESS_LABEL, flagWords, healthFlags, listLogins, sentenceCounts, siteOf, timeLeft, SORTS } from "./vaultModel";
import { Monogram } from "./vaultCards";

/** The site's own icon when the row has a link, else the department monogram. */
export function SiteIcon({ cred, depts, size = 34 }) {
  const [broken, setBroken] = useState(false);
  const host = siteOf(cred.url);
  if (!host || broken) return <Monogram name={cred.name} dept={cred.dept} depts={depts} size={size} />;
  return <img className="cv-site-icon" style={{ width: size, height: size }} src={`https://icon.horse/icon/${host}`} alt="" onError={() => setBroken(true)} loading="lazy" />;
}

function RowActions({ cred, done, onCopyUser, onCopyPassword, onOpenSite, onCopyCode }) {
  const hasUser = cred.username && cred.username !== "-";
  const site = siteOf(cred.url);
  const ok = (k) => done === `${cred.id}:${k}`;
  return (
    <span className="cv-l-acts">
      {hasUser && (
        <button type="button" className={`cv-l-btn is-x${ok("u") ? " is-done" : ""}`} title={`Copy username ${cred.username}`} aria-label={`Copy username for ${cred.name}`} onClick={() => onCopyUser(cred)}>
          {ok("u") ? <Check size={13} /> : <Copy size={13} />} User
        </button>
      )}
      {/* With a site, Password is one of the quiet extras and Open leads; with none, copying the password is the row's one button. */}
      {site && (
        <button type="button" className={`cv-l-btn is-x${ok("p") ? " is-done" : ""}`} title="Copy the password (logged)" aria-label={`Copy password for ${cred.name}`} onClick={() => onCopyPassword(cred)}>
          {ok("p") ? <Check size={13} /> : <KeyRound size={13} />} Password
        </button>
      )}
      {cred.hasTotp && (
        <button type="button" className={`cv-l-btn is-x${ok("t") ? " is-done" : ""}`} title="Copy the current authenticator code" aria-label={`Copy code for ${cred.name}`} onClick={() => onCopyCode(cred)}>
          {ok("t") ? <Check size={13} /> : <ShieldCheck size={13} />} Code
        </button>
      )}
      {site ? (
        <button type="button" className="cv-l-btn" title={`Copy the password and open ${site}`} aria-label={`Open ${cred.name}`} onClick={() => onOpenSite(cred)}>
          <ExternalLink size={13} /> Open
        </button>
      ) : (
        <button type="button" className={`cv-l-btn${ok("p") ? " is-done" : ""}`} title="Copy the password (logged)" aria-label={`Copy password for ${cred.name}`} onClick={() => onCopyPassword(cred)}>
          {ok("p") ? <Check size={13} /> : <Copy size={13} />} Copy
        </button>
      )}
    </span>
  );
}

/** The row's second line: who it is for and what state it is in, as words. */
function SubLine({ cred, now, nameOf }) {
  const parts = [];
  const user = cred.username && cred.username !== "-" ? cred.username : "";
  if (user) parts.push(<span key="u">{user}</span>);
  else if (siteOf(cred.url)) parts.push(<span key="s">{siteOf(cred.url)}</span>);
  if (cred.dept) parts.push(<span key="d">{cred.dept}</span>);
  if (cred.siteName) parts.push(<span key="l">{cred.siteName}</span>);
  if (cred.tier && cred.tier !== "Standard") parts.push(<span key="t" title={cred.tier === "Critical" ? "Critical: only named people open it" : "High: closely guarded"}>{cred.tier}</span>);
  if (cred.deletedAt) parts.push(<span key="x" className="tone-bad">in the trash</span>);
  else {
    if (cred.access === "shared" && cred.grantUntil) parts.push(<span key="g">shared with you, {timeLeft(cred.grantUntil - now)} left</span>);
    if (cred.access === "person") parts.push(<span key="p">shared with you by {nameOf(cred.owner)}</span>);
    if (cred.canReveal) healthFlags(cred).slice(0, 2).forEach((f) => parts.push(<span key={f.key} className={`tone-${f.tone}`} title={f.hint || f.label}>{flagWords(f, cred)}</span>));
  }
  return <span className="cv-l-sub">{parts.map((p, i) => [i > 0 && <span key={`sep${i}`} aria-hidden="true"> - </span>, p])}</span>;
}

function Row({ cred, depts, active, favorite, now, nameOf, done, onOpen, selecting, checked, onCheck, ...actions }) {
  return (
    <div className={`cv-l${active ? " is-active" : ""}`} data-login={cred.id}>
      {selecting && (
        <span className="cv-l-check">
          {cred.canEdit && !cred.deletedAt && <input type="checkbox" className="cv-check" aria-label={`Select ${cred.name}`} checked={checked} onChange={() => onCheck(cred.id)} />}
        </span>
      )}
      <button type="button" className="cv-l-open" onClick={() => onOpen(cred.id)} aria-current={active ? "true" : undefined} aria-label={`${cred.name} details`}>
        <SiteIcon cred={cred} depts={depts} />
        <span className="cv-l-main">
          <span className="cv-l-name"><span>{cred.name}</span>{favorite && <Star size={11} className="cv-prow-star" fill="currentColor" aria-label="Favorite" />}</span>
          <SubLine cred={cred} now={now} nameOf={nameOf} />
        </span>
      </button>
      {!cred.deletedAt && <RowActions cred={cred} done={done} {...actions} />}
    </div>
  );
}

const plural = (n, one, many) => (n === 1 ? one : many);

/** The sentence: each phrase filters the list; the one in force is pressed. */
function Sentence({ counts, view, onView, everyone, waiting, onWaiting }) {
  const phrases = [
    ["all", `${counts.open} you can open`, ""],
    counts.mine > 0 && ["mine", `${counts.mine} yours`, ""],
    counts.shared > 0 && ["shared", `${counts.shared} shared with you`, ""],
    counts.attention > 0 && ["attention", `${counts.attention} ${plural(counts.attention, "needs", "need")} attention`, "tone-bad"],
    counts.nobackup > 0 && ["nobackup", `${counts.nobackup} ${plural(counts.nobackup, "has", "have")} no backup owner`, "tone-warn"],
  ].filter(Boolean);
  if (everyone) phrases[0][1] = `${counts.open} ${plural(counts.open, "login", "logins")}`;
  return (
    <span className="cv-sum-phrases" data-sentence="">
      {phrases.map(([key, words, tone], i) => (
        <span key={key}>
          {i > 0 && <span aria-hidden="true"> - </span>}
          <button type="button" className={`cv-sum-btn ${tone}`} aria-pressed={view === key} onClick={() => onView(view === key ? "all" : key)}>{words}</button>
        </span>
      ))}
      {waiting > 0 && (
        <span>
          <span aria-hidden="true"> - </span>
          <button type="button" className="cv-sum-btn" onClick={onWaiting} title="People asking for a login you own">{waiting} {plural(waiting, "request", "requests")} waiting</button>
        </span>
      )}
    </span>
  );
}

export default function LoginList({
  rows, depts, favorites, recents, query, onQuery, view, onView, sort, onSort, selectedId, now, nameOf, myEmail, done, clipLeft,
  verified = "", everyone = false, waiting = 0, onWaiting, autoFocus = true,
  selecting = false, checked = new Set(), onCheck, onTrashChecked, onDoneSelecting,
  onOpen, onCopyUser, onCopyPassword, onOpenSite, onCopyCode, onRequest, actions = null, children,
}) {
  const [showLocked, setShowLocked] = useState(false);
  const box = useRef(null);
  const counts = sentenceCounts(rows, myEmail);
  const g = listLogins(rows, { view, query, favorites, recents, sort, myEmail, nameOf });
  const shown = g.sections.reduce((n, s) => n + s.rows.length, 0);
  const first = g.sections[0]?.rows[0] || g.locked[0] || null;
  const searching = !!query.trim();
  const lockedOpen = showLocked || searching;
  const sortName = SORTS.find(([k]) => k === sort)?.[1] || "";
  const rowProps = (c) => ({ cred: c, depts, active: selectedId === c.id, favorite: favorites.has(c.id), now, nameOf, done, onOpen,
    selecting, checked: checked.has(c.id), onCheck, onCopyUser, onCopyPassword, onOpenSite, onCopyCode });

  // "/" from anywhere on the page puts the cursor in the search box, the
  // same key Links uses - unless something typed-into already has it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".cv-drawer, .cv-modal-overlay, .modal-overlay")) return;
      e.preventDefault(); box.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="cv-one" data-login-list="">
      {/* One first row: the search, then "+ New" and "..." at its end - not a row of their own above it. */}
      <div className="cv-top">
      <label className="cv-search">
        <Search size={18} aria-hidden="true" />
        <input ref={box} placeholder="Search" aria-label="Search logins" value={query} onChange={(e) => onQuery(e.target.value)} autoFocus={autoFocus}
          onKeyDown={(e) => { if (e.key === "Enter" && first) { e.preventDefault(); onOpen(first.id); } if (e.key === "Escape" && query) { e.stopPropagation(); onQuery(""); } }} />
        {query
          ? <button type="button" className="cv-search-clear" aria-label="Clear search" onClick={() => { onQuery(""); box.current?.focus(); }}><X size={15} /></button>
          : <kbd aria-hidden="true">/</kbd>}
      </label>
      {actions && <div className="cv-top-actions">{actions}</div>}
      </div>

      <div className="cv-sum">
        {selecting ? (
          <span className="cv-sum-phrases" data-selecting="">
            {checked.size} selected
            <span aria-hidden="true"> - </span>
            <button type="button" className="cv-sum-btn tone-bad" disabled={!checked.size} onClick={onTrashChecked}><Trash2 size={12} style={{ verticalAlign: -1 }} /> Move to Trash</button>
            <span aria-hidden="true"> - </span>
            <button type="button" className="cv-sum-btn" onClick={onDoneSelecting}>Done</button>
          </span>
        ) : view === "trash" ? (
          <span className="cv-sum-phrases" data-sentence="">
            <strong>Trash</strong> - {counts.trash} {plural(counts.trash, "login", "logins")}
            <span aria-hidden="true"> - </span>
            <button type="button" className="cv-sum-btn" onClick={() => onView("all")}>Back to All</button>
          </span>
        ) : (
          <Sentence counts={counts} view={view} onView={onView} everyone={everyone} waiting={waiting} onWaiting={onWaiting} />
        )}
        {sort !== "name" && view !== "trash" && !selecting && (
          <span className="cv-sum-note">sorted by {sortName.toLowerCase()} - <button type="button" className="cv-sum-btn" onClick={() => onSort("name")}>Clear</button></span>
        )}
        <span className="cv-sum-side">
          {clipLeft > 0 && <span title="The clipboard is wiped when this reaches zero">Clipboard clears in {clipLeft}s</span>}
          {verified && <span title="Reveals and approvals inside this window do not ask for another code">{verified}</span>}
        </span>
      </div>

      {shown === 0 && !(view === "all" && g.locked.length) && (
        <div className="cv-none">
          <strong>{view === "trash" ? "The trash is empty" : searching ? "No logins match" : view === "shared" ? "Nothing shared with you right now"
            : view === "attention" ? "All clear" : view === "nobackup" ? "Every login has a backup owner" : view === "mine" ? "You do not own a login yet" : "Nothing you can open yet"}</strong>
          <span>{searching ? "Try another name, username, site, owner, department or location."
            : view === "attention" ? "Nothing you can open is weak, reused, overdue or expiring."
              : view === "all" ? "When a login is shared with you or your department, it shows up here." : ""}</span>
        </div>
      )}

      {g.sections.map((s) => (
        <section key={s.key} data-section={s.key}>
          {s.title && <h3 className="cv-sec">{s.title}</h3>}
          {s.rows.map((c) => <Row key={c.id} {...rowProps(c)} />)}
        </section>
      ))}

      {/* Personal - its own section of the same list (PersonalVault), on the whole list only. */}
      <div hidden={view !== "all" || selecting}>{children}</div>

      {g.locked.length > 0 && view === "all" && !selecting && (<>
        <button type="button" className="cv-fold" onClick={() => setShowLocked((v) => !v)} aria-expanded={lockedOpen}>
          {lockedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span><strong>{g.locked.length} more</strong> {plural(g.locked.length, "exists", "exist")} that you cannot open - Not shared with you</span>
          {!lockedOpen && <span className="cv-fold-hint">Ask the owner for timed access</span>}
        </button>
        {lockedOpen && g.locked.map((c) => (
          <div className={`cv-l${selectedId === c.id ? " is-active" : ""}`} key={c.id} data-login={c.id}>
            <button type="button" className="cv-l-open" onClick={() => onOpen(c.id)} aria-label={`${c.name} details`}>
              <SiteIcon cred={c} depts={depts} />
              <span className="cv-l-main">
                <span className="cv-l-name"><span>{c.name}</span></span>
                <span className="cv-l-sub">
                  {[c.dept, `owned by ${nameOf(c.owner)}`, c.access === "view" && c.username && c.username !== "-" ? c.username : "",
                    c.tier && c.tier !== "Standard" ? c.tier : "", ACCESS_LABEL[c.access]].filter(Boolean).join(" - ")}
                </span>
              </span>
            </button>
            <span className="cv-l-acts">
              <button type="button" className="cv-l-btn" onClick={() => onRequest(c)} aria-label={`Request access to ${c.name}`}><Send size={13} /> Request Access</button>
            </span>
          </div>
        ))}
      </>)}
    </div>
  );
}
