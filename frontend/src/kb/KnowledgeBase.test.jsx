// Render-smoke for the Knowledge Base module: the three tabs and the main
// screens draw with mocked data and never go blank.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [{ name: 'Neil Kadakia' }] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ isExternal: false, can: () => true, myGrantedModules: new Map([['sop', 'full'], ['tasks', 'editor']]), myEmail: 'me@example.com' }),
}));
vi.mock('../lib/useActionCounts', () => ({ useActionCounts: () => ({}), tabCount: () => 0, moduleCount: () => 0, withBadges: (t) => t, DATA_WRITTEN: 'nexus:data-written' }));

const PAGE = {
  id: 'kb_1', code: 'OPS-014', title: 'Move-In Walkthrough', summary: 'How a site manager hands a unit to a tenant.', page_type: 'sop', type_label: 'SOP',
  status: 'approved', version: '2.0', collection_id: 'col_ops', collection: [{ id: 'col_ops', name: 'Operations' }], owner_email: 'sagar@example.com', owner_name: 'Sagar Patel',
  reviewer_email: 'neil@example.com', tags: ['move-in'], verified_at: '2026-09-30', verified_by: 'neil@example.com', updated_at: '2026-10-01T00:00:00Z', published_at: '2026-09-30T00:00:00Z',
  views: 12, require_ack: false, stale: false, next_review: '2027-09-30', pinned: false, pending_revision: '', reading_minutes: 3,
  blocks: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Purpose' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Every tenant gets the same walk.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
    { type: 'steps', content: [
      { type: 'step', attrs: { photos: [], warning: '', tip: '', photoRequired: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Walk the tenant to the unit' }] }] },
      { type: 'step', attrs: { photos: [], warning: 'Mind the door spring', tip: '', photoRequired: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open the door fully' }] }] },
    ] },
    { type: 'callout', attrs: { kind: 'safety' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Never let the tenant use their own lock.' }] }] },
  ] },
  headings: [{ level: 2, text: 'Purpose', anchor: 'h-0' }, { level: 2, text: 'Steps', anchor: 'h-2' }],
  legacy_only: false, effective_date: '2026-09-30', review_every_months: 12, review: { next_review: '2027-09-30', days_overdue: 0, stale: false, banner: false },
  signing: 'in_page', audience: { everyone: true }, audience_text: 'Everyone', signoff: { required: false, signed: false, signed_at: '', due: '', overdue_days: 0, version_signed: '' },
  feedback: { helpful: 38, not_helpful: 3, mine: null }, versions: [{ id: 'ver_1', version: '2.0', published_at: '2026-09-30', change_kind: 'major', change_note: 'Four standard photos', author_name: 'Sagar Patel' }],
  translations: [], used_in_courses: [{ id: 'crs_1', title: 'Customer Move-In Essentials', code: 'LRN-001' }], task_runs: 142, related: [], embeds: {},
  steps: [{ title: 'Walk the tenant to the unit', detail: '', photos: [], photoRequired: true, warning: '' }, { title: 'Open the door fully', detail: '', photos: [], photoRequired: false, warning: 'Mind the door spring' }],
  can_edit: true, can_review: false, open_revision: null, has_original: false, comments: [], can_start_task: true,
};
const HOME = {
  me: { email: 'me@example.com', name: 'Me', can_author: true, can_manage: true, owned_collections: [], ai: false, storage: false, review_count: 1 },
  waiting: { policies: [{ ...PAGE, id: 'kb_pol', page_type: 'policy', title: 'Safety and Conduct Policy', due: '2026-10-28', overdue_days: 0 }], training: [], reviews: [] },
  collections: [{ id: 'col_ops', name: 'Operations', parent_id: '', department: 'Operations', owner_email: 'sagar@example.com', owner_name: 'Sagar Patel', description: 'Sites', pages: 24, stale: 2, review_every_months: 12 }],
  pinned: [PAGE], recent: [PAGE], my_drafts: [], counts: { published: 24, collections: 1 },
};
const TRAINING = {
  due: [{ id: 'crs_1', code: 'LRN-001', title: 'Site Safety Basics', my_status: 'In Progress', my_pct: 60, due_date: '2026-10-24', days_overdue: 0, est_minutes: 20, source: 'rule' }],
  completed: [], plans: [], certificates: [], policies: [], stats: { due: 1, overdue: 0, completed: 0, certificates: 0, to_sign: 0 }, can_author: true,
};
const HEALTH = { stats: { published: 24, stale: 1, flags: 1, drafts: 0, in_review: 0, requests: 0, unmigrated: 3, signatures_outstanding: 5 }, review_queue: [], stale: [{ ...PAGE, days_overdue: 40, next_review: '2026-09-01' }],
  flags: [{ id: 'flg_1', doc_id: 'kb_1', title: 'Move-In Walkthrough', code: 'OPS-014', text: 'Step 2 is out of date', user_name: 'Visesh', created_at: '2026-10-20T00:00:00Z', version: '2.0' }], requests: [], misses: [], drafts: [], in_review: [], activity: [] };

const named = {
  kbMe: () => Promise.resolve(HOME.me), kbHome: () => Promise.resolve(HOME), kbPage: () => Promise.resolve(PAGE), kbTrainingMe: () => Promise.resolve(TRAINING),
  kbHealth: () => Promise.resolve(HEALTH), kbCollections: () => Promise.resolve(HOME.collections), kbPeople: () => Promise.resolve([]), getTaskProjects: () => Promise.resolve([]),
  kbSearch: () => Promise.resolve({ results: [{ ...PAGE, snippet: 'the walk' }], also_matched: ['keys'], did_you_mean: '', total: 1 }),
  kbCompliance: () => Promise.resolve({ scope: 'direct', people: [], columns: [], stats: { people: 0, compliant_pct: 100, overdue: 0, due_soon: 0, compliant_people: 0 }, filters: { companies: [], departments: [], can_company: true } }),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) });
  return { api, default: api, saveBlob: () => {}, API_BASE: 'http://localhost:8000' };
});

