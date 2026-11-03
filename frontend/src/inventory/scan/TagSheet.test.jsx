import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// Items phase 4: the print-ready tag sheet. Labels per sheet follow the
// stock (30 on 2.625" x 1", 12 on 2" x 2"), a part-used sheet can start
// further in, and each tag names the company the SERVER gives it - nothing
// in the sheet is a hard-coded company name (white-label).

const calls = { getItemTags: vi.fn() };
vi.mock('../../api', () => ({ api: { getItemTags: (...a) => calls.getItemTags(...a) } }));

const { default: TagSheet, TagLabel } = await import('./TagSheet');
const { useEscapeLayer } = await import('../../tasks/components');
const { paginateTags, perPage, TAG_LAYOUTS, PAGE } = await import('./tagLayout');
const realQr = async () => { const m = await import('qrcode'); return m.default || m; };

const rows = (n, company = 'Alpha Storage') => Array.from({ length: n }, (_, i) => ({
  id: `it-${i}`, name: `Item ${i}`, serialNumber: `GG-${String(i).padStart(5, '0')}`, companyName: company,
}));

afterEach(() => { cleanup(); calls.getItemTags.mockReset(); try { localStorage.clear(); } catch { /* none */ } });

describe('the sheet grid', () => {
  it('fits exactly on US Letter, both sizes', () => {
    for (const l of Object.values(TAG_LAYOUTS)) {
      expect(l.left * 2 + l.cols * l.w + (l.cols - 1) * l.gapX).toBeCloseTo(PAGE.w, 2);
      expect(l.top * 2 + l.rows * l.h + (l.rows - 1) * l.gapY).toBeCloseTo(PAGE.h, 2);
    }
    expect(perPage('address')).toBe(30);
    expect(perPage('square')).toBe(12);
  });

  it('pages the tags, skipping used labels on the first sheet', () => {
    const pages = paginateTags(rows(31), 'address', 3);
    expect(pages).toHaveLength(2);
    expect(pages[0].slice(0, 2)).toEqual([null, null]);
    expect(pages[0].filter(Boolean)).toHaveLength(28);
    expect(pages[1].filter(Boolean)).toHaveLength(3);
    expect(paginateTags([], 'address')).toEqual([]);
    expect(paginateTags(rows(1), 'square', 99)[0].findIndex(Boolean)).toBe(11);   // clamped to the last label
  });

  it('places a label by its column and row', () => {
    render(<TagLabel tag={rows(1)[0]} layout="address" index={4} qr={null} />);
    const el = screen.getByTestId('nx-tag');
    // index 4 = column 2, row 2 on a 3-wide sheet
    expect(el.style.left).toBe(`${0.1875 + 1 * (2.625 + 0.125)}in`);
    expect(el.style.top).toBe(`${0.5 + 1 * 1}in`);
  });
});

