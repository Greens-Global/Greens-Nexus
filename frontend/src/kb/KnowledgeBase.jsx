// Knowledge Base (Oct 2026 rebuild). One module, three tabs: Library for
// everyone, Training for everyone, Manage for editors. The sub-route
// (lib.js parseSub) names the screen, so every page, course and review has
// an address bells and the help widget can open.
import { lazy, Suspense, useEffect, useState } from 'react';
import { BookOpen, GraduationCap, SlidersHorizontal } from 'lucide-react';
import ModuleTabs from '../components/ModuleTabs';
import { ViewLoading } from '../components/AsyncState';
import { useActionCounts, tabCount } from '../lib/useActionCounts';
import { api } from '../api';
import { ToastProvider } from './components/Toast';
import { parseSub, subFor, TAB_OF } from './lib';
import Home from './library/Home';
import SearchResults from './library/SearchResults';
import PageView from './library/PageView';
import CollectionView from './library/CollectionView';
import SignaturesView from './library/SignaturesView';
import PageTasksView from './library/PageTasksView';
import MyTraining from './training/MyTraining';
import CoursePlayer from './training/CoursePlayer';
import Health from './manage/Health';
import Compliance from './manage/Compliance';
import CollectionsAdmin from './manage/CollectionsAdmin';
import Plans from './manage/Plans';
import './kb.css';

// The editor and the course builder carry TipTap; only writers load them.
const Editor = lazy(() => import('./editor/Editor'));
const ReviewView = lazy(() => import('./editor/ReviewView'));
const CourseBuilder = lazy(() => import('./training/CourseBuilder'));

const TABS = [
  { key: 'library', label: 'Library', Icon: BookOpen },
  { key: 'training', label: 'Training', Icon: GraduationCap },
  { key: 'manage', label: 'Manage', Icon: SlidersHorizontal },
];

export default function KnowledgeBase({ activeSub, onSubChange }) {
  const route = parseSub(activeSub);
  const counts = useActionCounts();
  const [me, setMe] = useState(null);
  useEffect(() => { api.kbMe().then(setMe).catch(() => setMe({ can_author: false, can_manage: false, owned_collections: [] })); }, []);

  // the old openKb event (help widget, older bells) still lands on a page
  useEffect(() => {
    const onOpen = (e) => { const d = e.detail || {}; if (d.id) onSubChange(subFor(d.kind === 'course' ? 'course' : 'page', d.id)); };
    window.addEventListener('nexus:kb-open', onOpen);
    return () => window.removeEventListener('nexus:kb-open', onOpen);
  }, [onSubChange]);

  const tab = TAB_OF[route.screen] || 'library';
  const tabs = TABS.filter((t) => t.key !== 'manage' || me?.can_author).map((t) => ({
    ...t,
    badge: t.key === 'training' ? tabCount(counts, 'support', 'kb') : t.key === 'manage' ? (me?.review_count || 0) : 0,
  }));
  const onTab = (key) => onSubChange(key === 'library' ? 'index' : key === 'training' ? 'training' : 'health');

  let screen;
  switch (route.screen) {
    case 'home': screen = <Home me={me} />; break;
    case 'search': screen = <SearchResults query={route.id || ''} me={me} />; break;
    case 'page': screen = <PageView id={route.id} me={me} />; break;
    case 'collection': screen = <CollectionView id={route.id} me={me} />; break;
    case 'signatures': screen = <SignaturesView id={route.id} />; break;
    case 'tasks': screen = <PageTasksView id={route.id} />; break;
    case 'editor': screen = <Editor id={route.id || 'new'} me={me} />; break;
    case 'revision': screen = <ReviewView kind="revision" id={route.id} me={me} />; break;
    case 'review': screen = <ReviewView kind="page" id={route.id} me={me} />; break;
    case 'training': screen = <MyTraining me={me} />; break;
    case 'courses': screen = <MyTraining me={me} seg="courses" />; break;
    case 'course': screen = <CoursePlayer id={route.id} me={me} />; break;
    case 'builder': screen = <CourseBuilder id={route.id || 'new'} me={me} />; break;
    case 'health': screen = <Health me={me} />; break;
    case 'compliance': screen = <Compliance me={me} />; break;
    case 'collections': screen = <CollectionsAdmin me={me} />; break;
    case 'plans': screen = <Plans me={me} />; break;
    default: screen = <Home me={me} />;
  }

  return (
    <ToastProvider>
      <div className="kb">
        <ModuleTabs tabs={tabs} active={tab} onChange={onTab} />
        <Suspense fallback={<ViewLoading label="Loading" minHeight="40vh" />}>{screen}</Suspense>
      </div>
    </ToastProvider>
  );
}
