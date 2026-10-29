import { useState, useEffect } from 'react';
import { Camera, Palette, Check, Copy, Mail, CalendarDays, Signature, User, Info } from 'lucide-react';
import { api } from '../api';
import PhotoEditorModal from './PhotoEditorModal';
import { refreshPhotoMap } from '../lib/peoplePhotos';
import { ZONE_GROUPS, MAX_ZONES, LOCAL_TZ, currentZones, setZones, zoneOptionLabel } from '../lib/worldClockZones';
import { Spinner } from './AsyncState';
import EmailSettingsPanel from '../tasks/MyEmailSettings';
import { DATE_FORMATS, getDateFormat, setDateFormat, formatDate } from '../lib/datetime';
import { Modal, useIsMobile } from '../tasks/components';
import { SettingCard, SettingRow, SwitchRow } from './settings/SettingsUI';
import SaveRow from './SaveRow';

const WK_THEMES = [['cobalt', 'Cobalt', '#2b45e1'], ['warm', 'Warm Sand', '#f5ead0']];

// "Profile" (header dropdown; "My Profile" until Neil, Oct 13 2026). It holds
// the user-level settings - "everything as it relates to only you".
// Every employee can add/change/remove their own photo here, through HR's
// PhotoEditorModal pointed at the self-service /myhr/profile/photo endpoints.
// Dark Mode + Work OS theme live here (Neil: group appearance with the rest of
// "your" settings) - theme/onThemeToggle/wkTheme/setWkTheme are TopHeader's
// state, threaded down. sidebarPinned/onSidebarPinnedChange are App.jsx's.
//
// Laid out like Settings (Neil, Oct 28 2026: "needs a full pass ... cleaner
// organized"): who you are across the top, a short list of sections on the
// left (tabs on a phone), and each section drawn with the Settings rows and
// switches (components/settings/SettingsUI.jsx). Switches and selects save
// on change; the signature's typed fields save through one Save row.
// `focusEmail`: opened from the "Email Settings" link in a task email - it
// opens on Task Emails.
const SECTIONS = [
  ['appearance', 'Appearance', Palette],
  ['time', 'Date & Time', CalendarDays],
  ['signature', 'Email Signature', Signature],
  ['email', 'Task Emails', Mail],
];

