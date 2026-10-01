// Copy Week, Clear Week and Fill From Usual Hours (Oct 2026) - the three
// range actions under the schedule's ⋯ menu. Moved out of ShiftSchedule.jsx
// as they were (Sep 28 / Teams parity), with the shift-type wording and
// type="button" on every button.
import { useState } from 'react';
import { formatDate, formatHHMM } from '../../lib/datetime';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../UnsavedChangesPrompt';
import { MODAL_BACK, MODAL_CARD, LBL, CHECK, DialogHead } from './ScheduleToolbar';
import { addDaysIso } from './shiftLib';

const INPUT = { width: '100%', fontSize: 13 };

// "Everyone in view" sends no people at all - the server scopes to the
// caller's team and, unlike a group, still includes open shifts.
function GroupPick({ groups, value, onChange }) {
  return (
    <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)} style={INPUT} aria-label="Apply to">
      <option value="">Everyone in view</option>
      {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members?.length || 0})</option>)}
    </select>
  );
}

// Copy Week: lay a date range - the week on screen by default - down again
// starting on another date, as drafts, optionally several times back to back.
export function CopyModal({ groups, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [target, setTarget] = useState(() => addDaysIso(defaultEnd, 1));
  const [copies, setCopies] = useState(1);
  const [groupId, setGroupId] = useState('');
  const [includeOpen, setIncludeOpen] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeActs, setIncludeActs] = useState(true);
  const [skipOff, setSkipOff] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [copyOff, setCopyOff] = useState(false);
  const span = from && to ? Math.round((new Date(to) - new Date(from)) / 86400000) + 1 : 0;
  const lastDay = span > 0 && target ? addDaysIso(target, span * copies - 1) : '';
  const overlaps = span > 0 && target && target <= to && lastDay >= from;
  const canApply = span > 0 && span <= 31 && target && !overlaps && !busy;

  function submit() {
    const payload = { source_start: from, source_end: to, target_start: target, weeks: Number(copies),
      include_open: includeOpen && !groupId, include_notes: includeNotes, include_activities: includeActs,
      skip_timeoff: skipOff, overwrite, include_timeoff: copyOff };
    if (groupId) payload.group_id = groupId;
    onApply(payload);
  }

  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Copy Week" style={MODAL_CARD}>
        <DialogHead title="Copy Week" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Copy these dates forward as drafts. Nothing changes for the team until you share.</div>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>Copy from</div><input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={INPUT} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>Through</div><input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={INPUT} /></label>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>Paste starting</div><input type="date" className="form-input" value={target} onChange={(e) => setTarget(e.target.value)} style={INPUT} /></label>
            <label style={{ width: 120 }}><div style={LBL}>Copies</div>
              <select className="form-input" value={copies} onChange={(e) => setCopies(Number(e.target.value))} style={INPUT}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div><div style={LBL}>Apply to</div><GroupPick groups={groups} value={groupId} onChange={setGroupId} /></div>
          <label style={{ ...CHECK, opacity: groupId ? 0.5 : 1 }} title={groupId ? 'Open shifts belong to the group they were posted for' : undefined}>
            <input type="checkbox" checked={includeOpen && !groupId} disabled={!!groupId} onChange={(e) => setIncludeOpen(e.target.checked)} /> Include open shifts
          </label>
          <label style={CHECK}><input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> Include shift notes</label>
          <label style={CHECK}><input type="checkbox" checked={includeActs} onChange={(e) => setIncludeActs(e.target.checked)} /> Include shift activities</label>
          <label style={CHECK}><input type="checkbox" checked={skipOff} onChange={(e) => setSkipOff(e.target.checked)} /> Skip days a person has time off</label>
          <label style={CHECK}><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Replace shifts that are already there (otherwise keep them)</label>
          <label style={CHECK}><input type="checkbox" checked={copyOff} onChange={(e) => setCopyOff(e.target.checked)} /> Copy approved time off too (as requests to approve)</label>
          <div style={{ fontSize: 11.5, color: overlaps || span > 31 ? 'hsl(var(--color-red))' : 'var(--muted)' }}>
            {span > 31 ? 'Copy at most 31 days at a time.'
              : overlaps ? 'The copy would land on the dates it copies from - pick a later start.'
                : lastDay ? `Lands on ${formatDate(target)} - ${formatDate(lastDay)}.` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={submit} disabled={!canApply} style={{ opacity: canApply ? 1 : 0.55 }}>{busy ? '…' : 'Copy Shifts'}</button>
        </div>
      </div>
    </div>
  );
}

