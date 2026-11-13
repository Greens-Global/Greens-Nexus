// The department head's code (Pranshu, 11/13/2026, backend vault_head.py): a
// change to a login - add, edit, trash, recover, delete, import, hand over -
// waits for a code the head of its department receives (email and bell).
// The server answers `head_code_required` with the departments and their
// heads; this card sends the code to them and takes it back, one department
// at a time, then the change runs again. It is a question, so a centered card.
import { useState } from "react";
import { KeyRound, Send } from "lucide-react";
import { api } from "../api";
import { Modal } from "../tasks/components";

const where = (sc) => `${sc.dept || "every department"}${sc.company ? ` at ${sc.company}` : ""}`;

export default function HeadCodeModal({ scopes, action, onDone, onCancel }) {
  const [i, setI] = useState(0);
  const [sent, setSent] = useState(null);       // { challengeId, sentTo, devCode }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sc = scopes[i];
  const who = (sent?.sentTo || sc.heads || []).join(" or ") || "a Super Administrator";

  function next() {
    setSent(null); setCode(""); setError("");
    if (i + 1 < scopes.length) setI(i + 1); else onDone();
  }
  async function send() {
    setBusy(true); setError("");
    try {
      const r = await api.cvHeadCodeRequest({ companyId: sc.companyId, dept: sc.dept, action });
      if (r?.exempt) next(); else setSent(r);
    } catch (e) { setError(e?.message || "Could not send the code."); }
    setBusy(false);
  }
  async function verify() {
    if (!sent || code.trim().length < 6) return;
    setBusy(true); setError("");
    try { await api.cvHeadCodeVerify({ challengeId: sent.challengeId, code: code.trim(), companyId: sc.companyId, dept: sc.dept }); next(); }
    catch (e) { setError(e?.message || "That code did not work."); }
    setBusy(false);
  }

  return (
    <Modal title="Department Head's OK" onClose={onCancel} placement="center" width="clamp(380px, 36vw, 520px)" minHeight="auto" zIndex={4600}
      footer={<>
        {error && <span style={{ color: "var(--cv-bad)", fontSize: 13, marginRight: "auto" }} role="alert">{error}</span>}
        <button type="button" className="cv-btn" onClick={onCancel}>Cancel</button>
        {sent
          ? <button type="button" className="cv-btn-dark" onClick={verify} disabled={busy || code.trim().length < 6}>{busy ? "Checking…" : "Confirm Code"}</button>
          : <button type="button" className="cv-btn-dark" onClick={send} disabled={busy}><Send size={14} /> {busy ? "Sending…" : "Send Code"}</button>}
      </>}>
      <div className="cv-root" style={{ gap: 12, animation: "none" }} data-head-code={sc.dept}>
        {scopes.length > 1 && <p className="cv-hint">Department {i + 1} of {scopes.length}</p>}
        {!sent ? (
          <p style={{ margin: 0 }}>
            Changing logins in <b>{where(sc)}</b> needs a code from <b>{who}</b>{sc.fallback ? " (no department head is set, so it goes to the Super Administrators)" : ""}.
            We send it to them by email and bell; they give it to you if they agree.
          </p>
        ) : (<>
          <p style={{ margin: 0 }}>Code sent to <b>{who}</b>. Ask them for it and type it here - it works for 10 minutes, and then covers your changes in {where(sc)} for 10 minutes.</p>
          <label style={{ display: "block" }}>
            <span className="cv-label">Code</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 5 }}>
              <KeyRound size={15} style={{ opacity: 0.6 }} />
              <input className="cv-ipt" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") verify(); }}
                aria-label="Code from the department head" placeholder="6 digits" />
            </span>
          </label>
          {sent.devCode && <p className="cv-hint">Local test: the code is {sent.devCode}.</p>}
          <button type="button" className="cv-link" onClick={send} disabled={busy}>Send Again</button>
        </>)}
      </div>
    </Modal>
  );
}
