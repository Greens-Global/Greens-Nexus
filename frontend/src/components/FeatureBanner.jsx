import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ArrowRight, RefreshCw, X } from 'lucide-react';
import { api } from '../api';
import { RUNNING_SINCE, useBuildVersion } from '../lib/useBuildVersion';
import { categoryParts, partJoiner } from '../lib/changelogCategories';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { prefersReducedMotion } from '../lib/reducedMotion';

// The one announcement bar: a full-width Nexus-green strip across the top of
// the page (Neil, Oct 12 2026). It has two jobs, one at a time (Oct 14: the
// bottom "new version" popup and the header's eye icon folded into it - one
// place says "there is something new", not four):
//
// NEW FEATURE - the weekly "New in Nexus" news. Speaks in categories only -
// "Updates this week, including 2 New Features and 3 Bug Fixes", the counts in
// bold - and leaves the details to What's New. The message is a way in too,
// not only the button. The same news is kept in the notification bell
// (server: _whats_new_notice), so a person who dismissed the bar can still
// find it there. Once a week, decided by the server (GET
// /task-changelog/feature-banner): only for a New Feature released in the last
// 7 days that this person has not already seen, and never within 7 days of
// their last dismissal. Dismissing it or opening What's New closes it for the
// week, on every device. Asked on load and every half hour while the tab is
// visible, so a tab left open all week still hears about a mid-week release.
//
// NEW VERSION - this tab is running code a deploy has replaced
// (lib/useBuildVersion.js). Cloudflare deletes the old chunks on a deploy, so
// a stale tab breaks the first time it opens a screen it has not loaded yet;
// this asks the person to Reload at a moment of their choosing. Never
// automatic - a forced reload mid-form would throw their typing away. It
// takes the bar over from the weekly news (reloading brings that news with
// it), says what the waiting version brings by category once the server
// answers, and See What's New opens those updates in a popup (ReleasePopup,
// Oct 29 2026 - it used to reload the tab onto What's New).
// Its X hides it for this tab only: the next load is the new version anyway.
//
// Phones (style.css): one row, two lines of message at most, and the whole
// message opens What's New. The weekly news shrinks See What's New to a white
// arrow square; a new version drops that square altogether (the message is
// the way in) so Reload can keep its word - an icon alone does not say
// "reload the app" - without squeezing the message to one word a line.
//
// Motion (style.css "New in Nexus bar"): it opens by growing to its height,
// the icon pops once and, once it has settled, a single soft flash of light
// crosses it (Neil, Oct 28 2026: "a subtle flash moving through the bar
// once ... cool and classy") - again whenever a new version takes the bar
// over, since the flash rides on the keyed row. It folds away on close.
// Transform/opacity plus that one height change, nothing loops, and reduced
// motion turns all of it off.
const RECHECK_MS = 30 * 60 * 1000;
// Updates publish automatically after their merge (changelog_auto.py: 5
// minutes after it, up to 30 when merges come in a burst, and the 15-minute
// sweep when GitHub's push notice is missed), so the first ~20 minutes are
// asked every 2 minutes and after that every 10 for as long as the tab stays
// stale - the bar always comes to list what the version brings instead of
// giving up on the plain line (Neil, Oct 30 2026). Only while the tab is
// visible.
const RELEASE_POLL_MS = 2 * 60 * 1000;
const RELEASE_FAST_CHECKS = 10;
const RELEASE_SLOW_POLL_MS = 10 * 60 * 1000;
// Removal follows the fold's own animationend; this only catches a browser
// that never sends one (an animation turned off another way).
const CLOSE_FALLBACK_MS = 1000;
// A reload the person cancelled at the browser's "Leave site?" prompt
// (unsaved work elsewhere) never unloads the page: the buttons come back.
const RELOAD_RECOVER_MS = 4000;

// See What's New on a NEW VERSION opens this popup (Oct 29 2026, Neil agreed:
// "should not reload the whole Nexus"): the updates the waiting version brings,
// listed from GET /task-changelog/released-since, with Reload beside them.
// It lives in this file on purpose - an out-of-date tab cannot load a screen
// it has not loaded yet (the deploy deleted those files), so the popup uses
// nothing but what the bar already has. Grouped by category in reading order.
const TYPE_ORDER = ['New Feature', 'Improvement', 'Performance', 'Security Update', 'Bug Fix', 'Hotfix', 'Maintenance'];

