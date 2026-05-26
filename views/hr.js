// views/hr.js
// Renders the HR / Employee Management view with Onboarding, Disclosures, and Documents

function renderHR(container, state, navigateTo) {
  const activeSubTab = state.activeHRSubTab || 'hr-ms';

  // Inject styles if they don't exist
  const styleId = 'hr-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .hr-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .hr-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
        flex-wrap: wrap;
      }
      .hr-tab-btn {
        background: none;
        border: none;
        padding: 10px 18px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-weight: 600;
        font-size: 0.95rem;
        cursor: pointer;
        color: var(--text-secondary);
        position: relative;
        transition: all var(--transition-fast);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hr-tab-btn:hover {
        color: var(--text-primary);
      }
      .hr-tab-btn.active {
        color: var(--text-primary);
      }
      .hr-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .hr-tab-container {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }
      .onboarding-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 20px;
        margin-top: 16px;
      }
      .employee-card {
        background-color: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 18px;
        transition: all var(--transition-fast);
      }
      .employee-card:hover {
        border-color: var(--border-hover);
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
      }
      .onboarding-task-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-radius: 6px;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        font-size: 0.875rem;
      }
      .ms-status-badge {
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 0.75rem;
        font-weight: 600;
      }
      .ms-status-active {
        background-color: hsla(var(--color-green), 0.1);
        color: hsl(var(--color-green));
      }
      .ms-status-pending {
        background-color: hsla(var(--color-orange), 0.1);
        color: hsl(var(--color-orange));
      }
      .ms-status-failed {
        background-color: hsla(var(--color-red), 0.1);
        color: hsl(var(--color-red));
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initialize HR state data if missing
  if (!state.hrMSOnboarding) {
    state.hrMSOnboarding = [
      { id: 1, name: 'Alice Thompson', role: 'Project Coordinator', dept: 'OPS', startDate: '2026-06-01', adAccount: 'Pending', emailSetup: 'Pending', msLicensing: 'Pending', laptopTracking: 'Shipped (Delivered May 24)' },
      { id: 2, name: 'Marcus Brody', role: 'Safety Inspector', dept: 'OPS', startDate: '2026-06-05', adAccount: 'Active', emailSetup: 'Active', msLicensing: 'Active', laptopTracking: 'In Transit' },
      { id: 3, name: 'Jessica Vance', role: 'Architectural Analyst', dept: 'Development', startDate: '2026-05-20', adAccount: 'Active', emailSetup: 'Active', msLicensing: 'Active', laptopTracking: 'Delivered' },
      { id: 4, name: 'Tyler Durden', role: 'Foreman Assistant', dept: 'OPS', startDate: '2026-06-10', adAccount: 'Pending', emailSetup: 'Pending', msLicensing: 'Pending', laptopTracking: 'Processing' }
    ];
  }

  if (!state.hrAsanaTasks) {
    state.hrAsanaTasks = [
      { id: 101, title: 'Collect NDA & Disclosure agreements', assignee: 'Jennifer Lee', dueDate: '2026-05-28', status: 'In Progress', candidate: 'Alice Thompson' },
      { id: 102, title: 'Provision AWS and local VPN credentials', assignee: 'David Kim', dueDate: '2026-05-29', status: 'To Do', candidate: 'Alice Thompson' },
      { id: 103, title: 'Conduct safety orientation walk-through', assignee: 'Michael Chen', dueDate: '2026-06-02', status: 'To Do', candidate: 'Alice Thompson' },
      { id: 104, title: 'Verify I-9 employment authorization docs', assignee: 'Jennifer Lee', dueDate: '2026-05-24', status: 'Completed', candidate: 'Jessica Vance' },
      { id: 105, title: 'Deliver laptop and configure MFA', assignee: 'David Kim', dueDate: '2026-05-19', status: 'Completed', candidate: 'Jessica Vance' }
    ];
  }

  if (!state.hrDisclosures) {
    state.hrDisclosures = [
      { id: 201, name: 'Alice Thompson', type: 'Conflict of Interest', status: 'Signed', date: '2026-05-24', file: 'coi_athompson_2026.pdf' },
      { id: 202, name: 'Alice Thompson', type: 'NDA Agreement', status: 'Signed', date: '2026-05-24', file: 'nda_athompson_2026.pdf' },
      { id: 203, name: 'Marcus Brody', type: 'NDA Agreement', status: 'Signed', date: '2026-05-22', file: 'nda_mbrody_2026.pdf' },
      { id: 204, name: 'Tyler Durden', type: 'Conflict of Interest', status: 'Pending', date: 'N/A', file: '' },
      { id: 205, name: 'Tyler Durden', type: 'NDA Agreement', status: 'Pending', date: 'N/A', file: '' }
    ];
  }

  if (!state.hrDocuments) {
    state.hrDocuments = [
      { name: 'Greens Nexus Employee Handbook 2026.pdf', size: '2.4 MB', category: 'Handbooks', lastUpdated: '2026-01-10' },
      { name: 'Direct Deposit Enrollment Form.pdf', size: '340 KB', category: 'Forms', lastUpdated: '2025-08-15' },
      { name: 'Safety Protocols & Hazard Guide.pdf', size: '4.8 MB', category: 'Safety', lastUpdated: '2026-03-22' },
      { name: 'Corporate Benefits & Healthcare Package.pdf', size: '1.2 MB', category: 'Benefits', lastUpdated: '2026-02-18' },
      { name: 'Form W-4 Employee Withholding 2026.pdf', size: '180 KB', category: 'Forms', lastUpdated: '2026-01-01' }
    ];
  }

  // Render Subtabs
  let tabContentHtml = '';
  switch (activeSubTab) {
    case 'hr-ms':
      tabContentHtml = renderMSOnboarding(state.hrMSOnboarding);
      break;
    case 'hr-asana':
      tabContentHtml = renderAsanaOnboarding(state.hrAsanaTasks);
      break;
    case 'hr-disclosures':
      tabContentHtml = renderDisclosures(state.hrDisclosures);
      break;
    case 'hr-documents':
      tabContentHtml = renderDocuments(state.hrDocuments);
      break;
  }

  container.innerHTML = `
    <div class="hr-view">
      <!-- Header -->
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>Human Resources</h2>
          <p>Employee onboarding pipelines, legal disclosures, and policy documentation</p>
        </div>
        <div style="display: flex; gap: 12px; align-items: center;">
          <span style="font-size: 0.8rem; background-color: var(--bg-secondary); border: 1px solid var(--border-color); padding: 6px 12px; border-radius: 20px; color: var(--text-secondary); font-weight: 600;">
            <i data-lucide="shield-check" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> HR Manager Portal
          </span>
        </div>
      </div>

      <!-- Horizontal Tab Navigation -->
      <div class="hr-tabs-nav">
        <button class="hr-tab-btn ${activeSubTab === 'hr-ms' ? 'active' : ''}" data-tab="hr-ms">
          <i data-lucide="log-in" style="width: 18px; height: 18px;"></i> Onboarding - MS
        </button>
        <button class="hr-tab-btn ${activeSubTab === 'hr-asana' ? 'active' : ''}" data-tab="hr-asana">
          <i data-lucide="check-square" style="width: 18px; height: 18px;"></i> Onboarding - Asana
        </button>
        <button class="hr-tab-btn ${activeSubTab === 'hr-disclosures' ? 'active' : ''}" data-tab="hr-disclosures">
          <i data-lucide="pen-tool" style="width: 18px; height: 18px;"></i> Disclosures
        </button>
        <button class="hr-tab-btn ${activeSubTab === 'hr-documents' ? 'active' : ''}" data-tab="hr-documents">
          <i data-lucide="files" style="width: 18px; height: 18px;"></i> Documents
        </button>
      </div>

      <!-- Tab Content Area -->
      <div class="hr-tab-container">
        ${tabContentHtml}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach horizontal tab listeners
  const tabBtns = container.querySelectorAll('.hr-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeHRSubTab = selectedTab;
      navigateTo('hr');
    });
  });

  // Attach event handlers depending on view
  if (activeSubTab === 'hr-ms') {
    attachMSHandlers(container, state, () => renderHR(container, state, navigateTo));
  } else if (activeSubTab === 'hr-asana') {
    attachAsanaHandlers(container, state, () => renderHR(container, state, navigateTo));
  } else if (activeSubTab === 'hr-disclosures') {
    attachDisclosuresHandlers(container, state);
  } else if (activeSubTab === 'hr-documents') {
    attachDocumentsHandlers(container, state);
  }
}

// -------------------------------------------
// 1. MS Onboarding Renderer & Handlers
// -------------------------------------------
function renderMSOnboarding(employees) {
  return `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Microsoft Active Directory Onboarding</h3>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">Manage employee Microsoft accounts, email addresses, and software licensing setups</p>
    </div>

    <div class="onboarding-grid">
      ${employees.map(emp => {
        const isPending = emp.adAccount === 'Pending';
        return `
          <div class="employee-card" id="emp-card-${emp.id}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;">
              <div>
                <strong style="font-size: 1rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif; display: block;">${emp.name}</strong>
                <span style="font-size: 0.8rem; color: var(--text-secondary);">${emp.role} &bull; ${emp.dept}</span>
              </div>
              <span class="ms-status-badge ${isPending ? 'ms-status-pending' : 'ms-status-active'}">
                ${isPending ? 'Awaiting Provisioning' : 'Active Account'}
              </span>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; font-size: 0.825rem;">
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-secondary);">Start Date:</span>
                <strong style="color: var(--text-primary);">${emp.startDate}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: var(--text-secondary);">Azure AD Domain:</span>
                <span style="font-family: monospace; font-size: 0.775rem;">${isPending ? 'Pending' : emp.name.toLowerCase().replace(' ', '') + '@greensglobal.com'}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-secondary);">Exchange Mailbox:</span>
                <strong style="color: ${emp.emailSetup === 'Active' ? 'hsl(var(--color-green))' : 'var(--text-secondary)'};">${emp.emailSetup}</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-secondary);">O365 Enterprise E5:</span>
                <strong style="color: ${emp.msLicensing === 'Active' ? 'hsl(var(--color-green))' : 'var(--text-secondary)'};">${emp.msLicensing}</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-secondary);">Hardware Laptop:</span>
                <strong style="color: var(--text-primary);">${emp.laptopTracking}</strong>
              </div>
            </div>

            ${isPending ? `
              <button class="primary-btn push-ms-btn" data-id="${emp.id}" style="width: 100%; justify-content: center; background-color: #000000; color: #ffffff; padding: 8px 14px; font-size: 0.85rem;">
                <i data-lucide="cloud-lightning" style="width: 14px; height: 14px; margin-right: 6px;"></i> Push to Microsoft AD
              </button>
            ` : `
              <button class="secondary-btn" style="width: 100%; justify-content: center; padding: 8px 14px; font-size: 0.85rem;" onclick="alert('Sending password credentials sheet via secure HR courier...')">
                <i data-lucide="key" style="width: 14px; height: 14px; margin-right: 6px;"></i> Print Credentials Sheet
              </button>
            `}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function attachMSHandlers(container, state, refreshView) {
  const pushBtns = container.querySelectorAll('.push-ms-btn');
  pushBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const emp = state.hrMSOnboarding.find(e => e.id === id);
      if (emp) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="refresh-cw" class="animate-spin" style="width: 14px; height: 14px; margin-right: 6px;"></i> Connecting to Microsoft Graph API...`;
        lucide.createIcons();

        setTimeout(() => {
          emp.adAccount = 'Active';
          emp.emailSetup = 'Active';
          emp.msLicensing = 'Active';
          alert(`Successfully created account directory and mailbox for ${emp.name} in Greens Nexus Azure tenant!`);
          refreshView();
        }, 1500);
      }
    });
  });
}

