// More question types (WP 5.5): put-in-order moves items; short answer is free text.
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OrderAnswer, ShortAnswer, hasAnswer } from './QuestionInputs';

afterEach(cleanup);

function Order({ onValue }) {
  const [v, setV] = useState(undefined);
  return <OrderAnswer q={{ _id: 'o1', q: 'Order', options: ['Lift', 'Inspect', 'Lower'] }} value={v} onChange={(x) => { setV(x); onValue(x); }} />;
}

describe('question inputs', () => {
  it('starts in the shown order (answered) and moves an item up', () => {
    const seen = [];
    render(<Order onValue={(x) => seen.push(x)} />);
    expect(seen[0]).toEqual([0, 1, 2]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Inspect up' }));
    expect(seen.at(-1)).toEqual([1, 0, 2]);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1.Inspect', '2.Lift', '3.Lower']);
  });

  it('short answers count once something is typed', () => {
    let v = '';
    render(<ShortAnswer q={{ _id: 's1', q: 'What do you wear?' }} value={v} onChange={(x) => { v = x; }} />);
    fireEvent.change(screen.getByLabelText('Answer to: What do you wear?'), { target: { value: 'a helmet' } });
    expect(v).toBe('a helmet');
    expect(hasAnswer('  ')).toBe(false);
    expect(hasAnswer('a helmet')).toBe(true);
    expect(hasAnswer([2, 0, 1])).toBe(true);
  });
});
