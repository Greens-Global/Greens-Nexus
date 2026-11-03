// Where each kind of queued change is sent from (field offline, Neil
// 11/03/2026; docs/Offline.md). The outbox replays a change saved yesterday
// as soon as there is signal - before anyone opens the screen it came from -
// so it must be able to load that screen's handler on its own. Each loader
// imports the module that calls registerKind(kind, ...) for it; nothing here
// loads until a change of that kind is waiting.
//
// A new field screen adds ONE line: '<module>:<thing>': () => import('...').
const construction = () => import('../../construction/constructionOffline');

const LOADERS = {
  'forms:entry': () => import('../../forms/formsOffline'),
  // Construction in the field (11/03/2026, plan phase 3): the daily log, job photos,
  // punch Done / Verified, field tickets - one module registers them all.
  'construction:log-create': construction,
  'construction:log-patch': construction,
  'construction:log-media': construction,
  'construction:log-submit': construction,
  'construction:job-photo': construction,
  'construction:punch-add': construction,
  'construction:punch-done': construction,
  'construction:punch-verify': construction,
  'construction:field-ticket': construction,
};

/** Load the module that registers `kind`. Resolves false when none is known. */
export async function loadKind(kind) {
  const load = LOADERS[kind];
  if (!load) return false;
  await load();
  return true;
}

export const knownKinds = () => Object.keys(LOADERS);
