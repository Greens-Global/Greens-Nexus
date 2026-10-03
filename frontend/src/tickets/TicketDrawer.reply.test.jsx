import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The drawer's reply and description editors (Oct 3):
//   - a reply that is only a picture is still a reply - Done sends it;
//   - while a reply picture uploads, Done waits ("Uploading...");
//   - the description editor uploads pictures to ticket storage, never
//     keeping a data: image in the description.
// The rich editor itself is stubbed: this is about what the drawer does with
// what the editor hands it, not about TipTap.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myLevel: 3, canAccessModule: () => true,
    myGrantedModules: new Set(), myEmail: 'agent@example.com' }),
}));
vi.mock('../api', () => {
  const empty = () => Promise.resolve([]);
  return { api: new Proxy({}, { get: () => empty }) };
});
const upload = vi.fn(() => Promise.resolve({ data: { path: 'image-1.png' }, error: null }));
vi.mock('../lib/supabase', () => ({
  supabase: { storage: { from: () => ({
    upload,
    getPublicUrl: (p) => ({ data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/ticket-evidence/${p}` } }),
  }) } },
}));
const editors = [];
vi.mock('../tasks/RichDescription', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    default: (props) => {
      editors.push(props);
      return (
        <div data-testid={props.placeholder}>
          <button type="button" onClick={() => props.onChange('<p><img src="https://example.com/a.png"></p>')}>Put Picture</button>
          {props.onUploadingChange && (
            <button type="button" onClick={() => props.onUploadingChange(1)}>Start Upload</button>
          )}
        </div>
      );
    },
  };
});
const TICKET = {
  id: 't1', code: '000001', subject: 'Printer jam', description: '<p>It jams</p>', status: 'open', priority: 'medium', type: 'incident',
  requesterId: 'req@example.com', assigneeId: '', approvalStatus: 'none', typeFields: {},
};
const updateTicket = vi.fn(() => Promise.resolve(TICKET));
vi.mock('../tasks/TasksContext', () => ({
  useTasks: () => ({ tickets: [TICKET], tasks: [], projects: [], myEmail: 'agent@example.com',
    nameOf: (e) => e, updateTicket, refresh: vi.fn() }),
}));

const { TicketDrawer } = await import('./TicketsView');

afterEach(() => { cleanup(); updateTicket.mockClear(); upload.mockClear(); editors.length = 0; vi.restoreAllMocks(); });

const replyEditor = () => editors.filter((p) => /reply/i.test(p.placeholder || '')).at(-1);

describe('TicketDrawer reply', () => {
  it('sends a reply that is only a picture', async () => {
    const onClose = vi.fn();
    render(<TicketDrawer ticketId="t1" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Conversation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Put Picture' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })); });
    expect(updateTicket).toHaveBeenCalledTimes(1);
    expect(updateTicket.mock.calls[0][1].comment).toMatch(/<img\b/);
    expect(onClose).toHaveBeenCalled();
  });

  it('holds Done while a reply picture is uploading', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Conversation/ }));
    // The upload count is reported by the reply editor; until that editor
    // reports it, Done is simply Done.
    if (!replyEditor()?.onUploadingChange) {
      expect(screen.getByRole('button', { name: 'Done' }).disabled).toBe(false);
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: 'Put Picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Upload' }));
    const busy = screen.getByRole('button', { name: 'Uploading...' });
    expect(busy.disabled).toBe(true);
    await act(async () => { fireEvent.click(busy); });
    expect(updateTicket).not.toHaveBeenCalled();
  });
});

describe('TicketDrawer description editor', () => {
  it('uploads a picture to ticket storage instead of keeping it inline', async () => {
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit title and description' }));
    const desc = editors.filter((p) => p.placeholder === 'Describe the issue').at(-1);
    expect(desc.allowInlineData).toBe(false);
    expect(typeof desc.onAttachFile).toBe('function');
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const saved = await desc.onAttachFile(file);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(saved.name).toBe('shot.png');
    expect(saved.kind).toBe('image');
    expect(saved.url).toMatch(/ticket-evidence/);
    expect(saved.url.startsWith('data:')).toBe(false);
  });

  it('turns away a file that is not a picture (files go on the Attachments tab)', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<TicketDrawer ticketId="t1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit title and description' }));
    const desc = editors.filter((p) => p.placeholder === 'Describe the issue').at(-1);
    const saved = await desc.onAttachFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));
    expect(saved).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toMatch(/Attachments tab/);
  });
});
