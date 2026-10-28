// The Workflows module (Oct 28 2026, docs/superpowers/specs/2026-10-28-
// workflows-design.md section 8). Tabs Overview / Workflows / Automations /
// Runs / Templates / Catalog in the header strip (ModuleTabs); the sub
// (lib/sub.js) picks the screen - wf:<id> is the builder (Builder.jsx, its
// own chunk), run:<id> the Runs tab with that run open. The paused-all
// banner from GET /workflows/overview sits above every tab: when a Global
// Admin has stopped everything, every screen says so, and a Global Admin
// can resume from right here.
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { BookOpen, History, LayoutDashboard, LayoutTemplate, PauseCircle, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { api } from '../api';
import { ViewLoading } from '../components/AsyncState';
import ModuleTabs from '../components/ModuleTabs';
import { useRole } from '../contexts/RoleContext';
import { useActionCounts, tabCount } from '../lib/useActionCounts';
import { formatDateTime } from '../lib/datetime';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import Automations from './Automations';
import Overview from './Overview';
import Runs from './Runs';
import WorkflowList from './WorkflowList';
import { parseSub, tabFor } from './lib/sub';
import { Card, FONT, errorText } from './ui';

// The builder is built on its own branch (Task 13) and lands beside this
// file. A glob resolves it when it is there and stays an empty map when it is
// not, so this shell builds either way; the dynamic import keeps it in its
// own chunk exactly as lazy(() => import('./Builder')) would.
const builderModules = import.meta.glob('./Builder.jsx');
const loadBuilder = builderModules['./Builder.jsx'];
const Builder = loadBuilder ? lazy(loadBuilder) : null;

const TABS = [
  { key: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { key: 'list', label: 'Workflows', Icon: WorkflowIcon },
  { key: 'automations', label: 'Automations', Icon: Zap },
  { key: 'runs', label: 'Runs', Icon: History },
  { key: 'templates', label: 'Templates', Icon: LayoutTemplate },
  { key: 'catalog', label: 'Catalog', Icon: BookOpen },
];

const POLL_MS = 60000;

export default function WorkflowsApp({ sub, go }) {
  const { can } = useRole();
  const counts = useActionCounts();
  const parsed = parseSub(sub);
  const tab = tabFor(sub);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => api.wfOverview()
    .then((o) => { setOverview(o || {}); setError(false); })
    .catch(() => setError(true))
    .finally(() => setLoading(false)), []);

  useEffect(() => { load(); return pollWhileVisible(load, POLL_MS); }, [load]);

  const paused = overview?.pausedAll?.paused ? overview.pausedAll : null;
  const isGlobalAdmin = can('owner');
  const resumeAll = async () => {
    setResuming(true); setNotice('');
    try { await api.wfPauseAll({ paused: false }); await load(); }
    catch (e) { setNotice(errorText(e, 'Workflows could not be resumed - please try again.')); }
    finally { setResuming(false); }
  };

  const tabs = TABS.map((t) => (t.key === 'overview' ? { ...t, badge: tabCount(counts, 'workflows', 'overview') } : t));

  let screen;
  switch (parsed.screen) {
    case 'list': screen = <WorkflowList go={go} />; break;
    case 'automations': screen = <Automations go={go} />; break;
    case 'runs': screen = <Runs go={go} />; break;
    case 'run': screen = <Runs go={go} openRunId={parsed.id} />; break;
    case 'builder':
      screen = Builder ? (
        <Suspense fallback={<ViewLoading label="Opening the builder" />}>
          <Builder id={parsed.id} go={go} />
        </Suspense>
      ) : <ComingSoon what="The builder" />;
      break;
    case 'templates': screen = <ComingSoon what="Templates" />; break;
    case 'catalog': screen = <ComingSoon what="The catalog browser" />; break;
    default:
      screen = <Overview overview={overview} loading={loading && !overview} error={error && !overview} reload={() => { setLoading(!overview); load(); }} go={go} />;
  }

  return (
    <div style={{ fontFamily: FONT }}>
      <ModuleTabs tabs={tabs} active={tab} onChange={(k) => go(k)} />
      {paused && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 14, borderRadius: 10,
          background: 'hsla(var(--color-orange),0.12)', border: '1px solid hsla(var(--color-orange),0.4)', color: 'var(--ink)', fontSize: 13.5, flexWrap: 'wrap' }}>
          <PauseCircle size={18} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 200 }}>
            All workflows are paused{paused.by ? ` by ${paused.by}` : ''}{paused.at ? ` since ${formatDateTime(paused.at)}` : ''}. No run starts until they are resumed.
          </span>
          {isGlobalAdmin && (
            <button type="button" className="primary-btn" onClick={resumeAll} disabled={resuming}>{resuming ? 'Resuming...' : 'Resume'}</button>
          )}
          {notice && <span role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 13, flex: '1 1 100%' }}>{notice}</span>}
        </div>
      )}
      {screen}
    </div>
  );
}

function ComingSoon({ what }) {
  return (
    <Card style={{ padding: '28px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{what} is coming in this release</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>This part of Workflows is being finished and lands with the same release.</div>
    </Card>
  );
}
