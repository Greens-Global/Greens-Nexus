import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Monogram, deptColor, DEPT_COLORS } from './vaultCards';


describe('the login tile', () => {
  it('makes a two-letter monogram', () => {
    const { container } = render(<><Monogram name="Stripe Dashboard" dept="Accounting" depts={['Accounting']} /><Monogram name="Jira" dept="IT" depts={['IT']} /><Monogram name="" dept="" depts={[]} /></>);
    expect([...container.querySelectorAll('.cv-mono-tile')].map((t) => t.textContent)).toEqual(['SD', 'JI', '?']);
    expect(deptColor('IT', ['Accounting', 'IT'])).toBe(DEPT_COLORS[1]);
    expect(deptColor('Unknown', ['Accounting'])).toBe(DEPT_COLORS[0]);     // never undefined
  });
});
