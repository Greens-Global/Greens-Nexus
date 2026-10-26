import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The Adopt Your Signature popup's button is Title Case like every button.
vi.mock('../api', () => ({ api: {} }));
const { SignaturePad } = await import('./ESign');

describe('SignaturePad', () => {
  it('says Adopt & Sign', () => {
    render(<SignaturePad name="Jane Doe" onAdopt={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Adopt & Sign/ })).toBeTruthy();
  });
});
