import { describe, it, expect } from 'vitest';
import { mergeRows, rowFor, rowStatus, rowsInView, searchRows, sortRows, startView, templateStatus, templateUsable } from './documentLibrary';

describe('The one status word', () => {
  it.each([
    [{ status: 'draft' }, 'Draft'],
    [{ status: 'final' }, 'Final'],
    [{ status: 'archived', signStatus: 'completed' }, 'Archived'],
    [{ status: 'final', signStatus: 'pending', signers: 2, signed: 1 }, 'Out For Signature - 1 of 2'],
    [{ status: 'final', signStatus: 'pending' }, 'Out For Signature'],
    [{ status: 'final', signStatus: 'pending', myTurn: true }, 'Your Signature Needed'],
    [{ status: 'final', signStatus: 'completed' }, 'Signed'],
    [{ status: 'final', signStatus: 'declined' }, 'Declined'],
    [{ status: 'final', signStatus: 'voided' }, 'Voided'],
    [{ status: 'final', signStatus: 'expired' }, 'Expired'],
    [{ kind: 'hr', hrStatus: 'In Review' }, 'In Review'],
  ])('%j reads %s', (row, label) => { expect(rowStatus(row).label).toBe(label); });
});

describe('Who a row is for', () => {
  it('the person first, then whoever signs, a CC never', () => {
    expect(rowFor({ forName: 'Jordan Lee', parties: [{ name: 'Sam', role: 'signer' }] })).toBe('Jordan Lee');
    expect(rowFor({ parties: [{ name: 'Sam', role: 'signer' }, { name: 'Copy', role: 'cc' }] })).toBe('Sam');
    expect(rowFor({ parties: [{ name: 'A', role: 'signer' }, { name: 'B', role: 'signer' }, { name: 'C', role: 'witness' }] })).toBe('A, B +1');
    expect(rowFor({})).toBe('');
  });
});

describe('Merging HR Records', () => {
  const hr = { documentId: 'h1', title: 'Offer', person: 'Priya', status: 'Signed', signRequestId: 'r1', updatedAt: '2026-10-02' };
  it('a packet envelope someone is on shows once, as the HR row', () => {
    const lib = [{ id: 'sign:r1', kind: 'envelope', signRequestId: 'r1', updatedAt: '2026-10-03' }, { id: 'd1', kind: 'document', signRequestId: 'r2', updatedAt: '2026-10-01' }];
    expect(mergeRows(lib, [hr]).map((r) => r.id)).toEqual(['hr:h1', 'd1']);
  });
  it('keeps the envelope for anyone who cannot read HR Records', () => {
    expect(mergeRows([{ id: 'sign:r1', kind: 'envelope', signRequestId: 'r1' }], []).map((r) => r.id)).toEqual(['sign:r1']);
  });
});

describe('Views, search and sort', () => {
  const rows = [
    { id: 'a', title: 'Zed', status: 'draft', mine: true, folderId: 'f1', updatedAt: '2026-01-01' },
    { id: 'b', title: 'Abe', status: 'draft', mine: false, updatedAt: '2026-03-01' },
    { id: 'c', title: 'Mid', status: 'final', signStatus: 'pending', updatedAt: '2026-02-01', parties: [{ name: 'Harbor Supply', role: 'signer' }] },
    { id: 'd', title: 'Gone', status: 'archived', signStatus: 'completed', folderId: 'f1' },
  ];
  it('My Drafts is only your own, even for an administrator who can see all', () => {
    expect(rowsInView(rows, 'drafts').map((r) => r.id)).toEqual(['a']);
  });
  it('archived rows are only in Archived', () => {
    expect(rowsInView(rows, 'signed')).toEqual([]);
    expect(rowsInView(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rowsInView(rows, 'folder:f1').map((r) => r.id)).toEqual(['a']);
    expect(rowsInView(rows, 'archived').map((r) => r.id)).toEqual(['d']);
  });
  it('search reaches signers and folder names', () => {
    expect(searchRows(rows, 'harbor').map((r) => r.id)).toEqual(['c']);
    expect(searchRows(rows, 'board', [{ id: 'f1', name: 'Board Minutes' }]).map((r) => r.id)).toEqual(['a', 'd']);
    expect(searchRows(rows, '  ')).toHaveLength(4);
  });
  it('sorts by name and by date', () => {
    const three = rows.slice(0, 3);
    expect(sortRows(three, 'title', 'asc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(three, 'updatedAt', 'desc').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
  it('Documents opens on what waits on you', () => {
    expect(startView(rows)).toBe('all');
    expect(startView([{ myTurn: true }])).toBe('needs');
  });
});

describe('One Publish', () => {
  it('a template shows one status and is usable once published', () => {
    expect(templateStatus({ state: 'changes' }).label).toBe('Unpublished Changes');
    expect(templateStatus({ state: 'published' }).label).toBe('Published');
    expect(templateUsable({ state: 'changes' })).toBe(true);
    expect(templateUsable({ state: 'draft' })).toBe(false);
    expect(templateUsable({ state: 'archived' })).toBe(false);
  });
});
