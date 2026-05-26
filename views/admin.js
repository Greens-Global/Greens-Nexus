// views/admin.js
// Renders the Administration & Access Control dashboard panel matching the Figma screenshots

function renderAdmin(container, state, navigateTo) {
  // Inject scoped styles for Admin & Access Control view
  const styleId = 'admin-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .admin-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }

      /* Toggle Switches Section */
      .sso-section {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }

      .sso-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-weight: 700;
        font-size: 1.05rem;
        margin-bottom: 20px;
        color: var(--text-primary);
      }

      .toggles-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }

      .toggle-box {
        background-color: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 16px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: border-color var(--transition-fast);
      }

      .toggle-box:hover {
        border-color: var(--border-hover);
      }

      .toggle-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .toggle-title {
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--text-primary);
        font-family: 'Plus Jakarta Sans', sans-serif;
      }

      .toggle-sub {
        font-size: 0.8rem;
        color: var(--text-secondary);
      }

      /* iOS Style Switch */
      .ios-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
      }

      .ios-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .ios-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: var(--border-color);
        transition: .3s;
        border-radius: 24px;
      }

      .ios-slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background-color: #ffffff;
        transition: .3s;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      }

      input:checked + .ios-slider {
        background-color: #0b0f19;
      }

      [data-theme="dark"] input:checked + .ios-slider {
        background-color: #ffffff;
      }

      [data-theme="dark"] input:checked + .ios-slider:before {
        background-color: #0b0f19;
      }

      input:checked + .ios-slider:before {
        transform: translateX(20px);
      }

      /* User Access badges */
      .badge-access-admin {
        background-color: hsl(var(--color-red));
        color: #ffffff;
        padding: 4px 10px;
        border-radius: 20px;
        font-weight: 600;
        font-size: 0.75rem;
        display: inline-block;
      }

      .badge-access-manager {
        background-color: #0b0f19;
        color: #ffffff;
        padding: 4px 10px;
        border-radius: 20px;
        font-weight: 600;
        font-size: 0.75rem;
        display: inline-block;
      }
      [data-theme="dark"] .badge-access-manager {
        background-color: #ffffff;
        color: #0b0f19;
      }

      .badge-access-regular {
        background-color: var(--bg-secondary);
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        padding: 3px 9px;
        border-radius: 20px;
        font-weight: 600;
        font-size: 0.75rem;
        display: inline-block;
      }

      .pill-special-access {
        border: 1px solid var(--border-color);
        background-color: var(--bg-secondary);
        color: var(--text-secondary);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.75rem;
        display: inline-block;
        margin-right: 4px;
        margin-bottom: 2px;
        font-weight: 500;
      }

      .status-dot-active {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: hsl(var(--color-green));
        font-weight: 600;
        font-size: 0.85rem;
      }

      .status-dot-inactive {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--text-muted);
        font-weight: 600;
        font-size: 0.85rem;
      }

      .action-menu-btn {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background-color var(--transition-fast);
      }

      .action-menu-btn:hover {
        background-color: var(--bg-secondary);
        color: var(--text-primary);
      }

      /* Access logs success/failed */
      .badge-log-success {
        background-color: #0b0f19;
        color: #ffffff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.725rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        display: inline-block;
      }
      [data-theme="dark"] .badge-log-success {
        background-color: #ffffff;
        color: #0b0f19;
      }

      .badge-log-failed {
        background-color: hsla(var(--color-red), 0.1);
        color: hsl(var(--color-red));
        border: 1px solid hsla(var(--color-red), 0.2);
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 0.725rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        display: inline-block;
      }

      /* Search & filter panel */
      .search-users-wrapper {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .search-users-input-box {
        position: relative;
        display: flex;
        align-items: center;
      }

      .search-users-input-box i {
        position: absolute;
        left: 12px;
        color: var(--text-muted);
        width: 16px;
        height: 16px;
        pointer-events: none;
      }

      .search-users-input {
        padding: 8px 12px 8px 36px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        font-size: 0.875rem;
        outline: none;
        background-color: var(--bg-primary);
        color: var(--text-primary);
        width: 220px;
        transition: border-color var(--transition-fast), width var(--transition-fast);
      }

      .search-users-input:focus {
        border-color: var(--text-primary);
        width: 260px;
      }

      .filter-users-btn {
        background: none;
        border: 1px solid var(--border-color);
        color: var(--text-secondary);
        padding: 8px;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all var(--transition-fast);
      }

      .filter-users-btn:hover {
        background-color: var(--bg-secondary);
        border-color: var(--border-hover);
        color: var(--text-primary);
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Calculate dynamic stats
  const totalUsersCount = state.users.length;
  const activeUsersCount = state.users.filter(u => u.status === 'Active').length;
  const adminUsersCount = state.users.filter(u => u.accessLevel === 'Admin').length;
  const logsCount = state.accessLogs.length;

  const searchQuery = state.activeUserSearchQuery || '';

  // Filter users
  let filteredUsers = state.users;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredUsers = state.users.filter(u => 
      u.name.toLowerCase().includes(q) || 
      u.dept.toLowerCase().includes(q) || 
      u.role.toLowerCase().includes(q)
    );
  }

  container.innerHTML = `
    <div class="admin-view">
      <!-- Page Header -->
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>Administration & Access Control</h2>
          <p>Complete user management, role assignment, and access governance</p>
        </div>
        <div style="display: flex; gap: 12px; align-items: center;">
          <button class="secondary-btn" id="ldap-import-btn" style="display: inline-flex; align-items: center; gap: 8px;">
            <i data-lucide="download" style="width: 16px; height: 16px;"></i> Import Users
          </button>
          <button class="primary-btn" id="add-user-btn" style="background-color: #000000; color: #ffffff;">
            <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Add User
          </button>
        </div>
      </div>

      <!-- 4 KPI Cards -->
      <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 24px;">
        <!-- Total Users -->
        <div class="kpi-card" style="cursor: default; border: 1px solid var(--border-color); background-color: var(--bg-card); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm);">
          <div class="kpi-card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.9rem; font-weight: 600;">Total Users</span>
            <div class="kpi-icon-container" style="color: var(--text-muted);">
              <i data-lucide="users" style="width: 20px; height: 20px;"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2.2rem; font-weight: 700; font-family: 'Inter', sans-serif;">${totalUsersCount}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Across all departments</div>
        </div>

        <!-- Active Users -->
        <div class="kpi-card" style="cursor: default; border: 1px solid var(--border-color); background-color: var(--bg-card); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm);">
          <div class="kpi-card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.9rem; font-weight: 600;">Active Users</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
              <i data-lucide="check-circle" style="width: 20px; height: 20px;"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2.2rem; font-weight: 700; font-family: 'Inter', sans-serif; color: hsl(var(--color-green));">${activeUsersCount}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Currently active</div>
        </div>

        <!-- Admin Users -->
        <div class="kpi-card" style="cursor: default; border: 1px solid var(--border-color); background-color: var(--bg-card); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm);">
          <div class="kpi-card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.9rem; font-weight: 600;">Admin Users</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-red));">
              <i data-lucide="shield-alert" style="width: 20px; height: 20px;"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2.2rem; font-weight: 700; font-family: 'Inter', sans-serif; color: hsl(var(--color-red));">${adminUsersCount}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Full access rights</div>
        </div>

        <!-- Access Logs -->
        <div class="kpi-card" style="cursor: default; border: 1px solid var(--border-color); background-color: var(--bg-card); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm);">
          <div class="kpi-card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.9rem; font-weight: 600;">Access Logs</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-blue));">
              <i data-lucide="activity" style="width: 20px; height: 20px;"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2.2rem; font-weight: 700; font-family: 'Inter', sans-serif; color: hsl(var(--color-blue));">${logsCount}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">Recent activities</div>
        </div>
      </div>

      <!-- Single Sign-On & Access Management Panel -->
      <div class="sso-section">
        <div class="sso-section-header">
          <i data-lucide="lock" style="width: 18px; height: 18px; color: var(--text-secondary);"></i> Single Sign-On & Access Management
          <span style="font-weight: 400; font-size: 0.8rem; color: var(--text-muted); margin-left: 4px;">Configure unified authentication and access controls</span>
        </div>
        <div class="toggles-grid">
          <!-- SSO Enabled Toggle -->
          <div class="toggle-box">
            <div class="toggle-info">
              <span class="toggle-title">SSO Enabled</span>
              <span class="toggle-sub">Single point of access for all users</span>
            </div>
            <label class="ios-switch">
              <input type="checkbox" id="toggle-sso" ${state.adminSettings.ssoEnabled ? 'checked' : ''}>
              <span class="ios-slider"></span>
            </label>
          </div>

          <!-- MFA Toggle -->
          <div class="toggle-box">
            <div class="toggle-info">
              <span class="toggle-title">Multi-Factor Authentication</span>
              <span class="toggle-sub">Required for all users</span>
            </div>
            <label class="ios-switch">
              <input type="checkbox" id="toggle-mfa" ${state.adminSettings.mfaRequired ? 'checked' : ''}>
              <span class="ios-slider"></span>
            </label>
          </div>

          <!-- Department-Wise Access -->
          <div class="toggle-box">
            <div class="toggle-info">
              <span class="toggle-title">Department-Wise Access</span>
              <span class="toggle-sub">Automatic access based on department</span>
            </div>
            <label class="ios-switch">
              <input type="checkbox" id="toggle-dept" ${state.adminSettings.deptAccess ? 'checked' : ''}>
              <span class="ios-slider"></span>
            </label>
          </div>

          <!-- Auto-Import Users -->
          <div class="toggle-box">
            <div class="toggle-info">
              <span class="toggle-title">Auto-Import Users</span>
              <span class="toggle-sub">Pull from connected systems</span>
            </div>
            <label class="ios-switch">
              <input type="checkbox" id="toggle-import" ${state.adminSettings.autoImport ? 'checked' : ''}>
              <span class="ios-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- All Users List Card -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">All Users</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">View, assign roles, and manage user access</p>
          </div>
          <div class="search-users-wrapper">
            <div class="search-users-input-box">
              <i data-lucide="search"></i>
              <input type="text" class="search-users-input" id="search-users-field" placeholder="Search users..." value="${searchQuery}">
            </div>
            <button class="filter-users-btn" id="filter-users-trigger">
              <i data-lucide="sliders-horizontal" style="width: 18px; height: 18px;"></i>
            </button>
          </div>
        </div>
        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Employee Name</th>
                <th>Department</th>
                <th>Role</th>
                <th>Access Level</th>
                <th>Special Access</th>
                <th>Status</th>
                <th>Last Login</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${filteredUsers.map(user => {
                // Access Level badge
                let accessBadgeClass = 'badge-access-regular';
                if (user.accessLevel === 'Admin') {
                  accessBadgeClass = 'badge-access-admin';
                } else if (user.accessLevel === 'Manager') {
                  accessBadgeClass = 'badge-access-manager';
                }

                // Status formatting
                let statusHtml = '';
                if (user.status === 'Active') {
                  statusHtml = `<span class="status-dot-active"><i data-lucide="check-circle" style="width: 14px; height: 14px; fill: hsla(142, 70%, 45%, 0.1);"></i> Active</span>`;
                } else {
                  statusHtml = `<span class="status-dot-inactive"><i data-lucide="x-circle" style="width: 14px; height: 14px; fill: rgba(0,0,0,0.05); color: var(--text-muted);"></i> Inactive</span>`;
                }

                // Special Access Pills
                let specialPillsHtml = '';
                if (user.specialAccess && user.specialAccess.length > 0) {
                  specialPillsHtml = user.specialAccess.map((acc, index) => {
                    if (acc === '+1') {
                      return `<span class="pill-special-access" style="border-style: dashed; opacity: 0.7;">+1</span>`;
                    }
                    return `<span class="pill-special-access">${acc}</span>`;
                  }).join('');
                }

                return `
                  <tr>
                    <td style="font-weight: 600; color: var(--text-primary);">${user.name}</td>
                    <td>${user.dept}</td>
                    <td>${user.role}</td>
                    <td>
                      <span class="${accessBadgeClass}">${user.accessLevel}</span>
                    </td>
                    <td>
                      ${specialPillsHtml}
                    </td>
                    <td>
                      ${statusHtml}
                    </td>
                    <td style="font-family: 'Inter', sans-serif;">${user.lastLogin}</td>
                    <td style="text-align: right;">
                      <button class="action-menu-btn user-action-trigger" data-id="${user.id}">
                        <i data-lucide="more-vertical" style="width: 16px; height: 16px;"></i>
                      </button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Access Logs Section -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="margin-bottom: 20px; display: flex; align-items: center; gap: 8px;">
          <div style="color: var(--text-secondary);"><i data-lucide="activity" style="width: 20px; height: 20px;"></i></div>
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Access Logs</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">Recent access activities and security events</p>
          </div>
        </div>
        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Action</th>
                <th>Module</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${state.accessLogs.map(log => {
                const logBadgeClass = log.status === 'Success' ? 'badge-log-success' : 'badge-log-failed';
                return `
                  <tr>
                    <td style="font-family: 'Inter', sans-serif;">${log.timestamp}</td>
                    <td style="font-weight: 600;">${log.user}</td>
                    <td>${log.action}</td>
                    <td>${log.module}</td>
                    <td>
                      <span class="${logBadgeClass}">${log.status}</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Bottom Panel Actions -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 24px;">
        <!-- Card 1: Assign Roles -->
        <div class="sop-update-row bottom-admin-action" data-title="Assign Roles" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="shield"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Assign Roles</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Manage user roles and permissions</div>
          </div>
        </div>

        <!-- Card 2: Special Access -->
        <div class="sop-update-row bottom-admin-action" data-title="Special Access" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="key"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Special Access</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Grant custom permissions</div>
          </div>
        </div>

        <!-- Card 3: Department Access -->
        <div class="sop-update-row bottom-admin-action" data-title="Department Access" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="users"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Department Access</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Control department-wise access</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal: Add User -->
    <div class="modal-overlay" id="add-user-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add New User</h3>
          <button class="close-btn" id="close-user-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-user-form">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="new-user-name">Employee Name</label>
              <input type="text" id="new-user-name" class="form-input" placeholder="e.g. Alice Mitchell" required>
            </div>
            <div class="form-group">
              <label for="new-user-dept">Department</label>
              <select id="new-user-dept" class="form-select">
                <option value="IT">IT Support</option>
                <option value="Accounting">Accounting</option>
                <option value="OPS">Operations (OPS)</option>
                <option value="Development">Real Estate Development</option>
                <option value="Marketing">Marketing & Sales</option>
                <option value="Admin">HR / Administration</option>
              </select>
            </div>
            <div class="form-group">
              <label for="new-user-role">Role Title</label>
              <input type="text" id="new-user-role" class="form-input" placeholder="e.g. Network Engineer, Auditor" required>
            </div>
            <div class="form-group">
              <label for="new-user-access">Access Level</label>
              <select id="new-user-access" class="form-select">
                <option value="Admin">Admin</option>
                <option value="Manager">Manager</option>
                <option value="IT">IT Support</option>
                <option value="Accounting">Accounting</option>
                <option value="OPS">OPS</option>
                <option value="Development">Development</option>
                <option value="Marketing">Marketing</option>
                <option value="View Only" selected>View Only</option>
              </select>
            </div>
            <div class="form-group">
              <label for="new-user-special">Special Access (comma separated)</label>
              <input type="text" id="new-user-special" class="form-input" placeholder="e.g. Audit Logs, Site Safety">
            </div>
            <div class="form-group">
              <label for="new-user-status">Status</label>
              <select id="new-user-status" class="form-select">
                <option value="Active" selected>Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-user-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Add Employee</button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Bind Lucide Icons
  lucide.createIcons();

  // 1. LDAP Import action
  container.querySelector('#ldap-import-btn').addEventListener('click', () => {
    alert('Synchronizing user records with active corporate LDAP/Active Directory domain controller...');
  });

  // 2. Add User Modal Controls
  const addUserBtn = document.getElementById('add-user-btn');
  const userModal = document.getElementById('add-user-modal');
  const closeBtn = document.getElementById('close-user-modal-btn');
  const cancelBtn = document.getElementById('cancel-user-modal-btn');
  const form = document.getElementById('new-user-form');

  addUserBtn.addEventListener('click', () => {
    userModal.style.display = 'flex';
  });

  const closeModal = () => {
    userModal.style.display = 'none';
    form.reset();
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const specialVal = document.getElementById('new-user-special').value.trim();
    let specialAccessArray = ['None'];
    if (specialVal) {
      specialAccessArray = specialVal.split(',').map(s => s.trim());
    }

    // Format current date: "2026-05-25 06:40 PM"
    const now = new Date();
    const dateFormatted = now.toISOString().split('T')[0] + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const newUser = {
      id: Math.floor(100 + Math.random() * 900),
      name: document.getElementById('new-user-name').value.trim(),
      dept: document.getElementById('new-user-dept').value,
      role: document.getElementById('new-user-role').value.trim(),
      accessLevel: document.getElementById('new-user-access').value,
      specialAccess: specialAccessArray,
      status: document.getElementById('new-user-status').value,
      lastLogin: dateFormatted
    };

    state.users.unshift(newUser);

    // Push new access log entry
    state.accessLogs.unshift({
      timestamp: dateFormatted,
      user: newUser.name,
      action: 'Account created',
      module: 'User Management',
      status: 'Success'
    });

    closeModal();
    renderAdmin(container, state, navigateTo);
  });

  // 3. SSO Toggles State updates
  const toggles = [
    { id: 'toggle-sso', key: 'ssoEnabled' },
    { id: 'toggle-mfa', key: 'mfaRequired' },
    { id: 'toggle-dept', key: 'deptAccess' },
    { id: 'toggle-import', key: 'autoImport' }
  ];

  toggles.forEach(t => {
    const el = document.getElementById(t.id);
    el.addEventListener('change', () => {
      state.adminSettings[t.key] = el.checked;
    });
  });

  // 4. Search and filters
  const searchInput = document.getElementById('search-users-field');
  searchInput.addEventListener('input', (e) => {
    state.activeUserSearchQuery = e.target.value;
    
    // Quick inline live filter of rows instead of full reload to maintain focus!
    const query = e.target.value.toLowerCase();
    const tableRows = container.querySelectorAll('.req-table tbody tr');
    
    tableRows.forEach(row => {
      const textContent = row.textContent.toLowerCase();
      if (textContent.includes(query)) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
  });

  document.getElementById('filter-users-trigger').addEventListener('click', () => {
    alert('Filters: Filter employees by Status or Access Level.');
  });

  // 5. Actions Ellipsis options
  const actionTriggers = container.querySelectorAll('.user-action-trigger');
  actionTriggers.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      const user = state.users.find(u => u.id === id);
      if (user) {
        const option = confirm(`Manage ${user.name}:\n\n- Click OK to toggle status (Active / Inactive)\n- Click Cancel to keep current state.`);
        if (option) {
          user.status = user.status === 'Active' ? 'Inactive' : 'Active';
          renderAdmin(container, state, navigateTo);
        }
      }
    });
  });

  // 6. Bottom Helper cogs
  const bottomActions = container.querySelectorAll('.bottom-admin-action');
  bottomActions.forEach(panel => {
    panel.addEventListener('click', () => {
      const title = panel.getAttribute('data-title');
      alert(`Opening access governance console: ${title}...`);
    });
  });
}

// Bind to window for router execution
window.renderAdmin = renderAdmin;
