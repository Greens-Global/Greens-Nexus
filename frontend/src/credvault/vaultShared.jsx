/* Credential Vault — shared building blocks and modals.
   1:1 port of the standalone credential-vault-dev app's components, translated
   from Tailwind to the Nexus inline-style idiom + the scoped credvault.css. */
import React, { useState, useRef, useMemo } from "react";
import {
  ShieldCheck, Eye, EyeOff, Copy, Check, X, RefreshCw, Users,
  Building2, Calculator, HardHat, Landmark, Server, Activity, Lock,
  CheckCircle2, XCircle, Settings, Trash2, Upload, Download, Smartphone,
  AlertCircle, User, Shuffle, Pencil, MessageCircle, Share2, Bell,
  ChevronDown,
} from "lucide-react";

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
// already removed upstream — these are its shipped defaults).
export const SETTINGS = {
  revealSeconds: 30, rotationDays: 90,
  requireApprovalCritical: true, breachScan: true, logRetentionDays: 365,
};

export const evalStrength = (pwd) => {
  if (!pwd) return "weak";
  const s = (pwd.length >= 12 ? 1 : 0) + (/[A-Z]/.test(pwd) ? 1 : 0) + (/[0-9]/.test(pwd) ? 1 : 0) + (/[^A-Za-z0-9]/.test(pwd) ? 1 : 0);
  return s >= 3 ? "strong" : s >= 2 ? "fair" : "weak";
};

// Simulated rotating 6-digit code for the MFA theater modals (as upstream).
export function getTOTP() {
  const t = Math.floor(Date.now() / 30000);
  let h = (t ^ 0x5f3759df) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) | 0;
  return String(Math.abs(h ^ (h >>> 16)) % 1000000).padStart(6, "0");
}

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

