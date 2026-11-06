// Task Module - what the screen shows while the task data is still arriving
// (Sep 28). Every task screen used to render straight away from an empty
// store, so for the several seconds a cold load takes it claimed "0 Tasks",
// "0 items" in every group and even "No Tasks - you're all caught up", and a
// task opened from an email's "Open in Nexus" link simply did not appear
// until the list landed. The shell (views/Tasks.jsx) shows this instead until
// TasksContext's `loading` clears - it is the store's own FIRST_PAINT signal
// (tasks + projects + statuses in), so an empty state only ever means empty.
// 11/05/2026: a skeleton in the shape of the screen it turns into (Home's
// tiles and its two columns, or a full-width list), no spinner - the old
// ring over a narrow centered list did not look like the page that followed.
import { useEffect, useState } from 'react';

import { NX, FONT } from './theme';

// Past this the message admits it is slow rather than looking frozen.
const SLOW_AFTER_MS = 8000;

const ROW_WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%', '58%', '50%'];
const card = { border: `1px solid ${NX.border}`, borderRadius: 16, background: NX.surface, overflow: 'hidden' };

function Rows({ count }) {
  return ROW_WIDTHS.slice(0, count).map((w, i) => (
    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', boxShadow: `inset 0 -1px 0 ${NX.border2}` }}>
      <span className="skel" style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0 }} />
      <span className="skel" style={{ width: w, height: 12 }} />
      <span className="skel" style={{ width: 72, height: 12, marginLeft: 'auto', flexShrink: 0 }} />
    </div>
  ));
}

function CardHead() {
  return (
    <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="skel" style={{ width: 26, height: 26, borderRadius: 7 }} />
      <span className="skel" style={{ width: 120, height: 13 }} />
    </div>
  );
}

// Home: the four focus tiles, then Updates beside Tasks over Bookmarks
// (HomeView's core grid); one column on a narrow window.
function HomeShape() {
  return (
    <>
      <div style={{ ...card, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="skel" style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="skel" style={{ width: 40, height: 16 }} />
              <span className="skel" style={{ width: '60%', height: 10 }} />
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' }}>
        <div style={card}><CardHead /><Rows count={8} /></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}><CardHead /><Rows count={5} /></div>
          <div style={card}><CardHead /><Rows count={2} /></div>
        </div>
      </div>
    </>
  );
}

// Every other screen (Tasks, Projects, Portfolios, Teams, a project): a
// toolbar over a full-width list.
function ListShape() {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span className="skel" style={{ width: 180, height: 22 }} />
        <span className="skel" style={{ width: 96, height: 30, borderRadius: 8, marginLeft: 'auto' }} />
        <span className="skel" style={{ width: 96, height: 30, borderRadius: 8 }} />
      </div>
      <div style={{ ...card, borderRadius: 12 }}>
        <div style={{ padding: '10px 16px', background: NX.surface2, boxShadow: `inset 0 -1px 0 ${NX.border}` }}>
          <span className="skel" style={{ width: 120, height: 12 }} />
        </div>
        <Rows count={8} />
      </div>
    </>
  );
}

export default function TasksLoading({ opening = false, sub = 'home' }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const title = opening ? 'Opening your task…' : 'Loading your tasks…';
  // Said out loud only when it is worth reading: a linked task on its way,
  // or a load that is taking a while.
  const note = slow ? 'Still working on it - this is taking a little longer than usual.'
    : opening ? 'Getting the task details ready.' : '';

  return (
    <div role="status" aria-live="polite" aria-busy="true" data-tasks-loading={sub === 'home' ? 'home' : 'list'}
      style={{ fontFamily: FONT, padding: '24px 24px 76px', boxSizing: 'border-box', width: '100%', animation: 'fadeIn 0.2s ease' }}>
      {note ? (
        <div style={{ fontSize: 13, color: NX.dim, marginBottom: 12 }}>
          <span style={{ fontWeight: 600, color: NX.ink }}>{title}</span> {note}
        </div>
      ) : <span className="dk-sr-only">{title}</span>}
      <div aria-hidden="true">{sub === 'home' ? <HomeShape /> : <ListShape />}</div>
    </div>
  );
}
