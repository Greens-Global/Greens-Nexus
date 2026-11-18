// Everything waiting on this phone (field offline, Neil 11/03/2026) - the
// sheet the offline bar's Review / Waiting opens. One row per queued change:
// what it is, when it was made, its state (SyncState), the server's message
// when it was refused, and what the person can do - Choose (a conflict, the
// centered Keep Mine / Use Theirs card), Retry, or Discard (held: an unsent
// change thrown away cannot be brought back). Sync Now sends what can go.
import { useEffect, useState } from 'react';
import { RefreshCw, RotateCcw, Trash2, Wrench } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { NX, FONT, btn } from '../../tasks/theme';
import HoldButton, { HOLD_RECORD_MS } from '../../ui/HoldButton';
import { formatDateTime } from '../../lib/datetime';
import { useOffline, changes } from '../../lib/offline/useOffline';
import SyncState from './SyncState';
import ConflictCard from './ConflictCard';

function useHandlers(entries) {
  const kindsKey = [...new Set(entries.map((e) => e.kind))].sort().join(',');
  const [handlers, setHandlers] = useState({});
  useEffect(() => {
    let live = true;
    Promise.all([import('../../lib/offline/kinds'), import('../../lib/offline/outbox')]).then(async ([k, ob]) => {
      const out = {};
      for (const kind of kindsKey.split(',').filter(Boolean)) {
        try { await k.loadKind(kind); } catch { /* not loadable offline */ }
        out[kind] = ob.kindHandler(kind);
      }
      if (live) setHandlers(out);
    }).catch(() => {});
    return () => { live = false; };
  }, [kindsKey]);
  return handlers;
}

const describe = (entry, handler) => {
  try { const d = handler?.describe?.(entry); if (d?.title) return d; } catch { /* plain words */ }
  return { title: entry.label || 'A change', detail: '' };
};

export default function OutboxPanel({ onClose }) {
  const s = useOffline();
  const others = s.others || [];
  const handlers = useHandlers([...s.entries, ...others]);
  const fix = async (e) => {
    const ob = await import('../../lib/offline/outbox');
    if (await ob.fixEntry(e.id)) onClose?.();
  };
  const [choosing, setChoosing] = useState(null);   // entry id
  const list = [...s.entries].reverse();             // newest first
  const chosen = choosing ? s.entries.find((e) => e.id === choosing) : null;

  const footer = (
    <>
      <button type="button" style={btn('outline')} onClick={onClose}>Close</button>
      <button type="button" style={btn('primary')} disabled={!s.online || !s.waiting} onClick={() => s.syncNow()}>
        <RefreshCw size={14} /> Sync Now
      </button>
    </>
  );

  return (
    <>
      <Modal title="Saved on This Phone" onClose={onClose} footer={footer} zIndex={4300} width="min(560px, 96vw)">
        <div className="nx-fill" style={{ fontFamily: FONT, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>
            {!s.online
              ? 'You are offline. These changes are saved on this phone and send by themselves when you are back online.'
              : s.signedOut
                ? 'Your sign-in ran out. Sign in and these changes send by themselves.'
                : s.waiting
                  ? `${changes(s.waiting)} waiting to send.`
                  : 'Nothing is waiting to send.'}
          </div>
          {!list.length && !others.length && <div style={{ fontSize: 13, color: NX.dim, padding: 20, textAlign: 'center' }}>Nothing is saved on this phone.</div>}
          {list.map((e) => {
            const h = handlers[e.kind];
            const d = describe(e, h);
            return (
              <div key={e.id} data-entry={e.id} style={{ border: `1px solid ${NX.border}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: NX.ink }}>{d.title}</span>
                    <span style={{ display: 'block', fontSize: 12, color: NX.dim }}>
                      {d.detail ? `${d.detail} - ` : ''}Saved {formatDateTime(e.createdAt)}{e.sentAt ? `, sent ${formatDateTime(e.sentAt)}` : ''}
                    </span>
                  </span>
                  <SyncState entry={e} />
                </div>
                {e.error && e.state !== 'parked' && e.state !== 'sent' && (
                  <div role="alert" style={{ fontSize: 12, color: e.state === 'failed' ? NX.red : NX.amber, fontWeight: 600 }}>{e.error}</div>
                )}
                {e.state !== 'sent' && e.state !== 'sending' && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {e.state === 'conflict' && (
                      <button type="button" style={{ ...btn('primary'), padding: '6px 12px', fontSize: 13 }} onClick={() => setChoosing(e.id)}>Choose</button>
                    )}
                    {e.state === 'failed' && typeof h?.fix === 'function' && (
                      // A refused change goes back where it can be corrected
                      // (a form: its fill screen, answers and photos kept).
                      <button type="button" style={{ ...btn('primary'), padding: '6px 12px', fontSize: 13 }} onClick={() => fix(e)}>
                        <Wrench size={13} /> Open and Fix
                      </button>
                    )}
                    {e.state === 'failed' && (
                      <button type="button" style={{ ...btn('outline'), padding: '6px 12px', fontSize: 13 }} disabled={!s.online} onClick={() => s.retryEntry(e.id)}>
                        <RotateCcw size={13} /> Retry
                      </button>
                    )}
                    <HoldButton label="Discard" doneLabel="Discarded" size="sm" icon={Trash2} holdMs={HOLD_RECORD_MS}
                      ariaLabel={`Discard ${d.title}`} onConfirm={() => s.discardEntry(e.id)}
                      fallbackMessage={`Discard ${d.title}? It has not been sent and cannot be brought back.`} />
                  </div>
                )}
              </div>
            );
          })}
          {others.length > 0 && (
            <div data-others style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink }}>{changes(others.length)} from another session</div>
              <div style={{ fontSize: 13, color: NX.dim, lineHeight: 1.5 }}>
                Saved on this phone under your name in another session (for example while acting as someone). They never send from here - discard them when you are sure they are not needed.
              </div>
              {others.map((e) => {
                const d = describe(e, handlers[e.kind]);
                return (
                  <div key={e.id} style={{ border: `1px dashed ${NX.border}`, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: NX.ink }}>{d.title}</span>
                      <span style={{ display: 'block', fontSize: 12, color: NX.dim }}>Saved {formatDateTime(e.createdAt)}</span>
                    </span>
                    <HoldButton label="Discard" doneLabel="Discarded" size="sm" icon={Trash2} holdMs={HOLD_RECORD_MS}
                      ariaLabel={`Discard ${d.title} from another session`} onConfirm={() => s.discardEntry(e.id)}
                      fallbackMessage={`Discard ${d.title}? It was never sent and cannot be brought back.`} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>
      {chosen && chosen.state === 'conflict' && (
        <ConflictCard entry={chosen} handler={handlers[chosen.kind]} title={describe(chosen, handlers[chosen.kind]).title}
          onClose={() => setChoosing(null)}
          onChoose={async (choice) => { await s.resolveConflict(chosen.id, choice); setChoosing(null); }} />
      )}
    </>
  );
}
