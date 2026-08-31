/* Credential Vault - shared building blocks and modals.
   1:1 port of the standalone credential-vault-dev app's components, translated
   from Tailwind to the Nexus inline-style idiom + the scoped credvault.css. */
import React, { useState, useRef, useMemo, useEffect } from "react";
import {
  ShieldCheck, Eye, EyeOff, Copy, Check, X, RefreshCw, Users,
  Building2, Calculator, HardHat, Landmark, Server, Activity, Lock,
  CheckCircle2, XCircle, Settings, Trash2, Upload, Download,
  AlertCircle, User, Shuffle, Pencil, MessageCircle, Share2, Bell,
  ChevronDown, Mail, KeyRound,
} from "lucide-react";
import { api } from "../api";
import { usePeopleDirectory } from "../lib/queries";
import { matchPeople } from "../lib/peopleSearch";

// ---------- Config ----------
export const DEPT_ICONS = {
  Accounting: Calculator, HR: Users, Operations: Activity, Administration: Building2,
  "Real Estate Development": Landmark, Construction: HardHat, IT: Server,
};
export const iconFor = (n) => DEPT_ICONS[n] || Building2;
export const DEFAULT_DEPTS = Object.keys(DEPT_ICONS);
export const TIERS = ["Standard", "High", "Critical"];
export const TYPES = ["Password", "API key", "Access key", "Certificate"];

// Fixed vault policy (the standalone app's ManagePanel settings sections were
// already removed upstream - these are its shipped defaults).
export const SETTINGS = {
  revealSeconds: 30, rotationDays: 90,
  requireApprovalCritical: true, breachScan: true, logRetentionDays: 365,
};

export const evalStrength = (pwd) => {
  if (!pwd) return "weak";
  const s = (pwd.length >= 12 ? 1 : 0) + (/[A-Z]/.test(pwd) ? 1 : 0) + (/[0-9]/.test(pwd) ? 1 : 0) + (/[^A-Za-z0-9]/.test(pwd) ? 1 : 0);
  return s >= 3 ? "strong" : s >= 2 ? "fair" : "weak";
};

export function generatePassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

export const tierStyle = (t) =>
  t === "Critical" ? { background: "var(--cv-rose-bg)", color: "var(--cv-rose)", border: "1px solid var(--cv-rose-line)" }
  : t === "High"   ? { background: "var(--cv-amber-bg)", color: "var(--cv-amber)", border: "1px solid var(--cv-amber-line)" }
  : { background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-color)" };

const ACTION_COLORS = {
  Revealed: "amber", Copied: "sky", Shared: "emerald", Edited: "violet",
  Created: "indigo", Imported: "indigo", Recovered: "emerald", Rotated: "emerald",
  Removed: "rose", Requested: null, Denied: "rose",
};
export const actionStyle = (a) => {
  const c = ACTION_COLORS[a];
  return c
    ? { background: `var(--cv-${c}-bg)`, color: `var(--cv-${c})` }
    : { background: "var(--bg-secondary)", color: "var(--text-secondary)" };
};

// CSV helpers (ported verbatim)
function splitCSVLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else { if (ch === ",") { out.push(cur); cur = ""; } else if (ch === '"') q = true; else cur += ch; }
  }
  out.push(cur); return out;
}
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => { const cells = splitCSVLine(line); const o = {}; header.forEach((h, i) => (o[h] = (cells[i] || "").trim())); return o; });
}
export const CSV_TEMPLATE = `name,department,type,username,secret,tier
"QuickBooks Online",Accounting,Password,finance@greensglobal.com,ChangeMe123!,Critical
"Procore",Construction,Password,project-controls,ChangeMe123!,High
"Razorpay API Key",Accounting,API key,rzp_live_xxx,ChangeMe123!,High`;

export function agoLabel(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------- Small components ----------
export const Dot = ({ color, title }) => (
  <span title={title} style={{ display: "inline-block", height: 8, width: 8, borderRadius: "50%", flexShrink: 0, background: color }} />
);

export const Empty = ({ children }) => (
  <div style={{ borderRadius: 16, border: "1px dashed var(--border-color)", background: "var(--bg-card)", padding: 40, textAlign: "center", color: "var(--text-secondary)", fontSize: 14 }}>{children}</div>
);

export function Dropdown({ open, onToggle, trigger, children, width = 240 }) {
  const ref = useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onToggle(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onToggle]);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button onClick={onToggle} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>{trigger}</button>
      {open && <div className="cv-dropdown" style={{ width }}>{children}</div>}
    </div>
  );
}

