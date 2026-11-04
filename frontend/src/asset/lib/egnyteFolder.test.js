import { describe, it, expect } from 'vitest';
import { normalizeEgnyteFolder, egnyteFolderProblem, egnyteFolderOf } from './egnyteFolder.js';

// The screen's copy of the server's pinned-folder rule
// (services/egnyte.normalize_pinned_folder) - the tab must read what the server stores.
describe('egnyteFolder', () => {
  it('normalizes like the server', () => {
    expect(normalizeEgnyteFolder('Shared//--Asset Management/ GS Valley Center /')).toBe('/Shared/--Asset Management/GS Valley Center');
    expect(normalizeEgnyteFolder('\\Shared\\#Entities\\X')).toBe('/Shared/#Entities/X');
    expect(normalizeEgnyteFolder('   ')).toBe('');
    expect(normalizeEgnyteFolder('https://greens.egnyte.com/app/index.do#storage/files/1/Shared/%23Entities/Greens%20X')).toBe('/Shared/#Entities/Greens X');
    expect(egnyteFolderOf({ egnyteFolder: ' /a ' })).toBe('/a');
  });

  it('names what the server would refuse', () => {
    const roots = ['/Shared/#Entities', '/Shared/--Asset Management'];
    expect(egnyteFolderProblem('')).toBe('');
    expect(egnyteFolderProblem('/Shared/#Entities/Greens X', roots)).toBe('');
    expect(egnyteFolderProblem('/shared/#entities/Greens X', roots)).toBe('');
    expect(egnyteFolderProblem('/Shared/#Entities/../HR', roots)).toMatch(/'\.\.'/);
    expect(egnyteFolderProblem('/Shared/#Entities', roots)).toMatch(/must be inside/);
    expect(egnyteFolderProblem('/Private/x', roots)).toMatch(/must be inside/);
    expect(egnyteFolderProblem('/Private/x')).toBe('');   // roots not known yet - the server decides
    expect(egnyteFolderProblem('https://example.com/x')).toMatch(/Paste the folder's path/);
  });
});
