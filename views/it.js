// views/it.js
// Renders the unified IT & Website Management dashboard

function renderIT(container, state, navigateTo) {
  const activeSubTab = state.activeITSubTab || 'access';

  // Inject scoped styles for IT & Website view
  const styleId = 'it-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .it-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      
      /* Sub-tab navigation */
      .it-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      
      .it-tab-btn {
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
      
      .it-tab-btn:hover {
        color: var(--text-primary);
      }
      
      .it-tab-btn.active {
        color: var(--text-primary);
      }
      
      .it-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }

      /* Website rows and cards */
      .website-rows-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .website-row-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        transition: transform var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
        cursor: pointer;
      }

      .website-row-card:hover {
        border-color: var(--border-hover);
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .web-info-left {
        display: flex;
        gap: 16px;
        align-items: flex-start;
      }

      .web-globe-icon-circle {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        flex-shrink: 0;
      }

      .web-text-details {
        display: flex;
        flex-direction: column;
      }

      .web-title-txt {
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-weight: 700;
        font-size: 1.05rem;
        color: var(--text-primary);
      }

      .web-domain-txt {
        font-size: 0.85rem;
        color: var(--text-secondary);
        margin-top: 2px;
        font-family: monospace;
      }

      .web-meta-row {
        display: flex;
        gap: 16px;
        align-items: center;
        margin-top: 10px;
      }

      .web-meta-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.8rem;
        color: var(--text-secondary);
      }

      .web-status-badge-online {
        background-color: #0b0f19;
        color: #ffffff;
        padding: 4px 12px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        text-align: center;
      }
      [data-theme="dark"] .web-status-badge-online {
        background-color: #ffffff;
        color: #0b0f19;
      }

      .web-status-badge-offline {
        background-color: hsl(var(--color-red));
        color: #ffffff;
        padding: 4px 12px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        text-align: center;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initial markup shell with switcher
  container.innerHTML = `
    <div class="it-view">
      <!-- Merged Sub-tab Switcher -->
      <div class="it-tabs-nav">
        <button class="it-tab-btn ${activeSubTab === 'access' ? 'active' : ''}" data-tab="access">
          <i data-lucide="shield-check" style="width: 18px; height: 18px;"></i> Access Management
        </button>
        <button class="it-tab-btn ${activeSubTab === 'website' ? 'active' : ''}" data-tab="website">
          <i data-lucide="globe" style="width: 18px; height: 18px;"></i> Website Management
        </button>
        <button class="it-tab-btn ${activeSubTab === 'integrations' ? 'active' : ''}" data-tab="integrations">
          <i data-lucide="cpu" style="width: 18px; height: 18px;"></i> API & Integrations
        </button>
        <button class="it-tab-btn ${activeSubTab === 'asset' ? 'active' : ''}" data-tab="asset">
          <i data-lucide="package" style="width: 18px; height: 18px;"></i> Hardware Assets
        </button>
        <button class="it-tab-btn ${activeSubTab === 'network' ? 'active' : ''}" data-tab="network">
          <i data-lucide="wifi" style="width: 18px; height: 18px;"></i> Network Management
        </button>
      </div>

      <!-- Active Subtab Panel Content -->
      <div id="it-panel-content">
        ${activeSubTab === 'access' ? renderAccessManagement(state) : 
          activeSubTab === 'website' ? renderWebsiteManagement(state) : 
          activeSubTab === 'integrations' ? renderITIntegrations(state) : 
          activeSubTab === 'asset' ? renderAssetManagement(state) : 
          renderNetworkManagement(state)}
      </div>
    </div>
  `;

  // Bind Lucide Icons
  lucide.createIcons();

  // Attach event handlers for the Sub-tab Navigation
  const tabBtns = container.querySelectorAll('.it-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeITSubTab = selectedTab;
      navigateTo('it');
    });
  });

  // Attach handlers depending on active sub-tab
  if (activeSubTab === 'access') {
    attachAccessHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'website') {
    attachWebsiteHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'integrations') {
    attachITHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'asset') {
    attachAssetHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'network') {
    attachNetworkHandlers(container, state, navigateTo);
  }
}

