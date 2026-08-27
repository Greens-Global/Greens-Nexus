import { useState, useEffect, useMemo } from "react";
import { Search, X, UserCog } from "lucide-react";
import { api } from "../api";
import { matchPeople, onEnterPickFirst } from "../lib/peopleSearch";

// Picker for starting an Act As session (Jul 2026). The eligible list is
// already filtered server-side to roles strictly below the caller's own -
// nothing here needs to re-derive that rule, just search/select/start.
export default function ActAsModal({ onClose, onStart }) {
  const [people, setPeople]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ]             = useState("");
  const [starting, setStarting] = useState("");
  const [error, setError]     = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getActAsEligibleTargets()
      .then(list => { if (!cancelled) setPeople(list); })
      .catch(() => { if (!cancelled) setError("Couldn't load the people list."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => matchPeople(people, q), [people, q]);

  async function pick(person) {
    if (starting) return;
    setStarting(person.email);
    setError("");
    try {
      await onStart(person.email);
      onClose();
    } catch (err) {
      setError(err?.message || "Couldn't start Act As.");
      setStarting("");
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: 380, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserCog size={16} style={{ color: 'var(--muted)' }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Act As</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '12px 18px 0' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…"
              onKeyDown={onEnterPickFirst(filtered, pick)}
              style={{ width: '100%', padding: '8px 10px 8px 30px', borderRadius: 8, border: '1px solid var(--line)', fontFamily: 'Inter, sans-serif', fontSize: 13, background: 'var(--bg)', color: 'var(--ink)', boxSizing: 'border-box' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 2px 4px', lineHeight: 1.4 }}>
            You'll see and act in Nexus exactly as they can, until you exit - every action while acting is still recorded under your name too.
          </div>
        </div>

        {error && <div style={{ margin: '4px 18px 0', fontSize: 12, color: 'hsl(var(--color-red))' }}>{error}</div>}

        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 8px 10px', marginTop: 4 }}>
          {loading && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 16, fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
              {people.length === 0 ? "No one is eligible - Act As only works on roles strictly below your own." : "No matches."}
            </div>
          )}
          {filtered.map(p => (
            <button key={p.email} onClick={() => pick(p)} disabled={!!starting}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px',
                background: 'transparent', border: 'none', borderRadius: 8, textAlign: 'left',
                cursor: starting ? 'default' : 'pointer', opacity: starting && starting !== p.email ? 0.5 : 1,
                fontFamily: 'Inter, sans-serif',
              }}
              onMouseEnter={e => { if (!starting) e.currentTarget.style.background = 'var(--mist)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>
                {p.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email}</div>
              </div>
              {starting === p.email && <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>Starting…</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
