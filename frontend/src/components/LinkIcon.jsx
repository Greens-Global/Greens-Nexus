import { useState, useMemo } from 'react';
import {
  Link2, Mail, Calendar, Users2, FolderKanban, Rocket, MessagesSquare, BookOpen,
  HelpCircle, Clock, FileSpreadsheet, Zap, Wifi, Landmark, Wallet, Building2,
  Newspaper, GraduationCap, LineChart, Briefcase, Shield, Globe, Megaphone,
  HardHat, Ruler, CreditCard, PiggyBank, Receipt, ClipboardList, Headphones,
  Video, CheckSquare, Cloud, Presentation, Gauge, Bird, Warehouse,
} from 'lucide-react';

// Shared with ExternalLinks.jsx (the admin icon picker there uses the same
// keys) and any other surface that needs to render a link's icon the same
// way - the Dashboard's Links Folder widget (Aug 14, "i want the same
// folder style in dashboard as we have in external links") pulled this out
// of ExternalLinks.jsx rather than re-implementing favicon resolution a
// second time, which would drift the two the next time one of them changes.
export const ICON_MAP = {
  Link2, Mail, Calendar, Users2, FolderKanban, Rocket, MessagesSquare, BookOpen,
  HelpCircle, Clock, FileSpreadsheet, Zap, Wifi, Landmark, Wallet, Building2,
  Newspaper, GraduationCap, LineChart, Briefcase, Shield, Globe, Megaphone,
  HardHat, Ruler, CreditCard, PiggyBank, Receipt, ClipboardList, Headphones, Video,
  CheckSquare, Cloud, Presentation, Gauge, Bird, Warehouse,
};
export const iconFor = (key) => ICON_MAP[key] || Link2;

// Clearbit's free logo API was shut down (logo.clearbit.com no longer
// resolves at all, Aug 2026) - it used to be the first choice here because it
// served the actual brand mark at real resolution. icon.horse is first now:
// it resolves a site's real high-res logo/favicon (up to 180x180, not just
// whatever tiny favicon.ico the site declared) and serves it from its own
// host with no redirect, so it doesn't need a second CSP img-src entry the
// way the old www.google.com/s2/favicons fallback did (that endpoint
// redirects to a *different* host, t1.gstatic.com, which CSP checks against
// instead of the one that was actually requested). Google's faviconV2 stays
// as the second attempt for the handful of domains icon.horse doesn't have -
// `fallback_opts` deliberately omits `TYPE` so a domain with nothing on file
// 404s instead of silently returning Google's generic globe glyph as if it
// were a real logo; the 404 is what lets onError fall through to our own
// (nicer, brand-colored) lucide icon instead of that globe.
function logoSources(url, size) {
  try {
    const hostname = new URL(url).hostname;
    return [
      `https://icon.horse/icon/${hostname}`,
      `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=&url=https://${hostname}&size=${size}`,
    ];
  } catch {
    return [];
  }
}

// Every link tile (External Links grid, folder tiles, palette results,
// Manage rows, the Dashboard Links Folder widget) renders the actual site
// logo rather than the admin-picked lucide glyph - real site logos read far
// more recognizable at a glance ("that's the ADP logo") than a generic
// folder/globe icon, and only falls back to the curated lucide glyph once
// every image source has failed to load (network blocked, ad blocker,
// unrecognized domain, etc - `iconKey` stays on the model for that).
export function LinkIcon({ url, iconKey, size = 42, iconSize, radius = 12, fg, bg, gradient = true }) {
  const sources = useMemo(() => logoSources(url, Math.max(size * 3, 128)), [url, size]);
  const [attempt, setAttempt] = useState(0);
  const src = attempt < sources.length ? sources[attempt] : null;
  const Fallback = iconFor(iconKey);
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, color: fg, flexShrink: 0, overflow: 'hidden',
      background: gradient ? `linear-gradient(135deg, ${bg}, ${bg} 40%, transparent)` : bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {src ? (
        <img
          key={src} src={src} alt="" width={Math.round(size * 0.68)} height={Math.round(size * 0.68)}
          style={{ objectFit: 'contain' }} onError={() => setAttempt(a => a + 1)}
        />
      ) : (
        <Fallback size={iconSize || Math.round(size * 0.5)} />
      )}
    </div>
  );
}
