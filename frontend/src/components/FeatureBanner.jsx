import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
// answers, and See What's New loads the new version straight onto What's New.
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
const RELEASE_POLL_MS = 2 * 60 * 1000;
// Updates publish within minutes of the merge; ~20 minutes of asking covers it.
const RELEASE_MAX_CHECKS = 10;
// Removal follows the fold's own animationend; this only catches a browser
// that never sends one (an animation turned off another way).
const CLOSE_FALLBACK_MS = 1000;
// A reload the person cancelled at the browser's "Leave site?" prompt
// (unsaved work elsewhere) never unloads the page: the buttons come back.
const RELOAD_RECOVER_MS = 4000;

export default function FeatureBanner({ activeView, onNavigate }) {
  const [banner, setBanner] = useState(null);
  const [closing, setClosing] = useState(null);       // the mode folding away
  const [updateHidden, setUpdateHidden] = useState(false);
  const [release, setRelease] = useState(null);       // { counts, total } the waiting version brings
  const [reloading, setReloading] = useState(false);
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
  // stale, and again for a while, because an update is published a few
  // minutes after its merge lands.
  const stale = useBuildVersion();
  useEffect(() => {
    if (!stale) return undefined;
    let live = true;
    let checks = 0;
    const check = () => {
      checks += 1;
      if (checks >= RELEASE_MAX_CHECKS) clearInterval(timer);
      return api.getReleasedSince(RUNNING_SINCE)
        .then((r) => { if (live && r) setRelease(r.total > 0 ? { counts: r.counts || {}, total: r.total } : null); })
        .catch(() => {});
    };
    const timer = setInterval(check, RELEASE_POLL_MS);
    check();
    return () => { live = false; clearInterval(timer); };
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
  // A full load, not in-app navigation: the new version, opened on What's New.
  const seeWhatsNew = update
    ? () => go(() => window.location.assign('/whats-new'))
    : () => onNavigate?.('whats-new');
  const reload = () => go(() => window.location.reload());

  const counts = update ? release?.counts : banner.counts;
  const parts = counts ? categoryParts(counts) : [];
  // The new version knows what it brings only once the server answers; until
  // then the bar offers Reload alone.
  const hasNews = parts.length > 0;
  // The label already says "New Version", so the desktop line leads with
  // what to do about it.
  const lead = update
    ? (hasNews ? 'Reload to get the latest version of Nexus, including ' : 'Reload to get the latest version of Nexus whenever it suits you.')
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
          {update && (
            <button type="button" className="feature-banner-cta feature-banner-reload" onClick={reload} disabled={reloading}>
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
    </div>
  );
}
