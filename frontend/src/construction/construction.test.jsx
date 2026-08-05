import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
// userEvent, not fireEvent, for the file input: FileList is read-only, so a
// plain change event cannot attach one.
import userEvent from '@testing-library/user-event';

// Render-smoke tests for the Construction module's four surfaces.
//
// Same guard as tasks/views/richlist.test.jsx and the same reason: build and
// lint both pass on a crash-at-render, and this module is the one where that
// failure costs the most. Its users are field crew on phones with no way to
// report a white screen and no second route to the task - if the capture screen
// throws, the day's log simply never gets filed.
//
// One file for all four rather than four files: they share every mock, and the
// per-view setup is a few lines each.
//
// These assert that a view RENDERS - not that it behaves. Each is exercised in
// the three states that actually crash things: loading (data still null),
// loaded with realistic rows, and empty. Deep interaction belongs in the
// backend tests, where the rules live.

vi.mock('../api', () => ({ api: {
  getConstructionOverview: vi.fn(),
  getConstructionLogs: vi.fn(),
  getConstructionReviewQueue: vi.fn(),
  getConstructionReports: vi.fn(),
  getConstructionRegister: vi.fn(),
  getConstructionMedia: vi.fn(),
  startConstructionLog: vi.fn(),
  createConstructionProject: vi.fn(),
  reviewConstructionLog: vi.fn(),
  updateConstructionLog: vi.fn(),
  submitConstructionLog: vi.fn(),
  createConstructionMedia: vi.fn(),
  deleteConstructionMedia: vi.fn(),
} }));

// The capture screen talks to Supabase Storage directly. Stubbed at the helper
// rather than the client so the test never needs Supabase env vars.
vi.mock('./lib/upload', () => ({
  uploadConstructionMedia: vi.fn(async () => ({ payload: null, error: null })),
  validate: () => '',
  kindOf: () => 'photo',
  filesFromPaste: () => [],
  BUCKET: 'construction-media',
  MAX_BYTES: { photo: 1, video: 1, audio: 1 },
  ALLOWED_MIME: { photo: [], video: [], audio: [] },
}));

vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

import { api } from '../api';
import { uploadConstructionMedia } from './lib/upload';
import ConstructionDashboard from './ConstructionDashboard';
import ReviewQueue from './ReviewQueue';
import WeeklyReports from './WeeklyReports';
import Registers from './Registers';
import DailyLogCapture from './DailyLogCapture';

const project = {
  id: 'p1', name: 'Valley Center Phase 2', address: '100 Site Rd',
  phase: 'Foundation', percentComplete: 42, status: 'active',
  workerEmails: ['w@greensglobal.com'], managerEmails: ['m@greensglobal.com'],
  executiveEmails: [], targetFinishOn: '2026-12-01', archived: false,
};

// Shaped from routers/construction.py log_to_dict - every field it returns,
// so a view reaching for one that is absent fails here rather than on a phone.
const log = {
  id: 'l1', projectId: 'p1', logDate: '2026-08-04', authorEmail: 'w@greensglobal.com',
  status: 'processed', notes: 'Poured the north footings.', weather: 'Clear',
  temperatureF: 78, crewSize: 6, hoursWorked: 8, geofenceOk: true,
  aiSummary: 'Formwork was stripped and the north footings were poured.',
  aiWorkCompleted: [{ activity: 'Pour', trade: 'Concrete', location: 'North' }],
  aiCategories: ['concrete'],
  aiSafetyFlags: [{ severity: 'medium', issue: 'Open trench unmarked' }],
  aiDelayFlags: [], aiActionItems: [], aiNextWork: ['Strip forms'],
  aiConfidence: 0.82, aiProcessedAt: '2026-08-04T18:00:00Z',
  reviewedBy: '', reviewNote: '', submittedAt: '2026-08-04T17:00:00Z',
  createdAt: '2026-08-04T07:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getConstructionOverview.mockResolvedValue({
    totalWorkforce: 6, activeSites: 1, safetyFlags: 1, pendingReview: 1,
    logsThisWeek: 3, projects: [project],
  });
  api.getConstructionLogs.mockResolvedValue([log]);
  api.getConstructionReviewQueue.mockResolvedValue([
    { ...log, projectName: project.name, mediaCount: 4, awaitingAi: false },
  ]);
  api.getConstructionReports.mockResolvedValue([]);
  api.getConstructionRegister.mockResolvedValue([]);
  api.getConstructionMedia.mockResolvedValue([]);
  api.updateConstructionLog.mockResolvedValue({});
  api.submitConstructionLog.mockResolvedValue({});
  uploadConstructionMedia.mockResolvedValue({ payload: null, error: null });
});

