// Crisis support (11/02/2026, the legal compliance pass): one deterministic
// check for a message that expresses suicidal intent or self-harm, run before
// a free-text message is sent to an assistant, Ask HR or a ticket. No AI, no
// key, no network. The phrase list is crisisPhrases.json, the SAME file as
// backend/crisis_phrases.json (backend/test_crisis_support.py fails when they
// differ); normalize() mirrors crisis_support.normalize on the server.
//
// A match shows the resources card (components/CrisisSupportCard.jsx) the
// person acknowledges; the message still goes where it was going. Nothing is
// stored, logged or sent to anyone about the match (a decision left to Neil).
import phrases from './crisisPhrases.json';

const PATTERNS = (phrases.patterns || []).map((p) => new RegExp(p));
const EXCLUSIONS = (phrases.exclusions || []).map((p) => new RegExp(p, 'g'));

export function normalize(text) {
  const s = String(text ?? '').toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${s} `;
}

// Rich text (a description editor's HTML) to the words in it.
export function textOf(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
}

export function detectCrisis(text) {
  if (!text) return false;
  let s = normalize(text);
  if (!s.trim()) return false;
  for (const e of EXCLUSIONS) s = s.replace(e, ' ');
  return PATTERNS.some((p) => p.test(s));
}

// Mirrors RESOURCES in backend/crisis_support.py.
export const CRISIS_RESOURCES = {
  US: {
    country: 'US',
    label: 'United States',
    lines: [
      { name: '988 Suicide & Crisis Lifeline', detail: 'Call or text 988, any time, free',
        links: [{ label: 'Call 988', href: 'tel:988' }, { label: 'Text 988', href: 'sms:988' },
          { label: 'Chat at 988lifeline.org', href: 'https://988lifeline.org/chat/' }] },
    ],
    emergency: { number: '911', href: 'tel:911' },
  },
  IN: {
    country: 'IN',
    label: 'India',
    lines: [
      { name: 'Tele-MANAS', detail: 'Call 14416 or 1-800-891-4416, any time, free',
        links: [{ label: 'Call 14416', href: 'tel:14416' }, { label: 'Call 1-800-891-4416', href: 'tel:18008914416' }] },
    ],
    emergency: { number: '112', href: 'tel:112' },
  },
};

export const CRISIS_TITLE = 'You Are Not Alone';
export const CRISIS_MESSAGE = 'It sounds like you may be going through something very hard. If you are thinking about suicide or hurting yourself, please reach out to one of the free, confidential lines below now. Talking to someone can help.';

function countryCode(c) {
  const v = String(c ?? '').trim().toUpperCase();
  if (['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(v)) return 'US';
  if (['IN', 'IND', 'INDIA'].includes(v)) return 'IN';
  return '';
}

// The person's country decides the list; both when it is not known.
export function crisisResources(country) {
  const c = countryCode(country);
  return c ? [CRISIS_RESOURCES[c]] : [CRISIS_RESOURCES.US, CRISIS_RESOURCES.IN];
}

// ── the card host ───────────────────────────────────────────────────────
// showCrisisSupport() asks the mounted <CrisisSupportHost> (App shell) to
// show the card and resolves once the person acknowledges it. With no host
// mounted (a test, a public page) it resolves at once, so a send is never
// held up by the safety layer itself.
let _host = null;
export function __setCrisisHost(fn) { _host = fn; }

export function showCrisisSupport(opts = {}) {
  if (!_host) return Promise.resolve();
  return new Promise((resolve) => _host({ ...opts, onDone: resolve }));
}

// The one call a send handler makes: when the text matches, show the card
// and wait for the acknowledgment; otherwise resolve at once. Resolves to
// whether the card was shown (callers do not need it to continue).
export async function crisisCheck(text, opts = {}) {
  if (!detectCrisis(text)) return false;
  await showCrisisSupport(opts);
  return true;
}
