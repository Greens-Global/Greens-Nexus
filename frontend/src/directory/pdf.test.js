import { describe, it, expect } from 'vitest';
import { directoryPdfBytes, ascii } from './pdf';

// The contact sheet actually RUNS pdf-lib: the failure it guards against is
// a character outside WinAnsi (an em dash in a title, an emoji in a name)
// throwing partway through and failing the whole export for one odd value.
const P = (email, name, dept, mgr = '', extra = {}) => ({
  email, name, firstName: name.split(' ')[0], lastName: name.split(' ')[1] || '', department: dept, managerEmail: mgr,
  managerName: '', departmentRole: '', jobTitle: 'Analyst', companyName: 'Greens Co', location: 'Escondido Office',
  city: 'Escondido', state: 'CA', mobile: '(760) 555-0101', officePhone: '', ...extra,
});

describe('directory PDF', () => {
  it('writes a multi-page contact sheet with the reporting outline and survives odd characters', async () => {
    const bo = P('bo@x', 'Bo Boss', 'Accounting', '', { departmentRole: 'lead', jobTitle: 'Controller — Finance 💼' });
    const people = [bo, P('sam@x', 'Sam “S” Staff', 'Accounting', 'bo@x', { managerName: 'Bo Boss' }), P('lee@x', 'Lee Leave', 'IT', 'bo@x', { managerName: 'Bo Boss', companyName: 'Other Co' }),
      P('solo@x', 'Sol Solo', '')];
    const bytes = await directoryPdfBytes({ people, companyName: 'Greens Global', scope: 'Office: Escondido', generatedAt: new Date('2026-10-10T17:30:00Z') });
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
    // Two pages: the sheet and the reporting-line outline.
    const { PDFDocument } = await import('pdf-lib');
    const back = await PDFDocument.load(bytes);
    expect(back.getPageCount()).toBe(2);
    expect(back.getTitle()).toBe('Contact Directory');
  });
  it('maps typography to ASCII and drops what Helvetica cannot draw', () => {
    expect(ascii('Controller — “Finance” 💼…')).toBe('Controller - "Finance" ...');
    expect(ascii('José Müller · Zoë')).toBe('José Müller · Zoë');      // Latin-1 is in WinAnsi: keep it
    expect(ascii('Łukasz Şahin 王')).toBe('ukasz Sahin ');             // accent dropped where it decomposes, else dropped
  });
});
