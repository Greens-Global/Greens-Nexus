import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The Tasks copy of the attachment viewer (tasks/components.jsx), kept in step
// with the Tickets one: on a phone a PDF is a card with Open / Download (iOS
// renders only page 1 of an iframed PDF, Android nothing), media is sized in
// dvh, and the header's actions are 40px targets.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
const { AttachmentViewer } = await import('./components');

function setViewport(isMobile) {
  window.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}
afterEach(() => cleanup());

const PDF = { name: 'plans.pdf', size: '2 MB', kind: 'doc', url: 'https://x.supabase.co/storage/v1/object/public/task-files/plans.pdf' };

describe('Tasks AttachmentViewer', () => {
  it('phone: PDF card with Open and Download, no iframe, 40px close', () => {
    setViewport(true);
    const { baseElement } = render(<AttachmentViewer att={PDF} onClose={() => {}} />);
    expect(baseElement.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link', { name: /Open/ }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: /^Download$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close viewer' }).style.width).toBe('40px');
    expect(screen.getByRole('link', { name: 'Download plans.pdf' })).toBeInTheDocument();
  });

  it('phone: images are capped in dvh', () => {
    setViewport(true);
    const { baseElement } = render(<AttachmentViewer att={{ name: 'a.jpg', kind: 'image', url: 'https://x/a.jpg' }} onClose={() => {}} />);
    expect(baseElement.querySelector('img').style.maxHeight).toBe('78dvh');
  });

  it('desktop: PDF stays inline, images stay in vh', () => {
    setViewport(false);
    const { baseElement, unmount } = render(<AttachmentViewer att={PDF} onClose={() => {}} />);
    expect(baseElement.querySelector('iframe')).not.toBeNull();
    unmount();
    const r = render(<AttachmentViewer att={{ name: 'a.jpg', kind: 'image', url: 'https://x/a.jpg' }} onClose={() => {}} />);
    expect(r.baseElement.querySelector('img').style.maxHeight).toBe('78vh');
  });
});
