// Favorite links on the dashboard (Neil, Oct 28 2026: "a widget that has all
// the favorite links in it from the links tab ... make sure everything is
// geometrically sound"). The bookmarks a person keeps on the Links tab, live
// from their saved Link View (backend-persisted, so they follow the account),
// every one of them - never a preview with the rest behind an "All" tile.
// Used by the Favorites widget (widgets.jsx) and the Favorites card on the
// home (DeskHome.jsx), so a link looks and opens the same in both.
//
// Geometry: a CSS grid of equal cells (auto-fill, one minimum width), each
// tile the same height - a fixed icon and a name box that is always two
// lines tall - so columns and rows line up whatever the names are. No hover
// scale: the grid sits in a scrolling card and a scaled tile would clip.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { LinkIcon } from '../components/LinkIcon.jsx';
import { pushRecentId } from '../links/shortcutStorage';

// Same accent-color scheme External Links uses (colorFor/PERSONAL_COLOR in
// ExternalLinks.jsx) - not shared as an import since it's three lines of
// pure hashing, cheaper to duplicate than to couple this file to that
// view's module. Company gets a stable per-category tone; Personal gets one
// flat purple, matching that view's own Personal badge color exactly.
const LINK_TILE_PALETTE = ['blue', 'green', 'orange', 'purple', 'red', 'gold'];
function hashLinkStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
export function colorForLinkCategory(category) {
  const tone = LINK_TILE_PALETTE[hashLinkStr(category || '') % LINK_TILE_PALETTE.length];
  return { fg: `hsl(var(--color-${tone}))`, bg: `hsla(var(--color-${tone}),0.12)` };
}
export const PERSONAL_TILE_COLOR = { fg: 'hsl(var(--color-purple))', bg: 'hsla(var(--color-purple),0.12)' };
export const favoriteColor = (l) => (l._favType === 'personal' ? PERSONAL_TILE_COLOR : colorForLinkCategory(l.category));

// The person's favorites, resolved against the Company and Personal Links
// lists (a favorite can be either; _uid keeps render keys unique since the
// two tables' ids can collide), in the order they were bookmarked. `company`
// rides along for the Recently Used trail, which only holds Company Links.
export function useFavoriteLinks() {
  const [state, setState] = useState({ loading: true, favorites: [], company: [] });
  useEffect(() => {
    let alive = true;
    Promise.all([api.getLinkLayout(), api.getExternalLinks(), api.getPersonalLinks().catch(() => [])])
      .then(([layout, company, personal]) => {
        if (!alive) return;
        const favorites = (layout?.favorites || []).map((f) => {
          const link = (f.item_type === 'personal' ? (personal || []) : (company || [])).find((l) => l.id === f.item_id);
          return link ? { ...link, _uid: `${f.item_type}-${link.id}`, _favType: f.item_type } : null;
        }).filter(Boolean);
        setState({ loading: false, favorites, company: company || [] });
      })
      .catch(() => { if (alive) setState({ loading: false, favorites: [], company: [] }); });
    return () => { alive = false; };
  }, []);
  return state;
}

// Open a link in a new tab and record the click the same way the Links tab
// does: the per-type click counter on the server and, for Company Links, the
// per-browser Recently Used trail - so the dashboard and Links stay in step.
export function openFavorite(link, myEmail) {
  window.open(link.url, '_blank', 'noopener,noreferrer');
  if (link._favType === 'personal') { api.clickPersonalLink(link.id).catch(() => {}); return; }
  api.clickExternalLink(link.id).catch(() => {});
  pushRecentId(myEmail, link.id);
}

export function FavoriteTileGrid({ links, onOpen, colorFor = favoriteColor, label = 'Favorite links' }) {
  return (
    <ul className="nx-fav-grid" aria-label={label}>
      {links.map((l) => {
        const color = colorFor(l);
        return (
          <li key={l._uid || l.id}>
            <a className="nx-fav-tile" href={l.url} target="_blank" rel="noopener noreferrer" title={l.description ? `${l.name} - ${l.description}` : l.name}
              onClick={(e) => { e.preventDefault(); onOpen(l); }}>
              <LinkIcon url={l.url} iconKey={l.icon} size={40} radius={11} fg={color.fg} bg={color.bg} />
              <span className="nx-fav-name">{l.name}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
