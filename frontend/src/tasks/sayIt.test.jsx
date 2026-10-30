// Voice on Tasks (Neil, Oct 30 2026): Say It fills the form from one spoken
// sentence and a chip puts its words back; voice notes are 'audio'
// attachments that play in the viewer; voice notes and videos over their
// limit are refused with the reason.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import SayIt from './SayIt';
import { AttachmentViewer } from './components';
import { attachmentKindOf, isAudioAttachment, screenTaskFiles } from './lib';

afterEach(() => { cleanup(); delete window.webkitSpeechRecognition; });

const people = [{ email: 'bob@greensglobal.com', name: 'Bob Brown' }];

function fakeSpeech() {
  const box = {};
  window.webkitSpeechRecognition = function SR() {
    box.rec = this;
    this.start = vi.fn();
    this.stop = vi.fn(() => this.onend?.());
    this.abort = vi.fn();
  };
  return box;
}

describe('Say It', () => {
  it('is not offered where the browser cannot dictate', () => {
    render(<SayIt people={people} myEmail="me@greensglobal.com" snapshot={() => ({})} onFill={() => {}} />);
    expect(screen.queryByRole('button', { name: /Say It/ })).toBeNull();
  });

  it('fills the form when the sentence ends, shows what it understood, and a chip undoes one part', async () => {
    const speech = fakeSpeech();
    const before = { title: '', dueOn: '', priority: 'medium', assigneeIds: ['me@greensglobal.com'] };
    const onFill = vi.fn();
    render(<SayIt people={people} myEmail="me@greensglobal.com" snapshot={() => before} onFill={onFill} />);
    fireEvent.click(screen.getByRole('button', { name: /Say It/ }));
    expect(speech.rec.start).toHaveBeenCalled();
    expect(screen.getByText(/Listening - say the whole task/)).toBeTruthy();
    await act(async () => {
      speech.rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'call the roofer tomorrow high priority for Bob' } }] });
    });
    expect(screen.getByText(/"call the roofer tomorrow high priority for Bob"/)).toBeTruthy();
    expect(onFill).not.toHaveBeenCalled();                      // nothing until the sentence ends
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    const filled = onFill.mock.calls.at(-1)[0];
    expect(filled.title).toBe('Call the roofer');
    expect(filled.priority).toBe('high');
    expect(filled.assigneeIds).toEqual(['bob@greensglobal.com']);
    expect(filled.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText('High Priority')).toBeTruthy();
    expect(screen.getByText('Bob Brown')).toBeTruthy();
    // Undo the priority: back to Medium, its words back in the name.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo Priority from Say It' })); });
    const undone = onFill.mock.calls.at(-1)[0];
    expect(undone.priority).toBe('medium');
    expect(undone.title).toBe('Call the roofer high priority');
    expect(undone.assigneeIds).toEqual(['bob@greensglobal.com']);
    expect(screen.queryByText('High Priority')).toBeNull();
  });

  it('Cancel keeps the form as it was', async () => {
    const speech = fakeSpeech();
    const onFill = vi.fn();
    render(<SayIt people={people} myEmail="me@greensglobal.com" snapshot={() => ({ title: 'x' })} onFill={onFill} />);
    fireEvent.click(screen.getByRole('button', { name: /Say It/ }));
    await act(async () => { speech.rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'something else' } }] }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(onFill).not.toHaveBeenCalled();
  });
});

const file = (name, type, size) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('voice notes and videos as task attachments', () => {
  it('a recorded clip is an audio attachment; older rows are read from the name', () => {
    expect(attachmentKindOf(file('voice-note-1.m4a', 'audio/mp4', 10))).toBe('audio');
    expect(attachmentKindOf(file('IMG_2.MOV', '', 10))).toBe('video');
    expect(attachmentKindOf(file('a.pdf', 'application/pdf', 10))).toBe('doc');
    expect(isAudioAttachment({ kind: 'doc', name: 'voice-note-12.webm' })).toBe(true);
    expect(isAudioAttachment({ kind: 'video', name: 'walk.webm' })).toBe(false);
  });

  it('the viewer plays a voice note instead of offering a download', () => {
    const { container } = render(<AttachmentViewer att={{ name: 'voice-note-1.m4a', kind: 'audio', url: 'https://x/voice.m4a', size: '20 KB' }} onClose={() => {}} />);
    expect(container.querySelector('audio')?.getAttribute('src')).toBe('https://x/voice.m4a');
    expect(container.querySelector('video')).toBeNull();
  });

  it('a video over 50 MB is refused with its size; other files pass, an iPhone .mov gets its type', () => {
    const { files, refused } = screenTaskFiles([
      file('big.mp4', 'video/mp4', 60 * 1024 * 1024), file('IMG_3.MOV', '', 10), file('notes.pdf', 'application/pdf', 10),
    ]);
    expect(refused).toEqual(['big.mp4: That video is 60 MB. The limit is 50 MB - record a shorter clip and try again.']);
    expect(files.map((f) => [f.name, f.type])).toEqual([['IMG_3.MOV', 'video/quicktime'], ['notes.pdf', 'application/pdf']]);
  });
});
