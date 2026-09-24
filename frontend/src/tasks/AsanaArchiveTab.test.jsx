import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Render-smoke for Manage -> Asana Archive (Sep 2026): the read-only list of
// what the removed Asana sync left pointing at Asana.

const audit = {
  attachments: { total: 1, rows: [{ taskId: 't1', taskCode: 'TASK-1', taskTitle: 'Lease renewal', id: 'a1', name: 'plan.pdf', kind: 'asana_file' }] },
  descriptions: { total: 0, rows: [] },
  comments: { total: 1, rows: [{ taskId: 't2', taskCode: 'TASK-2', taskTitle: 'HVAC', id: 'c1', author: 'a@x.com', kind: 'asana_link' }] },
  syncedTasks: 812,
  archive: { asana_task_links: 812, asana_comment_links: 300 },
};
const getAsanaLegacyAudit = vi.fn(() => Promise.resolve(audit));
vi.mock('../api', () => ({ api: { getAsanaLegacyAudit: (...a) => getAsanaLegacyAudit(...a) } }));

const AsanaArchiveTab = (await import('./AsanaArchiveTab')).default;

describe('AsanaArchiveTab', () => {
  it('lists what still points at Asana and what was kept', async () => {
    render(<AsanaArchiveTab />);
    expect(await screen.findByText('plan.pdf', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('File Lost')).toBeInTheDocument();
    expect(screen.getByText('Dead Link')).toBeInTheDocument();
    expect(screen.getByText('1112')).toBeInTheDocument();   // archived link records
    expect(screen.getByText('2')).toBeInTheDocument();      // rows pointing at Asana
  });

  it('says so when nothing depends on Asana', async () => {
    getAsanaLegacyAudit.mockResolvedValueOnce({
      ...audit, attachments: { total: 0, rows: [] }, comments: { total: 0, rows: [] },
    });
    render(<AsanaArchiveTab />);
    expect(await screen.findByText('Nothing in Nexus depends on Asana any more.')).toBeInTheDocument();
  });
});
