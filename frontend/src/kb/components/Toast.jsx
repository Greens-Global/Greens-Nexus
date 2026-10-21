// One small notice pill for the module ("Saved", "Could not publish").
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const Ctx = createContext(() => {});

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const toast = useCallback((text, kind = 'ok') => {
    clearTimeout(timer.current);
    setMsg({ text: String(text || ''), kind });
    timer.current = setTimeout(() => setMsg(null), kind === 'err' ? 6000 : 2600);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {msg && (
        <div role="status" style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 6000, maxWidth: 'min(92vw, 560px)',
          padding: '10px 16px', borderRadius: 999, fontSize: 13.5, fontWeight: 600, color: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
          background: msg.kind === 'err' ? '#b91c1c' : '#0f172a' }}>
          {msg.text}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}

export function errText(e, fallback = 'Something went wrong') {
  return e?.detail || e?.message || fallback;
}
