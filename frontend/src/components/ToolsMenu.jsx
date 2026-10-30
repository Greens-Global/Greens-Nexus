// The profile menu's Tools section (Neil, Oct 25 2026): Insights (moved off
// the left menu, Neil, Oct 29 2026), Act As, then Build Mode and Testing -
// one "Tools" label, no subheadings - each row shown only to
// people who can use it - the same checks the server enforces - and the
// whole section absent for everyone else. Act As is a people finder inside
// the menu (no modal, no screen): the menu swaps to it, nobody is listed
// until something is typed, at most 5 rows show, and every typed word may
// match a name, email, title, department, company, site or role.
import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FlaskConical, UserCog, Wrench, Search } from 'lucide-react';
import { api } from '../api';
import { useRole, ROLES } from '../contexts/RoleContext';
import { useBuildModeMenu } from '../devnotes/BuildModeChip';
import { NAV, isNavItemVisible } from './Sidebar';
import { findPeople } from '../lib/peopleSearch';
import { useListNav } from '../lib/listNav';
import { usePhotoMap } from '../lib/peoplePhotos';
import { isTypingTarget } from '../lib/keys';
import { formatTime } from '../lib/datetime';
import { LoadingState } from './AsyncState';
import InsightsChart from './icons/InsightsChart';

const TESTING_NAV = NAV.find((item) => item.view === 'testing');
const INSIGHTS_NAV = NAV.find((item) => item.view === 'bi');
const SHOWN = 5;
const FIELDS = ['title', 'department', 'company', 'site', 'roleLabel'];
const RECENT_KEY = 'nexus:act-as-recent';
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const BUILD_KEYS = MAC ? '⌘ ⇧ .' : 'Ctrl Shift .';   // devnotes/lib/hotkeys.js isToggleHotkey

// Last 3 people acted as - this browser only, a convenience.
function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => typeof e === 'string').slice(0, 3) : [];
  } catch { return []; }
}
function saveRecent(email) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([email, ...readRecent().filter((e) => e !== email)].slice(0, 3))); }
  catch { /* storage blocked - recents are optional */ }
}

function Avatar({ p, photo }) {
  if (photo) return <img src={photo} alt="" loading="lazy" className="hud-av" />;
  const ini = (p.name || p.email || '?').split(/\s+/).map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  return <span className="hud-av hud-av--ini">{ini}</span>;
}

export function ActAsFinder({ onBack }) {
  const { startActAs } = useRole();
  const photos = usePhotoMap();
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [starting, setStarting] = useState('');
  const [error, setError] = useState('');
  const listId = useId();

  useEffect(() => {
    let live = true;
    api.getActAsEligibleTargets()
      .then((list) => { if (live) setPeople((list || []).map((p) => ({ ...p, roleLabel: ROLES[p.role]?.label || '' }))); })
      .catch(() => { if (live) { setPeople([]); setError("Couldn't load the people list."); } });
    return () => { live = false; };
  }, []);

  const typed = !!q.trim();
  const found = useMemo(() => findPeople(people || [], q, { fields: FIELDS, limit: SHOWN }), [people, q]);
  const recent = useMemo(() => {
    if (typed || !people) return [];
    const by = new Map(people.map((p) => [p.email, p]));
    return readRecent().map((e) => by.get(e)).filter(Boolean);
  }, [people, typed]);
  const rows = typed ? found.list : recent;
  const nav = useListNav(rows, { open: rows.length > 0, query: q, onPick: pick });

  async function pick(p) {
    if (!p || starting) return;
    setStarting(p.email);
    setError('');
    try {
      await startActAs(p.email);   // reloads the app as them
      saveRecent(p.email);
    } catch (err) {
      setError(err?.message || "Couldn't start Act As.");
      setStarting('');
    }
  }

  return (
    <div className="hud-actas" data-testid="act-as-finder">
      <div className="hud-actas-head">
        <button type="button" className="hud-back" onClick={onBack} aria-label="Back to menu"><ChevronLeft size={15} /></button>
        <span>Act As</span>
        {people && people.length > 0 && <span className="hud-actas-count">{people.length} {people.length === 1 ? 'person' : 'people'}</span>}
      </div>
      <label className="hud-actas-search">
        <Search size={14} aria-hidden="true" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, title, company or site"
          aria-label="Find a person to act as" aria-controls={listId} {...nav.inputProps} onKeyDown={nav.onKeyDown} />
      </label>
      {error && <div className="hud-actas-msg hud-actas-msg--err">{error}</div>}
      <div className={`hud-actas-zone${typed ? ' is-typed' : ''}`}>
        {people === null && <LoadingState compact />}
        {people && people.length === 0 && !error && <div className="hud-actas-msg">No one is eligible.</div>}
        {!typed && recent.length > 0 && <div className="hud-sec" id={`${listId}-recent`}>Recent</div>}
        {typed && people && people.length > 0 && found.total === 0 && <div className="hud-actas-msg">No matches.</div>}
        <div id={listId} role="listbox" aria-label={typed ? 'People' : undefined}
          aria-labelledby={!typed && recent.length ? `${listId}-recent` : undefined}>
          {rows.map((p, i) => (
            <button type="button" key={p.email} className="hud-person" {...nav.optionProps(i)} onClick={() => pick(p)}
              disabled={!!starting} style={starting && starting !== p.email ? { opacity: 0.5 } : undefined}>
              <Avatar p={p} photo={p.photoUrl || photos[p.email]} />
              <span className="hud-person-text"><b>{p.name}</b></span>
              {starting === p.email && <span className="hud-person-note">Starting…</span>}
            </button>
          ))}
        </div>
        {typed && found.total > SHOWN && (
          <div className="hud-actas-more"><span><b>+{found.total - SHOWN} more</b> match</span><span>keep typing</span></div>
        )}
      </div>
      <div className="hud-keys" aria-hidden="true">
        <span><kbd className="hud-kbd">↑</kbd> <kbd className="hud-kbd">↓</kbd> Pick</span>
        <span><kbd className="hud-kbd">Enter</kbd> Start</span>
        <span><kbd className="hud-kbd">Esc</kbd> Back</span>
      </div>
    </div>
  );
}

