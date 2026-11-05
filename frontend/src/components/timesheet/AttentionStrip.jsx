// The line above the Time Sheet grid (Neil, 11/04/2026): the figures - Worked,
// Regular (added 11/05/2026), Overtime, Time Off, Gross Pay - and Needs Attention as grouped chips. At
// most three chips show, worst first; the rest sit behind "+N More". A chip's
// name jumps to its first day on the grid; its button (Fix / Show / Map) does
// the thing. "Fix Next" is a quiet link to the first fix. No late or
// schedule-variance chips (Neil: v5 was too busy).
import { useRef, useState } from 'react';
import { CheckCircle } from 'lucide-react';
import AnchoredMenu from '../AnchoredMenu';

const SHOWN = 3;

function Chip({ item, onJump, onAct }) {
  const first = item.refs[0];
  return (
    <span className={`ts-chip is-${item.tone}${onAct ? '' : ' no-do'}`} data-kind={item.kind}>
      <button type="button" className="ts-chip-go" onClick={() => onJump(first.ds)}
        title={`Go to ${item.days} on the time sheet`}>
        {item.label} <small>{item.days}</small>
      </button>
      {onAct && (
        <button type="button" className="ts-chip-do" onClick={() => onAct(item, first)}
          aria-label={`${item.act} - ${item.label} ${item.days}`}>{item.act}</button>
      )}
    </span>
  );
}

export default function AttentionStrip({ figures, items, actionFor, onJump }) {
  const [more, setMore] = useState(false);
  const moreRef = useRef(null);
  const shown = items.slice(0, SHOWN), rest = items.slice(SHOWN);
  const next = items.find(it => it.tone === 'bad' && actionFor(it));
  return (
    <div className="ts-strip" style={{ gridTemplateColumns: `repeat(${figures.length}, auto) minmax(0, 1fr)` }} data-testid="ts-strip">
      {figures.map(f => (
        <div key={f.label} className={`ts-fig${f.warn ? ' is-warn' : ''}`}>
          <span>{f.label}</span>
          <b>{f.value}{f.small && <small>{f.small}</small>}</b>
        </div>
      ))}
      <div className="ts-att">
        <span>
          Needs Attention
          {next && (
            <button type="button" className="ts-next-fix" onClick={() => actionFor(next)(next, next.refs[0])}>Fix Next</button>
          )}
        </span>
        {items.length === 0 ? (
          <span className="ts-ok"><CheckCircle size={14} /> Nothing to fix</span>
        ) : (
          <div className="ts-att-row">
            {shown.map(it => <Chip key={it.kind} item={it} onJump={onJump} onAct={actionFor(it)} />)}
            {rest.length > 0 && (
              <>
                <button ref={moreRef} type="button" className="ts-more" aria-expanded={more} aria-haspopup="dialog"
                  onClick={() => setMore(v => !v)}>+{rest.length} More</button>
                <AnchoredMenu anchorRef={moreRef} open={more} onClose={() => setMore(false)} align="end" role="dialog" aria-label="More to look at"
                  style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: 10 }}>
                  <div className="ts-more-list">
                    {rest.map(it => (
                      <Chip key={it.kind} item={it}
                        onJump={(ds) => { setMore(false); onJump(ds); }}
                        onAct={actionFor(it) ? (a, b) => { setMore(false); actionFor(it)(a, b); } : null} />
                    ))}
                  </div>
                </AnchoredMenu>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
