// views/operations.js
// Renders the Operations / Project Management view with Cubby integration

function renderOperations(container, state, navigateTo) {
  const activeSubTab = state.activeOpsSubTab || 'ops-dashboard';

  const styleId = 'ops-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .ops-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .ops-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      .ops-tab-btn {
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
      .ops-tab-btn:hover {
        color: var(--text-primary);
      }
      .ops-tab-btn.active {
        color: var(--text-primary);
      }
      .ops-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .cubby-vault-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }
      .cubby-browser {
        background-color: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
      }
      .cubby-browser-header {
        background-color: var(--bg-secondary);
        border-bottom: 1px solid var(--border-color);
        padding: 12px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .cubby-item-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 20px;
        border-bottom: 1px solid var(--border-color);
        cursor: pointer;
        transition: background-color var(--transition-fast);
      }
      .cubby-item-row:last-child {
        border-bottom: none;
      }
      .cubby-item-row:hover {
        background-color: var(--bg-secondary);
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initialize Cubby State if missing
  if (!state.cubbyCurrentDir) {
    state.cubbyCurrentDir = 'root'; // 'root' or folder name
    state.cubbyFolders = {
      'Blueprints & CAD drawings': [
        { name: 'downtown_foundation_v3.dwg', size: '12.4 MB', type: 'dwg', date: '2026-05-18' },
        { name: 'harbor_view_mep_v1.dwg', size: '18.1 MB', type: 'dwg', date: '2026-05-20' },
        { name: 'warehouse_framing.dwg', size: '8.2 MB', type: 'dwg', date: '2026-05-14' }
      ],
      'Subcontractor Bid logs': [
        { name: 'apex_concrete_bid_sealed.pdf', size: '1.2 MB', type: 'pdf', date: '2026-05-22' },
        { name: 'electric_bids_tabulation.xlsx', size: '480 KB', type: 'xlsx', date: '2026-05-19' }
      ],
      'Site Safety Audits': [
        { name: 'weekly_safety_check_may20.pdf', size: '1.4 MB', type: 'pdf', date: '2026-05-20' },
        { name: 'osha_compliance_report.pdf', size: '2.1 MB', type: 'pdf', date: '2026-05-10' }
      ],
      'Permits & Regulatory approvals': [
        { name: 'downtown_permit_approved.pdf', size: '820 KB', type: 'pdf', date: '2026-05-21' },
        { name: 'zoning_variance_harbor.pdf', size: '1.1 MB', type: 'pdf', date: '2026-05-15' }
      ]
    };
  }

  let tabContentHtml = '';
  switch (activeSubTab) {
    case 'ops-dashboard':
      tabContentHtml = renderOpsDashboard(state);
      break;
    case 'ops-cubby':
      tabContentHtml = renderCubbyIntegration(state);
      break;
  }

  container.innerHTML = `
    <div class="ops-view">
      <!-- Horizontal Tab Navigation -->
      <div class="ops-tabs-nav">
        <button class="ops-tab-btn ${activeSubTab === 'ops-dashboard' ? 'active' : ''}" data-tab="ops-dashboard">
          <i data-lucide="layout-dashboard" style="width: 18px; height: 18px;"></i> Project Dashboard
        </button>
        <button class="ops-tab-btn ${activeSubTab === 'ops-cubby' ? 'active' : ''}" data-tab="ops-cubby">
          <i data-lucide="folder-sync" style="width: 18px; height: 18px;"></i> Cubby Integration
        </button>
      </div>

      <!-- Tab Content Panel -->
      <div id="ops-tab-content">
        ${tabContentHtml}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach horizontal tab listeners
  const tabBtns = container.querySelectorAll('.ops-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeOpsSubTab = selectedTab;
      navigateTo('ops');
    });
  });

  // Attach handlers
  if (activeSubTab === 'ops-dashboard') {
    attachOpsDashboardHandlers(container, state, () => renderOperations(container, state, navigateTo));
  } else if (activeSubTab === 'ops-cubby') {
    attachCubbyHandlers(container, state, () => renderOperations(container, state, navigateTo));
  }
}

// -------------------------------------------
// 1. Ops Dashboard Renderer
// -------------------------------------------
function renderOpsDashboard(state) {
  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Construction Overview</h2>
        <p>Project management, logistics, and heavy machinery oversight</p>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="secondary-btn" id="ops-schedule-btn">Schedule Review</button>
        <button class="primary-btn" id="add-project-btn" style="background-color: #000000; color: #ffffff;">New Project</button>
      </div>
    </div>

    <!-- KPI Summary Cards (4 columns) -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header" style="margin-bottom: 12px;">
          <span class="kpi-title" style="color: var(--text-secondary);">Total Workforce</span>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">156</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">+8 this month</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header" style="margin-bottom: 12px;">
          <span class="kpi-title" style="color: var(--text-secondary);">Active Sites</span>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">12</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">+2 this month</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header" style="margin-bottom: 12px;">
          <span class="kpi-title" style="color: var(--text-secondary);">Safety Incidents</span>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">0</div>
        <div class="kpi-helper" style="color: var(--text-secondary);">0 this month</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header" style="margin-bottom: 12px;">
          <span class="kpi-title" style="color: var(--text-secondary);">Productivity</span>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">94%</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">+3% this month</div>
      </div>
    </div>

    <!-- Active Projects Section -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm);">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Active Projects</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Current construction and development projects</p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 16px;">
        ${state.opsProjects.map(proj => {
          const isDelayed = proj.status === 'delayed';
          const badgeBg = isDelayed ? 'hsl(var(--color-red))' : '#111827';
          
          return `
            <div class="sop-update-row" style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 12px; cursor: default; transition: border-color var(--transition-fast);">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <i data-lucide="folder" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
                    <strong style="font-size: 1.05rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${proj.name}</strong>
                    <span class="status-badge" style="background-color: ${badgeBg}; color: #ffffff; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px;">${proj.status}</span>
                  </div>
                  <!-- Meta info row -->
                  <div style="display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.8rem; color: var(--text-secondary); align-items: center;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <i data-lucide="map-pin" style="width: 12px; height: 12px;"></i>
                      <span>${proj.location}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <i data-lucide="users" style="width: 12px; height: 12px;"></i>
                      <span>${proj.members} members</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <i data-lucide="calendar" style="width: 12px; height: 12px;"></i>
                      <span>Due: ${proj.dueDate}</span>
                    </div>
                  </div>
                </div>
                <!-- Percentage -->
                <div style="font-size: 1.1rem; font-weight: 700; font-family: 'Inter', sans-serif; color: var(--text-primary);">${proj.progress}%</div>
              </div>
              <!-- Progress bar spanning horizontally -->
              <div style="width: 100%; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                <div style="width: ${proj.progress}%; height: 100%; background-color: #000000; border-radius: 3px;"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Split section: Logistics & Equipment -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <!-- Left: Logistics -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 16px;">
        <div>
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Logistics & Supply Chain</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Material deliveries and shipments</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${state.opsLogistics.map(ship => {
            const isDelivered = ship.status === 'delivered';
            const badgeBg = isDelivered ? '#111827' : 'var(--border-color)';
            const badgeText = isDelivered ? '#ffffff' : 'var(--text-secondary)';
            return `
              <div class="sop-update-row" style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; cursor: default; transition: border-color var(--transition-fast);">
                <div style="display: flex; gap: 12px; align-items: center;">
                  <i data-lucide="truck" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
                  <div>
                    <strong style="font-size: 0.95rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${ship.item}</strong>
                    <div style="font-size: 0.775rem; color: var(--text-secondary); margin-top: 2px;">${ship.destination} &bull; ETA: ${ship.eta}</div>
                  </div>
                </div>
                <span class="status-badge" style="background-color: ${badgeBg}; color: ${badgeText}; font-size: 0.7rem; padding: 4px 10px; border-radius: 20px; font-weight: 600;">${ship.status}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Right: Equipment -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 16px;">
        <div>
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Equipment Status</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Heavy machinery and equipment tracking</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${state.opsEquipment.map(eq => {
            const isAvailable = eq.status === 'available';
            const badgeBg = isAvailable ? '#111827' : 'var(--border-color)';
            const badgeText = isAvailable ? '#ffffff' : 'var(--text-secondary)';
            return `
              <div class="sop-update-row" style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; cursor: default; transition: border-color var(--transition-fast);">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                  <div style="display: flex; gap: 12px; align-items: center;">
                    <i data-lucide="settings" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
                    <div>
                      <strong style="font-size: 0.95rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${eq.name}</strong>
                      <div style="font-size: 0.775rem; color: var(--text-secondary); margin-top: 2px;">${eq.location}</div>
                    </div>
                  </div>
                  <span class="status-badge" style="background-color: ${badgeBg}; color: ${badgeText}; font-size: 0.7rem; padding: 4px 10px; border-radius: 20px; font-weight: 600;">${eq.status}</span>
                </div>
                ${eq.progress > 0 
                  ? `<div style="width: 100%; height: 4px; background-color: var(--border-color); border-radius: 2px; overflow: hidden; margin-top: 2px;">
                      <div style="width: ${eq.progress}%; height: 100%; background-color: #000000; border-radius: 2px;"></div>
                     </div>`
                  : ''
                }
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- Modal for New Project -->
    <div class="modal-overlay" id="project-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New Project</h3>
          <button class="close-btn" id="close-project-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-project-form">
          <div class="form-grid">
            <div class="form-group form-group-full">
              <label for="proj-name">Project Name</label>
              <input type="text" id="proj-name" class="form-input" placeholder="e.g. Oakridge Estate Phase 2" required>
            </div>
            <div class="form-group">
              <label for="proj-location">Location</label>
              <input type="text" id="proj-location" class="form-input" placeholder="e.g. Main Street, Downtown" required>
            </div>
            <div class="form-group">
              <label for="proj-members">Subcontractors Count</label>
              <input type="number" id="proj-members" class="form-input" min="1" placeholder="e.g. 15" required>
            </div>
            <div class="form-group">
              <label for="proj-due">Target Due Date</label>
              <input type="date" id="proj-due" class="form-input" required>
            </div>
            <div class="form-group">
              <label for="proj-progress">Initial Progress (%)</label>
              <input type="number" id="proj-progress" class="form-input" min="0" max="100" placeholder="e.g. 0" required>
            </div>
            <div class="form-group form-group-full">
              <label for="proj-status">Project Status</label>
              <select id="proj-status" class="form-select">
                <option value="on-track" selected>on-track</option>
                <option value="delayed">delayed</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-project-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Create Project</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachOpsDashboardHandlers(container, state, refreshView) {
  const addBtn = container.querySelector('#add-project-btn');
  const modal = container.querySelector('#project-modal');
  const closeBtn = container.querySelector('#close-project-modal-btn');
  const cancelBtn = container.querySelector('#cancel-project-modal-btn');
  const form = container.querySelector('#new-project-form');

  addBtn.addEventListener('click', () => {
    container.querySelector('#proj-due').valueAsDate = new Date();
    modal.style.display = 'flex';
  });

  const closeModal = () => {
    modal.style.display = 'none';
    form.reset();
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const dateInput = new Date(container.querySelector('#proj-due').value);
    const dateFormatted = dateInput.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const newProj = {
      id: Date.now(),
      name: container.querySelector('#proj-name').value,
      status: container.querySelector('#proj-status').value,
      location: container.querySelector('#proj-location').value,
      members: parseInt(container.querySelector('#proj-members').value),
      dueDate: dateFormatted,
      progress: parseInt(container.querySelector('#proj-progress').value)
    };

    state.opsProjects.push(newProj);
    closeModal();
    refreshView();
  });

  container.querySelector('#ops-schedule-btn').addEventListener('click', () => {
    alert('Opening logistics and project audit rosters scheduling card...');
  });
}

// -------------------------------------------
// 2. Cubby Integration Renderer & Handlers
// -------------------------------------------
function renderCubbyIntegration(state) {
  const isRoot = state.cubbyCurrentDir === 'root';
  let files = [];
  if (!isRoot) {
    files = state.cubbyFolders[state.cubbyCurrentDir] || [];
  }

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Cubby Secure Cloud Vault</h2>
        <p>Greens Nexus internal operations blueprint repository & subcontractor plans room</p>
      </div>
      <div style="display: flex; gap: 12px; align-items: center;">
        <button class="secondary-btn" id="cubby-sync-btn" style="display: inline-flex; align-items: center; gap: 6px;">
          <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Sync Vault
        </button>
        ${!isRoot ? `
          <button class="primary-btn" id="cubby-upload-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 6px;">
            <i data-lucide="upload" style="width: 14px; height: 14px;"></i> Upload Plan
          </button>
        ` : ''}
      </div>
    </div>

    <!-- Storage Statistics Cards (3 columns) -->
    <div class="cards-grid" style="grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default; padding: 16px 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.8rem;">Storage capacity</span>
          <i data-lucide="database" style="color: hsl(var(--color-blue)); width: 18px; height: 18px;"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.6rem; margin-top: 4px;">42.5 GB / 100 GB</div>
        <div style="width: 100%; height: 4px; background-color: var(--border-color); border-radius: 2px; overflow: hidden; margin-top: 8px;">
          <div style="width: 42.5%; height: 100%; background-color: hsl(var(--color-blue));"></div>
        </div>
      </div>

      <div class="kpi-card card-green" style="cursor: default; padding: 16px 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.8rem;">Active nodes connections</span>
          <i data-lucide="server" style="color: hsl(var(--color-green)); width: 18px; height: 18px;"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.6rem; margin-top: 4px;">3 Local Syncs</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600; font-size: 0.75rem; margin-top: 4px;">HQ Server, Trailers, Procore Sync</div>
      </div>

      <div class="kpi-card card-purple" style="cursor: default; padding: 16px 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary); font-size: 0.8rem;">Encryption Status</span>
          <i data-lucide="shield-check" style="color: hsl(var(--color-purple)); width: 18px; height: 18px;"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.6rem; margin-top: 4px;">AES-256 Enabled</div>
        <div class="kpi-helper" style="color: var(--text-secondary); font-size: 0.75rem; margin-top: 4px;">End-to-End vault encryption active</div>
      </div>
    </div>

    <!-- Directory Browser Layout -->
    <div class="cubby-vault-card" style="padding: 0;">
      <div class="cubby-browser">
        <div class="cubby-browser-header">
          <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.9rem; color: var(--text-primary);">
            <i data-lucide="folder-open" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
            <span>Cubby Root</span>
            ${!isRoot ? `
              <span>&bull;</span>
              <span style="color: hsl(var(--color-blue)); font-weight: 700;">${state.cubbyCurrentDir}</span>
            ` : ''}
          </div>
          ${!isRoot ? `
            <button class="secondary-btn" id="cubby-back-btn" style="padding: 4px 10px; font-size: 0.775rem;">
              <i data-lucide="arrow-left" style="width: 12px; height: 12px; margin-right: 4px;"></i> Up One Level
            </button>
          ` : `
            <span style="font-size: 0.75rem; color: var(--text-secondary);">Select a folder to browse files</span>
          `}
        </div>

        <div style="display: flex; flex-direction: column;">
          ${isRoot ? `
            <!-- Folder Lists -->
            ${Object.keys(state.cubbyFolders).map(folderName => {
              const fileCount = state.cubbyFolders[folderName].length;
              return `
                <div class="cubby-item-row folder-row" data-folder="${folderName}">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <i data-lucide="folder" style="color: hsl(var(--color-gold)); fill: hsla(var(--color-gold), 0.1); width: 22px; height: 22px;"></i>
                    <div>
                      <strong style="font-size: 0.9rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${folderName}</strong>
                      <span style="font-size: 0.75rem; color: var(--text-secondary); display: block; margin-top: 1px;">Cloud Vault Folder</span>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">${fileCount} items</span>
                    <i data-lucide="chevron-right" style="width: 16px; height: 16px; color: var(--text-muted);"></i>
                  </div>
                </div>
              `;
            }).join('')}
          ` : `
            <!-- File Lists inside folder -->
            ${files.length === 0 ? `
              <div style="text-align: center; padding: 40px; color: var(--text-secondary);">
                <i data-lucide="folder-open" style="width: 40px; height: 40px; margin-bottom: 8px; color: var(--text-muted); stroke-width: 1.5;"></i>
                <p style="font-size: 0.85rem; font-weight: 500;">This vault folder is empty.</p>
              </div>
            ` : files.map(file => {
              let fileIcon = 'file-text';
              let iconColor = 'var(--text-secondary)';
              if (file.type === 'dwg') { fileIcon = 'map'; iconColor = 'hsl(var(--color-blue))'; }
              if (file.type === 'pdf') { fileIcon = 'file-text'; iconColor = 'hsl(var(--color-red))'; }
              if (file.type === 'xlsx') { fileIcon = 'file-spreadsheet'; iconColor = 'hsl(var(--color-green))'; }

              return `
                <div class="cubby-item-row file-row" data-name="${file.name}">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <i data-lucide="${fileIcon}" style="color: ${iconColor}; width: 20px; height: 20px;"></i>
                    <div>
                      <strong style="font-size: 0.9rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${file.name}</strong>
                      <span style="font-size: 0.75rem; color: var(--text-secondary); display: block; margin-top: 1px;">Synced: ${file.date} &bull; ${file.size}</span>
                    </div>
                  </div>
                  <button class="secondary-btn cubby-download-btn" data-name="${file.name}" style="padding: 4px 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;">
                    <i data-lucide="download" style="width: 12px; height: 12px;"></i> Download
                  </button>
                </div>
              `;
            }).join('')}
          `}
        </div>
      </div>
    </div>
  `;
}

function attachCubbyHandlers(container, state, refreshView) {
  // Click folder row to enter directory
  const folderRows = container.querySelectorAll('.folder-row');
  folderRows.forEach(row => {
    row.addEventListener('click', () => {
      const folderName = row.getAttribute('data-folder');
      state.cubbyCurrentDir = folderName;
      refreshView();
    });
  });

  // Up level button click
  const backBtn = container.querySelector('#cubby-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state.cubbyCurrentDir = 'root';
      refreshView();
    });
  }

  // Sync button
  container.querySelector('#cubby-sync-btn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="refresh-cw" class="animate-spin" style="width: 14px; height: 14px; margin-right: 6px;"></i> Syncing cloud cache...`;
    lucide.createIcons();

    setTimeout(() => {
      alert('Cubby vault synced successfully with local storage nodes. All indices up to date.');
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" style="width: 14px; height: 14px; margin-right: 6px;"></i> Sync Vault`;
      lucide.createIcons();
    }, 1500);
  });

  // Download file button click
  const dlBtns = container.querySelectorAll('.cubby-download-btn');
  dlBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent row click if wired
      const name = btn.getAttribute('data-name');
      alert(`Retrieving encrypted file from Cubby Storage Cluster...\n\nDownloading: ${name}\nVerify AES keys... Success.`);
    });
  });

  // Upload file button click
  const uploadBtn = container.querySelector('#cubby-upload-btn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', () => {
      const filename = prompt('Enter drawing/plan filename to upload:');
      if (filename) {
        const cleanFilename = filename.includes('.') ? filename : filename + '.dwg';
        const ext = cleanFilename.split('.').pop().toLowerCase();
        
        const newFile = {
          name: cleanFilename,
          size: '4.5 MB',
          type: ext,
          date: new Date().toISOString().split('T')[0]
        };

        if (state.cubbyFolders[state.cubbyCurrentDir]) {
          state.cubbyFolders[state.cubbyCurrentDir].push(newFile);
          alert(`Successfully uploaded "${cleanFilename}" to Cubby ${state.cubbyCurrentDir} storage node!`);
          refreshView();
        }
      }
    });
  }
}

// Bind to window
window.renderOperations = renderOperations;