export function ToolsSection({ onClose, onOpenActAs }) {
  const { can, myGrantedModules, isExternal, actingAs, stopActAs } = useRole();
  const buildMode = useBuildModeMenu();
  const [qaEnabled, setQaEnabled] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve(api.qaEnabled?.()).then((r) => { if (live) setQaEnabled(!!r?.enabled); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // routers/act_as.py: Manager+ or the 'act-as' grant. While acting, the
  // role here is the target's, so the Exit card shows whatever it says.
  const canActAs = !actingAs && !isExternal && (!!can?.('manager') || !!myGrantedModules?.has('act-as'));
  const canTesting = !!TESTING_NAV && isNavItemVisible(TESTING_NAV, { isExternal, can, myGrantedModules, qaEnabled });
  // The left menu's own rule for Insights, unchanged since it moved here.
  const canInsights = !!INSIGHTS_NAV && isNavItemVisible(INSIGHTS_NAV, { isExternal, can, myGrantedModules });
  const support = canActAs || !!actingAs;
  const developer = buildMode.enabled || canTesting;

  // "A" with the menu open (and nothing being typed) opens Act As.
  useEffect(() => {
    if (!canActAs) return undefined;
    const onKey = (e) => {
      if ((e.key || '').toLowerCase() !== 'a' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      onOpenActAs();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canActAs, onOpenActAs]);

  if (!canInsights && !support && !developer) return null;

  async function exit() {
    setStopping(true);
    try { await stopActAs(); } finally { setStopping(false); }
  }

  return (
    <div className="hud-tools" data-testid="tools-section">
      <div className="hud-divider" />
      <div className="hud-sec">Tools</div>
      {canInsights && (
        <button type="button" className="hud-item"
          onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'bi' } })); }}>
          <InsightsChart size={14} /> Insights
          <span className="hud-end"><ChevronRight size={14} /></span>
        </button>
      )}
      {support && (
        <>
          {actingAs ? (
            <div className="hud-acting">
              <UserCog size={15} aria-hidden="true" />
              <span className="hud-person-text">
                <b>Acting as {(actingAs.targetName || actingAs.targetEmail || '').split(' ')[0]}</b>
                {actingAs.expiresAt && <span>Ends {formatTime(actingAs.expiresAt)}</span>}
              </span>
              <button type="button" className="hud-exit" onClick={exit} disabled={stopping}>{stopping ? 'Exiting…' : 'Exit'}</button>
            </div>
          ) : (
            <button type="button" className="hud-item" data-tools-actas="" onClick={onOpenActAs}>
              <UserCog size={14} /> Act As
              <span className="hud-end"><kbd className="hud-kbd">A</kbd></span>
            </button>
          )}
        </>
      )}
      {developer && (
        <>
          {buildMode.enabled && (
            <button type="button" className="hud-item" role="switch" aria-checked={buildMode.on}
              onClick={() => { onClose(); buildMode.toggle(); }}>
              <Wrench size={14} /> Build Mode
              <span className="hud-end">
                <kbd className="hud-kbd">{BUILD_KEYS}</kbd>
                <span className={`hud-switch${buildMode.on ? ' is-on' : ''}`} aria-hidden="true" />
              </span>
            </button>
          )}
          {canTesting && (
            <button type="button" className="hud-item"
              onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'testing' } })); }}>
              <FlaskConical size={14} /> Testing
              <span className="hud-end"><ChevronRight size={14} /></span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
