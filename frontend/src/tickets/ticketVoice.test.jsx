// Voice on tickets (Neil, Oct 30 2026): a voice note is an 'audio'
// attachment that PLAYS in the viewer, its size is checked before upload,
// the record row offers Voice Note, and Screen Recording only shows where
// the browser can record a screen (never on a phone).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ getTicketAttachments: vi.fn(), addTicketAttachment: vi.fn(), deleteTicketAttachment: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));
const upload = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({
  supabase: { storage: { from: () => ({ upload, getPublicUrl: (p) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/ticket-evidence/${p}` } }) }) } },
}));

import { TicketAttachments } from './TicketAttachments';
import { RecordUploadButtons } from './TicketEvidence';
import { attachmentKindOf } from './ticketViewShared';
import { uploadTicketEvidence } from './evidenceUpload';

const URL_ = 'https://x.supabase.co/storage/v1/object/public/ticket-evidence/audio-1.m4a';
const file = (name, type, size = 10) => { const f = new File(['x'], name, { type }); Object.defineProperty(f, 'size', { value: size }); return f; };

beforeEach(() => { Object.values(apiMock).forEach((f) => f.mockReset()); upload.mockReset(); });
afterEach(() => { cleanup(); });

describe('ticket voice notes', () => {
  it('a voice note is an audio attachment, even an iPhone clip with no type', () => {
    expect(attachmentKindOf(file('voice-note-1.m4a', 'audio/mp4'))).toBe('audio');
    expect(attachmentKindOf(file('IMG_2.MOV', ''))).toBe('video');
    expect(attachmentKindOf(file('a.pdf', 'application/pdf'))).toBe('doc');
  });

  it('plays a voice note in the attachment viewer', async () => {
    apiMock.getTicketAttachments.mockResolvedValue([{ id: 'a1', name: 'voice-note-1.m4a', size: '40 KB', kind: 'audio', url: URL_ }]);
    const { container } = render(<TicketAttachments ticketId="t1" ticketType="it" />);
    fireEvent.click(await screen.findByTitle('View voice-note-1.m4a'));
    const audio = container.ownerDocument.querySelector('audio');
    expect(audio).toBeTruthy();
    expect(audio.getAttribute('src')).toBe(URL_);
    expect(screen.queryByText('No inline preview for this file type.')).toBeNull();
  });

  it('refuses a voice note over the limit before uploading', async () => {
    await expect(uploadTicketEvidence(file('long.m4a', 'audio/mp4', 30 * 1024 * 1024), 'audio')).rejects.toThrow(/limit is 25 MB/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('offers Voice Note, and no Screen Recording where the browser cannot record a screen', () => {
    // A phone: a microphone, no screen capture.
    const real = navigator.mediaDevices;
    window.MediaRecorder = function MR() {};
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    try {
      render(<RecordUploadButtons onFile={() => {}} quiet />);
      expect(screen.getByRole('button', { name: 'Record a Voice Note' })).toBeTruthy();
      expect(screen.queryByText('Record Screen')).toBeNull();
    } finally {
      delete window.MediaRecorder;
      Object.defineProperty(navigator, 'mediaDevices', { value: real, configurable: true });
    }
  });

  it('keeps Record Screen where getDisplayMedia exists', async () => {
    const real = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: vi.fn() }, configurable: true });
    try {
      render(<RecordUploadButtons onFile={() => {}} quiet />);
      await waitFor(() => expect(screen.getByText('Record Screen')).toBeTruthy());
    } finally { Object.defineProperty(navigator, 'mediaDevices', { value: real, configurable: true }); }
  });
});
