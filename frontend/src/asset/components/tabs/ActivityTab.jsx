// Asset Management > Activity (Neil, 11/17/2026): the Activity Log as a tab - every add, edit,
// delete and link with who, what and when; Go To and Undo as before. What arrived since the
// person last looked is words on the page ("12 new since your last visit"), never a badge.
// The asset page's Activity uses it too, with the asset's own logs and `scopeName`.

import { useEffect, useRef, useState } from 'react';
import { ActivityLog } from '../manage/ActivityLog.jsx';
import { plural } from '../../lib/datesModel.js';
import { formatDate } from '../../lib/format.js';
import { Sentence } from './tabParts.jsx';

/** The tab's sentence: what is new since `seenAt`, how many changes and by how many people. */
export function activitySentence(logs, seenAt, scopeName) {
  const list = logs || [];
  if (!list.length) return [scopeName ? `No changes to ${scopeName} have been recorded yet` : 'No changes have been recorded yet'];
  const fresh = seenAt ? list.filter((l) => l.ts && l.ts > seenAt).length : 0;
  const people = new Set(list.map((l) => String(l.user || '').trim().toLowerCase()).filter(Boolean)).size;
  const oldest = list.reduce((m, l) => (l.ts && (!m || l.ts < m) ? l.ts : m), '');
  return [
    fresh > 0 && <span key="n" style={{ color: 'hsl(var(--color-green))' }}>{fresh.toLocaleString('en-US')} new since your last visit</span>,
    <span key="c">{plural(list.length, 'change')} by {plural(people || 1, 'person', 'people')}{oldest ? ` since ${formatDate(oldest)}` : ''}</span>,
  ];
}

export function ActivityTab({ logs, assets, openAsset, onGoTo, onUndo, canUndo, lastSeen, onSeen, scopeName }) {
  // What was "last seen" when the tab opened: marking the log read must not empty the sentence.
  const [seenAt] = useState(() => lastSeen || '');
  const count = (logs || []).length;
  const seenRef = useRef(onSeen);
  useEffect(() => { seenRef.current = onSeen; });
  useEffect(() => { seenRef.current?.(); }, [count]);
  return (
    <div data-tab="activity">
      <Sentence parts={activitySentence(logs, seenAt, scopeName)} />
      <div style={{ marginTop: 16 }}>
        <ActivityLog bare logs={logs || []} query="" onOpenProperty={scopeName ? null : (id) => openAsset?.(id)} activeId={null} activeName=""
          scopeName={scopeName} onGoTo={onGoTo} onUndo={onUndo} canUndo={canUndo} assetsForKind={assets} />
      </div>
    </div>
  );
}

export default ActivityTab;
