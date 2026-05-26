// views/propertyAsset.js
// Renders the Property Asset Management view: Portfolio Details, Warranties, As-Builts, Inspections

function renderPropertyAsset(container, state, navigateTo) {
  const activeSubTab = state.activePropertyAssetSubTab || 'asset-portfolio';

  const styleId = 'property-asset-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .prop-asset-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .asset-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      .asset-tab-btn {
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
      .asset-tab-btn:hover {
        color: var(--text-primary);
      }
      .asset-tab-btn.active {
        color: var(--text-primary);
      }
      .asset-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .prop-asset-container {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }
      .prop-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 20px;
        margin-top: 16px;
      }
      .prop-card {
        background-color: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 20px;
        transition: all var(--transition-fast);
      }
      .prop-card:hover {
        border-color: var(--border-hover);
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
      }
      .warranty-badge-critical {
        background-color: hsla(var(--color-red), 0.1);
        color: hsl(var(--color-red));
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
      }
      .warranty-badge-ok {
        background-color: hsla(var(--color-green), 0.1);
        color: hsl(var(--color-green));
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initialize Property Asset State if missing
  if (!state.propertiesPortfolio) {
    state.propertiesPortfolio = [
      { id: 1, name: 'Harbor View Condos', type: 'Residential Complex', units: 120, address: 'Harbor View District, Lot 14', purchaseCost: 45000000, yearBuilt: 2024, occupancyRate: 94, manager: 'Sarah Johnson' },
      { id: 2, name: 'Downtown Commercial Complex', type: 'Commercial Plaza', units: 45, address: '88 Main Street, Downtown', purchaseCost: 68000000, yearBuilt: 2023, occupancyRate: 98, manager: 'Michael Chen' },
      { id: 3, name: 'Oakridge Subdivision Phase 1', type: 'Subdivision Estate', units: 250, address: 'Green Valley Road, lot 8B', purchaseCost: 32000000, yearBuilt: 2025, occupancyRate: 85, manager: 'Robert Kim' },
      { id: 4, name: 'North Industrial Warehouse', type: 'Industrial Center', units: 8, address: 'North Industrial Zone', purchaseCost: 15000000, yearBuilt: 2022, occupancyRate: 100, manager: 'Marcus Vance' }
    ];
  }

  if (!state.equipmentWarranties) {
    state.equipmentWarranties = [
      { id: 1, equipName: 'Carrier VRF Commercial HVAC System', location: 'Downtown Complex - Block A', vendor: 'Carrier HVAC Corp', start: '2023-08-15', end: '2028-08-15', contact: 'tech-support@carrier.com', policyNo: 'WAR-CAR-90812' },
      { id: 2, equipName: 'Otis Gen2 Passenger Elevator Co', location: 'Harbor View Condos - Tower 1', vendor: 'Otis Elevator Inc', start: '2024-02-10', end: '2026-06-25', contact: 'service@otis.com', policyNo: 'WAR-OTIS-88219' }, // expiring soon!
      { id: 3, equipName: 'Cummins Diesel Emergency Generator', location: 'Downtown Complex - Basement B', vendor: 'Cummins Power Systems', start: '2023-09-01', end: '2027-09-01', contact: 'parts@cummins.com', policyNo: 'WAR-CUM-74021' },
      { id: 4, equipName: 'Square D High-Voltage Transformers', location: 'North Industrial Warehouse', vendor: 'Schneider Electric', start: '2022-11-20', end: '2032-11-20', contact: 'electrical@schneider.com', policyNo: 'WAR-SCH-11894' }
    ];
  }

  if (!state.asBuiltPlans) {
    state.asBuiltPlans = [
      { id: 1, projName: 'Downtown Commercial Complex', category: 'Architectural As-Built', filename: 'downtown_as_built_architectural.dwg', size: '42.5 MB', uploadDate: '2024-01-20' },
      { id: 2, projName: 'Downtown Commercial Complex', category: 'Electrical & MEP Plans', filename: 'downtown_as_built_mep.dwg', size: '68.1 MB', uploadDate: '2024-01-25' },
      { id: 3, projName: 'Harbor View Condos', category: 'Structural Foundation Plans', filename: 'harbor_view_structural_final.dwg', size: '28.3 MB', uploadDate: '2024-05-10' },
      { id: 4, projName: 'North Industrial Warehouse', category: 'Civil As-Built Site Layout', filename: 'north_warehouse_civil_asbuilt.pdf', size: '12.4 MB', uploadDate: '2023-03-12' }
    ];
  }

  if (!state.annualInspections) {
    state.annualInspections = [
      { id: 1, title: 'Annual Fire Sprinkler & Safety Inspection', property: 'Downtown Commercial Complex', agency: 'Metro Fire Department', date: '2025-09-12', nextDue: '2026-09-12', status: 'Compliant' },
      { id: 2, title: 'Elevator Safety & Certifications Audit', property: 'Harbor View Condos', agency: 'State Division of Building Safety', date: '2025-06-05', nextDue: '2026-06-05', status: 'Needs Inspection' },
      { id: 3, title: 'Structural Foundation Integrity Survey', property: 'North Industrial Warehouse', agency: 'Apex Structural Engineering', date: '2025-04-18', nextDue: '2026-04-18', status: 'Compliant' },
      { id: 4, title: 'RPZ Backflow Preventer Annual Audit', property: 'Downtown Commercial Complex', agency: 'Municipal Water Authority', date: '2026-05-20', nextDue: '2027-05-20', status: 'Compliant' }
    ];
  }

  let tabContentHtml = '';
  switch (activeSubTab) {
    case 'asset-portfolio':
      tabContentHtml = renderPortfolioTab(state.propertiesPortfolio);
      break;
    case 'asset-warranties':
      tabContentHtml = renderWarrantiesTab(state.equipmentWarranties);
      break;
    case 'asset-plans':
      tabContentHtml = renderAsBuiltPlansTab(state.asBuiltPlans);
      break;
    case 'asset-inspections':
      tabContentHtml = renderInspectionsTab(state.annualInspections);
      break;
  }

  container.innerHTML = `
    <div class="prop-asset-view">
      <!-- Horizontal Tab Navigation -->
      <div class="asset-tabs-nav">
        <button class="asset-tab-btn ${activeSubTab === 'asset-portfolio' ? 'active' : ''}" data-tab="asset-portfolio">
          <i data-lucide="layout-grid" style="width: 18px; height: 18px;"></i> Property Portfolio
        </button>
        <button class="asset-tab-btn ${activeSubTab === 'asset-warranties' ? 'active' : ''}" data-tab="asset-warranties">
          <i data-lucide="shield" style="width: 18px; height: 18px;"></i> Equipment Warranties
        </button>
        <button class="asset-tab-btn ${activeSubTab === 'asset-plans' ? 'active' : ''}" data-tab="asset-plans">
          <i data-lucide="file-text" style="width: 18px; height: 18px;"></i> As-Built Plans
        </button>
        <button class="asset-tab-btn ${activeSubTab === 'asset-inspections' ? 'active' : ''}" data-tab="asset-inspections">
          <i data-lucide="clipboard-check" style="width: 18px; height: 18px;"></i> Annual Inspections
        </button>
      </div>

      <!-- Tab Content -->
      <div class="prop-asset-container">
        ${tabContentHtml}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach horizontal tab listeners
  const tabBtns = container.querySelectorAll('.asset-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activePropertyAssetSubTab = selectedTab;
      navigateTo('property-asset');
    });
  });

  // Attach handlers
  if (activeSubTab === 'asset-portfolio') {
    attachPortfolioHandlers(container, state, () => renderPropertyAsset(container, state, navigateTo));
  } else if (activeSubTab === 'asset-warranties') {
    attachWarrantiesHandlers(container, state);
  } else if (activeSubTab === 'asset-plans') {
    attachAsBuiltHandlers(container, state);
  } else if (activeSubTab === 'asset-inspections') {
    attachInspectionsHandlers(container, state, () => renderPropertyAsset(container, state, navigateTo));
  }
}

// -------------------------------------------
// 1. Property Portfolio Tab
// -------------------------------------------
function renderPortfolioTab(properties) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Real Estate Property Portfolio</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Review values, geographic addresses, capacities, and active managers</p>
      </div>
      <button class="primary-btn" id="add-property-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="plus" style="width: 14px; height: 14px; margin-right: 6px;"></i> Add Property Asset
      </button>
    </div>

    <div class="prop-grid">
      ${properties.map(p => `
        <div class="prop-card">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
            <div>
              <strong style="font-size: 1.05rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif; display: block;">${p.name}</strong>
              <span style="font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">${p.type}</span>
            </div>
            <span style="font-size: 0.85rem; font-weight: 700; color: hsl(var(--color-green));">${p.occupancyRate}% Occupied</span>
          </div>

          <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.825rem; margin-bottom: 16px; border-bottom: 1px dashed var(--border-color); padding-bottom: 12px;">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Address:</span>
              <strong style="color: var(--text-primary);">${p.address}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Units/Suites:</span>
              <strong style="color: var(--text-primary);">${p.units} units</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Acquisition Cost:</span>
              <strong style="color: var(--text-primary);">$${(p.purchaseCost / 1000000).toFixed(1)}M</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Year Completed:</span>
              <strong style="color: var(--text-primary);">${p.yearBuilt}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-secondary);">Asset Manager:</span>
              <strong style="color: var(--text-primary);">${p.manager}</strong>
            </div>
          </div>

          <div style="display: flex; gap: 8px;">
            <button class="secondary-btn" style="flex: 1; padding: 6px 12px; font-size: 0.8rem;" onclick="alert('Viewing comprehensive building specifications, architectural appraisals, and tax structures...')">
              View Details
            </button>
            <button class="secondary-btn" style="padding: 6px 8px;" onclick="alert('Opening properties occupancy registers...')">
              <i data-lucide="users" style="width: 14px; height: 14px;"></i>
            </button>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- Add Property Modal -->
    <div class="modal-overlay" id="prop-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Register Property Asset</h3>
          <button class="close-btn" id="close-prop-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-prop-form">
          <div class="form-grid">
            <div class="form-group form-group-full">
              <label for="prop-name">Property Name</label>
              <input type="text" id="prop-name" class="form-input" placeholder="e.g. Greens Plaza East" required>
            </div>
            <div class="form-group">
              <label for="prop-type">Property Category</label>
              <input type="text" id="prop-type" class="form-input" placeholder="e.g. Mixed-Use Commercial" required>
            </div>
            <div class="form-group">
              <label for="prop-units">Total Units/Suites</label>
              <input type="number" id="prop-units" class="form-input" min="1" placeholder="e.g. 64" required>
            </div>
            <div class="form-group form-group-full">
              <label for="prop-address">Geographic Address</label>
              <input type="text" id="prop-address" class="form-input" placeholder="e.g. 101 North Boulevard, Sector 4" required>
            </div>
            <div class="form-group">
              <label for="prop-cost">Acquisition Cost ($)</label>
              <input type="number" id="prop-cost" class="form-input" min="1" placeholder="e.g. 24000000" required>
            </div>
            <div class="form-group">
              <label for="prop-year">Year Completed</label>
              <input type="number" id="prop-year" class="form-input" min="1900" max="2030" placeholder="e.g. 2025" required>
            </div>
            <div class="form-group">
              <label for="prop-occupancy">Initial Occupancy (%)</label>
              <input type="number" id="prop-occupancy" class="form-input" min="0" max="100" placeholder="e.g. 90" required>
            </div>
            <div class="form-group">
              <label for="prop-manager">Assigned Asset Manager</label>
              <input type="text" id="prop-manager" class="form-input" placeholder="e.g. Sarah Johnson" required>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-prop-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save Asset</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachPortfolioHandlers(container, state, refreshView) {
  const addBtn = container.querySelector('#add-property-btn');
  const modal = container.querySelector('#prop-modal');
  const closeBtn = container.querySelector('#close-prop-modal-btn');
  const cancelBtn = container.querySelector('#cancel-prop-modal-btn');
  const form = container.querySelector('#new-prop-form');

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
    const newProp = {
      id: Date.now(),
      name: container.querySelector('#prop-name').value,
      type: container.querySelector('#prop-type').value,
      units: parseInt(container.querySelector('#prop-units').value),
      address: container.querySelector('#prop-address').value,
      purchaseCost: parseInt(container.querySelector('#prop-cost').value),
      yearBuilt: parseInt(container.querySelector('#prop-year').value),
      occupancyRate: parseInt(container.querySelector('#prop-occupancy').value),
      manager: container.querySelector('#prop-manager').value
    };

    state.propertiesPortfolio.push(newProp);
    closeModal();
    refreshView();
  });
}

