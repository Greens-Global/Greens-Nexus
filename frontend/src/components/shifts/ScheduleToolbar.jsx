// The schedule toolbar (Oct 2026, Teams parity): ONE row, at most seven
// controls - [‹ ›] [Today] [range] | Day / Week / Month | Group | + Add |
// Share | ⋯. Everything that used to be a button of its own (Fill, Copy,
// Clear, Import, Export, Print, Discard, Requests, the View menu, the
// filters) lives under + Add or ⋯ now. "A huge mess compared to shifts in
// Microsoft" (Neil, 10/01) was mostly this row.
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Send, MoreHorizontal, Clock, CalendarRange, CalendarOff, StickyNote, Copy, CalendarDays, Trash2, Upload, Download, Printer, RotateCcw, Inbox, SlidersHorizontal, X, Search } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatDateTime, formatWeekday } from '../../lib/datetime';
import { MenuButton } from './Menu';
import { TeamSwitcher } from '../ShiftTeams';
import { addDaysIso } from './shiftLib';

const VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
export const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
export const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 460, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };
export const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
export const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' };

export function DialogHead({ title, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{title}</span>
      <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
    </div>
  );
}

export function ScheduleToolbar({ view, onView, onPrev, onNext, onToday, rangeLabel, groups, groupFilter, onGroupFilter, canManage, busy, ready,
  unsharedCount = 0, onAdd, onShare, actions }) {
  const viewName = VIEWS.find(([k]) => k === view)?.[1] || (view === 'twoweeks' ? 'Two Weeks' : 'Week');
  const addItems = [
    { key: 'shift', label: 'Shift', Icon: Clock, onClick: () => onAdd('shift') },
    { key: 'open', label: 'Open Shift', Icon: CalendarRange, onClick: () => onAdd('open') },
    ...(actions.canTimeOff ? [{ key: 'timeoff', label: 'Time Off', Icon: CalendarOff, onClick: () => onAdd('timeoff') }] : []),
    { key: 'note', label: 'Day Note', Icon: StickyNote, onClick: () => onAdd('note') },
  ];
  const moreItems = [
    ...(canManage ? [
      { key: 'copy', label: 'Copy Week', Icon: Copy, onClick: actions.copy, disabled: !ready },
      { key: 'fill', label: 'Fill From Usual Hours', Icon: CalendarDays, onClick: actions.fill, disabled: !ready },
      { key: 'clear', label: 'Clear Week', Icon: Trash2, onClick: actions.clear, disabled: !ready },
      'sep',
      { key: 'import', label: 'Import', Icon: Upload, onClick: actions.importFile, disabled: !ready },
    ] : []),
    { key: 'export', label: 'Export', Icon: Download, onClick: actions.exportFile, disabled: !ready },
    { key: 'print', label: 'Print', Icon: Printer, onClick: actions.print, disabled: !ready },
    'sep',
    { key: 'view', label: 'View Options', Icon: SlidersHorizontal, onClick: actions.viewOptions },
    ...(canManage ? [
      'sep',
      { key: 'discard', label: `Discard Changes${actions.discardCount ? ` (${actions.discardCount})` : ''}`, Icon: RotateCcw, onClick: actions.discard, disabled: !actions.discardCount || busy,
        title: 'Undo edits and removals that are not shared yet' },
      { key: 'requests', label: 'Requests', Icon: Inbox, onClick: actions.requests },
    ] : []),
  ];
  return (
    <div role="toolbar" aria-label="Schedule" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', background: 'var(--card)' }}>
        <button type="button" className="icon-btn" onClick={onPrev} aria-label={`Previous ${viewName.toLowerCase()}`} style={{ padding: 7, border: 'none', borderRadius: 0 }}><ChevronLeft size={16} /></button>
        <button type="button" onClick={onToday} style={{ border: 'none', borderLeft: '1px solid var(--line)', borderRight: '1px solid var(--line)', background: 'none', padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>Today</button>
        <button type="button" className="icon-btn" onClick={onNext} aria-label={`Next ${viewName.toLowerCase()}`} style={{ padding: 7, border: 'none', borderRadius: 0 }}><ChevronRight size={16} /></button>
      </div>
      <span style={{ fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap' }}>{rangeLabel}</span>
      <div role="group" aria-label="View" style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden', background: 'var(--card)' }}>
        {VIEWS.map(([k, label]) => {
          const on = view === k || (k === 'week' && view === 'twoweeks');
          return (
            <button key={k} type="button" onClick={() => onView(k)} aria-pressed={on}
              style={{ border: 'none', padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                background: on ? 'var(--wk-brand-tint)' : 'transparent', color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{label}</button>
          );
        })}
      </div>
      <TeamSwitcher groups={groups} value={groupFilter} onChange={onGroupFilter} />
      <div style={{ flex: 1 }} />
      {canManage && <MenuButton label="Add" Icon={Plus} items={addItems} ariaLabel="Add" primary width={190} disabled={!ready} />}
      {canManage && (
        <button type="button" className={unsharedCount ? 'primary-btn' : 'secondary-btn'} onClick={onShare} disabled={busy || !ready}
          title={unsharedCount ? 'Share these changes with the team' : 'Everything is shared with the team'}
          aria-label={`Share${unsharedCount ? `, ${unsharedCount} unshared` : ''}`}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Send size={13} /> Share
          {unsharedCount > 0 && <span style={{ fontSize: 10.5, fontWeight: 800, background: '#fff', color: 'var(--wk-brand)', borderRadius: 10, padding: '0 6px', minWidth: 18, textAlign: 'center' }}>{unsharedCount}</span>}
        </button>
      )}
      <MenuButton label="" Icon={MoreHorizontal} items={moreItems} ariaLabel="More" align="right" width={240} style={{ padding: '6px 8px' }} />
    </div>
  );
}

// Share (Teams "Share with team"): pick a date range - the visible week by
// default - and who hears about it; says when the schedule was last shared
// and how many changes in that range are waiting.
export function ShareDialog({ defaultStart, defaultEnd, lastPublishedAt, localCount = 0, groups = [], busy, onPublish, onClose }) {
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [notify, setNotify] = useState('changed');
  const [groupId, setGroupId] = useState('');
  const [count, setCount] = useState(null);    // null = unknown (older API)
  const days = from && to ? Math.round((new Date(to) - new Date(from)) / 86400000) + 1 : 0;
  const tooLong = days > 92;
  useEffect(() => {
    if (!from || !to || to < from) return undefined;
    let live = true;
    api.timeSchedUnshared(from, to).then((r) => { if (live) setCount(Number(r?.count) || 0); }).catch(() => { if (live) setCount(null); });
    return () => { live = false; };
  }, [from, to]);
  const n = count ?? localCount;
  const opt = (value, title, hint) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
      border: `1px solid ${notify === value ? 'var(--wk-brand)' : 'var(--line)'}`, background: notify === value ? 'var(--wk-brand-tint)' : 'transparent' }}>
      <input type="radio" name="share-notify" checked={notify === value} onChange={() => setNotify(value)} style={{ marginTop: 3 }} />
      <span><div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div></span>
    </label>
  );
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Share Schedule" style={{ ...MODAL_CARD, maxWidth: 440 }}>
        <DialogHead title="Share Schedule" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          The team sees drafts, edits and removals in these dates once you share.
          {lastPublishedAt ? ` Last shared ${formatDateTime(lastPublishedAt)}.` : ' Not shared yet.'}
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="date" className="form-input" aria-label="Share from" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="date" className="form-input" aria-label="Share to" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          </div>
          {groups.length > 0 && (
            <label><div style={LBL}>Group</div>
              <select className="form-input" aria-label="Share group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">Every group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          )}
          <div style={{ fontSize: 12.5, fontWeight: 700, color: tooLong ? 'hsl(var(--color-red))' : 'var(--ink)' }}>
            {tooLong ? 'Share at most 92 days at a time.' : to < from ? 'The end is before the start.' : `${n} change${n === 1 ? '' : 's'} to share in these dates.`}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {opt('changed', 'Only people whose shifts changed', 'Each gets a notification and an email listing their own changes.')}
            {opt('team', 'The whole team', 'The same, plus a short notification to everyone else on the schedule for these dates.')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" disabled={busy || tooLong || !from || !to || to < from || n === 0}
            onClick={() => onPublish({ start_date: from, end_date: to, notify, ...(groupId ? { group_id: groupId } : {}) })}>{busy ? '…' : 'Share'}</button>
        </div>
      </div>
    </div>
  );
}

// A note on one day, for the whole team or one group (Teams "day notes").
export function DayNoteDialog({ date, groups = [], notes = [], busy, onSave, onClose, onDateChange }) {
  const [groupId, setGroupId] = useState('');
  const existing = notes.find((n) => n.date === date && (n.groupId || '') === groupId);
  const [text, setText] = useState(existing?.note || '');
  useEffect(() => { setText(existing?.note || ''); }, [existing?.note, groupId, date]);
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Day Note" style={{ ...MODAL_CARD, maxWidth: 420 }}>
        <DialogHead title="Day Note" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Everyone on the schedule sees this on the day, here and in My Shifts.</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label><div style={LBL}>Day</div>
            {onDateChange ? <input type="date" className="form-input" aria-label="Note day" value={date} onChange={(e) => onDateChange(e.target.value)} style={{ width: '100%', fontSize: 13 }} />
              : <div style={{ fontSize: 13, fontWeight: 700 }}>{formatWeekday(date)}, {formatDate(date)}</div>}
          </label>
          {groups.length > 0 && (
            <label><div style={LBL}>For</div>
              <select className="form-input" aria-label="Note group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: '100%', fontSize: 13 }}>
                <option value="">Everyone</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          )}
          <textarea className="form-input" rows={3} maxLength={200} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Inventory day - all hands" aria-label="Day note" style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          {existing?.note && <button type="button" onClick={() => onSave(date, '', groupId)} disabled={busy} style={{ background: 'none', border: 'none', color: 'hsl(var(--color-red))', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Remove</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => onSave(date, text, groupId)} disabled={busy || !text.trim()} style={{ opacity: text.trim() ? 1 : 0.55 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// View Options (under ⋯): the filters and switches that used to crowd the
// toolbar - search, rows by team or location, one shift type, Teams' Show
// list, your own shifts only, and two weeks at a time.
export const SHOW_OPTIONS = [['teams', 'Groups'], ['open', 'Open Shifts'], ['conflicts', 'Shift Conflicts'], ['availability', 'Availability'], ['photos', 'Profile Pictures'], ['sunday', 'Sunday']];
export function ViewOptionsDialog({ prefs, onPrefs, query, onQuery, groupBy, onGroupBy, presetFilter, onPresetFilter, presets = [], twoWeeks, onTwoWeeks, canViewByShift, onClose }) {
  const set = (k, v) => onPrefs({ ...prefs, [k]: v });
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="View Options" style={{ ...MODAL_CARD, maxWidth: 420 }}>
        <DialogHead title="View Options" onClose={onClose} />
        <div style={{ display: 'grid', gap: 14, marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px' }}>
            <Search size={13} color="var(--muted)" />
            <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search people" aria-label="Search people"
              style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, flex: 1, fontFamily: 'inherit', color: 'var(--ink)' }} />
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 150 }}><div style={LBL}>Rows By</div>
              <select className="form-input" value={groupBy} onChange={(e) => onGroupBy(e.target.value)} aria-label="Group people by" style={{ width: '100%', fontSize: 13 }}>
                <option value="group">Group</option>
                <option value="location">Location</option>
                {canViewByShift && <option value="shift">Shift Type</option>}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 150 }}><div style={LBL}>Shift Type</div>
              <select className="form-input" value={presetFilter} onChange={(e) => onPresetFilter(e.target.value)} aria-label="Filter by shift type" style={{ width: '100%', fontSize: 13 }}>
                <option value="">All Shift Types</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.name}</option>)}
              </select>
            </label>
          </div>
          <div>
            <div style={LBL}>Show</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {SHOW_OPTIONS.map(([k, label]) => (
                <label key={k} style={CHECK}><input type="checkbox" checked={prefs[k] !== false} onChange={(e) => set(k, e.target.checked)} aria-label={`Show ${label}`} /> {label}</label>
              ))}
              <label style={CHECK}><input type="checkbox" checked={!!prefs.mine} onChange={(e) => set('mine', e.target.checked)} aria-label="Your shifts only" /> Your Shifts Only</label>
              <label style={CHECK}><input type="checkbox" checked={!!twoWeeks} onChange={(e) => onTwoWeeks(e.target.checked)} aria-label="Two weeks at a time" /> Two Weeks At A Time</label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={() => { onQuery(''); onPresetFilter(''); onPrefs({ ...prefs, mine: false }); }}>Clear Filters</button>
          <button type="button" className="primary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export { addDaysIso };
