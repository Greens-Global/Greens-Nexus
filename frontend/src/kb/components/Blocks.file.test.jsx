// Attachments on a page (WP 5.2): the reader shows the file's name and size as a download link.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import Blocks from './Blocks';

afterEach(cleanup);

describe('attachment block', () => {
  it('renders a download link with the name and size', () => {
    const doc = { type: 'doc', content: [{ type: 'file', attrs: { url: 'https://x.supabase.co/storage/v1/object/public/kb-media/files/a.pdf', name: 'Move-In Checklist.pdf', size: 48213, mime: 'application/pdf' } }] };
    render(<Blocks doc={doc} />);
    const link = screen.getByRole('link', { name: /Move-In Checklist\.pdf/ });
    expect(link.getAttribute('href')).toContain('kb-media/files/a.pdf');
    expect(screen.getByText(/47 KB/)).toBeTruthy();
  });

  it('plays an uploaded video and says when it ended (WP 5.10)', () => {
    const ended = [];
    const url = 'https://x.supabase.co/storage/v1/object/public/kb-media/videos/v.mp4';
    const { container } = render(<Blocks doc={{ type: 'doc', content: [{ type: 'video', attrs: { url, title: 'Forklift Walkaround', kind: 'file' } }] }} onVideoEnded={(u) => ended.push(u)} />);
    const video = container.querySelector('video');
    expect(video.getAttribute('src')).toBe(url);
    expect(screen.getByText('Forklift Walkaround')).toBeTruthy();
    fireEvent.ended(video);
    expect(ended).toEqual([url]);
  });
});