// `isDirty` + `onSave`: closing via the backdrop, Escape, or the X button used
// to discard an in-progress form with no warning - with isDirty set, those
// three now confirm first. A form's own Cancel button still discards straight
// away, since that's a deliberate choice.
export function Modal({ children, onClose, wide, maxWidth, isDirty = false, onSave }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestClose = () => { if (isDirty) setConfirming(true); else onClose(); };
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isDirty]);
  const saveAndClose = async () => {
    if (!onSave) { setConfirming(false); onClose(); return; }
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); setConfirming(false); }
  };
  return (
    <div className="cv-modal-overlay">
      <div className="cv-modal-backdrop" onClick={requestClose} />
      {/* maxWidth: an explicit override for the genuine content forms (Add/Edit/
          Import/Request Access) to size to ~60% of the viewport - left unset for
          the small confirm/OTP/lock-gate steps, which stay at the compact
          430px/660px CSS defaults on purpose. */}
      <div className={`cv-modal cv-root${wide ? " cv-modal-wide" : ""}`} style={maxWidth ? { maxWidth } : undefined}>
        <button onClick={requestClose} className="cv-modal-close"><X size={19} /></button>
        {children}
      </div>
      {confirming && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,.25)" }}>
          <div className="cv-modal cv-root" style={{ maxWidth: 340, padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 18 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button className="cv-btn" onClick={() => setConfirming(false)}>Keep Editing</button>
              <button className="cv-btn" onClick={onClose}>Discard</button>
              {onSave && (
                <button className="cv-btn-dark" onClick={saveAndClose} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Field = ({ label, required, children }) => (
  <label style={{ display: "block" }}>
    <span className="cv-label" style={{ marginBottom: 0 }}>{label}{required && <span style={{ color: "var(--cv-rose)", marginLeft: 2 }}>*</span>}</span>
    <div style={{ marginTop: 5 }}>{children}</div>
  </label>
);

export function ModalHeader({ icon, tint, title, subtitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
      <div style={{ height: 40, width: 40, borderRadius: 12, background: `var(--cv-${tint}-bg)`, display: "flex", alignItems: "center", justifyContent: "center", color: `var(--cv-${tint})`, flexShrink: 0 }}>{icon}</div>
      <div>
        <h3 style={{ fontWeight: 600, fontSize: 15.5, margin: 0 }}>{title}</h3>
        {subtitle && <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "2px 0 0" }}>{subtitle}</p>}
      </div>
    </div>
  );
}

export function Toggle({ on, onChange }) {
  return (
    <button className={`cv-toggle ${on ? "on" : "off"}`} onClick={() => onChange(!on)}><span className="knob" /></button>
  );
}

export function TeamsIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect x="50" y="38" width="19" height="27" rx="9.5" fill="#4B53BC" />
      <circle cx="59" cy="24" r="7" fill="#4B53BC" />
      <rect x="28" y="33" width="23" height="32" rx="11.5" fill="#7B83EB" />
      <circle cx="39" cy="21" r="11" fill="#7B83EB" />
      <rect x="14" y="27" width="32" height="31" rx="5" fill="#5059C9" />
      <rect x="18.5" y="33.5" width="23" height="5.5" rx="2.75" fill="white" />
      <rect x="27.25" y="39" width="6.5" height="15" rx="2.75" fill="white" />
    </svg>
  );
}

export const MsLogo = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 23 23" fill="none">
    <path d="M1 1h10v10H1z" fill="#F25022" /><path d="M12 1h10v10H12z" fill="#7FBA00" />
    <path d="M1 12h10v10H1z" fill="#00A4EF" /><path d="M12 12h10v10H12z" fill="#FFB900" />
  </svg>
);

export function SecretControls({ c, state, onReveal, onCopy, copiedId, onDelete, onEdit, onRequestAccess }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {!state.isOpen && (
        <button onClick={() => onReveal(c)} title={state.lockedForRole ? "Request access" : "Reveal"} className="cv-iconbtn">
          {state.lockedForRole ? <Lock size={14} /> : <Eye size={14} />}
        </button>
      )}
      {state.isOpen && (
        <button onClick={() => onCopy(c)} title="Copy" className="cv-iconbtn">
          {copiedId === c.id ? <Check size={14} style={{ color: "var(--cv-emerald)" }} /> : <Copy size={14} />}
        </button>
      )}
      {onRequestAccess && <button onClick={onRequestAccess} title="Request access" className="cv-iconbtn cv-hover-violet"><Share2 size={14} /></button>}
      {onEdit && <button onClick={onEdit} title="Edit" className="cv-iconbtn cv-hover-sky"><Pencil size={14} /></button>}
      {onDelete && <button onClick={onDelete} title="Remove" className="cv-iconbtn cv-hover-rose"><Trash2 size={14} /></button>}
    </div>
  );
}

export function StatPill({ icon, value, label, warn, onClick, active }) {
  return (
    <button onClick={onClick} disabled={!onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 10, borderRadius: 12, padding: "8px 12px",
        boxShadow: "var(--shadow-sm)", cursor: onClick ? "pointer" : "default", fontFamily: "inherit",
        background: active ? "var(--cv-rose-bg)" : "var(--bg-card)",
        border: `1px solid ${active || warn ? "var(--cv-rose-line)" : "var(--border-color)"}`,
      }}>
      <span style={{ height: 32, width: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: active || warn ? "var(--cv-rose-bg)" : "var(--bg-secondary)", color: active || warn ? "var(--cv-rose)" : "var(--text-secondary)" }}>{icon}</span>
      <span style={{ textAlign: "left" }}>
        <span style={{ display: "block", fontSize: 17, fontWeight: 700, lineHeight: 1, color: active || warn ? "var(--cv-rose)" : "var(--text-primary)" }}>{value}</span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)", marginTop: 3 }}>{label}</span>
      </span>
    </button>
  );
}

export function ViewBtn({ active, onClick, title, children }) {
  return (
    <button onClick={onClick} title={title} style={{
      height: 30, width: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
      border: "none", cursor: "pointer", fontFamily: "inherit",
      background: active ? "var(--text-primary)" : "transparent",
      color: active ? "var(--bg-card)" : "var(--text-secondary)",
    }}>{children}</button>
  );
}

export function Select({ value, onChange, options, icon, label }) {
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <span style={{ position: "absolute", left: 10, color: "var(--text-muted)", pointerEvents: "none", display: "flex" }}>{icon}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: "none", borderRadius: 12, border: "1px solid var(--border-color)", background: "var(--bg-card)",
          color: "var(--text-primary)", padding: "7px 26px 7px 32px", fontSize: 13.5, fontWeight: 500,
          fontFamily: "inherit", outline: "none", cursor: "pointer",
        }}>
        {options.map((o) => <option key={o} value={o}>{o === "All" ? (label || "All") : o}</option>)}
      </select>
      <ChevronDown size={14} style={{ color: "var(--text-muted)", position: "absolute", right: 8, pointerEvents: "none" }} />
    </div>
  );
}

