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
//   - On a computer the row's facts line up as a register - Login, Username,
//     Department, Owner, Status - under one quiet heading row whose names sort
//     the list (the same sorts as "..."); a narrow window and a phone run the
//     same facts together as the row's second line (Pranshu, 11/25/2026). There
//     User, Password and Code are their icons alone, named on hover, so the
//     Status column keeps its room.
//   - On a computer the views stand on the left (Pranshu, 11/26/2026 - to be
//     shown to Neil before it merges, since it stands beside "the sentence is
//     the menu"): the sentence's phrases as a standing list, then every
//     department with its count. One is in force at a time; the search looks
//     inside it. A narrow window and a phone keep the sentence.
//   - On a computer Personal is a button beside the list's title, not a folded
//     line under the last row (Pranshu, 11/26/2026): pressed, the list shows
//     the Personal section alone (it unlocks first); pressed again, or a view
//     picked, brings the company logins back. A narrow window and a phone keep
//     the folded line at the foot of the list.
// The screen (CredentialVaultApp) owns the data and every gated call; this
// file lays the list out.
import { useEffect, useRef, useState } from "react";
import { Search, X, Star, Copy, Check, KeyRound, ExternalLink, ChevronDown, ChevronRight, Send, ShieldCheck, Trash2, User, Lock } from "lucide-react";
import { ACCESS_LABEL, flagWords, healthFlags, listLogins, sentenceCounts, siteOf, timeLeft, SORTS } from "./vaultModel";
import { Monogram } from "./vaultCards";