describe('ConstructionDashboard', () => {
  it('renders the overview once loaded', async () => {
    render(<ConstructionDashboard />);
    expect(screen.getByText('Construction Overview')).toBeInTheDocument();
    // Asserted on the address, not the name: the review queue renders above the
    // project list and names the same jobsite, so getByText(name) matches twice.
    await waitFor(() => expect(screen.getByText(project.address)).toBeInTheDocument());
  });

  it('shows a loading state that is not mistakable for empty', () => {
    api.getConstructionOverview.mockReturnValue(new Promise(() => {}));
    render(<ConstructionDashboard />);
    // The distinction this asserts is the one that generates support tickets:
    // an in-flight fetch that renders the empty state reads as "our data is
    // gone". Skeletons carry no text, so the check is that the page has its
    // frame and the empty state is absent.
    expect(screen.getByText('Construction Overview')).toBeInTheDocument();
    expect(screen.queryByText(/No construction projects yet/i)).not.toBeInTheDocument();
  });

  it('renders an empty state rather than a blank panel', async () => {
    api.getConstructionOverview.mockResolvedValue({
      totalWorkforce: 0, activeSites: 0, safetyFlags: 0, pendingReview: 0,
      logsThisWeek: 0, projects: [],
    });
    render(<ConstructionDashboard />);
    await waitFor(() => expect(screen.getByText(/No construction projects yet/i)).toBeInTheDocument());
  });

  it('survives the overview failing', async () => {
    api.getConstructionOverview.mockRejectedValue(new Error('network down'));
    render(<ConstructionDashboard />);
    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
    // The header must still be there - a failed fetch is a banner, not a blank screen.
    expect(screen.getByText('Construction Overview')).toBeInTheDocument();
  });
});

