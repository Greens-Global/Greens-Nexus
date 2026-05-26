// views/investorRelations.js
// Renders the Investor Relations view: Dashboard, Reports, Distributions

function renderInvestorRelations(container, state, navigateTo) {
  const activeSubTab = state.activeInvestorSubTab || 'investor-dashboard';

  const styleId = 'investor-relations-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .investor-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .investor-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
        flex-wrap: wrap;
      }
      .investor-tab-btn {
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
      .investor-tab-btn:hover {
        color: var(--text-primary);
      }
      .investor-tab-btn.active {
        color: var(--text-primary);
      }
      .investor-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .investor-container {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 24px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 24px;
      }
      .investor-charts-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        margin-bottom: 24px;
      }
      @media (max-width: 768px) {
        .investor-charts-grid {
          grid-template-columns: 1fr;
        }
      }
      .funding-bar-row {
        margin-bottom: 16px;
      }
      .funding-bar-header {
        display: flex;
        justify-content: space-between;
        font-size: 0.85rem;
        margin-bottom: 6px;
      }
      .funding-bar-outer {
        width: 100%;
        height: 8px;
        background-color: var(--border-color);
        border-radius: 4px;
        overflow: hidden;
      }
      .funding-bar-inner {
        height: 100%;
        border-radius: 4px;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Initialize Investor Relations data if missing
  if (!state.investorEquityList) {
    state.investorEquityList = [
      { id: 1, investor: 'Vance Capital Holdings', amount: 8500000, project: 'Harbor View Condos', share: 34.7, date: '2024-05-10', email: 'invest@vancecapital.com' },
      { id: 2, investor: 'Main Street Equity Group', amount: 12000000, project: 'Downtown Commercial Complex', share: 49.0, date: '2023-11-15', email: 'funding@mainstreet.com' },
      { id: 3, investor: 'Green Valley Partners', amount: 4000000, project: 'Oakridge Subdivision Phase 1', share: 16.3, date: '2025-02-20', email: 'gvpartners@valley.com' },
      { id: 4, investor: 'GG Founders Pool', amount: 3000000, project: 'North Industrial Warehouse', share: 12.2, date: '2022-09-01', email: 'internal-pool@greensglobal.com' }
    ];
  }

  if (!state.investorReports) {
    state.investorReports = [
      { id: 1, title: 'Q2 2026 Investor Prospectus.pdf', category: 'Prospectus', size: '3.8 MB', date: '2026-05-15' },
      { id: 2, title: 'K-1 Capital Account Tax Form 2025.zip', category: 'Tax Documents', size: '1.2 MB', date: '2026-03-01' },
      { id: 3, title: 'GG Real Estate Funds Audit Report 2025.pdf', category: 'Audit Statements', size: '5.2 MB', date: '2026-04-10' },
      { id: 4, title: 'Q1 2026 Financial Performance Summary.pdf', category: 'Quarterly Financials', size: '1.8 MB', date: '2026-04-15' },
      { id: 5, title: 'Investor Distribution Register Q1.pdf', category: 'Distributions Log', size: '920 KB', date: '2026-04-02' }
    ];
  }

  let tabContentHtml = '';
  switch (activeSubTab) {
    case 'investor-dashboard':
      tabContentHtml = renderInvestorDashboard(state.investorEquityList);
      break;
    case 'investor-reports':
      tabContentHtml = renderInvestorReportsTab(state.investorReports);
      break;
  }

  container.innerHTML = `
    <div class="investor-view">
      <!-- Header -->
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>Investor Relations</h2>
          <p>Financial equity dashboards, distribution logs, and reports directories</p>
        </div>
        <div style="display: flex; gap: 12px; align-items: center;">
          <span style="font-size: 0.8rem; background-color: var(--bg-secondary); border: 1px solid var(--border-color); padding: 6px 12px; border-radius: 20px; color: var(--text-secondary); font-weight: 600;">
            <i data-lucide="coins" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> Investor Portal
          </span>
        </div>
      </div>

      <!-- Horizontal Tab Navigation -->
      <div class="investor-tabs-nav">
        <button class="investor-tab-btn ${activeSubTab === 'investor-dashboard' ? 'active' : ''}" data-tab="investor-dashboard">
          <i data-lucide="bar-chart-3" style="width: 18px; height: 18px;"></i> Investor Dashboard
        </button>
        <button class="investor-tab-btn ${activeSubTab === 'investor-reports' ? 'active' : ''}" data-tab="investor-reports">
          <i data-lucide="file-spreadsheet" style="width: 18px; height: 18px;"></i> Reports
        </button>
      </div>

      <!-- Tab Content Area -->
      <div class="investor-container">
        ${tabContentHtml}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach horizontal tab listeners
  const tabBtns = container.querySelectorAll('.investor-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeInvestorSubTab = selectedTab;
      navigateTo('investor-relations');
    });
  });

  // Attach handlers
  if (activeSubTab === 'investor-dashboard') {
    attachInvestorDashboardHandlers(container, state);
  } else if (activeSubTab === 'investor-reports') {
    attachInvestorReportsHandlers(container, state);
  }
}

// -------------------------------------------
// 1. Investor Dashboard Tab
// -------------------------------------------
function renderInvestorDashboard(equityList) {
  // Aggregate stats
  const totalEquity = equityList.reduce((sum, item) => sum + item.amount, 0);

  return `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Equity Funding & Performance</h3>
      <p style="color: var(--text-secondary); font-size: 0.85rem;">Review active holdings values, capital calls, and average returns rates</p>
    </div>

    <!-- 4 KPI Cards -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Total Equity Invested</span>
          <div class="kpi-icon-container" style="color: hsl(var(--color-blue));">
            <i data-lucide="dollar-sign"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">$${(totalEquity / 1000000).toFixed(1)}M</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">+12% vs Q1</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Active Fund Investors</span>
          <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
            <i data-lucide="users"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">42</div>
        <div class="kpi-helper" style="color: var(--text-secondary);">Corporate & Private</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Avg Portfolio ROI</span>
          <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
            <i data-lucide="trending-up"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">16.4%</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">+1.2% over benchmark</div>
      </div>

      <div class="kpi-card card-orange" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Q2 Distributions Status</span>
          <div class="kpi-icon-container" style="color: hsl(var(--color-orange));">
            <i data-lucide="coins"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">$120K</div>
        <div class="kpi-helper" style="color: var(--text-secondary); font-weight: 500;">Pending approval</div>
      </div>
    </div>

    <!-- Charts Split Row -->
    <div class="investor-charts-grid">
      <!-- Left: Capital Invested by Project -->
      <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; background-color: var(--bg-primary);">
        <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 16px; color: var(--text-primary);">Equity Distribution by Project</h4>
        
        ${equityList.map((item, idx) => {
          let barColor = 'hsl(var(--color-blue))';
          if (idx === 1) barColor = 'hsl(var(--color-green))';
          if (idx === 2) barColor = 'hsl(var(--color-purple))';
          if (idx === 3) barColor = 'hsl(var(--color-orange))';

          return `
            <div class="funding-bar-row">
              <div class="funding-bar-header">
                <span>${item.project}</span>
                <strong style="color: var(--text-primary);">$${(item.amount / 1000000).toFixed(1)}M (${item.share}%)</strong>
              </div>
              <div class="funding-bar-outer">
                <div class="funding-bar-inner" style="width: ${item.share}%; background-color: ${barColor};"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Right: Active Holdings List -->
      <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; background-color: var(--bg-primary);">
        <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 16px; color: var(--text-primary);">Key Holding Portfolios</h4>
        
        <div style="display: flex; flex-direction: column; gap: 10px;">
          ${equityList.map(item => `
            <div style="padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-color); background-color: var(--bg-secondary); display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
              <div>
                <strong style="color: var(--text-primary); display: block;">${item.investor}</strong>
                <span style="font-size: 0.75rem; color: var(--text-secondary);">${item.email}</span>
              </div>
              <div style="text-align: right;">
                <strong style="color: var(--text-primary); display: block;">$${(item.amount / 1000000).toFixed(2)}M</strong>
                <span style="font-size: 0.75rem; color: var(--text-muted);">Deposited: ${item.date}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- Distribution roster trigger -->
    <div style="display: flex; justify-content: flex-end;">
      <button class="primary-btn" id="audit-distributions-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="check-circle" style="width: 14px; height: 14px; margin-right: 6px;"></i> Approve Q2 Distributions ($120K)
      </button>
    </div>
  `;
}

function attachInvestorDashboardHandlers(container, state) {
  container.querySelector('#audit-distributions-btn').addEventListener('click', (e) => {
    const doubleCheck = confirm('Are you sure you want to approve and release Q2 Investor Distributions ($120,000)?\n\nThis will trigger automated bank transfers to registered investor accounts.');
    if (doubleCheck) {
      alert('Q2 distributions approved and batch transfers initiated! Transaction log updated.');
    }
  });
}

// -------------------------------------------
// 2. Investor Reports Tab
// -------------------------------------------
function renderInvestorReportsTab(reports) {
  return `
    <div style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
      <div>
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 4px;">Investor Financial Reports Room</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Search and download financial prospectus catalogs, K-1 tax zip archives, and audit records</p>
      </div>
      <div>
        <input type="text" id="report-search-input" class="form-input" placeholder="Search report name..." style="width: 220px; padding: 6px 12px; font-size: 0.85rem;">
      </div>
    </div>

    <div class="req-table-wrapper">
      <table class="req-table" id="investor-reports-table">
        <thead>
          <tr>
            <th>Report Title</th>
            <th>Category</th>
            <th>File Size</th>
            <th>Publication Date</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${reports.map(r => `
            <tr class="report-row-item">
              <td style="font-weight: 600;" class="report-title-cell">${r.title}</td>
              <td style="font-weight: 500; color: var(--text-secondary);">${r.category}</td>
              <td>${r.size}</td>
              <td style="font-family: monospace; font-size: 0.85rem;">${r.date}</td>
              <td style="text-align: right;">
                <button class="secondary-btn download-report-btn" data-title="${r.title}" style="padding: 4px 10px; font-size: 0.775rem;">
                  <i data-lucide="download" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"></i> Download PDF
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function attachInvestorReportsHandlers(container, state) {
  // Download button
  const dlBtns = container.querySelectorAll('.download-report-btn');
  dlBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const title = btn.getAttribute('data-title');
      alert(`Simulating download for: ${title}\n\nGreens Nexus Investor Cryptographic Verification... OK.`);
    });
  });

  // Search input
  const searchInput = container.querySelector('#report-search-input');
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const rows = container.querySelectorAll('.report-row-item');
    rows.forEach(row => {
      const title = row.querySelector('.report-title-cell').textContent.toLowerCase();
      if (title.includes(query)) {
        row.style.display = '';
      } else {
        row.style.display = 'none';
      }
    });
  });
}

// Bind to window
window.renderInvestorRelations = renderInvestorRelations;
