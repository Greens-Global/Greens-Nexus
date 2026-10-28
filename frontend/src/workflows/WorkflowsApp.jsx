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
import Templates from './Templates';
import Catalog from './Catalog';
import { parseSub, tabFor } from './lib/sub';
import { FONT } from './ui';
import { errorText } from './lib/errors';

// The builder is its own chunk: nobody downloads it until a workflow opens.
const Builder = lazy(() => import('./Builder'));

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

  // /workflows/settings is Settings > Workflows: send the person there (an
  // old link, a bell) instead of landing them on Overview without a word.
  useEffect(() => {
    if (parsed.screen !== 'settings') return;
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'workflows' } }));
  }, [parsed.screen]);

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
      screen = (
        <Suspense fallback={<ViewLoading label="Opening the builder" />}>
          <Builder id={parsed.id} go={go} />
        </Suspense>
      );
      break;
    case 'templates': screen = <Templates go={go} />; break;
    case 'catalog': screen = <Catalog go={go} />; break;
    // 'settings' is Settings > Workflows (the effect above sends the person
    // there); Overview stands in meanwhile - never a blank screen
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

