import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The shared accounting Dialog (Change Loan, + Add > Manual, Ask Accountant,
// Management Fees). 11/21/2026: on a 390px phone the form's one column grew to
// its widest row (431px), so every right-hand field ran off the screen. jsdom
// lays nothing out, so this pins the rule that bounds the column to the sheet.

vi.mock('../../api', () => ({ api: {} }));
vi.mock('../../egnyte/EgnyteFolderPick', () => ({ default: () => null }));

import { Dialog } from './LoanDialogs';

describe('accounting Dialog layout', () => {
  it('bounds its one column to the sheet, never to its widest row', () => {
    render(<Dialog title="Change Loan" onClose={() => {}} onSubmit={(e) => e.preventDefault()} submitLabel="Save"><div>Fields</div></Dialog>);
    const body = screen.getByText('Fields').parentElement;
    expect(body.style.display).toBe('grid');
    expect(body.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });
});