export function ResizeHandle({ colIndex, colWidths, setColWidths }) {
  const startRef = useRef(null);
  function onMouseDown(e) {
    e.preventDefault();
    const container = e.currentTarget.closest("[data-table-container]");
    const containerW = container ? container.offsetWidth : 900;
    const totalFr = colWidths.reduce((a, b) => a + b, 0);
    startRef.current = { x: e.clientX, weights: [...colWidths], containerW, totalFr };
    function onMove(ev) {
      if (!startRef.current) return;
      const { x, weights: sw, containerW: cw, totalFr: tf } = startRef.current;
      const dFr = ((ev.clientX - x) / cw) * tf;
      const minFr = tf * 0.06;
      setColWidths(() => {
        const next = [...sw];
        next[colIndex] = Math.max(minFr, sw[colIndex] + dFr);
        if (colIndex + 1 < next.length) {
          const pair = sw[colIndex] + sw[colIndex + 1];
          next[colIndex + 1] = Math.max(minFr, pair - next[colIndex]);
        }
        return next;
      });
    }
    function onUp() { startRef.current = null; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  return (
    <div onMouseDown={onMouseDown} style={{ position: "absolute", right: 0, top: 0, height: "100%", width: 14, display: "flex", alignItems: "center", justifyContent: "center", cursor: "col-resize", zIndex: 10, userSelect: "none" }}>
      <div style={{ width: 2, height: "70%", background: "var(--border-color)", borderRadius: 999 }} />
    </div>
  );
}

const rowBetween = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 };
const rowSplit = { display: "flex", justifyContent: "space-between", gap: 8, marginTop: 16 };
const infoBox = { borderRadius: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-color)", padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)" };
const codeInput = { textAlign: "center", fontSize: 19, letterSpacing: "0.4em" };

// Standalone SMS consent checkbox (unchecked by default) - required before the
// SMS OTP channel can be used. Carrier/TCPA compliance: separate from the
// "Authenticate via SMS" action itself, not implied by clicking it.
function SmsConsent({ checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 10px", borderRadius: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-color)", cursor: "pointer" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0, cursor: "pointer" }} />
      <span style={{ fontSize: 10.5, lineHeight: 1.45, color: "var(--text-secondary)" }}>
        I agree to receive SMS text messages from <strong>Greens Global</strong> at the mobile number on file, including account alerts, two-factor authentication codes, and appointment reminders. <strong>Message frequency may vary.</strong> Msg &amp; data rates may apply. Reply <strong>STOP</strong> to opt out or <strong>HELP</strong> for help at any time. Consent is not a condition of employment or any purchase. View our <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)", textDecoration: "underline" }}><strong>Privacy Policy</strong></a>.
      </span>
    </label>
  );
}

// ---------- Modals ----------
// Real, server-verified SMS/Email OTP (Aug 2026) - replaces the old client-side
// "MFA theater" (ReauthModal / PersonalVaultAuthModal, both deleted) that showed
// a fake code and never checked it against anything. Gates company credential
// reveal/share and access-request approval (require_vault_otp on the backend).
export function VaultOtpModal({ onClose, onVerified, title = "Verify your identity", subtitle = "This is a sensitive action - confirm it's really you." }) {
  const [targets, setTargets] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [channel, setChannel] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [smsConsent, setSmsConsent] = useState(false);

  useEffect(() => {
    api.cvOtpTargets().then(setTargets).catch((e) => setLoadErr(e.message || "Could not load verification options."));
  }, []);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  async function sendCode(ch) {
    setBusy(true); setError("");
    try {
      const res = await api.cvOtpRequest(ch);
      setChannel(ch); setChallenge(res); setCode(""); setResendIn(30);
    } catch (e) { setError(e.message || "Could not send the code."); }
    setBusy(false);
  }

  async function verify() {
    if (code.length !== 6 || !challenge) return;
    setBusy(true); setError("");
    try {
      await api.cvOtpVerify(challenge.challengeId, code);
      onVerified();
    } catch (e) { setError(e.message || "Incorrect code."); }
    setBusy(false);
  }

  if (loadErr) return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<ShieldCheck size={19} />} tint="sky" title={title} subtitle={subtitle} />
      <div style={{ fontSize: 13, color: "var(--cv-rose)" }}>{loadErr}</div>
      <div style={rowBetween}><button onClick={onClose} className="cv-btn">Close</button></div>
    </Modal>
  );

  if (!channel) return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<ShieldCheck size={19} />} tint="sky" title={title} subtitle={subtitle} />
      {!targets ? <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Loading…</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={() => sendCode("email")} disabled={busy} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
            <Mail size={19} style={{ color: "var(--cv-sky)", flexShrink: 0 }} />
            <span style={{ textAlign: "left" }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Authenticate via Email</span>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Send a code to {targets.email.masked}</span>
            </span>
          </button>
          <button onClick={() => targets.sms.available && smsConsent && sendCode("sms")} disabled={busy || !targets.sms.available || !smsConsent} className="cv-btn"
            style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12, opacity: targets.sms.available ? 1 : 0.5, cursor: targets.sms.available ? "pointer" : "not-allowed" }}>
            <MessageCircle size={19} style={{ color: "var(--cv-emerald)", flexShrink: 0 }} />
            <span style={{ textAlign: "left" }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Authenticate via SMS</span>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>{targets.sms.available ? `Send a code to ${targets.sms.masked}` : "No phone number on file - ask HR to add one"}</span>
            </span>
          </button>
          {targets.sms.available && <SmsConsent checked={smsConsent} onChange={setSmsConsent} />}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginTop: 10 }}>{error}</div>}
      <div style={rowBetween}><button onClick={onClose} className="cv-btn">Cancel</button></div>
    </Modal>
  );

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={channel === "sms" ? <MessageCircle size={19} /> : <Mail size={19} />} tint={channel === "sms" ? "emerald" : "sky"}
        title={channel === "sms" ? "SMS Authentication" : "Email Authentication"} subtitle={title} />
      <div style={{ borderRadius: 12, background: channel === "sms" ? "var(--cv-emerald-bg)" : "var(--cv-sky-bg)", border: `1px solid ${channel === "sms" ? "var(--cv-emerald-line)" : "var(--cv-sky-line)"}`, padding: "8px 14px", marginBottom: 14, fontSize: 12, color: channel === "sms" ? "var(--cv-emerald)" : "var(--cv-sky)", display: "flex", alignItems: "center", gap: 8 }}>
        <CheckCircle2 size={15} style={{ flexShrink: 0 }} /> Code sent to {challenge?.target}
      </div>
      {challenge?.devCode && (
        <div style={{ ...infoBox, marginBottom: 10, border: "1px solid var(--cv-amber-line)", background: "var(--cv-amber-bg)", color: "var(--cv-amber)" }}>
          Dev mode - this channel isn't fully configured yet, so nothing was actually sent. Your code: <strong className="cv-mono">{challenge.devCode}</strong>
        </div>
      )}
      <div style={{ ...infoBox, marginBottom: 10 }}>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code:</p>
        <input value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
          placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus
          onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verify()} />
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginBottom: 8 }}>{error}</div>}
      <div style={rowSplit}>
        <button onClick={() => { setChannel(null); setChallenge(null); setCode(""); setError(""); }} className="cv-btn">← Back</button>
        <button onClick={() => resendIn === 0 && sendCode(channel)} disabled={resendIn > 0 || busy} className="cv-btn" style={{ fontSize: 12 }}>{resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}</button>
        <button onClick={verify} disabled={code.length !== 6 || busy} className="cv-btn-dark">{busy ? "Verifying…" : "Verify"}</button>
      </div>
    </Modal>
  );
}