/** The site's own icon when the row has a link, else the department monogram. */
export function SiteIcon({ cred, depts, size = 28 }) {
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
          {ok("u") ? <Check size={13} /> : <User size={13} />} <span className="cv-l-word">User</span>
        </button>
      )}
      {/* With a site, Password is one of the quiet extras and Open leads; with none, copying the password is the row's one button. */}
      {site && (
        <button type="button" className={`cv-l-btn is-x${ok("p") ? " is-done" : ""}`} title="Copy the password (logged)" aria-label={`Copy password for ${cred.name}`} onClick={() => onCopyPassword(cred)}>
          {ok("p") ? <Check size={13} /> : <KeyRound size={13} />} <span className="cv-l-word">Password</span>
        </button>
      )}
      {cred.hasTotp && (
        <button type="button" className={`cv-l-btn is-x${ok("t") ? " is-done" : ""}`} title="Copy the current authenticator code" aria-label={`Copy code for ${cred.name}`} onClick={() => onCopyCode(cred)}>
          {ok("t") ? <Check size={13} /> : <ShieldCheck size={13} />} <span className="cv-l-word">Code</span>
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

/** The row's facts, a cell each: the register's columns on a computer, one
 *  running second line on a narrow window. `narrow` = said on that line too. */
function Cells({ cred, now, nameOf, myEmail = "", locked = false }) {
  const user = cred.username && cred.username !== "-" ? cred.username : "";
  const owner = cred.owner ? nameOf(cred.owner) : "";
  const mine = !!myEmail && (cred.owner || "").toLowerCase() === myEmail.toLowerCase();
  const state = [];
  if (cred.tier && cred.tier !== "Standard") state.push({ key: "t", text: cred.tier, hint: cred.tier === "Critical" ? "Critical: only named people open it" : "High: closely guarded" });
  if (locked) { if (ACCESS_LABEL[cred.access]) state.push({ key: "a", text: ACCESS_LABEL[cred.access] }); }
  else if (cred.deletedAt) state.push({ key: "x", text: "in the trash", tone: "bad" });
  else {
    if (cred.access === "shared" && cred.grantUntil) state.push({ key: "g", text: `shared with you, ${timeLeft(cred.grantUntil - now)} left` });
    if (cred.access === "person") state.push({ key: "p", text: `shared with you by ${owner}` });
    if (cred.canReveal) healthFlags(cred).slice(0, 2).forEach((f) => state.push({ key: f.key, text: flagWords(f, cred), tone: f.tone, hint: f.hint || f.label }));
  }
  const dept = [cred.dept, !locked && cred.siteName].filter(Boolean).join(" - ");
  const cells = [
    { key: "user", narrow: true, title: user, body: locked ? (cred.access === "view" ? user : "") : user || siteOf(cred.url) || "" },
    { key: "dept", narrow: true, title: dept, body: dept },
    // The owner is its own column on a computer; a narrow row names the owner only where you have to ask them.
    { key: "owner", narrow: locked, title: owner, body: !owner ? "" : locked ? <><span className="cv-narrow">owned by </span>{owner}</> : mine ? "You" : owner },
    { key: "state", narrow: true, title: state.map((p) => p.text).join(" - "),
      body: state.length ? state.map((p, i) => [i > 0 && <span key={`sep${i}`} aria-hidden="true"> - </span>,
        <span key={p.key} className={p.tone ? `tone-${p.tone}` : undefined} title={p.hint}>{p.text}</span>]) : "" },
  ];
  const firstSaid = cells.find((c) => c.narrow && c.body);
  return (
    <span className="cv-l-sub cv-l-cells">
      {cells.map((c) => [
        c.narrow && c.body && c !== firstSaid && <span key={`${c.key}-sep`} className="cv-sep" aria-hidden="true"> - </span>,
        <span key={c.key} className={`cv-c cv-c-${c.key}${c.narrow ? "" : " cv-wide"}`} title={c.title || undefined}>{c.body}</span>,
      ])}
    </span>
  );
}

/** The register's heading row (computers only): a name sorts by its column. */
const COLUMNS = [["name", "Login"], ["", "Username"], ["dept", "Department"], ["owner", "Owner"], ["health", "Status"]];
function Head({ sort, onSort, selecting }) {
  return (
    <div className="cv-head" data-head="">
      {selecting && <span className="cv-l-check" />}
      <span className="cv-head-cols">
        {COLUMNS.map(([key, label]) => (key
          ? <button key={label} type="button" className="cv-head-btn" aria-pressed={sort === key} title={`Sort by ${label.toLowerCase()}`} onClick={() => onSort(sort === key ? "name" : key)}>{label}{sort === key && <ChevronDown size={12} aria-hidden="true" />}</button>
          : <span key={label}>{label}</span>))}
      </span>
      <span className="cv-head-acts" />
    </div>
  );
}

function Row({ cred, depts, active, favorite, now, nameOf, myEmail, done, onOpen, selecting, checked, onCheck, ...actions }) {
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
          <Cells cred={cred} now={now} nameOf={nameOf} myEmail={myEmail} />
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
    <span className="cv-sum-phrases cv-narrow" data-sentence="">
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

const VIEWS = [["all", "All Logins"], ["mine", "Mine"], ["shared", "Shared With Me"], ["attention", "Needs Attention"], ["nobackup", "No Backup Owner"]];
const VIEW_TONE = { attention: "tone-bad", nobackup: "tone-warn" };

/** The views on the left (computers): the sentence's phrases as a standing
 *  list, then each department. One is in force at a time. */
function Rail({ counts, depts, view, dept, onView, onDept, waiting, onWaiting }) {
  const n = { all: counts.open, mine: counts.mine, shared: counts.shared, attention: counts.attention, nobackup: counts.nobackup };
  const item = (key, label, count, tone, on, pick) => (
    <button key={key} type="button" className="cv-rail-item" aria-current={on ? "true" : undefined} onClick={pick}>
      <span className="cv-rail-name">{label}</span>
      <span className={`cv-rail-n ${count > 0 ? tone : ""}`}>{count}</span>
    </button>
  );
  return (
    <nav className="cv-rail" aria-label="Views" data-rail="">
      {VIEWS.map(([key, label]) => item(key, label, n[key], VIEW_TONE[key] || "", view === key && !dept, () => onView(key)))}
      {waiting > 0 && item("waiting", "Requests Waiting", waiting, "", false, onWaiting)}
      {depts.length > 0 && <p className="cv-rail-label">Departments</p>}
      {depts.map(([d, count]) => item(`d:${d}`, d, count, "", dept === d, () => onDept(d)))}
    </nav>
  );
}

export default function LoginList({
  rows, depts, favorites, recents, query, onQuery, view, onView, sort, onSort, selectedId, now, nameOf, myEmail, done, clipLeft,
  verified = "", everyone = false, waiting = 0, onWaiting, autoFocus = true,
  selecting = false, checked = new Set(), onCheck, onTrashChecked, onDoneSelecting,
  onOpen, onCopyUser, onCopyPassword, onOpenSite, onCopyCode, onRequest, actions = null, children,
  personalSignal = 0, onPersonal,
}) {
  const [showLocked, setShowLocked] = useState(false);
  const box = useRef(null);
  const counts = sentenceCounts(rows, myEmail);
  // The rail's department: one more way to narrow the whole list. A view picked
  // anywhere else ("...", a link, the sentence) takes its place.
  const [dept, setDept] = useState("");
  if (dept && view !== "all") setDept("");
  const deptCounts = new Map();
  rows.forEach((c) => { if (!c.deletedAt && c.canReveal && c.dept) deptCounts.set(c.dept, (deptCounts.get(c.dept) || 0) + 1); });
  const railDepts = [...deptCounts].sort((a, b) => a[0].localeCompare(b[0]));
  const deptOn = view === "all" && deptCounts.has(dept) ? dept : "";
  // Personal, on a computer: the button beside the title shows that section
  // alone. "+ New > Personal Login" and a link to Personal (personalSignal) turn
  // it on too; a view picked anywhere turns it off.
  const [personalOn, setPersonalOn] = useState(false);
  const [seenPersonal, setSeenPersonal] = useState(0);
  if (personalSignal !== seenPersonal) { setSeenPersonal(personalSignal); setPersonalOn(true); }
  if (personalOn && view !== "all") setPersonalOn(false);
  const personalShown = personalOn && view === "all" && !selecting;
  const pickView = (key) => { setDept(""); setPersonalOn(false); onView(key); };
  const pickDept = (d) => { setDept(d); setPersonalOn(false); if (view !== "all") onView("all"); };
  const togglePersonal = () => {
    if (personalShown) { setPersonalOn(false); return; }
    setDept(""); if (view !== "all") onView("all");
    setPersonalOn(true); onPersonal?.();
  };
  const title = deptOn || VIEWS.find(([k]) => k === view)?.[1] || "";
  const g = listLogins(deptOn ? rows.filter((c) => c.dept === deptOn) : rows, { view, query, favorites, recents, sort, myEmail, nameOf });
  const shown = g.sections.reduce((n, s) => n + s.rows.length, 0);
  const first = g.sections[0]?.rows[0] || g.locked[0] || null;
  const searching = !!query.trim();
  const lockedOpen = showLocked || searching;
  const sortName = SORTS.find(([k]) => k === sort)?.[1] || "";
  const rowProps = (c) => ({ cred: c, depts, active: selectedId === c.id, favorite: favorites.has(c.id), now, nameOf, myEmail, done, onOpen,
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
      <Rail counts={counts} depts={railDepts} view={personalShown ? "" : view} dept={deptOn} onView={pickView} onDept={pickDept} waiting={waiting} onWaiting={onWaiting} />
      <div className="cv-main">
      {/* One first row: the search, then "+ New" and "..." at its end - not a row of their own above it. */}
      <div className="cv-top">
      <label className="cv-search">
        <Search size={16} aria-hidden="true" />
        <input ref={box} placeholder="Search name, username, site, owner or department" aria-label="Search logins" value={query} onChange={(e) => onQuery(e.target.value)} autoFocus={autoFocus}
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
        ) : (<>
          <span className="cv-sum-title" data-title="">{personalShown
            ? <><strong>Personal</strong> - private to you</>
            : <><strong>{title}</strong> - {shown} {plural(shown, "login", "logins")}</>}</span>
          <button type="button" className="cv-l-btn cv-personal-btn" aria-pressed={personalShown} onClick={togglePersonal}
            title="Your own passwords, private to you. No admin or teammate can see them."><Lock size={13} aria-hidden="true" /> Personal</button>
          <Sentence counts={counts} view={view} onView={pickView} everyone={everyone} waiting={waiting} onWaiting={onWaiting} />
          {deptOn && <span className="cv-sum-note cv-narrow">{deptOn} only - <button type="button" className="cv-sum-btn" onClick={() => setDept("")}>Show All</button></span>}
        </>)}
        {sort !== "name" && view !== "trash" && !selecting && (
          <span className="cv-sum-note">sorted by {sortName.toLowerCase()} - <button type="button" className="cv-sum-btn" onClick={() => onSort("name")}>Clear</button></span>
        )}
        <span className="cv-sum-side">
          {clipLeft > 0 && <span title="The clipboard is wiped when this reaches zero">Clipboard clears in {clipLeft}s</span>}
          {verified && <span title="Reveals and approvals inside this window do not ask for another code">{verified}</span>}
        </span>
      </div>

      <div className={`cv-company${personalShown ? " is-off" : ""}`}>
      {shown === 0 && !(view === "all" && g.locked.length) && (
        <div className="cv-none">
          <strong>{view === "trash" ? "The trash is empty" : searching ? "No logins match" : view === "shared" ? "Nothing shared with you right now"
            : view === "attention" ? "All clear" : view === "nobackup" ? "Every login has a backup owner" : view === "mine" ? "You do not own a login yet" : "Nothing you can open yet"}</strong>
          <span>{searching ? "Try another name, username, site, owner, department or location."
            : view === "attention" ? "Nothing you can open is weak, reused, overdue or expiring."
              : view === "all" ? "When a login is shared with you or your department, it shows up here." : ""}</span>
        </div>
      )}

      {(shown > 0 || (g.locked.length > 0 && view === "all")) && <Head sort={sort} onSort={onSort} selecting={selecting} />}

      {g.sections.map((s) => (
        <section key={s.key} data-section={s.key}>
          {s.title && <h3 className="cv-sec">{s.title}</h3>}
          {s.rows.map((c) => <Row key={c.id} {...rowProps(c)} />)}
        </section>
      ))}

      </div>

      {/* Personal - its own section of the same list (PersonalVault), on the whole list only. */}
      <div className={`cv-personal-slot${personalShown ? " is-on" : ""}`} hidden={view !== "all" || selecting || !!deptOn}>{children}</div>

      <div className={`cv-company${personalShown ? " is-off" : ""}`}>
      {g.locked.length > 0 && view === "all" && !selecting && (<>
        <button type="button" className="cv-fold" onClick={() => setShowLocked((v) => !v)} aria-expanded={lockedOpen}>
          {lockedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span><strong>{g.locked.length} more</strong> {plural(g.locked.length, "exists", "exist")} that you cannot open - Not shared with you</span>
          {!lockedOpen && <span className="cv-fold-hint">Ask the owner for timed access</span>}
        </button>
        {lockedOpen && g.locked.map((c) => (
          <div className={`cv-l is-locked${selectedId === c.id ? " is-active" : ""}`} key={c.id} data-login={c.id}>
            <button type="button" className="cv-l-open" onClick={() => onOpen(c.id)} aria-label={`${c.name} details`}>
              <SiteIcon cred={c} depts={depts} />
              <span className="cv-l-main">
                <span className="cv-l-name"><span>{c.name}</span></span>
                <Cells cred={c} now={now} nameOf={nameOf} locked />
              </span>
            </button>
            <span className="cv-l-acts">
              <button type="button" className="cv-l-btn" onClick={() => onRequest(c)} aria-label={`Request access to ${c.name}`}><Send size={13} /> Request Access</button>
            </span>
          </div>
        ))}
      </>)}
      </div>
      </div>
    </div>
  );
}
