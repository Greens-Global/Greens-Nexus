import { describe, it, expect } from 'vitest';
import { cardLabel, cardGraph, markCard, taskCards, refreshedCards } from './recordCards';
import { recordHref } from '../../../lib/recordRef';

describe('record cards', () => {
  it('words a card: what it is, its name, and for a task Open / Done with a US date', () => {
    expect(cardLabel({ kind: 'ticket', title: 'Gate is stuck', code: '000042' })).toBe('Ticket #000042\nGate is stuck');
    expect(cardLabel({ kind: 'task', title: 'Order the motor' }, { done: false, dueOn: '2026-11-10' })).toBe('Task\nOrder the motor\nOpen · Due 11/10/2026');
    expect(cardLabel({ kind: 'task', title: 'Order the motor' }, { done: true, dueOn: '2026-11-10' })).toBe('Task\nOrder the motor\nDone');
    expect(cardGraph({ kind: 'kb', title: 'Gate SOP' }).nodes).toEqual([{ id: 'card', label: 'Knowledge Base\nGate SOP', shape: 'step' }]);
  });

  it('marks only the box, with a safe ref and its address', () => {
    const out = markCard([{ id: 'b' }, { id: 't', containerId: 'b' }], 'b', 'task:t1');
    expect(out[0]).toMatchObject({ link: '/tasks?task=t1', customData: { nexusRecord: { ref: 'task:t1' } } });
    expect(out[1].customData).toBeUndefined();
    expect(markCard([{ id: 'b' }], 'b', 'payroll:1')[0].customData).toBeUndefined();
    expect(recordHref('ticket:k 1')).toBe('');
    expect(recordHref('ticket:k1')).toBe('/tickets?ticket=k1');
  });

  it('brings a task card up to date as a newer version, and leaves a current one alone', () => {
    const els = [
      { id: 'b', type: 'rectangle', customData: { nexusRecord: { ref: 'task:t1' } } },
      { id: 'tx', type: 'text', containerId: 'b', text: 'Task\nOrder\nOpen', originalText: 'Task\nOrder\nOpen', version: 3 },
      { id: 'b2', type: 'rectangle', isDeleted: true, customData: { nexusRecord: { ref: 'task:t2' } } },
    ];
    expect(taskCards(els).map((c) => c.taskId)).toEqual(['t1']);
    const [moved] = refreshedCards(els, { t1: { title: 'Order', done: true } });
    expect(moved).toMatchObject({ id: 'tx', text: 'Task\nOrder\nDone', version: 4 });
    expect(refreshedCards(els, { t1: { title: 'Order', done: false } })).toEqual([]);
  });
});