export function ConfirmModal({ cred, onClose, onConfirm }) {
  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Trash2 size={19} />} tint="rose" title="Remove Credential" subtitle="It moves to the trash and can be recovered." />
      <div style={{ ...infoBox, fontSize: 13.5, color: "var(--text-primary)" }}>
        <div style={{ fontWeight: 500 }}>{cred.name}</div>
        <div style={{ color: "var(--text-secondary)" }}>{cred.dept} · {cred.type}</div>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--cv-amber)", background: "var(--cv-amber-bg)", border: "1px solid var(--cv-amber-line)", borderRadius: 12, padding: "8px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Bell size={14} /> All managers + the IT team will be notified.
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={onConfirm} className="cv-btn-dark cv-btn-rose">Remove & Notify</button>
      </div>
    </Modal>
  );
}

function ExpirySection({ form, set }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
        <input type="checkbox" checked={form.customExpiry} onChange={(e) => { set("customExpiry", e.target.checked); if (!e.target.checked) set("rotationMax", 90); }} style={{ height: 15, width: 15, accentColor: "var(--text-primary)" }} />
        <span className="cv-label" style={{ marginBottom: 0 }}>Set password expiry timeline</span>
      </label>
      {form.customExpiry ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[60, 90, 180, 365].map((d) => (
            <button key={d} type="button" onClick={() => set("rotationMax", d)}
              className={form.rotationMax === d ? "cv-btn-dark" : "cv-btn"} style={{ justifyContent: "center", borderRadius: 12 }}>{d}d</button>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 11.5, color: "var(--text-muted)", paddingLeft: 24, margin: 0 }}>Default: 90 days</p>
      )}
    </div>
  );
}

function PasswordField({ value, onChange, placeholder, required = true, label = "Password" }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} required={required}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} className="cv-ipt" style={{ paddingRight: 34 }} placeholder={placeholder} />
          <button type="button" onClick={() => setShow((v) => !v)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex" }}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        <button type="button" onClick={() => onChange(generatePassword())} className="cv-btn" style={{ flexShrink: 0 }}><Shuffle size={15} /> Generate</button>
      </div>
    </Field>
  );
}

export function AddModal({ onClose, onSave, depts, userName, userEmail, people }) {
  const [form, setForm] = useState({ name: "", dept: depts[0], type: "Password", username: "", secret: "", tier: "Standard", url: "", backupOwner: "", rotationMax: 90, customExpiry: false });
  const [initialForm] = useState(form);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => { if (form.name && form.secret) onSave(form); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  return (
    <Modal onClose={onClose} isDirty={dirty} onSave={form.name && form.secret ? save : undefined} maxWidth="clamp(480px, 60vw, 820px)">
      <h3 style={{ fontWeight: 600, fontSize: 17, margin: 0 }}>Add Credential</h3>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "3px 0 0" }}>Stored encrypted. Saving notifies managers + IT.</p>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" placeholder="e.g. Stripe Dashboard" /></Field>
        <Field label="Department" required><select value={form.dept} onChange={(e) => set("dept", e.target.value)} className="cv-ipt">{depts.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Username" required><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" /></Field>
        </div>
        <PasswordField value={form.secret} onChange={(v) => set("secret", v)} placeholder="Enter password" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Tier"><select value={form.tier} onChange={(e) => set("tier", e.target.value)} className="cv-ipt">{TIERS.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="URL / Link"><input value={form.url} onChange={(e) => set("url", e.target.value)} className="cv-ipt" placeholder="https://…" /></Field>
        </div>
        <ExpirySection form={form} set={set} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Owner">
            <div className="cv-ipt" style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-secondary)", color: "var(--text-secondary)", cursor: "default", userSelect: "none" }}>
              <User size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />{userName}
            </div>
          </Field>
          <Field label="Backup owner">
            <select value={form.backupOwner} onChange={(e) => set("backupOwner", e.target.value)} className="cv-ipt">
              <option value="">- Select by email -</option>
              {people.filter((u) => u.email !== userEmail).map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ ...infoBox, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <User size={14} style={{ color: "var(--text-muted)", marginTop: 2, flexShrink: 0 }} />
          Only the owner and backup owner can edit or delete this credential.
        </div>
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={save} disabled={!form.name || !form.secret} className="cv-btn-dark">Save & Notify</button>
      </div>
    </Modal>
  );
}

