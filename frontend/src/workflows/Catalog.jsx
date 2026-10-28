// Workflows > Catalog (Oct 28 2026): what the app can do today - every
// trigger, field, action and list source the backend registers, per module,
// with a New chip on what was added since this person last looked. Nothing
// here is hard-coded: the screen draws GET /workflows/catalog and grows
// with it. The New chips are shown first and only then marked seen, so
// they appear exactly once.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Zap, ListChecks, Play, Table2, Sparkles } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { formatDateTime } from '../lib/datetime';
import { useCatalog } from './lib/useCatalog';
import { moduleLabel, sortModules } from './lib/modules';

const TYPE_LABELS = {
  text: 'Text', number: 'Number', date: 'Date', datetime: 'Date and time', select: 'Choice', person: 'Person',
  people: 'People', bool: 'Yes / No', money: 'Money', template: 'Text with fields', recipients: 'Recipients',
  duration: 'Duration', date_offset: 'Date offset', entity_ref: 'Record', approvers: 'Approvers', options: 'Options',
  list_source: 'List',
};
const typeLabel = (t) => TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');
const VISIBILITY = { hr: 'HR Only', comp: 'Compensation' };

function Chip({ children, tone = 'muted', title }) {
  return <span className={`status-badge pill-${tone}`} style={{ fontWeight: 600 }} title={title}>{children}</span>;
}
function NewChip() { return <Chip tone="info">New</Chip>; }

const match = (q, ...parts) => !q || parts.some((p) => String(p || '').toLowerCase().includes(q));

