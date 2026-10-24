import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Records Audit: nothing when every record is complete; a banner, then the
// list, and a click opens the person.
const getRecordsAudit = vi.fn();
vi.mock('../api', () => ({ api: { getRecordsAudit: (...a) => getRecordsAudit(...a) } }));
const RecordsAudit = (await import('./RecordsAudit')).default;

describe('Records Audit', () => {
  it('shows nothing when every record is complete', async () => {
    getRecordsAudit.mockResolvedValue({ people: [] });
    const { container } = render(<RecordsAudit />);
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('lists who is missing what and opens the person', async () => {
    getRecordsAudit.mockResolvedValue({ people: [{ id: 'e-1', name: 'Colin Case', company: 'co', jobTitle: 'Analyst', gaps: ['No picture ID on file'] }] });
    const onOpen = vi.fn();
    render(<RecordsAudit entityName={() => 'Oversite'} onOpen={onOpen} />);
    expect(await screen.findByText(/1 person is missing something on file/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('No picture ID on file')).toBeTruthy();
    fireEvent.click(screen.getByText('Colin Case').closest('button'));
    expect(onOpen).toHaveBeenCalledWith('e-1');
  });
});
