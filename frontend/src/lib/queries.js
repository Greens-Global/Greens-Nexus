// Canonical data hooks (Aug 1, 2026) - the reference-data reads, on TanStack
// Query. These replace the ad-hoc `api.getX()` + useEffect pattern for the
// data that is read constantly and changes slowly (people, roles, item types,
// groups, entities, pickers). Any screen needing this data calls the hook and
// gets shared, deduped, cache-backed results - no manual loading state, no
// redundant fetch on revisit.
//
// Migration pattern for the rest of the app (see ENTERPRISE-HARDENING.md):
//   before:  const [x, setX] = useState([]);
//            useEffect(() => { api.getX().then(setX); }, []);
//   after:   const { data: x = [] } = useX();
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { qk } from './queryClient';

// staleTime per query reflects how fast each source actually changes; the
// server caches these too (cache.py), so a refetch is cheap even on a miss.
export function usePeopleDirectory(options = {}) {
  return useQuery({ queryKey: qk.peopleDirectory, queryFn: api.getPeopleDirectory,
                    staleTime: 60_000, ...options });
}
export function useRolesDirectory(options = {}) {
  return useQuery({ queryKey: qk.rolesDirectory, queryFn: api.getRolesDirectory,
                    staleTime: 60_000, ...options });
}
export function useItemTypes(options = {}) {
  return useQuery({ queryKey: qk.itemTypes, queryFn: api.getItemTypes,
                    staleTime: 300_000, ...options });
}
export function useItemApprovers(options = {}) {
  return useQuery({ queryKey: qk.itemApprovers, queryFn: api.getItemApprovers,
                    staleTime: 120_000, ...options });
}
export function useItemAllocators(options = {}) {
  return useQuery({ queryKey: qk.itemAllocators, queryFn: api.getItemAllocators,
                    staleTime: 120_000, ...options });
}
export function useGroups(options = {}) {
  return useQuery({ queryKey: qk.groups, queryFn: api.getGroups,
                    staleTime: 30_000, ...options });
}
export function useEntities(options = {}) {
  return useQuery({ queryKey: qk.entities, queryFn: api.getEntities,
                    staleTime: 120_000, ...options });
}
export function useWorkSites(options = {}) {
  return useQuery({ queryKey: qk.workSites, queryFn: api.getWorkSites,
                    staleTime: 120_000, ...options });
}
export function useBranding(options = {}) {
  return useQuery({ queryKey: qk.branding, queryFn: api.getBrandingConfig,
                    staleTime: 300_000, ...options });
}
export function useMyRole(options = {}) {
  return useQuery({ queryKey: qk.myRole, queryFn: api.getMyRole,
                    staleTime: 120_000, ...options });
}
