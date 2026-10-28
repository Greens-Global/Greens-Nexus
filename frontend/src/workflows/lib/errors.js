// How a refused call is worded on a Workflows screen (Oct 28 2026). api.js
// puts the parsed FastAPI `detail` on err.detail (err.status is the code,
// err.message the flattened text, "API error 422" when the detail is an
// object); the workflow routes answer a 422 with
// {"detail": {"problems": [{message, path}, ...]}}.
import { problemsSummary } from './definition';

/** The definition problems a 422 carries. Older callers may find them on
 *  err.problems or err.body.problems; an empty list otherwise. */
export function errorProblems(err) {
  const list = err?.detail?.problems ?? err?.problems ?? err?.body?.problems;
  return Array.isArray(list) ? list.filter((p) => p && typeof p.message === 'string') : [];
}

/** Inline error for a failed action (a refused Pause, a Replay that 409s,
 *  a Publish the server found problems in). A bare "API error 422" or a
 *  network failure never reaches the screen - the fallback does. */
export function errorText(err, fallback = 'That did not go through - please try again.') {
  const problems = errorProblems(err);
  if (problems.length) return problemsSummary(problems);
  const d = err?.detail ?? err?.message;
  if (typeof d === 'string' && d && !/^API error|^Failed to fetch|^NetworkError/i.test(d)) return d;
  if (d && typeof d === 'object') {
    if (typeof d.detail === 'string' && d.detail) return d.detail;
    if (typeof d.message === 'string' && d.message) return d.message;
  }
  const m = err?.message;
  if (typeof m === 'string' && m && !/^API error|^Failed to fetch|^NetworkError|^\[object/i.test(m)) return m;
  return fallback;
}
