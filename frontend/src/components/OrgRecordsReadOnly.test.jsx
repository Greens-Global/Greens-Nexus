import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Records every company shares (Neil, 11/02/2026) - the California minimum
// wage, the interview questionnaires - are a Super Administrator's to change.
// Everyone else who can open them reads them, with one line saying why there
// is no Save, rather than a Save that answers 403.

const role = { isGlobalAdmin: false };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ isGlobalAdmin: role.isGlobalAdmin }) }));
vi.mock('../api', () => ({
  api: {
    caReviewSettings: () => Promise.resolve({ minWage: 16.9 }),
    ivTemplates: () => Promise.resolve([{ id: 't1', name: 'Site Manager', questions: [{ id: 'q', q: 'Why?', group: 'competence' }], roleIds: [], isGeneral: true }]),
    hiringAllRoles: () => Promise.resolve({ roles: [] }),
  },
}));

const { MinWageForm } = await import('./CaReview');
const { QuestionnairesModal } = await import('./Interviews');

beforeEach(() => { role.isGlobalAdmin = false; });

describe('records every company shares', () => {
  it('shows the minimum wage read only to anyone but a Super Administrator', async () => {
    render(<MinWageForm />);
    expect(await screen.findByText('Only a Super Administrator can change this.')).toBeTruthy();
    expect(screen.getByLabelText('Minimum Wage').readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('lets a Super Administrator save the minimum wage', async () => {
    role.isGlobalAdmin = true;
    render(<MinWageForm />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText('Only a Super Administrator can change this.')).toBeNull();
  });

  it('lists the questionnaires without Edit, Delete or New for anyone else', async () => {
    render(<QuestionnairesModal onClose={() => {}} />);
    expect(await screen.findByText('Site Manager')).toBeTruthy();
    expect(screen.getByText('Only a Super Administrator can change this.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText(/New Questionnaire/)).toBeNull();
  });
});
