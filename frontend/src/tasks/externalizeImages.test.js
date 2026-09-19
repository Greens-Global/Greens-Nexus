import { describe, it, expect, vi } from 'vitest';
import { externalizeInlineImages, dataUrlToFile } from './lib';

// Pictures pasted into the Create Task description are held inline (data:
// URLs) until the task exists; after create they are uploaded as attachments
// and the description is re-pointed at the stored files.

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

describe('externalizeInlineImages', () => {
  it('uploads each inline image once and swaps its src for the stored URL', async () => {
    const html = `<p>a</p><img src="${PNG}" style="max-width:100%"><p>b</p><img src="${JPG}"><img src="${PNG}">`;
    const upload = vi.fn(async (f) => ({ url: `https://store/${f.name}` }));
    const out = await externalizeInlineImages(html, upload);
    expect(upload).toHaveBeenCalledTimes(2);               // the repeated PNG is uploaded once
    expect(upload.mock.calls.map(([f]) => f.name)).toEqual(['pasted-image-1.png', 'pasted-image-2.jpg']);
    expect(out).not.toContain('data:image');
    expect(out).toBe('<p>a</p><img src="https://store/pasted-image-1.png" style="max-width:100%"><p>b</p>'
      + '<img src="https://store/pasted-image-2.jpg"><img src="https://store/pasted-image-1.png">');
  });

  it('keeps the inline image when the upload fails or comes back inline', async () => {
    const html = `<img src="${PNG}"><img src="${JPG}">`;
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ url: JPG });
    expect(await externalizeInlineImages(html, upload)).toBe(html);
  });

  it('leaves a description without inline images untouched and uploads nothing', async () => {
    const upload = vi.fn();
    const html = '<p>hi</p><img src="https://store/x.png">';
    expect(await externalizeInlineImages(html, upload)).toBe(html);
    expect(await externalizeInlineImages('', upload)).toBe('');
    expect(upload).not.toHaveBeenCalled();
  });

  it('decodes a data URL into a typed File of the right size', () => {
    const f = dataUrlToFile(PNG, 'x.png');
    expect(f.name).toBe('x.png');
    expect(f.type).toBe('image/png');
    expect(f.size).toBe(atob('iVBORw0KGgoAAAANSUhEUg==').length);
    expect(dataUrlToFile('not a data url', 'y.png')).toBeNull();
  });
});
