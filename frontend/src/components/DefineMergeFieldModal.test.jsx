import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DefineMergeFieldModal from './DefineMergeFieldModal';

// Forms (Neil, 11/02/2026): a form field's Formula is written in the Tasks
// formula language, naming other fields by {Label} or {token} - the hint and
// the example say so, never the old field("token") spelling.
describe('DefineMergeFieldModal - form Formula', () => {
  it('shows the {Label} example and names the formula language', () => {
    render(<DefineMergeFieldModal form existingDef={null} siblings={[]} sections={[]} existingTokens={[]} onSave={() => {}} onCancel={() => {}} />);
    const box = screen.getByLabelText('Formula');
    expect(box.getAttribute('placeholder')).toBe('e.g. {Miles Out} - {Miles In}');
    expect(screen.getByText(/Name another field as \{Its Label\} or \{its_token\} - the Tasks formula language \(SUM, IF, ROUND, DAYS\.\.\.\)\./)).toBeTruthy();
    expect(screen.queryByText(/field\("token"\)/)).toBeNull();
  });
});
