import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PersonActions from './PersonActions';

describe('PersonActions', () => {
  it('offers Message and Call on Teams, opening in a new tab', () => {
    render(<PersonActions email="ana@greensglobal.com" name="Ana Diaz" />);
    const msg = screen.getByRole('link', { name: 'Message Ana Diaz on Teams' });
    const call = screen.getByRole('link', { name: 'Call Ana Diaz on Teams' });
    expect(msg.getAttribute('href')).toBe('https://teams.microsoft.com/l/chat/0/0?users=ana%40greensglobal.com');
    expect(call.getAttribute('href')).toBe('https://teams.microsoft.com/l/call/0/0?users=ana%40greensglobal.com');
    expect(msg.getAttribute('target')).toBe('_blank');
    expect(msg.getAttribute('rel')).toContain('noopener');
    expect(msg.getAttribute('title')).toBe('Message on Teams');
    expect(call.getAttribute('title')).toBe('Call on Teams');
  });
  it('renders nothing for an external, for yourself, or with no email', () => {
    const { container, rerender } = render(<PersonActions email="g@partner.com" name="Guest" external />);
    expect(container.firstChild).toBeNull();
    rerender(<PersonActions email="me@x.com" name="Me" myEmail="me@x.com" />);
    expect(container.firstChild).toBeNull();
    rerender(<PersonActions email="" name="Nobody" />);
    expect(container.firstChild).toBeNull();
  });
  it('keeps a click from reaching the row behind it', () => {
    const onRow = vi.fn();
    render(<div onClick={onRow}><PersonActions email="a@x.com" name="A" call={false} /></div>);
    fireEvent.click(screen.getByRole('link', { name: 'Message A on Teams' }));
    expect(onRow).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Call/ })).toBeNull();
  });
});
