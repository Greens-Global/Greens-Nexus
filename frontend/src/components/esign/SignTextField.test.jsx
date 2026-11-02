import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SignTextField, { noteAnchor } from './SignTextField';

// The signer's text box on a PDF page (Nexus Sign). A `format` on the field
// masks what is typed and shows the live digit count; the server's 422
// message shows under the box.

const st = { position: 'absolute', left: '10%', top: '20%', width: '30%', height: '3%' };
const field = { id: 'f1', type: 'text', label: 'Social Security Number', x: 0.1, y: 0.2, w: 0.3, h: 0.03, format: 'ssn', sensitive: true };

describe('SignTextField', () => {
  it('masks an SSN as it is typed and names the box by its label', () => {
    const onChange = vi.fn();
    render(<SignTextField field={field} value="" onChange={onChange} style={st} />);
    const box = screen.getByLabelText('Social Security Number');
    expect(box.getAttribute('placeholder')).toBe('###-##-####');
    expect(box.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(box, { target: { value: '123456789' } });
    expect(onChange).toHaveBeenCalledWith('123-45-6789');
  });
  it('shows the live count for a routing number only while the box has focus, until it is complete', () => {
    const f = { ...field, id: 'r', label: 'Routing Number', format: 'routing', sensitive: false };
    const { rerender } = render(<SignTextField field={f} value="12345" onChange={() => {}} style={st} />);
    expect(screen.queryByText('5 of 9 digits')).toBeNull();               // not focused: no counter
    fireEvent.focus(screen.getByLabelText('Routing Number'));
    expect(screen.getByText('5 of 9 digits')).toBeTruthy();
    rerender(<SignTextField field={f} value="123456789" onChange={() => {}} style={st} />);
    expect(screen.queryByText(/of 9 digits/)).toBeNull();
    rerender(<SignTextField field={f} value="1234" onChange={() => {}} style={st} />);
    expect(screen.getByText('4 of 9 digits')).toBeTruthy();
    fireEvent.blur(screen.getByLabelText('Routing Number'));
    expect(screen.queryByText(/of 9 digits/)).toBeNull();
  });
  it('shows the server message under the box, wrapping and never off the page', () => {
    render(<SignTextField field={field} value="123-45-6789" onChange={() => {}} style={st} error="That is not a valid Social Security number." />);
    const note = screen.getByRole('alert');
    expect(note.textContent).toBe('That is not a valid Social Security number.');
    expect(screen.getByLabelText('Social Security Number').getAttribute('aria-invalid')).toBe('true');
    expect(note.style.whiteSpace).toBe('normal');
    expect(note.style.maxWidth).toBe('min(60ch, 100%)');
    expect(note.style.left).toBe('10%');                                    // left half: under the box's left edge
    expect(note.style.right).toBe('');
  });
  it('a box on the right half of the page anchors its note to the right edge', () => {
    const right = { ...st, left: '62%', width: '30%' };
    render(<SignTextField field={field} value="" onChange={() => {}} style={right} error="That is not a valid Social Security number." />);
    const note = screen.getByRole('alert');
    expect(note.style.right).toBe('0px');
    expect(note.style.left).toBe('');
    expect(noteAnchor({ left: '50%', top: '20%', height: '3%' })).toEqual({ left: '50%', top: 'calc(20% + 3% + 2px)' });
    expect(noteAnchor({ left: '50.5%', top: '20%', height: '3%' })).toEqual({ right: 0, top: 'calc(20% + 3% + 2px)' });
    expect(noteAnchor(undefined)).toEqual({ left: undefined, top: 'calc(0% + 0% + 2px)' });
  });
  it('is a plain text box without a format', () => {
    render(<SignTextField field={{ id: 'p', type: 'text', x: 0, y: 0, w: 0.2, h: 0.03 }} value="" onChange={() => {}} style={st} />);
    const box = screen.getByLabelText('Text');
    expect(box.getAttribute('placeholder')).toBe('Text');
    expect(box.getAttribute('inputmode')).toBeNull();
  });
});
