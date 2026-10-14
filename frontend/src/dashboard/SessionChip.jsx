import { fmtHM } from '../lib/timeclockStore';

// The header's time chip. Nothing at all for someone who is not time-tracked
// (Neil, Oct 14: "Clocked Out - Open time clock" on a salaried person's
// dashboard made no sense) and nothing until the status has loaded, so the
// chip never flashes Clocked Out before it knows. On a break it says so.
export function SessionChip({ mine, onOpen }) {
  if (!mine || mine.exempt || mine.state === 'unknown') return null;
  const on = mine.state === 'in' || mine.state === 'break';
  return (
    <button
      className={`dk-session-chip${on ? ' dk-session-chip--on' : ''}`}
      onClick={onOpen}
      title="Open time clock"
      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      <span className={`dk-dot ${on ? 'dk-dot--up' : 'dk-dot--off'}`} />
      {mine.state === 'break' ? <>On Break · <b>{fmtHM(mine.todayMin)}</b></>
        : on ? <>Clocked In · <b>{fmtHM(mine.todayMin)}</b></>
          : <>Clocked Out<span className="dk-session-long"> · Open time clock</span></>}
    </button>
  );
}

