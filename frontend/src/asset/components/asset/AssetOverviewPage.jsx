// An asset's Overview (Neil, 11/17/2026 redesign; mock after/asset.png). Two columns: the
// main one reads top to bottom - Needs Attention, the details (AssetDetailForm), the Site
// Model, Media - and the 360px rail holds what you glance at: Key Details (how complete the
// record is), Location (a real map of the stored point), Units, Work (open tickets and jobs,
// Report a Problem), Financing (the ledger's loans) and Recent Changes. Under ~1100px the rail
// drops under the main column. A vehicle or a piece of equipment gets the same shape with its
// own facts (Service and Papers instead of the property blocks).
//
// The module shell (asset/App.jsx) renders this for view 'property' and keeps the title band,
// the tabs and the walk between assets; nothing here repeats them. Edit mode is the detail
// form's own (AssetDetailForm), at full width: the form stays mounted in the same place in
// both modes, so starting an edit never resets it.
import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import ProgressTrack from '../../../ui/ProgressTrack.jsx';
import PropertyJobs from '../../../components/PropertyJobs.jsx';
import PropertyLoans from '../../../components/PropertyLoans.jsx';
import { formatDateTime } from '../../../lib/datetime';
import { assetCompleteness, assetSignals } from '../../lib/assetMetrics.js';
import { inferAssetKind } from '../../lib/vehicleFields.js';
import { formatDate, formatNumber } from '../../lib/format.js';
import { usePropertyTickets, TICKET_STATUS } from '../../lib/propertyTickets.js';
import { NeedsAttention } from './AssetOverview.jsx';
import { AssetDetailForm } from './AssetDetailForm.jsx';
import { AssemblageParcels } from './AssemblageParcels.jsx';
import { PhotoGallery } from './PhotoGallery.jsx';
import { SiteModelSection, useSiteModel, siteModelInventory } from './SiteModelSection.jsx';
import { AssetLocationMap, mapTargets } from './PropertyMapLink.jsx';
import { PropertyTicketComposer } from '../maintenance/ticketMounts.jsx';
import { TONE_COLOR } from '../shared/StatusBadge.jsx';

// The layout's only media rule: one column under 1100px. Scoped to this page's classes.
const CSS = `
.ax-ov{display:grid;grid-template-columns:minmax(0,1fr) 360px;column-gap:56px;align-items:start}
.ax-ov.is-editing{grid-template-columns:minmax(0,1fr)}
@media (max-width:1100px){.ax-ov{grid-template-columns:minmax(0,1fr)}.ax-ov-rail{border-top:1px solid var(--border-color);padding-top:4px}}
`;

const link = { border: 'none', background: 'none', padding: 0, fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'hsl(var(--color-green))', cursor: 'pointer', textDecoration: 'none' };
const dim = { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 };
const SIGNAL_TONE = { ok: 'green', warn: 'orange', bad: 'red', info: 'blue', mut: 'mut' };

