import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { changedValues, fieldError, formatFieldValue, matchesFieldFilter } from '../lib/employeeCustomFields';

// More Details (Oct 27 2026): HR's custom fields on employee records. The
// server filters and validates; the screens read values the US way, name a
// bad value before saving, and send only what changed.

const myHrCustomFields = vi.fn();
const myHrCustomFieldsSave = vi.fn();
const hrEmployeeCustomFields = vi.fn();
const hrEmployeeCustomFieldsSave = vi.fn();
vi.mock('../api', () => ({
  api: {
    myHrCustomFields: (...a) => myHrCustomFields(...a),
    myHrCustomFieldsSave: (...a) => myHrCustomFieldsSave(...a),
    hrEmployeeCustomFields: (...a) => hrEmployeeCustomFields(...a),
    hrEmployeeCustomFieldsSave: (...a) => hrEmployeeCustomFieldsSave(...a),
  },
}));

const { MyMoreDetails, EmployeeMoreDetails } = await import('./EmployeeCustomFields');

const SHIRT = { fieldKey: 'shirt', label: 'Shirt Size', fieldType: 'dropdown', options: ['S', 'M', 'L'], visibility: 'employee_edit', editable: true, required: false };
const BADGE = { fieldKey: 'badge', label: 'Badge Number', fieldType: 'text', options: [], visibility: 'employee_view', editable: false, required: false };

beforeEach(() => {
  myHrCustomFields.mockReset();
  myHrCustomFieldsSave.mockReset();
  hrEmployeeCustomFields.mockReset();
  hrEmployeeCustomFieldsSave.mockReset();
});

describe('employee custom field helpers', () => {
  it('reads values the US way', () => {
    expect(formatFieldValue({ fieldType: 'date' }, '2026-10-27')).toBe('10/27/2026');
    expect(formatFieldValue({ fieldType: 'checkbox' }, true)).toBe('Yes');
    expect(formatFieldValue({ fieldType: 'checkbox' }, false)).toBe('No');
    expect(formatFieldValue({ fieldType: 'number' }, 1200)).toBe('1,200');
    expect(formatFieldValue({ fieldType: 'text' }, '')).toBe('');
  });

  it('names a value that does not fit its type', () => {
    expect(fieldError({ label: 'Locker', fieldType: 'number' }, 'abc')).toMatch(/number/);
    expect(fieldError({ label: 'Locker', fieldType: 'number' }, '1,200')).toBe('');
    expect(fieldError({ label: 'Expiry', fieldType: 'date' }, '10/27/2026')).toMatch(/date/);
    expect(fieldError(SHIRT, 'XL')).toMatch(/options/);
    expect(fieldError(SHIRT, 'm')).toBe('');
    expect(fieldError({ label: 'Cost Center', fieldType: 'text', required: true }, ' ')).toMatch(/required/);
  });

  it('sends only editable fields that changed', () => {
    const out = changedValues([SHIRT, BADGE], { shirt: 'M', badge: 'B-1' }, { shirt: 'L', badge: 'B-2' });
    expect(out).toEqual({ shirt: 'L' });
  });

  it('filters the People list by a field', () => {
    expect(matchesFieldFilter(SHIRT, 'M', '')).toBe(true);
    expect(matchesFieldFilter(SHIRT, 'M', 'm')).toBe(true);
    expect(matchesFieldFilter(SHIRT, 'M', 'L')).toBe(false);
    expect(matchesFieldFilter(SHIRT, undefined, '__empty')).toBe(true);
    expect(matchesFieldFilter({ fieldType: 'checkbox' }, true, 'yes')).toBe(true);
    expect(matchesFieldFilter({ fieldType: 'checkbox' }, undefined, 'no')).toBe(true);
    expect(matchesFieldFilter(BADGE, 'B-77', 'b-7')).toBe(true);
  });
});

describe('More Details', () => {
  it('renders nothing in My HR until HR shares a field', async () => {
    myHrCustomFields.mockResolvedValue({ fields: [], values: {}, canEdit: false });
    const { container } = render(<MyMoreDetails />);
    await waitFor(() => expect(myHrCustomFields).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('lets the employee change an Employee Can Edit field and sends just that', async () => {
    myHrCustomFields.mockResolvedValue({ fields: [SHIRT, BADGE], values: { shirt: 'M', badge: 'B-77' }, canEdit: true });
    myHrCustomFieldsSave.mockResolvedValue({ fields: [SHIRT, BADGE], values: { shirt: 'L', badge: 'B-77' }, canEdit: true });
    render(<MyMoreDetails />);
    expect(await screen.findByText('B-77')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Shirt Size'), { target: { value: 'L' } });
    expect(screen.getByText('(HR changes this)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(myHrCustomFieldsSave).toHaveBeenCalledWith({ shirt: 'L' }));
    expect(await screen.findByText('L')).toBeTruthy();
  });

  it('shows a manager the fields read only', async () => {
    hrEmployeeCustomFields.mockResolvedValue({ fields: [{ ...BADGE }], values: { badge: 'B-77' }, canEdit: false });
    render(<EmployeeMoreDetails employee={{ id: 'e1', firstName: 'Erin' }} readOnly />);
    expect(await screen.findByText('B-77')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });
});