// ----------------------------------------------------
// 1. IT Integrations Tab Renderer & Handlers
// ----------------------------------------------------
function renderITIntegrations(state) {
  // Read search query if search input exists
  const searchInput = document.getElementById('it-log-search');
  const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

  // Filter change log rows
  const filteredLogs = state.itChangeLogs.filter(log => {
    if (!searchQuery) return true;
    return log.user.toLowerCase().includes(searchQuery) ||
           log.action.toLowerCase().includes(searchQuery) ||
           log.module.toLowerCase().includes(searchQuery) ||
           log.details.toLowerCase().includes(searchQuery);
  });

  // Systems config
  const systems = [
    { name: 'Intacct', icon: 'database', time: '2 min ago', status: 'LIVE', detail: '' },
    { name: 'Asana', icon: 'check-circle', time: '5 min ago', status: 'LIVE', detail: '' },
    { name: 'UniFi', icon: 'router', time: '1 min ago', status: 'LIVE', detail: '' },
    { name: 'MS Outlook', icon: 'mail', time: '1 min ago', status: 'SYNCING', detail: '12 Unanswered Customer Emails' },
    { name: 'MS Teams', icon: 'message-square', time: '3 min ago', status: 'LIVE', detail: 'Flowace integrated &mdash; voice activity & time tracking active' },
    { name: 'Egnyte', icon: 'folder', time: '4 min ago', status: 'LIVE', detail: '' },
    { name: 'HB/Cubby', icon: 'server', time: '45 min ago', status: 'DISCONNECTED', detail: '' },
    { name: 'Flowace', icon: 'clock', time: '2 min ago', status: 'LIVE', detail: '' },
    { name: 'Ubiquiti', icon: 'network', time: '1 min ago', status: 'LIVE', detail: '' },
    { name: 'PowerBI', icon: 'bar-chart', time: '6 min ago', status: 'LIVE', detail: '<a href="#" id="powerbi-link" style="color: var(--text-secondary); font-size: 0.8rem; font-weight: 600; text-decoration: none;">Open Dashboard &rarr;</a>' }
  ];

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>API & Integrations</h2>
        <p>Manage external webhooks, API access tokens, and system connections</p>
      </div>
    </div>

    <!-- CONNECTED SYSTEMS Section -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <div>
          <h3 style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-primary); font-weight: 700;">Connected APIs & Integrations</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Live status for all system integration endpoints</p>
        </div>
        <button class="primary-btn" id="generate-api-key-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; padding: 8px 16px;">
          <i data-lucide="key" style="width: 14px; height: 14px;"></i> Generate API Key
        </button>
      </div>

      <div class="cards-grid" style="grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 0;">
        ${systems.map(sys => {
          let statusBadgeClass = 'status-badge status-approved';
          if (sys.status === 'SYNCING') {
            statusBadgeClass = 'status-badge status-pending';
          } else if (sys.status === 'DISCONNECTED') {
            statusBadgeClass = 'status-badge status-rejected';
          }

          // Draw status blocks (10 blocks)
          let blocksHtml = '';
          if (sys.status === 'DISCONNECTED') {
            for (let i = 0; i < 10; i++) {
              blocksHtml += `<div style="flex: 1; height: 2px; background-color: hsl(var(--color-red)); border-radius: 1px; opacity: 0.35;"></div>`;
            }
          } else {
            for (let i = 0; i < 10; i++) {
              blocksHtml += `<div style="flex: 1; height: 12px; background-color: var(--border-color); border-radius: 3px;"></div>`;
            }
          }

          return `
            <div class="kpi-card" style="padding: 20px; border-radius: 8px; cursor: default; border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 12px; --card-hue: var(--color-blue); justify-content: space-between;">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <i data-lucide="${sys.icon}" style="width: 20px; height: 20px; color: var(--text-secondary);"></i>
                    <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">${sys.name}</strong>
                  </div>
                  <span class="${statusBadgeClass}" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; text-transform: uppercase;">${sys.status}</span>
                </div>
                <span style="font-size: 0.75rem; color: var(--text-secondary); padding-left: 30px;">${sys.time}</span>
              </div>

              <!-- Status Bars -->
              <div style="display: flex; gap: 4px; align-items: center; margin: 4px 0;">
                ${blocksHtml}
              </div>

              <!-- Sub-detail text -->
              ${sys.detail ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">${sys.detail}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- FILE LABELLING & AUTOMATION Section -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
      <!-- Left: AI Labelling Tool -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; justify-content: space-between; gap: 20px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div style="display: flex; gap: 12px; align-items: center;">
              <i data-lucide="sparkles" style="width: 20px; height: 20px; color: var(--text-secondary);"></i>
              <div>
                <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">AI Labelling Tool</h4>
                <p style="color: var(--text-secondary); font-size: 0.8rem;">Label files using OpenAI API calls</p>
              </div>
            </div>
            
            <label class="switch-container">
              <input type="checkbox" id="ai-label-toggle" ${state.itConfig.aiLabellingActive ? 'checked' : ''}>
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; font-family: monospace; font-size: 0.85rem;">
          <span>$0.002</span>
          <span style="color: var(--text-secondary); font-size: 0.75rem;">per call</span>
        </div>
      </div>

      <!-- Right: Unsorted Checker -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; justify-content: space-between; gap: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="display: flex; gap: 12px; align-items: center;">
            <i data-lucide="tag" style="width: 20px; height: 20px; color: var(--text-secondary);"></i>
            <div>
              <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Unsorted/Unlabelled Checker</h4>
              <p style="color: var(--text-secondary); font-size: 0.8rem;">Scan for unlabelled files</p>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 2px;" id="checker-status-text">Last run: ${state.itConfig.checkerLastRun}</div>
            <strong style="font-size: 0.9rem;" id="checker-files-count">${state.itConfig.unlabelledFilesCount} files found</strong>
          </div>
        </div>

        <div id="scanning-progress-container" style="display: none; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-family: monospace;">
            <span>Scanning files...</span>
            <span id="scan-percentage">0%</span>
          </div>
          <div style="width: 100%; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
            <div id="scan-progress-bar" style="width: 0%; height: 100%; background-color: hsl(var(--color-blue)); border-radius: 3px; transition: width 0.1s linear;"></div>
          </div>
        </div>

        <div style="display: flex; gap: 12px;" id="checker-actions-row">
          <button class="primary-btn" id="run-checker-btn" style="background-color: #000000; color: #ffffff; flex: 1; justify-content: center; height: 38px; font-size: 0.85rem;">
            <i data-lucide="play" style="width: 14px; height: 14px;"></i> Run Script
          </button>
          <button class="secondary-btn" id="schedule-checker-btn" style="flex: 1; justify-content: center; height: 38px; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 6px;">
            <i data-lucide="calendar" style="width: 14px; height: 14px;"></i> Schedule
          </button>
        </div>
      </div>
    </div>

    <!-- SITE-WIDE CHANGE LOG Section -->
    <div class="requisitions-list-card" style="padding: 24px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
        <div>
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Site-wide Change Log</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Complete audit trail of all system activities</p>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; font-size: 0.75rem; color: #b58900; background-color: #fff9db; border: 1px solid #ffe8cc; border-radius: 20px; padding: 4px 12px; font-weight: 600;">
          <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Visible to Supervisors and above
        </div>
      </div>

      <div style="display: flex; gap: 12px; margin-bottom: 20px; align-items: center;">
        <div style="position: relative; flex: 1; max-width: 320px;">
          <i data-lucide="search" style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--text-muted);"></i>
          <input type="text" id="it-log-search" class="form-input" style="padding-left: 38px; width: 100%; height: 36px;" placeholder="Search..." value="${searchQuery || ''}">
        </div>
        <button class="secondary-btn" id="it-log-filter-btn" style="height: 36px; padding: 0 14px; display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem;">
          <i data-lucide="sliders-horizontal" style="width: 14px; height: 14px;"></i> Filter by Module
        </button>
        <button class="secondary-btn" id="it-log-date-btn" style="height: 36px; padding: 0 14px; display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem;">
          <i data-lucide="calendar" style="width: 14px; height: 14px;"></i> Date Range
        </button>
      </div>

      <div class="req-table-wrapper">
        <table class="req-table">
          <thead>
            <tr>
              <th style="width: 180px;">Timestamp</th>
              <th style="width: 150px;">User</th>
              <th style="width: 120px;">Action</th>
              <th style="width: 150px;">Module</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${filteredLogs.length === 0 
              ? `<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 24px;">No change logs match your search.</td></tr>`
              : filteredLogs.map(log => `
                  <tr>
                    <td style="font-family: monospace; font-size: 0.825rem; color: var(--text-secondary);">${log.timestamp}</td>
                    <td style="font-weight: 600;">${log.user}</td>
                    <td>
                      <span class="status-badge" style="background-color: var(--border-color); color: var(--text-primary); font-size: 0.75rem; border-radius: 4px; padding: 2px 8px; font-weight: 600;">
                        ${log.action}
                      </span>
                    </td>
                    <td>${log.module}</td>
                    <td style="font-weight: 500;">${log.details}</td>
                  </tr>
                `).join('')
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal: Generate API Key -->
    <div class="modal-overlay" id="api-key-modal" style="display: none;">
      <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
          <h3>Generate New API Key</h3>
          <button class="close-btn" id="close-api-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="api-key-form">
          <div class="form-grid" style="grid-template-columns: 1fr; gap: 16px;">
            <div class="form-group">
              <label for="api-key-name">Integration/Service Name</label>
              <input type="text" id="api-key-name" class="form-input" placeholder="e.g. Procore Reporting Hook" required>
            </div>
            <div class="form-group">
              <label for="api-key-expiry">Expiry Date</label>
              <select id="api-key-expiry" class="form-select">
                <option value="30">30 Days</option>
                <option value="90" selected>90 Days</option>
                <option value="365">1 Year</option>
                <option value="never">Never Expires</option>
              </select>
            </div>
            <div class="form-group" id="api-key-result-group" style="display: none; background-color: var(--bg-secondary); padding: 12px; border-radius: 6px; border: 1px solid var(--border-color);">
              <label style="font-family: monospace; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 6px;">Generated API Token (Copy now, it won't be shown again)</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" id="api-key-value" class="form-input" style="font-family: monospace; font-size: 0.85rem; flex: 1; height: 36px; background-color: var(--bg-primary);" readonly>
                <button type="button" class="secondary-btn" id="copy-api-key-btn" style="height: 36px; padding: 0 10px;">
                  <i data-lucide="copy" style="width: 14px; height: 14px;"></i>
                </button>
              </div>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; margin-top: 16px;">
            <button type="button" class="secondary-btn" id="cancel-api-modal-btn" style="margin-left: auto;">Close</button>
            <button type="submit" class="primary-btn" id="submit-api-key-btn">Create Token</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachITHandlers(container, state, navigateTo) {
  const sInput = document.getElementById('it-log-search');
  if (sInput) {
    sInput.addEventListener('input', () => {
      renderIT(container, state, navigateTo);
      const tempInput = document.getElementById('it-log-search');
      tempInput.focus();
      const val = tempInput.value;
      tempInput.value = '';
      tempInput.value = val;
    });
  }

  const toggleCheckbox = document.getElementById('ai-label-toggle');
  if (toggleCheckbox) {
    toggleCheckbox.addEventListener('change', () => {
      state.itConfig.aiLabellingActive = toggleCheckbox.checked;
    });
  }

  const runBtn = document.getElementById('run-checker-btn');
  const progressContainer = document.getElementById('scanning-progress-container');
  const progressBar = document.getElementById('scan-progress-bar');
  const percentageText = document.getElementById('scan-percentage');
  const actionRow = document.getElementById('checker-actions-row');

  if (runBtn) {
    runBtn.addEventListener('click', () => {
      actionRow.style.display = 'none';
      progressContainer.style.display = 'flex';
      
      let percentage = 0;
      progressBar.style.width = '0%';
      percentageText.textContent = '0%';

      const interval = setInterval(() => {
        percentage += 5;
        progressBar.style.width = `${percentage}%`;
        percentageText.textContent = `${percentage}%`;

        if (percentage >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            state.itConfig.unlabelledFilesCount = 0;
            state.itConfig.checkerLastRun = 'Just now';
            renderIT(container, state, navigateTo);
          }, 300);
        }
      }, 80);
    });
  }

  // Generate API Key Handlers
  const generateApiKeyBtn = document.getElementById('generate-api-key-btn');
  const apiKeyModal = document.getElementById('api-key-modal');
  const closeApiModalBtn = document.getElementById('close-api-modal-btn');
  const cancelApiModalBtn = document.getElementById('cancel-api-modal-btn');
  const apiKeyForm = document.getElementById('api-key-form');
  const resultGroup = document.getElementById('api-key-result-group');
  const apiKeyValue = document.getElementById('api-key-value');
  const copyApiKeyBtn = document.getElementById('copy-api-key-btn');
  const submitApiKeyBtn = document.getElementById('submit-api-key-btn');

  if (generateApiKeyBtn) {
    generateApiKeyBtn.addEventListener('click', () => {
      resultGroup.style.display = 'none';
      apiKeyValue.value = '';
      submitApiKeyBtn.style.display = 'block';
      submitApiKeyBtn.textContent = 'Create Token';
      apiKeyForm.reset();
      apiKeyModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  const closeApiModal = () => {
    apiKeyModal.style.display = 'none';
  };

  if (closeApiModalBtn) closeApiModalBtn.addEventListener('click', closeApiModal);
  if (cancelApiModalBtn) cancelApiModalBtn.addEventListener('click', closeApiModal);

  if (apiKeyForm) {
    apiKeyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const serviceName = document.getElementById('api-key-name').value.trim();
      const expiry = document.getElementById('api-key-expiry').value;

      // Generate simulated key
      const randStr = Array.from({length: 32}, () => Math.floor(Math.random()*36).toString(36)).join('');
      const token = `gg_live_${randStr}`;

      apiKeyValue.value = token;
      resultGroup.style.display = 'block';
      submitApiKeyBtn.style.display = 'none';

      // Log activity
      state.itChangeLogs.unshift({
        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
        user: 'Pranshu',
        action: 'Created',
        module: 'Integrations',
        details: `Generated API Key for service: ${serviceName} (Expires in ${expiry} days)`
      });
    });
  }

  if (copyApiKeyBtn) {
    copyApiKeyBtn.addEventListener('click', () => {
      apiKeyValue.select();
      navigator.clipboard.writeText(apiKeyValue.value).then(() => {
        alert('API Key copied to clipboard!');
      });
    });
  }

  document.getElementById('it-log-filter-btn').addEventListener('click', () => {
    alert('Log module filters toggled.');
  });

  document.getElementById('it-log-date-btn').addEventListener('click', () => {
    alert('Date range filters toggled.');
  });

  document.getElementById('schedule-checker-btn').addEventListener('click', () => {
    alert('Scan Scheduler Panel loaded.');
  });

  const pbiLink = document.getElementById('powerbi-link');
  if (pbiLink) {
    pbiLink.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Loading Microsoft PowerBI analytical portal context...');
    });
  }
}

// ----------------------------------------------------
// 2. Website Management Tab Renderer & Handlers
// ----------------------------------------------------
function renderWebsiteManagement(state) {
  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Website Management</h2>
        <p>Manage company websites and monitoring</p>
      </div>
      <button class="primary-btn" id="edit-website-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Register Website
      </button>
    </div>

    <!-- Active Websites Container Card -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Active Websites</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Status and monitoring for all company websites</p>
      </div>

      <!-- Websites Rows List -->
      <div class="website-rows-container">
        ${state.websites.map(web => {
          const isOnline = web.status === 'Online';
          const statusClass = isOnline ? 'web-status-badge-online' : 'web-status-badge-offline';
          
          return `
            <div class="website-row-card" data-id="${web.id}">
              <div class="web-info-left">
                <div class="web-globe-icon-circle">
                  <i data-lucide="globe" style="width: 20px; height: 20px;"></i>
                </div>
                <div class="web-text-details">
                  <span class="web-title-txt">${web.name}</span>
                  <span class="web-domain-txt">${web.domain}</span>
                  <div class="web-meta-row">
                    <div class="web-meta-item">
                      <i data-lucide="shield-check" style="width: 14px; height: 14px; color: hsl(var(--color-green));"></i>
                      <span>Valid (${web.sslDays} days)</span>
                    </div>
                    <div class="web-meta-item">
                      <i data-lucide="activity" style="width: 14px; height: 14px; color: hsl(var(--color-blue));"></i>
                      <span>${web.uptime}% uptime</span>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <span class="${statusClass}">${web.status}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Modal: Manage/Edit Website -->
    <div class="modal-overlay" id="edit-website-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="modal-website-title-action">Register New Website</h3>
          <button class="close-btn" id="close-web-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="edit-website-form">
          <input type="hidden" id="web-form-id">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="web-form-name">Website Name</label>
              <input type="text" id="web-form-name" class="form-input" placeholder="e.g. Main Website, Careers Portal" required>
            </div>
            <div class="form-group">
              <label for="web-form-domain">Domain Name</label>
              <input type="text" id="web-form-domain" class="form-input" placeholder="e.g. greensglobal.com" required>
            </div>
            <div class="form-group">
              <label for="web-form-ssl">SSL Certification Days Left</label>
              <input type="number" id="web-form-ssl" class="form-input" min="1" placeholder="e.g. 90" required>
            </div>
            <div class="form-group">
              <label for="web-form-uptime">Uptime Percentage (%)</label>
              <input type="number" id="web-form-uptime" class="form-input" min="1" max="100" step="0.01" placeholder="e.g. 99.9" required>
            </div>
            <div class="form-group">
              <label for="web-form-status">Status</label>
              <select id="web-form-status" class="form-select">
                <option value="Online">Online</option>
                <option value="Offline">Offline</option>
              </select>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: space-between;">
            <button type="button" class="secondary-btn" id="delete-web-btn" style="color: hsl(var(--color-red)); border-color: hsla(var(--color-red), 0.2); display: none;">Delete Website</button>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button type="button" class="secondary-btn" id="cancel-web-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn" id="save-web-submit-btn">Save Website</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachWebsiteHandlers(container, state, navigateTo) {
  const editWebBtn = document.getElementById('edit-website-btn');
  const webModal = document.getElementById('edit-website-modal');
  const closeWebBtn = document.getElementById('close-web-modal-btn');
  const cancelWebBtn = document.getElementById('cancel-web-modal-btn');
  const webForm = document.getElementById('edit-website-form');
  const deleteWebBtn = document.getElementById('delete-web-btn');
  const modalTitle = document.getElementById('modal-website-title-action');
  const submitBtn = document.getElementById('save-web-submit-btn');

  const closeWebModal = () => {
    webModal.style.display = 'none';
    webForm.reset();
  };

  closeWebBtn.addEventListener('click', closeWebModal);
  cancelWebBtn.addEventListener('click', closeWebModal);

  editWebBtn.addEventListener('click', () => {
    document.getElementById('web-form-id').value = '';
    modalTitle.textContent = 'Register New Website';
    submitBtn.textContent = 'Save Website';
    deleteWebBtn.style.display = 'none';
    webModal.style.display = 'flex';
  });

  const rows = container.querySelectorAll('.website-row-card');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.getAttribute('data-id'));
      const web = state.websites.find(w => w.id === id);
      if (web) {
        document.getElementById('web-form-id').value = web.id;
        document.getElementById('web-form-name').value = web.name;
        document.getElementById('web-form-domain').value = web.domain;
        document.getElementById('web-form-ssl').value = web.sslDays;
        document.getElementById('web-form-uptime').value = web.uptime;
        document.getElementById('web-form-status').value = web.status;

        modalTitle.textContent = 'Edit Website Settings';
        submitBtn.textContent = 'Save Changes';
        deleteWebBtn.style.display = 'block';
        webModal.style.display = 'flex';
      }
    });
  });

  webForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const idVal = document.getElementById('web-form-id').value;
    const name = document.getElementById('web-form-name').value.trim();
    const domain = document.getElementById('web-form-domain').value.trim();
    const sslDays = parseInt(document.getElementById('web-form-ssl').value);
    const uptime = parseFloat(document.getElementById('web-form-uptime').value);
    const status = document.getElementById('web-form-status').value;

    if (idVal) {
      const id = parseInt(idVal);
      const index = state.websites.findIndex(w => w.id === id);
      if (index !== -1) {
        state.websites[index].name = name;
        state.websites[index].domain = domain;
        state.websites[index].sslDays = sslDays;
        state.websites[index].uptime = uptime;
        state.websites[index].status = status;
      }
    } else {
      const newWeb = {
        id: Math.floor(100 + Math.random() * 900),
        name: name,
        domain: domain,
        sslDays: sslDays,
        uptime: uptime,
        status: status
      };
      state.websites.push(newWeb);
    }

    closeWebModal();
    renderIT(container, state, navigateTo);
  });

  deleteWebBtn.addEventListener('click', () => {
    const id = parseInt(document.getElementById('web-form-id').value);
    if (confirm('Are you sure you want to remove this website from monitoring?')) {
      state.websites = state.websites.filter(w => w.id !== id);
      closeWebModal();
      renderIT(container, state, navigateTo);
    }
  });
}

// ----------------------------------------------------
// 3. Asset Management Tab Renderer & Handlers
// ----------------------------------------------------
function renderAssetManagement(state) {
  // Calculate dynamic KPI counters with offsets to match initial numbers (124 Total, 98 Checked Out, 18 Available, 8 Overdue)
  const checkedOutCount = 94 + state.assets.filter(a => a.status === 'Checked Out').length;
  const availableCount = 17 + state.assets.filter(a => a.status === 'Available').length;
  const overdueCount = 7 + state.assets.filter(a => a.status === 'Overdue').length;
  const totalCount = checkedOutCount + availableCount + overdueCount;

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Hardware Assets</h2>
        <p>Track and manage company hardware assets, laptops, and mobile devices</p>
      </div>
    </div>

    <!-- KPI Cards Grid -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Total Assets</span>
          <div class="kpi-icon-container">
            <i data-lucide="package" style="width: 20px; height: 20px;"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">${totalCount}</div>
        <div class="kpi-helper">Baseline match</div>
      </div>
      
      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Checked Out</span>
          <div class="kpi-icon-container">
            <i data-lucide="user-check" style="width: 20px; height: 20px; color: hsl(var(--color-blue));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-blue)); font-size: 2rem;">${checkedOutCount}</div>
        <div class="kpi-helper">Active assignments</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Available</span>
          <div class="kpi-icon-container">
            <i data-lucide="check-circle" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">${availableCount}</div>
        <div class="kpi-helper">Ready to assign</div>
      </div>

      <div class="kpi-card card-red" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Overdue</span>
          <div class="kpi-icon-container">
            <i data-lucide="alert-triangle" style="width: 20px; height: 20px; color: hsl(var(--color-red));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-red)); font-size: 2rem;">${overdueCount}</div>
        <div class="kpi-helper">Needs action</div>
      </div>
    </div>

    <!-- Asset Inventory List -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Asset Inventory</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Status and assignments for physical hardware devices</p>
      </div>

      <div class="req-table-wrapper">
        <table class="req-table">
          <thead>
            <tr>
              <th>Asset Name</th>
              <th>Category</th>
              <th>Assigned To</th>
              <th>Status</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            ${state.assets.map(asset => {
              let badgeClass = 'asset-status-available';
              if (asset.status === 'Checked Out') {
                badgeClass = 'asset-status-checked-out';
              } else if (asset.status === 'Overdue') {
                badgeClass = 'asset-status-overdue';
              }

              return `
                <tr class="asset-row-clickable" data-id="${asset.id}">
                  <td style="font-weight: 600;">${asset.name}</td>
                  <td>${asset.category}</td>
                  <td style="font-weight: 500;">${asset.assignedTo}</td>
                  <td><span class="${badgeClass}">${asset.status}</span></td>
                  <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-secondary);">${asset.lastSeen}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal: Register / Edit Asset -->
    <div class="modal-overlay" id="asset-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="modal-asset-title">Register New Asset</h3>
          <button class="close-btn" id="close-asset-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="asset-form">
          <input type="hidden" id="asset-form-id">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="asset-form-name">Asset Name</label>
              <input type="text" id="asset-form-name" class="form-input" placeholder="e.g. Dell Latitude 5520" required>
            </div>
            <div class="form-group">
              <label for="asset-form-category">Category</label>
              <select id="asset-form-category" class="form-select" required>
                <option value="Laptop">Laptop</option>
                <option value="Mobile">Mobile</option>
                <option value="Monitor">Monitor</option>
                <option value="Accessory">Accessory</option>
                <option value="Printer">Printer</option>
              </select>
            </div>
            <div class="form-group">
              <label for="asset-form-assignee">Assigned To</label>
              <input type="text" id="asset-form-assignee" class="form-input" placeholder="e.g. John Doe, Unassigned" required>
            </div>
            <div class="form-group">
              <label for="asset-form-status">Status</label>
              <select id="asset-form-status" class="form-select" required>
                <option value="Checked Out">Checked Out</option>
                <option value="Available">Available</option>
                <option value="Overdue">Overdue</option>
              </select>
            </div>
            <div class="form-group">
              <label for="asset-form-lastseen">Last Seen</label>
              <input type="date" id="asset-form-lastseen" class="form-input" required>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px;">
            <button type="button" class="secondary-btn" id="delete-asset-btn" style="color: hsl(var(--color-red)); border-color: hsla(var(--color-red), 0.2); display: none;">Delete Asset</button>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button type="button" class="secondary-btn" id="cancel-asset-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn" id="save-asset-submit-btn">Save Asset</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachAssetHandlers(container, state, navigateTo) {
  const newAssetBtn = document.getElementById('new-asset-btn');
  const assetModal = document.getElementById('asset-modal');
  const closeAssetBtn = document.getElementById('close-asset-modal-btn');
  const cancelAssetBtn = document.getElementById('cancel-asset-modal-btn');
  const assetForm = document.getElementById('asset-form');
  const deleteAssetBtn = document.getElementById('delete-asset-btn');
  const modalTitle = document.getElementById('modal-asset-title');
  const submitBtn = document.getElementById('save-asset-submit-btn');

  const closeAssetModal = () => {
    assetModal.style.display = 'none';
    assetForm.reset();
  };

  closeAssetBtn.addEventListener('click', closeAssetModal);
  cancelAssetBtn.addEventListener('click', closeAssetModal);

  if (newAssetBtn) {
    newAssetBtn.addEventListener('click', () => {
      document.getElementById('asset-form-id').value = '';
      modalTitle.textContent = 'Register New Asset';
      submitBtn.textContent = 'Save Asset';
      deleteAssetBtn.style.display = 'none';
      
      const today = new Date().toISOString().split('T')[0];
      document.getElementById('asset-form-lastseen').value = today;

      assetModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  const rows = container.querySelectorAll('.asset-row-clickable');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.getAttribute('data-id'));
      const asset = state.assets.find(a => a.id === id);
      if (asset) {
        document.getElementById('asset-form-id').value = asset.id;
        document.getElementById('asset-form-name').value = asset.name;
        document.getElementById('asset-form-category').value = asset.category;
        document.getElementById('asset-form-assignee').value = asset.assignedTo;
        document.getElementById('asset-form-status').value = asset.status;
        document.getElementById('asset-form-lastseen').value = asset.lastSeen;

        modalTitle.textContent = 'Edit Asset Settings';
        submitBtn.textContent = 'Save Changes';
        deleteAssetBtn.style.display = 'block';
        assetModal.style.display = 'flex';
        lucide.createIcons();
      }
    });
  });

  assetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const idVal = document.getElementById('asset-form-id').value;
    const name = document.getElementById('asset-form-name').value.trim();
    const category = document.getElementById('asset-form-category').value;
    const assignedTo = document.getElementById('asset-form-assignee').value.trim();
    const status = document.getElementById('asset-form-status').value;
    const lastSeen = document.getElementById('asset-form-lastseen').value;

    if (idVal) {
      const id = parseInt(idVal);
      const index = state.assets.findIndex(a => a.id === id);
      if (index !== -1) {
        state.assets[index].name = name;
        state.assets[index].category = category;
        state.assets[index].assignedTo = assignedTo;
        state.assets[index].status = status;
        state.assets[index].lastSeen = lastSeen;
        
        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Updated',
          module: 'Asset Mgmt',
          details: `Updated status of ${name} to ${status}`
        });
      }
    } else {
      const newAsset = {
        id: Math.floor(100 + Math.random() * 900),
        name: name,
        category: category,
        assignedTo: assignedTo,
        status: status,
        lastSeen: lastSeen
      };
      state.assets.push(newAsset);

      state.itChangeLogs.unshift({
        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
        user: 'Pranshu',
        action: 'Created',
        module: 'Asset Mgmt',
        details: `Registered ${name} (${category})`
      });
    }

    closeAssetModal();
    window.renderIT(container, state, navigateTo);
  });

  deleteAssetBtn.addEventListener('click', () => {
    const id = parseInt(document.getElementById('asset-form-id').value);
    const name = document.getElementById('asset-form-name').value.trim();
    if (confirm('Are you sure you want to remove this asset?')) {
      state.assets = state.assets.filter(a => a.id !== id);
      
      state.itChangeLogs.unshift({
        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
        user: 'Pranshu',
        action: 'Deleted',
        module: 'Asset Mgmt',
        details: `Removed ${name}`
      });

      closeAssetModal();
      window.renderIT(container, state, navigateTo);
    }
  });
}