export default function MyProfileModal({ onClose, theme, onThemeToggle, wkTheme, setWkTheme, sidebarPinned, onSidebarPinnedChange, focusEmail = false }) {
  const isMobile = useIsMobile();
  const [section, setSection] = useState(focusEmail ? 'email' : 'appearance');
  // The settings API answers 403 for an account with no Task module access -
  // say so plainly instead of showing controls that cannot be saved.
  const [emailUnavailable, setEmailUnavailable] = useState(false);
  const [profile, setProfile] = useState(null);
  const [signature, setSignature] = useState(null);
  const [sigError, setSigError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);
  // The signature's own fields, beside what was saved (Settings saves one way).
  const [sig, setSig] = useState({ name: '', phone: '', closing: '', linkedin: '' });
  const [sigSaved, setSigSaved] = useState(sig);
  const [sigBusy, setSigBusy] = useState(false);
  const [sigStatus, setSigStatus] = useState('');
  const [logoBusy, setLogoBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dateFmtStatus, setDateFmtStatus] = useState('');
  // Fixed MAX_ZONES slots, '' = unset - a dropdown per slot (Pranshu, Sep 1).
  // Local (the detected system zone) always shows first on the greeting and
  // is not one of these slots (Pranshu, Sep 9).
  const [zoneSlots, setZoneSlots] = useState(() => {
    const cur = currentZones();
    return Array.from({ length: MAX_ZONES }, (_, i) => cur[i] || '');
  });

  function setSlot(i, tz) {
    const next = [...zoneSlots]; next[i] = tz;
    setZoneSlots(next);
    setZones(next);
  }

  const fromSignature = (s) => ({ name: s.displayNameOverride || '', phone: s.phoneOverride || '',
    closing: s.closingOverride || '', linkedin: s.linkedinOverride || '' });

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(err => setError(err?.message || 'Could not load your profile.'));
    api.mySignature().then(s => {
      setSignature(s); const v = fromSignature(s); setSig(v); setSigSaved(v);
    }).catch(e => setSigError(e?.status === 404
      ? 'Your signature is built from your HR record. Once HR adds you, it shows here.'
      : (e?.message || 'Could not load your signature.')));
  }, []);

  function handlePhotoSaved(updated) {
    setProfile(updated);
    refreshPhotoMap();
  }

  async function uploadSignatureLogo(file) {
    setLogoBusy(true); setSigStatus('');
    try {
      const form = new FormData();
      form.append('file', file);
      setSignature(await api.mySignatureLogoUpload(form));
      setSigStatus('Logo updated.');
    } catch (e) { setSigStatus(e?.message || 'Could not upload logo.'); }
    setLogoBusy(false);
  }

  async function removeSignatureLogo() {
    setLogoBusy(true); setSigStatus('');
    try {
      setSignature(await api.mySignatureLogoRemove());
      setSigStatus("Back to your company's logo.");
    } catch (e) { setSigStatus(e?.message || 'Could not remove logo.'); }
    setLogoBusy(false);
  }

  async function saveSignature() {
    setSigBusy(true); setSigStatus('');
    try {
      const s = await api.mySignatureSave({ display_name: sig.name, phone: sig.phone, closing: sig.closing, linkedin_url: sig.linkedin });
      setSignature(s); const v = fromSignature(s); setSig(v); setSigSaved(v); setSigStatus('Saved.');
    } catch (e) { setSigStatus(e?.message || 'Could not save.'); }
    setSigBusy(false);
  }

  // Every date on every screen is already drawn, so a reload shows the new order everywhere.
  async function saveDateFormat(fmt) {
    setDateFmtStatus('Saving...');
    try {
      await api.saveMyDateFormat(fmt);
      setDateFormat(fmt);
      window.location.reload();
    } catch (err) {
      setDateFmtStatus(err?.message || 'Could not save your date format.');
    }
  }

  async function copySignature() {
    if (!signature?.html) return;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        const blob = new Blob([signature.html], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
      } else {
        await navigator.clipboard.writeText(signature.html);
      }
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { setSigStatus('Could not copy - select the preview and copy manually.'); }
  }

  if (photoOpen && profile) {
    return (
      <PhotoEditorModal
        photoUrl={profile.photoUrl}
        title={profile.photoUrl ? 'Change Photo' : 'Add Photo'}
        onUpload={form => api.myHrPhotoUpload(form)}
        onRemove={() => api.myHrPhotoRemove()}
        onClose={() => setPhotoOpen(false)}
        onSaved={handlePhotoSaved}
        toastOk={setStatus}
        toastErr={setError}
      />
    );
  }

  const initials = profile ? `${(profile.firstName || '')[0] || ''}${(profile.lastName || '')[0] || ''}`.toUpperCase() : '';
  const fullName = profile ? `${profile.firstName || ''} ${profile.lastName || ''}`.trim() : '';
  const sigDirty = Object.keys(sig).some((k) => sig[k] !== sigSaved[k]);
  const field = (key, label, placeholder, extra) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2, var(--muted))' }}>{label}</span>
      <span style={{ display: 'flex', gap: 6 }}>
        <input className="form-input" placeholder={placeholder} value={sig[key]}
          onChange={e => setSig((v) => ({ ...v, [key]: e.target.value }))} style={{ fontSize: 13, flex: 1, minWidth: 0 }} />
        {extra}
      </span>
    </label>
  );

  // ── Who you are ──
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '2px 0 18px', borderBottom: '1px solid var(--line)', marginBottom: 18 }}>
      <div style={{ position: 'relative', flex: 'none' }}>
        {profile?.photoUrl ? (
          <img src={profile.photoUrl} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div aria-hidden="true" style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--wk-brand-tint)', color: 'var(--wk-brand)', display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 700 }}>
            {profile ? (initials || <User size={24} />) : <User size={24} />}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!profile && !error ? <Spinner size="inline" /> : (<>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.3 }}>{fullName || profile?.workEmail || 'You'}</div>
          {profile?.workEmail && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 1 }}>{profile.workEmail}</div>}
          {profile?.jobTitle && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1 }}>{profile.jobTitle}{profile.department ? ` - ${profile.department}` : ''}</div>
          )}
          {error && !profile && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12.5, lineHeight: 1.45, color: 'var(--muted)', marginTop: 2 }}>
              <Info size={13} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} /> {error}
            </div>
          )}
          {status && <div style={{ fontSize: 12, color: 'var(--wk-brand)', marginTop: 4 }}>{status}</div>}
          {error && profile && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 4 }}>{error}</div>}
        </>)}
      </div>
      {profile && (
        <button type="button" className="secondary-btn" onClick={() => setPhotoOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, flex: 'none' }}>
          <Camera size={14} aria-hidden="true" /> {profile.photoUrl ? 'Change Photo' : 'Add Photo'}
        </button>
      )}
    </div>
  );

  // ── The sections ──
  const segmented = (value, options, onPick, label) => (
    <span role="radiogroup" aria-label={label} style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, padding: 2, background: 'var(--paper)', flexWrap: 'wrap' }}>
      {options.map(([key, text, swatch]) => {
        const on = value === key;
        return (
          <button key={key} type="button" role="radio" aria-checked={on} onClick={() => onPick(key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? 'var(--ink)' : 'var(--muted)',
              background: on ? 'var(--card)' : 'transparent', boxShadow: on ? '0 1px 2px rgba(15,23,42,.12)' : 'none' }}>
            {swatch && <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: swatch, border: '1px solid rgba(0,0,0,.12)' }} />}
            {text}
          </button>
        );
      })}
    </span>
  );
  const zoneSelect = (val, i) => (
    <select className="form-input" value={val} onChange={(e) => setSlot(i, e.target.value)} aria-label={`Extra clock ${i + 1}`}
      style={{ fontSize: 13, width: isMobile ? '100%' : 300 }}>
      <option value="">None</option>
      {Object.entries(ZONE_GROUPS).map(([region, tzs]) => (
        <optgroup key={region} label={region.replace(/_/g, ' ')}>
          {tzs.filter((tz) => tz !== LOCAL_TZ).map((tz) => <option key={tz} value={tz}>{zoneOptionLabel(tz)}</option>)}
        </optgroup>
      ))}
    </select>
  );

  const body = {
    appearance: (
      <SettingCard>
        {onThemeToggle && (
          <SwitchRow id="profile-dark" title="Dark Mode" desc="Dark backgrounds across Nexus, on this device."
            checked={theme === 'dark'} onChange={() => onThemeToggle()} />
        )}
        {setWkTheme && (
          <SettingRow title="Theme" desc="The accent and surface colors of your workspace."
            control={segmented(wkTheme, WK_THEMES, (k) => setWkTheme(k), 'Theme')} />
        )}
        {onSidebarPinnedChange && (
          <SettingRow title="Sidebar"
            desc={sidebarPinned ? 'Always stays expanded.' : 'Opens when you need it, closes when you click elsewhere.'}
            control={segmented(sidebarPinned ? 'open' : 'auto', [['auto', 'Collapse Automatically'], ['open', 'Keep Open']],
              (k) => onSidebarPinnedChange(k === 'open'), 'Sidebar')} />
        )}
      </SettingCard>
    ),
    time: (
      <SettingCard>
        <SettingRow title="Date Format"
          desc={dateFmtStatus || 'How every date in Nexus reads for you. MM/DD/YYYY is the default for everyone.'}
          control={(
            <select className="form-input" aria-label="Date Format" value={getDateFormat()} onChange={(e) => saveDateFormat(e.target.value)}
              disabled={dateFmtStatus === 'Saving...'} style={{ fontSize: 13, width: isMobile ? '100%' : 300 }}>
              {DATE_FORMATS.map((f) => <option key={f} value={f}>{f} - {formatDate(new Date(), '', undefined, f)}{f === DATE_FORMATS[0] ? ' (Default)' : ''}</option>)}
            </select>
          )} />
        <SettingRow title="Your Time Zone"
          desc="From this computer. It shows first on your Dashboard greeting, with California time beside it when yours is different."
          control={<span style={{ fontSize: 13, color: 'var(--ink)', textAlign: 'right', display: 'block', maxWidth: 300 }}>{zoneOptionLabel(LOCAL_TZ)}</span>} />
        {zoneSlots.map((val, i) => (
          <SettingRow key={i} title={`Extra Clock ${i + 1}`}
            desc={i === 0 ? `Up to ${MAX_ZONES} more time zones beside yours on the greeting.` : undefined}
            control={zoneSelect(val, i)} />
        ))}
      </SettingCard>
    ),
    signature: !signature ? (sigError ? <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{sigError}</p> : <Spinner size="section" />) : (
      <>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 14 }}>
          Your name, role and company email come from your directory record, and the design is set by your administrator. These are yours to change.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: 22, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {field('name', 'Preferred Name', 'Shown alongside your full name')}
            {field('phone', 'Phone', 'Defaults to your profile phone')}
            {field('linkedin', 'LinkedIn', 'https://linkedin.com/in/...')}
            {field('closing', 'Sign-Off', 'e.g. Sincerely, or write your own',
              signature.closingPresets?.some(c => c) && (
                <select className="form-input" value="" aria-label="Pick a sign-off" onChange={e => { if (e.target.value) setSig((v) => ({ ...v, closing: e.target.value })); }}
                  style={{ fontSize: 12.5, width: 130, flex: 'none' }}>
                  <option value="">Pick One…</option>
                  {signature.closingPresets.filter(c => c).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2, var(--muted))' }}>Logo</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {signature.logoUrl && (
                  <img src={signature.logoUrl} alt="" style={{ height: 30, maxWidth: 110, objectFit: 'contain', borderRadius: 4, background: '#fff', border: '1px solid var(--line)', padding: 2 }} />
                )}
                <label className="secondary-btn" style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: logoBusy ? 0.6 : 1 }}>
                  {logoBusy ? <Spinner size={12} /> : <Camera size={13} />}
                  {signature.logoUrlOverride ? 'Replace Logo' : 'Upload Logo'}
                  <input type="file" accept="image/*" style={{ display: 'none' }} disabled={logoBusy}
                    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadSignatureLogo(f); }} />
                </label>
                {signature.logoUrlOverride && (
                  <button type="button" className="secondary-btn" onClick={removeSignatureLogo} disabled={logoBusy} style={{ fontSize: 12.5 }}>
                    Use Company Logo
                  </button>
                )}
              </span>
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-2, var(--muted))' }}>Preview</span>
              <button type="button" className="secondary-btn" onClick={copySignature}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy Signature'}
              </button>
            </div>
            {/* The typewriter animation ships inside signature.html itself (backend
                _TYPEWRITER_CSS) so it travels with a copy/paste into Outlook. */}
            <div key={signature.html}
              style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: '#fff', overflow: 'auto' }}
              dangerouslySetInnerHTML={{ __html: signature.html }} />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
              Shows what was last saved. Paste it into Outlook: Settings, Mail, Compose and Reply, Signatures.
            </div>
          </div>
        </div>
        <SaveRow dirty={sigDirty} busy={sigBusy} onSave={saveSignature}
          onDiscard={() => { setSig(sigSaved); setSigStatus(''); }}
          note={sigStatus && <span style={{ color: /Could not/.test(sigStatus) ? 'hsl(var(--color-red))' : 'var(--wk-brand)' }}>{sigStatus}</span>} />
      </>
    ),
    // Email Settings (Neil, Oct 13 2026: "no need to have this as a separate
    // pop-up") - your own task email preferences, now a section of its own.
    email: emailUnavailable ? (
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
        Task email settings aren&apos;t available for your account because you don&apos;t have access to the Tasks module.
      </p>
    ) : (
      <div id="profile-email-settings"><EmailSettingsPanel onUnavailable={() => setEmailUnavailable(true)} /></div>
    ),
  };
  const current = SECTIONS.find(([k]) => k === section) || SECTIONS[0];

  const nav = (
    <nav aria-label="Profile sections" className={isMobile ? 'scroll-tabs' : undefined}
      style={isMobile
        ? { display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--line)' }
        : { display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 0, alignSelf: 'start' }}>
      {SECTIONS.map(([key, label, Icon]) => {
        const on = key === section;
        return (
          <button key={key} type="button" onClick={() => setSection(key)} aria-current={on ? 'page' : undefined}
            style={isMobile ? {
              flex: 'none', padding: '8px 10px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 13, fontWeight: on ? 600 : 500, color: on ? 'var(--ink)' : 'var(--muted)',
              boxShadow: on ? 'inset 0 -2px 0 var(--wk-brand)' : 'none', whiteSpace: 'nowrap',
            } : {
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, textAlign: 'left',
              fontWeight: on ? 600 : 500, color: on ? 'var(--wk-brand)' : 'var(--ink)', background: on ? 'var(--wk-brand-tint)' : 'transparent',
            }}>
            {!isMobile && <Icon size={16} aria-hidden="true" />} {label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <Modal title="Profile" onClose={onClose} minHeight="80vh">
      {header}
      <div style={isMobile ? undefined : { display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr)', gap: 28, alignItems: 'start' }}>
        {nav}
        <section aria-label={current[1]} style={{ minWidth: 0 }}>
          {!isMobile && <h3 style={{ margin: '4px 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{current[1]}</h3>}
          {body[current[0]]}
        </section>
      </div>
    </Modal>
  );
}
