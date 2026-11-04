import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Documents > Filing & Sorting (Nov 2026). The tab drives renames and moves in
// Egnyte, so its behavior is pinned here with a mocked API: the guide before a
// first scan, the default scan, the hidden correctly-labeled rows, the
// spacing-only callout, search, paging, and the client-driven folder walk.

const filingStatus = vi.fn();
const filingScan = vi.fn();
const filingActivity = vi.fn(() => Promise.resolve({ rows: [] }));
vi.mock('../api', () => ({
  api: {
    filingStatus: (...a) => filingStatus(...a),
    filingScan: (...a) => filingScan(...a),
    filingActivity: (...a) => filingActivity(...a),
    filingApply: vi.fn(() => Promise.resolve({ results: [], moved: 0, failed: 0 })),
    filingConfig: vi.fn(),
  },
}));
// The tree lists Egnyte - not this file's subject.
vi.mock('../egnyte/EgnyteTree', () => ({ default: () => <div>egnyte tree</div> }));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const FilingTab = (await import('./FilingTab')).default;

const STATUS = { configured: true, scanRoots: ['/Shared/#Unsorted'], templates: [], mayConfigure: false };

const row = (name, extra = {}) => ({
  sourcePath: `/Shared/#Unsorted/${name}`, currentName: name, status: 'review',
  docType: '', destFolder: '', newName: '', rule: '', reasons: ['no doc-type rule matched the name'],
  canonicalName: name, labeled: true, ...extra,
});

const scanOf = (proposals, extra = {}) => {
  const totals = { files: 0, labeled: 0, unlabeled: 0 };
  for (const p of proposals) if (p.status !== 'skip') { totals.files += 1; totals[p.labeled ? 'labeled' : 'unlabeled'] += 1; }
  return { proposals, counts: { auto: 0, review: proposals.length, skip: 0 }, totals,
           scannedRoots: ['/Shared/#Unsorted'], missingRoots: [], subfolders: [], truncated: false, ...extra };
};

beforeEach(() => {
  filingStatus.mockReset().mockResolvedValue(STATUS);
  filingScan.mockReset();
  try { localStorage.clear(); } catch { /* jsdom */ }
});

describe('Filing & Sorting tab', () => {
  it('explains itself before the first scan', async () => {
    render(<FilingTab />);
    expect(await screen.findByText('How It Works')).toBeTruthy();
    expect(screen.getByText(/Fix All Names - every wrong name/)).toBeTruthy();
  });

  it('scans, counts, and hides the correctly labeled files by default', async () => {
    filingScan.mockResolvedValue(scanOf([
      row('2020-01-01 - Right Name.pdf'),
      row('Wrong Name 2020-02-02.pdf', { canonicalName: '2020-02-02 - Wrong Name.pdf', labeled: false }),
    ]));
    render(<FilingTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan Now/ }));
    expect(await screen.findByText('Wrong Name 2020-02-02.pdf')).toBeTruthy();
    expect(screen.queryByText('2020-01-01 - Right Name.pdf')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Hide Correctly Labeled/));
    expect(await screen.findByText('2020-01-01 - Right Name.pdf')).toBeTruthy();
    // The wrong one offers both repairs.
    expect(screen.getAllByRole('button', { name: 'Fix Name' }).length).toBe(1);
    expect(screen.getByRole('button', { name: /Fix All Names \(1\)/ })).toBeTruthy();
  });

  it('says so when a suggestion differs only in spacing', async () => {
    filingScan.mockResolvedValue(scanOf([
      row('2018-08-29 - Plan -Charles - E2.3.pdf', { canonicalName: '2018-08-29 - Plan - Charles - E2.3.pdf', labeled: false }),
    ]));
    render(<FilingTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan Now/ }));
    expect(await screen.findByText(/differs only in spacing/)).toBeTruthy();
  });

  it('finds a file by name', async () => {
    filingScan.mockResolvedValue(scanOf([
      row('Alpha.pdf', { labeled: false, canonicalName: '' }),
      row('Beta.pdf', { labeled: false, canonicalName: '' }),
    ]));
    render(<FilingTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan Now/ }));
    await screen.findByText('Alpha.pdf');
    fireEvent.change(screen.getByLabelText(/Find a file or folder/), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('Alpha.pdf')).toBeNull());
    expect(screen.getByText('Beta.pdf')).toBeTruthy();
  });

  it('renders a large result in pages', async () => {
    const many = Array.from({ length: 250 }, (_, i) => row(`File ${i}.pdf`, { labeled: false, canonicalName: '' }));
    filingScan.mockResolvedValue(scanOf(many));
    render(<FilingTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan Now/ }));
    expect(await screen.findByText('File 0.pdf')).toBeTruthy();
    expect(screen.queryByText('File 249.pdf')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 More' }));
    expect(await screen.findByText('File 249.pdf')).toBeTruthy();
  });

  it('walks ticked folders and their subfolders, a few per request', async () => {
    try { localStorage.setItem('filing-picked', JSON.stringify(['/Shared/A'])); } catch { /* jsdom */ }
    filingScan.mockImplementation(({ paths } = {}) => {
      if (paths?.[0] === '/Shared/A') {
        return Promise.resolve(scanOf([row('Top.pdf', { sourcePath: '/Shared/A/Top.pdf', labeled: false, canonicalName: '' })],
          { subfolders: ['/Shared/A/Deep'], scannedRoots: ['/Shared/A'] }));
      }
      return Promise.resolve(scanOf([row('Deep.pdf', { sourcePath: '/Shared/A/Deep/Deep.pdf', labeled: false, canonicalName: '' })],
        { scannedRoots: ['/Shared/A/Deep'] }));
    });
    render(<FilingTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Scan Now \(1 Folder\)/ }));
    expect(await screen.findByText('Deep.pdf')).toBeTruthy();
    expect(screen.getByText('Top.pdf')).toBeTruthy();
    expect(filingScan).toHaveBeenCalledWith({ paths: ['/Shared/A'] });
    expect(filingScan).toHaveBeenCalledWith({ paths: ['/Shared/A/Deep'] });
  });
});