/** One block of the rail: a 13/600 title, an optional action on its right, a hairline above. */
function RailBlock({ title, action, children, id, first }) {
  return (
    <section aria-label={title} id={id} style={{ padding: first ? '0 0 20px' : '20px 0', borderTop: first ? 'none' : '1px solid var(--border-color)', scrollMarginTop: 108 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</h3>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {children}
    </section>
  );
}

function Kv({ k, v, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
      <span style={{ color: tone ? TONE_COLOR[tone] : 'var(--text-primary)', fontWeight: tone && tone !== 'mut' ? 500 : 400, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const clip = (v, n = 40) => { const t = String(v ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** One log entry as a short line: "Country set to United States". */
export function changeLine(l) {
  const ch = l.changes || [];
  if (l.action === 'added') return `Added ${l.item || l.section || 'a record'}`;
  if (l.action === 'removed') return `Removed ${l.item || l.section || 'a record'}`;
  if (ch.length === 1) {
    const c = ch[0];
    const to = ISO_DAY.test(String(c.to ?? '')) ? formatDate(c.to) : clip(c.to);
    return to ? `${c.field} set to ${to}` : `${c.field} cleared`;
  }
  if (ch.length > 1) return `${ch.length} fields edited: ${ch.slice(0, 2).map((c) => c.field).join(', ')}${ch.length > 2 ? ' and more' : ''}`;
  return `Edited ${l.item || l.section || 'the asset'}`;
}

/** "a, b and c" */
const words = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * props: asset, store, editing, onTab(view), onGoTo(logEntry), onStartEdit(fieldLabel?),
 * detailFormProps (exactly what AssetDetailForm took in App.jsx), onSaveEntityCode(code),
 * onOpenAsset(id).
 */
export function AssetOverviewPage({ asset, store, editing = false, onTab, onGoTo, onStartEdit, detailFormProps = {}, onSaveEntityCode, onOpenAsset }) {
  const isProperty = inferAssetKind(asset) === 'property';
  const site = useSiteModel(isProperty ? asset : null);
  const showModel = isProperty && !!site.match;
  const startEdit = (field) => onStartEdit?.(field);

  return (
    <div>
      <style>{CSS}</style>
      {isProperty && asset.assembled && !asset.parentId && <AssemblageParcels lead={asset} all={store.properties || []} onOpen={onOpenAsset} />}
      <div className={editing ? 'ax-ov is-editing' : 'ax-ov'}>
        <div className="ax-ov-main" style={{ minWidth: 0 }}>
          {!editing && <NeedsAttention asset={asset} store={store} onTab={onTab} onEdit={startEdit} />}
          {!editing && <div aria-hidden="true" style={{ borderTop: '1px solid var(--border-color)', marginBottom: 22 }} />}
          <AssetDetailForm {...detailFormProps} p={asset} onFillIn={onStartEdit ? startEdit : undefined} />
          {showModel && !editing && (
            <div id="gt-model" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 22, marginBottom: 22, scrollMarginTop: 108 }}>
              <SiteModelSection p={asset} site={site} />
            </div>
          )}
          <div id="gt-media" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 22, marginTop: editing ? 22 : 0, scrollMarginTop: 108 }}>
            <PhotoGallery p={asset} onSave={detailFormProps.onSaveImages} />
          </div>
        </div>
        {!editing && (
          <aside className="ax-ov-rail" aria-label="At a Glance" style={{ minWidth: 0 }}>
            <KeyDetails asset={asset} onStartEdit={startEdit} />
            {isProperty ? (
              <>
                <RailBlock title="Location" id="gt-map"
                  action={mapTargets(asset).hasLocation ? <a href={mapTargets(asset).openUrl} target="_blank" rel="noreferrer" style={link}>Open in Maps</a> : null}>
                  <AssetLocationMap asset={asset} onAddAddress={() => startEdit('Property Address')} />
                </RailBlock>
                <Units asset={asset} site={site} />
                <Work asset={asset} onTab={onTab} />
                <RailBlock title="Financing">
                  <PropertyLoans property={asset} onSaveEntityCode={onSaveEntityCode} variant="rail" />
                </RailBlock>
              </>
            ) : (
              <ServiceAndPapers asset={asset} store={store} onTab={onTab} />
            )}
            <RecentChanges asset={asset} logs={store.logs} onGoTo={onGoTo} onTab={onTab} />
          </aside>
        )}
      </div>
    </div>
  );
}

function KeyDetails({ asset, onStartEdit }) {
  const gaps = useMemo(() => assetCompleteness(asset), [asset]);
  return (
    <RailBlock first title="Key Details" action={<span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{gaps.pct}% filled</span>}>
      <ProgressTrack value={gaps.pct / 100} state="done" size="sm" label="Key details filled in" valueText={`${gaps.pct}% of the key details filled in`} />
      {gaps.missing.length ? (
        <>
          <p style={{ ...dim, marginTop: 10 }}>Missing {words(gaps.missing.slice(0, 6))}{gaps.missing.length > 6 ? ` and ${gaps.missing.length - 6} more` : ''}.</p>
          <button type="button" onClick={() => onStartEdit(gaps.missing[0])} style={{ ...link, marginTop: 8 }}>Fill In the Gaps</button>
        </>
      ) : <p style={{ ...dim, marginTop: 10 }}>Every key detail is on file.</p>}
    </RailBlock>
  );
}

const UNIT_FIELDS = [['unitsClimate', 'Climate-controlled'], ['unitsNonClimate', 'Non-climate'], ['unitsRV', 'Vehicle spaces'], ['unitsResidential', 'Residential'], ['unitsCommercial', 'Commercial'], ['unitsMailbox', 'Mailboxes'], ['unitsOther', 'Other']];

function Units({ asset, site }) {
  if (site.model) {
    const inv = siteModelInventory(site.model);
    if (!inv.total) return null;
    const pct = Math.round((100 * inv.leased) / inv.total);
    return (
      <RailBlock title="Units" action={<button type="button" style={link} onClick={() => document.getElementById('gt-model')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}>Open Site Model</button>}>
        <Kv k="Leased" v={formatNumber(inv.leased)} />
        <Kv k="Vacant" v={formatNumber(inv.vacant)} />
        <Kv k="Out of service" v={formatNumber(inv.bad)} tone={inv.bad ? 'red' : undefined} />
        <p style={{ ...dim, fontSize: 12, marginTop: 6 }}>{pct}% leased - {formatNumber(inv.leased)} of {formatNumber(inv.total)} units, from the Site Model.</p>
      </RailBlock>
    );
  }
  const rows = UNIT_FIELDS.filter(([k]) => Number(String(asset[k] ?? '').replace(/[^0-9.]/g, '')) > 0);
  const total = Number(String(asset.unitsTotal ?? '').replace(/[^0-9.]/g, '')) || 0;
  if (!rows.length && !total) return null;
  return (
    <RailBlock title="Units">
      {rows.map(([k, l]) => <Kv key={k} k={l} v={formatNumber(asset[k])} />)}
      {total > 0 && <Kv k="Total" v={formatNumber(total)} />}
      <p style={{ ...dim, fontSize: 12, marginTop: 6 }}>From the details on file - no Site Model yet.</p>
    </RailBlock>
  );
}

function Work({ asset, onTab }) {
  const tickets = usePropertyTickets(asset.id);
  const [jobs, setJobs] = useState(null);       // what PropertyJobs read: { open: [] } once loaded
  const [composing, setComposing] = useState(false);
  const open = tickets.data?.open || [];
  const loaded = !!tickets.data || !!tickets.error;
  const jobsOpen = jobs?.unavailable ? 0 : (jobs?.open || []).length;
  return (
    <RailBlock title="Work" action={<button type="button" style={link} onClick={() => setComposing(true)}>Report a Problem</button>}>
      {open.slice(0, 3).map((t) => {
        const [label, tone] = TICKET_STATUS[t.status] || [t.status, 'mut'];
        return (
          <button key={t.id} type="button" onClick={() => onTab?.('maintenance')}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 0', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t.subject}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>
              {t.codeLabel}{' · '}<span style={{ color: TONE_COLOR[tone] || TONE_COLOR.mut, fontWeight: 600 }}>{label}</span>
            </span>
          </button>
        );
      })}
      {open.length > 3 && (
        <button type="button" onClick={() => onTab?.('maintenance')} style={{ ...link, display: 'inline-flex', alignItems: 'center', gap: 4, margin: '4px 0' }}>
          {open.length - 3} more open <ArrowRight size={13} aria-hidden="true" />
        </button>
      )}
      <PropertyJobs property={asset} variant="rail" onLoaded={setJobs} />
      {loaded && jobs && !open.length && !jobsOpen && <p style={dim}>No open tickets or construction jobs.</p>}
      {composing && <PropertyTicketComposer property={{ id: asset.id, name: asset.name }} onClose={() => { setComposing(false); tickets.reload?.(); }} />}
    </RailBlock>
  );
}

function ServiceAndPapers({ asset, store, onTab }) {
  const signals = useMemo(() => assetSignals(asset, store), [asset, store]);
  return (
    <RailBlock title="Service and Papers" action={onTab ? <button type="button" style={link} onClick={() => onTab('vservice')}>Service Log</button> : null}>
      {signals.map((s) => <Kv key={s.l} k={s.l} v={s.v} tone={SIGNAL_TONE[s.t]} />)}
    </RailBlock>
  );
}

function RecentChanges({ asset, logs, onGoTo, onTab }) {
  const recent = useMemo(() => (logs || []).filter((l) => l.propertyId === asset.id).slice(0, 3), [logs, asset.id]);
  return (
    <RailBlock title="Recent Changes" action={onTab ? <button type="button" style={link} onClick={() => onTab('activity')}>All Activity</button> : null}>
      {recent.length === 0 ? <p style={dim}>No changes recorded yet.</p> : recent.map((l) => (
        <button key={l.id} type="button" onClick={() => onGoTo?.(l)} title="Go to this change"
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 0', border: 'none', background: 'none', cursor: onGoTo ? 'pointer' : 'default', fontFamily: 'inherit' }}>
          <span style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{changeLine(l)}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)' }}>{l.user ? `${l.user} · ` : ''}{formatDateTime(l.ts)}</span>
        </button>
      ))}
    </RailBlock>
  );
}