export function Modal({ children, onClose, wide }) {
  return (
    <div className="cv-modal-overlay">
      <div className="cv-modal-backdrop" onClick={onClose} />
      <div className={`cv-modal cv-root${wide ? " cv-modal-wide" : ""}`}>
        <button onClick={onClose} className="cv-modal-close"><X size={19} /></button>
        {children}
      </div>
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

// ---------- Modals ----------
export function ReauthModal({ cred, seconds, onClose, onConfirm, maskedPhone }) {
  const [method, setMethod] = useState(null);
  const [msaSent, setMsaSent] = useState(false);
  const [msaNum] = useState(() => 10 + Math.floor(Math.random() * 90));
  const [smsInput, setSmsInput] = useState("");
  const [smsSent, setSmsSent] = useState(false);

  const header = (
    <>
      <ModalHeader icon={<ShieldCheck size={19} />} tint="sky" title="Confirm it's you" subtitle="Two-factor or multi-factor authentication required." />
      <div style={{ ...infoBox, fontSize: 13.5, color: "var(--text-primary)" }}>
        <div style={{ fontWeight: 500 }}>{cred.name}</div>
        <div style={{ color: "var(--text-secondary)" }}>{cred.dept} · {cred.type}</div>
      </div>
    </>
  );

  if (!method) return (
    <Modal onClose={onClose}>
      {header}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {[
          { key: "msa", icon: <Smartphone size={19} />, l1: "Microsoft", l2: "Authenticator", hint: "Push notification" },
          { key: "sms", icon: <MessageCircle size={19} />, l1: "SMS", l2: "Authentication", hint: `Code to ${maskedPhone}` },
        ].map((m) => (
          <button key={m.key} onClick={() => setMethod(m.key)} className="cv-btn" style={{ flexDirection: "column", padding: "18px 12px", borderWidth: 2, borderRadius: 12, gap: 10 }}>
            <span style={{ height: 40, width: 40, borderRadius: 12, background: "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center" }}>{m.icon}</span>
            <span style={{ textAlign: "center" }}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{m.l1}</span>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{m.l2}</span>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{m.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <div style={rowBetween}><button onClick={onClose} className="cv-btn">Cancel</button></div>
    </Modal>
  );

  if (method === "msa") return (
    <Modal onClose={onClose}>
      {header}
      <div style={{ marginTop: 16 }}>
        {!msaSent ? (
          <button onClick={() => setMsaSent(true)} className="cv-btn-dark" style={{ width: "100%", justifyContent: "center" }}><Smartphone size={15} /> Send Microsoft Authenticator request</button>
        ) : (
          <div style={{ borderRadius: 12, border: "1px solid var(--cv-sky-line)", background: "var(--cv-sky-bg)", padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--cv-sky)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Match this number in your app</div>
            <div style={{ fontSize: 36, fontWeight: 700, color: "var(--cv-sky)", marginTop: 4 }}>{msaNum}</div>
            <div style={{ fontSize: 11.5, color: "var(--cv-sky)", marginTop: 4 }}>Open Microsoft Authenticator and tap Approve</div>
          </div>
        )}
      </div>
      <div style={rowBetween}>
        <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
        <button onClick={onConfirm} disabled={!msaSent} className="cv-btn-dark">I approved it</button>
      </div>
      <p style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-muted)" }}>Wired to Microsoft Entra ID + Authenticator. Reveal stays open {seconds}s.</p>
    </Modal>
  );

  return (
    <Modal onClose={onClose}>
      {header}
      <div style={{ marginTop: 16 }}>
        {!smsSent ? (
          <button onClick={() => setSmsSent(true)} className="cv-btn-dark cv-btn-emerald" style={{ width: "100%", justifyContent: "center" }}><MessageCircle size={15} /> Send SMS to {maskedPhone}</button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ borderRadius: 12, border: "1px solid var(--cv-emerald-line)", background: "var(--cv-emerald-bg)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--cv-emerald)" }}>
              <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
              <span>SMS sent to <strong>{maskedPhone}</strong>. Enter the 6-digit code below.</span>
            </div>
            <input value={smsInput} onChange={(e) => setSmsInput(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter 6-digit code" maxLength={6} className="cv-ipt cv-mono" style={codeInput} />
          </div>
        )}
      </div>
      <div style={rowBetween}>
        <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
        <button onClick={onConfirm} disabled={!smsSent || smsInput.length !== 6} className="cv-btn-dark cv-btn-emerald">Verify & Reveal</button>
      </div>
      <p style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-muted)" }}>Number pulled from the People module. Reveal stays open {seconds}s.</p>
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
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal onClose={onClose}>
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
              <option value="">— Select by email —</option>
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
        <button onClick={() => form.name && form.secret && onSave(form)} disabled={!form.name || !form.secret} className="cv-btn-dark">Save & Notify</button>
      </div>
    </Modal>
  );
}

export function EditModal({ cred, onClose, onSave, depts, ownerName, people }) {
  const [form, setForm] = useState({ name: cred.name, dept: cred.dept, type: cred.type, username: cred.username === "—" ? "" : cred.username, secret: "", url: cred.url || "", backupOwner: cred.backupOwner || "", rotationMax: cred.rotationMax || 90, customExpiry: cred.customExpiry || false, tier: cred.tier });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal onClose={onClose}>
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
              <option value="">— Select by email —</option>
              {people.filter((u) => u.email !== cred.owner).map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div style={rowBetween}>
        <button onClick={onClose} className="cv-btn">Cancel</button>
        <button onClick={() => onSave(cred.id, form)} className="cv-btn-dark">Save Changes</button>
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

  return (
    <Modal onClose={onClose} wide>
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
                <span className="cv-truncate" style={{ fontWeight: 500, flex: 1 }}>{r.data.name || <span style={{ color: "var(--text-muted)" }}>— no name —</span>}</span>
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
        <button onClick={() => onImport(valid.map((r) => r.data))} disabled={valid.length === 0} className="cv-btn-dark">Import {valid.length > 0 ? `${valid.length} ` : ""}credentials</button>
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
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>{isAdmin ? "Global Admin — changes apply company-wide." : "Changes are scoped to credentials you own."}</p>
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

export function PersonalVaultAuthModal({ userEmail, onClose, onUnlock, isFirstTime, title, subtitle, confirmLabel, maskedPhone }) {
  const [method, setMethod] = useState(null);
  const [msaSent, setMsaSent] = useState(false);
  const [msaNum] = useState(() => 10 + Math.floor(Math.random() * 90));
  const [totpInput, setTotpInput] = useState("");
  const [totpError, setTotpError] = useState("");
  const [smsSent, setSmsSent] = useState(false);
  const [smsInput, setSmsInput] = useState("");
  const totp = getTOTP();
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

  const msaTag = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 12, background: "var(--cv-blue-bg)", border: "1px solid var(--cv-blue-line)", padding: "8px 12px", marginBottom: 16 }}>
      <MsLogo size={13} />
      <span style={{ fontSize: 12, color: "var(--cv-blue)", fontWeight: 500 }}>{userEmail}</span>
    </div>
  );

  const submitTotp = () => {
    if (totpInput !== totp) { setTotpError("Incorrect code. Check your Microsoft Authenticator app."); return; }
    onUnlock();
  };

  if (!method) return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Lock size={19} />} tint="indigo" title={title || (isFirstTime ? "Activate Personal Vault" : "Unlock Personal Vault")} subtitle={subtitle || "Two-factor or multi-factor authentication required."} />
      {msaTag}
      {isFirstTime && (
        <div style={{ borderRadius: 12, background: "var(--cv-amber-bg)", border: "1px solid var(--cv-amber-line)", padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "var(--cv-amber)" }}>
          Your Personal Vault will be bound to <strong>{userEmail}</strong>. No one else — including Global Admin — can access it.
        </div>
      )}
      <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>Choose your authentication method:</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => setMethod("msa")} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
          <Smartphone size={19} style={{ color: "var(--cv-indigo)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Microsoft Authenticator</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Enter the 6-digit code from your authenticator app</span>
          </span>
        </button>
        <button onClick={() => setMethod("sms")} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
          <MessageCircle size={19} style={{ color: "var(--cv-emerald)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>SMS Authentication</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Send a verification code to {maskedPhone}</span>
          </span>
        </button>
      </div>
      <div style={rowBetween}><button onClick={onClose} className="cv-btn">Cancel</button></div>
    </Modal>
  );

  if (method === "msa") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Smartphone size={19} />} tint="indigo" title="Microsoft Authenticator" subtitle={title || `${isFirstTime ? "Activate" : "Unlock"} Personal Vault`} />
      {!msaSent ? (<>
        <div style={{ ...infoBox, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 10px" }}>Open your Microsoft Authenticator app and select the matching number:</p>
          <div style={{ textAlign: "center", fontSize: 40, fontWeight: 700, color: "var(--cv-indigo)", padding: "6px 0" }}>{msaNum}</div>
        </div>
        <div style={rowSplit}>
          <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
          <button onClick={() => setMsaSent(true)} className="cv-btn-dark cv-btn-indigo">Send to Authenticator</button>
        </div>
      </>) : (<>
        <div style={{ ...infoBox, marginBottom: 10 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code from your Microsoft Authenticator app:</p>
          <input value={totpInput} onChange={(e) => { setTotpInput(e.target.value.replace(/\D/g, "").slice(0, 6)); setTotpError(""); }} placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus onKeyDown={(e) => e.key === "Enter" && totpInput.length === 6 && submitTotp()} />
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}><RefreshCw size={12} /> Refreshes in {secondsLeft}s</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Demo hint — your app shows: <span className="cv-mono" style={{ fontWeight: 600 }}>{totp.slice(0, 3)} {totp.slice(3)}</span></div>
        </div>
        {totpError && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginBottom: 8 }}>{totpError}</div>}
        <div style={rowSplit}>
          <button onClick={() => { setMsaSent(false); setTotpInput(""); setTotpError(""); }} className="cv-btn">← Back</button>
          <button onClick={submitTotp} disabled={totpInput.length !== 6} className="cv-btn-dark cv-btn-indigo">{confirmLabel || (isFirstTime ? "Activate Vault" : "Unlock Vault")}</button>
        </div>
      </>)}
    </Modal>
  );

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<MessageCircle size={19} />} tint="emerald" title="SMS Authentication" subtitle={`${isFirstTime ? "Activate" : "Unlock"} Personal Vault`} />
      {!smsSent ? (<>
        <div style={{ ...infoBox, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>A 6-digit verification code will be sent to:</p>
          <p style={{ fontWeight: 600, fontSize: 15, margin: "6px 0 0", color: "var(--text-primary)" }}>{maskedPhone}</p>
        </div>
        <div style={rowSplit}>
          <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
          <button onClick={() => setSmsSent(true)} className="cv-btn-dark cv-btn-emerald">Send SMS Code</button>
        </div>
      </>) : (<>
        <div style={{ borderRadius: 12, background: "var(--cv-emerald-bg)", border: "1px solid var(--cv-emerald-line)", padding: "8px 14px", marginBottom: 14, fontSize: 12, color: "var(--cv-emerald)", display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle2 size={15} style={{ flexShrink: 0 }} /> Code sent to {maskedPhone}
        </div>
        <div style={{ ...infoBox, marginBottom: 10 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code you received via SMS:</p>
          <input value={smsInput} onChange={(e) => setSmsInput(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus onKeyDown={(e) => e.key === "Enter" && smsInput.length === 6 && onUnlock()} />
        </div>
        <div style={rowSplit}>
          <button onClick={() => { setSmsSent(false); setSmsInput(""); }} className="cv-btn">← Back</button>
          <button onClick={onUnlock} disabled={smsInput.length !== 6} className="cv-btn-dark cv-btn-emerald">{confirmLabel || (isFirstTime ? "Activate Vault" : "Unlock Vault")}</button>
        </div>
      </>)}
    </Modal>
  );
}

export function PersonalAddModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name: "", username: "", secret: "", type: "Password", note: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal onClose={onClose}>
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
        <button onClick={() => form.name && form.secret && onSave(form)} disabled={!form.name || !form.secret} className="cv-btn-dark cv-btn-indigo">Save to Personal Vault</button>
      </div>
    </Modal>
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

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Share2 size={19} />} tint="violet" title="Share Access" subtitle={`${cred.name} · ${cred.dept}`} />
      <div style={{ marginBottom: 16 }}>
        <span className="cv-label">Share with (email address) <span style={{ color: "var(--cv-rose)" }}>*</span></span>
        <input value={recipientEmail} onChange={(e) => { setRecipientEmail(e.target.value); setEmailError(""); }}
          placeholder="colleague@greensglobal.com" autoFocus onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          className={`cv-ipt${emailError ? " cv-ipt-error" : ""}`} />
        {emailError && <p style={{ fontSize: 12, color: "var(--cv-rose)", margin: "4px 0 0" }}>{emailError}</p>}
      </div>
      <div style={{ ...infoBox, marginBottom: 16 }}>
        {isOwner ? (
          <p style={{ margin: 0 }}>As the owner, access will be <strong>granted immediately</strong>. The recipient will see the password in their Credential Vault for the selected duration.</p>
        ) : (<>
          <p style={{ margin: 0 }}>A request will be sent to <strong>{ownerName}</strong> (owner) for approval.</p>
          <p style={{ margin: "4px 0 0" }}>The password will appear only in the recipient's <strong>Credential Vault</strong> — never by email. It auto-disappears when time expires.</p>
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

export function ApproveAccessModal({ request: a, onClose, onConfirm, onDeny, maskedPhone }) {
  const [method, setMethod] = useState(null);
  const [msaSent, setMsaSent] = useState(false);
  const [msaNum] = useState(() => 10 + Math.floor(Math.random() * 90));
  const [totpInput, setTotpInput] = useState("");
  const [totpError, setTotpError] = useState("");
  const [smsSent, setSmsSent] = useState(false);
  const [smsInput, setSmsInput] = useState("");
  const totp = getTOTP();
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

  const requestCard = (
    <div style={{ borderRadius: 12, background: "var(--cv-violet-bg)", border: "1px solid var(--cv-violet-line)", padding: "10px 14px", marginBottom: 16 }}>
      <div style={{ fontSize: 11.5, color: "var(--cv-violet)", marginBottom: 4, fontWeight: 500 }}>Share Request</div>
      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{a.cred}</div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 2 }}><span style={{ fontWeight: 500 }}>{a.requestedBy}</span> wants access · {a.dept} · {a.duration}</div>
      {a.sharedToEmail && <div style={{ fontSize: 11.5, color: "var(--cv-violet)", marginTop: 4, fontWeight: 500 }}>Recipient: {a.sharedToEmail}</div>}
    </div>
  );

  const submitTotp = () => {
    if (totpInput !== totp) { setTotpError("Incorrect code. Check your Microsoft Authenticator app."); return; }
    onConfirm(a);
  };

  if (!method) return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Share2 size={19} />} tint="violet" title="Approve Access Request" subtitle="Two-factor or multi-factor authentication required." />
      {requestCard}
      <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10 }}>Verify your identity to approve:</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button onClick={() => setMethod("msa")} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
          <Smartphone size={19} style={{ color: "var(--cv-indigo)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>Microsoft Authenticator</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Enter the 6-digit code from your app</span>
          </span>
        </button>
        <button onClick={() => setMethod("sms")} className="cv-btn" style={{ width: "100%", justifyContent: "flex-start", padding: 14, borderRadius: 12, gap: 12 }}>
          <MessageCircle size={19} style={{ color: "var(--cv-emerald)", flexShrink: 0 }} />
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>SMS Authentication</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)" }}>Send a code to {maskedPhone}</span>
          </span>
        </button>
      </div>
      <div style={rowSplit}>
        <button onClick={() => onDeny(a)} className="cv-btn cv-btn-danger"><XCircle size={15} /> Deny</button>
        <button onClick={onClose} className="cv-btn">Cancel</button>
      </div>
    </Modal>
  );

  if (method === "msa") return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<Smartphone size={19} />} tint="indigo" title="Microsoft Authenticator" subtitle={`Approving access to ${a.cred}`} />
      {!msaSent ? (<>
        <div style={{ ...infoBox, marginBottom: 16, textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 10px" }}>Select this number in your Authenticator app:</p>
          <div style={{ fontSize: 40, fontWeight: 700, color: "var(--cv-indigo)" }}>{msaNum}</div>
        </div>
        <div style={rowSplit}>
          <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
          <button onClick={() => setMsaSent(true)} className="cv-btn-dark cv-btn-indigo">Send to Authenticator</button>
        </div>
      </>) : (<>
        <div style={{ ...infoBox, marginBottom: 10 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code from your app:</p>
          <input value={totpInput} onChange={(e) => { setTotpInput(e.target.value.replace(/\D/g, "").slice(0, 6)); setTotpError(""); }} placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus onKeyDown={(e) => e.key === "Enter" && totpInput.length === 6 && submitTotp()} />
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}><RefreshCw size={12} /> Refreshes in {secondsLeft}s</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Demo hint — your app shows: <span className="cv-mono" style={{ fontWeight: 600 }}>{totp.slice(0, 3)} {totp.slice(3)}</span></div>
        </div>
        {totpError && <div style={{ fontSize: 12, color: "var(--cv-rose)", marginBottom: 8 }}>{totpError}</div>}
        <div style={rowSplit}>
          <button onClick={() => { setMsaSent(false); setTotpInput(""); setTotpError(""); }} className="cv-btn">← Back</button>
          <button onClick={submitTotp} disabled={totpInput.length !== 6} className="cv-btn-dark cv-btn-violet">Approve Access</button>
        </div>
      </>)}
    </Modal>
  );

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<MessageCircle size={19} />} tint="emerald" title="SMS Authentication" subtitle={`Approving access to ${a.cred}`} />
      {!smsSent ? (<>
        <div style={{ ...infoBox, marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>A 6-digit code will be sent to:</p>
          <p style={{ fontWeight: 600, fontSize: 15, margin: "6px 0 0", color: "var(--text-primary)" }}>{maskedPhone}</p>
        </div>
        <div style={rowSplit}>
          <button onClick={() => setMethod(null)} className="cv-btn">← Back</button>
          <button onClick={() => setSmsSent(true)} className="cv-btn-dark cv-btn-emerald">Send SMS Code</button>
        </div>
      </>) : (<>
        <div style={{ borderRadius: 12, background: "var(--cv-emerald-bg)", border: "1px solid var(--cv-emerald-line)", padding: "8px 14px", marginBottom: 14, fontSize: 12, color: "var(--cv-emerald)", display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle2 size={15} style={{ flexShrink: 0 }} /> Code sent to {maskedPhone}
        </div>
        <div style={{ ...infoBox, marginBottom: 10 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 8px" }}>Enter the 6-digit code:</p>
          <input value={smsInput} onChange={(e) => setSmsInput(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000 000" maxLength={6} className="cv-ipt cv-mono" style={codeInput} autoFocus onKeyDown={(e) => e.key === "Enter" && smsInput.length === 6 && onConfirm(a)} />
        </div>
        <div style={rowSplit}>
          <button onClick={() => { setSmsSent(false); setSmsInput(""); }} className="cv-btn">← Back</button>
          <button onClick={() => onConfirm(a)} disabled={smsInput.length !== 6} className="cv-btn-dark cv-btn-violet">Approve Access</button>
        </div>
      </>)}
    </Modal>
  );
}
