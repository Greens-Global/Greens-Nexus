import { useState } from 'react';
import { BookOpen, CheckSquare, GraduationCap, FilePlus, Search, Clock, Sparkles, Play, BadgeCheck, Users, X } from 'lucide-react';

const INIT_SOPS = [
  { id: 1, title: 'IT Security Policy v2.1', category: 'IT Procedures', status: 'Published', date: '2026-05-20' },
  { id: 2, title: 'Financial Reporting Guidelines', category: 'Accounting Guidelines', status: 'Under Review', date: '2026-05-19' },
  { id: 3, title: 'Site Safety Checklist', category: 'Safety Protocols', status: 'Published', date: '2026-05-18' },
  { id: 4, title: 'Code Review Process', category: 'Development Standards', status: 'Published', date: '2026-05-17' },
];

const INIT_COURSES = [
  { id: 101, title: 'Onsite Safety & Hazard Compliance', category: 'OPS', duration: '2 hours', progress: 100, status: 'Completed' },
  { id: 102, title: 'Sage Intacct Accounting Basics', category: 'Accounting', duration: '4 hours', progress: 40, status: 'Enrolled' },
  { id: 103, title: 'GDPR & Corporate IT Security Training', category: 'IT', duration: '1 hour', progress: 0, status: 'Enrolled' },
  { id: 104, title: 'Construction Blueprint Interpretation', category: 'Development', duration: '3 hours', progress: 100, status: 'Completed' },
  { id: 105, title: 'HubSpot Lead Routing & Sales Operations', category: 'Marketing', duration: '1.5 hours', progress: 85, status: 'Enrolled' },
];

const CATEGORIES = [
  { name: 'IT Procedures', count: 24 },
  { name: 'Accounting Guidelines', count: 18 },
  { name: 'Operations Manual', count: 32 },
  { name: 'Development Standards', count: 15 },
  { name: 'Safety Protocols', count: 12 },
  { name: 'HR Policies', count: 20 },
];

const TAB_LABELS = { index: 'SOP Index', review: 'Review SOP', lms: 'LMS (Learning Portal)' };

