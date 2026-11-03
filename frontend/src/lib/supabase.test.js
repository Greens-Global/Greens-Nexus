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
