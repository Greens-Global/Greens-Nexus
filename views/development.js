// views/development.js
// Renders the Development / Real Estate view with Permit Status, Plans links, and Property Details

function renderDevelopment(container, state, navigateTo) {
  const activeSubTab = state.activeDevelopmentSubTab === 'dev-projects' || !state.activeDevelopmentSubTab ? 'dev-permits' : state.activeDevelopmentSubTab;

  const styleId = 'dev-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .dev-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .dev-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      .dev-tab-btn {
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
      .dev-tab-btn:hover {
        color: var(--text-primary);
      }
      .dev-tab-btn.active {
        color: var(--text-primary);
      }
      .dev-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .dev-tab-container {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }
      .plan-project-block {
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 20px;
        background-color: var(--bg-primary);
        margin-bottom: 16px;
      }
      .plan-item-link {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-radius: 6px;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        font-size: 0.85rem;
        cursor: pointer;
        transition: border-color var(--transition-fast);
      }
      .plan-item-link:hover {
        border-color: var(--border-hover);
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initialize Development Data if missing
  if (!state.developmentPermits) {
    state.developmentPermits = [
      { id: 1, project: 'Luxury Apartment Complex', permitNo: 'BLD-2026-00412', type: 'Zoning & Height Variance', agency: 'Oceanview Zoning Board', status: 'Approved', date: '2026-02-18' },
      { id: 2, project: 'Mixed-Use Development', permitNo: 'BLD-2026-08912', type: 'Foundation & Earth Retention', agency: 'City Building Department', status: 'Under Review', date: '2026-04-05' },
      { id: 3, project: 'Suburban Housing Project', permitNo: 'ENV-2026-31021', type: 'Stormwater Runoff Discharge', agency: 'Environmental Protection Agency', status: 'Approved', date: '2026-03-22' },
      { id: 4, project: 'Mixed-Use Development', permitNo: 'BLD-2026-09245', type: 'MEP Structural Engineering', agency: 'City Fire & Safety Division', status: 'Pending Action', date: '2026-05-10' }
    ];
  }

  if (!state.developmentPlans) {
    state.developmentPlans = {
      'Luxury Apartment Complex': [
        { name: 'Luxury Apartments - Architectural Layouts.pdf', category: 'Architectural Specs', revision: 'Rev 4', size: '12.4 MB' },
        { name: 'Luxury Apartments - MEP Drawing Grid.dwg', category: 'MEP Systems', revision: 'Rev 2', size: '24.1 MB' },
        { name: 'Luxury Apartments - Soils & Civil Engineering.pdf', category: 'Civil & Foundation', revision: 'Rev 1', size: '8.5 MB' }
      ],
      'Mixed-Use Development': [
        { name: 'Mixed-Use Retail - Structural Shell.dwg', category: 'Structural Shell', revision: 'Rev 3', size: '32.4 MB' },
        { name: 'Mixed-Use Retail - Electrical Wiring Grid.pdf', category: 'MEP Systems', revision: 'Rev 2', size: '14.8 MB' }
      ],
      'Suburban Housing Project': [
        { name: 'Suburban Phase 1 - Civil Grading Map.dwg', category: 'Civil Layout', revision: 'Rev 5', size: '16.2 MB' },
        { name: 'Suburban Housing - Model A Framing Specs.pdf', category: 'Architectural Specs', revision: 'Rev 3', size: '4.8 MB' }
      ]
    };
  }

  if (!state.propertyDetails) {
    state.propertyDetails = [
      { id: 1, name: 'Oceanview Parcel A-14', size: '4.2 Acres', zoning: 'R-4 High-Density Residential', parcelNo: 'APN-890-412-09', surveyor: 'Apex Surveying Ltd', cost: 12500000, titleStatus: 'Cleared & Insured' },
      { id: 2, name: 'Main Street Plaza Lot', size: '1.8 Acres', zoning: 'C-3 Central Business District', parcelNo: 'APN-312-089-22', surveyor: 'Precision Land Surveying', cost: 18000000, titleStatus: 'Cleared & Insured' },
      { id: 3, name: 'Green Valley Phase 2 Plot', size: '28.5 Acres', zoning: 'SUB-1 Suburban Residential', parcelNo: 'APN-540-310-44', surveyor: 'Valley Soil & Survey LLC', cost: 8400000, titleStatus: 'Pending Title Escrow' }
    ];
  }

  let tabContentHtml = '';
  switch (activeSubTab) {
    case 'dev-permits':
      tabContentHtml = renderPermitStatusTab(state.developmentPermits);
      break;
    case 'dev-plans':
      tabContentHtml = renderProjectPlansTab(state.developmentPlans);
      break;
    case 'dev-details':
      tabContentHtml = renderPropertyDetailsTab(state.propertyDetails);
      break;
  }

  container.innerHTML = `
    <div class="dev-view">
      <!-- Horizontal Tab Navigation -->
      <div class="dev-tabs-nav">
        <button class="dev-tab-btn ${activeSubTab === 'dev-permits' ? 'active' : ''}" data-tab="dev-permits">
          <i data-lucide="file-check" style="width: 18px; height: 18px;"></i> Permit Status
        </button>
        <button class="dev-tab-btn ${activeSubTab === 'dev-plans' ? 'active' : ''}" data-tab="dev-plans">
          <i data-lucide="map" style="width: 18px; height: 18px;"></i> Project Plans
        </button>
        <button class="dev-tab-btn ${activeSubTab === 'dev-details' ? 'active' : ''}" data-tab="dev-details">
          <i data-lucide="info" style="width: 18px; height: 18px;"></i> Property Details
        </button>
      </div>

      <!-- Tab Container -->
      <div class="dev-tab-container">
        ${tabContentHtml}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach horizontal tab listeners
  const tabBtns = container.querySelectorAll('.dev-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeDevelopmentSubTab = selectedTab;
      navigateTo('development');
    });
  });

  // Attach handlers
  if (activeSubTab === 'dev-permits') {
    attachPermitsHandlers(container, state, () => renderDevelopment(container, state, navigateTo));
  } else if (activeSubTab === 'dev-plans') {
    attachPlansHandlers(container, state);
  } else if (activeSubTab === 'dev-details') {
    attachDetailsHandlers(container, state, () => renderDevelopment(container, state, navigateTo));
  }
}

// -------------------------------------------
// 1. Projects Directory Tab
// -------------------------------------------
function renderDevProjectsTab(state) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Real Estate Development Projects</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Review active zoning, financing details, and timeline schedules</p>
      </div>
      <button class="primary-btn" id="add-dev-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="plus" style="width: 14px; height: 14px; margin-right: 6px;"></i> Register Development
      </button>
    </div>

    <div style="display: flex; flex-direction: column; gap: 12px;">
      ${state.devProjects.map(proj => {
        const isConstruction = proj.status === 'construction';
        const badgeBg = isConstruction ? '#111827' : 'var(--border-color)';
        const badgeText = isConstruction ? '#ffffff' : 'var(--text-secondary)';

        return `
          <div class="sop-update-row" style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; cursor: default; transition: border-color var(--transition-fast);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div style="display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <i data-lucide="building" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
                  <strong style="font-size: 1.05rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${proj.name}</strong>
                  <span class="status-badge" style="background-color: ${badgeBg}; color: ${badgeText}; font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${proj.status}</span>
                </div>
                <span style="font-size: 0.8rem; color: var(--text-secondary); padding-left: 26px;">${proj.type}</span>
              </div>
            </div>

            <!-- Metadata Row -->
            <div style="display: flex; flex-wrap: wrap; gap: 24px; font-size: 0.825rem; color: var(--text-secondary); align-items: center; padding-left: 26px;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <i data-lucide="map-pin" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
                <span>${proj.location}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <i data-lucide="dollar-sign" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
                <span>$${proj.cost}M</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <i data-lucide="calendar" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
                <span>${proj.dueDate}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <i data-lucide="trending-up" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
                <span>ROI: ${proj.roi}%</span>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Modal for New Development -->
    <div class="modal-overlay" id="dev-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New Development</h3>
          <button class="close-btn" id="close-dev-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-dev-form">
          <div class="form-grid">
            <div class="form-group form-group-full">
              <label for="dev-name">Development Project Name</label>
              <input type="text" id="dev-name" class="form-input" placeholder="e.g. Oakridge Phase 3" required>
            </div>
            <div class="form-group">
              <label for="dev-type">Category & Units</label>
              <input type="text" id="dev-type" class="form-input" placeholder="e.g. Residential • 60 units" required>
            </div>
            <div class="form-group">
              <label for="dev-status">Status</label>
              <select id="dev-status" class="form-select">
                <option value="planning" selected>planning</option>
                <option value="pre-construction">pre-construction</option>
                <option value="construction">construction</option>
              </select>
            </div>
            <div class="form-group">
              <label for="dev-location">Location District</label>
              <input type="text" id="dev-location" class="form-input" placeholder="e.g. Westlake District" required>
            </div>
            <div class="form-group">
              <label for="dev-cost">Value ($M)</label>
              <input type="number" id="dev-cost" class="form-input" min="1" placeholder="e.g. 24" required>
            </div>
            <div class="form-group">
              <label for="dev-due">Target Due Timeline</label>
              <input type="text" id="dev-due" class="form-input" placeholder="e.g. Q4 2027" required>
            </div>
            <div class="form-group">
              <label for="dev-roi">Estimated ROI (%)</label>
              <input type="number" id="dev-roi" class="form-input" min="1" placeholder="e.g. 18" required>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-dev-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save Project</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachDevProjectsHandlers(container, state, refreshView) {
  const addBtn = container.querySelector('#add-dev-btn');
  const modal = container.querySelector('#dev-modal');
  const closeBtn = container.querySelector('#close-dev-modal-btn');
  const cancelBtn = container.querySelector('#cancel-dev-modal-btn');
  const form = container.querySelector('#new-dev-form');

  addBtn.addEventListener('click', () => {
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
    const newProj = {
      id: Date.now(),
      name: container.querySelector('#dev-name').value,
      type: container.querySelector('#dev-type').value,
      status: container.querySelector('#dev-status').value,
      location: container.querySelector('#dev-location').value,
      cost: parseInt(container.querySelector('#dev-cost').value),
      dueDate: container.querySelector('#dev-due').value,
      roi: parseInt(container.querySelector('#dev-roi').value)
    };

    state.devProjects.unshift(newProj);
    closeModal();
    refreshView();
  });
}

// -------------------------------------------
// 2. Permit Status Tab
// -------------------------------------------
function renderPermitStatusTab(permits) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Zoning & Construction Permit Tracker</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Monitor city approvals, building permits, and height variance clearances</p>
      </div>
      <button class="secondary-btn" id="sync-permits-btn" style="display: inline-flex; align-items: center; gap: 6px;">
        <i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Sync City Database
      </button>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Project Site</th>
            <th>Permit Type</th>
            <th>Municipal Agency</th>
            <th>Permit Number</th>
            <th>Submitted Date</th>
            <th>Approval Status</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${permits.map(p => {
            const isApproved = p.status === 'Approved';
            return `
              <tr>
                <td style="font-weight: 600;">${p.project}</td>
                <td style="font-weight: 500; color: var(--text-secondary);">${p.type}</td>
                <td>${p.agency}</td>
                <td style="font-family: monospace; font-size: 0.8rem;">${p.permitNo}</td>
                <td style="font-family: monospace; font-size: 0.85rem;">${p.date}</td>
                <td>
                  <span class="status-badge" style="background-color: ${isApproved ? 'hsla(var(--color-green), 0.1)' : p.status === 'Under Review' ? 'hsla(var(--color-blue), 0.1)' : 'hsla(var(--color-orange), 0.1)'}; color: ${isApproved ? 'hsl(var(--color-green))' : p.status === 'Under Review' ? 'hsl(var(--color-blue))' : 'hsl(var(--color-orange))'}; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; font-weight: 600;">
                    ${p.status}
                  </span>
                </td>
                <td style="text-align: right;">
                  <button class="secondary-btn check-permit-single-btn" data-id="${p.id}" style="padding: 4px 10px; font-size: 0.75rem;">
                    Check Live Status
                  </button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachPermitsHandlers(container, state, refreshView) {
  // Sync button
  container.querySelector('#sync-permits-btn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="refresh-cw" class="animate-spin" style="width: 14px; height: 14px; margin-right: 6px;"></i> Connecting to municipal API...`;
    lucide.createIcons();

    setTimeout(() => {
      alert('Zoning boards databases queried. 0 status changes detected.');
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" style="width: 14px; height: 14px; margin-right: 6px;"></i> Sync City Database`;
      lucide.createIcons();
    }, 1200);
  });

  // Check single live status
  const checkBtns = container.querySelectorAll('.check-permit-single-btn');
  checkBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const p = state.developmentPermits.find(item => item.id === id);
      if (p) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="refresh-cw" class="animate-spin" style="width: 12px; height: 12px; margin-right: 4px;"></i> Checking...`;
        lucide.createIcons();

        setTimeout(() => {
          if (p.status !== 'Approved') {
            p.status = 'Approved';
            alert(`Permit ${p.permitNo} has been marked APPROVED on city servers!`);
          } else {
            alert(`Permit ${p.permitNo} verified: Status is current (Approved).`);
          }
          refreshView();
        }, 1000);
      }
    });
  });
}

// -------------------------------------------
// 3. Project Plans Tab
// -------------------------------------------
function renderProjectPlansTab(plans) {
  return `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Design Plans & Engineering Drawings</h3>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">Access blueprints, structural CAD files, and electrical drawing links by project site</p>
    </div>

    <div>
      ${Object.keys(plans).map(projName => {
        const drawings = plans[projName];
        return `
          <div class="plan-project-block">
            <h4 style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 0.95rem; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; color: var(--text-primary);">
              <i data-lucide="building" style="width: 18px; height: 18px; color: var(--text-secondary);"></i>
              ${projName}
            </h4>

            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
              ${drawings.map(d => `
                <div class="plan-item-link view-drawing-btn" data-proj="${projName}" data-name="${d.name}">
                  <div style="display: flex; gap: 10px; align-items: center;">
                    <i data-lucide="file" style="color: hsl(var(--color-blue)); width: 18px; height: 18px;"></i>
                    <div>
                      <strong style="color: var(--text-primary); display: block; font-size: 0.825rem; word-break: break-all;">${d.name}</strong>
                      <span style="font-size: 0.725rem; color: var(--text-secondary);">${d.category} &bull; ${d.revision}</span>
                    </div>
                  </div>
                  <i data-lucide="external-link" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function attachPlansHandlers(container, state) {
  const linkBtns = container.querySelectorAll('.view-drawing-btn');
  linkBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      const proj = btn.getAttribute('data-proj');
      alert(`Opening blueprint drawing viewer...\n\nProject: ${proj}\nDrawing File: ${name}\nVerify cloud tokens... Success.`);
    });
  });
}

// -------------------------------------------
// 4. Property Details Tab
// -------------------------------------------
function renderPropertyDetailsTab(properties) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Development Property Parcels</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Review details of acquired land, zoning classifications, and surveyor audits</p>
      </div>
      <button class="primary-btn" id="add-parcel-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="plus" style="width: 14px; height: 14px; margin-right: 6px;"></i> Add Land Parcel
      </button>
    </div>

    <div class="prop-grid">
      ${properties.map(p => `
        <div class="prop-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
            <div>
              <strong style="font-size: 1.05rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif; display: block;">${p.name}</strong>
              <span style="font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">${p.zoning}</span>
            </div>
            <i data-lucide="map-pin" style="color: var(--text-muted); width: 18px; height: 18px;"></i>
          </div>

          <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.825rem; margin-bottom: 16px; border-bottom: 1px dashed var(--border-color); padding-bottom: 12px;">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Parcel Number:</span>
              <strong style="color: var(--text-primary); font-family: monospace;">${p.parcelNo}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Total Acreage:</span>
              <strong style="color: var(--text-primary);">${p.size}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Acquisition Value:</span>
              <strong style="color: var(--text-primary);">$${(p.cost / 1000000).toFixed(1)}M</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Title Status:</span>
              <strong style="color: hsl(var(--color-green));">${p.titleStatus}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Lead Surveyor:</span>
              <strong style="color: var(--text-primary);">${p.surveyor}</strong>
            </div>
          </div>

          <div style="display: flex; gap: 8px;">
            <button class="secondary-btn" style="flex: 1; padding: 6px 12px; font-size: 0.8rem;" onclick="alert('Viewing comprehensive parcel maps, soil drilling core test results, and easement records...')">
              View Survey Report
            </button>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- Add Parcel Modal -->
    <div class="modal-overlay" id="parcel-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Register Land Parcel</h3>
          <button class="close-btn" id="close-parcel-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-parcel-form">
          <div class="form-grid">
            <div class="form-group form-group-full">
              <label for="parcel-name">Parcel Name</label>
              <input type="text" id="parcel-name" class="form-input" placeholder="e.g. Westlake Sector 4 Plot" required>
            </div>
            <div class="form-group">
              <label for="parcel-size">Total Acreage</label>
              <input type="text" id="parcel-size" class="form-input" placeholder="e.g. 5.6 Acres" required>
            </div>
            <div class="form-group">
              <label for="parcel-zoning">Zoning Class</label>
              <input type="text" id="parcel-zoning" class="form-input" placeholder="e.g. R-4 Multi-Family" required>
            </div>
            <div class="form-group">
              <label for="parcel-apn">APN Parcel Number</label>
              <input type="text" id="parcel-apn" class="form-input" placeholder="e.g. APN-920-112-40" required>
            </div>
            <div class="form-group">
              <label for="parcel-cost">Acquisition Cost ($)</label>
              <input type="number" id="parcel-cost" class="form-input" min="1" placeholder="e.g. 5000000" required>
            </div>
            <div class="form-group">
              <label for="parcel-surveyor">Lead Surveyor</label>
              <input type="text" id="parcel-surveyor" class="form-input" placeholder="e.g. Precise Lands surveying" required>
            </div>
            <div class="form-group">
              <label for="parcel-title">Title Status</label>
              <select id="parcel-title" class="form-select">
                <option value="Cleared & Insured" selected>Cleared & Insured</option>
                <option value="Pending Title Escrow">Pending Title Escrow</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-parcel-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save Parcel</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachDetailsHandlers(container, state, refreshView) {
  const addBtn = container.querySelector('#add-parcel-btn');
  const modal = container.querySelector('#parcel-modal');
  const closeBtn = container.querySelector('#close-parcel-modal-btn');
  const cancelBtn = container.querySelector('#cancel-parcel-modal-btn');
  const form = container.querySelector('#new-parcel-form');

  addBtn.addEventListener('click', () => {
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
    const newParcel = {
      id: Date.now(),
      name: container.querySelector('#parcel-name').value,
      size: container.querySelector('#parcel-size').value,
      zoning: container.querySelector('#parcel-zoning').value,
      parcelNo: container.querySelector('#parcel-apn').value,
      cost: parseInt(container.querySelector('#parcel-cost').value),
      surveyor: container.querySelector('#parcel-surveyor').value,
      titleStatus: container.querySelector('#parcel-title').value
    };

    state.propertyDetails.push(newParcel);
    closeModal();
    refreshView();
  });
}

// Bind to window
window.renderDevelopment = renderDevelopment;