export function EditModal({ cred, onClose, onSave, depts, ownerName, people }) {
  const [form, setForm] = useState({ name: cred.name, dept: cred.dept, type: cred.type, username: cred.username === "-" ? "" : cred.username, secret: "", url: cred.url || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, customExpiry: cred.customExpiry || false, tier: cred.tier });
  const [initialForm] = useState(form);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => onSave(cred.id, form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  return (
    <Modal onClose={onClose} isDirty={dirty} onSave={save} maxWidth="clamp(480px, 60vw, 820px)">
      <h3 style={{ fontWeight: 600, fontSize: 17, margin: 0 }}>Edit Credential</h3>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "3px 0 0" }}>Changes are logged and managers + IT will be notified.</p>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" /></Field>
        <Field label="Department" required><select value={form.dept} onChange={(e) => set("dept", e.target.value)} className="cv-ipt">{depts.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Username" required><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" /></Field>
        </div>
        <PasswordField value={form.secret} onChange={(v) => set("secret", v)} placeholder="Leave blank to keep current password" required={false} label="New password" />
        <Field label="URL / Link"><input value={form.url} onChange={(e) => set("url", e.target.value)} className="cv-ipt" placeholder="https://…" /></Field>
        <ExpirySection form={form} set={set} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Owner">
            <div className="cv-ipt" style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-secondary)", color: "var(--text-secondary)", cursor: "default", userSelect: "none" }}>
              <User size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />{ownerName}
            </div>
          </Field>
          <Field label="Backup owner">
            <select value={form.backupOwner} onChange={(e) => set("backupOwner", e.target.value)} className="cv-ipt">
              <option value="">- Select by email -</option>
              {people.filter((u) => u.email !== cred.owner).map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={save} className="cv-btn-dark">Save Changes</button>
      </div>
    </Modal>
  );
}

