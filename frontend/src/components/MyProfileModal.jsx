import { useState, useEffect } from 'react';
import { X, Camera, Loader2, Sun, Moon, Palette, Check, PanelLeft, Globe2 } from 'lucide-react';
import { api } from '../api';
import PhotoEditorModal from './PhotoEditorModal';
import { refreshPhotoMap } from '../lib/peoplePhotos';
import { ZONE_OPTIONS, MAX_ZONES, currentZoneKeys, setZoneKeys } from '../lib/worldClockZones';

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
  const [zoneKeys, setZoneKeysLocal] = useState(() => currentZoneKeys());

  function toggleZone(key) {
    const next = zoneKeys.includes(key)
      ? zoneKeys.filter((k) => k !== key)
      : (zoneKeys.length >= MAX_ZONES ? zoneKeys : [...zoneKeys, key]);
    setZoneKeysLocal(next);
    setZoneKeys(next);
  }

  useEffect(() => {
    api.myHrProfile().then(setProfile).catch(err => setError(err?.message || 'Could not load your profile.'));
  }, []);

  function handlePhotoSaved(updated) {
    setProfile(updated);
    refreshPhotoMap();
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
      <div style={{ background: 'var(--card)', borderRadius: 14, width: 360, maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>My Profile</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>
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
            Pick up to {MAX_ZONES} time zones to show on your Dashboard greeting.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ZONE_OPTIONS.map((z) => {
              const checked = zoneKeys.includes(z.key);
              const disabled = !checked && zoneKeys.length >= MAX_ZONES;
              return (
                <button key={z.key} onClick={() => toggleZone(z.key)} disabled={disabled}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'none', color: disabled ? 'var(--muted)' : 'var(--ink)', fontSize: 13, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer', textAlign: 'left', opacity: disabled ? 0.55 : 1 }}>
                  {z.label}
                  {checked && <Check size={13} style={{ marginLeft: 'auto', color: 'var(--ink)' }} />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