// -------------------------------------------
// 2. Asana Onboarding Checklist Renderer & Handlers
// -------------------------------------------
function renderAsanaOnboarding(tasks) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Asana Sync - Employee Onboarding Checklists</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Interactive task completion list synchronized with team workspace boards</p>
      </div>
      <button class="secondary-btn" id="asana-sync-btn" style="display: inline-flex; align-items: center; gap: 8px;">
        <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Sync with Asana API
      </button>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Onboarding Task</th>
            <th>Candidate</th>
            <th>Assignee</th>
            <th>Due Date</th>
            <th>Status</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => {
            const isCompleted = t.status === 'Completed';
            return `
              <tr>
                <td style="font-weight: 600; color: ${isCompleted ? 'var(--text-muted)' : 'var(--text-primary)'}; text-decoration: ${isCompleted ? 'line-through' : 'none'};">
                  ${t.title}
                </td>
                <td>${t.candidate}</td>
                <td>
                  <div style="display: inline-flex; align-items: center; gap: 6px;">
                    <div style="width: 24px; height: 24px; border-radius: 50%; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700;">
                      ${t.assignee.charAt(0)}
                    </div>
                    <span>${t.assignee}</span>
                  </div>
                </td>
                <td style="font-family: monospace; font-size: 0.85rem;">${t.dueDate}</td>
                <td>
                  <span class="status-badge" style="background-color: ${isCompleted ? 'hsl(var(--color-green))' : t.status === 'In Progress' ? 'hsl(var(--color-blue))' : 'var(--border-color)'}; color: ${isCompleted || t.status === 'In Progress' ? '#ffffff' : 'var(--text-secondary)'}; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;">
                    ${t.status}
                  </span>
                </td>
                <td style="text-align: right;">
                  ${isCompleted ? `
                    <span style="color: hsl(var(--color-green)); font-size: 0.8rem; font-weight: 600;"><i data-lucide="check" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> Done</span>
                  ` : `
                    <button class="secondary-btn complete-task-btn" data-id="${t.id}" style="padding: 4px 10px; font-size: 0.775rem;">Mark Complete</button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachAsanaHandlers(container, state, refreshView) {
  // Complete task
  const completeBtns = container.querySelectorAll('.complete-task-btn');
  completeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const task = state.hrAsanaTasks.find(t => t.id === id);
      if (task) {
        task.status = 'Completed';
        alert(`Task "${task.title}" updated in in-memory state and queued for Asana sync!`);
        refreshView();
      }
    });
  });

  // Sync button
  container.querySelector('#asana-sync-btn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="refresh-cw" class="animate-spin" style="width: 14px; height: 14px; margin-right: 6px;"></i> Fetching Asana tasks...`;
    lucide.createIcons();

    setTimeout(() => {
      alert('Asana checklist boards synced successfully. 0 new changes detected.');
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" style="width: 14px; height: 14px; margin-right: 6px;"></i> Sync with Asana API`;
      lucide.createIcons();
    }, 1200);
  });
}

