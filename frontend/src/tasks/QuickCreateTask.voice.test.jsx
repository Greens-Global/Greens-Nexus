// The phone New Task sheet with voice (Neil, Oct 30 2026): Say It fills the
// form, nothing is created until Create, and what Say It set (priority
// included - the sheet has no priority box) is what gets saved; a recorded
// voice note goes up with the task.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';

const createTask = vi.fn();
const uploadFilesToTask = vi.fn(async () => []);
vi.mock('./TasksContext', () => ({
  useTasks: () => ({ createTask, myEmail: 'me@greensglobal.com', projects: [], customFields: [] }),
}));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn(async () => [{ email: 'bob@greensglobal.com', name: 'Bob Brown' }]) } }));
vi.mock('./lib', async (orig) => ({ ...(await orig()), uploadFilesToTask: (...a) => uploadFilesToTask(...a) }));

import QuickCreateTask from './QuickCreateTask';

afterEach(() => { cleanup(); delete window.webkitSpeechRecognition; createTask.mockReset(); uploadFilesToTask.mockClear(); });

describe('QuickCreateTask voice', () => {
  it('Say It fills the sheet, and Create saves what it understood with the voice note', async () => {
    let rec;
    window.webkitSpeechRecognition = function SR() { rec = this; this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); this.abort = vi.fn(); };
    const realMd = navigator.mediaDevices; const realMR = window.MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) }, configurable: true });
    window.MediaRecorder = function MR() { this.mimeType = 'audio/mp4'; this.start = vi.fn(); this.stop = vi.fn(() => { this.ondataavailable({ data: new Blob(['x']) }); this.onstop(); }); };
    window.MediaRecorder.isTypeSupported = (m) => m === 'audio/mp4';
    createTask.mockResolvedValue({ id: 't1' });
    const onClose = vi.fn();
    try {
      render(<QuickCreateTask defaults={{}} onClose={onClose} onFullDetails={() => {}} />);
      await screen.findByRole('button', { name: /Say It/ });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Dictate the Task Name - type what you say' })).toBeTruthy());
      // People load first, so "Bob" can be matched.
      await act(async () => { await Promise.resolve(); });
      fireEvent.click(screen.getByRole('button', { name: /Say It/ }));
      await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'check the gate tomorrow, urgent, for Bob' } }] }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
      expect(screen.getByLabelText('Task name').value).toBe('Check the gate');
      expect(createTask).not.toHaveBeenCalled();
      // A voice note rides along.
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record a Voice Note' })); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Stop/ })); });
      expect(screen.getByText('Voice Note')).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Task' })); });
      const saved = createTask.mock.calls[0][0];
      expect(saved).toMatchObject({ title: 'Check the gate', priority: 'urgent', assigneeIds: ['bob@greensglobal.com'] });
      expect(saved.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(uploadFilesToTask.mock.calls[0][1][0].type).toBe('audio/mp4');
      expect(onClose).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { value: realMd, configurable: true });
      window.MediaRecorder = realMR;
    }
  });
});
