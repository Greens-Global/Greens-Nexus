import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AccessCodeField, { generateAccessCode, maskPhone } from './AccessCodeField';

// The access code is the second factor on top of the emailed link: it is
// generated here, texted to the signer, or copied and shared by hand - never
// emailed, or it would travel the same channel as the link.

describe('generateAccessCode', () => {
  it('is grouped, readable and free of look-alike characters', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateAccessCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateAccessCode()));
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe('maskPhone', () => {
  it('shows only the last four digits', () => {
    expect(maskPhone('+1 (555) 010-4821')).toBe('••• 4821');
    expect(maskPhone('12')).toBe('their mobile');
  });
});

describe('AccessCodeField', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  it('generates a code into the field', () => {
    const onChange = vi.fn();
    render(<AccessCodeField value="" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Generate access code'));
    expect(onChange.mock.calls[0][0]).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('generating with a mobile on file turns on texting it', () => {
    const onCodeSmsChange = vi.fn();
    render(<AccessCodeField value="" phone="+1 555 010 4821" onChange={() => {}} onCodeSmsChange={onCodeSmsChange} />);
    fireEvent.click(screen.getByLabelText('Generate access code'));
    expect(onCodeSmsChange).toHaveBeenCalledWith(true);
  });

  it('offers the text option only once there is a code and a mobile', () => {
    const { rerender } = render(<AccessCodeField value="" phone="+1 555 010 4821" onChange={() => {}} />);
    expect(screen.queryByText(/Text the code/)).toBeNull();
    rerender(<AccessCodeField value="K7P2-QX9M" phone="+1 555 010 4821" onChange={() => {}} />);
    expect(screen.getByText(/Text the code to ••• 4821 when sending/)).toBeTruthy();
  });

  it('without a mobile it says to share it yourself, and that it is never emailed', () => {
    render(<AccessCodeField value="K7P2-QX9M" phone="" onChange={() => {}} />);
    expect(screen.getByText(/never emailed/)).toBeTruthy();
    expect(screen.queryByText(/Text the code/)).toBeNull();
  });

  it('copies the code', async () => {
    render(<AccessCodeField value="K7P2-QX9M" onChange={() => {}} />);
    fireEvent.click(screen.getByLabelText('Copy access code'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('K7P2-QX9M');
  });

  it('has nothing to copy before a code exists', () => {
    render(<AccessCodeField value="" onChange={() => {}} />);
    expect(screen.queryByLabelText('Copy access code')).toBeNull();
  });

  it('a code can still be typed by hand', () => {
    const onChange = vi.fn();
    render(<AccessCodeField value="" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/Access code/), { target: { value: 'my-own-code' } });
    expect(onChange).toHaveBeenCalledWith('my-own-code');
  });
});
