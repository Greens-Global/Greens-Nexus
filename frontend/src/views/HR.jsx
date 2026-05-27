import { useState } from 'react';
import { LogIn, CheckSquare, PenTool, Files, ShieldCheck, RefreshCw, Check, Download, X } from 'lucide-react';

const INIT_MS = [
  { id: 1, name: 'Alice Thompson', role: 'Project Coordinator', dept: 'OPS', startDate: '2026-06-01', adAccount: 'Pending', emailSetup: 'Pending', msLicensing: 'Pending', laptopTracking: 'Shipped (Delivered May 24)' },
  { id: 2, name: 'Marcus Brody', role: 'Safety Inspector', dept: 'OPS', startDate: '2026-06-05', adAccount: 'Active', emailSetup: 'Active', msLicensing: 'Active', laptopTracking: 'In Transit' },
  { id: 3, name: 'Jessica Vance', role: 'Architectural Analyst', dept: 'Development', startDate: '2026-05-20', adAccount: 'Active', emailSetup: 'Active', msLicensing: 'Active', laptopTracking: 'Delivered' },
  { id: 4, name: 'Tyler Durden', role: 'Foreman Assistant', dept: 'OPS', startDate: '2026-06-10', adAccount: 'Pending', emailSetup: 'Pending', msLicensing: 'Pending', laptopTracking: 'Processing' },
];

const INIT_ASANA = [
  { id: 101, title: 'Collect NDA & Disclosure agreements', assignee: 'Jennifer Lee', dueDate: '2026-05-28', status: 'In Progress', candidate: 'Alice Thompson' },
  { id: 102, title: 'Provision AWS and local VPN credentials', assignee: 'David Kim', dueDate: '2026-05-29', status: 'To Do', candidate: 'Alice Thompson' },
  { id: 103, title: 'Conduct safety orientation walk-through', assignee: 'Michael Chen', dueDate: '2026-06-02', status: 'To Do', candidate: 'Alice Thompson' },
  { id: 104, title: 'Verify I-9 employment authorization docs', assignee: 'Jennifer Lee', dueDate: '2026-05-24', status: 'Completed', candidate: 'Jessica Vance' },
  { id: 105, title: 'Deliver laptop and configure MFA', assignee: 'David Kim', dueDate: '2026-05-19', status: 'Completed', candidate: 'Jessica Vance' },
];

const INIT_DISCLOSURES = [
  { id: 201, name: 'Alice Thompson', type: 'Conflict of Interest', status: 'Signed', date: '2026-05-24', file: 'coi_athompson_2026.pdf' },
  { id: 202, name: 'Alice Thompson', type: 'NDA Agreement', status: 'Signed', date: '2026-05-24', file: 'nda_athompson_2026.pdf' },
  { id: 203, name: 'Marcus Brody', type: 'NDA Agreement', status: 'Signed', date: '2026-05-22', file: 'nda_mbrody_2026.pdf' },
  { id: 204, name: 'Tyler Durden', type: 'Conflict of Interest', status: 'Pending', date: 'N/A', file: '' },
  { id: 205, name: 'Tyler Durden', type: 'NDA Agreement', status: 'Pending', date: 'N/A', file: '' },
];

const HR_DOCS = [
  { name: 'Greens Nexus Employee Handbook 2026.pdf', size: '2.4 MB', category: 'Handbooks', lastUpdated: '2026-01-10' },
  { name: 'Direct Deposit Enrollment Form.pdf', size: '340 KB', category: 'Forms', lastUpdated: '2025-08-15' },
  { name: 'Safety Protocols & Hazard Guide.pdf', size: '4.8 MB', category: 'Safety', lastUpdated: '2026-03-22' },
  { name: 'Corporate Benefits & Healthcare Package.pdf', size: '1.2 MB', category: 'Benefits', lastUpdated: '2026-02-18' },
  { name: 'Form W-4 Employee Withholding 2026.pdf', size: '180 KB', category: 'Forms', lastUpdated: '2026-01-01' },
];

