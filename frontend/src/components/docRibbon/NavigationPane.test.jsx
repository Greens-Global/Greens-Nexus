import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NavigationPane from './NavigationPane';

// Word's View > Navigation (Neil, 11/11/2026): Headings, Pages (the old
// always-on rail, now one tab) and Results for the pane's own search.
const HEADINGS = [{ pageId: 'p1', pos: 1, level: 1, page: 1, text: 'Offer of Employment' }, { pageId: 'p1', pos: 40, level: 2, page: 1, text: 'Benefits' }];

describe('the Navigation pane', () => {
  it('lists the headings and goes to one on a click', () => {
    const onGo = vi.fn();
    render(<NavigationPane tab="headings" headings={HEADINGS} onGo={onGo} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Benefits' }));
    expect(onGo).toHaveBeenCalledWith(HEADINGS[1]);
  });

  it('shows the Pages tab only when there are pages to show', () => {
    const { rerender } = render(<NavigationPane tab="pages" headings={[]} onGo={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Pages' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Headings' }).getAttribute('aria-selected')).toBe('true');
    rerender(<NavigationPane tab="pages" headings={[]} pages={<div>THUMBS</div>} onGo={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Pages' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('THUMBS')).toBeTruthy();
  });

  it('switches to Results as you search, and lists each match with the words around it', () => {
    const onTab = vi.fn();
    const onQuery = vi.fn();
    const { rerender } = render(<NavigationPane tab="headings" onTab={onTab} headings={HEADINGS} onGo={() => {}} onClose={() => {}} query="" onQuery={onQuery} />);
    fireEvent.change(screen.getByLabelText('Search document'), { target: { value: 'salary' } });
    expect(onQuery).toHaveBeenCalledWith('salary');
    expect(onTab).toHaveBeenCalledWith('results');
    const onResult = vi.fn();
    rerender(<NavigationPane tab="results" onTab={onTab} headings={HEADINGS} onGo={() => {}} onClose={() => {}} query="salary" onQuery={onQuery}
      results={[{ pageId: 'p1', from: 10, to: 16, before: 'Annual ', match: 'Salary', after: ': 80,000' }]} onResult={onResult} />);
    expect(screen.getByText('1 result')).toBeTruthy();
    const row = screen.getByText('Salary').closest('button');
    expect(row.textContent).toBe('Annual Salary: 80,000');
    fireEvent.click(row);
    expect(onResult).toHaveBeenCalledWith(0);
  });

  it('says so when nothing matches', () => {
    render(<NavigationPane tab="results" headings={[]} onGo={() => {}} onClose={() => {}} query="zzz" onQuery={() => {}} results={[]} />);
    expect(screen.getByText(/No results for "zzz"/)).toBeTruthy();
  });
});