// -------------------------------------------
// 3. Disclosures Log Renderer & Handlers
// -------------------------------------------
function renderDisclosures(disclosures) {
  return `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Zoning & Corporate Disclosures</h3>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">Conflict of interest disclosures, safety agreements, and employee NDAs sign-off sheets</p>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Employee Name</th>
            <th>Disclosure Type</th>
            <th>Sign-off Status</th>
            <th>Date Signed</th>
            <th>Document File</th>
            <th style="text-align: right;">View Doc</th>
          </tr>
        </thead>
        <tbody>
          ${disclosures.map(d => {
            const isSigned = d.status === 'Signed';
            return `
              <tr>
                <td style="font-weight: 600;">${d.name}</td>
                <td>${d.type}</td>
                <td>
                  <span class="status-badge" style="background-color: ${isSigned ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)'}; color: ${isSigned ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))'}; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; font-weight: 600;">
                    ${d.status}
                  </span>
                </td>
                <td style="font-family: monospace; font-size: 0.85rem;">${d.date}</td>
                <td style="font-family: monospace; font-size: 0.8rem; color: var(--text-secondary);">${d.file || '—'}</td>
                <td style="text-align: right;">
                  ${isSigned ? `
                    <button class="secondary-btn view-doc-btn" data-file="${d.file}" style="padding: 4px 10px; font-size: 0.775rem;">
                      <i data-lucide="eye" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> View
                    </button>
                  ` : `
                    <button class="primary-btn" style="padding: 4px 10px; font-size: 0.775rem; background-color: #000000; color: #ffffff;" onclick="alert('Sending sign-off notification email to candidate...')">
                      Request Signature
                    </button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachDisclosuresHandlers(container, state) {
  const viewBtns = container.querySelectorAll('.view-doc-btn');
  viewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const filename = btn.getAttribute('data-file');
      alert(`Opening simulated signed document vault: ${filename}\n\nGreens Nexus Enterprise Security verification check... OK.`);
    });
  });
}

// -------------------------------------------
// 4. Documents Vault Renderer & Handlers
// -------------------------------------------
function renderDocuments(documents) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Corporate Documents & Manuals</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Access internal handbooks, enrollment files, medical benefits sheets, and tax guides</p>
      </div>
      <button class="primary-btn" style="background-color: #000000; color: #ffffff;" onclick="alert('Opening secure file uploading dialog...')">
        <i data-lucide="upload" style="width: 14px; height: 14px; margin-right: 6px;"></i> Upload Policy File
      </button>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 16px;">
      ${documents.map(doc => {
        let docColor = 'hsl(var(--color-blue))';
        if (doc.category === 'Safety') docColor = 'hsl(var(--color-orange))';
        if (doc.category === 'Forms') docColor = 'hsl(var(--color-green))';
        if (doc.category === 'Benefits') docColor = 'hsl(var(--color-purple))';

        return `
          <div class="employee-card" style="display: flex; flex-direction: column; justify-content: space-between; height: 160px; padding: 16px;">
            <div style="display: flex; gap: 12px; align-items: flex-start;">
              <div style="width: 38px; height: 38px; border-radius: 6px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: ${docColor}; flex-shrink: 0;">
                <i data-lucide="file-text"></i>
              </div>
              <div style="overflow: hidden;">
                <strong style="font-size: 0.9rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${doc.name}</strong>
                <span style="font-size: 0.75rem; color: var(--text-secondary);">${doc.category} &bull; ${doc.size}</span>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
              <span style="font-size: 0.75rem; color: var(--text-muted);">Updated: ${doc.lastUpdated}</span>
              <button class="secondary-btn download-doc-btn" data-name="${doc.name}" style="padding: 4px 8px; font-size: 0.775rem;">
                <i data-lucide="download" style="width: 12px; height: 12px; margin-right: 4px;"></i> Download
              </button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function attachDocumentsHandlers(container, state) {
  const dlBtns = container.querySelectorAll('.download-doc-btn');
  dlBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      alert(`Simulating secure download for document: ${name}`);
    });
  });
}

// Bind to window
window.renderHR = renderHR;
