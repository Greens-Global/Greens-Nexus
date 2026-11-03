import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNexusSupabase } from './supabase';

// The client must send what supabase-js's createClient sent (checked against
// 2.107.0 on 11/03/2026): the apikey and a Bearer anon key on every storage
// request, and the same Realtime endpoint, params and token.
const URL_ = 'https://proj.supabase.co';
const KEY = 'anon-key';

afterEach(() => vi.unstubAllGlobals());

describe('createNexusSupabase', () => {
  it('builds public URLs and signs storage requests with the anon key', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ Key: 'task-files/a/b.png', Id: '1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const sb = createNexusSupabase(URL_, KEY);
    expect(sb.storage.from('task-files').getPublicUrl('a/b.png').data.publicUrl)
      .toBe('https://proj.supabase.co/storage/v1/object/public/task-files/a/b.png');
    const { error } = await sb.storage.from('task-files').upload('a/b.png', new Blob(['x'], { type: 'image/png' }), { contentType: 'image/png' });
    expect(error).toBeNull();
    expect(calls[0].url).toBe('https://proj.supabase.co/storage/v1/object/task-files/a/b.png');
    expect(calls[0].headers.get('apikey')).toBe(KEY);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers.get('x-client-info')).toBe('supabase-js/2.107.0; runtime=web');
  });

  it('points Realtime at the project with the anon key', async () => {
    const sb = createNexusSupabase(URL_, KEY);
    expect(sb.realtime.endpointURL()).toMatch(/^wss:\/\/proj\.supabase\.co\/realtime\/v1\/websocket\?apikey=anon-key/);
    expect(await sb.realtime.accessToken()).toBe(KEY);
    const ch = sb.channel('pings');
    expect(ch.topic).toBe('realtime:pings');
    expect(sb.getChannels()).toContain(ch);
    await sb.removeChannel(ch);
    expect(sb.getChannels()).not.toContain(ch);
  });

  it('refuses a URL that is not http(s), as createClient did', () => {
    expect(() => createNexusSupabase('proj.supabase.co', KEY)).toThrow(/Invalid supabaseUrl/);
  });
});

// Parity with the real thing: @supabase/supabase-js is a devDependency at the
// same exact version as storage-js and realtime-js (package.json), never
// shipped, kept so this test can build both clients side by side.
describe('createNexusSupabase matches supabase-js createClient', () => {
  const realtimeFacts = async (rt) => {
    const before = rt.accessTokenValue;
    await rt.setAuth();
    return {
      endpointURL: rt.endpointURL(), params: rt.params, headers: rt.headers, vsn: rt.vsn,
      heartbeatIntervalMs: rt.heartbeatIntervalMs, timeout: rt.timeout,
      accessTokenBefore: before, accessTokenValue: rt.accessTokenValue,
    };
  };
  const storageFacts = async (storage) => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const headers = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      calls.push({ url: String(input), method: init?.method, headers });
      return new Response(JSON.stringify({ Key: 'task-files/a/b.png', Id: '1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await storage.from('task-files').upload('a/b.png', new Blob(['x'], { type: 'image/png' }), { cacheControl: '31536000', contentType: 'image/png' });
    await storage.from('task-files').uploadToSignedUrl('a/c.png', 'tok', new Blob(['y']), { contentType: 'image/png' });
    vi.unstubAllGlobals();
    return {
      url: storage.url, headers: storage.headers,
      publicUrl: storage.from('task-files').getPublicUrl('a/b c.png').data.publicUrl,
      calls,
    };
  };

  it('sends the same storage requests and uses the same Realtime settings', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    // The auth options only stop GoTrue's timers and storage in the test; with
    // no one signed in its token is the anon key either way.
    const real = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const ours = createNexusSupabase(URL_, KEY);
    const rtOurs = await realtimeFacts(ours.realtime);
    expect(rtOurs.accessTokenValue).toBe(KEY);
    expect(rtOurs).toEqual(await realtimeFacts(real.realtime));
    const stOurs = await storageFacts(ours.storage);
    expect(stOurs.calls).toHaveLength(2);
    expect(stOurs).toEqual(await storageFacts(real.storage));
    const a = ours.channel('pings');
    const b = real.channel('pings');
    expect([a.topic, a.params]).toEqual([b.topic, b.params]);
  });
});
