// HelpTopicField - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { NX, input as inputStyle } from '../tasks/theme';
import { OTHER_TOPIC, TOPIC_MAX_LEN, helpGroupFor } from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_LABEL, topicOptions } from './ticketMeta';
import { TicketSelect } from './TicketAtoms';
import { listedTopic } from './ticketViewShared';

// The picker plus, for "Other" (or a department with no list), the short typed
// answer it requires - max TOPIC_MAX_LEN characters, a name for the thing
// rather than a second description (Neil: "it cannot be like a huge long
// sentence... max 50 characters").
//
// `subValue` / `onSubChange` (optional, Oct 1 2026): when the picked topic has
// sub-options, a second "Which one?" dropdown appears under it (Microsoft ->
// Outlook). Never required. Picking a different topic clears it. Without
// onSubChange the field behaves exactly as before.
function HelpTopicField({ deptName, value, onChange, invalid = false, disabled = false, subValue = '', onSubChange = null }) {
  const group = helpGroupFor(deptName);
  const listed = listedTopic(group, value);
  const subOptions = listed ? topicOptions(listed.name, group) : [];
  const subPicker = onSubChange && subOptions.length > 0 ? (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: NX.dim, margin: '2px 0 5px' }}>
        {HELP_SUBTOPIC_LABEL} <span style={{ fontWeight: 400, color: NX.faint }}>(optional)</span>
      </div>
      <TicketSelect value={subOptions.includes(subValue) ? subValue : ''} disabled={disabled}
        placeholder="Pick one, if it fits" searchPlaceholder="Search…"
        options={[['', 'Not Sure'], ...subOptions.map((o) => [o, o])]}
        onChange={(v) => onSubChange(v)} />
    </div>
  ) : null;
  // A new topic has its own list - the old "which one" belonged to the other.
  const changeTopic = (v) => {
    if (onSubChange && (v || '').trim().toLowerCase() !== (value || '').trim().toLowerCase() && subValue) onSubChange('');
    onChange(v);
  };
  // "Other" picked but nothing typed yet is a real state the value alone
  // cannot express ("" also means "nothing picked").
  const [otherPicked, setOtherPicked] = useState(!!(value && !listed));
  useEffect(() => { if (listed) setOtherPicked(false); }, [listed]);
  useEffect(() => { if (value && !listed) setOtherPicked(true); }, [value, listed]);
  const showText = !group || otherPicked;
  const textInput = (
    <div style={{ position: 'relative' }}>
      <input value={listed ? '' : (value || '')} maxLength={TOPIC_MAX_LEN} disabled={disabled}
        onChange={(e) => changeTopic(e.target.value)}
        placeholder={group ? 'Tell us what it is, in a few words' : 'e.g. Front gate keypad, Outlook, Payroll report'}
        style={{ ...inputStyle, paddingRight: 52, ...(invalid ? { borderColor: NX.red } : null) }} />
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: NX.faint, pointerEvents: 'none' }}>
        {(listed ? 0 : (value || '').length)}/{TOPIC_MAX_LEN}
      </span>
    </div>
  );
  if (!group) return textInput;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <TicketSelect value={listed ? listed.name : (otherPicked ? OTHER_TOPIC : '')} disabled={disabled}
        invalid={invalid && !otherPicked}
        placeholder="Select one" searchPlaceholder="Search…"
        options={[['', 'Select one'], ...group.topics.map((tp) => [tp.name, tp.name]), [OTHER_TOPIC, 'Other']]}
        onChange={(v) => {
          if (v === OTHER_TOPIC) { setOtherPicked(true); changeTopic(''); return; }
          setOtherPicked(false);
          changeTopic(v);
        }} />
      {showText && textInput}
      {subPicker}
    </div>
  );
}

export { HelpTopicField };
