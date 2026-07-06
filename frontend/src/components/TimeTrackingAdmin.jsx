import { useState } from 'react';
import {
  Monitor, Command, Terminal, Download, Copy, Check, AlertTriangle,
  ShieldCheck, Trash2, ChevronRight,
} from 'lucide-react';

// ── Time Tracking (admin portal) ──────────────────────────────────────────────
// How to deploy + remove the Greens Nexus desktop Agent (silent multi-monitor
// screen capture). Mirrors the familiar Flowace layout: a Mode strip
// (Interactive | Silent) over a platform strip (Windows | Mac | Linux). We only
// ship SILENT mode; the Interactive tab is shown for parity but is not enabled.
//
// The installer URLs below are placeholders — build the agent in `desktop-agent/`
// (npm run dist:win / dist:mac), sign it, host it, then set AGENT_HOST + version.

const AGENT_HOST = 'https://updates.nexus.greensglobal.com/agent'; // where you host the signed installers
const AGENT_VERSION = 'v0.1.0';

const WIN_URL = `${AGENT_HOST}/GreensNexusAgent-Setup.exe`;
const MAC_URL = `${AGENT_HOST}/GreensNexusAgent.dmg`;
const LINUX_URL = `${AGENT_HOST}/GreensNexusAgent.AppImage`;

// One-line silent Windows deploy: download the signed installer to TEMP, run it
// with NSIS's /S (per-user, no admin prompt), then clean up.
const WIN_SILENT_CMD =
  `powershell -Command "$p=\\"$env:TEMP\\GNAgent.exe\\"; Invoke-WebRequest -Uri '${WIN_URL}' -OutFile $p; ` +
  `Start-Process -Wait $p -ArgumentList '/S'; Remove-Item $p"`;

const MAC_SILENT_CMD =
  `curl -L '${MAC_URL}' -o /tmp/GNAgent.dmg && hdiutil attach /tmp/GNAgent.dmg -nobrowse -quiet && ` +
  `cp -R "/Volumes/Greens Nexus Agent/Greens Nexus Agent.app" /Applications/ && ` +
  `hdiutil detach "/Volumes/Greens Nexus Agent" -quiet && open "/Applications/Greens Nexus Agent.app"`;

const LINUX_SILENT_CMD =
  `curl -L '${LINUX_URL}' -o ~/.local/bin/gn-agent.AppImage && chmod +x ~/.local/bin/gn-agent.AppImage && ~/.local/bin/gn-agent.AppImage &`;

const WIN_UNINSTALL =
  `"%LOCALAPPDATA%\\Programs\\greens-nexus-agent\\Uninstall Greens Nexus Agent.exe" /S`;
const MAC_UNINSTALL =
  `rm -rf "/Applications/Greens Nexus Agent.app" ~/Library/Application\\ Support/greens-nexus-agent`;
const LINUX_UNINSTALL = `rm -f ~/.local/bin/gn-agent.AppImage`;

const PLATFORMS = [
  { id: 'win',   label: 'Windows', Icon: Monitor,  compat: 'Compatible with Windows 10 or later',
    url: WIN_URL,   cmd: WIN_SILENT_CMD,   cmdIntro: 'Copy this into an elevated Command Prompt / PowerShell on the user’s profile, or push it through Intune / RMM:',
    uninstall: WIN_UNINSTALL, uninstallNote: 'Or: Settings → Apps → Greens Nexus Agent → Uninstall.' },
  { id: 'mac',   label: 'Mac',     Icon: Command,  compat: 'Compatible with macOS 11 or later',
    url: MAC_URL,   cmd: MAC_SILENT_CMD,   cmdIntro: 'Run in Terminal (or push via your MDM). macOS shows a one-time Screen Recording permission prompt on first capture — this cannot be suppressed by any app.',
    uninstall: MAC_UNINSTALL, uninstallNote: 'Then remove it from System Settings → Privacy → Screen Recording and Login Items.' },
  { id: 'linux', label: 'Linux',   Icon: Terminal, compat: 'AppImage — most modern distros',
    url: LINUX_URL, cmd: LINUX_SILENT_CMD, cmdIntro: 'Run in a terminal on the user’s session:',
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
  { n: 1, title: 'Host the installer (one-time)', body: 'Build the agent in the desktop-agent/ folder (npm run dist:win / dist:mac), code-sign it, and upload it to your host so the download link below resolves.' },
  { n: 2, title: 'Deploy to the machine', body: 'Run the silent command on the employee’s computer, or push it through Intune / your RMM. It installs per-user — no admin prompt on Windows.' },
  { n: 3, title: 'Employee signs in once', body: 'The agent opens the normal Microsoft sign-in in the system browser. After that it remembers the session and starts silently on login.' },
  { n: 4, title: 'Verify it’s reporting', body: 'While the employee is clocked in, frames appear under your avatar → Admin → Screenshots, one per monitor, every 5 minutes.' },
];

export default function TimeTrackingAdmin() {
  const [mode, setMode] = useState('silent');   // 'interactive' (UI only) | 'silent'
  const [plat, setPlat] = useState('win');
  const P = PLATFORMS.find(p => p.id === plat);

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

        {/* Download */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <a href={P.url} target="_blank" rel="noreferrer" className="primary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', padding: '11px 30px', fontSize: 14 }}>
            <Download size={16} /> Download installer
          </a>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>{AGENT_VERSION} · {P.compat}</div>
        </div>

        {/* Silent command */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 7 }}>
            Silent install command
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.6 }}>{P.cmdIntro}</p>
          <CopyBox text={P.cmd} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'hsla(45,90%,55%,0.12)', border: '1px solid hsla(45,80%,45%,0.35)', borderRadius: 9, padding: '8px 12px', fontSize: 11.5, color: '#8a5a00', margin: '0 0 24px' }}>
          <AlertTriangle size={13} style={{ flexShrink: 0 }} /> Copy the full command, not just the link — a partial copy will fail. Set the download host before shipping (see step 1).
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
            <strong>How it behaves.</strong> The agent captures <strong>only while the employee is clocked in</strong> (it checks the punch clock every minute) and the employee can pause it from the tray. It never records off the clock. Signing out from the tray clears the saved session on that machine.
          </div>
        </div>

        {/* Uninstall */}
        <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Trash2 size={15} style={{ color: '#b91c1c' }} />
            <span style={{ fontSize: 13, fontWeight: 800 }}>Uninstall on {P.label}</span>
          </div>
          <CopyBox text={P.uninstall} />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '9px 0 0', lineHeight: 1.55 }}>{P.uninstallNote}</p>
        </div>
      </>)}
    </div>
  );
}
