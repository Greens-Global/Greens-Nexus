import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sparkles, ArrowRight, X } from 'lucide-react';
import { api } from '../api';
import { RUNNING_SINCE, setReleaseSummary, useUpdateSignal } from '../lib/updateSignal';
import { categoryParts, partJoiner } from '../lib/changelogCategories';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { prefersReducedMotion } from './shifts/motion';

// The weekly "New in Nexus" bar (Neil, Oct 12 2026): a full-width Nexus-green
// strip across the top of the page, raised by a New Feature, linking to
// What's New. It speaks in categories only - "Updates this week, including
// 2 New Features and 3 Bug Fixes", the counts in bold - and leaves the details
// to What's New. The message is a way in too, not only the button. The same
// news is kept in the notification bell (server: _whats_new_notice), so a
// person who dismissed the bar can still find it there.
//
// Once a week, decided by the server (GET /task-changelog/feature-banner):
// only for a New Feature released in the last 7 days that this person has not
// already seen, and never within 7 days of their last dismissal. Dismissing it
// or opening What's New (by its link or any other way) closes it for the week,
// on every device. Asked on load and again every half hour while the tab is
// visible, so a tab left open all week still hears about a mid-week release.
// Everyone signed in sees it - reading What's New is every user's default.
//
// Motion (style.css "New in Nexus bar"): it opens by growing to its height,
// the sparkle pops once and a single sheen crosses it; it folds away on close.
// Transform/opacity plus that one height change, nothing loops, and reduced
// motion turns all of it off.
//
// It also answers the "new version" popup (UpdateBanner): when this tab's
// build is stale, it asks what the waiting version brings, by category.
const RECHECK_MS = 30 * 60 * 1000;
const RELEASE_POLL_MS = 2 * 60 * 1000;
// Updates publish within minutes of the merge; ~20 minutes of asking covers it.
const RELEASE_MAX_CHECKS = 10;
const CLOSE_MS = 300;   // matches .feature-banner.is-closing in style.css

export default function FeatureBanner({ activeView, onNavigate }) {
  const [banner, setBanner] = useState(null);
  const [closing, setClosing] = useState(false);
  const ref = useRef(null);
  const closeTimer = useRef(null);
  // One dismissal per session, however the bar goes away (its X, its link,
  // or opening What's New another way) - and a recheck answering "show"
  // while that dismissal is still in flight does not bring it back.
  const dismissed = useRef(false);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

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
  // what closes it for the week. The link itself only navigates, so a move
  // cancelled at the unsaved-changes prompt leaves the bar as it was.
  const onWhatsNew = activeView === 'whats-new';
  useEffect(() => {
    if (!onWhatsNew || !banner) return;
    const first = !dismissed.current;
    dismissed.current = true;
    (first ? api.dismissFeatureBanner().catch(() => {}) : Promise.resolve()).finally(() => setBanner(null));
  }, [onWhatsNew, banner]);

  const visible = !!banner && !onWhatsNew;

  // The full-height views (Tasks, Tickets, What's New, PDF Tools) size
  // themselves to the viewport under the header; --nx-announce-h takes this
  // bar's height off them too - live, so they follow it as it opens and folds.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!visible || !el) return undefined;
    const set = () => root.style.setProperty('--nx-announce-h', `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set);
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--nx-announce-h'); };
  }, [visible]);

  // The popup's question: what does the version waiting for this tab bring?
  // Asked once the build is stale, and again for a while, because an update
  // is published a few minutes after its merge lands.
  const { stale } = useUpdateSignal();
  useEffect(() => {
    if (!stale) return undefined;
    let live = true;
    let checks = 0;
    const check = () => {
      checks += 1;
      if (checks >= RELEASE_MAX_CHECKS) clearInterval(timer);
      return api.getReleasedSince(RUNNING_SINCE)
        .then((r) => { if (live && r) setReleaseSummary(r); })
        .catch(() => {});
    };
    const timer = setInterval(check, RELEASE_POLL_MS);
    check();
    return () => { live = false; clearInterval(timer); };
  }, [stale]);

  if (!visible) return null;

  const close = () => {
    if (closing) return;
    if (!dismissed.current) {
      dismissed.current = true;
      api.dismissFeatureBanner().catch(() => {});
    }
    if (prefersReducedMotion()) { setBanner(null); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => { setBanner(null); setClosing(false); }, CLOSE_MS);
  };

  const parts = categoryParts(banner.counts);
  return (
    <div ref={ref} role="region" aria-label="New in Nexus" className={`feature-banner${closing ? ' is-closing' : ''}`}>
      <div className="feature-banner-clip">
        <div className="feature-banner-row">
          <Sparkles size={17} className="feature-banner-icon" aria-hidden="true" />
          <span className="feature-banner-label">New in Nexus</span>
          <span className="feature-banner-rule" aria-hidden="true" />
          {/* The message opens What's New too - a bigger target than the
              button; the button stays the keyboard and screen-reader way in. */}
          <p className="feature-banner-text" onClick={() => onNavigate?.('whats-new')}>
            {/* Phones start at "Including" - the lead-in pushed the last
                category out of two lines. */}
            <span className="feature-banner-lead">Updates this week, including </span>
            <span className="feature-banner-lead-short">Including </span>
            {parts.map((p, i) => (
              <span key={p.label}>
                <strong className="feature-banner-count">{p.count} {p.label}</strong>{partJoiner(i, parts.length)}
              </span>
            ))}
          </p>
          <button type="button" className="feature-banner-cta" onClick={() => onNavigate?.('whats-new')} aria-label="See What's New">
            <span className="feature-banner-cta-long">See What&apos;s New</span>
            <span className="feature-banner-cta-short">What&apos;s New</span>
            <ArrowRight size={15} className="feature-banner-cta-arrow" aria-hidden="true" />
          </button>
          <button type="button" className="feature-banner-close" onClick={close} aria-label="Dismiss for this week" title="Dismiss for this week">
            <X size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