// -------------------------------------------
// 2. Equipment Warranties Tab
// -------------------------------------------
function renderWarrantiesTab(warranties) {
  const currentDate = new Date('2026-05-25');
  return `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Building Systems & Equipment Warranties</h3>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">Track structural machinery policies, supplier contacts, and contract terms</p>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Equipment Name</th>
            <th>Location Site</th>
            <th>Manufacturer/Vendor</th>
            <th>Policy Number</th>
            <th>Warranty Period</th>
            <th>Mfr Support</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${warranties.map(w => {
            const expDate = new Date(w.end);
            const timeDiff = expDate - currentDate;
            const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
            const isExpiringSoon = daysDiff <= 45;

            return `
              <tr>
                <td style="font-weight: 600;">${w.equipName}</td>
                <td>${w.location}</td>
                <td>${w.vendor}</td>
                <td style="font-family: monospace; font-size: 0.8rem;">${w.policyNo}</td>
                <td style="font-size: 0.85rem;">
                  <div style="display: flex; flex-direction: column; gap: 2px;">
                    <span>Start: ${w.start}</span>
                    <span style="font-weight: 600; color: ${isExpiringSoon ? 'hsl(var(--color-red))' : 'var(--text-secondary)'};">End: ${w.end}</span>
                  </div>
                </td>
                <td>
                  <a href="mailto:${w.contact}" style="color: hsl(var(--color-blue)); font-weight: 500; font-size: 0.85rem; text-decoration: none;">
                    ${w.contact}
                  </a>
                </td>
                <td>
                  <span class="${isExpiringSoon ? 'warranty-badge-critical' : 'warranty-badge-ok'}">
                    ${isExpiringSoon ? `Expiring Soon (${daysDiff}d)` : 'Active Policy'}
                  </span>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachWarrantiesHandlers(container, state) {}

// -------------------------------------------
// 3. As-Built Plans Tab
// -------------------------------------------
function renderAsBuiltPlansTab(plans) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">As-Built Blueprints & Specifications</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Access verified final blueprints and engineering specifications for post-construction maintenance</p>
      </div>
      <button class="primary-btn" style="background-color: #000000; color: #ffffff;" onclick="alert('Opening CAD blueprint vault uploader...')">
        <i data-lucide="upload-cloud" style="width: 14px; height: 14px; margin-right: 6px;"></i> Upload CAD Drawing
      </button>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Property Project</th>
            <th>Category & Drawing Type</th>
            <th>Filename</th>
            <th>File Size</th>
            <th>Date Synced</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${plans.map(p => `
            <tr>
              <td style="font-weight: 600;">${p.projName}</td>
              <td style="font-weight: 500; color: var(--text-secondary);">${p.category}</td>
              <td style="font-family: monospace; font-size: 0.8rem;">${p.filename}</td>
              <td style="font-size: 0.85rem;">${p.size}</td>
              <td style="font-family: monospace; font-size: 0.85rem;">${p.uploadDate}</td>
              <td style="text-align: right;">
                <button class="secondary-btn download-plan-btn" data-filename="${p.filename}" style="padding: 4px 10px; font-size: 0.775rem;">
                  <i data-lucide="download" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> Download DWG
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachAsBuiltHandlers(container, state) {
  const dlBtns = container.querySelectorAll('.download-plan-btn');
  dlBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const fn = btn.getAttribute('data-filename');
      alert(`Connecting to Greens Nexus CAD Vault...\n\nDownloading file: ${fn}\nSize verification complete.`);
    });
  });
}

// -------------------------------------------
// 4. Annual Safety Inspections Tab
// -------------------------------------------
function renderInspectionsTab(inspections) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Annual Safety Inspections Compliance</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Track fire alarms, elevator systems, RPZ backflow preventers, and structural safety certifications</p>
      </div>
      <button class="primary-btn" id="trigger-inspections-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="clipboard-check" style="width: 14px; height: 14px; margin-right: 6px;"></i> Schedule Audit
      </button>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Audit Title</th>
            <th>Property Site</th>
            <th>Certifying Agency</th>
            <th>Last Inspected</th>
            <th>Next Due Date</th>
            <th>Compliance Status</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${inspections.map(ins => {
            const isCompliant = ins.status === 'Compliant';
            return `
              <tr>
                <td style="font-weight: 600;">${ins.title}</td>
                <td>${ins.property}</td>
                <td style="font-weight: 500; color: var(--text-secondary);">${ins.agency}</td>
                <td style="font-family: monospace; font-size: 0.85rem;">${ins.date}</td>
                <td style="font-family: monospace; font-size: 0.85rem; font-weight: 600; color: ${isCompliant ? 'var(--text-secondary)' : 'hsl(var(--color-red))'};">${ins.nextDue}</td>
                <td>
                  <span class="status-badge" style="background-color: ${isCompliant ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)'}; color: ${isCompliant ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))'}; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; font-weight: 600;">
                    ${ins.status}
                  </span>
                </td>
                <td style="text-align: right;">
                  ${isCompliant ? `
                    <button class="secondary-btn" style="padding: 4px 8px; font-size: 0.75rem;" onclick="alert('Viewing official agency certification PDF...')">View Certificate</button>
                  ` : `
                    <button class="primary-btn perform-inspect-btn" data-id="${ins.id}" style="padding: 4px 8px; font-size: 0.75rem; background-color: #000000; color: #ffffff;">Record Compliance</button>
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

function attachInspectionsHandlers(container, state, refreshView) {
  const completeBtns = container.querySelectorAll('.perform-inspect-btn');
  completeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const ins = state.annualInspections.find(i => i.id === id);
      if (ins) {
        ins.status = 'Compliant';
        ins.date = new Date().toISOString().split('T')[0];
        const nextDate = new Date();
        nextDate.setFullYear(nextDate.getFullYear() + 1);
        ins.nextDue = nextDate.toISOString().split('T')[0];
        alert(`Inspections records successfully updated for ${ins.property}. Site certificate verified.`);
        refreshView();
      }
    });
  });

  container.querySelector('#trigger-inspections-btn').addEventListener('click', () => {
    alert('Opening building safety agency scheduling dashboard...');
  });
}

// Bind to window
window.renderPropertyAsset = renderPropertyAsset;
