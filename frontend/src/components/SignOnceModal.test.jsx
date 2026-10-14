import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Signs Once (Oct 14): adopt a signature, verify with the emailed code, agree,
// and the packet keeps the signature. Render-smoke plus the request it sends.

const signOnceCode = vi.fn(() => Promise.resolve({ channel: 'email', masked: 'c***@greensglobal.com', devCode: '123456' }));
const signOnce = vi.fn(() => Promise.resolve([{ key: 'company', signed: true }]));
vi.mock('../api', () => ({ api: { signOnceCode: (...a) => signOnceCode(...a), signOnce: (...a) => signOnce(...a) } }));
vi.mock('./ESign', () => ({
  SignaturePad: ({ onAdopt }) => <button onClick={() => onAdopt({ kind: 'drawn', data: 'data:image/png;base64,AAA' })}>Fake Pad Adopt</button>,
}));
const { default: SignOnceModal } = await import('./SignOnceModal');

describe('SignOnceModal', () => {
  it('signs once with the signature and the code', async () => {
    const onDone = vi.fn();
    render(<SignOnceModal packetId="s1" entityId="co" step={{ key: 'company', roleLabel: 'HR', name: 'Charmi Shah' }}
      packetName="Admin Associate - India" companyName="Greens India" onClose={() => {}} onDone={onDone} />);
    const sign = screen.getByText('Sign Once', { selector: 'button' });
    expect(sign.disabled).toBe(true);
    fireEvent.click(screen.getByText('Adopt Your Signature'));
    fireEvent.click(screen.getByText('Fake Pad Adopt'));
    fireEvent.click(screen.getByText('Email Me A Code'));
    await waitFor(() => expect(screen.getByText('Sent to c***@greensglobal.com')).toBeTruthy());
    expect(screen.getByLabelText('One-time code').value).toBe('123456');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(signOnce.mock.calls[0]).toEqual(['s1', { step: 'company', entity_id: 'co', consent: true,
      signature_kind: 'drawn', signature_data: 'data:image/png;base64,AAA', code: '123456' }]);
  });
});