const { default: KnowledgeBase } = await import('./KnowledgeBase');
afterEach(cleanup);

describe('Knowledge Base module', () => {
  it('shows the Library home with the search box, what waits on you and the collections', async () => {
    render(<KnowledgeBase activeSub="index" onSubChange={() => {}} />);
    expect(await screen.findByText('What do you need to know?')).toBeTruthy();
    expect(await screen.findByText('Waiting on You')).toBeTruthy();
    expect(await screen.findByText('Safety and Conduct Policy', { exact: false })).toBeTruthy();
    expect((await screen.findAllByText('Operations')).length).toBeGreaterThan(0);
  });

  it('renders a page with numbered steps, callouts and Start as Task', async () => {
    render(<KnowledgeBase activeSub="page:kb_1" onSubChange={() => {}} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Move-In Walkthrough' })).toBeTruthy();
    expect(await screen.findByText('Walk the tenant to the unit')).toBeTruthy();
    expect(screen.getByText('Never let the tenant use their own lock.')).toBeTruthy();
    expect(screen.getByText('Start as Task')).toBeTruthy();
    expect(screen.getByText('Verified 09/30/2026', { exact: false })).toBeTruthy();
    expect(screen.getByText('Mind the door spring', { exact: false })).toBeTruthy();
  });

  it('shows search results with the synonyms that matched', async () => {
    render(<KnowledgeBase activeSub="search:unit%20key" onSubChange={() => {}} />);
    expect(await screen.findByText('Also matched: keys')).toBeTruthy();
    expect(await screen.findByText('Move-In Walkthrough')).toBeTruthy();
  });

  it('shows My Training with the assigned course', async () => {
    render(<KnowledgeBase activeSub="training" onSubChange={() => {}} />);
    expect(await screen.findByText('Assigned to You')).toBeTruthy();
    expect(await screen.findByText('Site Safety Basics', { exact: false })).toBeTruthy();
  });

  it('shows Manage > Health with stale pages, flags and the migration banner', async () => {
    render(<KnowledgeBase activeSub="health" onSubChange={() => {}} />);
    expect(await screen.findByText('Past Review Date')).toBeTruthy();
    expect(await screen.findByText('"Step 2 is out of date"')).toBeTruthy();
    expect(await screen.findByText('3 pages from the old Knowledge Base', { exact: false })).toBeTruthy();
  });

  it('old sub keys still land somewhere sensible', async () => {
    render(<KnowledgeBase activeSub="lms" onSubChange={() => {}} />);
    expect(await screen.findByText('Assigned to You')).toBeTruthy();
  });
});
