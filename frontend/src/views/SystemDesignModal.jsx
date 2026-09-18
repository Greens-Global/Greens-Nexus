// Support > System & Design (Sep 19, Pranshu: "a new card 'System & Design'
// where it will state all the tech we used or using for building NEXUS...
// and also we should see another section inside that which is 'Data
// Dictionary'... all this should get updated automatically if something new
// is created, deleted, altered. All should be in real time.")
//
// Two tabs:
//  - Architecture: the actual Nexus stack, hand-maintained (backend/routers/
//    support.py's _SYSTEM_INFO) since a tech stack doesn't change on every
//    deploy the way the schema does.
//  - Data Dictionary: every backend table, grouped by module, fetched fresh
//    from /support/data-dictionary - that endpoint derives the whole thing
//    from models.py's live SQLAlchemy metadata on every call, so a table
//    added/renamed/dropped shows up here the moment the backend redeploys,
//    with nothing to hand-update.
import { useEffect, useState } from 'react';
import {
  X, Layers, Database as DatabaseIcon, Globe, Server, Plug, Search,
  ChevronDown, ChevronRight, Building2, Users, Clock, FileSignature,
  FolderOpen, BookOpen, KeyRound, Ticket, CheckSquare, HardHat, Package,
  Home, Landmark, FlaskConical, Shield, Link2, Megaphone, Settings2, Archive,
  Boxes, Loader2,
} from 'lucide-react';
import { api } from '../api';
import { NX, FONT } from '../tasks/theme';

const ICONS = {
  Globe, Server, Database: DatabaseIcon, Plug,
  Building2, Users, Clock, FileSignature, FolderOpen, BookOpen, KeyRound,
  Ticket, CheckSquare, HardHat, Package, Home, Landmark, FlaskConical,
  Shield, Link2, Megaphone, Settings2, Archive, Boxes,
};
const IconFor = ({ name, size = 16, style }) => {
  const Cmp = ICONS[name] || Boxes;
  return <Cmp size={size} style={style} />;
};

const card = { background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12 };

