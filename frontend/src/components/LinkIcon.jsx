import { useState, useMemo } from 'react';
import { API_BASE } from '../api';
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

// Logos come from OUR OWN origin first (backend caches one fetch per domain in
// link_icons). They used to be fetched straight from icon.horse by every tile:
// 50+ links means 50+ simultaneous requests to a free service, per employee,
// per page view, all from one office egress IP - and it rate-limits per IP, so
// most tiles came back HTTP 429 and dropped to the generic glyph, differently
// each time (Charmi/Neil, Aug 31). Going through the backend makes that 50
// requests in total rather than 50 per person per view, and it can't be
// throttled out from under the grid.
//
// The two third-party resolvers stay as fallbacks, for the cases the cache
// can't serve: a local dev backend without the table, an unauthenticated
// image request, or a domain the cache has no logo for. Clearbit is gone
// entirely (logo.clearbit.com stopped resolving, Aug 2026). icon.horse serves
// a site's real high-res mark; Google's faviconV2 is the last try, with
// `fallback_opts` deliberately empty so an unknown domain 404s instead of
// quietly returning Google's generic globe as though it were a real logo -
// that 404 is what lets onError reach our own brand-colored lucide icon.
function logoSources(url, size) {
  try {
    const hostname = new URL(url).hostname;
    return [
      `${API_BASE}/external-links/icon?d=${encodeURIComponent(hostname)}`,
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
