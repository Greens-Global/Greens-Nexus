// Compliance CSV (WP 1.6, Oct 29 2026): a name typed by a user that starts
// with = + - @ must reach Excel as text, never as a formula.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const saved = [];
const BOM = new RegExp(`^${String.fromCharCode(0xFEFF)}`);
const DATA = {
  scope: 'direct',
  columns: [{ key: 'c1', title: 'Safety Policy' }],
  people: [
    { name: '=HYPERLINK("http://x","Click")', email: 'eve@example.com', department: '+Ops', job_title: '@Lead',
      cells: { c1: { status: 'Overdue', due: '2026-10-01' } }, counts: { red: 1, amber: 0, green: 0 } },
    { name: 'Al Test', email: 'al@example.com', department: 'Operations', job_title: '-5', cells: {}, counts: { red: 0, amber: 0, green: 1 } },
  ],
  stats: { people: 2, compliant_pct: 50, overdue: 1, due_soon: 0, compliant_people: 1 },
  filters: { companies: [], departments: [], can_company: false },
};

vi.mock('../../api', () => {
  const api = new Proxy({}, { get: (_, k) => (k === 'kbCompliance' ? () => Promise.resolve(DATA) : () => Promise.resolve([])) });
  return { api, default: api, saveBlob: (blob, name) => saved.push({ blob, name }), API_BASE: 'http://localhost:8000' };
});

const { default: Compliance } = await import('./Compliance');
afterEach(cleanup);

describe('Compliance CSV', () => {
  it('defuses cells a spreadsheet would run as a formula', async () => {
    render(<Compliance me={{ email: 'me@example.com' }} />);
    const btn = await screen.findByRole('button', { name: /CSV/ });
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('compliance-direct.csv');
    const text = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsText(saved[0].blob); });
    const rows = text.replace(BOM, '').split('\r\n');
    expect(rows[0]).toBe('Name,Email,Department,Job Title,Safety Policy');
    expect(rows[1]).toBe(`"'=HYPERLINK(""http://x"",""Click"")",eve@example.com,'+Ops,'@Lead,Overdue (due 10/01/2026)`);
    // a plain negative number stays a number
    expect(rows[2]).toBe('Al Test,al@example.com,Operations,-5,');
  });
});
