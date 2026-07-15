// Post Playwright verdicts back into the dev Testing module (/qa/ci-results) so
// automated runs appear in the same Run-tests screen as human ones. Case ids are
// carried in the test titles: "[<caseId>] <title>". Skips when secrets are absent.
import { readFileSync } from 'node:fs';

const API = process.env.NEXUS_DEV_API_URL || '';
const TOKEN = process.env.NEXUS_QA_CI_TOKEN || '';
if (!API || !TOKEN) { console.log('[report] secrets not set — skipping result upload.'); process.exit(0); }

let report;
try { report = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf-8')); }
catch { console.log('[report] no results.json — nothing to upload.'); process.exit(0); }

const results = [];
const walk = suite => {
  for (const child of suite.suites || []) walk(child);
  for (const spec of suite.specs || []) {
    const m = spec.title.match(/^\[([0-9a-f-]{36})\]/i);
    if (!m) continue;   // committed smoke specs carry no case id
    const outcomes = (spec.tests || []).flatMap(t => (t.results || []).map(r => r.status));
    const passed = spec.ok || outcomes.includes('passed');
    results.push({
      case_id: m[1],
      result: passed ? 'pass' : 'fail',
      notes: passed ? 'Playwright: passed' : `Playwright: ${outcomes.join(', ') || 'failed'}`,
    });
  }
};
for (const suite of report.suites || []) walk(suite);

if (!results.length) { console.log('[report] no case-linked results.'); process.exit(0); }
const res = await fetch(`${API}/qa/ci-results`, {
  method: 'POST',
  headers: { 'X-QA-CI-Token': TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ results }),
});
console.log(`[report] uploaded ${results.length} result(s) → ${res.status}`);
