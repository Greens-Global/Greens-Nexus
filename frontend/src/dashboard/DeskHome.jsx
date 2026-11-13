/*
THESIS: the home screen reads like a premium work OS (canon, owner-pinned:
monday.com-grade) - a personal command center, not a grid of identical
widgets.
OWN-WORLD: white cards on #f6f7fb, Inter type, brand #2b45e1 (Stella cobalt), colored icon
chips carrying meaning, soft shadows, friendly copy. Light always.
STORY: an employee reads their day in five seconds - greeting, session chip,
one stat tile, the "needs your attention" list - then acts.
FIRST VIEWPORT: greeting + session/timezone meta → one stat tile → attention
queue (left) + team pulse / quick actions (right). Primary action = top queue
row.
FORM: category standard played straight at full fidelity (user's canon call,
Jul 28); craft bar monday.com.
*/
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  ArrowUpRight, CheckCircle2, CheckSquare, ChevronRight, House,
} from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import { myTasksFootnote, MY_TASKS_RULE } from './myTasksCount';
import { useTimeStatus } from '../lib/useTimeStatus';
// The header chip shows today's worked hours as H:MM - the same number and
// format as the sidebar's time clock chip (Neil, Oct 14 2026), not seconds
// since the last punch.
import { SessionChip } from './SessionChip';
import { deriveMyTime } from './essentials/usePunchClock.jsx';
import { useWorldClockPicks, headerClocks } from '../lib/worldClockZones';
import { formatDate, formatDayLong, formatTimeIn, formatWeekday, greetingFor } from '../lib/datetime';
import { LoadingState, CountSkeleton } from '../components/AsyncState';
import { useNotifications } from '../contexts/NotificationContext.jsx';
import { useActionCounts, tabCount } from '../lib/useActionCounts';
import { MoreRow } from './listParts.jsx';
import { useFavoriteLinks, openFavorite, FavoriteTileGrid } from './favoriteLinks.jsx';
// The same composer the customizable dashboard's Quick Actions widget uses -
// it brings its own TasksProvider, so the modal works outside the Tasks view.

const reduceMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

const navTo = (view, sub) =>
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

// One shared 1-second heartbeat: timezone meta + the session timer.
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useCountUp(target, ms = 650) {
  const [val, setVal] = useState(reduceMotion() ? target : 0);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || reduceMotion() || !target) { setVal(target ?? 0); return; }
    done.current = true;                     // count up once, never re-tick
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

// One clock from headerClocks: "7:42 PM" for the viewer's own time,
// "California 4:42 PM PDT" / "India 8:12 AM" for the others.
// The home zone (clock.away - the person's own zone while the device is
// elsewhere) wears a small house and says so to a screen reader.
const ZoneClock = ({ clock, now }) => (
  <>
    {clock.away && <House size={12} className="dk-zone-home" aria-hidden="true" />}
    {clock.away && <span className="dk-sr">Home time: </span>}
    {clock.label && <>{clock.label} </>}<b>{formatTimeIn(now, clock.tz)}{clock.abbr && ` ${clock.abbr}`}</b>
  </>
);


