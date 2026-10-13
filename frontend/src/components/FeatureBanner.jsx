import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sparkles, ArrowRight, X } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { canOpenWhatsNew } from '../lib/whatsNewAccess';
import { LOADED_AT, setNewFeature, useUpdateSignal } from '../lib/updateSignal';

// The weekly "New in Nexus" bar (Neil, Oct 12 2026): a full-width Nexus-green
// strip across the top of the page when a New Feature has been released,
// linking to What's New. Bug fixes alone never raise it.
//
// Once a week, decided by the server (GET /task-changelog/feature-banner):
// only a New Feature released in the last 7 days that this person has not
// already seen - by opening What's New or by this bar - and never again within
// 7 days of their last dismissal. Dismissing, following the link, or opening
// What's New any other way all close it for the week, on every device.
//
// It also answers the "new version" popup (UpdateBanner): when this tab's
// build is stale, it checks whether a New Feature was released since the tab
// loaded, so the popup can offer See What's New.
const NEW_FEATURE_POLL_MS = 2 * 60 * 1000;
// Updates publish within minutes of the merge; after ~20 minutes a version
// with no New Feature is taken to have none, and the asking stops.
const NEW_FEATURE_MAX_CHECKS = 10;

export default function FeatureBanner({ activeView, onNavigate }) {
  const role = useRole() || {};
  const allowed = canOpenWhatsNew(role);
  const [banner, setBanner] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    api.getFeatureBanner().then((r) => { if (live && r?.show && r.feature) setBanner(r); }).catch(() => {});
    return () => { live = false; };
  }, [allowed]);

  // Opening What's New by any route counts as having seen this week's news.
  const onWhatsNew = activeView === 'whats-new';
  useEffect(() => {
    if (!onWhatsNew || !banner) return;
    api.dismissFeatureBanner().catch(() => {}).finally(() => setBanner(null));
  }, [onWhatsNew, banner]);

  const visible = !!banner && !onWhatsNew;

  // The full-height views (Tasks, Tickets, What's New, PDF Tools) size
  // themselves to the viewport under the header; --nx-announce-h takes this
  // bar's height off them too, so it never pushes them past the bottom.
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

  // The popup's question: does the version waiting for this tab bring a New
  // Feature? Asked only once the build is stale, and re-asked for a while,
  // because the update is published a few minutes after the merge lands.
  const { stale, newFeature } = useUpdateSignal();
  useEffect(() => {
    if (!stale || newFeature || !allowed) return undefined;
    let live = true;
    let checks = 0;
    const check = () => {
      checks += 1;
      if (checks >= NEW_FEATURE_MAX_CHECKS) clearInterval(timer);
      return api.getNewFeatures(LOADED_AT)
        .then((r) => { if (live && r?.count > 0) setNewFeature(true); })
        .catch(() => {});
    };
    const timer = setInterval(check, NEW_FEATURE_POLL_MS);
    check();
    return () => { live = false; clearInterval(timer); };
  }, [stale, newFeature, allowed]);

  if (!visible) return null;
  const dismiss = () => { setBanner(null); api.dismissFeatureBanner().catch(() => {}); };
  const open = () => { dismiss(); onNavigate?.('whats-new'); };
  const { feature, more = 0 } = banner;

  return (
    <div ref={ref} role="region" aria-label="New in Nexus" className="feature-banner">
      <Sparkles size={16} className="feature-banner-icon" aria-hidden="true" />
      <span className="feature-banner-text">
        <strong>New in Nexus:</strong> {feature.title}{more > 0 ? ` and ${more} more` : ''}
      </span>
      <button type="button" className="feature-banner-cta" onClick={open}>
        See What&apos;s New <ArrowRight size={14} aria-hidden="true" />
      </button>
      <button type="button" className="feature-banner-close" onClick={dismiss} aria-label="Dismiss for this week" title="Dismiss for this week">
        <X size={16} />
      </button>
    </div>
  );
}