// Clear Week: every shift in a range at once. Same rule as removing one -
// drafts go, shared shifts wait for Share.
export function ClearModal({ groups, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [groupId, setGroupId] = useState('');
  const [includeOpen, setIncludeOpen] = useState(true);
  const canApply = from && to && to >= from && !busy;
  function submit() {
    const payload = { start_date: from, end_date: to, include_open: includeOpen && !groupId };
    if (groupId) payload.group_id = groupId;
    onApply(payload);
  }
  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Clear Week" style={MODAL_CARD}>
        <DialogHead title="Clear Week" onClose={onClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Remove every shift in these dates. Drafts are deleted. Shared shifts are marked for removal and stay on the team's schedule until you share - Discard Changes brings them back.
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={INPUT} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={INPUT} /></label>
          </div>
          <div><div style={LBL}>Apply to</div><GroupPick groups={groups} value={groupId} onChange={setGroupId} /></div>
          <label style={{ ...CHECK, opacity: groupId ? 0.5 : 1 }}>
            <input type="checkbox" checked={includeOpen && !groupId} disabled={!!groupId} onChange={(e) => setIncludeOpen(e.target.checked)} /> Include open shifts
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={submit} disabled={!canApply}
            style={{ opacity: canApply ? 1 : 0.55, background: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>{busy ? '…' : 'Clear Shifts'}</button>
        </div>
      </div>
    </div>
  );
}

// Fill From Usual Hours: apply a shift type to a whole group (or everyone in
// view) across a date range and chosen weekdays in one action. Skips time
// off and (unless overwrite) days that already have a shift.
export function BulkModal({ groups, shifts, allEmails, defaultStart, defaultEnd, busy, onApply, onClose }) {
  const [groupId, setGroupId] = useState(groups[0]?.id || '');
  const [shiftId, setShiftId] = useState(shifts[0]?.id || '');
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState(defaultEnd);
  const [dows, setDows] = useState([0, 1, 2, 3, 4]);
  const [skipOff, setSkipOff] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const preset = shifts.find((s) => s.id === shiftId);
  const DOW = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];
  const toggle = (n) => setDows((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n]));
  const targetCount = groupId ? (groups.find((g) => g.id === groupId)?.members?.length || 0) : allEmails.length;
  const canApply = shifts.length > 0 && from && to && dows.length > 0 && !busy && (groupId || allEmails.length);

  function submit() {
    const payload = { shift_id: shiftId, start_date: from, end_date: to, weekdays: dows, skip_timeoff: skipOff, overwrite };
    if (groupId) payload.group_id = groupId; else payload.emails = allEmails;
    onApply(payload);
  }
  const dirty = groupId !== (groups[0]?.id || '') || shiftId !== (shifts[0]?.id || '') || from !== defaultStart
    || to !== defaultEnd || JSON.stringify(dows) !== JSON.stringify([0, 1, 2, 3, 4]) || skipOff !== true || overwrite !== false;
  const guard = useUnsavedGuard(dirty, onClose, canApply ? submit : undefined);

  return (
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && guard.requestClose()}>
      <div role="dialog" aria-label="Fill From Usual Hours" style={MODAL_CARD}>
        <DialogHead title="Fill From Usual Hours" onClose={guard.requestClose} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Place a shift type on a whole group across a date range in one go.</div>
        {shifts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>No shift types yet - add one under Settings &gt; Global Settings &gt; Shifts first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div style={LBL}>Apply to</div>
              <select className="form-input" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={INPUT} aria-label="Apply to">
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members?.length || 0})</option>)}
                <option value="">Everyone in view ({allEmails.length})</option>
              </select>
            </div>
            <div>
              <div style={LBL}>Shift Type</div>
              <select className="form-input" value={shiftId} onChange={(e) => setShiftId(e.target.value)} style={INPUT} aria-label="Shift type">
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.code ? `${s.code} · ` : ''}{s.name} ({formatHHMM(s.start)} - {formatHHMM(s.end)})</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="date" className="form-input" value={from} onChange={(e) => setFrom(e.target.value)} style={INPUT} /></label>
              <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="date" className="form-input" value={to} onChange={(e) => setTo(e.target.value)} style={INPUT} /></label>
            </div>
            <div>
              <div style={LBL}>Days of week</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {DOW.map(([label, n]) => {
                  const on = dows.includes(n);
                  return (
                    <button key={n} type="button" onClick={() => toggle(n)} aria-pressed={on}
                      style={{ fontSize: 12, fontWeight: 700, padding: '6px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${on ? 'var(--wk-brand)' : 'var(--line)'}`, background: on ? 'var(--wk-brand-tint)' : 'transparent', color: on ? 'var(--wk-brand)' : 'var(--muted)' }}>{label}</button>
                  );
                })}
              </div>
            </div>
            <label style={CHECK}><input type="checkbox" checked={skipOff} onChange={(e) => setSkipOff(e.target.checked)} /> Skip days a person has time off</label>
            <label style={CHECK}><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Replace shifts that are already there (otherwise keep them)</label>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {targetCount} {targetCount === 1 ? 'person' : 'people'} · {preset ? `${formatHHMM(preset.start)} - ${formatHHMM(preset.end)}` : 'shift type'} · {dows.length} day{dows.length !== 1 ? 's' : ''}/week
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifts.length > 0 && <button type="button" className="primary-btn" onClick={submit} disabled={!canApply} style={{ opacity: canApply ? 1 : 0.55 }}>{busy ? '…' : 'Fill Schedule'}</button>}
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={canApply ? guard.saveAndClose : undefined} saving={guard.saving || busy} />
      )}
    </div>
  );
}
