# Data fetching - TanStack Query

Adopted 2026-08-01. TanStack Query (React Query) is now the standard way Nexus
screens read server data. This is the scalable foundation - build every new
screen on it, and convert existing screens to it as you touch them.

## The architecture

Three layers, one responsibility each:

1. **`api.js`** - the fetch engine. MSAL auth, retry/backoff, Act-As header,
   error shaping, the `_getCache` legacy cache. Unchanged. Query functions call
   into it. NEVER bypass it with a raw `fetch`.
2. **`lib/queryClient.js`** - the shared client + the `qk` query-key registry +
   the `invalidateAll` / `clearOnIdentitySwitch` helpers. The client is wired
   into the app in `main.jsx` (`QueryClientProvider`) and bridged into `api.js`
   via `setCacheBridge` so writes and Act-As switches invalidate/clear the cache
   automatically.
3. **`lib/queries.js`** - the `useX()` hooks screens actually call.

## Using it

```jsx
import { usePeopleDirectory } from '../lib/queries';

function Picker() {
  const { data: directory = [], isLoading } = usePeopleDirectory();
  // directory is shared, deduped, and cached across every screen using it.
}
```

## Converting an existing screen

```jsx
// before - refetches on every mount, no sharing, manual loading state
const [dir, setDir] = useState([]);
useEffect(() => { api.getPeopleDirectory().then(setDir).catch(() => {}); }, []);

// after - shared cache, deduped, background refresh, zero boilerplate
const { data: dir = [] } = usePeopleDirectory();
```

Rules:
- Always default the data: `const { data: x = [] } = useX()` (data is
  `undefined` on first render).
- If the endpoint isn't in `lib/queries.js` yet, add a hook there and a key in
  `qk` first - never inline a `queryKey` string at a call site.
- Remove the now-dead `useState` + `useEffect` + any import that became unused.

## Writes / invalidation

Today, ANY successful mutation through `api.js` broadly invalidates the whole
cache (mirrors the old `_getCache.clear()`), so migrated screens are always
coherent with zero extra work. As screens mature, tighten a specific mutation
to invalidate only what it touched:

```jsx
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/queryClient';
const queryClient = useQueryClient();
await api.addItemType(name);
queryClient.invalidateQueries({ queryKey: qk.itemTypes });   // narrow, not global
```

## What is NOT on TanStack Query (by design)

- **Realtime module state** (inventory, tasks, requisitions, notifications).
  These live in app-level contexts fed by Supabase realtime pings and are
  correctness-sensitive. Leave them until a dedicated pass; when converting,
  bridge a ping to `queryClient.invalidateQueries({ queryKey })` instead of a
  manual refetch. Do NOT casually swap these.
- **Mutations themselves** stay as direct `api.js` calls for now. `useMutation`
  is a later refinement, not required for the cache benefit.

## Migration status

**Converted (all clean component-mount reference reads):**
- `usePeopleDirectory` - Assignments, Purchase, LoginPage-adjacent pickers,
  FundsTab, InvestorsTab, Testing, HR (group-manager panel), RolesAccess (both
  the main screen and the add-member dialog), InventoryManagement (people picker)
- `useItemApprovers` - Purchase
- `useWorkSites` - PayrollTimecard
- `useRolesDirectory` - CredentialVault
- `useEntities` - Documents
- `useBranding` - LoginPage

**Deliberately NOT converted (a hook here would be incorrect, not just skipped):**
- **Non-components** - `lib/brandAccent.js` (plain async util), `tasks/components.jsx`
  (module-level singleton promise), `lib/useNameResolver.js` (own caching contract,
  many consumers). React hooks are illegal outside a component/hook body.
- **Core auth context** - `contexts/RoleContext.jsx` (getMyRole + getGroups with
  event-driven refetch). Highest-blast-radius file in the app; convert only in a
  dedicated, carefully-tested pass, never casually.
- **Imperative refresh functions** - `HR.loadEntities/loadSites`, `RolesAccess.loadGroups`,
  `AdminPanel` branding form load, `InventoryManagement.refreshItemTypes` and the
  approver/allocator fetches inside handlers. These fire on demand after writes,
  not on mount; they already benefit from the server cache and the api.js
  invalidation bridge. Converting them means moving to `invalidateQueries`, which
  is a refinement, not a correctness fix - do it per-screen when touched.
- **Bundled with non-reference calls** - `SOP.jsx` (directory inside a Promise.all
  with a course-specific call), `HR:1044` (with getJobRoles).

The two cache layers (TanStack for migrated reads, `cachedGet` for the rest)
coexist safely, so the app is fully correct at every step. New screens: always
use the hooks.
