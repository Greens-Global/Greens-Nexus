// Where each kind of queued change is sent from (field offline, Neil
// 11/03/2026; docs/Offline.md). The outbox replays a change saved yesterday
// as soon as there is signal - before anyone opens the screen it came from -
// so it must be able to load that screen's handler on its own. Each loader
// imports the module that calls registerKind(kind, ...) for it; nothing here
// loads until a change of that kind is waiting.
//
// A new field screen adds ONE line: '<module>:<thing>': () => import('...').
const LOADERS = {
  'forms:entry': () => import('../../forms/formsOffline'),
};

/** Load the module that registers `kind`. Resolves false when none is known. */
export async function loadKind(kind) {
  const load = LOADERS[kind];
  if (!load) return false;
  await load();
  return true;
}

export const knownKinds = () => Object.keys(LOADERS);
