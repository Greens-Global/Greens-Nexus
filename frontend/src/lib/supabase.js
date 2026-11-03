// The Supabase client: file storage and Realtime only.
//
// Nexus signs in with Microsoft (MSAL) and reads its data through the API, so
// it uses two parts of Supabase - `supabase.storage` (uploads, public URLs)
// and `supabase.channel` / `supabase.removeChannel` (Realtime pings). It used
// to build them through supabase-js's createClient, which also constructs the
// Supabase Auth client (GoTrue), the database (PostgREST) and Functions
// clients - about 100 KB on first paint that Nexus never called (11/03/2026,
// bundle headroom). This builds the same two clients the same way
// createClient does (@supabase/supabase-js 2.107, SupabaseClient's
// constructor): the same URLs, the same headers, `apikey` and a Bearer anon
// key on every request (no one signs in to Supabase Auth, so createClient's
// token was always the anon key), and the same Realtime options.
//
// Need another part of Supabase? Add it here the same way (or bring
// createClient back) - never a second client.
import { RealtimeClient } from '@supabase/realtime-js';
import { StorageClient } from '@supabase/storage-js';

const url  = import.meta.env.VITE_SUPABASE_URL  ?? '';
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// What supabase-js 2.107.0 sent from a browser, kept so requests look the same.
const HEADERS = { 'X-Client-Info': 'supabase-js/2.107.0; runtime=web' };

export function createNexusSupabase(supabaseUrl, supabaseKey) {
  const trimmed = supabaseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.');
  const base = new URL(trimmed.endsWith('/') ? trimmed : trimmed + '/');

  // supabase-js's fetchWithAuth: add the key unless the caller set its own.
  const authedFetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('apikey')) headers.set('apikey', supabaseKey);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${supabaseKey}`);
    return fetch(input, { ...init, headers });
  };

  const realtimeUrl = new URL('realtime/v1', base);
  realtimeUrl.protocol = realtimeUrl.protocol.replace('http', 'ws');
  const realtime = new RealtimeClient(realtimeUrl.href, {
    headers: HEADERS,
    accessToken: async () => supabaseKey,
    fetch: authedFetch,
    params: { apikey: supabaseKey },
  });
  const storage = new StorageClient(new URL('storage/v1', base).href, HEADERS, authedFetch);

  return {
    storage,
    realtime,
    channel: (name, opts = { config: {} }) => realtime.channel(name, opts),
    getChannels: () => realtime.getChannels(),
    removeChannel: (channel) => realtime.removeChannel(channel),
    removeAllChannels: () => realtime.removeAllChannels(),
  };
}

// Client is null if env vars not set - contexts fall back to polling
export const supabase = url && key ? createNexusSupabase(url, key) : null;

// For upload paths that need XHR progress events - supabase-js exposes no
// onUploadProgress, so those talk to the storage REST endpoint directly.
export const supabaseUrl = url;
export const supabaseAnonKey = key;