const timeAgo = (ts) => {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

// The ONE stat band (Neil, 11/08/2026): a gradient band as wide as the
// queue under it - Open Tasks (chip, big number, label, sub line) on the
// left, and on the right the three counts that used to be white tiles of
// their own (checked out, equipment, to sign) as small stat items, each a
// button to where its tile's arrow went. The band is a div so the count
// buttons are not buttons inside a button.
function Stat({ i, label, value, sub, tip, chip, Icon, onGo, links = [] }) {
  const n = useCountUp(value ?? 0);
  const loaded = value != null;   // a placeholder until the count is in, never a 0
  return (
    <div className="dk-stat dk-stat--hero dk-hero dk-rise" style={{ '--i': i }}>
      <button type="button" className="dk-hero-main" onClick={onGo} title={tip}>
        <span className={`dk-chip dk-chip--${chip}`}><Icon /></span>
        <span className="dk-hero-text">
          <span className="dk-stat-num">{loaded ? n : <CountSkeleton />}</span>
          <span className="dk-stat-label">{label}</span>
          <span className="dk-stat-sub">{sub}</span>
        </span>
        <ArrowUpRight size={15} className="dk-stat-arrow" />
      </button>
      <span className="dk-hero-links">
        {links.map((l) => (
          <button key={l.label} type="button" className="dk-hero-link" onClick={l.go} title={l.tip}>
            <span className="dk-hero-k">{l.label}</span>
            <span className="dk-hero-n">{l.value == null ? <CountSkeleton /> : l.value}</span>
          </button>
        ))}
      </span>
    </div>
  );
}

// The greeting + session header, on its own so the Dashboard page can wear it
// over EVERY layout - the designed Home below it AND saved custom-view grids
// (saving a default view used to swallow the greeting with the rest of Home;
// Visesh, Aug 12). `summary` is an optional node after the date line - Home
// passes its attention-count sentence, grid views just get the date.
export function DeskGreeting({ summary = null, right = null, menu = null }) {
  const { accounts } = useMsal();
  const { actingAs, myHomeZone } = useRole();
  const now = useNow();
  const picks = useWorldClockPicks();
  // Own time bare, California beside it only when it differs, then the My
  // Profile picks (headerClocks). Recomputed once a minute - a DST switch
  // lands on a minute boundary.
  const minute = Math.floor(now.getTime() / 60000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clocks = useMemo(() => headerClocks(picks, now, undefined, myHomeZone), [picks, minute, myHomeZone]);
  // While acting as someone, the greeting greets THEM - this whole screen is
  // their day, and "Good Evening, Visesh" on Pranshu's dashboard read wrong.
  const firstName = ((actingAs?.targetName || accounts[0]?.name) ?? 'there').split(' ')[0];
  const { status } = useTimeStatus();   // the shared read (lib/useTimeStatus)

  // The same derivation as the sidebar chip (stale shifts and exempt people
  // read as clocked out), so the two never disagree on whether a shift is live.
  const mine = deriveMyTime({ status, now });

  const greeting = greetingFor(now);
  // "Wednesday, Oct 14" - through the shared date helpers (lib/datetime.js).
  const dateLine = formatDayLong(now);

  return (
    <div className="dk-head dk-rise" style={{ '--i': 0 }}>
      <div className="dk-head-left">
        {/* The date sits ABOVE the greeting, small, like a dateline (Neil,
            11/04/2026); the line under the greeting is the summary. */}
        <div className="dk-head-date">{dateLine}</div>
        <h1>{greeting}, {firstName}!</h1>
        <div className="dk-head-sub">
          {summary}
          {/* On a phone the small zones beside the big clock are hidden and
              California (when different) rides here instead (Sep 23 / Oct 7)
              - one line, no separate row. The viewer's own time is the big
              clock at every width now, so it is not repeated here; the My
              Profile picks stay on the wider layout. */}
          {clocks.filter((c) => c.home && c.label).map((c, i) => (
            <span key={c.tz} className="dk-sub-local">{summary || i ? ' · ' : ''}<ZoneClock clock={c} now={now} /></span>
          ))}
        </div>
      </div>
      <div className="dk-head-right">
        {/* The viewer's own time, as big as the greeting, on the row ABOVE the
            controls - the 12px zones line under the toolbar was too small to
            read (Neil, Oct 7). The other clocks (California when it differs,
            the My Profile picks) sit small on the same baseline, before it,
            so the right side is two rows like the left. On a phone the clock
            keeps the top-right corner beside the greeting (style.css regrids
            the header there); only the small zones hide. */}
        <div className="dk-clock-row">
          <div className="dk-clock">{formatTimeIn(now, clocks[0].tz)}</div>
        </div>
        {/* The other clocks on their own line UNDER the big one, the way a
            phone's world clock reads (Neil, 11/13/2026: in Texas he did not
            see California - small and faint BESIDE the big clock, it read as
            decoration). Home comes first, with its house. */}
        {clocks.length > 1 && (
          <div className="dk-zones">
            {clocks.slice(1).map((c, i) => (
              <Fragment key={c.tz}>
                {i > 0 && <span className="dk-zone-sep" />}
                <span className={c.away ? 'dk-zone is-home' : 'dk-zone'} title={c.away ? 'Your home time zone' : undefined}><ZoneClock clock={c} now={now} /></span>
              </Fragment>
            ))}
          </div>
        )}
        {/* View picker + Customize, moved up here from their own title band
            (Neil, Sep 15) - repeating "Dashboard" under the tab strip plus a
            whole separate control row was pure clutter, stealing real estate
            the greeting/stats should get instead. Session chip sits on the
            same row as those controls (Neil, Sep 15 follow-up). */}
        <div className="dk-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {right}
          <SessionChip mine={mine} onOpen={() => navTo('timeclock')} />
          {/* The Customize menu (portaled; its button is in `right`). */}
          {menu}
        </div>
      </div>
    </div>
  );
}

// Favorites (Neil, Oct 28 2026: "a widget that has all the favorite links in
// it from the links tab") - every bookmark from the Links tab, the same grid
// as the custom dashboard's Favorites widget (favoriteLinks.jsx). A long list
// scrolls inside the card so the rail keeps its shape.
function FavoritesCard({ myEmail }) {
  const { loading, favorites } = useFavoriteLinks();
  const openLinks = () => navTo('dashboard', 'links');
  return (
    <div className="dk-card dk-rise" style={{ '--i': 6 }}>
      <div className="dk-pane-head">
        Favorites
        <button type="button" className="dk-fav-open" onClick={openLinks}>{favorites.length ? `${favorites.length} in Links` : 'Open Links'}</button>
      </div>
      <div className="dk-fav-body">
        {loading ? <LoadingState compact /> : favorites.length ? (
          <FavoriteTileGrid links={favorites} onOpen={(l) => openFavorite(l, myEmail)} />
        ) : (
          <p className="dk-fav-empty">Bookmark an app in Links and it shows up here.</p>
        )}
      </div>
    </div>
  );
}

export default function DeskHome({ kpis = {}, notifications = [], markRead, headerRight = null, headerMenu = null }) {
  const { can, myEmail } = useRole();
  const now = useNow();
  // `|| {}`: null outside NotificationProvider (render tests).
  const { openPanel } = useNotifications() || {};
  const actionCounts = useActionCounts();

  // Live extras: session state (the My-hours strip), pending signatures, team
  // KPIs (managers). All read-only, all existing endpoints, all safe to fail
  // quietly. DeskGreeting reads the same shared time status for its own chip
  // (lib/useTimeStatus - one request for both, and for the floating timer).
  const { status } = useTimeStatus();
  const [sigs, setSigs] = useState(null);   // null = not read yet
  const [teamKpis, setTeamKpis] = useState(null);
  useEffect(() => {
    api.mySignatures().then(r => setSigs(Array.isArray(r) ? r : (r?.requests || r?.items || []))).catch(() => setSigs([]));
    if (can('supervisor')) api.dashKpis('team').then(r => setTeamKpis(r?.kpis || null)).catch(() => {});
  }, [can]);

  const last = status?.lastPunch;
  // Stale open shift (clock-in >16h, server treats it as closed) reads as clocked out here too.
  const clockedIn = !!(last && last.kind !== 'out') && !status?.staleOpenShift;
  const elapsed = clockedIn && last?.at
    ? Math.max(0, Math.floor((now.getTime() - new Date(last.at + 'Z').getTime()) / 1000))
    : 0;

  // Approvals waiting on you come from the ONE count (approvals_inbox, the
  // same number as the Approvals tab's badge) - Home used to say "You're all
  // caught up" beside "Approvals 2" (phone review, 11/13/2026). An approval
  // bell is then not counted a second time.
  const approvalsWaiting = tabCount(actionCounts, 'dashboard', 'approvals');
  const isApprovalBell = (n) => n.action?.view === 'dashboard' && String(n.action?.sub || '').startsWith('approvals');
  const unread = notifications.filter(n => !n.read && !n.closed);
  const allActionable = unread.filter(n => n.action && !n.actioned && !(approvalsWaiting > 0 && isApprovalBell(n)));
  const actionable = allActionable.slice(0, 6);
  const pendingSigs = sigs ? sigs.length : null;
  // Everything that needs you, not just the rows that fit: the count, the
  // summary sentence and the "+N more" row all say the real number.
  const attentionTotal = (pendingSigs || 0) + allActionable.length + approvalsWaiting;

  // "Needs your attention": signatures first (hard blockers), then actionable
  // unread notifications.
  const queue = useMemo(() => {
    const rows = [];
    if (approvalsWaiting > 0) rows.push({
      key: 'approvals',
      pill: 'Approve', tone: 'orange',
      title: approvalsWaiting === 1 ? '1 Approval Waiting on You' : `${approvalsWaiting} Approvals Waiting on You`,
      sub: 'Approvals',
      time: '',
      go: () => navTo('dashboard', 'approvals'),
    });
    (sigs || []).slice(0, 3).forEach(s => rows.push({
      key: `sig-${s.id ?? s.packet_id ?? Math.random()}`,
      pill: 'Sign', tone: 'green',
      title: s.title || s.name || s.document_title || 'Document awaiting your signature',
      sub: 'Nexus Sign · waiting on you',
      time: timeAgo(s.created_at || s.requested_at),
      go: () => navTo('myhr'),
    }));
    actionable.forEach(n => rows.push({
      key: `ntf-${n.id}`,
      pill: /approv|request/i.test(`${n.type} ${n.title}`) ? 'Approve'
        : /overdue|return/i.test(`${n.type} ${n.title}`) ? 'Overdue'
        : 'Review',
      tone: /overdue|reject|urgent|alert/i.test(`${n.type} ${n.title}`) ? 'red'
        : /approv|request/i.test(`${n.type} ${n.title}`) ? 'orange'
        : 'blue',
      title: n.title || 'Notification',
      sub: n.body || '',
      time: timeAgo(n.timestamp),
      go: () => { markRead?.(n.id); if (n.action?.view) navTo(n.action.view, n.action.sub); },
    }));
    return rows.slice(0, 7);
  }, [sigs, actionable, markRead, approvalsWaiting]);

  // The approvals row stands for every approval it counts.
  const hiddenCount = Math.max(0, attentionTotal - queue.length - (approvalsWaiting > 1 ? approvalsWaiting - 1 : 0));
  // Where the rest live: the bell holds every notification; signatures are
  // on My HR. Notifications left out first, since there are usually more.
  const hiddenNotifs = allActionable.length - queue.filter(r => r.key.startsWith('ntf-')).length;
  const viewAll = () => { if (hiddenNotifs > 0 && openPanel) openPanel(); else navTo('myhr'); };

  const summary = attentionTotal > 0
    ? <>You have <b>{attentionTotal} item{attentionTotal === 1 ? '' : 's'}</b> that need your attention today.</>
    : <>You're all caught up.</>;

  const counts = [
    // `value` stays undefined until /kpis (or the signature fetch) lands, so
    // the band shows a CountSkeleton there, never a placeholder 0.
    { label: 'Checked Out', value: kpis.my_checkouts, tip: 'Checked-Out Items - with you right now', go: () => navTo('inventory', 'checkouts') },
    { label: 'Equipment', value: kpis.my_assignments, tip: 'My Equipment - permanently assigned', go: () => navTo('inventory') },
    { label: 'To Sign', value: pendingSigs, tip: 'Signatures Needed - waiting on you', go: () => navTo('myhr') },
  ];

  return (
    <div className="dk-home">
      {/* ── Greeting + session ── */}
      <DeskGreeting summary={summary} right={headerRight} menu={headerMenu} />

      {/* ── Stat band + attention queue (left column) + rail ──
          The band lives in the left column with the queue (Neil,
          11/08/2026) so the rail starts level with it. */}
      <div className="dk-main">
        <div className="dk-col">
        <Stat i={1} label="Open Tasks" value={kpis.my_open_tasks} sub={myTasksFootnote(kpis) || 'Due soon or in progress'}
          tip={`Open Tasks - ${MY_TASKS_RULE}${myTasksFootnote(kpis) ? `. ${myTasksFootnote(kpis)}` : ''}`}
          chip="blue" Icon={CheckSquare} onGo={() => navTo('tasks')} links={counts} />
        <div className="dk-card dk-queue dk-rise" style={{ '--i': 2 }}>
          {/* No count badge, no "newest first" (Neil, 11/08/2026): the
              greeting already says how many need you. */}
          <div className="dk-pane-head">Needs Your Attention</div>
          {queue.length === 0 ? (
            <div className="dk-clear">
              <span className="dk-clear-icon"><CheckCircle2 size={22} /></span>
              <h3>You're All Caught Up</h3>
              <p>New approvals, signatures, and alerts will land here as they come in.</p>
            </div>
          ) : (<>
            {queue.map(row => (
              <button key={row.key} className="dk-queue-row" onClick={row.go}>
                <span className={`dk-pill dk-pill--${row.tone}`}>{row.pill}</span>
                <span className="dk-queue-body">
                  <span className="dk-queue-title">{row.title}</span>
                  {row.sub && <span className="dk-queue-sub">{row.sub}</span>}
                </span>
                {row.time && <span className="dk-queue-time">{row.time}</span>}
                <ChevronRight size={15} />
              </button>
            ))}
            <MoreRow count={hiddenCount} onClick={viewAll} label={`View All (${attentionTotal})`} />
          </>)}
        </div>
        </div>

        <div className="dk-rail">
          {can('supervisor') && teamKpis && (
            <div className="dk-card dk-rise" style={{ '--i': 3 }}>
              <div className="dk-pane-head">Team Pulse</div>
              <button className="dk-team-row" onClick={() => navTo('timeclock')}>
                <span className="dk-dot dk-dot--up" /> Clocked In Now
                <b>{teamKpis.clocked_in_now ?? 0}</b>
              </button>
              <button className="dk-team-row" onClick={() => navTo('myhr', 'purchase')}>
                Requisitions to Approve
                <b className={teamKpis.pending_requisitions > 0 ? 'dk-hot' : ''}>{teamKpis.pending_requisitions ?? 0}</b>
              </button>
              <button className="dk-team-row" onClick={() => navTo('timeclock')}>
                Time Off to Review
                <b className={teamKpis.time_off_pending > 0 ? 'dk-hot' : ''}>{teamKpis.time_off_pending ?? 0}</b>
              </button>
            </div>
          )}

          {/* My hours - last 7 days from the timeStatus call already made above.
              Today's bar is solid brand; earlier days a lighter cobalt. */}
          {(() => {
            const days = status?.days || {};
            const off = now.getTimezoneOffset() * 60000;
            const series = [];
            for (let i = 6; i >= 0; i--) {
              const d = new Date(now.getTime() - off - i * 86400000);
              const key = d.toISOString().slice(0, 10);
              const local = new Date(d.getTime() + off);
              series.push({ key, date: local, min: days[key]?.workedMin || 0, wd: formatWeekday(local, 'short').slice(0, 2), today: i === 0 });
            }
            // Today's closed segments exclude the live session - add it so the
            // card agrees with the running timer (paused while on break).
            if (clockedIn && last?.kind !== 'break_start') series[6].min += Math.floor(elapsed / 60);
            const total = series.reduce((a, s) => a + s.min, 0);
            if (total === 0 && !clockedIn) return null;   // no time-clock use - skip the card
            const max = Math.max(480, ...series.map(s => s.min));
            const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
            return (
              <div className="dk-card dk-rise" style={{ '--i': 4 }}>
                <div className="dk-pane-head">My Hours <span className="dk-meta">last 7 days · {fmtH(total)}</span></div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 88, padding: '14px 16px 10px' }}>
                  {series.map(s => (
                    <div key={s.key} title={`${formatDate(s.date)} - ${fmtH(s.min)}`}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 5, minWidth: 0, height: '100%' }}>
                      <div style={{ width: '62%', maxWidth: 22, height: Math.max(s.min ? 6 : 3, (s.min / max) * 56), borderRadius: 99,
                        background: !s.min ? 'var(--mist)' : s.today ? 'var(--wk-brand)' : '#b9c4f4' }} />
                      <span style={{ fontSize: 11, fontWeight: s.today ? 700 : 500, color: s.today ? 'var(--wk-brand)' : 'var(--wk-faint)' }}>{s.wd}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* The Quick Actions card is gone (Neil, 11/13/2026: "no longer
              needed") - the green bolt in the top header starts a task, a
              ticket or a request from every screen. */}

          <FavoritesCard myEmail={myEmail} />
        </div>
      </div>

    </div>
  );
}