export function ImportModal({ onClose, onImport, depts }) {
  const [raw, setRaw] = useState("");
  const fileRef = useRef(null);
  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "credential-vault-import-template.csv"; a.click(); URL.revokeObjectURL(url);
  };
  const onFile = (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => setRaw(String(r.result)); r.readAsText(f); };

  const rows = useMemo(() => {
    if (!raw.trim()) return [];
    return parseCSV(raw).map((r) => {
      const errors = [];
      if (!r.name) errors.push("name");
      if (!depts.includes(r.department)) errors.push("department");
      if (!TYPES.includes(r.type)) errors.push("type");
      if (!TIERS.includes(r.tier)) errors.push("tier");
      if (!r.secret) errors.push("secret");
      return { data: r, valid: errors.length === 0, errors };
    });
  }, [raw, depts]);
  const valid = rows.filter((r) => r.valid);
  const doImport = () => onImport(valid.map((r) => r.data));

  return (
    <Modal onClose={onClose} wide isDirty={!!raw.trim()} onSave={valid.length > 0 ? doImport : undefined} maxWidth="clamp(600px, 65vw, 1000px)">
      <h3 style={{ fontWeight: 600, fontSize: 17, margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Upload size={19} /> Batch Import</h3>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0" }}>Bulk-load your existing credentials from a CSV. Download the template first so the columns line up correctly.</p>
      <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <button onClick={downloadTemplate} className="cv-btn"><Download size={15} /> Download Template</button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>columns: name, department, type, username, secret, tier</span>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid var(--border-color)", overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Preview · {valid.length} ready, {rows.length - valid.length} need fixing
          </div>
          <div className="cv-divide" style={{ maxHeight: 208, overflowY: "auto" }}>
            {rows.map((r, i) => (
              <div key={i} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
                {r.valid ? <CheckCircle2 size={15} style={{ color: "var(--cv-emerald)", flexShrink: 0 }} /> : <AlertCircle size={15} style={{ color: "var(--cv-rose)", flexShrink: 0 }} />}
                <span className="cv-truncate" style={{ fontWeight: 500, flex: 1 }}>{r.data.name || <span style={{ color: "var(--text-muted)" }}>- no name -</span>}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{r.data.department} · {r.data.tier}</span>
                {!r.valid && <span style={{ fontSize: 11.5, color: "var(--cv-rose)", flexShrink: 0 }}>check: {r.errors.join(", ")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--cv-amber)", background: "var(--cv-amber-bg)", border: "1px solid var(--cv-amber-line)", borderRadius: 12, padding: "8px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Bell size={14} /> Importing notifies all managers + IT, and the import is written to the activity log.
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={() => fileRef.current && fileRef.current.click()} className="cv-btn"><Upload size={15} /> Upload CSV</button>
        <button onClick={doImport} disabled={valid.length === 0} className="cv-btn-dark">Import {valid.length > 0 ? `${valid.length} ` : ""}credentials</button>
      </div>
    </Modal>
  );
}

export function ManagePanel({ onClose, isAdmin, editMode, onToggleEdit }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1200, display: "flex", justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.45)" }} onClick={onClose} />
      <div className="cv-root" style={{ position: "relative", width: "100%", maxWidth: 420, background: "var(--bg-primary)", height: "100%", boxShadow: "0 0 60px rgba(0,0,0,.3)", overflowY: "auto" }}>
        <div style={{ position: "sticky", top: 0, background: "var(--bg-card)", borderBottom: "1px solid var(--border-color)", padding: "16px 20px", display: "flex", alignItems: "center", gap: 8, zIndex: 10 }}>
          <Settings size={19} style={{ color: "var(--text-primary)" }} />
          <h3 style={{ fontWeight: 600, fontSize: 15.5, margin: 0 }}>Manage Vault</h3>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}><X size={19} /></button>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>{isAdmin ? "Global Admin - changes apply company-wide." : "Changes are scoped to credentials you own."}</p>
          <div className="cv-card" style={{ padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}><Pencil size={15} style={{ color: "var(--text-secondary)" }} /> Edit Credentials</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "10px 0" }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>Edit mode</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Enable to edit or bulk-delete credentials</div>
              </div>
              <Toggle on={editMode} onChange={onToggleEdit} />
            </div>
          </div>
          <button onClick={onClose} className="cv-btn-dark" style={{ width: "100%", justifyContent: "center" }}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Personal Vault password: first-time setup, unlock, and OTP-verified "forgot
// password" reset - a real server-checked password (PBKDF2-hashed), replacing
// the old fake TOTP/SMS PersonalVaultAuthModal above.
export function PersonalLockGate({ userEmail, onClose, onUnlocked }) {
  const [step, setStep] = useState("loading"); // loading|setup|enter|forgot-choose|forgot-verify|new-password
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState(null);
  const [channel, setChannel] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [smsConsent, setSmsConsent] = useState(false);

  useEffect(() => {
    api.cvPersonalLockStatus()
      .then((s) => setStep(s.hasPassword ? "enter" : "setup"))
      .catch((e) => { setStep("enter"); setError(e.message || "Could not load Personal Vault status."); });
  }, []);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const msaTag = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 12, background: "var(--cv-blue-bg)", border: "1px solid var(--cv-blue-line)", padding: "8px 12px", marginBottom: 16 }}>
      <MsLogo size={13} />
      <span style={{ fontSize: 12, color: "var(--cv-blue)", fontWeight: 500 }}>{userEmail}</span>
    </div>
  );

  async function doSetup() {
    if (password.trim().length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== password2) { setError("Passwords don't match."); return; }
    setBusy(true); setError("");
    try { await api.cvPersonalLockSetup(password); onUnlocked(); }
    catch (e) { setError(e.message || "Could not set the password."); }
    setBusy(false);
  }

  async function doVerify() {
    if (!password) return;
    setBusy(true); setError("");
    try { await api.cvPersonalLockVerify(password); onUnlocked(); }
    catch (e) { setError(e.message || "Incorrect password."); }
    setBusy(false);
  }

  async function sendForgotCode(ch) {
    setBusy(true); setError("");
    try {
      if (!targets) setTargets(await api.cvOtpTargets());
      const res = await api.cvPersonalLockForgot(ch);
      setChannel(ch); setChallenge(res); setCode(""); setResendIn(30); setStep("forgot-verify");
    } catch (e) { setError(e.message || "Could not send the code."); }
    setBusy(false);
  }

  async function submitReset() {
    if (password.trim().length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== password2) { setError("Passwords don't match."); return; }
    setBusy(true); setError("");
    try { await api.cvPersonalLockReset(challenge.challengeId, code, password); onUnlocked(); }
    catch (e) { setError(e.message || "Could not reset the password - the code may be wrong or expired."); }
    setBusy(false);
  }

  if (step === "loading") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title="Personal Vault" subtitle="Loading…" />
    </Modal>
  );

  if (step === "setup") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title="Set Up Your Personal Vault Password" subtitle="Choose a password to protect your Personal Vault." />
      {msaTag}
      <div style={{ borderRadius: 12, background: "var(--cv-amber-bg)", border: "1px solid var(--cv-amber-line)", padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "var(--cv-amber)" }}>
        Your Personal Vault will be bound to <strong>{userEmail}</strong>. No one else - including Global Admin - can access it. Don't forget this password: you'll need SMS or Email to reset it.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="New password" required>
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} className="cv-ipt" placeholder="At least 6 characters" autoFocus />
        </Field>
        <Field label="Confirm password" required>
          <input type="password" value={password2} onChange={(e) => { setPassword2(e.target.value); setError(""); }} className="cv-ipt" placeholder="Re-enter password"
            onKeyDown={(e) => e.key === "Enter" && doSetup()} />
        </Field>
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginTop: 10 }}>{error}</div>}
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={doSetup} disabled={busy} className="cv-btn-dark cv-btn-indigo">{busy ? "Saving…" : "Activate Vault"}</button>
      </div>
    </Modal>
  );

  if (step === "enter") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title="Unlock Personal Vault" subtitle="Enter your Personal Vault password." />
      {msaTag}
      <Field label="Password" required>
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} className="cv-ipt" placeholder="Personal Vault password" autoFocus
          onKeyDown={(e) => e.key === "Enter" && doVerify()} />
      </Field>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginTop: 10 }}>{error}</div>}
      <div style={{ marginTop: 10 }}>
        <button onClick={() => { setStep("forgot-choose"); setPassword(""); setPassword2(""); setError(""); }} style={{ background: "none", border: "none", color: "var(--cv-indigo)", fontSize: 12, cursor: "pointer", padding: 0, fontFamily: "inherit", textDecoration: "underline" }}>
          Forgot password?
        </button>
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={doVerify} disabled={!password || busy} className="cv-btn-dark cv-btn-indigo">{busy ? "Checking…" : "Unlock Vault"}</button>
      </div>
    </Modal>
  );

  if (step === "forgot-choose") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<KeyRound size={19} />} tint="indigo" title="Reset Personal Vault Password" subtitle="Verify it's you via SMS or Email, then choose a new password." />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => sendForgotCode("email")} disabled={busy} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
          <Mail size={19} style={{ color: "var(--cv-sky)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Authenticate via Email</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Send a code to {targets?.email?.masked || userEmail}</span>
          </span>
        </button>
        <button onClick={() => (!targets || targets.sms.available) && smsConsent && sendForgotCode("sms")} disabled={busy || (targets && !targets.sms.available) || !smsConsent} className="cv-btn"
          style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12, opacity: targets && !targets.sms.available ? 0.5 : 1 }}>
          <MessageCircle size={19} style={{ color: "var(--cv-emerald)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Authenticate via SMS</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>{targets && !targets.sms.available ? "No phone number on file" : `Send a code to ${targets?.sms?.masked || "your phone"}`}</span>
          </span>
        </button>
        {(!targets || targets.sms.available) && <SmsConsent checked={smsConsent} onChange={setSmsConsent} />}
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginTop: 10 }}>{error}</div>}
      <div style={rowBetween}>
        <button onClick={() => { setStep("enter"); setError(""); }} className="cv-btn">← Back</button>
        <button onClick={onClose} className="cv-btn">Cancel</button>
      </div>
    </Modal>
  );

  if (step === "forgot-verify") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={channel === "sms" ? <MessageCircle size={19} /> : <Mail size={19} />} tint={channel === "sms" ? "emerald" : "sky"}
        title={channel === "sms" ? "SMS Authentication" : "Email Authentication"} subtitle="Reset Personal Vault password" />
      <div style={{ borderRadius: 12, background: channel === "sms" ? "var(--cv-emerald-bg)" : "var(--cv-sky-bg)", border: `1px solid ${channel === "sms" ? "var(--cv-emerald-line)" : "var(--cv-sky-line)"}`, padding: "8px 14px", marginBottom: 14, fontSize: 12, color: channel === "sms" ? "var(--cv-emerald)" : "var(--cv-sky)", display: "flex", alignItems: "center", gap: 8 }}>
        <CheckCircle2 size={15} style={{ flexShrink: 0 }} /> Code sent to {challenge?.target}
      </div>
      {challenge?.devCode && (
        <div style={{ ...infoBox, marginBottom: 10, border: "1px solid var(--cv-amber-line)", background: "var(--cv-amber-bg)", color: "var(--cv-amber)" }}>
          Dev mode - this channel isn't fully configured yet, so nothing was actually sent. Your code: <strong className="cv-mono">{challenge.devCode}</strong>
        </div>
      )}
      <div style={{ ...infoBox, marginBottom: 10 }}>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code:</p>
        <input value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }} placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus
          onKeyDown={(e) => e.key === "Enter" && code.length === 6 && setStep("new-password")} />
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginBottom: 8 }}>{error}</div>}
      <div style={rowSplit}>
        <button onClick={() => { setStep("forgot-choose"); setChallenge(null); setCode(""); setError(""); }} className="cv-btn">← Back</button>
        <button onClick={() => resendIn === 0 && sendForgotCode(channel)} disabled={resendIn > 0 || busy} className="cv-btn" style={{ fontSize: 12 }}>{resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}</button>
        <button onClick={() => setStep("new-password")} disabled={code.length !== 6} className="cv-btn-dark cv-btn-indigo">Continue</button>
      </div>
    </Modal>
  );

  // step === "new-password"
  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title="Choose a New Password" subtitle="Verified - set a new Personal Vault password." />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="New password" required>
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} className="cv-ipt" placeholder="At least 6 characters" autoFocus />
        </Field>
        <Field label="Confirm password" required>
          <input type="password" value={password2} onChange={(e) => { setPassword2(e.target.value); setError(""); }} className="cv-ipt" placeholder="Re-enter password"
            onKeyDown={(e) => e.key === "Enter" && submitReset()} />
        </Field>
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginTop: 10 }}>{error}</div>}
      <div style={rowBetween}>
        <button onClick={() => setStep("forgot-verify")} className="cv-btn">← Back</button>
        <button onClick={submitReset} disabled={busy} className="cv-btn-dark cv-btn-indigo">{busy ? "Saving…" : "Reset Password & Unlock"}</button>
      </div>
    </Modal>
  );
}