describe('the tag sheet', () => {
  it('draws 30 labels a sheet with the QR code, name, serial and the server\'s company name', async () => {
    calls.getItemTags.mockResolvedValue(rows(32));
    render(<TagSheet items={rows(32).map(({ id }) => ({ id }))} onClose={() => {}} origin="https://nexus.example.com" loadQr={realQr} />);
    await waitFor(() => expect(screen.getAllByTestId('nx-tag-page')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('nx-tag-page');
    expect(within(first).getAllByTestId('nx-tag')).toHaveLength(30);
    expect(within(second).getAllByTestId('nx-tag')).toHaveLength(2);
    expect(calls.getItemTags).toHaveBeenCalledWith(rows(32).map((r) => r.id));
    expect(screen.getAllByText('Alpha Storage')).toHaveLength(32);
    expect(screen.getByText('GG-00007')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.nx-tag svg path')).toHaveLength(32));
    expect(screen.getByText(/32 tags on 2 sheets/)).toBeInTheDocument();
    // White-label: no company name comes from the screen itself.
    expect(document.body.textContent).not.toMatch(/Greens/);
  });

  it('switches to 2" x 2" labels, 12 a sheet', async () => {
    calls.getItemTags.mockResolvedValue(rows(13, 'Beta Builders'));
    render(<TagSheet items={rows(13)} onClose={() => {}} loadQr={realQr} />);
    await waitFor(() => expect(screen.getAllByTestId('nx-tag-page')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '2" x 2" Labels' }));
    expect(screen.getAllByTestId('nx-tag-page')).toHaveLength(2);
    expect(within(screen.getAllByTestId('nx-tag-page')[0]).getAllByTestId('nx-tag')).toHaveLength(12);
    expect(screen.getAllByText('Beta Builders')).toHaveLength(13);
  });

  it('starts further into a part-used sheet', async () => {
    calls.getItemTags.mockResolvedValue(rows(30));
    render(<TagSheet items={rows(30)} onClose={() => {}} loadQr={realQr} />);
    await waitFor(() => expect(screen.getAllByTestId('nx-tag-page')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Start at label'), { target: { value: '5' } });
    const pages = screen.getAllByTestId('nx-tag-page');
    expect(pages).toHaveLength(2);
    expect(within(pages[0]).getAllByTestId('nx-tag')).toHaveLength(26);
  });

  it('says when walled or deleted items were left off', async () => {
    calls.getItemTags.mockResolvedValue(rows(2));
    render(<TagSheet items={rows(3)} onClose={() => {}} loadQr={realQr} />);
    expect(await screen.findByText(/1 item was left off/)).toBeInTheDocument();
  });

  it('prints with window.print and closes on Close', async () => {
    calls.getItemTags.mockResolvedValue(rows(1));
    const onClose = vi.fn();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<TagSheet items={rows(1)} onClose={onClose} loadQr={realQr} />);
    const btn = screen.getByRole('button', { name: /Print/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(document.body.classList.contains('nx-printing-tags')).toBe(true);
    fireEvent.click(btn);
    expect(print).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    print.mockRestore();
  });

  it('QR codes carry the app\'s public address from the server, else this tab\'s origin (review M1)', async () => {
    const seen = [];
    const fakeQr = async () => ({ create: (text) => { seen.push(text); return { modules: { size: 21, get: () => false } }; } });
    calls.getItemTags.mockResolvedValue({ tags: rows(1), publicBase: 'https://nexus.greensglobal.com' });
    render(<TagSheet items={rows(1)} onClose={() => {}} loadQr={fakeQr} />);
    await waitFor(() => expect(seen).toEqual(['https://nexus.greensglobal.com/itemmanagement/item/it-0']));
    cleanup();
    seen.length = 0;
    calls.getItemTags.mockResolvedValue({ tags: rows(1), publicBase: '' });
    render(<TagSheet items={rows(1)} onClose={() => {}} loadQr={fakeQr} />);
    await waitFor(() => expect(seen).toEqual([`${window.location.origin}/itemmanagement/item/it-0`]));
  });

  it('Escape closes the tag sheet only, never the record under it; focus goes in and comes back (review L3)', async () => {
    calls.getItemTags.mockResolvedValue(rows(1));
    const underClose = vi.fn();
    const onClose = vi.fn();
    function Under() { useEscapeLayer(underClose); return <button type="button">Print Tag</button>; }
    const under = render(<Under />);
    const opener = screen.getByRole('button', { name: 'Print Tag' });
    opener.focus();
    const sheet = render(<TagSheet items={rows(1)} onClose={onClose} loadQr={realQr} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Tag sheet options'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underClose).not.toHaveBeenCalled();
    sheet.unmount();
    expect(document.activeElement).toBe(opener);
    under.unmount();
  });

  it('lets the body flow again when it prints from a scroll-locked sheet (review L4)', async () => {
    calls.getItemTags.mockResolvedValue(rows(1));
    render(<TagSheet items={rows(1)} onClose={() => {}} loadQr={realQr} />);
    const css = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
    expect(css).toMatch(/body\.nx-printing-tags \{ position: static !important; top: auto !important;[^}]*overflow: visible !important/);
  });

  it('still prints the tags when the company names cannot be loaded', async () => {
    calls.getItemTags.mockRejectedValue(new Error('offline'));
    render(<TagSheet items={[{ id: 'it-1', name: 'Hammer Drill', serialNumber: 'GG-00001' }]} onClose={() => {}} loadQr={realQr} />);
    expect(await screen.findByText('Hammer Drill')).toBeInTheDocument();
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });
});
