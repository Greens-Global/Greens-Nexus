/* Credential Vault - shared building blocks the rebuilt screen still uses
   (Oct 14 2026): config + CSV helpers, the compact Modal/Field pair the two
   identity dialogs are built on, VaultOtpModal (the SMS/Email code gate on
   every company reveal/share/approve), PasswordField (show/generate), and
   PersonalLockGate (the Personal Vault password: set up, unlock, OTP-verified
   reset) - which Personal Links (views/ExternalLinks.jsx) also opens. */
import React, { useState, useEffect } from "react";
import { LoadingState } from '../components/AsyncState';
import {
  ShieldCheck, Eye, EyeOff, X, Users, Building2, Calculator, HardHat, Landmark, Server, Activity, Lock,
  CheckCircle2, Shuffle, MessageCircle, Mail, KeyRound,
} from "lucide-react";
import { api } from "../api";

// The Microsoft four-square mark - the Personal Vault is bound to the signed-in
// Entra account, and the lock gate says so with it.
export const MsLogo = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 23 23" aria-hidden="true">
    <rect x="1" y="1" width="10" height="10" fill="#f25022" /><rect x="12" y="1" width="10" height="10" fill="#7fba00" />
    <rect x="1" y="12" width="10" height="10" fill="#00a4ef" /><rect x="12" y="12" width="10" height="10" fill="#ffb900" />
  </svg>
);

export const DEPT_ICONS = {
  Accounting: Calculator, HR: Users, Operations: Activity, Administration: Building2,
  "Real Estate Development": Landmark, Construction: HardHat, IT: Server,
};
export const iconFor = (n) => DEPT_ICONS[n] || Building2;
export const DEFAULT_DEPTS = Object.keys(DEPT_ICONS);
export const TIERS = ["Standard", "High", "Critical"];
export const TYPES = ["Password", "API key", "Access key", "Certificate"];


export function generatePassword() {
  // The browser's cryptographic generator, never Math.random (Oct 14 2026).
  // Rejection sampling keeps every character equally likely.
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
  const limit = 256 - (256 % chars.length);
  const out = [];
  while (out.length < 16) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const b of bytes) { if (b < limit && out.length < 16) out.push(chars[b % chars.length]); }
  }
  return out.join("");
}


const ACTION_COLORS = {
  Revealed: "amber", Copied: "sky", Shared: "emerald", Edited: "violet",
  Created: "indigo", Imported: "indigo", Recovered: "emerald", Rotated: "emerald",
  Removed: "rose", Requested: null, Denied: "rose", Revoked: "rose", Transferred: "violet", Offboarded: "amber",
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

// away, since that's a deliberate choice.
export function Modal({ children, onClose, isDirty = false, onSave }) {
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
      {/* 60% of the screen (CLAUDE.md popup rule) via .nx-popup; a caller's `wide` no
          longer adds .cv-modal-wide (its later, equally specific rule would cap it). */}
      <div className="cv-modal cv-root nx-popup">
        <button onClick={requestClose} className="cv-modal-close"><X size={19} /></button>
        {children}
      </div>
      {confirming && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,23,42,.25)" }}>
          <div className="cv-modal cv-root nx-popup" style={{ padding: 20, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Save your changes?</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 18 }}>
              You have unsaved changes. Closing now will discard them.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
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

const rowBetween = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 };
const rowSplit = { display: "flex", justifyContent: "space-between", gap: 8, marginTop: 16 };
const infoBox = { borderRadius: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-color)", padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)" };
const codeInput = { textAlign: "center", fontSize: 19, letterSpacing: "0.4em" };

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

// reveal/share and access-request approval (require_vault_otp on the backend).
export function VaultOtpModal({ onClose, onVerified, title = "Verify Your Identity", subtitle = "This is a sensitive action - confirm it is really you." }) {
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
      {!targets ? <LoadingState compact /> : (
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

export function PasswordField({ value, onChange, placeholder, required = true, label = "Password" }) {
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

// the old fake TOTP/SMS PersonalVaultAuthModal above.
// onUnlocked(res) receives the unlock response ({ expiresInSec }) so the caller
// knows when the server window closes.
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
    try { const res = await api.cvPersonalLockSetup(password); onUnlocked(res); }
    catch (e) { setError(e.message || "Could not set the password."); }
    setBusy(false);
  }

  async function doVerify() {
    if (!password) return;
    setBusy(true); setError("");
    try { const res = await api.cvPersonalLockVerify(password); onUnlocked(res); }
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
    try { const res = await api.cvPersonalLockReset(challenge.challengeId, code, password); onUnlocked(res); }
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

// Previous / Next over a list (Oct 29 2026): Activity shows 20 a page, a
// credential's History 10. Says where you are; hidden when one page is enough.
export function Pager({ page, pages, total, size, onPage, compact = false }) {
  if (pages <= 1) return null;
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  return (
    <div className="cv-pager" data-pager="">
      <span className="cv-hint">{from}-{to} of {total}</span>
      <span style={{ flex: 1 }} />
      <button type="button" className="cv-btn" style={compact ? { padding: "3px 9px", fontSize: 12 } : undefined} onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous</button>
      <span className="cv-hint" style={{ padding: "0 6px" }}>{page} / {pages}</span>
      <button type="button" className="cv-btn" style={compact ? { padding: "3px 9px", fontSize: 12 } : undefined} onClick={() => onPage(page + 1)} disabled={page >= pages}>Next</button>
    </div>
  );
}
