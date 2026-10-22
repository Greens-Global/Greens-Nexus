// Follow a project (Neil, Oct 22 2026) - the Follow / Following button in a
// project's header, the follower count beside it, and the Followers popup
// (who follows, Add Follower for owners and editors).
//
// A follower hears about new tasks, completed tasks and comments in the
// project, batched with the rest of their task email and grouped into one
// bell notice a day (backend task_project_follow.py). The server is the
// authority on who may follow and who may add others; this only hides what
// it would refuse.
import { useState } from 'react';
import { Bell, BellRing, UserPlus, X } from 'lucide-react';
import { useTasks } from './TasksContext';
import { useRole } from '../contexts/RoleContext';
import { Avatar, Modal, PersonSelect, usePeople } from './components';
import { canManageFollowers, isFollowing, projectFollowers } from './followRules';
import { NX, FONT, btn } from './theme';

export default function ProjectFollowControl({ project, compact = false }) {
  const { myEmail, nameOf, followProject, unfollowProject, offerUndo } = useTasks();
  const { canAccessModule } = useRole();
  const isManager = !!canAccessModule?.('tasks', 'manager', 'owner');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!project) return null;
  const me = String(myEmail || '').toLowerCase();
  const followers = projectFollowers(project);
  const following = isFollowing(project, me);
  const shown = followers.slice(0, 3);

  const toggle = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      if (following) {
        await unfollowProject(project.id);
        offerUndo?.(`Stopped following ${project.name}`, () => followProject(project.id).catch(() => {}));
      } else {
        await followProject(project.id);
        offerUndo?.(`Following ${project.name}`, () => unfollowProject(project.id).catch(() => {}));
      }
    } catch (e) {
      setErr(e?.message || 'Could not change following.');
      setOpen(true);
    } finally { setBusy(false); }
  };

  const label = following ? 'Following' : 'Follow';
  const hint = following
    ? 'Following - you hear about new tasks, completions and comments. Click to stop.'
    : 'Follow - hear about new tasks, completions and comments in this project';
  return (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {!project.archived && (
          <button type="button" onClick={toggle} disabled={busy} aria-pressed={following}
            aria-label={label} title={hint} data-testid="project-follow"
            style={{
              ...btn('outline'), padding: compact ? 6 : '6px 10px', fontSize: 12,
              color: following ? NX.primary : NX.dim, opacity: busy ? 0.6 : 1,
              ...(following ? { borderColor: NX.primary } : null),
            }}>
            {following ? <BellRing size={14} /> : <Bell size={14} />}{!compact && label}
          </button>
        )}
        <button type="button" onClick={() => { setErr(''); setOpen(true); }}
          title="Followers - who hears about this project" aria-label={`Followers: ${followers.length}`}
          data-testid="project-followers"
          style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: `1px solid ${NX.border}`,
            borderRadius: 20, padding: shown.length ? '3px 8px 3px 3px' : '4px 9px', cursor: 'pointer', fontFamily: FONT, minHeight: 28 }}>
          {!compact && shown.length > 0 && (
            <span style={{ display: 'flex', marginRight: 6 }}>
              {shown.map((em, i) => (
                <span key={em} style={{ marginLeft: i === 0 ? 0 : -8, display: 'flex', border: `2px solid ${NX.surface}`, borderRadius: '50%' }}>
                  <Avatar email={em} name={nameOf?.(em) || em} size={22} />
                </span>
              ))}
            </span>
          )}
          <span style={{ fontSize: 12.5, color: NX.dim, fontWeight: 600 }}>{followers.length}</span>
        </button>
      </span>
      {open && (
        <FollowersModal project={project} me={me} isManager={isManager} initialError={err}
          onClose={() => { setOpen(false); setErr(''); }} />
      )}
    </>
  );
}

export function FollowersModal({ project, me, isManager, onClose, initialError = '' }) {
  const { nameOf, addProjectFollower, removeProjectFollower, unfollowProject } = useTasks();
  const people = usePeople();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(initialError);
  const followers = projectFollowers(project);
  const manage = canManageFollowers(project, me, isManager);
  const nameFor = (em) => people.find((p) => p.email === em)?.name || nameOf?.(em) || em;

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e?.message || 'Could not save.'); } finally { setBusy(false); }
  };
  const add = () => run(async () => { await addProjectFollower(project.id, pick); setPick(''); });
  const remove = (em) => run(() => (em === me ? unfollowProject(project.id) : removeProjectFollower(project.id, em)));

  return (
    <Modal title={`Followers of ${project.name}`} onClose={onClose}>
      <p style={{ fontSize: 12.5, color: NX.dim, margin: '0 0 12px', lineHeight: 1.45 }}>
        Followers hear about new tasks, completed tasks and comments in this project, in their task email and bell.
        Nobody hears about tasks they cannot see.
      </p>
      {err && (
        <div role="alert" style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626', fontSize: 12.5, padding: '8px 10px',
          borderRadius: 8, marginBottom: 12 }}>{err}</div>
      )}
      {manage && !project.archived && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>Add Follower</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <PersonSelect value={pick} onChange={(em) => setPick(em || '')}
                people={people.filter((p) => !followers.includes(p.email))} placeholder="Pick a person…" />
            </div>
            <button type="button" disabled={busy || !pick} onClick={add} style={{ ...btn('primary'), opacity: busy || !pick ? 0.6 : 1 }}>
              <UserPlus size={14} /> Add Follower
            </button>
          </div>
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 700, color: NX.ink, marginBottom: 8 }}>
        {followers.length === 1 ? '1 Follower' : `${followers.length} Followers`}
      </div>
      <div className="nx-fill nx-scroll" data-testid="followers-list"
        style={{ overflowY: 'auto', border: `1px solid ${NX.border}`, borderRadius: 10, minHeight: 80 }}>
        {followers.length === 0 ? (
          <div style={{ padding: '14px 10px', fontSize: 12.5, color: NX.faint, textAlign: 'center' }}>
            Nobody follows this project yet.
          </div>
        ) : followers.map((em) => (
          <div key={em} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderBottom: `1px solid ${NX.border2}` }}>
            <Avatar email={em} name={nameFor(em)} size={26} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: NX.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nameFor(em)}{em === me && <span style={{ color: NX.faint }}> (You)</span>}
            </span>
            {(manage || em === me) && (
              <button type="button" disabled={busy} onClick={() => remove(em)}
                title={em === me ? 'Stop Following' : 'Remove Follower'} aria-label={em === me ? 'Stop Following' : `Remove ${nameFor(em)}`}
                style={{ ...btn('ghost'), padding: 5, color: NX.faint }}><X size={14} /></button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