function Section({ Icon, title, count, children }) {
  return (
    <section aria-label={title} style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}>
        <Icon size={14} style={{ color: 'var(--muted)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, flex: 1 }}>{title}</h3>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{count}</span>
      </div>
      {count === 0
        ? <div style={{ padding: '14px 16px', fontSize: 12.5, color: 'var(--muted)' }}>Nothing here for this module{' '}yet.</div>
        : <div>{children}</div>}
    </section>
  );
}

function Row({ title, chips, children }) {
  return (
    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        {chips}
      </div>
      {children && <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{children}</div>}
    </div>
  );
}

export default function Catalog() {
  const { catalog, loading, error, isNew } = useCatalog();
  const [module, setModule] = useState('');
  const [q, setQ] = useState('');
  const seen = useRef(false);

  // Mark the catalog seen only after the New chips have painted.
  useEffect(() => {
    if (!catalog || seen.current) return;
    seen.current = true;
    api.wfCatalogSeen?.()?.catch?.(() => {});
  }, [catalog]);

  const modules = useMemo(() => sortModules([
    ...(catalog?.entities || []).map((e) => e.module),
    ...(catalog?.events || []).map((e) => e.module),
    ...(catalog?.actions || []).map((a) => a.module),
    ...(catalog?.listSources || []).map((l) => l.module),
  ]), [catalog]);
  const picked = module || modules[0] || '';
  const entityLabel = (key) => (catalog?.entities || []).find((e) => e.key === key)?.label || key;

  if (error) return <ErrorBanner message="The catalog could not be loaded." onRetry={() => window.location.reload()} />;
  if (loading || !catalog) return <SkeletonBlocks count={3} height={120} />;

  const needle = q.trim().toLowerCase();
  const events = (catalog.events || []).filter((e) => e.module === picked && match(needle, e.label, e.group, entityLabel(e.entity), e.key));
  const entities = (catalog.entities || []).filter((e) => e.module === picked).map((e) => ({
    ...e,
    fields: (e.fields || []).filter((f) => match(needle, f.label, f.key, e.label)),
    dates: (e.dates || []).filter((d) => match(needle, d.label, d.key, e.label)),
  })).filter((e) => !needle || e.fields.length || e.dates.length || match(needle, e.label));
  const fieldCount = entities.reduce((n, e) => n + e.fields.length + e.dates.length, 0);
  const actions = (catalog.actions || []).filter((a) => a.module === picked && match(needle, a.label, a.key, ...(a.params || []).map((p) => p.label)));
  const sources = (catalog.listSources || []).filter((l) => l.module === picked && match(needle, l.label, l.key, entityLabel(l.entity)));
  const newCount = (catalog.newSince || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {newCount > 0 && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'var(--info-bg)', color: 'var(--info-fg)', fontSize: 13 }}>
          <Sparkles size={14} aria-hidden="true" />
          <span>
            <strong>New Since You Last Looked:</strong> {newCount} {newCount === 1 ? 'entry' : 'entries'}
            {catalog.lastSeen ? ` since ${formatDateTime(catalog.lastSeen)}` : ''}. They carry a New chip below.
          </span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--line)', borderRadius: 10, padding: '6px 12px', background: 'var(--card)' }}>
        <Search size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} data-slash-search="" aria-label="Search the catalog"
          placeholder="Search triggers, fields, actions and lists" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: 'inherit', fontSize: 13, minWidth: 0 }} />
      </div>
      <div className="wf-catalog-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 190px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <nav aria-label="Modules" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {modules.map((m) => {
            const on = m === picked;
            return (
              <button key={m} type="button" onClick={() => setModule(m)} aria-current={on ? 'true' : undefined}
                style={{ textAlign: 'left', border: 'none', borderRadius: 8, padding: '8px 10px', font: 'inherit', fontSize: 13, fontWeight: on ? 700 : 500, cursor: 'pointer',
                  background: on ? 'var(--paper)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)' }}>
                {moduleLabel(m)}
              </button>
            );
          })}
          {modules.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)', padding: 8 }}>No modules registered.</span>}
        </nav>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <Section Icon={Zap} title="Triggers" count={events.length}>
            {events.map((e) => (
              <Row key={e.key} title={e.label} chips={<>
                {e.group && <Chip>{e.group}</Chip>}
                <Chip>{entityLabel(e.entity)}</Chip>
                {e.volume === 'high' && <Chip title="Written only while a workflow listens for it">High Volume</Chip>}
                {isNew(e.key) && <NewChip />}
              </>}>
                {(e.changes || []).length > 0 ? `Carries from and to for: ${e.changes.join(', ')}` : null}
              </Row>
            ))}
          </Section>
          <Section Icon={ListChecks} title="Fields" count={fieldCount}>
            {entities.map((en) => (
              <div key={en.key}>
                <div style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {en.label}{isNew(en.key) && <NewChip />}
                </div>
                {en.fields.map((f) => (
                  <Row key={f.key} title={f.label} chips={<>
                    <Chip>{typeLabel(f.type)}</Chip>
                    {VISIBILITY[f.visibility] && <Chip tone="warn">{VISIBILITY[f.visibility]}</Chip>}
                    {isNew(`${en.key}.${f.key}`) && <NewChip />}
                  </>} />
                ))}
                {en.dates.map((d) => (
                  <Row key={`date:${d.key}`} title={d.label || d.key} chips={<>
                    <Chip>Date Trigger</Chip>
                    {d.yearly && <Chip>Yearly</Chip>}
                  </>} />
                ))}
              </div>
            ))}
          </Section>
          <Section Icon={Play} title="Actions" count={actions.length}>
            {actions.map((a) => (
              <Row key={a.key} title={a.label} chips={<>
                {a.adminOnly && <Chip tone="warn">Global Admin Only</Chip>}
                {a.needsPerson && <Chip title="Runs as a directory person, never as Nexus">Needs A Person</Chip>}
                {isNew(a.key) && <NewChip />}
              </>}>
                {(a.params || []).length > 0 ? `Needs: ${a.params.map((p) => p.label).join(', ')}` : 'Needs nothing else.'}
              </Row>
            ))}
          </Section>
          <Section Icon={Table2} title="List Sources" count={sources.length}>
            {sources.map((l) => (
              <Row key={l.key} title={l.label} chips={<>
                {l.entity && <Chip>{entityLabel(l.entity)}</Chip>}
                {isNew(l.key) && <NewChip />}
              </>}>
                {(l.params || []).length > 0 ? `Asks for: ${l.params.map((p) => p.label || p.key).join(', ')}` : null}
              </Row>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