describe('ReviewQueue', () => {
  it('renders a queued log', async () => {
    render(<ReviewQueue />);
    await waitFor(() => expect(screen.getByText(project.name)).toBeInTheDocument());
  });

  it('renders when the queue is empty', async () => {
    api.getConstructionReviewQueue.mockResolvedValue([]);
    const { container } = render(<ReviewQueue />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  // A log the AI has not reached yet has ai_* fields at their defaults. This is
  // the shape most likely to crash a view that assumes a summary exists.
  it('renders a log the AI has not processed', async () => {
    api.getConstructionReviewQueue.mockResolvedValue([{
      ...log, status: 'submitted', aiSummary: '', aiProcessedAt: '',
      aiSafetyFlags: [], aiWorkCompleted: [], aiConfidence: 0,
      projectName: project.name, mediaCount: 0, awaitingAi: true,
    }]);
    const { container } = render(<ReviewQueue />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });
});

describe('WeeklyReports', () => {
  it('renders with no reports yet', async () => {
    const { container } = render(<WeeklyReports project={project} canReview />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  it('renders a published report', async () => {
    api.getConstructionReports.mockResolvedValue([{
      id: 'r1', projectId: 'p1', weekStart: '2026-08-03', weekEnd: '2026-08-09',
      title: 'Week of August 3', status: 'published', version: 1, supersedesId: null,
      sections: { progress_narrative: { ai_text: 'Work proceeded.', text: 'Work proceeded.', sources: [] } },
      sectionOrder: ['progress_narrative'],
      stats: { logs: 5, photos: 20, videos: 1, crew_days: 30, hours: 240 },
      risks: [], recommendations: [], executiveSummary: 'On track.',
      managerNotes: '', dailyLogIds: ['l1'], mediaIds: [], pdfUrl: '',
      generatedAt: '2026-08-09T10:00:00Z', approvedBy: 'm@greensglobal.com',
      publishedAt: '2026-08-09T11:00:00Z',
    }]);
    const { container } = render(<WeeklyReports project={project} canReview />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  // An executive gets the same component with canReview false, and that branch
  // hides every control - easy to leave referencing something now undefined.
  it('renders read-only for a non-reviewer', async () => {
    const { container } = render(<WeeklyReports project={project} canReview={false} />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });
});

describe('Registers', () => {
  it('renders the milestones tab empty', async () => {
    render(<Registers project={project} canReview />);
    await waitFor(() => expect(screen.getByText(/No milestones yet/i)).toBeInTheDocument());
  });

  it('renders rows for each register', async () => {
    api.getConstructionRegister.mockImplementation((_id, kind) => Promise.resolve({
      milestones: [{
        id: 'm1', projectId: 'p1', name: 'Foundation complete', description: '',
        targetDate: '2026-09-01', actualDate: '', status: 'at_risk', critical: true,
        aiDetectedAt: '2026-08-04T12:00:00Z', aiEvidence: ['media1'],
        confirmedBy: '', createdAt: '2026-07-01T00:00:00Z',
      }],
      rfis: [{
        id: 'q1', projectId: 'p1', number: 'RFI-014', subject: 'Rebar spacing',
        question: 'Confirm spacing at grid C.', answer: '', status: 'open',
        ballInCourt: 'Architect', submittedBy: 'm@greensglobal.com',
        submittedOn: '2026-08-01', dueOn: '2026-08-08', answeredOn: '',
        costImpact: 0, scheduleImpactDays: 2, createdAt: '2026-08-01T00:00:00Z',
      }],
      submittals: [{
        id: 's1', projectId: 'p1', number: 'SUB-007', title: 'Concrete mix design',
        specSection: '03 30 00', status: 'revise_resubmit', revision: 1,
        submittedBy: 'm@greensglobal.com', submittedOn: '2026-07-20',
        dueOn: '2026-08-05', returnedOn: '2026-08-02', documentUrls: [],
        createdAt: '2026-07-20T00:00:00Z',
      }],
    }[kind] || []));
    render(<Registers project={project} canReview />);
    await waitFor(() => expect(screen.getByText('Foundation complete')).toBeInTheDocument());
    // The AI suggestion is a prompt to confirm, never a state change.
    expect(screen.getByText(/AI suggests this is hit/i)).toBeInTheDocument();
  });

  it('renders read-only for a worker', async () => {
    const { container } = render(<Registers project={project} canReview={false} />);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });
});

describe('DailyLogCapture', () => {
  it('renders the capture sheet for a draft', async () => {
    const { container } = render(
      <DailyLogCapture log={{ ...log, status: 'draft', aiSummary: '', aiProcessedAt: '' }}
        project={project} onClose={() => {}} onSubmitted={() => {}} />,
    );
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  it('renders a log bounced back for more information', async () => {
    const { container } = render(
      <DailyLogCapture log={{ ...log, status: 'needs_info', reviewNote: 'Which elevation?' }}
        project={project} onClose={() => {}} onSubmitted={() => {}} />,
    );
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  // Regression: Save & Close called onClose directly, so notes, crew size and
  // hours were discarded by a button labelled Save. Uploads had already landed,
  // so the log survived with its photos and none of the worker's words - and
  // nothing on screen said so.
  it('persists the typed fields on Save & Close', async () => {
    const onClose = vi.fn();
    render(<DailyLogCapture log={{ ...log, status: 'draft' }} project={project}
      onClose={onClose} onSubmitted={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/Anything the photos do not show/i),
      { target: { value: 'Footings poured on the north wall.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & Close/i }));

    await waitFor(() => expect(api.updateConstructionLog).toHaveBeenCalledWith(
      log.id, expect.objectContaining({ notes_raw: 'Footings poured on the north wall.' }),
    ));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the sheet open when the save fails, rather than losing the text', async () => {
    const onClose = vi.fn();
    api.updateConstructionLog.mockRejectedValue(new Error('Network request failed'));
    render(<DailyLogCapture log={{ ...log, status: 'draft' }} project={project}
      onClose={onClose} onSubmitted={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText(/Anything the photos do not show/i),
      { target: { value: 'Rebar inspection passed.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & Close/i }));

    await waitFor(() => expect(screen.getByText('Network request failed')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    // The words the worker typed are still on screen to retry with.
    expect(screen.getByDisplayValue('Rebar inspection passed.')).toBeInTheDocument();
  });

  // Regression: the failure reason lived only in the tile's title attribute, so
  // a worker in gloves saw a red square reading "Failed" and nothing else.
  it('shows why an upload failed without needing a hover', async () => {
    uploadConstructionMedia.mockResolvedValue({
      payload: null,
      error: 'Photo and video uploads are unavailable right now. Your notes, crew size and hours will still save.',
    });
    const { container } = render(
      <DailyLogCapture log={{ ...log, status: 'draft' }} project={project}
        onClose={() => {}} onSubmitted={() => {}} />);

    const input = container.querySelector('input[type="file"]');
    await userEvent.upload(input, new File(['x'], 'site.jpg', { type: 'image/jpeg' }));

    await waitFor(() => expect(screen.getByText(/1 file did not attach/i)).toBeInTheDocument());
    expect(screen.getByText(/uploads are unavailable right now/i)).toBeInTheDocument();
  });
});