export default function HR({ activeSub, onSubChange }) {
  const sub = activeSub || 'hr-ms';
  const [msEmp, setMsEmp] = useState(INIT_MS);
  const [asanaTasks, setAsanaTasks] = useState(INIT_ASANA);

  const pushToAD = (id) => setMsEmp(prev => prev.map(e => e.id === id ? { ...e, adAccount: 'Active', emailSetup: 'Active', msLicensing: 'Active' } : e));
  const completeTask = (id) => setAsanaTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'Completed' } : t));

  const statusStyle = (s) => ({
    backgroundColor: s === 'Active' ? 'hsla(var(--color-green), 0.1)' : s === 'Pending' ? 'hsla(var(--color-orange), 0.1)' : 'var(--bg-secondary)',
    color: s === 'Active' ? 'hsl(var(--color-green))' : s === 'Pending' ? 'hsl(var(--color-orange))' : 'var(--text-secondary)',
    padding: '2px 8px', borderRadius: 12, fontSize: '0.75rem', fontWeight: 600,
  });

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Human Resources</h2>
          <p>Employee onboarding pipelines, legal disclosures, and policy documentation</p>
        </div>
        <span style={{ fontSize: '0.8rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '6px 12px', borderRadius: 20, color: 'var(--text-secondary)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={14} /> HR Manager Portal
        </span>
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-color)', paddingBottom: 1, flexWrap: 'wrap' }}>
        {[
          { key: 'hr-ms', label: 'Onboarding - MS', Icon: LogIn },
          { key: 'hr-asana', label: 'Onboarding - Asana', Icon: CheckSquare },
          { key: 'hr-disclosures', label: 'Disclosures', Icon: PenTool },
          { key: 'hr-documents', label: 'Documents', Icon: Files },
        ].map(({ key, label, Icon }) => (
          <button key={key} onClick={() => onSubChange(key)}
            style={{ background: 'none', border: 'none', padding: '10px 18px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', color: sub === key ? 'var(--text-primary)' : 'var(--text-secondary)', position: 'relative', transition: 'color 0.15s', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={18} /> {label}
            {sub === key && <span style={{ position: 'absolute', bottom: -1, left: 0, right: 0, height: 2.5, backgroundColor: 'var(--text-primary)', borderRadius: '4px 4px 0 0' }} />}
          </button>
        ))}
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>

        {/* MS Onboarding */}
        {sub === 'hr-ms' && (
          <>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Microsoft Active Directory Onboarding</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Manage employee Microsoft accounts, email addresses, and software licensing setups</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
              {msEmp.map(emp => {
                const pending = emp.adAccount === 'Pending';
                return (
                  <div key={emp.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 18, transition: 'all 0.15s' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                      <div>
                        <strong style={{ fontSize: '1rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block' }}>{emp.name}</strong>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{emp.role} · {emp.dept}</span>
                      </div>
                      <span style={statusStyle(pending ? 'Pending' : 'Active')}>{pending ? 'Awaiting Provisioning' : 'Active Account'}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16, fontSize: '0.825rem' }}>
                      {[
                        ['Start Date', emp.startDate],
                        ['Azure AD Domain', pending ? 'Pending' : emp.name.toLowerCase().replace(' ', '') + '@greensglobal.com'],
                        ['Exchange Mailbox', emp.emailSetup],
                        ['O365 Enterprise E5', emp.msLicensing],
                        ['Hardware Laptop', emp.laptopTracking],
                      ].map(([label, val]) => (
                        <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>{label}:</span>
                          <strong style={{ color: val === 'Active' ? 'hsl(var(--color-green))' : 'var(--text-primary)', fontFamily: label === 'Azure AD Domain' ? 'monospace' : 'inherit', fontSize: label === 'Azure AD Domain' ? '0.775rem' : 'inherit' }}>{val}</strong>
                        </div>
                      ))}
                    </div>
                    {pending
                      ? <button className="primary-btn" onClick={() => pushToAD(emp.id)} style={{ width: '100%', justifyContent: 'center', fontSize: '0.85rem', padding: '8px 14px' }}>
                          Push to Microsoft AD
                        </button>
                      : <button className="secondary-btn" style={{ width: '100%', justifyContent: 'center', padding: '8px 14px', fontSize: '0.85rem' }}>
                          Print Credentials Sheet
                        </button>
                    }
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Asana Onboarding */}
        {sub === 'hr-asana' && (
          <>
            <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Asana Sync - Employee Onboarding Checklists</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Interactive task completion list synchronized with team workspace boards</p>
              </div>
              <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <RefreshCw size={14} /> Sync with Asana API
              </button>
            </div>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr><th>Onboarding Task</th><th>Candidate</th><th>Assignee</th><th>Due Date</th><th>Status</th><th style={{ textAlign: 'right' }}>Action</th></tr>
                </thead>
                <tbody>
                  {asanaTasks.map(t => {
                    const done = t.status === 'Completed';
                    const inProg = t.status === 'In Progress';
                    return (
                      <tr key={t.id}>
                        <td style={{ fontWeight: 600, color: done ? 'var(--text-muted)' : 'var(--text-primary)', textDecoration: done ? 'line-through' : 'none' }}>{t.title}</td>
                        <td>{t.candidate}</td>
                        <td>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>{t.assignee.charAt(0)}</div>
                            <span>{t.assignee}</span>
                          </div>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t.dueDate}</td>
                        <td>
                          <span style={{ backgroundColor: done ? 'hsl(var(--color-green))' : inProg ? 'hsl(var(--color-blue))' : 'var(--border-color)', color: (done || inProg) ? '#fff' : 'var(--text-secondary)', fontSize: '0.7rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{t.status}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {done
                            ? <span style={{ color: 'hsl(var(--color-green))', fontSize: '0.8rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={14} /> Done</span>
                            : <button className="secondary-btn" onClick={() => completeTask(t.id)} style={{ padding: '4px 10px', fontSize: '0.775rem' }}>Mark Complete</button>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Disclosures */}
        {sub === 'hr-disclosures' && (
          <>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>NDA & Compliance Disclosures</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Review employee non-disclosure agreements and conflict of interest forms</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Employee</th><th>Document Type</th><th>Status</th><th>Date Signed</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {INIT_DISCLOSURES.map(d => {
                    const signed = d.status === 'Signed';
                    return (
                      <tr key={d.id}>
                        <td style={{ fontWeight: 600 }}>{d.name}</td>
                        <td>{d.type}</td>
                        <td>
                          <span style={{ backgroundColor: signed ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: signed ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{d.status}</span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{d.date}</td>
                        <td style={{ textAlign: 'right' }}>
                          {signed
                            ? <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.775rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Download size={12} /> Download PDF</button>
                            : <button className="primary-btn" style={{ padding: '4px 10px', fontSize: '0.775rem' }}>Send for Signature</button>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Documents */}
        {sub === 'hr-documents' && (
          <>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>HR Document Vault</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Company policies, onboarding forms, benefits packages, and tax documents</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {HR_DOCS.map(doc => (
                <div key={doc.name} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: 'hsla(var(--color-red), 0.08)', color: 'hsl(var(--color-red))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Files size={18} />
                    </div>
                    <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-secondary)', fontWeight: 600 }}>{doc.category}</span>
                  </div>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block', marginBottom: 4, lineHeight: 1.3 }}>{doc.name}</strong>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 14 }}>{doc.size} · Updated {doc.lastUpdated}</div>
                  <button className="secondary-btn" style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    <Download size={14} /> Download
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
