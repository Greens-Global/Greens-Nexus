import { describe, it, expect } from 'vitest';
import { stackBoxes, importElements, importable, isPdfFile, placedWords, blobToDataURL, IMPORT_WIDTH, IMPORT_GAP } from './boardImport';

describe('boardImport', () => {
  it('takes pictures and PDFs only', () => {
    const files = [
      new File(['x'], 'a.png', { type: 'image/png' }),
      new File(['x'], 'plan.PDF', { type: '' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ];
    expect(importable(files).map((f) => f.name)).toEqual(['a.png', 'plan.PDF']);
    expect(isPdfFile(files[1])).toBe(true);
  });

  it('stacks pages top to bottom, scaled down to the import width, the first centered on the point', () => {
    const boxes = stackBoxes([{ width: 2000, height: 1000 }, { width: 500, height: 300 }], { x: 100, y: 0 });
    expect(boxes[0]).toEqual({ x: 100 - IMPORT_WIDTH / 2, y: -250, width: IMPORT_WIDTH, height: 500 });
    expect(boxes[1]).toEqual({ x: 100 - 250, y: 250 + IMPORT_GAP, width: 500, height: 300 });
    expect(stackBoxes([{ width: 0, height: 0 }])[0]).toMatchObject({ width: 800, height: 600 });   // a size we could not read
  });

  it('places locked images that remember the file and page', () => {
    const [a, b] = importElements([{ fileId: 'f1', width: 800, height: 600, name: 'plan.pdf', page: 1 }, { fileId: 'f2', width: 800, height: 600, name: 'plan.pdf', page: 2 }]);
    expect(a).toMatchObject({ type: 'image', fileId: 'f1', locked: true, customData: { nexusImport: { name: 'plan.pdf', page: 1 } } });
    expect(b.y).toBeGreaterThan(a.y + a.height);
  });

  it('says what was placed', () => {
    expect(placedWords(3, 0)).toBe('3 Pages');
    expect(placedWords(1, 1)).toBe('1 Page and 1 Picture');
    expect(placedWords(0, 2)).toBe('2 Pictures');
  });

  it('reads a file as a data URL', async () => {
    expect(await blobToDataURL(new Blob(['hi'], { type: 'text/plain' }))).toBe('data:text/plain;base64,aGk=');
  });
});
