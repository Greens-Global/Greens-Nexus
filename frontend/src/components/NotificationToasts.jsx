import { useEffect, useRef, useState } from 'react';
import { CheckCircle, XCircle, Package, ShoppingCart, RotateCcw, X } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import { useMsal }          from '@azure/msal-react';
import { useRole }          from '../contexts/RoleContext';

const TYPE_META = {
  inv_request:      { icon: Package,      color: 'var(--color-blue)'   },
  req_pending:      { icon: ShoppingCart, color: 'var(--color-orange)' },
  item_returned:    { icon: RotateCcw,    color: 'var(--color-green)'  },
  allocate_request: { icon: Package,      color: 'var(--color-orange)' },
  allocated:        { icon: CheckCircle,  color: 'var(--color-green)'  },
  approved:         { icon: CheckCircle,  color: 'var(--color-green)'  },
  rejected:         { icon: XCircle,      color: 'var(--color-red)'    },
};

const LIFESPAN = 7000; // how long a popup stays before auto-dismissing

// On-screen popups for incoming notifications — the bell badge alone is easy to
// miss when you're heads-down in another view, so freshly-arrived notifications
// also surface here briefly before settling into the bell's list.
export default function NotificationToasts({ onNavigate }) {
  const { notifications, openApproval } = useNotifications();
  const { accounts }      = useMsal();
  const { can }           = useRole();
  const myName  = accounts[0]?.name     ?? '';
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [popups, setPopups] = useState([]);
  const seenIds   = useRef(null);
  const timersRef = useRef({});

  useEffect(() => {
    // First run: remember everything that already exists so refreshes/logins
    // don't dump a wall of "new" popups on screen.
    if (seenIds.current === null) {
      seenIds.current = new Set(notifications.map(n => n.id));
      return;
    }
    const fresh = notifications.filter(n => {
      if (seenIds.current.has(n.id)) return false;
      seenIds.current.add(n.id);
      const isActionable = (n.type === 'inv_request' || n.type === 'req_pending' || n.type === 'checkout_pending');
      if (isActionable) return can('manager') && !n.recipient;
      // item_returned with no recipient must not toast for non-managers (avoids broadcasting returns to all employees)
      if (n.type === 'item_returned' && !n.recipient) return can('manager');
      return !n.recipient || n.recipient === myEmail || n.recipient === myName;
    });
    if (fresh.length === 0) return;

    setPopups(prev => [...fresh.map(n => ({ ...n, _popupId: `pop-${n.id}` })), ...prev].slice(0, 4));
    fresh.forEach(n => {
      timersRef.current[n.id] = setTimeout(() => {
        setPopups(prev => prev.filter(p => p.id !== n.id));
        delete timersRef.current[n.id];
      }, LIFESPAN);
    });
  }, [notifications, can, myEmail, myName]);

  useEffect(() => () => {
    Object.values(timersRef.current).forEach(clearTimeout);
  }, []);

  function close(id) {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setPopups(prev => prev.filter(p => p.id !== id));
  }

  function handleClick(n) {
    const isActionable = (n.type === 'inv_request' || n.type === 'req_pending' || n.type === 'checkout_pending') && !n.recipient;
    if (isActionable && can('manager')) {
      // Jump straight into the approval workflow (allocator picker / reject
      // reason) in the bell panel — no extra navigation or hunting required.
      openApproval(n.id);
    } else if (n.action?.view && onNavigate) {
      onNavigate(n.action.view, n.action.sub);
    }
    close(n.id);
  }

  if (popups.length === 0) return null;

  return (
    <div style={{ position: 'fixed', top: 70, right: 16, zIndex: 500, display: 'flex', flexDirection: 'column', gap: 10, width: 320, maxWidth: 'calc(100vw - 32px)' }}>
      {popups.map(n => {
        const meta = TYPE_META[n.type] ?? TYPE_META['approved'];
        return (
          <div key={n._popupId}
            onClick={() => handleClick(n)}
            style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
              boxShadow: 'var(--shadow-lg)', padding: '12px 14px', cursor: 'pointer',
              animation: 'fadeInUp 0.2s cubic-bezier(.16,1,.3,1) both',
            }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: `hsla(${meta.color},0.14)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <meta.icon size={16} color={`hsl(${meta.color})`} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--ink)' }}>{n.title}</div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 0', lineHeight: 1.4 }}>{n.body}</p>
            </div>
            <button onClick={e => { e.stopPropagation(); close(n.id); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2, borderRadius: 4, flexShrink: 0 }}
              aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