export function PersonalAddModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name: "", username: "", secret: "", type: "Password", note: "" });
  const [initialForm] = useState(form);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => { if (form.name && form.secret) onSave(form); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  return (
    <Modal onClose={onClose} isDirty={dirty} onSave={form.name && form.secret ? save : undefined} maxWidth="clamp(480px, 60vw, 820px)">
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title="Add Personal Credential" subtitle="Encrypted and private. No one else can see this." />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Name" required><input value={form.name} onChange={(e) => set("name", e.target.value)} className="cv-ipt" placeholder="e.g. Personal Gmail, Home WiFi" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Username / Email"><input value={form.username} onChange={(e) => set("username", e.target.value)} className="cv-ipt" placeholder="account@…" /></Field>
          <Field label="Type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="cv-ipt">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        </div>
        <PasswordField value={form.secret} onChange={(v) => set("secret", v)} placeholder="Enter password" label="Password / Secret" />
        <Field label="Note (optional)"><input value={form.note} onChange={(e) => set("note", e.target.value)} className="cv-ipt" placeholder="Security question, recovery hint…" /></Field>
      </div>
      <div style={{ marginTop: 12, borderRadius: 12, background: "var(--cv-indigo-bg)", border: "1px solid var(--cv-indigo-line)", padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--cv-indigo)" }}>
        <ShieldCheck size={14} style={{ flexShrink: 0 }} />
        Hard-encrypted · Owner-only · Not accessible to any admin or team member
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={save} disabled={!form.name || !form.secret} className="cv-btn-dark cv-btn-indigo">Save to Personal Vault</button>
      </div>
    </Modal>
  );
}

// Searchable + scrollable employee picker - the curated Nexus People list
// (getPeopleDirectory), never M365/GAL-derived (see CLAUDE.md). Typing filters
// by name or email; the field still accepts a free-typed address for people
// not in the directory.
function EmployeePicker({ value, onChange, onEnter, error, placeholder, autoFocus }) {
  const { data: people } = usePeopleDirectory();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const q = value.trim().toLowerCase();
  const matches = useMemo(() => matchPeople(people || [], q), [people, q]);

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <input value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // A suggestion showing means Enter picks it - same "takes the
            // first search result" contract as every other people picker.
            // No suggestions (e.g. a free-typed address for someone not in
            // the directory - this field explicitly supports that) falls
            // through to the parent's submit.
            if (open && matches.length > 0) { e.preventDefault(); onChange(matches[0].email); setOpen(false); return; }
            onEnter?.();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder} autoFocus={autoFocus}
        className={`cv-ipt${error ? " cv-ipt-error" : ""}`} autoComplete="off" />
      {open && matches.length > 0 && (
        <div style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", zIndex: 30,
          background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,.14)", padding: 6, maxHeight: 240, overflowY: "auto" }}>
          {matches.slice(0, 50).map((p) => (
            <button key={p.email} type="button" onClick={() => { onChange(p.email); setOpen(false); }}
              className="cv-row-hover"
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                border: "none", background: "none", padding: "7px 8px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" }}>
              {p.photoUrl ? (
                <img src={p.photoUrl} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
              ) : (
                <div style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--cv-violet-bg)", color: "var(--cv-violet)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, flexShrink: 0 }}>
                  {(p.name || p.email || "?")[0].toUpperCase()}
                </div>
              )}
              <span style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.email}</div>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RequestAccessModal({ cred, userEmail, ownerName, onClose, onSubmit }) {
  const [duration, setDuration] = useState("4h");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const DURATIONS = [{ key: "1h", label: "1 Hour", ms: 3600000 }, { key: "4h", label: "4 Hours", ms: 14400000 }, { key: "8h", label: "8 Hours", ms: 28800000 }, { key: "24h", label: "24 Hours", ms: 86400000 }];
  const isOwner = userEmail === cred.owner;

  function handleSubmit() {
    const trimmed = recipientEmail.trim();
    if (!trimmed || !trimmed.includes("@") || !trimmed.includes(".")) { setEmailError("Please enter a valid email address."); return; }
    const d = DURATIONS.find((x) => x.key === duration);
    onSubmit(cred, d.ms, d.label, trimmed);
  }
  const dirty = !!recipientEmail.trim() || duration !== "4h";

  return (
    <Modal onClose={onClose} isDirty={dirty} onSave={recipientEmail.trim() ? handleSubmit : undefined}>
      <ModalHeader icon={<Share2 size={19} />} tint="violet" title="Share Access" subtitle={`${cred.name} · ${cred.dept}`} />
      <div style={{ marginBottom: 16 }}>
        <span className="cv-label">Share with <span style={{ color: "var(--cv-rose)" }}>*</span></span>
        <EmployeePicker value={recipientEmail} onChange={(v) => { setRecipientEmail(v); setEmailError(""); }}
          onEnter={handleSubmit} error={emailError} placeholder="Search by name or email…" autoFocus />
        {emailError && <p style={{ fontSize: 12, color: "var(--cv-rose)", margin: "4px 0 0" }}>{emailError}</p>}
      </div>
      <div style={{ ...infoBox, marginBottom: 16 }}>
        {isOwner ? (
          <p style={{ margin: 0 }}>As the owner, access will be <strong>granted immediately</strong>. The recipient will see the password in their Credential Vault for the selected duration.</p>
        ) : (<>
          <p style={{ margin: 0 }}>A request will be sent to <strong>{ownerName}</strong> (owner) for approval.</p>
          <p style={{ margin: "4px 0 0" }}>The password will appear only in the recipient's <strong>Credential Vault</strong> - never by email. It auto-disappears when time expires.</p>
        </>)}
      </div>
      <div style={{ marginBottom: 20 }}>
        <span className="cv-label" style={{ marginBottom: 8 }}>Access duration</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {DURATIONS.map((d) => (
            <button key={d.key} onClick={() => setDuration(d.key)}
              className={duration === d.key ? "cv-btn-dark cv-btn-violet" : "cv-btn"}
              style={{ justifyContent: "center", padding: "10px 4px" }}>{d.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={handleSubmit} className="cv-btn-dark cv-btn-violet"><Share2 size={15} /> {isOwner ? "Grant Access" : "Send Request"}</button>
      </div>
    </Modal>
  );
}

// Confirmation details only - the real SMS/Email OTP check happens via
// VaultOtpModal (require_vault_otp on the backend) once the user hits Approve,
// same as reveal/share. Replaces the old fake TOTP/SMS chooser.
export function ApproveAccessModal({ request: a, onClose, onConfirm, onDeny }) {
  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Share2 size={19} />} tint="violet" title="Approve Access Request" subtitle="Approving grants this password to the recipient." />
      <div style={{ borderRadius: 12, background: "var(--cv-violet-bg)", border: "1px solid var(--cv-violet-line)", padding: "10px 14px", marginBottom: 16 }}>
        <div style={{ fontSize: 11.5, color: "var(--cv-violet)", marginBottom: 4, fontWeight: 500 }}>Share Request</div>
        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{a.cred}</div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}><span style={{ fontWeight: 500 }}>{a.requestedBy}</span> wants access · {a.dept} · {a.duration}</div>
        {a.sharedToEmail && <div style={{ fontSize: 11.5, color: "var(--cv-violet)", marginTop: 4, fontWeight: 500 }}>Recipient: {a.sharedToEmail}</div>}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>You'll be asked to verify via SMS or Email before this is approved.</p>
      <div style={rowSplit}>
        <button onClick={() => onDeny(a)} className="cv-btn cv-btn-danger"><XCircle size={15} /> Deny</button>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={() => onConfirm(a)} className="cv-btn-dark cv-btn-violet"><Share2 size={15} /> Approve Access</button>
      </div>
    </Modal>
  );
}
