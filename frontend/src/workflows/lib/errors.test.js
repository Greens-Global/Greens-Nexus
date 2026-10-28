import { describe, it, expect } from 'vitest';
import { errorProblems, errorText } from './errors';

// The one way a refused call is worded on a Workflows screen (Oct 28
// 2026, lib/errors.js). api.js puts the parsed FastAPI `detail` on err.detail; a workflow
// 422 carries {problems: [...]}; a bare "API error 422" or a network
// failure never reaches the screen.

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

describe('workflows errorText', () => {
  it('names the problems a 422 carries', () => {
    const e = err('API error 422', { status: 422, detail: { problems: [{ message: 'Step 1: To is required', path: 'steps.0.params.to' }] } });
    expect(errorProblems(e)).toEqual([{ message: 'Step 1: To is required', path: 'steps.0.params.to' }]);
    expect(errorText(e)).toBe('Step 1: To is required');
    const two = err('API error 422', { status: 422, detail: { problems: [{ message: 'Step 1: To is required' }, { message: 'Step 2: Title is required' }] } });
    expect(errorText(two)).toBe('Step 1: To is required (and 1 more)');
  });

  it('still reads the older places problems were put', () => {
    expect(errorText(err('x', { problems: [{ message: 'From problems' }] }))).toBe('From problems');
    expect(errorText(err('x', { body: { problems: [{ message: 'From body' }] } }))).toBe('From body');
    expect(errorProblems(err('x', { detail: { problems: 'nope' } }))).toEqual([]);
    expect(errorProblems(null)).toEqual([]);
  });

  it('uses the server\'s sentence and never a bare status code', () => {
    expect(errorText(err('API error 409', { status: 409, detail: 'Only a failed run can be replayed' }))).toBe('Only a failed run can be replayed');
    expect(errorText(err('Only a manager may change this rule', { status: 403, detail: 'Only a manager may change this rule' }))).toBe('Only a manager may change this rule');
    expect(errorText(err('API error 422', { status: 422, detail: { message: 'A structured message' } }))).toBe('A structured message');
    expect(errorText(err('API error 500', { status: 500, detail: null }), 'Try again.')).toBe('Try again.');
    expect(errorText(err('Failed to fetch'), 'Try again.')).toBe('Try again.');
    expect(errorText(err('API error 422', { detail: { code: 'x' } }), 'Try again.')).toBe('Try again.');
    expect(errorText(undefined)).toBe('That did not go through - please try again.');
  });
});
