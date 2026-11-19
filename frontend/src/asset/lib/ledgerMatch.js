// Link to the Ledger (Neil, 11/19/2026). A property shows its loans from the books only once it
// carries its ledger entity as `entityCode` (components/PropertyLoans.jsx). Production had the
// owner's NAME typed on most properties ("Greens Heritage LLC", "Greens Heritage LL", "Greens
// Heritage, LLC.") and the code on none, so the Financing block showed nothing anywhere. This
// matches the typed names to the ledger's entities by RULES (no AI): one question per distinct
// owner, a suggestion a person accepts or corrects - never applied by itself.
import { inferAssetKind } from './vehicleFields.js';
import { isHistoricalEntity } from '../../components/accounting/reportModel';

// Words that say what KIND of company it is, not which one. "ll" is a cut-off "LLC".
const KIND_WORDS = new Set(['llc', 'll', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
  'partnership', 'lp', 'llp', 'private', 'pvt', 'the', 'and']);
// One spelling for words the books and the property sheet write differently.
const SAME = { investment: 'inv', investments: 'inv', invest: 'inv' };

/** A company name reduced to the words that tell it apart: "(G) Greens Heritage, LLC." -> "greens heritage". */
export function ownerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^(\s*\([^)]*\)\s*)+/, ' ')           // the books' leading tags: (G), (AM)
    .replace(/&/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')   // "inv1" -> "inv 1"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((w) => SAME[w] || w)
    .filter((w) => w && !KIND_WORDS.has(w))
    .join(' ');
}

const usable = (e) => !!e?.code && e.is_active !== false && !isHistoricalEntity(e);
const byCode = (a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true });

/**
 * The ledger entity a typed owner name most likely means.
 * -> { code, name, match: 'exact' | 'close' | 'several' | 'none' }
 * exact: the same name once the company words are dropped - the entity itself when the books
 * hold it at several levels (a parent "63000" over its "(G) 63001"). close: one entity whose
 * name holds every word of the typed one, or the other way around. several: more than one fits
 * equally, so nothing is offered. A historical (H) or inactive entity is never offered.
 */
export function suggestEntity(typed, entities) {
  const key = ownerKey(typed);
  const none = { code: '', name: '', match: 'none' };
  if (!key) return none;
  const list = (entities || []).filter(usable).map((e) => ({ e, key: ownerKey(e.name) })).filter((x) => x.key);
  const same = list.filter((x) => x.key === key).map((x) => x.e).sort(byCode);
  if (same.length) {
    const top = same.filter((e) => !e.parent_code);
    // A parent and its own child of the same name are one company: take the parent.
    const pool = top.length ? top : same.filter((e) => !same.some((p) => p.code === e.parent_code));
    if (pool.length === 1) return { code: pool[0].code, name: pool[0].name || '', match: 'exact' };
    return { ...none, match: 'several' };
  }
  const words = key.split(' ');
  if (words.length < 2) return none;
  const near = list.filter((x) => {
    const theirs = x.key.split(' ');
    if (theirs.length < 2) return false;
    return words.every((w) => theirs.includes(w)) || theirs.every((w) => words.includes(w));
  }).map((x) => x.e).filter((e) => !e.parent_code).sort(byCode);
  if (near.length === 1) return { code: near[0].code, name: near[0].name || '', match: 'close' };
  return near.length > 1 ? { ...none, match: 'several' } : none;
}

const isProperty = (p) => !!p && !p.deleted && inferAssetKind(p) === 'property';
/** Live properties (parcels included) with no ledger entity yet. */
export const unlinkedProperties = (assets) => (assets || []).filter((p) => isProperty(p) && !String(p.entityCode || '').trim());

/**
 * What the panel asks: one row per distinct owner name among the unlinked properties, most
 * properties first, each with its suggestion; `untyped` are the properties with no owner typed.
 * -> { groups: [{ key, label, assets, suggestion }], untyped: [asset] }
 */
export function ownerGroups(assets, entities) {
  const groups = new Map();
  const untyped = [];
  unlinkedProperties(assets).forEach((p) => {
    const typed = String(p.entity || '').trim();
    const key = ownerKey(typed);
    if (!key) { untyped.push(p); return; }
    if (!groups.has(key)) groups.set(key, { key, labels: new Map(), assets: [] });
    const g = groups.get(key);
    g.assets.push(p);
    g.labels.set(typed, (g.labels.get(typed) || 0) + 1);
  });
  const out = [...groups.values()].map((g) => {
    // The spelling most properties use names the row; the longest wins a tie ("LLC" over "LL").
    const label = [...g.labels.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    return { key: g.key, label, assets: g.assets.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))), suggestion: suggestEntity(label, entities) };
  });
  out.sort((a, b) => b.assets.length - a.assets.length || a.label.localeCompare(b.label));
  return { groups: out, untyped: untyped.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))) };
}
