// Passwords - the two lists that used to be tabs, as sheets from the right
// (Neil, 11/18/2026):
//   ActivitySheet  - "..." > Activity: who opened, copied, shared or changed
//                    what, with the same search, action and date filters and
//                    20 a page. A row opens its login.
//   RequestsSheet  - people asking for a login the caller owns. Inside Nexus
//                    these are decided in Dashboard > Approvals (one inbox);
//                    this sheet is for an outside guest, who has no Dashboard.
import { useEffect, useRef, useState } from "react";
import { X, Search, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import { useDialogFocus, trapTab } from "../lib/useDialogFocus";
import { formatDateTime } from "../lib/datetime";
import { DateField } from "../tasks/components";
import { agoLabel, actionTone, Pager } from "./vaultShared";
import { logMatches } from "./vaultModel";
import { Monogram } from "./vaultCards";

const LOG_ACTIONS = ["All", "Revealed", "Copied", "Created", "Edited", "Shared", "Requested", "Denied", "Revoked", "Transferred", "Removed", "Recovered", "Imported", "Offboarded"];
const LOG_PAGE = 20;           // Activity rows per page (Pranshu, Oct 29 2026)

function Sheet({ title, meta, onClose, children }) {
  const panel = useRef(null);
  useDialogFocus(panel);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".cv-modal-overlay, .nx-overlay")) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="cv-drawer-overlay" onMouseDown={onClose} />
      <aside className="cv-drawer cv-root" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1} onKeyDown={trapTab}>
        <div className="cv-drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}><h3>{title}</h3>{meta && <p className="cv-detail-words">{meta}</p>}</div>
          <button type="button" className="cv-iconbtn" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="cv-drawer-body is-plain">{children}</div>
      </aside>
    </>
  );
}

export function ActivitySheet({ logs, canOpen, onOpen, onClose }) {
  const [filter, setFilter] = useState({ query: "", action: "All", from: "", to: "" });
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [filter]);
  const visible = logs.filter((e) => logMatches(e, filter));
  const pages = Math.max(1, Math.ceil(visible.length / LOG_PAGE));
  const paged = visible.slice((page - 1) * LOG_PAGE, page * LOG_PAGE);
  return (
    <Sheet title="Activity" meta={`${visible.length} ${visible.length === 1 ? "entry" : "entries"}`} onClose={onClose}>
      <div className="cv-act-filters">
        <label className="search-bar cv-dir-search">
          <Search size={13} style={{ flexShrink: 0 }} />
          <input placeholder="Search activity…" aria-label="Search activity" value={filter.query} onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} />
        </label>
        <select className="form-input cv-dir-select" value={filter.action} onChange={(e) => setFilter((f) => ({ ...f, action: e.target.value }))} aria-label="Action">{LOG_ACTIONS.map((a) => <option key={a} value={a}>{a === "All" ? "All Actions" : a}</option>)}</select>
        {/* The house date box, not the browser's (a phone drew its own mm/dd/yyyy). */}
        <span className="form-input cv-dir-date"><DateField value={filter.from} onChange={(v) => setFilter((f) => ({ ...f, from: v || "" }))} placeholder="From" title="From" max={filter.to || ""} /></span>
        <span className="form-input cv-dir-date"><DateField value={filter.to} onChange={(v) => setFilter((f) => ({ ...f, to: v || "" }))} placeholder="To" title="To" min={filter.from || ""} /></span>
      </div>
      {visible.length === 0 && <div className="cv-none"><strong>No activity matches</strong><span>Try another person, login, action or date range.</span></div>}
      <div className="cv-divide">
        {paged.map((e) => {
          const linked = e.credId && canOpen(e.credId);
          return (
            <div key={e.id} className={`cv-log-row${linked ? " is-link" : ""}`} onClick={() => linked && onOpen(e.credId)}
              role={linked ? "button" : undefined} tabIndex={linked ? 0 : undefined} onKeyDown={(k) => { if (linked && (k.key === "Enter" || k.key === " ")) { k.preventDefault(); onOpen(e.credId); } }}>
              <span className="cv-avatar">{(e.actor || "?").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div><b style={{ fontWeight: 600 }}>{e.actor}</b> <span style={actionTone(e.action)}>{e.action}</span> <span style={{ color: "var(--text-secondary)" }}>{e.cred}</span></div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
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
      <Pager page={page} pages={pages} total={visible.length} size={LOG_PAGE} onPage={setPage} />
    </Sheet>
  );
}

export function RequestsSheet({ requests, depts, nameOf, onApprove, onDeny, onClose }) {
  return (
    <Sheet title="Requests" meta={`${requests.length} waiting`} onClose={onClose}>
      {requests.length === 0 && <div className="cv-none"><strong>No requests waiting</strong><span>When someone asks for a login you own, it shows up here.</span></div>}
      {requests.map((r) => (
        <div key={r.id} className="cv-req">
          <Monogram name={r.cred} dept={r.dept} depts={depts} size={36} />
          <div className="cv-req-main">
            <b>{r.cred}</b>
            <p><strong>{r.requestedBy}</strong> asks for {r.duration.toLowerCase()} of access - {r.dept} - {agoLabel(r.ts)}{r.sharedToEmail && r.sharedToEmail !== r.requestedByEmail ? ` - for ${nameOf(r.sharedToEmail)}` : ""}</p>
          </div>
          <div className="cv-req-actions">
            <button type="button" className="secondary-btn cv-danger-text" onClick={() => onDeny(r)}><XCircle size={14} /> Decline</button>
            <button type="button" className="primary-btn" onClick={() => onApprove(r)}><CheckCircle2 size={14} /> Approve</button>
          </div>
        </div>
      ))}
    </Sheet>
  );
}
