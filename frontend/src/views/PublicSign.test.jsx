import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Render-smoke + ordering for the EXTERNAL Nexus Sign experience. This page
// renders outside the MSAL gate for people with no Nexus account, so a
// crash-on-render here is a dead signing link for a customer rather than a
// broken tab for a colleague - which is why it gets its own test.
//
// The thing actually worth asserting is the ORDER: consent, then the one-time
// code, then the document. The server enforces it by withholding the document
// URLs, so the test drives the same payload shapes the API really returns.

vi.mock('../api', () => ({ API_BASE: '', api: {} }));
// pdfjs and the signature canvas are out of scope for a gate test; SigningDoc
// is exercised through its real gate branch, which never reaches either.
vi.mock('../components/ESign', async () => {
  const actual = await vi.importActual('../components/ESign');
  return actual;
});

const PublicSign = (await import('./PublicSign')).default;

const DISCLOSURES = [
  { heading: 'Paper copies', body: 'You may ask for a paper copy at any time.' },
  { heading: 'Withdrawing consent', body: 'You may withdraw before you sign.' },
];

const base = {
  partyId: 'p1', requestId: 'r1', title: 'Subcontract Agreement', message: '',
  status: 'pending', source: 'pdf', myTurn: true, myRole: 'a', myPartyRole: 'signer',
  myName: 'Dana Fields', myStatus: 'notified', parties: [],
  consentText: 'I agree to use electronic records.', consentVersion: '2.0-2026-09',
  disclosures: DISCLOSURES, disclosureDigest: 'ab'.repeat(32),
  supportContact: 'it@greensglobal.com', copyUrl: '/esign/public/tok/copy',
  governingLaw: 'TX', standaloneConsent: true, expiresOn: '',
  sender: { name: 'Maria Ortiz', email: 'maria.ortiz@greensglobal.com',
            title: 'Project Manager', phone: '(949) 555-0134', entity: 'Greens Global' },
};

const consentPayload = { ...base, gate: 'consent', consentAt: '', otpChannels: [] };
const otpPayload = {
  ...base, gate: 'otp', consentAt: '2026-09-15T10:00:00+00:00',
  otpChannels: [{ channel: 'email', masked: 'd••••@partner.example' },
                { channel: 'sms', masked: '•••• 0134' }],
};

let queue = [];
const calls = [];

