// How the left navigation moves (Neil, 11/01/2026): the icon lifts under the
// pointer, one highlight glides between rows, the label flies out of the
// folded rail, the active tint travels, labels cascade in when the rail
// opens and a waiting count bumps when it changes. All of it is CSS keyed
// on two things this module writes to <html>:
//
//   data-rail-motion="off | subtle | lively | bold"   which strength is on
//   --rail-lift                                         how far the icon grows
//
// The strength is a setting. The company picks a default (Settings >
// Branding > Brand Color, `navMotion` on the branding config, Lively when
// nothing is saved); a person may choose their own under My Profile >
// Appearance (profile prefs, table "nav", key "motion"; 'default' follows
// the company). Reduced motion wins over both: it is Off, and reactively so,
// because the Oct 11 motion rules say the preference may change mid-session.
//
// Nothing here animates. The one place that reads `effective` for layout is
// Sidebar.jsx (the pills); everything else is a stylesheet rule.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useTableValue } from '../tasks/tableCols';
import { useReducedMotion } from './motion';

export const STRENGTHS = ['off', 'subtle', 'lively', 'bold'];
// Bold is the ceiling (Neil: "professional and not goofy") - a larger lift
// reads as a toy.
export const LIFT = { subtle: 1.10, lively: 1.18, bold: 1.26 };
export const DEFAULT_STRENGTH = 'lively';
export const FOLLOW_COMPANY = 'default';
export const EVENT = 'nexus:rail-motion';

export const isStrength = (v) => STRENGTHS.includes(v);

/** The one rule: reduced motion is Off; a person's own choice beats the
 *  company's; anything unknown falls back to the company, then to Lively. */
export function resolveStrength({ personal, company, reduced } = {}) {
  if (reduced) return 'off';
  if (isStrength(personal)) return personal;
  if (isStrength(company)) return company;
  return DEFAULT_STRENGTH;
}

export function applyRailMotion(effective) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) return;
  const s = isStrength(effective) ? effective : 'off';
  root.dataset.railMotion = s;
  if (s === 'off') root.style.removeProperty('--rail-lift');
  else root.style.setProperty('--rail-lift', String(LIFT[s]));
}

// The company default, read once per app load from the branding config
// (api.js caches that GET) and refreshed by the `nexus:rail-motion` event a
// Settings save fires - so an open sidebar follows without a reload.
let companyValue = DEFAULT_STRENGTH;
let companyLoaded = null;
const listeners = new Set();
function setCompany(v) {
  companyValue = isStrength(v) ? v : DEFAULT_STRENGTH;
  listeners.forEach((fn) => fn(companyValue));
}
function loadCompany() {
  if (companyLoaded) return companyLoaded;
  companyLoaded = Promise.resolve()
    .then(() => api.getBrandingConfig())
    .then((cfg) => setCompany(cfg?.navMotion))
    .catch(() => { /* keep the default; the stylesheet already knows it */ });
  return companyLoaded;
}
// Tests reset the module-level cache between cases.
export function __resetRailMotion() { companyValue = DEFAULT_STRENGTH; companyLoaded = null; }

if (typeof window !== 'undefined') {
  window.addEventListener(EVENT, (e) => setCompany(e?.detail?.navMotion));
}

export function useRailMotion() {
  const [personal, setPersonalPref] = useTableValue('nav', 'motion', FOLLOW_COMPANY);
  const [company, setCompanyState] = useState(companyValue);
  const reduced = useReducedMotion();
  useEffect(() => {
    listeners.add(setCompanyState);
    loadCompany().then(() => setCompanyState(companyValue));
    return () => listeners.delete(setCompanyState);
  }, []);
  const effective = resolveStrength({ personal: personal === FOLLOW_COMPANY ? null : personal, company, reduced });
  useEffect(() => { applyRailMotion(effective); }, [effective]);
  const setPersonal = useCallback((v) => setPersonalPref(v === FOLLOW_COMPANY || isStrength(v) ? v : FOLLOW_COMPANY), [setPersonalPref]);
  return { personal, setPersonal, company, effective };
}
