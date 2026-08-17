// External passwordless auth client helpers (Aug 18) - shared by the
// activation page (/activate/{token}) and the login page's Partner Sign-In.
import { useState, useEffect, useRef } from 'react';
// Plain fetch, not api.js: these run BEFORE any session exists, and in cookie
// mode they must ride the same-origin /api proxy so the Set-Cookie the backend
// returns lands first-party. Localhost dev talks straight to the API.
import { BFF_MODE } from '../bffAuth';

export const EXTERNAL_AUTH_API = BFF_MODE ? '/api' : (import.meta.env.VITE_API_BASE ?? 'http://localhost:8000');

export async function externalAuthPost(path, body) {
  const res = await fetch(`${EXTERNAL_AUTH_API}${path}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data?.detail || 'Something went wrong - try again.');
  return data;
}

// 30s resend countdown shared by both code screens.
export function useResendTimer() {
  const [left, setLeft] = useState(0);
  const timer = useRef(null);
  const start = (s = 30) => {
    setLeft(s);
    clearInterval(timer.current);
    timer.current = setInterval(() => setLeft(v => {
      if (v <= 1) { clearInterval(timer.current); return 0; }
      return v - 1;
    }), 1000);
  };
  useEffect(() => () => clearInterval(timer.current), []);
  return [left, start];
}