beforeEach(() => {
  queue = [];
  calls.length = 0;
  global.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET',
                 body: opts.body ? JSON.parse(opts.body) : null });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, json: async () => next };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('Nexus Sign external signing page', () => {
  it('shows who sent the document before anything else', async () => {
    queue.push(consentPayload);
    render(<PublicSign token="tok" />);
    expect(await screen.findByText('Subcontract Agreement')).toBeTruthy();
    expect(screen.getByText('Maria Ortiz')).toBeTruthy();
    // An external signer may not recognize the brand or the domain, so the
    // sender's own contact details are the legitimacy check (review section 10).
    expect(screen.getByText('maria.ortiz@greensglobal.com')).toBeTruthy();
    expect(screen.getByText('(949) 555-0134')).toBeTruthy();
  });

  it('puts consent first and shows no document behind it', async () => {
    queue.push(consentPayload);
    render(<PublicSign token="tok" />);
    expect(await screen.findByText('Before You Sign')).toBeTruthy();
    expect(screen.getByText(DISCLOSURES[0].body)).toBeTruthy();
    // The signing controls must not be reachable from the consent screen.
    expect(screen.queryByText('Finish')).toBeNull();
    expect(screen.queryByText(/Sign here/i)).toBeNull();
  });

  it('offers paper signing without letting it compete with the primary action', async () => {
    queue.push(consentPayload);
    render(<PublicSign token="tok" />);
    const primary = await screen.findByRole('button', { name: /Sign Electronically/i });
    const paper = screen.getByRole('button', { name: /I would rather sign on paper/i });
    expect(primary.className).toContain('primary-btn');
    expect(paper.className).not.toContain('primary-btn');
  });

  it('records consent, then asks for a one-time code', async () => {
    queue.push(consentPayload);           // initial load
    render(<PublicSign token="tok" />);
    await screen.findByText('Before You Sign');

    // Scrolling the disclosure to the end is what enables the checkbox; jsdom
    // reports zero-height elements, which the component already treats as
    // "short enough to be fully visible", so the box is live.
    fireEvent.click(screen.getByRole('checkbox'));
    queue.push({ ok: true, gate: 'otp', otpChannels: otpPayload.otpChannels });  // POST /consent
    queue.push(otpPayload);                                                      // reload
    fireEvent.click(screen.getByRole('button', { name: /Sign Electronically/i }));

    expect(await screen.findByText("Verify It's You")).toBeTruthy();
    const consentCall = calls.find(c => c.url.endsWith('/consent'));
    expect(consentCall).toBeTruthy();
    expect(consentCall.body.agreed).toBe(true);
  });

  it('lets the signer choose email or text for the code', async () => {
    queue.push(otpPayload);
    render(<PublicSign token="tok" />);
    await screen.findByText("Verify It's You");
    expect(screen.getByText('d••••@partner.example')).toBeTruthy();
    expect(screen.getByText('•••• 0134')).toBeTruthy();

    queue.push({ channel: 'sms', masked: '•••• 0134', expiresIn: 600 });
    fireEvent.click(screen.getByText('Text message'));
    fireEvent.click(screen.getByRole('button', { name: /Send Code/i }));

    await waitFor(() => expect(calls.some(c => c.url.endsWith('/otp/request'))).toBe(true));
    expect(calls.find(c => c.url.endsWith('/otp/request')).body.channel).toBe('sms');
    expect(await screen.findByPlaceholderText('000000')).toBeTruthy();
  });

  it('keeps the copy-to-read link available while gated (UETA section 8)', async () => {
    queue.push(consentPayload);
    render(<PublicSign token="tok" />);
    const link = await screen.findByText(/Download a copy to read or print/i);
    expect(link.closest('a').getAttribute('href')).toBe('/esign/public/tok/copy');
  });

  // Past both gates. Uses a TEMPLATE-source envelope deliberately: it renders
  // from `body` paragraphs rather than pdf.js, so the required-field behavior
  // can be tested without standing up a PDF worker.
  const openPayload = {
    ...base, gate: '', consentAt: '2026-09-15T10:00:00+00:00', otpChannels: [],
    source: 'template', parties: [{ name: 'Dana Fields', status: 'viewed', roleKey: 'a' }],
    body: [
      'The parties agree as follows.',
      '[[text:a:Legal entity name]]',
      '[[check:a:Insurance confirmed]]',
      '[[sign:a]]',
    ],
  };

  it('names the required fields that are still empty', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    // A signature and a checkbox are required; authored free text is not.
    const counter = await screen.findByTitle(/2 required fields left/i);
    fireEvent.click(counter);
    // Entries in the list are buttons that jump to the field; the checkbox in
    // the document body carries the same words, so match on the control.
    expect(screen.getByRole('button', { name: /^Signature/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Insurance confirmed/ })).toBeTruthy();
    // The optional text field must not be listed as outstanding.
    expect(screen.queryByRole('button', { name: /Legal entity name/ })).toBeNull();
  });

  it('will not let the signer finish while a required field is empty', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    const finish = await screen.findByRole('button', { name: /Finish/i });
    expect(finish.disabled).toBe(true);

    // Ticking the checkbox clears one of the two, and the count follows.
    fireEvent.click(screen.getByRole('checkbox', { name: /Insurance confirmed/i }));
    expect(await screen.findByTitle(/1 required field left/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Finish/i }).disabled).toBe(true);
  });

  it('explains an invalid link instead of rendering nothing', async () => {
    queue = [];
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ detail: '' }), status: 404 }));
    render(<PublicSign token="bad" />);
    expect(await screen.findByText(/invalid or no longer active/i)).toBeTruthy();
  });
});