// ----------------------------------------------------
// 4. Access Management Tab Renderer & Handlers
// ----------------------------------------------------
function renderAccessManagement(state) {
  const accounts = state.itAccessAccounts;
  const activeAccountsCount = accounts.length;
  const mfaCount = accounts.filter(a => a.mfaStatus === 'Enabled').length;
  const mfaPercent = accounts.length ? Math.round((mfaCount / accounts.length) * 100) : 0;
  const activeVpnCount = accounts.filter(a => a.vpnAccess && a.vpnAccess !== 'Inactive').length;

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Access Management</h2>
        <p>Manage employee system credentials, VPN profiles, and MFA verification</p>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="secondary-btn" id="rotate-keyring-btn" style="display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="key-round" style="width: 16px; height: 16px;"></i> Rotate Keyring
        </button>
        <button class="secondary-btn" id="revoke-vpns-btn" style="color: hsl(var(--color-red)); border-color: hsla(var(--color-red), 0.2); display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="shield-off" style="width: 16px; height: 16px;"></i> Revoke All VPNs
        </button>
        <button class="primary-btn" id="new-access-btn" style="background-color: #000000; color: #ffffff;">
          <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Register Credentials
        </button>
      </div>
    </div>

    <!-- KPI Cards Grid -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Active Accounts</span>
          <div class="kpi-icon-container">
            <i data-lucide="users" style="width: 20px; height: 20px;"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">${activeAccountsCount}</div>
        <div class="kpi-helper">Registered operations logins</div>
      </div>
      
      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">MFA Status</span>
          <div class="kpi-icon-container">
            <i data-lucide="shield-check" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">${mfaPercent}%</div>
        <div class="kpi-helper">${mfaCount} of ${activeAccountsCount} enabled</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Active VPNs</span>
          <div class="kpi-icon-container">
            <i data-lucide="network" style="width: 20px; height: 20px; color: hsl(var(--color-blue));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-blue)); font-size: 2rem;">${activeVpnCount}</div>
        <div class="kpi-helper">Encrypted tunnels open</div>
      </div>

      <div class="kpi-card card-gold" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">API Keys</span>
          <div class="kpi-icon-container">
            <i data-lucide="key" style="width: 20px; height: 20px; color: hsl(var(--color-gold));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-gold)); font-size: 2rem;">12</div>
        <div class="kpi-helper">Active API connections</div>
      </div>
    </div>

    <!-- Accounts Table Card -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">User Credentials Directory</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Status and roles of active user credentials</p>
      </div>

      <div class="req-table-wrapper">
        <table class="req-table">
          <thead>
            <tr>
              <th>Employee Name</th>
              <th>System Role</th>
              <th>VPN Profile</th>
              <th>MFA Status</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map(acc => {
              const hasMFA = acc.mfaStatus === 'Enabled';
              const mfaBadge = hasMFA 
                ? `<span class="status-badge status-approved" style="font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">Enabled</span>`
                : `<span class="status-badge status-rejected" style="font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">Disabled</span>`;
              
              const hasVPN = acc.vpnAccess && acc.vpnAccess !== 'Inactive';
              const vpnBadge = hasVPN
                ? `<span class="status-badge status-approved" style="background-color: hsla(var(--color-blue), 0.1); color: hsl(var(--color-blue)); font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">${acc.vpnAccess}</span>`
                : `<span class="status-badge status-pending" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">Inactive</span>`;

              return `
                <tr class="access-row-clickable" data-id="${acc.id}" style="cursor: pointer;">
                  <td style="font-weight: 600;">${acc.name}</td>
                  <td>${acc.role}</td>
                  <td>${vpnBadge}</td>
                  <td>${mfaBadge}</td>
                  <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-secondary);">${acc.lastActive}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal: Register / Edit Credentials -->
    <div class="modal-overlay" id="access-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="modal-access-title">Register User Credentials</h3>
          <button class="close-btn" id="close-access-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="access-form">
          <input type="hidden" id="access-form-id">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="access-form-name">Employee Name</label>
              <input type="text" id="access-form-name" class="form-input" placeholder="e.g. Sarah Johnson" required>
            </div>
            <div class="form-group">
              <label for="access-form-role">System Role</label>
              <input type="text" id="access-form-role" class="form-input" placeholder="e.g. IT Manager, Financial Controller" required>
            </div>
            <div class="form-group">
              <label for="access-form-vpn">VPN Profile</label>
              <select id="access-form-vpn" class="form-select">
                <option value="Active v2.4">Active v2.4</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
            <div class="form-group">
              <label for="access-form-mfa">MFA Status</label>
              <select id="access-form-mfa" class="form-select">
                <option value="Enabled">Enabled</option>
                <option value="Disabled">Disabled</option>
              </select>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px;">
            <button type="button" class="secondary-btn" id="delete-access-btn" style="color: hsl(var(--color-red)); border-color: hsla(var(--color-red), 0.2); display: none;">Delete Credentials</button>
            <div style="display: flex; gap: 8px; margin-left: auto;">
              <button type="button" class="secondary-btn" id="cancel-access-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn" id="save-access-submit-btn">Save Credentials</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachAccessHandlers(container, state, navigateTo) {
  const newBtn = document.getElementById('new-access-btn');
  const accessModal = document.getElementById('access-modal');
  const closeBtn = document.getElementById('close-access-modal-btn');
  const cancelBtn = document.getElementById('cancel-access-modal-btn');
  const form = document.getElementById('access-form');
  const deleteBtn = document.getElementById('delete-access-btn');
  const modalTitle = document.getElementById('modal-access-title');
  const submitBtn = document.getElementById('save-access-submit-btn');

  const closeAccessModal = () => {
    accessModal.style.display = 'none';
    form.reset();
  };

  if (closeBtn) closeBtn.addEventListener('click', closeAccessModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeAccessModal);

  if (newBtn) {
    newBtn.addEventListener('click', () => {
      document.getElementById('access-form-id').value = '';
      modalTitle.textContent = 'Register User Credentials';
      submitBtn.textContent = 'Save Credentials';
      deleteBtn.style.display = 'none';
      accessModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  const rows = container.querySelectorAll('.access-row-clickable');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.getAttribute('data-id'));
      const acc = state.itAccessAccounts.find(a => a.id === id);
      if (acc) {
        document.getElementById('access-form-id').value = acc.id;
        document.getElementById('access-form-name').value = acc.name;
        document.getElementById('access-form-role').value = acc.role;
        document.getElementById('access-form-vpn').value = acc.vpnAccess.includes('Active') ? 'Active v2.4' : 'Inactive';
        document.getElementById('access-form-mfa').value = acc.mfaStatus;

        modalTitle.textContent = 'Edit User Credentials';
        submitBtn.textContent = 'Save Changes';
        deleteBtn.style.display = 'block';
        accessModal.style.display = 'flex';
        lucide.createIcons();
      }
    });
  });

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const idVal = document.getElementById('access-form-id').value;
      const name = document.getElementById('access-form-name').value.trim();
      const role = document.getElementById('access-form-role').value.trim();
      const vpn = document.getElementById('access-form-vpn').value;
      const mfa = document.getElementById('access-form-mfa').value;

      if (idVal) {
        const id = parseInt(idVal);
        const index = state.itAccessAccounts.findIndex(a => a.id === id);
        if (index !== -1) {
          state.itAccessAccounts[index].name = name;
          state.itAccessAccounts[index].role = role;
          state.itAccessAccounts[index].vpnAccess = vpn;
          state.itAccessAccounts[index].mfaStatus = mfa;

          state.itChangeLogs.unshift({
            timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
            user: 'Pranshu',
            action: 'Updated',
            module: 'Access Control',
            details: `Updated credentials for ${name}`
          });
        }
      } else {
        const newAcc = {
          id: Math.floor(100 + Math.random() * 900),
          name: name,
          role: role,
          vpnAccess: vpn,
          mfaStatus: mfa,
          lastActive: 'Just now'
        };
        state.itAccessAccounts.push(newAcc);

        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Created',
          module: 'Access Control',
          details: `Registered credentials for ${name} (${role})`
        });
      }

      closeAccessModal();
      window.renderIT(container, state, navigateTo);
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const id = parseInt(document.getElementById('access-form-id').value);
      const name = document.getElementById('access-form-name').value.trim();
      if (confirm('Are you sure you want to delete these user credentials?')) {
        state.itAccessAccounts = state.itAccessAccounts.filter(a => a.id !== id);

        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Deleted',
          module: 'Access Control',
          details: `Deleted credentials for ${name}`
        });

        closeAccessModal();
        window.renderIT(container, state, navigateTo);
      }
    });
  }

  // Keyring rotation handler
  const rotateBtn = document.getElementById('rotate-keyring-btn');
  if (rotateBtn) {
    rotateBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to rotate the Master API Keyring? This will invalidate and regenerate all live communication tokens.')) {
        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Modified',
          module: 'Access Control',
          details: 'Rotated master keyring & re-secured active tunnels'
        });
        alert('Master API Keyring rotated successfully. 12 integration tunnels re-established.');
        window.renderIT(container, state, navigateTo);
      }
    });
  }

  // Revoke all VPNs handler
  const revokeBtn = document.getElementById('revoke-vpns-btn');
  if (revokeBtn) {
    revokeBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to revoke all active employee VPN profiles? This will disconnect all external users immediately.')) {
        state.itAccessAccounts.forEach(acc => {
          acc.vpnAccess = 'Inactive';
        });
        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Modified',
          module: 'Access Control',
          details: 'Revoked all active VPN gateway tunnels'
        });
        alert('All active VPN connection profiles revoked.');
        window.renderIT(container, state, navigateTo);
      }
    });
  }
}

// ----------------------------------------------------
// 5. Network Management Tab Renderer & Handlers
// ----------------------------------------------------
function renderNetworkManagement(state) {
  // Ensure network nodes are populated in state or use custom UniFi items
  if (!state.unifiNodes) {
    state.unifiNodes = [
      { id: 'UDM-01', name: 'UniFi Dream Machine Pro', ip: '10.0.1.1', type: 'Gateway', clients: 142, status: 'Online', model: 'UDM-Pro' },
      { id: 'USW-24', name: 'UniFi Switch Enterprise 24 PoE', ip: '10.0.1.2', type: 'Switch', clients: 24, status: 'Online', model: 'USW-Enterprise-24' },
      { id: 'U6-AP01', name: 'UniFi AP U6 Pro - Reception', ip: '10.0.5.10', type: 'Access Point', clients: 38, status: 'Online', model: 'U6-Pro' },
      { id: 'U6-AP02', name: 'UniFi AP U6 Pro - Executive Suite', ip: '10.0.5.11', type: 'Access Point', clients: 42, status: 'Online', model: 'U6-Pro' },
      { id: 'U6-AP03', name: 'UniFi AP U6 Lite - Main Hall', ip: '10.0.5.12', type: 'Access Point', clients: 22, status: 'Online', model: 'U6-Lite' },
      { id: 'UAP-AC-M', name: 'UniFi AP AC Mesh - Outdoor Deck', ip: '10.0.5.15', type: 'Access Point', clients: 16, status: 'Online', model: 'UAP-AC-M' }
    ];
  }
  
  if (!state.unifiUptime) {
    state.unifiUptime = '14d 6h 32m';
  }

  const nodes = state.unifiNodes;
  const onlineCount = nodes.filter(n => n.status === 'Online').length;
  const totalClients = nodes.reduce((sum, n) => sum + (n.status === 'Online' ? n.clients : 0), 0);

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Network Management</h2>
        <p>UniFi Controller Integration Dashboard &bull; Real-time infrastructure status</p>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="secondary-btn" id="provision-config-btn" style="display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="settings" style="width: 16px; height: 16px;"></i> Provision AP Config
        </button>
        <button class="primary-btn" id="sync-unifi-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i> Sync UniFi Controller
        </button>
      </div>
    </div>

    <!-- KPI Cards Grid -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">UniFi Controller</span>
          <div class="kpi-icon-container">
            <i data-lucide="shield" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">Connected</div>
        <div class="kpi-helper">Software Version v8.1.113</div>
      </div>
      
      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">UniFi Devices</span>
          <div class="kpi-icon-container">
            <i data-lucide="network" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">${onlineCount} / ${nodes.length}</div>
        <div class="kpi-helper">Active nodes online</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Active Clients</span>
          <div class="kpi-icon-container">
            <i data-lucide="users" style="width: 20px; height: 20px; color: hsl(var(--color-blue));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-blue)); font-size: 2rem;">${totalClients}</div>
        <div class="kpi-helper">Wired: 24 &bull; Wireless: ${totalClients - 24}</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Avg Network XP</span>
          <div class="kpi-icon-container">
            <i data-lucide="zap" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">98%</div>
        <div class="kpi-helper">Excellent network rating</div>
      </div>
    </div>

    <!-- Network Panels Grid (2 columns) -->
    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 24px;">
      <!-- Left: Network Devices Table -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">UniFi Infrastructure Devices</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Managed routing gateways, access switches, and APs</p>
        </div>

        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Device ID</th>
                <th>Device Name</th>
                <th>IP Address</th>
                <th>Model</th>
                <th>Type</th>
                <th>Clients</th>
                <th>Status</th>
                <th style="width: 100px; text-align: center;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${nodes.map(node => {
                const isOnline = node.status === 'Online';
                const isRebooting = node.status === 'Rebooting...';
                let statusBadge = '';
                
                if (isOnline) {
                  statusBadge = `<span class="status-badge status-approved" style="font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">Online</span>`;
                } else if (isRebooting) {
                  statusBadge = `<span class="status-badge status-pending" style="font-size: 0.75rem; border-radius: 4px; padding: 2px 8px; animation: pulse 1.5s infinite;">Rebooting...</span>`;
                } else {
                  statusBadge = `<span class="status-badge status-rejected" style="font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">Offline</span>`;
                }

                return `
                  <tr>
                    <td style="font-family: monospace; font-size: 0.85rem; font-weight: 600;">${node.id}</td>
                    <td style="font-weight: 600;">${node.name}</td>
                    <td style="font-family: monospace; font-size: 0.85rem; color: var(--text-secondary);">${node.ip}</td>
                    <td style="font-size: 0.8rem; font-family: monospace;">${node.model}</td>
                    <td>${node.type}</td>
                    <td style="font-weight: 600; text-align: center;">${isOnline ? node.clients : 0}</td>
                    <td>${statusBadge}</td>
                    <td style="text-align: center;">
                      ${node.type === 'Access Point' 
                        ? `<button class="secondary-btn restart-ap-btn" data-id="${node.id}" style="height: 28px; padding: 0 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;" ${isRebooting ? 'disabled' : ''}>
                            <i data-lucide="rotate-cw" style="width: 12px; height: 12px;"></i> Restart
                           </button>` 
                        : `<span style="font-size: 0.75rem; color: var(--text-muted);">Protected</span>`
                      }
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Right: Wi-Fi Profiles & Controller Health -->
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <!-- UniFi Controller Health -->
        <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
          <div style="margin-bottom: 16px;">
            <h3 style="font-size: 1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">UniFi Controller Status</h3>
            <p style="color: var(--text-secondary); font-size: 0.8rem;">Local virtual server performance metrics</p>
          </div>

          <div style="display: flex; flex-direction: column; gap: 12px; font-size: 0.85rem;">
            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
              <span style="color: var(--text-secondary);">Uptime:</span>
              <strong style="font-family: monospace;">${state.unifiUptime}</strong>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
              <span style="color: var(--text-secondary);">CPU Load:</span>
              <strong style="font-family: monospace;">12%</strong>
            </div>
            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
              <span style="color: var(--text-secondary);">Memory Load:</span>
              <strong style="font-family: monospace;">42% (3.3 GB / 8 GB)</strong>
            </div>
            <div style="display: flex; justify-content: space-between; padding-bottom: 4px;">
              <span style="color: var(--text-secondary);">Ubiquiti Cloud Sync:</span>
              <span class="status-badge status-approved" style="font-size: 0.7rem; padding: 1px 6px;">Live Connected</span>
            </div>
          </div>
        </div>

        <!-- Managed Networks -->
        <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
          <div style="margin-bottom: 16px;">
            <h3 style="font-size: 1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">UniFi Broadcast SSIDs</h3>
            <p style="color: var(--text-secondary); font-size: 0.8rem;">Wireless network security profiles</p>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px; background-color: var(--bg-secondary);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong style="font-size: 0.9rem;">GreensGlobal-HQ</strong>
                <span class="status-badge status-approved" style="font-size: 0.7rem; padding: 1px 6px;">Active</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; display: flex; justify-content: space-between;">
                <span>Security: WPA3 Enterprise</span>
                <span>VLAN: 10</span>
              </div>
            </div>
            
            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px; background-color: var(--bg-secondary);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong style="font-size: 0.9rem;">GreensGlobal-Guest</strong>
                <span class="status-badge status-approved" style="font-size: 0.7rem; padding: 1px 6px;">Active</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; display: flex; justify-content: space-between;">
                <span>Security: Hotspot Portal</span>
                <span>VLAN: 20</span>
              </div>
            </div>

            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px; background-color: var(--bg-secondary);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong style="font-size: 0.9rem;">GreensGlobal-IoT</strong>
                <span class="status-badge status-approved" style="font-size: 0.7rem; padding: 1px 6px;">Active</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; display: flex; justify-content: space-between;">
                <span>Security: WPA2 Personal</span>
                <span>VLAN: 30</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Sync loading block -->
        <div id="unifi-sync-block" style="display: none; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 0.9rem; font-family: 'Plus Jakarta Sans', sans-serif;">Handshaking UniFi API...</strong>
            <span id="sync-stage" style="font-size: 0.75rem; font-family: monospace; color: var(--text-secondary);">Querying stats</span>
          </div>
          <div style="width: 100%; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
            <div id="sync-unifi-progress-bar" style="width: 0%; height: 100%; background-color: hsl(var(--color-blue)); border-radius: 3px; transition: width 0.1s linear;"></div>
          </div>
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Fetching connected client experience tables</span>
        </div>
      </div>
    </div>
  `;
}

function attachNetworkHandlers(container, state, navigateTo) {
  // Restart AP handler
  const restartBtns = container.querySelectorAll('.restart-ap-btn');
  restartBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const nid = btn.getAttribute('data-id');
      const node = state.unifiNodes.find(n => n.id === nid);
      if (node) {
        node.status = 'Rebooting...';
        state.itChangeLogs.unshift({
          timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
          user: 'Pranshu',
          action: 'Modified',
          module: 'Infrastructure',
          details: `Dispatched UniFi reboot cmd to AP: ${node.name}`
        });

        alert(`UniFi Controller command sent: rebooting Access Point "${node.name}"...`);
        window.renderIT(container, state, navigateTo);

        // Simulate reboot complete in 2.5 seconds
        setTimeout(() => {
          node.status = 'Online';
          // randomize client count slightly upon reconnecting
          node.clients = Math.floor(Math.random() * 25 + 15);
          
          state.itChangeLogs.unshift({
            timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
            user: 'System',
            action: 'Sync',
            module: 'Infrastructure',
            details: `UniFi Access Point "${node.name}" successfully re-adopted`
          });
          
          alert(`Access Point "${node.name}" has completed reboot and is online.`);
          window.renderIT(container, state, navigateTo);
        }, 2500);
      }
    });
  });

  // Sync UniFi Controller handler
  const syncBtn = document.getElementById('sync-unifi-btn');
  const syncBlock = document.getElementById('unifi-sync-block');
  const progressBar = document.getElementById('sync-unifi-progress-bar');
  const syncStage = document.getElementById('sync-stage');

  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      syncBlock.style.display = 'flex';
      progressBar.style.width = '0%';
      syncStage.textContent = 'REST Handshake';

      let percentage = 0;
      const interval = setInterval(() => {
        percentage += 20;
        progressBar.style.width = `${percentage}%`;
        
        if (percentage === 40) {
          syncStage.textContent = 'Parsing API Payload';
        } else if (percentage === 80) {
          syncStage.textContent = 'Adopting Devices';
        }

        if (percentage >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            syncBlock.style.display = 'none';
            // Randomize active clients slightly to show dynamic sync
            state.unifiNodes.forEach(node => {
              if (node.status === 'Online') {
                if (node.type === 'Access Point') {
                  node.clients = Math.floor(Math.random() * 30 + 15);
                } else if (node.type === 'Gateway') {
                  // Gateway clients is sum of others
                  node.clients = state.unifiNodes
                    .filter(x => x.type !== 'Gateway')
                    .reduce((s, x) => s + (x.status === 'Online' ? x.clients : 0), 0);
                }
              }
            });

            // Update sync uptime status slightly
            const now = new Date();
            state.unifiUptime = '14d 6h ' + now.getMinutes() + 'm';

            state.itChangeLogs.unshift({
              timestamp: now.toISOString().slice(0, 16).replace('T', ' '),
              user: 'Pranshu',
              action: 'Sync',
              module: 'Infrastructure',
              details: 'Synchronized telemetry stats from UniFi Controller Cloud API'
            });

            alert('UniFi controller sync successful. Telemetry updated.');
            window.renderIT(container, state, navigateTo);
          }, 300);
        }
      }, 150);
    });
  }

  // Provision AP Config handler
  const provisionBtn = document.getElementById('provision-config-btn');
  if (provisionBtn) {
    provisionBtn.addEventListener('click', () => {
      const selected = prompt('Select UniFi AP to provision config:\n1 - Reception AP\n2 - Executive Suite AP\n3 - Main Hall AP\n4 - Outdoor AP');
      if (selected >= 1 && selected <= 4) {
        const apIndex = parseInt(selected) + 1; // Nodes index 2, 3, 4, 5 are APs
        const ap = state.unifiNodes[apIndex];
        if (ap) {
          alert(`Deploying wireless provisioning profile to AP "${ap.name}"... Config adopted successfully.`);
          state.itChangeLogs.unshift({
            timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
            user: 'Pranshu',
            action: 'Modified',
            module: 'Infrastructure',
            details: `Provisioned SSID settings on AP: ${ap.name}`
          });
          window.renderIT(container, state, navigateTo);
        }
      }
    });
  }
}

window.renderIT = renderIT;