export default function SOP({ activeSub, onSubChange }) {
  const sub = activeSub || 'index';
  const [sops, setSops] = useState(INIT_SOPS);
  const [courses, setCourses] = useState(INIT_COURSES);
  const [search, setSearch] = useState('');
  const [showSopModal, setShowSopModal] = useState(false);
  const [showCourseModal, setShowCourseModal] = useState(false);
  const [sopForm, setSopForm] = useState({ title: '', category: 'Safety Protocols', status: 'Published', date: new Date().toISOString().split('T')[0] });
  const [courseForm, setCourseForm] = useState({ title: '', category: 'OPS', duration: '' });

  const filtered = sops.filter(s => !search || s.title.toLowerCase().includes(search.toLowerCase()) || s.category.toLowerCase().includes(search.toLowerCase()));
  const reviewDocs = sops.filter(d => d.status === 'Under Review');
  const completed = courses.filter(c => c.status === 'Completed').length;
  const inProgress = courses.filter(c => c.status === 'Enrolled').length;

  const approveSop = (id) => setSops(prev => prev.map(s => s.id === id ? { ...s, status: 'Published' } : s));

  const studyLesson = (id) => setCourses(prev => prev.map(c => {
    if (c.id !== id) return c;
    const newProgress = Math.min(c.progress + 20, 100);
    return { ...c, progress: newProgress, status: newProgress >= 100 ? 'Completed' : 'Enrolled' };
  }));

  const submitSop = (e) => {
    e.preventDefault();
    setSops(prev => [{ id: Date.now(), ...sopForm }, ...prev]);
    setShowSopModal(false);
    setSopForm({ title: '', category: 'Safety Protocols', status: 'Published', date: new Date().toISOString().split('T')[0] });
  };

  const submitCourse = (e) => {
    e.preventDefault();
    setCourses(prev => [...prev, { id: Math.floor(200 + Math.random() * 800), ...courseForm, progress: 0, status: 'Enrolled' }]);
    setShowCourseModal(false);
    setCourseForm({ title: '', category: 'OPS', duration: '' });
  };

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 }}>
        {Object.entries(TAB_LABELS).map(([key, label]) => (
          <button
            key={key}
            onClick={() => onSubChange(key)}
            style={{
              background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer',
              color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)',
              position: 'relative', transition: 'color 0.15s',
            }}
          >
            {label}
            {sub === key && (
              <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />
            )}
          </button>
        ))}
      </div>

      {/* SOP Index */}
      {sub === 'index' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>SOP Index</h2>
              <p>Standard Operating Procedures and company documentation</p>
            </div>
            <button className="primary-btn" onClick={() => setShowSopModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <FilePlus size={16} /> New SOP
            </button>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, marginBottom: 24, boxShadow: 'var(--shadow-sm)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text" className="form-input" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search SOPs and documentation..."
                style={{ paddingLeft: 44, width: '100%', height: 44 }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 32 }}>
            <h3 style={{ fontSize: '1.15rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>SOP Categories</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>Browse by department and category</p>
            <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              {CATEGORIES.map(cat => (
                <div key={cat.name} onClick={() => setSearch(cat.name)}
                  style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}>
                  <div style={{ width: 42, height: 42, borderRadius: 8, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <BookOpen size={20} style={{ color: 'var(--text-secondary)' }} />
                  </div>
                  <div>
                    <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)', display: 'block' }}>{cat.name}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{cat.count} documents</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Clock size={20} style={{ color: 'var(--text-secondary)' }} />
              <div>
                <h3 style={{ fontSize: '1.15rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 2 }}>Recent Updates</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Latest SOP changes and additions</p>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {filtered.length === 0
                ? <div style={{ textAlign: 'center', padding: 30, border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)' }}>No documents found.</div>
                : filtered.map(doc => (
                  <div key={doc.id} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                    <div>
                      <strong style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>{doc.title}</strong>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{doc.category}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <span className={`status-badge ${doc.status === 'Published' ? 'status-approved' : 'status-pending'}`}>{doc.status}</span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{doc.date}</span>
                    </div>
                  </div>
                ))
              }
            </div>
          </div>

          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: 'hsla(215,100%,50%,0.08)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={24} />
              </div>
              <div>
                <strong style={{ fontSize: '1.05rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)', display: 'block' }}>SOP Editor with Claude AI integration</strong>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 4, display: 'block' }}>Auto-format to company SOP template</span>
                <a href="#" style={{ fontSize: '0.85rem', color: 'hsl(var(--color-blue))', fontWeight: 700, textDecoration: 'none', marginTop: 6, display: 'inline-block' }}>Configure</a>
              </div>
            </div>
            <span style={{ border: '1px solid var(--border-color)', borderRadius: 20, padding: '4px 14px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Active</span>
          </div>
        </>
      )}

      {/* Review SOP */}
      {sub === 'review' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>SOP Approval Pipeline</h2>
              <p>Review draft SOP policies and approve them for organization-wide publication</p>
            </div>
          </div>
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Drafts Awaiting Approval</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Click 'Approve & Publish' to move documents to the index directory</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {reviewDocs.length === 0
                ? <div style={{ textAlign: 'center', padding: 48, border: '1px dashed var(--border-color)', borderRadius: 8, color: 'var(--text-secondary)' }}>
                    <strong style={{ display: 'block', fontSize: '1rem', color: 'var(--text-primary)', marginBottom: 4 }}>All Drafts Approved</strong>
                    <span>No SOPs are currently awaiting review.</span>
                  </div>
                : reviewDocs.map(doc => (
                  <div key={doc.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '18px 24px', backgroundColor: 'var(--bg-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)' }}>{doc.title}</strong>
                        <span className="status-badge status-pending" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Draft</span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', gap: 16 }}>
                        <span>Category: <strong>{doc.category}</strong></span>
                        <span>Created on: {doc.date}</span>
                      </div>
                    </div>
                    <button className="primary-btn" onClick={() => approveSop(doc.id)}
                      style={{ backgroundColor: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', height: 36, padding: '0 16px' }}>
                      <CheckSquare size={14} /> Approve & Publish
                    </button>
                  </div>
                ))
              }
            </div>
          </div>
        </>
      )}

      {/* LMS */}
      {sub === 'lms' && (
        <>
          <div className="view-header" style={{ marginBottom: 24 }}>
            <div className="view-title-group">
              <h2>Learning Management System (LMS)</h2>
              <p>Assign and monitor professional construction compliance courses and training</p>
            </div>
            <button className="primary-btn" onClick={() => setShowCourseModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              + Register Course
            </button>
          </div>

          <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { label: 'Total Courses', value: courses.length, helper: 'Compliance courses cataloged', color: 'card-blue', Icon: BookOpen },
              { label: 'Completed Training', value: completed, helper: 'Completed credentials issued', color: 'card-green', Icon: BadgeCheck },
              { label: 'Ongoing Training', value: inProgress, helper: 'Enrolled course paths in progress', color: 'card-blue', Icon: Users },
            ].map(({ label, value, helper, color, Icon }) => (
              <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
                <div className="kpi-card-header">
                  <span className="kpi-title">{label}</span>
                  <div className="kpi-icon-container"><Icon size={20} /></div>
                </div>
                <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
                <div className="kpi-helper">{helper}</div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Greens Nexus Course Catalog</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Compliance training curricula</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {courses.map(course => {
              const isDone = course.status === 'Completed';
              return (
                <div key={course.id} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 16 }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <span style={{ backgroundColor: 'var(--border-color)', color: 'var(--text-secondary)', fontSize: '0.7rem', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{course.category}</span>
                      <span className={`status-badge ${isDone ? 'status-approved' : 'status-pending'}`} style={{ fontSize: '0.7rem', padding: '1px 6px' }}>{course.status}</span>
                    </div>
                    <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block', marginBottom: 4, color: 'var(--text-primary)', lineHeight: 1.3 }}>{course.title}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Clock size={12} /> {course.duration} training
                    </span>
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: 4 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>Syllabus Progress</span>
                      <strong style={{ fontFamily: 'monospace' }}>{course.progress}%</strong>
                    </div>
                    <div style={{ width: '100%', height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${course.progress}%`, height: '100%', backgroundColor: isDone ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))', borderRadius: 3, transition: 'width 0.3s ease' }} />
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                    {isDone
                      ? <button className="secondary-btn" disabled style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <CheckSquare size={12} /> Course Complete
                        </button>
                      : <button className="primary-btn" onClick={() => studyLesson(course.id)}
                          style={{ height: 32, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 12px' }}>
                          <Play size={12} /> Study Lesson
                        </button>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* New SOP Modal */}
      {showSopModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create New SOP Document</h3>
              <button className="close-btn" onClick={() => setShowSopModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitSop}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Document Title</label>
                  <input type="text" className="form-input" required placeholder="e.g. Excavation Trench Safety Guidelines"
                    value={sopForm.title} onChange={e => setSopForm(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Department Category</label>
                  <select className="form-select" value={sopForm.category} onChange={e => setSopForm(p => ({ ...p, category: e.target.value }))}>
                    {['IT Procedures', 'Accounting Guidelines', 'Operations Manual', 'Development Standards', 'Safety Protocols', 'HR Policies'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Publication Status</label>
                  <select className="form-select" value={sopForm.status} onChange={e => setSopForm(p => ({ ...p, status: e.target.value }))}>
                    <option>Published</option>
                    <option>Under Review</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Effective Date</label>
                  <input type="date" className="form-input" required value={sopForm.date} onChange={e => setSopForm(p => ({ ...p, date: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowSopModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Create Document</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Course Modal */}
      {showCourseModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content" style={{ maxWidth: 500 }}>
            <div className="modal-header">
              <h3>Register New Compliance Course</h3>
              <button className="close-btn" onClick={() => setShowCourseModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitCourse}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Course Title</label>
                  <input type="text" className="form-input" required placeholder="e.g. Forklift Certification Training"
                    value={courseForm.title} onChange={e => setCourseForm(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Department Category</label>
                  <select className="form-select" value={courseForm.category} onChange={e => setCourseForm(p => ({ ...p, category: e.target.value }))}>
                    {['OPS', 'Accounting', 'IT', 'Development', 'Marketing'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Estimated Duration</label>
                  <input type="text" className="form-input" required placeholder="e.g. 2 hours, 45 minutes"
                    value={courseForm.duration} onChange={e => setCourseForm(p => ({ ...p, duration: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowCourseModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Create Course</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
