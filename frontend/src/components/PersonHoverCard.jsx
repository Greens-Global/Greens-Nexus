// Hover any person's avatar in Nexus -> an Outlook-style contact card. Click ->
// their profile in the People module, for users whose sidebar shows People.
//
// Wraps an existing avatar rather than replacing it, so every caller keeps the
// avatar it already renders (Tasks/Tickets use one shape, People another) and
// only gains the behavior:  <PersonHover email={em}><Avatar .../></PersonHover>
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mail, MessageSquare, User } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { openPersonProfile } from '../lib/personNav';
import { rootZoom } from '../lib/utils';

// A person's card is stable for the session, so it is cached per email and the
// in-flight promise is shared - a 40-row list whose avatars all resolve to the
// same person must not fire 40 requests. null = looked up, no match (the
// endpoint 404s for anyone not in Nexus People, e.g. an external commenter).
const _cache = new Map();
const _inflight = new Map();

function loadPerson(email) {
  const key = email.toLowerCase();
  if (_cache.has(key)) return Promise.resolve(_cache.get(key));
  if (_inflight.has(key)) return _inflight.get(key);
  const p = api.personCard(key)
    .then((card) => { _cache.set(key, card || null); return _cache.get(key); })
    .catch(() => { _cache.set(key, null); return null; })
    .finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

const OPEN_DELAY = 320;   // hover intent - don't fire while sweeping across a list
const CLOSE_DELAY = 140;  // grace to move the pointer from avatar into the card
const CARD_W = 268;

export default function PersonHover({ email, name = '', children, disabled = false }) {
  const { can, myGrantedModules } = useRole();
  const [card, setCard] = useState(null);
  const [pos, setPos] = useState(null);      // non-null while the card is shown
  const anchorRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const overCard = useRef(false);

  const em = (email || '').trim().toLowerCase();
  // Match the sidebar's own People test exactly (Sidebar.jsx NAV filter), so the
  // avatar is clickable precisely when the user has somewhere to land.
  const canOpen = !!em && (can?.('administrator') || myGrantedModules?.has('hr'));
  const active = !!em && !disabled;

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  useEffect(() => clearTimers, []);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    // The rect and innerWidth/Height are in the OUTER coordinate space; CARD_W
    // and everything written below are CSS lengths in the INNER one, which
    // <html>'s CSS zoom scales. Compare in outer, then divide back. See rootZoom.
    const z = rootZoom();
    const r = el.getBoundingClientRect();
    // Flip above / clamp horizontally so the card never leaves the viewport.
    const below = window.innerHeight - r.bottom > 210 * z;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - CARD_W * z - 8)) / z,
      top: below ? (r.bottom + 8) / z : undefined,
      bottom: below ? undefined : (window.innerHeight - r.top + 8) / z,
    });
  }, []);

  const open = useCallback(() => {
    if (!active) return;
    clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => {
      place();
      loadPerson(em).then((c) => setCard(c));
    }, OPEN_DELAY);
  }, [active, em, place]);

  const close = useCallback(() => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!overCard.current) { setPos(null); setCard(null); }
    }, CLOSE_DELAY);
  }, []);

  // The card is fixed-positioned against the anchor, so any scroll or resize
  // would leave it stranded mid-page. Cheaper to dismiss than to re-follow.
  useEffect(() => {
    if (!pos) return undefined;
    const hide = () => { setPos(null); setCard(null); };
    const onKey = (e) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [pos]);

  if (!active) return children;

  const go = () => { setPos(null); setCard(null); openPersonProfile(em); };

  return (
    <>
      <span
        ref={anchorRef}
        // Touch has no hover: a tap would open the card and immediately act on
        // it, so pointer devices get the card and touch goes straight to click.
        onPointerEnter={(e) => { if (e.pointerType !== 'touch') open(); }}
        onPointerLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={canOpen ? (e) => { e.stopPropagation(); go(); } : undefined}
        onKeyDown={canOpen ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); go(); }
        } : undefined}
        role={canOpen ? 'button' : undefined}
        tabIndex={canOpen ? 0 : undefined}
        title={canOpen ? `Open ${name || em} in People` : undefined}
        style={{ display: 'inline-flex', flexShrink: 0, cursor: canOpen ? 'pointer' : 'default' }}
      >
        {children}
      </span>
      {pos && createPortal(
        <div
          onPointerEnter={() => { overCard.current = true; clearTimeout(closeTimer.current); }}
          onPointerLeave={() => { overCard.current = false; close(); }}
          style={{
            position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom,
            width: CARD_W, zIndex: 4000, background: 'var(--card)',
            border: '1px solid var(--line)', borderRadius: 12,
            boxShadow: 'var(--shadow-lg)', padding: 14,
            font: '13px/1.45 Inter, sans-serif', color: 'var(--ink)',
          }}
        >
          {card === null ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {_cache.has(em) ? (name || em) : 'Loading...'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
                {card.photoUrl
                  ? <img src={card.photoUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 44, height: 44, borderRadius: '50%', flexShrink: 0, background: 'var(--mist)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}>
                      {(card.name || em).slice(0, 1).toUpperCase()}
                    </div>}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.name}</div>
                  {card.jobTitle && <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.jobTitle}</div>}
                  {(card.department || card.location) && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                      {[card.department, card.location].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                <a href={`mailto:${card.workEmail || em}`} style={ACTION} onClick={(e) => e.stopPropagation()}>
                  <Mail size={13} /> Email
                </a>
                <a href={`https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(card.workEmail || em)}`}
                   target="_blank" rel="noreferrer" style={ACTION} onClick={(e) => e.stopPropagation()}>
                  <MessageSquare size={13} /> Teams
                </a>
                {canOpen && (
                  <button onClick={(e) => { e.stopPropagation(); go(); }} style={{ ...ACTION, border: 'none', cursor: 'pointer' }}>
                    <User size={13} /> Profile
                  </button>
                )}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

const ACTION = {
  display: 'inline-flex', alignItems: 'center', gap: 5, flex: 1, justifyContent: 'center',
  padding: '5px 8px', borderRadius: 7, background: 'var(--mist)', color: 'var(--ink)',
  fontSize: 11.5, fontWeight: 600, textDecoration: 'none', font: 'inherit',
};
