// Contact Directory > Org Chart: the company as a tree of cards on the shared
// pan/zoom canvas (components/orgchart), read-only. The same reporting data
// as the Reporting Line list, drawn the way people picture an organization,
// with what the directory is for on every card: who they are, whether they
// are reachable right now (Teams presence / today's availability), and Teams
// chat and call one tap away. A tap opens the same contact card as the other
// two lenses; nothing here edits anything - Reports To is set in People.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Phone, LocateFixed, Unlink } from 'lucide-react';
import { NX, FONT } from '../tasks/theme';
import OrgChartCanvas, { ReportsPill } from '../components/orgchart/OrgChartCanvas';
import { initialCollapsed, allBranchKeys, countBelow, divisionColor } from '../components/orgchart/tree';
import { Avatar, RoleBadge, AvailabilityChip } from './ProfilePanel';
import { buildTree, splitTree, searchPeople, chainUp, inheritedDivision, divisionNames, isOffToday, teamsChat, teamsCall } from './lib';

const CARD_W = 232;
const childrenOf = (n) => n.children;
const keyOf = (n) => n.person.email;

export default function OrgChartLens({ people, query, me, selected, onSelect, mobile, canOpenPeople }) {
  const canvas = useRef(null);
  const [collapsed, setCollapsed] = useState(null);   // null = not seeded yet
  const [activeDiv, setActiveDiv] = useState('');

  const byEmail = useMemo(() => new Map(people.map((p) => [p.email, p])), [people]);
  const { trees, loose } = useMemo(() => splitTree(buildTree(people)), [people]);
  const folded = useMemo(() => collapsed || initialCollapsed(trees, childrenOf, keyOf), [collapsed, trees]);
  const toggle = useCallback((key) => setCollapsed((prev) => {
    const n = new Set(prev || initialCollapsed(trees, childrenOf, keyOf));
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  }), [trees]);
  const expandAll = () => { setCollapsed(new Set()); setTimeout(() => canvas.current?.centerView(), 60); };
  const collapseAll = () => { setCollapsed(allBranchKeys(trees, childrenOf, keyOf)); setTimeout(() => canvas.current?.centerView(), 60); };

  // Divisions color the cards; the legend spotlights one.
  const divNames = useMemo(() => divisionNames(people), [people]);
  const divisionOf = useMemo(() => { const cache = new Map(); return (p) => inheritedDivision(p, byEmail, cache); }, [byEmail]);
  const divCounts = useMemo(() => {
    const out = {};
    for (const p of people) { const d = divisionOf(p); if (d) out[d] = (out[d] || 0) + 1; }
    return out;
  }, [people, divisionOf]);

  // Search finds and focuses (expand the match's ancestors, glide to the
  // card) rather than filtering - filtering by a name would amputate the
  // person's whole team out of the picture.
  const q = (query || '').trim();
  const hits = useMemo(() => (q ? new Set(searchPeople(people, q).map((p) => p.email)) : null), [people, q]);
  const reveal = useCallback((email) => {
    const p = byEmail.get(email);
    if (!p) return;
    const keys = [email, ...chainUp(p, byEmail).map((m) => m.email)];
    setCollapsed((prev) => {
      const base = prev || initialCollapsed(trees, childrenOf, keyOf);
      if (!keys.some((k) => base.has(k))) return prev;
      const n = new Set(base);
      keys.forEach((k) => n.delete(k));
      return n;
    });
  }, [byEmail, trees]);
  useEffect(() => {
    if (!q) return undefined;
    const first = searchPeople(people, q)[0];
    if (!first) return undefined;
    reveal(first.email);   // eslint-disable-line react-hooks/set-state-in-effect -- the query is the parent's; unfolding the match's ancestors is this chart's reaction to it
    const t = setTimeout(() => canvas.current?.focusOn(first.email), 80);
    return () => clearTimeout(t);
  }, [q, people, reveal]);

  // A selection made anywhere (a card here, a pill on the contact card, the
  // header search) is brought into view - but a card already in view stays
  // where it is, so tapping it does not make the chart lurch.
  useEffect(() => {
    if (!selected || !byEmail.has(selected)) return undefined;
    reveal(selected);   // eslint-disable-line react-hooks/set-state-in-effect -- selection arrives from the contact card and the header search too, not only from a card here
    const t = setTimeout(() => canvas.current?.focusOn(selected, { onlyIfHidden: true }), 80);
    return () => clearTimeout(t);
  }, [selected, byEmail, reveal]);

  // A new shape (first load, a filter change) starts centered at 100%; the
  // minute refresh hands over new objects with the same shape and must not
  // move the chart under the viewer.
  const shape = `${trees.map(keyOf).join('|')}:${people.length}`;
  useEffect(() => { canvas.current?.centerView(); }, [shape]);

  const jumpToMe = () => {
    onSelect(me);
    reveal(me);
    setTimeout(() => canvas.current?.focusOn(me), 80);
  };

  const linked = people.length - loose.length;
  const renderCard = (node, meta) => {
    const p = node.person;
    const d = divisionOf(p);
    return (
      <OrgCard p={p} kids={meta.kids} below={meta.kids ? countBelow(node, childrenOf) : 0} collapsed={meta.collapsed} onToggle={meta.toggle}
        active={p.email === selected} me={me} hit={hits ? hits.has(p.email) : false} dim={(!!hits && !hits.has(p.email)) || (!!activeDiv && d !== activeDiv)}
        divName={d} divColor={divisionColor(d, divNames)} isLead={!!(p.division || '').trim()} onSelect={onSelect} />
    );
  };

  const tool = { fontFamily: FONT, fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 8, border: `1px solid ${NX.border}`, background: NX.surface, color: NX.ink, cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: mobile ? 10 : 14, minWidth: 0 }}>
      <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" className="dir-tool" style={tool} onClick={expandAll}>Expand All</button>
        <button type="button" className="dir-tool" style={tool} onClick={collapseAll}>Collapse All</button>
        {me && byEmail.has(me) && (
          <button type="button" className="dir-tool" style={tool} onClick={jumpToMe} title="Find yourself on the chart"><LocateFixed size={13} /> Me</button>
        )}
        <span style={{ fontSize: 11.5, color: NX.faint, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
          {people.length} {people.length === 1 ? 'person' : 'people'} · {linked} on the chart
        </span>
      </div>

      {divNames.length > 0 && (
        <div className="scroll-tabs" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint, whiteSpace: 'nowrap' }}>Divisions</span>
          {divNames.map((d) => {
            const on = activeDiv === d, col = divisionColor(d, divNames);
            return (
              <button key={d} type="button" aria-pressed={on} onClick={() => setActiveDiv(on ? '' : d)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 20, whiteSpace: 'nowrap',
                border: `1.5px solid ${on ? `hsl(${col})` : NX.border}`, cursor: 'pointer', fontFamily: FONT,
                background: on ? `hsla(${col},0.12)` : NX.surface, fontSize: 11.5, fontWeight: 700,
                color: on ? `hsl(${col})` : NX.ink, opacity: activeDiv && !on ? 0.55 : 1, transition: 'opacity 0.12s',
              }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: `hsl(${col})` }} />
                {d}
                <span style={{ fontSize: 10, fontWeight: 800, color: NX.faint }}>{divCounts[d] || 0}</span>
              </button>
            );
          })}
        </div>
      )}

      <OrgChartCanvas ref={canvas} roots={trees} childrenOf={childrenOf} keyOf={keyOf} renderCard={renderCard}
        collapsed={folded} onToggle={toggle} ariaLabel="Organization chart"
        height={mobile ? 'max(380px, 60vh)' : 'max(480px, calc(100vh - 430px))'}
        emptyText={people.length ? 'Nobody here reports to anyone else you can see - the people are listed below.' : 'No one matches these filters.'}
        hint={mobile ? 'Drag to move · pinch to zoom · tap a card' : 'Drag to move · Ctrl + scroll or pinch to zoom · click a card for their contact card'} />

      {loose.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: NX.faint, marginBottom: 4 }}>
            <Unlink size={12} /> Not Connected <span style={{ fontWeight: 600 }}>{loose.length}</span>
          </div>
          <div style={{ fontSize: 12, color: NX.dim, marginBottom: 10 }}>
            No manager on record, or a manager outside the companies you can see.{canOpenPeople ? ' Reports To is set on the person in People.' : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {loose.map((p) => {
              const d = divisionOf(p);
              return (
                <div key={p.email} data-orgkey={p.email}>
                  <OrgCard p={p} kids={0} below={0} collapsed={false} onToggle={() => {}} active={p.email === selected} me={me}
                    hit={hits ? hits.has(p.email) : false} dim={(!!hits && !hits.has(p.email)) || (!!activeDiv && d !== activeDiv)}
                    divName={d} divColor={divisionColor(d, divNames)} isLead={!!(p.division || '').trim()} onSelect={onSelect} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// One card. Teams chat and call sit in the corner (visible on hover, always
// on touch) so reaching the person never needs the contact card first; the
// count pill under the card folds their team.
export function OrgCard({ p, kids, below, collapsed, onToggle, active, me, hit, dim, divName, divColor, isLead, onSelect }) {
  const off = isOffToday(p);
  const open = () => onSelect(p.email);
  return (
    <div style={{ position: 'relative', paddingBottom: kids > 0 ? 12 : 0 }}>
      <div role="button" tabIndex={0} data-email={p.email} aria-label={`${p.name}${p.jobTitle ? `, ${p.jobTitle}` : ''}`} aria-pressed={active}
        className={`dir-card${active ? ' is-active' : ''}`} onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
        style={{
          position: 'relative', width: CARD_W, padding: '12px 12px 12px 18px', display: 'flex', alignItems: 'center', gap: 11,
          background: NX.surface, borderRadius: 14, cursor: 'pointer', overflow: 'hidden', userSelect: 'none', WebkitUserSelect: 'none',
          border: `1.5px solid ${active ? NX.primary : hit ? NX.blue : NX.border}`,
          boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${NX.primary} 18%, transparent)` : hit ? '0 0 0 3px rgba(37,99,235,0.15)' : 'var(--shadow-sm)',
          opacity: dim ? 0.3 : 1,
        }}>
        {divColor && <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: `hsl(${divColor})` }} />}
        <Avatar p={p} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.name}{p.email === me && <span style={{ color: NX.faint, fontWeight: 500 }}> (you)</span>}
          </div>
          <div style={{ fontSize: 11, color: NX.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.jobTitle || '-'}</div>
          <div style={{ fontSize: 10, color: NX.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{[p.department, p.companyName].filter(Boolean).join(' · ') || '\u00a0'}</span>
            <RoleBadge role={p.departmentRole} />
          </div>
          {(off || (isLead && divName)) && (
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              {off && <AvailabilityChip availability={p.availability} />}
              {isLead && divName && (
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.03em', textTransform: 'uppercase', color: `hsl(${divColor})`, background: `hsla(${divColor},0.12)`, borderRadius: 6, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                  {divName} Lead
                </span>
              )}
            </div>
          )}
        </div>
        <div className="dir-card-actions" style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 3 }}>
          <a href={teamsChat(p.email)} target="_blank" rel="noreferrer" title="Chat on Teams" aria-label={`Chat with ${p.name} on Teams`}
            onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} className="dir-mini teams" style={{ width: 24, height: 24, borderRadius: 6 }}><MessageSquare size={12} /></a>
          <a href={teamsCall(p.email)} target="_blank" rel="noreferrer" title="Call on Teams" aria-label={`Call ${p.name} on Teams`}
            onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} className="dir-mini teams" style={{ width: 24, height: 24, borderRadius: 6 }}><Phone size={12} /></a>
        </div>
      </div>
      <ReportsPill count={kids} collapsed={collapsed} onToggle={onToggle}
        label={collapsed ? `Show ${p.name}'s team (${below})` : `Hide ${p.name}'s team (${below})`} />
    </div>
  );
}
