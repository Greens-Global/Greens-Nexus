import { useState, useEffect, useRef } from 'react';
import {
  Monitor, Command, Terminal, Download, Copy, Check, AlertTriangle,
  ShieldCheck, Trash2, ChevronRight, Upload, Loader2, KeyRound,
} from 'lucide-react';
import { api } from '../api';

// ── Time Tracking (admin portal) ──────────────────────────────────────────────
// How to deploy + remove the Greens Nexus desktop Agent (silent multi-monitor
// screen capture). Mirrors the familiar Flowace layout: a Mode strip
// (Interactive | Silent) over a platform strip (Windows | Mac | Linux). We only
// ship SILENT mode; the Interactive tab is shown for parity but is not enabled.
//
// Installers live in a PRIVATE Supabase bucket. Admins upload the signed build
// here; the Download button and the silent-install command carry a fresh 7-day
// signed URL fetched from /timeclock/agent/download-url — never a public link.

const AGENT_VERSION = 'v0.1.0';

// Command builders take the live signed URL + a device TOKEN so the machine
// enrolls to a user with NO Microsoft login: the command installs the agent and
// drops the token into the agent's config dir, where it reads it on startup.
// Windows: download → NSIS /S (per-user, no admin) → write token → clean up.
// PowerShell -EncodedCommand takes UTF-16LE base64 — this pastes cleanly into
// BOTH Command Prompt and PowerShell (no quote-escaping to get wrong).
function psEncoded(script) {
  let bin = '';
  for (const ch of script) { const c = ch.charCodeAt(0); bin += String.fromCharCode(c & 0xff, (c >> 8) & 0xff); }
  return btoa(bin);
}
const q = (s) => String(s).replace(/'/g, "''");   // PowerShell single-quote escape
const winScript = (url, token) => [
  "$ErrorActionPreference='Stop'",
  '$p="$env:TEMP\\GNAgent.exe"',
  // 1) Clear leftovers from any previous attempt FIRST, so nothing is locked:
  //    kill the agent AND any stuck installer, then delete the stale temp file.
  'Get-Process -Name "Greens Nexus Agent","GNAgent" -ErrorAction SilentlyContinue | Stop-Process -Force',
  'Start-Sleep -Milliseconds 700',
  'Remove-Item $p -Force -ErrorAction SilentlyContinue',
  // 2) Cleanly uninstall the old build (avoids "Failed to uninstall old files").
  '$u = Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Recurse -Filter "Uninstall Greens Nexus Agent.exe" -ErrorAction SilentlyContinue | Select-Object -First 1',
  'if ($u) { Start-Process -Wait $u.FullName -ArgumentList "/S"; Start-Sleep -Milliseconds 800 }',
  // 3) Download + install fresh.
  `Invoke-WebRequest -Uri '${q(url)}' -OutFile $p`,
  "Start-Process -Wait $p -ArgumentList '/S'",
  // 4) Machine-wide token (ProgramData) so the agent finds it whatever user it runs as.
  '$d="$env:ProgramData\\Greens Nexus Agent"',
  'New-Item -ItemType Directory -Force $d | Out-Null',
  `Set-Content -NoNewline "$d\\device-token.txt" '${q(token)}'`,
  'Remove-Item $p -Force -ErrorAction SilentlyContinue',
  // 5) Launch whatever the installer placed under Programs (folder name can vary).
  '$exe = Get-ChildItem "$env:LOCALAPPDATA\\Programs" -Recurse -Filter "Greens Nexus Agent.exe" -ErrorAction SilentlyContinue | Select-Object -First 1',
  'if ($exe) { Start-Process $exe.FullName }',
].join('\n');

const CMD = {
  win: (url, token) =>
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded(winScript(url, token))}`,
  mac: (url, token) =>
    `curl -L '${url}' -o /tmp/GNAgent.dmg && hdiutil attach /tmp/GNAgent.dmg -nobrowse -quiet && ` +
    `cp -R "/Volumes/Greens Nexus Agent/Greens Nexus Agent.app" /Applications/ && ` +
    `hdiutil detach "/Volumes/Greens Nexus Agent" -quiet && ` +
    `mkdir -p ~/Library/Application\\ Support/Greens\\ Nexus\\ Agent && ` +
    `printf '%s' '${token}' > ~/Library/Application\\ Support/Greens\\ Nexus\\ Agent/device-token.txt && ` +
    `open "/Applications/Greens Nexus Agent.app"`,
  linux: (url, token) =>
    `curl -L '${url}' -o ~/.local/bin/gn-agent.AppImage && chmod +x ~/.local/bin/gn-agent.AppImage && ` +
    `mkdir -p ~/.config/Greens\\ Nexus\\ Agent && printf '%s' '${token}' > ~/.config/Greens\\ Nexus\\ Agent/device-token.txt && ` +
    `~/.local/bin/gn-agent.AppImage &`,
};

const WIN_UNINSTALL =
  `"%LOCALAPPDATA%\\Programs\\greens-nexus-agent\\Uninstall Greens Nexus Agent.exe" /S`;
const MAC_UNINSTALL =
  `rm -rf "/Applications/Greens Nexus Agent.app" ~/Library/Application\\ Support/greens-nexus-agent`;
const LINUX_UNINSTALL = `rm -f ~/.local/bin/gn-agent.AppImage`;

const PLATFORMS = [
  { id: 'win',   label: 'Windows', Icon: Monitor,  compat: 'Compatible with Windows 10 or later', accept: '.exe',
    cmdIntro: 'Copy this into Command Prompt / PowerShell on the target machine, or push it through Intune / RMM. The link is a 7-day signed URL — no login needed on that machine:',
    uninstall: WIN_UNINSTALL, uninstallNote: 'Or: Settings → Apps → Greens Nexus Agent → Uninstall.' },
  { id: 'mac',   label: 'Mac',     Icon: Command,  compat: 'Compatible with macOS 11 or later', accept: '.dmg',
    cmdIntro: 'Run in Terminal (or push via your MDM). macOS shows a one-time Screen Recording permission prompt on first capture — this cannot be suppressed by any app.',
    uninstall: MAC_UNINSTALL, uninstallNote: 'Then remove it from System Settings → Privacy → Screen Recording and Login Items.' },
  { id: 'linux', label: 'Linux',   Icon: Terminal, compat: 'AppImage — most modern distros', accept: '.AppImage',
    cmdIntro: 'Run in a terminal on the user’s session:',
    uninstall: LINUX_UNINSTALL, uninstallNote: 'Also remove any autostart entry you created in ~/.config/autostart.' },
];

function CopyBox({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
  };
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)', overflow: 'hidden' }}>
      <code style={{ flex: 1, padding: '12px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}>{text}</code>
      <button onClick={copy} title="Copy"
        style={{ flexShrink: 0, width: 44, border: 'none', borderLeft: '1px solid var(--line)', background: copied ? 'hsla(var(--color-green),0.15)' : 'var(--card)', cursor: 'pointer', color: copied ? 'hsl(var(--color-green))' : 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

const STEPS = [
  { n: 1, title: 'Host the installer (one-time)', body: 'Build the agent in the desktop-agent/ folder (npm run dist:win / dist:mac), code-sign it, then upload it here with the button above.' },
  { n: 2, title: 'Enroll the person', body: 'Enter the employee’s email below and generate their install command. It carries a device token, so no Microsoft login is needed on the machine.' },
  { n: 3, title: 'Run it on the computer', body: 'Paste the command into the machine’s terminal, or push it via Intune / RMM. It installs silently and tags that computer to the person automatically.' },
  { n: 4, title: 'It tracks itself', body: 'The agent auto-records worked time while the person is active and captures every monitor — visible under Admin → Screenshots and in their timesheet. It appears below in Silent App Tracking.' },
];

function fmtWhen(iso) {
  if (!iso) return 'never';
  try { return new Date(iso + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso.slice(0, 16).replace('T', ' '); }
}

export default function TimeTrackingAdmin() {
  const [mode, setMode] = useState('silent');   // 'interactive' (UI only) | 'silent'
  const [plat, setPlat] = useState('win');
  const [dl, setDl] = useState({ loading: true, exists: false, url: '' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);   // {ok, text}
  const [enrollEmail, setEnrollEmail] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [enrollErr, setEnrollErr] = useState('');
  const [token, setToken] = useState('');             // shown once, after enroll
  const [devices, setDevices] = useState(null);
  const fileRef = useRef(null);
  const P = PLATFORMS.find(p => p.id === plat);

  function loadUrl(platform) {
    setDl({ loading: true, exists: false, url: '' });
    api.timeAgentDownloadUrl(platform)
      .then(r => setDl({ loading: false, exists: !!r.exists, url: r.url || '' }))
      .catch(() => setDl({ loading: false, exists: false, url: '' }));
  }
  function loadDevices() {
    api.timeAgentDevices().then(r => setDevices(r.devices || [])).catch(() => setDevices([]));
  }

  useEffect(() => { if (mode === 'silent') loadUrl(plat); }, [plat, mode]);
  useEffect(() => { if (mode === 'silent') loadDevices(); }, [mode]);

  async function onUpload(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || uploading) return;
    setUploading(true);
    setUploadMsg({ ok: true, text: 'Preparing upload…' });
    try {
      // Get a one-time signed URL and PUT the file STRAIGHT to Supabase Storage
      // (never through our API) via XHR — no request timeout, real progress.
      const { uploadUrl } = await api.timeAgentUploadUrl(plat);
      const mb = (f.size / 1_000_000).toFixed(1);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploadMsg({ ok: true, text: `Uploading ${mb} MB — ${Math.round((ev.loaded / ev.total) * 100)}%` });
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
          ? resolve()
          : reject(new Error(`Upload failed (${xhr.status})${xhr.responseText ? `: ${xhr.responseText.slice(0, 150)}` : ''}`));
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(f);
      });
      setUploadMsg({ ok: true, text: `Uploaded ${f.name} (${mb} MB). Download link is live.` });
      loadUrl(plat);
    } catch (err) {
      setUploadMsg({ ok: false, text: err?.message || 'Upload failed.' });
    }
    setUploading(false);
  }

  async function enroll() {
    const email = enrollEmail.trim().toLowerCase();
    if (!email.includes('@')) { setEnrollErr('Enter a valid employee email.'); return; }
    setEnrolling(true); setEnrollErr('');
    try {
      const r = await api.timeAgentEnroll({ email });
      setToken(r.token);
      loadDevices();
    } catch (err) {
      setEnrollErr(err?.message || 'Could not create enrollment.');
    }
    setEnrolling(false);
  }

  async function revoke(id) {
    try { await api.timeAgentRevoke(id); loadDevices(); } catch {}
  }

  const cmdText = token && dl.url ? CMD[plat](dl.url, token) : '';

  return (
    <div style={{ fontFamily: 'Inter,sans-serif', maxWidth: 860, margin: '0 auto' }}>
      {/* Mode strip */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 34, borderBottom: '1px solid var(--line)', marginBottom: 22 }}>
        {[['interactive', 'Interactive Mode'], ['silent', 'Silent Mode']].map(([id, label]) => (
          <button key={id} onClick={() => setMode(id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 15,
              fontWeight: mode === id ? 800 : 600, color: mode === id ? 'var(--ink)' : 'var(--muted)',
              padding: '10px 4px', borderBottom: `2.5px solid ${mode === id ? 'var(--pine)' : 'transparent'}`, marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'interactive' ? (
        <div style={{ textAlign: 'center', padding: '30px 20px', border: '1px dashed var(--line)', borderRadius: 14, background: 'var(--mist)' }}>
          <Monitor size={30} style={{ color: 'var(--muted)', opacity: 0.5 }} />
          <h3 style={{ margin: '12px 0 6px', fontSize: 15, fontWeight: 800 }}>Interactive mode isn’t used at Greens</h3>
          <p style={{ margin: '0 auto', maxWidth: 460, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
            Interactive mode is a visible, employee-controlled tracker (a window the person opens to start/stop).
            Greens Nexus tracks time through the in-app punch clock and the <strong>Silent</strong> agent instead,
            so this tab is shown for reference only. Switch to <strong>Silent Mode</strong> to deploy.
          </p>
          <button onClick={() => setMode('silent')} className="primary-btn" style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Go to Silent Mode <ChevronRight size={14} />
          </button>
        </div>
      ) : (<>
        {/* Platform strip */}
        <div style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
          {PLATFORMS.map(p => {
            const active = p.id === plat;
            return (
              <button key={p.id} onClick={() => setPlat(p.id)}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '13px 8px',
                  border: 'none', cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontSize: 13.5, fontWeight: active ? 800 : 600,
                  background: active ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
                  color: active ? 'hsl(var(--color-green))' : 'var(--muted)',
                  borderBottom: active ? '2.5px solid var(--pine)' : '2.5px solid transparent' }}>
                <p.Icon size={16} /> {p.label}
              </button>
            );
          })}
        </div>

        <p style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, margin: '0 0 4px' }}>
          Deploy the Greens Nexus Agent to record activity silently.
        </p>
        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.6 }}>
          Captures every monitor while the employee is clocked in — no window, no browser sharing bar.
          Frames land under Admin → Screenshots. Deploy only where you have consent on file.
        </p>

        {/* Download + upload */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          {dl.loading ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Checking for an installer…
            </div>
          ) : dl.exists ? (
            <a href={dl.url} target="_blank" rel="noreferrer" className="primary-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', padding: '11px 30px', fontSize: 14 }}>
              <Download size={16} /> Download installer
            </a>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              No {P.label} installer uploaded yet — upload your signed build below.
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>{AGENT_VERSION} · {P.compat}</div>

          {/* Admin upload — replaces touching the storage dashboard */}
          <div style={{ marginTop: 14 }}>
            <input ref={fileRef} type="file" accept={P.accept} onChange={onUpload} style={{ display: 'none' }} />
            <button className="secondary-btn" disabled={uploading} onClick={() => fileRef.current?.click()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {uploading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={13} />}
              {dl.exists ? 'Replace installer' : `Upload ${P.label} installer`}
            </button>
            {uploadMsg && (
              <div style={{ fontSize: 11.5, marginTop: 8, color: uploadMsg.ok ? 'hsl(var(--color-green))' : '#b91c1c' }}>{uploadMsg.text}</div>
            )}
          </div>
        </div>

        {/* Enroll a computer → install command with a device token (no login) */}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '16px', marginBottom: 20 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>Enroll a computer</div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.55 }}>
            Enter the employee this machine belongs to. We generate a one-time device token and bake it into the command —
            the person is tagged automatically, with no Microsoft login on the machine.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="email" className="form-input" placeholder="employee@greensglobal.com"
              value={enrollEmail} onChange={e => { setEnrollEmail(e.target.value); setToken(''); }}
              style={{ flex: 1, minWidth: 220, fontSize: 13 }} />
            <button className="primary-btn" onClick={enroll} disabled={enrolling || !dl.exists}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              {enrolling ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <KeyRound size={13} />}
              Generate install command
            </button>
          </div>
          {!dl.exists && <p style={{ fontSize: 11, color: '#b45309', margin: '8px 0 0' }}>Upload a {P.label} installer first.</p>}
          {enrollErr && <p style={{ fontSize: 11.5, color: '#b91c1c', margin: '8px 0 0' }}>{enrollErr}</p>}

          {token && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 7 }}>
                Silent install command · {enrollEmail.trim().toLowerCase()}
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.6 }}>{P.cmdIntro}</p>
              <CopyBox text={cmdText} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'hsla(45,90%,55%,0.12)', border: '1px solid hsla(45,80%,45%,0.35)', borderRadius: 9, padding: '8px 12px', fontSize: 11.5, color: '#8a5a00', marginTop: 10 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} /> Copy the full command now — the token is shown once. The download link inside is signed and expires in 7 days. Generate a fresh command per computer.
              </div>
            </div>
          )}
        </div>

        {/* Steps */}
        <div style={{ fontSize: 13.5, fontWeight: 800, textAlign: 'center', margin: '0 0 14px' }}>Steps to follow</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 26 }}>
          {STEPS.map(s => (
            <div key={s.n} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 15px', background: 'var(--card)' }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'hsla(var(--color-green),0.12)', color: 'hsl(var(--color-green))', fontWeight: 800, fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 9 }}>{s.n}</div>
              <div style={{ fontSize: 12.5, fontWeight: 800, marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>{s.body}</div>
            </div>
          ))}
        </div>

        {/* How it behaves */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'hsla(var(--color-green),0.04)', marginBottom: 14 }}>
          <ShieldCheck size={17} style={{ color: 'hsl(var(--color-green))', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.6 }}>
            <strong>How it behaves.</strong> A silent device auto-records worked time while the person is <strong>active</strong> (it punches them in on activity and out after 10 minutes idle — every such punch is marked <em>agent</em> and is adjustable in their timecard) and captures each monitor every 5 minutes. It never records once revoked here or uninstalled.
          </div>
        </div>

        {/* Uninstall */}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Trash2 size={15} style={{ color: '#b91c1c' }} />
            <span style={{ fontSize: 13, fontWeight: 800 }}>Uninstall on {P.label}</span>
          </div>
          <CopyBox text={P.uninstall} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '9px 0 0', lineHeight: 1.55 }}>{P.uninstallNote} You can also <strong>Revoke</strong> a device below to cut it off instantly.</p>
        </div>

        {/* Silent App Tracking — enrolled computers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 10px' }}>
          <Monitor size={15} style={{ color: 'var(--pine)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Silent App Tracking</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>enrolled computers</span>
        </div>
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'auto' }}>
          <table className="stack-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--mist)' }}>
                {['Member', 'Email', 'Device name', 'Device user', 'MAC', 'Last seen', ''].map(h => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {devices === null && (
                <tr><td colSpan={7} style={{ padding: 22, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /></td></tr>
              )}
              {devices && devices.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 22, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>No computers enrolled yet.</td></tr>
              )}
              {devices && devices.map(d => (
                <tr key={d.id} style={{ borderTop: '1px solid var(--line)', opacity: d.revoked ? 0.5 : 1 }}>
                  <td data-th="Member" style={{ padding: '9px 12px', fontWeight: 700 }}>{d.name}</td>
                  <td data-th="Email" style={{ padding: '9px 12px', color: 'var(--muted)' }}>{d.email}</td>
                  <td data-th="Device name" style={{ padding: '9px 12px' }}>{d.deviceName || '—'}</td>
                  <td data-th="Device user" style={{ padding: '9px 12px' }}>{d.deviceUser || '—'}</td>
                  <td data-th="MAC" style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: 11 }}>{d.mac || '—'}</td>
                  <td data-th="Last seen" style={{ padding: '9px 12px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{fmtWhen(d.lastSeen)}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                    {d.revoked
                      ? <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: '#b91c1c' }}>Revoked</span>
                      : <button onClick={() => revoke(d.id)} className="secondary-btn" style={{ fontSize: 11, color: '#b91c1c', padding: '3px 10px' }}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
