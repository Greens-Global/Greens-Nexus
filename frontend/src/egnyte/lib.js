// Egnyte module - shared helpers.
//
// Egnyte is the source of truth. Nexus lists, reads, writes and links; it never
// keeps a second copy and never re-uploads content into Supabase. Every helper
// here therefore deals in Egnyte paths and Egnyte web links, never in local
// storage of file bytes.
//
// All server calls go through frontend/src/api.js (api.egnyte*). Note the older
// api.egnyteBrowse / api.egnyteFetchFile pair hits /documents/egnyte/* and is
// the DMS importer's extension-filtered view - do not point one at the other.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate as usFormatDate } from '../lib/datetime';

// ── connection state ─────────────────────────────────────────────────────────

// /egnyte/status answers 200 even when Egnyte is unconfigured - it exists so the
// UI can decide what to render instead of discovering the 503 through a failed
// browse. Unconfigured is a first-class, explained state, not an error banner.
export function useEgnyteStatus() {
  const [state, setState] = useState({ loading: true, configured: false, error: '' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api.egnyteStatus()
      .then(r => alive && setState({ loading: false, configured: !!r?.configured, error: '' }))
      .catch(err => alive && setState({ loading: false, configured: false, error: egnyteErrorMessage(err, 'Could not reach the Egnyte service.') }));
    return () => { alive = false; };
  }, [attempt]);

  const recheck = useCallback(() => {
    setState({ loading: true, configured: false, error: '' });
    setAttempt(a => a + 1);
  }, []);

  return { ...state, recheck };
}

// ── paths ────────────────────────────────────────────────────────────────────

// Egnyte paths are absolute and slash-prefixed; the backend normalizes too, but
// keeping the UI's idea of "the current folder" canonical stops the breadcrumb
// from producing '//Shared' style keys that never match a cached web URL.
export function normPath(path) {
  const p = (path || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  const trimmed = p.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

export function crumbsFor(path) {
  const segs = normPath(path).split('/').filter(Boolean);
  return segs.map((name, i) => ({ name, path: `/${segs.slice(0, i + 1).join('/')}` }));
}

export function parentOf(path) {
  const segs = normPath(path).split('/').filter(Boolean);
  segs.pop();
  return segs.length ? `/${segs.join('/')}` : '';
}

// ── formatting ───────────────────────────────────────────────────────────────

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Egnyte hands back RFC-1123 strings ("Tue, 21 Jul 2026 09:12:44 GMT") on some
// endpoints and ISO on others, so parse defensively and show nothing rather
// than "Invalid Date" when it is neither.
export function formatWhen(value) {
  // US MM/DD/YYYY, empty string on empty/invalid. Delegates to the canonical
  // formatter; its loose parser still handles the RFC-1123 strings Egnyte sends.
  return usFormatDate(value, '');
}

// ── errors ───────────────────────────────────────────────────────────────────

// One place that turns an api.js error into copy a person can act on. 503 means
// the API key does not exist yet, which is a configuration state and not a
// fault; 403 means the signed-in user may read but not write here.
export function egnyteErrorMessage(err, fallback = 'Something went wrong while talking to Egnyte.') {
  const status = err?.status;
  if (status === 503) return 'Egnyte is not connected yet. An administrator needs to add the Egnyte domain and API token.';
  if (status === 403) return 'You do not have permission for that. Uploading and creating folders needs supervisor access.';
  // A 401 out of /egnyte/* is Egnyte rejecting the stored SERVICE token, not the
  // viewer's Nexus session - api.js already retries a genuine Nexus 401 once
  // with a refreshed token before it ever reaches here. Telling the user to sign
  // in again would send them to fix the one thing that is not broken.
  if (status === 401) return 'Egnyte rejected the connection. The stored API token is invalid or has expired, so an administrator needs to refresh it.';
  if (status === 404) return 'That folder no longer exists in Egnyte.';
  if (status === 413) return 'That file is too large to upload through Nexus. Upload it in Egnyte directly.';
  return err?.message || fallback;
}

export const isNotConnected = (err) => err?.status === 503;

// ── clipboard ────────────────────────────────────────────────────────────────

// Ctrl+V support (CLAUDE.md: every upload widget takes a clipboard paste).
// Deliberately wider than imageFromPaste in InventoryManagement.jsx: this
// surface accepts any file type, because an Egnyte folder holds PDFs, plans and
// spreadsheets, not only photos. A pasted screenshot arrives with no filename,
// so give it one.
export function filesFromPaste(e) {
  const out = [];
  for (const item of e.clipboardData?.items || []) {
    if (item.kind !== 'file') continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    out.push(blob.name
      ? blob
      : new File([blob], `paste-${Date.now()}.${(blob.type.split('/')[1] || 'png')}`, { type: blob.type || 'application/octet-stream' }));
  }
  return out;
}

// ── preview ──────────────────────────────────────────────────────────────────

// MIRRORS the server allowlist in routers/egnyte.py - it decides which viewer to
// offer, the server decides what it will actually serve inline. Keep the two in
// step, and note the client copy is a convenience, never the security boundary:
// a file the server will not serve inline simply falls back to downloading.
//
// HTML and SVG are absent deliberately. Previews render through a blob: URL,
// which inherits the APP's origin, so either one would run as first-party
// script - stored XSS by way of an Egnyte upload.
const PREVIEW_BY_EXT = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  txt: 'text', log: 'text', csv: 'text', md: 'text', markdown: 'text',
};

// Text is read into memory to render, so cap it. Past this a file is a download,
// not something anyone is reading in a modal.
export const MAX_TEXT_PREVIEW_BYTES = 400 * 1024;

export function previewKindFor(name = '') {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return PREVIEW_BY_EXT[ext] || null;
}

export const canPreview = (file) => !!previewKindFor(file?.name);

// Egnyte shortcuts are pointers, not documents - previewing one shows bytes that
// mean nothing. They open in Egnyte instead.
export const isShortcut = (name = '') => name.toLowerCase().endsWith('.egnyte_d');

export async function fetchEgnytePreview(path) {
  const { blob } = await api.egnyteFilePreview(path);
  return blob;
}

// ── download ─────────────────────────────────────────────────────────────────

// Pull the bytes through the API (the browser cannot call Egnyte directly - the
// token lives on the server) and hand them to the browser as a normal download.
export async function downloadEgnyteFile(path, name) {
  const { blob, filename } = await api.egnyteFile(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick - revoking synchronously cancels the download in
  // Safari before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
