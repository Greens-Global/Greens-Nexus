import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../api';
import { SkeletonBlocks } from '../../../components/AsyncState';
import { EntityPicker } from '../../../components/accounting/reportControls';
import { PanelHead } from './PortfolioPanels.jsx';
import { ownerGroups } from '../../lib/ledgerMatch.js';

// Link to the Ledger (Neil, 11/19/2026). Production had the owner's name typed on most
// properties and the ledger entity on none, so the Financing block (PropertyLoans) showed
// nothing anywhere. This asks ONE question per distinct owner name - "Greens Heritage LLC, 25
// properties: is that 63000 in the books?" - with the match the rules found already picked
// (lib/ledgerMatch.js, no AI). A person ticks, corrects or leaves each row; nothing is linked
// by itself. Opens in place under the page's first row like Trash and Data Gaps: no box, a
// hairline above and below, rows divided by hairlines.

const WRAP = { borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', padding: '16px 0', marginBottom: 20 };
const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '8px 14px', padding: '11px 0', borderTop: '1px solid var(--border-color)' };
const DIM = { fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.5 };
const NOTE = { fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 };
const TEXT_BTN = { border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'hsl(var(--color-green))', cursor: 'pointer' };

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const namesOf = (assets) => {
  const names = assets.map((p) => p.name || 'Unnamed');
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
};
const WHY = {
  exact: 'Same name in the books.',
  close: 'Close to a name in the books - check it.',
  several: 'More than one entity in the books fits - pick one.',
  none: 'Not found in the books by name - pick one, or leave it.',
  untyped: 'Pick its entity, or leave it.',
};

function LinkRow({ rowKey, title, sub, why, none = WHY.none, pick, entities, onPick }) {
  return (
    <div style={ROW} role="listitem">
      <label className="pt-check" style={{ marginTop: 1 }}>
        <input type="checkbox" checked={pick.on && !!pick.code} disabled={!pick.code} onChange={(e) => onPick(rowKey, { ...pick, on: e.target.checked })} aria-label={`Link ${title}`} />
      </label>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        <div style={DIM}>{sub}</div>
      </div>
      <div style={{ flex: '0 1 320px', minWidth: 0 }}>
        <EntityPicker entities={entities} value={pick.code} onChange={(code) => onPick(rowKey, { code, on: !!code })} noneLabel="None" placeholder="Pick the Ledger Entity" ariaLabel={`Ledger entity for ${title}`} align="right" />
        <div style={DIM}>{pick.code ? why : none}</div>
      </div>
    </div>
  );
}

/**
 * props: assets (every live asset the person may see), onLink([{ id, code }]) - the parent saves
 * one row and writes one Activity entry per property, onClose.
 */
export function LedgerLinkPanel({ assets, onLink, onClose }) {
  const [state, setState] = useState({ entities: null, error: null });
  const [edits, setEdits] = useState({});        // only what the person changed; the rest is the suggestion

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getAccountingLocations()
      .then((d) => { if (alive) setState({ entities: d?.entities || [], error: null }); })
      .catch((e) => { if (alive) setState({ entities: [], error: e || {} }); });
    return () => { alive = false; };
  }, [attempt]);
  const load = useCallback(() => { setState({ entities: null, error: null }); setAttempt((n) => n + 1); }, []);

  const { entities, error } = state;
  const model = useMemo(() => ownerGroups(assets, entities || []), [assets, entities]);
  const rows = useMemo(() => [
    ...model.groups.map((g) => ({
      key: `o:${g.key}`, title: g.label, assets: g.assets, match: g.suggestion.match,
      sub: `${plural(g.assets.length, 'property', 'properties')} - ${namesOf(g.assets)}`,
      start: { code: g.suggestion.code, on: g.suggestion.match === 'exact' },
    })),
    ...model.untyped.map((p) => ({
      key: `p:${p.id}`, title: p.name || 'Unnamed', assets: [p], match: 'untyped', sub: 'No owner typed on this property.', start: { code: '', on: false },
    })),
  ], [model]);
  const pickOf = (r) => edits[r.key] || r.start;
  const setPick = (key, pick) => setEdits((e) => ({ ...e, [key]: pick }));

  const chosen = rows.filter((r) => pickOf(r).on && pickOf(r).code);
  const count = chosen.reduce((n, r) => n + r.assets.length, 0);
  const total = rows.reduce((n, r) => n + r.assets.length, 0);
  const submit = () => onLink(chosen.flatMap((r) => r.assets.map((p) => ({ id: p.id, code: pickOf(r).code }))));

  return (
    <section aria-label="Link to the Ledger" style={WRAP}>
      <PanelHead title="Link to the Ledger" onClose={onClose}
        subtitle={total
          ? `${plural(total, 'property has', 'properties have')} no ledger entity, so loans from the books cannot show on ${total === 1 ? 'it' : 'them'}. Each owner is asked once.`
          : 'Every property has its ledger entity.'} />
      {!total ? null : entities === null ? (
        <div role="status" aria-live="polite">
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Reading the ledger&apos;s entities...</span>
          <SkeletonBlocks count={4} height={40} borderRadius={8} />
        </div>
      ) : error ? (
        <p role="alert" style={NOTE}>
          {error.status === 403
            ? 'You do not have access to Accounting, so the ledger\'s entities cannot be listed. Someone with Accounting access can link the properties here.'
            : <>Could not read the ledger&apos;s entities{error.message ? ` - ${error.message}` : ''}. <button type="button" style={TEXT_BTN} onClick={load}>Try Again</button></>}
        </p>
      ) : (
        <>
          <div role="list" aria-label="Owners to link" style={{ maxHeight: 460, overflowY: 'auto', borderBottom: '1px solid var(--border-color)' }}>
            {rows.map((r) => (
              <LinkRow key={r.key} rowKey={r.key} title={r.title} sub={r.sub} why={edits[r.key] ? 'Picked by hand.' : WHY[r.match]} none={r.match === 'untyped' ? WHY.untyped : WHY.none} pick={pickOf(r)} entities={entities} onPick={setPick} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <button type="button" className="primary-btn" disabled={!count} onClick={submit}>
              {count ? `Link ${plural(count, 'Property', 'Properties')}` : 'Link Properties'}
            </button>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <span style={NOTE}>
              {count
                ? `${plural(count, 'property', 'properties')} of ${total} will carry ${chosen.length === 1 ? 'its' : 'their'} ledger entity. The rest stay as they are.`
                : 'Tick an owner to link its properties.'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
