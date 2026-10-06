// Ticket evidence upload - the PRIVATE ticket-evidence bucket (CLAUDE.md:
// evidence buckets are private; the stored URL is canonical and opened through
// /files/view). Shared by the ticket form, the drawer and the Property
// Walkthrough's per-line photos. Unique paths, cached immutably.
import { supabase } from '../lib/supabase';
import { toViewUrl } from '../lib/storageView';

export async function uploadTicketEvidence(file, prefix = 'file') {
  if (!supabase) throw new Error('Storage not configured');
  const ext = (file.name.split('.').pop() || 'dat').toLowerCase();
  const path = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { data, error } = await supabase.storage.from('ticket-evidence')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Upload failed');
  return toViewUrl(supabase.storage.from('ticket-evidence').getPublicUrl(data.path).data.publicUrl);
}