function ArchitectureTab({ info }) {
  if (!info) return <div style={{ padding: '30px 0', textAlign: 'center', color: NX.faint, fontSize: 13 }}>Loading…</div>;
  return (
    <>
      <p style={{ fontSize: 12.5, color: NX.dim, margin: '0 0 16px' }}>{info.intro}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {info.sections.map((s) => (
          <div key={s.key} style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, background: NX.hover, display: 'grid', placeItems: 'center', flexShrink: 0, color: NX.primary }}>
                <IconFor name={s.icon} size={16} />
              </span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: NX.faint }}>{s.subtitle}</div>
              </div>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {s.points.map((p, i) => (
                <li key={i} style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.5 }}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}

function TableRow({ table, open, onToggle }) {
  return (
    <div style={{ borderTop: `1px solid ${NX.border2}` }}>
      <button type="button" onClick={onToggle} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 4px',
        background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
      }}>
        {open ? <ChevronDown size={13} style={{ color: NX.faint, flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: NX.faint, flexShrink: 0 }} />}
        <code style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, background: NX.hover, color: NX.dim, flexShrink: 0 }}>{table.name}</code>
        <span style={{ fontSize: 12.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {table.description || '—'}
        </span>
        <span style={{ fontSize: 11, color: NX.faint, flexShrink: 0 }}>{table.fieldCount} field{table.fieldCount === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <div style={{ padding: '2px 4px 12px 25px' }}>
          {table.description && (
            <p style={{ fontSize: 12, color: NX.dim, lineHeight: 1.5, margin: '0 0 10px' }}>{table.description}</p>
          )}
          <div style={{ border: `1px solid ${NX.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', background: NX.surface2, fontSize: 10.5, fontWeight: 700, color: NX.faint, letterSpacing: '.04em', textTransform: 'uppercase' }}>
              <div style={{ padding: '6px 10px' }}>Field</div>
              <div style={{ padding: '6px 10px', borderLeft: `1px solid ${NX.border}` }}>What it stores</div>
            </div>
            {table.fields.map((f) => (
              <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', borderTop: `1px solid ${NX.border2}` }}>
                <div style={{ padding: '7px 10px', fontSize: 12.5, fontWeight: 600, color: NX.ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {f.label}{f.primaryKey && <span style={{ fontSize: 9.5, fontWeight: 700, color: NX.primary }}>PK</span>}
                </div>
                <div style={{ padding: '7px 10px', fontSize: 12.5, color: NX.dim, borderLeft: `1px solid ${NX.border2}` }}>
                  {f.description || <span style={{ color: NX.faint }}>{f.type}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DomainCard({ domain, query }) {
  const [open, setOpen] = useState(false);
  const [openTables, setOpenTables] = useState(() => new Set());
  const toggleTable = (name) => setOpenTables((s) => {
    const next = new Set(s);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const q = query.trim().toLowerCase();
  const tables = !q ? domain.tables : domain.tables.filter((t) =>
    t.name.includes(q) || (t.description || '').toLowerCase().includes(q)
    || t.fields.some((f) => f.name.includes(q) || f.label.toLowerCase().includes(q)));
  // A live search auto-opens any domain with a match, so results don't hide
  // behind a collapsed card - the whole point of searching 200 tables.
  const forceOpen = q.length > 0 && tables.length > 0;
  if (q && tables.length === 0) return null;

  return (
    <div style={{ ...card, marginBottom: 10, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
        background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
      }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: NX.hover, display: 'grid', placeItems: 'center', flexShrink: 0, color: NX.primary }}>
          <IconFor name={domain.icon} size={16} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: NX.ink }}>{domain.label}</div>
          <div style={{ fontSize: 11.5, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{domain.description}</div>
        </span>
        <span style={{ fontSize: 11.5, color: NX.faint, flexShrink: 0 }}>{tables.length} table{tables.length === 1 ? '' : 's'}</span>
        {(open || forceOpen) ? <ChevronDown size={15} style={{ color: NX.faint, flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: NX.faint, flexShrink: 0 }} />}
      </button>
      {(open || forceOpen) && (
        <div style={{ padding: '0 16px 8px' }}>
          {tables.map((t) => (
            <TableRow key={t.name} table={t} open={openTables.has(t.name) || Boolean(q)} onToggle={() => toggleTable(t.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DataDictionaryTab({ dict }) {
  const [query, setQuery] = useState('');
  if (!dict) return <div style={{ padding: '30px 0', textAlign: 'center', color: NX.faint, fontSize: 13 }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /></div>;
  return (
    <>
      <p style={{ fontSize: 12.5, color: NX.dim, margin: '0 0 12px' }}>
        {dict.tableCount} tables across {dict.domains.length} areas of the backend, read live off the actual
        database models - expand a domain, then a table, to see its fields in plain English.
      </p>
      <div style={{ position: 'relative', marginBottom: 14, maxWidth: 360 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: NX.faint }} />
        <input type="text" className="form-input" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tables or fields…" style={{ width: '100%', paddingLeft: 30, fontSize: 13 }} />
      </div>
      {dict.domains.map((d) => <DomainCard key={d.key} domain={d} query={query} />)}
    </>
  );
}

export default function SystemDesignModal({ onClose }) {
  const [tab, setTab] = useState('architecture');
  const [info, setInfo] = useState(null);
  const [dict, setDict] = useState(null);

  useEffect(() => { api.getSupportSystemInfo().then(setInfo).catch(() => {}); }, []);
  useEffect(() => {
    if (tab === 'dictionary' && !dict) api.getSupportDataDictionary().then(setDict).catch(() => {});
  }, [tab, dict]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={{ background: NX.canvas, borderRadius: 14, width: '100%', maxWidth: 920, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.35)', fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: `1px solid ${NX.border}`, flexShrink: 0 }}>
          <Layers size={18} style={{ color: NX.primary }} />
          <div style={{ fontSize: 15.5, fontWeight: 700, color: NX.ink, flex: 1 }}>System & Design</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: NX.faint, display: 'flex', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '10px 20px 0', flexShrink: 0 }}>
          {[['architecture', 'Architecture', Layers], ['dictionary', 'Data Dictionary', DatabaseIcon]].map(([key, label, Icon]) => (
            <button key={key} type="button" onClick={() => setTab(key)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: '8px 8px 0 0',
              border: 'none', borderBottom: tab === key ? `2px solid ${NX.primary}` : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              color: tab === key ? NX.ink : NX.faint, fontFamily: FONT,
            }}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {tab === 'architecture' ? <ArchitectureTab info={info} /> : <DataDictionaryTab dict={dict} />}
        </div>
      </div>
    </div>
  );
}
