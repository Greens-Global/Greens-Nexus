// Ticket evidence upload - the PRIVATE ticket-evidence bucket (CLAUDE.md:
// evidence buckets are private; the stored URL is canonical and opened through
// /files/view). Shared by the ticket form, the drawer and the Property
// Walkthrough's per-line photos. Unique paths, cached immutably.
import { supabase } from '../lib/supabase';
import { toViewUrl } from '../lib/storageView';
import { checkMedia, mediaKind, withType } from '../lib/voice';

export async function uploadTicketEvidence(input, prefix = 'file') {
  if (!supabase) throw new Error('Storage not configured');
  // A voice note keeps the voice note limit (lib/voice.js). Videos are left
  // to their callers: a long screen recording is fine here, and a clip picked
  // on a phone is checked where it is picked (CreateTicketModal).
  if (mediaKind(input) === 'audio') { const bad = checkMedia(input); if (bad) throw new Error(bad); }
  const file = withType(input);
  const ext = (file.name.split('.').pop() || 'dat').toLowerCase();
  const path = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { data, error } = await supabase.storage.from('ticket-evidence')
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
  if (error || !data) throw new Error(error?.message || 'Upload failed');
  return toViewUrl(supabase.storage.from('ticket-evidence').getPublicUrl(data.path).data.publicUrl);
}
