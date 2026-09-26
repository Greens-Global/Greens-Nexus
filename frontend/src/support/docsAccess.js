// Who may read which page of the guide - the same rule as the left menu
// (Sidebar.jsx): baseline screens for everyone, gated ones for admins or an
// explicit Access Group / job-role grant; external guests get only what they
// were granted. Guide-only pages (no `view`, e.g. Getting Started) are for
// everyone. Shared by the Documentation tab and every help search, so a
// search can never point someone at a page the Documentation tab hides.
import { useCallback, useMemo } from 'react';
import { NAV } from '../components/Sidebar';
import { useRole } from '../contexts/RoleContext';
import { DOCS } from './docsContent';

export function canReadDoc(doc, { can, myGrantedModules, isExternal }) {
  if (!doc) return false;
  if (!doc.view) return true;
  if (isExternal) return !!myGrantedModules?.has(doc.view);
  const item = NAV.find((n) => n.view === doc.view);
  return !item?.minRole || !!can?.('administrator') || !!myGrantedModules?.has(doc.view);
}

/** { allowed: DOCS this person can read, allow(docId) -> boolean }. */
export function useDocAccess() {
  const { can, myGrantedModules, isExternal } = useRole();
  const computed = DOCS.filter((d) => canReadDoc(d, { can, myGrantedModules, isExternal }));
  // Keyed on the resulting id list, not on the role functions: those may be
  // new on every render, and callers use `allow` as an effect dependency.
  const key = computed.map((d) => d.id).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allowed = useMemo(() => computed, [key]);
  const ids = useMemo(() => new Set(key.split('|')), [key]);
  const allow = useCallback((docId) => ids.has(docId), [ids]);
  return { allowed, allow };
}
