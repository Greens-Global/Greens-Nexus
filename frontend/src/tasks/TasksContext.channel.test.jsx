// Hotfix 11/05/2026: on the Tasks or Tickets screen (App mounts a
// TasksProvider) the header's + > New Task mounts a second one. Realtime hands
// back the already-subscribed channel for a reused topic and `.on()` then
// throws "cannot add postgres_changes callbacks ... after subscribe()" - the
// header's boundary showed "The header hit a snag." Each provider needs its
// own channel. Uses the real Realtime client (no server needed: subscribe()
// moves the channel to "joining" at once, which is when `.on()` refuses).
import { it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Component } from 'react';

vi.mock('../lib/supabase', async (orig) => {
  const m = await orig();
  return { ...m, supabase: m.createNexusSupabase('http://localhost:54321', 'anon-key') };
});
vi.mock('../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve([]) }) }));
vi.mock('../contexts/RoleContext', async (orig) => ({
  ...(await orig()),
  useRole: () => ({ myRole: 'employee', myEmail: 'pat@greensglobal.com', isExternal: false, actingAs: null,
    can: () => false, canAccessModule: () => true, myGrantedModules: new Map([['tasks', 'editor']]) }),
}));

const { TasksProvider } = await import('./TasksContext');
const { supabase } = await import('../lib/supabase');

class Catch extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? <p role="alert">{String(this.state.error.message)}</p> : this.props.children; }
}

afterEach(() => { cleanup(); supabase.removeAllChannels(); });

it('a second TasksProvider (header New Task over the Tasks view) does not crash', async () => {
  let view;
  await act(async () => {
    view = render(
      <Catch>
        <TasksProvider><div>Tasks view</div></TasksProvider>
        <TasksProvider><div>New Task</div></TasksProvider>
      </Catch>,
    );
  });
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.getByText('New Task')).toBeTruthy();
});
