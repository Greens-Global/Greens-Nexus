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

  it('shows the expiry as a US date, not an ISO one', async () => {
    queue.push({ ...consentPayload, expiresOn: '2026-09-25' });
    render(<PublicSign token="tok" />);
    expect(await screen.findByText('09/25/2026')).toBeTruthy();
    expect(screen.queryByText('2026-09-25')).toBeNull();
  });

  it('offers paper signing without letting it compete with the primary action', async () => {
    queue.push(consentPayload);
    render(<PublicSign token="tok" />);
    const primary = await screen.findByRole('button', { name: /^I Agree$/i });
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
    fireEvent.click(screen.getByRole('button', { name: /^I Agree$/i }));

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
    // Fetched, not linked: the server's copyUrl can be relative, and a
    // relative link resolves against the SPA origin - which is how this
    // saved a blank .htm off Cloudflare instead of the document (Sagar,
    // Sep 22 2026). The access code has to travel as a header too.
    queue.push({ ...consentPayload, locked: false });
    render(<PublicSign token="tok" />);
    const btn = await screen.findByRole('button', { name: /Download a copy to read or print/i });

    const copyFetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['%PDF-1.4']) }));
    global.fetch = copyFetch;
    global.URL.createObjectURL = vi.fn(() => 'blob:copy');
    global.URL.revokeObjectURL = vi.fn();
    fireEvent.click(btn);

    await waitFor(() => expect(copyFetch).toHaveBeenCalled());
    expect(String(copyFetch.mock.calls[0][0])).toBe('/esign/public/tok/copy');
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

  it('guides field by field: START first, then NEXT naming where it goes', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    // Before it is used it says only START - the signer has not been anywhere
    // yet, so there is no "next" to name.
    const start = await screen.findByRole('button', { name: /Start signing/i });
    expect(start.textContent.replace(/\s+/g, ' ').trim()).toBe('START');

    fireEvent.click(start);
    // The tab is now standing AT the first field, so its label names the one a
    // click would take them to next - not the box beside it. "NEXT Signature"
    // has to be a promise about the click (Sagar, Sep 22 2026).
    const next = await screen.findByRole('button', { name: /Next field:/i });
    expect(next.textContent).toMatch(/NEXT/);
    expect(next.textContent).toMatch(/Signature/i);
    expect(next.textContent).not.toMatch(/Insurance confirmed/);
  });

  it('reads END at the last field, and goes to the finish bar', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    fireEvent.click(await screen.findByRole('button', { name: /Start signing/i }));
    // Step on to the last field: from there nothing follows, so the tab stops
    // promising a next field and offers the end of the document instead.
    fireEvent.click(await screen.findByRole('button', { name: /Next field:/i }));
    const end = await screen.findByRole('button', { name: /Go to the end of the document/i });
    expect(end.textContent.replace(/\s+/g, ' ').trim()).toBe('END');

    window.scrollTo = vi.fn();
    fireEvent.click(end);
    // The foot of the page, which is where the finish bar lives. (jsdom
    // reports a zero-height body, so this checks the target, not the number.)
    expect(window.scrollTo).toHaveBeenCalledWith(
      { top: document.body.scrollHeight, behavior: 'smooth' });
  });

  it('will not let the signer finish while a required field is empty', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    // Two of them now: the bar at the top and the one that follows the signer
    // down the page - neither may be live while a field is empty.
    const finishAll = await screen.findAllByRole('button', { name: /Finish/i });
    expect(finishAll.length).toBe(2);
    expect(finishAll.every(b => b.disabled)).toBe(true);

    // Ticking the checkbox clears one of the two, and the count follows.
    fireEvent.click(screen.getByRole('checkbox', { name: /Insurance confirmed/i }));
    expect(await screen.findByTitle(/1 required field left/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Finish/i }).every(b => b.disabled)).toBe(true);
  });

  it('shows what the other party already filled in and signed', async () => {
    // A signer is agreeing to the document AS IT STANDS, so a co-signer's
    // answers cannot render as empty boxes (Sagar, Sep 22 2026).
    queue.push({
      ...openPayload,
      body: ['[[text:b:Employer name]]', '[[sign:b]]', '[[check:a:Insurance confirmed]]', '[[sign:a]]'],
      parties: [{ name: 'Dana Fields', status: 'viewed', roleKey: 'a' },
                { name: 'Maria Ortiz', status: 'signed', roleKey: 'b' }],
      filledByOthers: { 'text:Employer name': 'Greens Global, LLC' },
      signedByRole: { b: { name: 'Maria Ortiz', signedAt: '2026-09-21T10:00:00+00:00',
                           signatureKind: 'typed', signatureData: 'Maria Ortiz' } },
    });
    render(<PublicSign token="tok" />);
    expect(await screen.findByText('Greens Global, LLC')).toBeTruthy();
    // Their signature, not a "signs here" placeholder. Matched on the script
    // face, because the sender block carries the same name as plain text.
    const signature = screen.getAllByText('Maria Ortiz')
      .find(el => /Segoe Script/.test(el.getAttribute('style') || ''));
    expect(signature).toBeTruthy();
    expect(screen.queryByText(/signs here/i)).toBeNull();
  });

  it('brings back the signer own answers when the link is re-opened', async () => {
    // View on the completion mail re-opens this screen; it showed blank boxes.
    queue.push({
      ...openPayload,
      myValues: { 'text:Legal entity name': 'Coastline Concrete', 'check:Insurance confirmed': true },
    });
    render(<PublicSign token="tok" />);
    const text = await screen.findByDisplayValue('Coastline Concrete');
    expect(text).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Insurance confirmed/i }).checked).toBe(true);
  });

  it('the opening bar stands down once the signer presses START', async () => {
    queue.push(openPayload);
    render(<PublicSign token="tok" />);
    expect(await screen.findByText(/Consent recorded and identity verified/i)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Start signing/i }));
    await waitFor(() =>
      expect(screen.queryByText(/Consent recorded and identity verified/i)).toBeNull());
    // The bar under the document is what carries Finish from here on.
    expect(screen.getAllByRole('button', { name: /Finish/i }).length).toBe(1);
  });

  it('a rejected action says what went wrong without closing the document', async () => {
    // A 400 off an action used to be shown with the SAME screen as a dead
    // link - "Can't open this document" - so a signer whose Finish was
    // rejected lost the document they were signing (Sagar, Sep 22 2026).
    queue.push({ ...openPayload, status: 'completed' });
    render(<PublicSign token="tok" />);
    const download = await screen.findByRole('button', { name: /Download Signed Copy/i });

    global.fetch = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ detail: 'These required fields are still empty: Date, Name' }),
    }));
    fireEvent.click(download);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/These required fields are still empty/i)).toBeTruthy();
    // Still the document, not the dead-link screen.
    expect(screen.getByText('Subcontract Agreement')).toBeTruthy();
    expect(screen.queryByText(/Can't open this document/i)).toBeNull();
  });

  it('explains an invalid link instead of rendering nothing', async () => {
    queue = [];
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ detail: '' }), status: 404 }));
    render(<PublicSign token="bad" />);
    expect(await screen.findByText(/invalid or no longer active/i)).toBeTruthy();
  });
});
