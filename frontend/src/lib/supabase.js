import { createClient } from '@supabase/supabase-js';

const url  = import.meta.env.VITE_SUPABASE_URL  ?? '';
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// Client is null if env vars not set - contexts fall back to polling
export const supabase = url && key ? createClient(url, key) : null;

// For upload paths that need XHR progress events - supabase-js exposes no
// onUploadProgress, so those talk to the storage REST endpoint directly.
export const supabaseUrl = url;
export const supabaseAnonKey = key;
