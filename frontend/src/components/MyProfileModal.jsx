import { useState, useEffect } from 'react';
import { X, Camera, Loader2, Sun, Moon, Palette, Check, PanelLeft, Globe2, Signature, Copy } from 'lucide-react';
import { api } from '../api';
import PhotoEditorModal from './PhotoEditorModal';
import { refreshPhotoMap } from '../lib/peoplePhotos';
import { ZONE_GROUPS, MAX_ZONES, LOCAL_TZ, currentZones, setZones, zoneOptionLabel } from '../lib/worldClockZones';

const WK_THEMES = [['cobalt', 'Cobalt', '#2b45e1'], ['warm', 'Warm Sand', '#f5ead0']];

// "My Profile" (header dropdown) - every employee can add/change/remove their
// own photo here (Neil: the menu item was a dead button, no self-service path
// to a photo existed at all). Reuses HR's PhotoEditorModal (pan/zoom crop,
// paste-a-screenshot) pointed at the self-service /myhr/profile/photo
// endpoints instead of HR's admin-only per-employee one.
//
// Dark Mode + Work OS theme moved here from the top-level header dropdown
// (Neil: group appearance with the rest of "your" settings) - theme/
// onThemeToggle/wkTheme/setWkTheme are TopHeader's existing state, just
// threaded down rather than re-implemented. sidebarPinned/onSidebarPinnedChange
// are App.jsx's - "keep it open every time" turns off the existing
// click-outside auto-collapse instead of adding a second collapse mechanism.
export default function MyProfileModal({ onClose, theme, onThemeToggle, wkTheme, setWkTheme, sidebarPinned, onSidebarPinnedChange }) {
  const [profile, setProfile] = useState(null);
  const [error,   setError]   = useState('');
  const [status,  setStatus]  = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);
  const [signature, setSignature] = useState(null);
  const [sigName, setSigName] = useState('');
  const [sigPhone, setSigPhone] = useState('');
  const [sigClosing, setSigClosing] = useState('');
  const [sigBusy, setSigBusy] = useState(false);
  const [sigStatus, setSigStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const [templates, setTemplates] = useState(null);
  const [templateBusy, setTemplateBusy] = useState('');
  // Fixed MAX_ZONES slots, '' = unset - a dropdown per slot rather than a
  // checklist of ~400 zones (Pranshu, Sep 1: "make it a drop down"). Local
  // (the detected system zone) is always shown first on the greeting and
  // isn't one of these slots - these are just the extra zones layered on
  // top of it (Pranshu, Sep 9).
  const [zoneSlots, setZoneSlots] = useState(() => {
    const cur = currentZones();
    return Array.from({ length: MAX_ZONES }, (_, i) => cur[i] || '');
  });

  function setSlot(i, tz) {
    const next = [...zoneSlots]; next[i] = tz;
    setZoneSlots(next);
    setZones(next);
  }

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(err => setError(err?.message || 'Could not load your profile.'));
    api.mySignature().then(s => { setSignature(s); setSigName(s.displayNameOverride || ''); setSigPhone(s.phoneOverride || ''); setSigClosing(s.closingOverride || ''); }).catch(() => {});
    api.mySignatureTemplates().then(setTemplates).catch(() => {});
  }, []);

  function handlePhotoSaved(updated) {
    setProfile(updated);
    refreshPhotoMap();
  }

  async function saveSignature() {
    setSigBusy(true); setSigStatus('');
    try {
      const s = await api.mySignatureSave({ display_name: sigName, phone: sigPhone, closing: sigClosing });
      setSignature(s); setSigStatus('Saved.');
      api.mySignatureTemplates().then(setTemplates).catch(() => {});   // previews use the same overrides
    } catch (e) { setSigStatus(e?.message || 'Could not save.'); }
    setSigBusy(false);
  }

  async function selectTemplate(tid) {
    if (tid === signature?.template || templateBusy) return;
    setTemplateBusy(tid);
    try {
      const s = await api.mySignatureSave({ template: tid });
      setSignature(s);
    } catch (e) { setSigStatus(e?.message || 'Could not switch template.'); }
    setTemplateBusy('');
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

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '60vw', minWidth: 420, maxWidth: '94vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>My Profile</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <div style={{ padding: 26, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, fontFamily: 'Inter, sans-serif' }}>
          {error && !profile ? (
            <div style={{ fontSize: 12.5, color: 'hsl(var(--color-red))' }}>{error}</div>
          ) : !profile ? (
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />
          ) : (<>
            <div style={{ position: 'relative' }}>
              {profile.photoUrl ? (
                <img src={profile.photoUrl} alt="" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: 88, height: 88, borderRadius: '50%', background: 'hsla(var(--color-green),0.15)', color: 'hsl(var(--color-green))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700 }}>
                  {initials || '?'}
                </div>
              )}
              <button onClick={() => setPhotoOpen(true)} title={profile.photoUrl ? 'Change photo' : 'Add photo'}
                style={{ position: 'absolute', right: -2, bottom: -2, width: 30, height: 30, borderRadius: '50%', border: '2px solid var(--card)', background: 'hsl(var(--color-green))', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Camera size={13} />
              </button>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)', textAlign: 'center' }}>{`${profile.firstName || ''} ${profile.lastName || ''}`.trim()}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{profile.workEmail}</div>
            {profile.jobTitle && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{profile.jobTitle}{profile.department ? ` · ${profile.department}` : ''}</div>
            )}
            {status && <div style={{ fontSize: 12, color: 'hsl(var(--color-green))', marginTop: 4 }}>{status}</div>}
            {error && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 4 }}>{error}</div>}
          </>)}
        </div>

        {signature && (
          <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px', fontFamily: 'Inter, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              <Signature size={11} /> Email Signature
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
              Name, role and company e-mail come from your directory record. Add a preferred name below and it shows alongside your full name - you can also override your phone.
            </div>
            <div
              style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 10, background: '#fff', overflow: 'auto' }}
              dangerouslySetInnerHTML={{ __html: signature.html }}
            />
            {templates && templates.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Template
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                  {templates.map(t => {
                    const selected = t.id === signature.template;
                    return (
                      <button key={t.id} onClick={() => selectTemplate(t.id)} disabled={!!templateBusy}
                        style={{
                          textAlign: 'left', cursor: templateBusy ? 'wait' : 'pointer', padding: 10, borderRadius: 8,
                          border: selected ? '2px solid hsl(var(--color-green))' : '1px solid var(--line)',
                          background: '#fff', position: 'relative',
                        }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {t.label}
                          {selected && <Check size={12} style={{ color: 'hsl(var(--color-green))' }} />}
                          {templateBusy === t.id && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', marginLeft: 'auto' }} />}
                        </div>
                        <div style={{ overflow: 'hidden', height: 60, pointerEvents: 'none' }}>
                          <div style={{ transform: 'scale(0.7)', transformOrigin: 'top left', width: '143%' }}
                            dangerouslySetInnerHTML={{ __html: t.html }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              <input className="form-input" placeholder="Preferred display name" value={sigName}
                onChange={e => setSigName(e.target.value)} style={{ fontSize: 13 }} />
              <input className="form-input" placeholder="Phone for signature (defaults to your profile phone)" value={sigPhone}
                onChange={e => setSigPhone(e.target.value)} style={{ fontSize: 13 }} />
              {(signature.template === 'sincerely' || signature.template === 'regards') && signature.closings && (
                <select className="form-input" value={sigClosing} onChange={e => setSigClosing(e.target.value)} style={{ fontSize: 13 }}>
                  {signature.closings.map(c => <option key={c} value={c}>{c || 'Sign-off (template default)'}</option>)}
                </select>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="secondary-btn" onClick={saveSignature} disabled={sigBusy}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {sigBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={12} />} Save
              </button>
              <button className="secondary-btn" onClick={copySignature}
                style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Copy size={12} /> {copied ? 'Copied!' : 'Copy Signature'}
              </button>
            </div>
            {sigStatus && <div style={{ fontSize: 11.5, color: sigStatus === 'Saved.' ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', marginTop: 6 }}>{sigStatus}</div>}
            <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>
              Paste this into Outlook: Settings → Mail → Compose and reply → Signatures.
            </p>
          </div>
        )}

        {onThemeToggle && (
          <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px', fontFamily: 'Inter, sans-serif' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              Appearance
            </div>
            <button onClick={onThemeToggle}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', marginBottom: 10 }}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
              <Palette size={11} /> Theme
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {WK_THEMES.map(([key, label, swatch]) => (
                <button key={key} onClick={() => setWkTheme?.(key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'none', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}>
                  <span aria-hidden="true" style={{
                    width: 13, height: 13, borderRadius: 4, flexShrink: 0, background: swatch,
                    border: key === 'warm' ? '1px solid #ddd5c2' : '1px solid transparent',
                  }} />
                  {label}
                  {wkTheme === key && <Check size={13} style={{ marginLeft: 'auto', color: 'var(--ink)' }} />}
                </button>
              ))}
            </div>
          </div>
        )}

        {onSidebarPinnedChange && (
          <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px', fontFamily: 'Inter, sans-serif' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              <PanelLeft size={11} /> Sidebar
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button onClick={() => onSidebarPinnedChange(false)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'none', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                <span>
                  Collapse automatically
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Opens when you need it, closes when you click elsewhere</span>
                </span>
                {!sidebarPinned && <Check size={13} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--ink)' }} />}
              </button>
              <button onClick={() => onSidebarPinnedChange(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'none', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                <span>
                  Keep it open
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Always stays expanded</span>
                </span>
                {sidebarPinned && <Check size={13} style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--ink)' }} />}
              </button>
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--line)', padding: '14px 18px 18px', fontFamily: 'Inter, sans-serif' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>
            <Globe2 size={11} /> World Clock
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            Your local time always shows first. Pick up to {MAX_ZONES} more to show alongside it on your Dashboard greeting.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--wk-hover, rgba(0,0,0,.03))', color: 'var(--muted)', fontSize: 13 }}>
              Local — {zoneOptionLabel(LOCAL_TZ)}
            </div>
            {zoneSlots.map((val, i) => (
              <select key={i} value={val} onChange={(e) => setSlot(i, e.target.value)}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontSize: 13, fontFamily: 'inherit' }}>
                <option value="">— None —</option>
                {Object.entries(ZONE_GROUPS).map(([region, tzs]) => (
                  <optgroup key={region} label={region.replace(/_/g, ' ')}>
                    {tzs.filter((tz) => tz !== LOCAL_TZ).map((tz) => <option key={tz} value={tz}>{zoneOptionLabel(tz)}</option>)}
                  </optgroup>
                ))}
              </select>
            ))}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