// `weekly`: the weekly news (this version's own updates) - worded for it, with a
// way on to the full What's New page; a new version cannot open that page.
function ReleasePopup({ items, total, onClose, onReload, reloading, weekly = false, onSeeAll }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const groups = [];
  const byType = {};
  (items || []).forEach((it) => { (byType[it.type] = byType[it.type] || []).push(it); });
  [...TYPE_ORDER, ...Object.keys(byType).filter((t) => !TYPE_ORDER.includes(t))].forEach((t) => {
    if (byType[t]?.length) groups.push({ type: t, label: categoryParts({ [t]: byType[t].length })[0]?.label || t, rows: byType[t] });
  });
  const more = Math.max(0, (total || 0) - (items || []).length);
  // Into the body: the bar animates with transforms, which would trap a
  // fixed overlay inside it.
  return createPortal(
    <div className="nx-overlay" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="nx-release-title" onClick={(e) => e.stopPropagation()}
        style={{ width: '60vw', minWidth: 'min(420px, 100%)', maxWidth: '100%', minHeight: '60vh', maxHeight: '85vh',
          background: 'var(--nx-surface, #fff)', color: 'var(--nx-ink, #0f172a)', borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Inter, sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--nx-border, #e5e7eb)' }}>
          <Sparkles size={18} style={{ color: '#1f7a40' }} aria-hidden="true" />
          <div style={{ flex: 1 }}>
            <div id="nx-release-title" style={{ fontSize: 17, fontWeight: 700 }}>{weekly ? <>What&apos;s New This Week</> : <>What&apos;s New in This Version</>}</div>
            <div style={{ fontSize: 13, color: 'var(--nx-dim, #64748b)' }}>{weekly ? 'The updates released to Nexus this week.' : 'Reload when you are ready to start using these. Nothing changes until you do.'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 6, color: 'inherit' }}><X size={18} /></button>
        </div>
        <div className="nx-fill" style={{ flex: 1, overflowY: 'auto', padding: '8px 20px 16px' }}>
          {groups.length === 0 && <div style={{ padding: '24px 0', color: 'var(--nx-dim, #64748b)', fontSize: 14 }}>The details are still being published. Reload to get the new version.</div>}
          {groups.map((g) => (
            <section key={g.type} style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--nx-dim, #64748b)', marginBottom: 6 }}>
                {g.rows.length} {g.label}
              </div>
              {g.rows.map((it) => (
                <div key={it.id} style={{ padding: '10px 0', borderTop: '1px solid var(--nx-border, #eef0f3)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14.5, fontWeight: 600 }}>{it.title}</span>
                    {it.module && <span style={{ fontSize: 11.5, fontWeight: 600, color: '#1f7a40', background: '#e7f4ec', borderRadius: 999, padding: '1px 8px' }}>{it.module}</span>}
                  </div>
                  {it.summary && <div style={{ fontSize: 13.5, color: 'var(--nx-dim, #475569)', marginTop: 3, lineHeight: 1.45 }}>{it.summary}</div>}
                </div>
              ))}
            </section>
          ))}
          {more > 0 && <div style={{ marginTop: 14, fontSize: 13, color: 'var(--nx-dim, #64748b)' }}>And {more} more - see them all on What&apos;s New{weekly ? '' : ' after you reload'}.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid var(--nx-border, #e5e7eb)' }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--nx-border, #d1d5db)', background: 'transparent', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}>{weekly ? 'Close' : 'Later'}</button>
          {weekly && onSeeAll && <button type="button" onClick={onSeeAll} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--nx-border, #d1d5db)', background: 'transparent', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}>See All on What&apos;s New</button>}
          <button type="button" onClick={onReload} disabled={reloading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 0, background: '#1f7a40', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
            <RefreshCw size={14} aria-hidden="true" />{reloading ? 'Reloading…' : 'Reload Now'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function FeatureBanner({ activeView, onNavigate }) {
  const [banner, setBanner] = useState(null);
  const [closing, setClosing] = useState(null);       // the mode folding away
  const [updateHidden, setUpdateHidden] = useState(false);
  const [release, setRelease] = useState(null);       // { counts, total } the waiting version brings
  const [reloading, setReloading] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);   // See What's New on a new version
  const rowRef = useRef(null);
  const closeTimer = useRef(null);
  const reloadTimer = useRef(null);
  // One dismissal per session, however the weekly bar goes away (its X, its
  // link, or opening What's New another way) - and a recheck answering "show"
  // while that dismissal is still in flight does not bring it back.
  const dismissed = useRef(false);
  useEffect(() => () => { clearTimeout(closeTimer.current); clearTimeout(reloadTimer.current); }, []);

  useEffect(() => {
    let live = true;
    const check = () => api.getFeatureBanner()
      .then((r) => { if (live && r?.show && r.total > 0 && !dismissed.current) setBanner(r); })
      .catch(() => {});
    check();
    const stop = pollWhileVisible(check, RECHECK_MS);
    return () => { live = false; stop(); };
  }, []);

  // Reaching What's New - through the bar's link or any other route - is
  // what closes the weekly news for the week. The link itself only navigates,
  // so a move cancelled at the unsaved-changes prompt leaves the bar as it was.
  const onWhatsNew = activeView === 'whats-new';
  useEffect(() => {
    if (!onWhatsNew || !banner) return;
    const first = !dismissed.current;
    dismissed.current = true;
    (first ? api.dismissFeatureBanner().catch(() => {}) : Promise.resolve()).finally(() => setBanner(null));
  }, [onWhatsNew, banner]);

  // What does the version waiting for this tab bring? Asked once the build is
  // stale and again until the tab reloads - an update is published minutes
  // after its merge lands, and a later merge adds to the list.
  const stale = useBuildVersion();
  useEffect(() => {
    if (!stale) return undefined;
    let live = true;
    let checks = 0;
    let stopSlow = null;
    const check = () => {
      checks += 1;
      if (checks === RELEASE_FAST_CHECKS) {
        clearInterval(timer);
        stopSlow = pollWhileVisible(check, RELEASE_SLOW_POLL_MS);
      }
      return api.getReleasedSince(RUNNING_SINCE)
        .then((r) => { if (live && r) setRelease(r.total > 0 ? { counts: r.counts || {}, total: r.total, items: r.items || [] } : null); })
        .catch(() => {});
    };
    const timer = setInterval(() => { if (document.visibilityState === 'visible') check(); }, RELEASE_POLL_MS);
    check();
    return () => { live = false; clearInterval(timer); stopSlow?.(); };
  }, [stale]);

  // A new version outranks the weekly news: reloading brings the news with
  // it, and the What's New this tab would open is the old one. It stays up on
  // What's New too - that page is just as stale.
  const mode = stale ? (updateHidden ? null : 'update') : (banner && !onWhatsNew ? 'feature' : null);
  const visible = !!mode;

  // The full-height views (Tasks, Tickets, What's New, PDF Tools) size
  // themselves to the viewport under the header; --nx-announce-h takes this
  // bar's height off them too. It is measured on the ROW - its natural
  // height, which does not animate - so the heavy views relayout once when
  // the bar arrives and once when it goes, not on every frame of the fold.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = rowRef.current;
    if (!visible || !el) return undefined;
    const set = () => root.style.setProperty('--nx-announce-h', `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--nx-announce-h'); };
  }, [visible, mode]);

  if (!visible) return null;

  const hide = (which) => { if (which === 'update') setUpdateHidden(true); else setBanner(null); };
  const finishClose = () => {
    clearTimeout(closeTimer.current);
    hide(closing);
    setClosing(null);
  };
  const close = () => {
    if (closing) return;
    // Only the weekly news is dismissed on the server; a new version is
    // hidden for this tab alone.
    if (mode === 'feature' && !dismissed.current) {
      dismissed.current = true;
      api.dismissFeatureBanner().catch(() => {});
    }
    if (prefersReducedMotion()) { hide(mode); return; }
    setClosing(mode);
    closeTimer.current = setTimeout(finishClose, CLOSE_FALLBACK_MS);
  };
  // The bar's own fold ending (not the sheen's, which is on ::after).
  const onAnimationEnd = (e) => {
    if (closing && e.target === e.currentTarget && !e.pseudoElement) finishClose();
  };

  const go = (navigate) => {
    setReloading(true);
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => setReloading(false), RELOAD_RECOVER_MS);
    navigate();
  };
  const update = mode === 'update';
  // See What's New opens the popup in both modes and never reloads (Oct 29-30
  // 2026, Neil agreed); Reload is its own button on both. Opening the weekly
  // news counts as seeing it for the week, as reaching What's New does.
  const seeWhatsNew = () => {
    if (!update && !dismissed.current) {
      dismissed.current = true;
      api.dismissFeatureBanner().catch(() => {});
    }
    setPopupOpen(true);
  };
  // Closing the weekly popup folds the bar away - it has been seen.
  const closePopup = () => { setPopupOpen(false); if (!update) close(); };
  const reload = () => go(() => window.location.reload());

  const counts = update ? release?.counts : banner.counts;
  const parts = counts ? categoryParts(counts) : [];
  // The new version knows what it brings only once its updates are published
  // (see RELEASE_POLL_MS); until then, or for a version with nothing a person
  // would notice (CI, docs, tests), the bar offers Reload alone - one plain
  // line, never "whenever it suits you" (Neil, Oct 30 2026).
  const hasNews = parts.length > 0;
  // The label already says "New Version", so the desktop line leads with
  // what to do about it.
  const lead = update
    ? (hasNews ? 'Reload to get the latest version of Nexus, including ' : 'Reload to get the latest version of Nexus.')
    : 'Updates this week, including ';
  const leadShort = update ? (hasNews ? 'New Version: ' : 'A New Version is ready.') : 'Including ';
  const message = `${lead}${parts.map((p, i) => `${p.count} ${p.label}${partJoiner(i, parts.length)}`).join('')}`;
  // A new version is always the refresh arrows (they turn once as the bar
  // lands - Neil, Oct 28 2026); the weekly news keeps the sparkle.
  const Icon = update ? RefreshCw : Sparkles;

  return (
    <div role="region" aria-label={update ? 'New Version of Nexus' : 'New in Nexus'}
      onAnimationEnd={onAnimationEnd}
      className={`feature-banner is-${mode}${closing ? ' is-closing' : ''}`}>
      <div className="feature-banner-clip">
        {/* Keyed by mode, so the content and its icon arrive afresh when a
            new version takes the bar over from the weekly news. */}
        <div className="feature-banner-row" ref={rowRef} key={mode}>
          <Icon key={hasNews ? 'known' : 'unknown'} size={17} className="feature-banner-icon" aria-hidden="true" />
          <span className="feature-banner-label">{update ? 'New Version' : 'New in Nexus'}</span>
          <span className="feature-banner-rule" aria-hidden="true" />
          {/* The message opens What's New too - a bigger target than the
              button; the button stays the keyboard and screen-reader way in. */}
          <p className={`feature-banner-text${hasNews ? '' : ' is-plain'}`} title={message}
            onClick={hasNews && !reloading ? seeWhatsNew : undefined}>
            {/* Phones get the short lead-in - the long one pushed the last
                category out of two lines. */}
            <span className="feature-banner-lead">{lead}</span>
            <span className="feature-banner-lead-short">{leadShort}</span>
            {parts.map((p, i) => (
              <span key={p.label}>
                <strong className="feature-banner-count">{p.count} {p.label}</strong>{partJoiner(i, parts.length)}
              </span>
            ))}
          </p>
          {hasNews && (
            <button type="button" className={`feature-banner-cta${update ? ' is-quiet' : ''}`}
              onClick={seeWhatsNew} disabled={reloading} aria-label="See What's New">
              <span className="feature-banner-cta-long">See What&apos;s New</span>
              <span className="feature-banner-cta-short">What&apos;s New</span>
              <ArrowRight size={15} className="feature-banner-cta-arrow" aria-hidden="true" />
            </button>
          )}
          {/* Reload on both bars (Oct 30 2026): anyone can reload by hand. */}
          {(update || hasNews) && (
            <button type="button" className={`feature-banner-cta feature-banner-reload${update ? '' : ' is-quiet'}`} onClick={reload} disabled={reloading}>
              <RefreshCw size={14} className={reloading ? 'feature-banner-spin' : undefined} aria-hidden="true" />
              {reloading ? 'Reloading…' : 'Reload'}
            </button>
          )}
          <button type="button" className="feature-banner-close" onClick={close}
            aria-label={update ? 'Dismiss' : 'Dismiss for this week'}
            title={update ? 'Dismiss - Reload whenever you are ready' : 'Dismiss for this week'}>
            <X size={17} />
          </button>
        </div>
      </div>
      {popupOpen && (
        <ReleasePopup weekly={!update} items={update ? release?.items : banner?.items}
          total={update ? release?.total : banner?.total} reloading={reloading}
          onClose={closePopup} onReload={reload}
          onSeeAll={() => { setPopupOpen(false); onNavigate?.('whats-new'); }} />
      )}
    </div>
  );
}
