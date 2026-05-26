// views/marketing.js
// Renders the merged Marketing & Reputation dashboard with Property Filter

function renderMarketing(container, state, navigateTo) {
  const activeSubTab = state.activeMarketingSubTab || 'ads';
  const selectedProperty = state.marketingPropertyFilter || 'all';

  // Inject scoped styles if they don't exist
  const styleId = 'marketing-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .marketing-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      .marketing-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      .marketing-tab-btn {
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
      .marketing-tab-btn:hover {
        color: var(--text-primary);
      }
      .marketing-tab-btn.active {
        color: var(--text-primary);
      }
      .marketing-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }
      .review-feed-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 16px;
        box-shadow: var(--shadow-sm);
        transition: transform var(--transition-fast), border-color var(--transition-fast);
      }
      .review-feed-card:hover {
        border-color: var(--border-hover);
      }
      .review-feed-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      .reviewer-row {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .reviewer-img-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        color: var(--text-primary);
        font-family: 'Plus Jakarta Sans', sans-serif;
      }
      .reviewer-text-details {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .reviewer-title-line {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .reviewer-name-txt {
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--text-primary);
      }
      .review-platform-badge {
        font-size: 0.75rem;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        padding: 2px 6px;
        border-radius: 4px;
        color: var(--text-secondary);
        font-weight: 500;
      }
      .review-property-badge {
        font-size: 0.75rem;
        background-color: hsla(var(--color-blue), 0.05);
        border: 1px solid hsla(var(--color-blue), 0.15);
        padding: 2px 6px;
        border-radius: 4px;
        color: hsl(var(--color-blue));
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .review-meta-time {
        font-size: 0.8rem;
        color: var(--text-muted);
      }
      .review-stars-group {
        display: flex;
        gap: 2px;
        color: hsl(var(--color-gold));
      }
      .review-stars-group svg {
        width: 14px;
        height: 14px;
      }
      .review-badge-status {
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .review-badge-new {
        background-color: hsla(var(--color-red), 0.1);
        color: hsl(var(--color-red));
      }
      .review-badge-suggested {
        background-color: var(--bg-secondary);
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
      }
      .review-badge-replied {
        background-color: hsla(var(--color-green), 0.1);
        color: hsl(var(--color-green));
      }
      .review-comment-body {
        font-size: 0.925rem;
        color: var(--text-primary);
        line-height: 1.6;
        margin-bottom: 16px;
        padding-left: 2px;
      }
      .ai-suggestion-box {
        background-color: hsla(var(--color-blue), 0.04);
        border: 1px solid hsla(var(--color-blue), 0.15);
        border-radius: 8px;
        padding: 16px;
        margin-top: 12px;
        position: relative;
        animation: fadeIn 0.2s ease-in-out;
      }
      .ai-suggestion-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 700;
        font-size: 0.85rem;
        color: hsl(var(--color-blue));
        margin-bottom: 8px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ai-suggestion-text {
        font-size: 0.9rem;
        color: var(--text-primary);
        line-height: 1.5;
        margin-bottom: 12px;
        font-style: italic;
      }
      .ai-suggestion-actions {
        display: flex;
        justify-content: flex-start;
      }
      .ai-review-btn {
        background: none;
        border: 1px solid hsla(var(--color-blue), 0.25);
        color: hsl(var(--color-blue));
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all var(--transition-fast);
      }
      .ai-review-btn:hover {
        background-color: hsla(var(--color-blue), 0.08);
        border-color: hsl(var(--color-blue));
      }
      .posted-reply-box {
        background-color: hsla(var(--color-green), 0.03);
        border-left: 3px solid hsl(var(--color-green));
        border-radius: 0 8px 8px 0;
        padding: 12px 16px;
        margin-top: 12px;
      }
      .posted-reply-header {
        font-weight: 700;
        font-size: 0.85rem;
        color: hsl(var(--color-green));
        margin-bottom: 4px;
        font-family: 'Plus Jakarta Sans', sans-serif;
      }
      .posted-reply-body {
        font-size: 0.9rem;
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .filter-pills-row {
        display: flex;
        gap: 8px;
        margin-bottom: 20px;
        flex-wrap: wrap;
      }
      .filter-pill {
        border-radius: 20px;
        border: 1px solid var(--border-color);
        background-color: var(--bg-card);
        color: var(--text-secondary);
        padding: 6px 14px;
        font-weight: 600;
        cursor: pointer;
        font-size: 0.825rem;
        transition: all var(--transition-fast);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .filter-pill:hover {
        border-color: var(--border-hover);
        color: var(--text-primary);
      }
      .filter-pill.active {
        background-color: var(--text-primary);
        color: var(--bg-primary);
        border-color: var(--text-primary);
      }
      [data-theme="dark"] .filter-pill.active {
        background-color: #ffffff;
        color: #000000;
        border-color: #ffffff;
      }
      .reply-editor-textarea {
        width: 100%;
        min-height: 100px;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px;
        font-size: 0.9rem;
        font-family: inherit;
        background-color: var(--bg-primary);
        color: var(--text-primary);
        resize: vertical;
        outline: none;
        transition: border-color var(--transition-fast);
        margin-bottom: 12px;
      }
      .reply-editor-textarea:focus {
        border-color: hsl(var(--color-blue));
      }
      .stats-footer-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
        margin-top: 24px;
      }
      .stats-footer-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        box-shadow: var(--shadow-sm);
      }
      .stats-footer-card h4 {
        font-size: 0.9rem;
        color: var(--text-secondary);
        margin-bottom: 16px;
        font-family: 'Plus Jakarta Sans', sans-serif;
      }
      .active-campaign-badge {
        background-color: #000000;
        color: #ffffff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        display: inline-block;
      }
      [data-theme="dark"] .active-campaign-badge {
        background-color: #ffffff;
        color: #000000;
      }
      .paused-campaign-badge {
        background-color: var(--bg-secondary);
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        display: inline-block;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Filter campaigns and reviews
  let filteredCampaigns = state.marketingCampaigns;
  let filteredReviews = state.reviews;

  if (selectedProperty !== 'all') {
    filteredCampaigns = state.marketingCampaigns.filter(c => 
      c.property.toLowerCase().includes(selectedProperty.toLowerCase()) || 
      selectedProperty.toLowerCase().includes(c.property.toLowerCase())
    );
    filteredReviews = state.reviews.filter(r => 
      r.property && (
        r.property.toLowerCase().includes(selectedProperty.toLowerCase()) || 
        selectedProperty.toLowerCase().includes(r.property.toLowerCase())
      )
    );
  }

  // Render Layout
  container.innerHTML = `
    <div class="marketing-view">
      <!-- Top header layout with Filter -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; border-bottom: 1px solid var(--border-color); padding-bottom: 16px;">
        <!-- Merged Tab Switcher -->
        <div class="marketing-tabs-nav" style="margin-bottom: 0; border-bottom: none; padding-bottom: 0;">
          <button class="marketing-tab-btn ${activeSubTab === 'ads' ? 'active' : ''}" data-tab="ads">
            <i data-lucide="megaphone" style="width: 18px; height: 18px;"></i> Google Ads Performance
          </button>
          <button class="marketing-tab-btn ${activeSubTab === 'reputation' ? 'active' : ''}" data-tab="reputation">
            <i data-lucide="star" style="width: 18px; height: 18px;"></i> Reputation Management
          </button>
        </div>

        <!-- Property Filter Dropdown -->
        <div style="display: flex; align-items: center; gap: 8px;">
          <label for="marketing-property-filter" style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">Property Filter:</label>
          <select id="marketing-property-filter" class="form-select" style="padding: 6px 12px; font-size: 0.85rem; width: 220px; background-color: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; outline: none;">
            <option value="all" ${selectedProperty === 'all' ? 'selected' : ''}>All Properties</option>
            <option value="Harbor View" ${selectedProperty === 'Harbor View' ? 'selected' : ''}>Harbor View</option>
            <option value="Downtown Complex" ${selectedProperty === 'Downtown Complex' ? 'selected' : ''}>Downtown Complex</option>
            <option value="Oakridge" ${selectedProperty === 'Oakridge' ? 'selected' : ''}>Oakridge Subdivision</option>
            <option value="Site-B" ${selectedProperty === 'Site-B' ? 'selected' : ''}>Site-B Development</option>
            <option value="North Industrial" ${selectedProperty === 'North Industrial' ? 'selected' : ''}>North Industrial</option>
            <option value="Residential Towers" ${selectedProperty === 'Residential Towers' ? 'selected' : ''}>Residential Towers</option>
            <option value="Luxury Condos" ${selectedProperty === 'Luxury Condos' ? 'selected' : ''}>Luxury Condos</option>
            <option value="Commercial Spaces" ${selectedProperty === 'Commercial Spaces' ? 'selected' : ''}>Commercial Spaces</option>
          </select>
        </div>
      </div>

      <!-- Active Subtab Panel Content -->
      <div id="marketing-panel-content">
        ${activeSubTab === 'ads' ? renderAdsDashboard(filteredCampaigns) : renderReputationDashboard(filteredReviews, state)}
      </div>
    </div>
  `;

  // Bind Lucide Icons
  lucide.createIcons();

  // Attach event handlers for the Sub-tab Navigation
  const tabBtns = container.querySelectorAll('.marketing-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeMarketingSubTab = selectedTab;
      navigateTo('marketing');
    });
  });

  // Attach property filter handler
  const propFilterEl = container.querySelector('#marketing-property-filter');
  propFilterEl.addEventListener('change', (e) => {
    state.marketingPropertyFilter = e.target.value;
    renderMarketing(container, state, navigateTo);
  });

  // Attach handlers depending on active sub-tab
  if (activeSubTab === 'ads') {
    attachAdsHandlers(container, state, navigateTo);
  } else {
    attachReputationHandlers(container, state, () => renderMarketing(container, state, navigateTo));
  }
}

// ----------------------------------------------------
// 1. Google Ads Performance Tab Renderers & Handlers
// ----------------------------------------------------
function renderAdsDashboard(campaigns) {
  // Aggregate KPIs dynamically
  const impressions = campaigns.reduce((sum, c) => sum + c.impressions, 0);
  const clicks = campaigns.reduce((sum, c) => sum + c.clicks, 0);
  const conversions = campaigns.reduce((sum, c) => sum + c.conversions, 0);
  const abandonedCarts = campaigns.reduce((sum, c) => sum + c.abandonedCarts, 0);
  const spend = campaigns.reduce((sum, c) => sum + c.spend, 0);
  
  const costPerConv = conversions > 0 ? (spend / conversions) : 0;
  const cac = conversions > 0 ? (spend / conversions * 1.55) : 0; // Simulated CAC ratio
  const convRate = clicks > 0 ? (conversions / clicks * 100) : 0;

  // Find top campaign
  let topCampaign = 'None';
  let topConv = 0;
  campaigns.forEach(c => {
    if (c.conversions > topConv) {
      topConv = c.conversions;
      topCampaign = c.name;
    }
  });

  // Find highest abandoned
  let topAbandoned = 'None';
  let topAbCount = 0;
  campaigns.forEach(c => {
    if (c.abandonedCarts > topAbCount) {
      topAbCount = c.abandonedCarts;
      topAbandoned = c.name;
    }
  });

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Google Ads Performance Metrics</h2>
        <p>Google Ads campaigns analysis, spend telemetry, and conversion analytics</p>
      </div>
      <div style="display: flex; gap: 12px; align-items: center;">
        <button class="secondary-btn" id="ads-date-btn" style="display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="calendar" style="width: 16px; height: 16px;"></i> Date Range
        </button>
        <button class="secondary-btn" id="ads-export-btn" style="display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="download" style="width: 16px; height: 16px;"></i> Export
        </button>
      </div>
    </div>

    <!-- 8 KPI Cards (4 columns) -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <!-- Impressions -->
      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Impressions</span>
          <i data-lucide="eye" style="color: hsl(var(--color-blue));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${impressions.toLocaleString()}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">Live impressions synced</div>
      </div>

      <!-- Clicks -->
      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Clicks</span>
          <i data-lucide="mouse-pointer-click" style="color: hsl(var(--color-green));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${clicks.toLocaleString()}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">CPC traffic load</div>
      </div>

      <!-- Conversions -->
      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Conversions</span>
          <i data-lucide="trending-up" style="color: hsl(var(--color-green));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${conversions}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">Lead submissions</div>
      </div>

      <!-- Abandoned Carts -->
      <div class="kpi-card card-orange" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Abandoned Carts</span>
          <i data-lucide="shopping-cart" style="color: hsl(var(--color-orange));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${abandonedCarts}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-red)); font-weight: 600;">Abandoned inquiries</div>
      </div>

      <!-- Cost per Conversion -->
      <div class="kpi-card card-purple" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Cost per Conversion</span>
          <i data-lucide="dollar-sign" style="color: hsl(var(--color-purple));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">$${costPerConv.toFixed(2)}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">Google Ads cost ratio</div>
      </div>

      <!-- Customer Acquisition Cost -->
      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">CAC Estimation</span>
          <i data-lucide="users" style="color: hsl(var(--color-blue));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">$${cac.toFixed(2)}</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">Blended marketing CAC</div>
      </div>

      <!-- Ad Spend -->
      <div class="kpi-card card-red" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Ad Spend</span>
          <i data-lucide="dollar-sign" style="color: hsl(var(--color-red));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">$${spend.toLocaleString()}</div>
        <div class="kpi-helper" style="color: var(--text-secondary);">Total budget disbursed</div>
      </div>

      <!-- Conversion Rate -->
      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Conversion Rate</span>
          <i data-lucide="percent" style="color: hsl(var(--color-green));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${convRate.toFixed(2)}%</div>
        <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">Conversion conversion ratio</div>
      </div>
    </div>

    <!-- Campaigns Table -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Google Ads Campaign Performance</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Detailed metrics for all active campaigns</p>
      </div>
      <div class="req-table-wrapper">
        <table class="req-table">
          <thead>
            <tr>
              <th>Campaign Name</th>
              <th>Property</th>
              <th>Platform</th>
              <th>Impressions</th>
              <th>Clicks</th>
              <th>Conversions</th>
              <th>Abandoned Carts</th>
              <th>Spend</th>
              <th>Cost/Conv.</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${campaigns.length === 0 ? `
              <tr>
                <td colspan="10" style="text-align: center; color: var(--text-secondary); padding: 24px;">No campaigns match the selected property filter.</td>
              </tr>
            ` : campaigns.map(c => `
              <tr>
                <td style="font-weight: 600;">${c.name}</td>
                <td>${c.property}</td>
                <td>${c.platform}</td>
                <td style="font-family: 'Inter', sans-serif;">${c.impressions.toLocaleString()}</td>
                <td style="font-family: 'Inter', sans-serif;">${c.clicks.toLocaleString()}</td>
                <td style="font-family: 'Inter', sans-serif; font-weight: 600;">${c.conversions}</td>
                <td style="font-family: 'Inter', sans-serif; color: hsl(var(--color-orange)); font-weight: 600;">${c.abandonedCarts}</td>
                <td style="font-family: 'Inter', sans-serif; font-weight: 600;">$${c.spend.toLocaleString()}</td>
                <td style="font-family: 'Inter', sans-serif;">$${c.costPerConv.toFixed(2)}</td>
                <td>
                  <span class="${c.status === 'Active' ? 'active-campaign-badge' : 'paused-campaign-badge'}">
                    ${c.status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 3-Column Footer Stats -->
    <div class="stats-footer-grid">
      <div class="stats-footer-card">
        <h4>Top Performing Campaign</h4>
        <div style="font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; font-size: 1.1rem; color: var(--text-primary); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${topCampaign}</div>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="color: var(--text-secondary); font-size: 0.85rem;">Conversions:</span>
          <span style="color: hsl(var(--color-green)); font-weight: 700; font-size: 1.2rem;">${topConv}</span>
        </div>
      </div>

      <div class="stats-footer-card">
        <h4>Highest Abandoned Carts</h4>
        <div style="font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; font-size: 1.1rem; color: var(--text-primary); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${topAbandoned}</div>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="color: var(--text-secondary); font-size: 0.85rem;">Abandoned:</span>
          <span style="color: hsl(var(--color-orange)); font-weight: 700; font-size: 1.2rem;">${topAbCount}</span>
        </div>
      </div>

      <div class="stats-footer-card">
        <h4>Overall Summary</h4>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--text-secondary); font-size: 0.85rem;">Total Spend:</span>
            <span style="font-weight: 700; color: var(--text-primary);">$${spend.toLocaleString()}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--text-secondary); font-size: 0.85rem;">Conversions:</span>
            <span style="font-weight: 700; color: hsl(var(--color-green)); font-size: 1.05rem;">${conversions}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachAdsHandlers(container, state, navigateTo) {
  container.querySelector('#ads-date-btn').addEventListener('click', () => {
    alert('Date range picker: Showing Google Ads data for last 30 days (May 1 - May 30, 2026).');
  });

  container.querySelector('#ads-export-btn').addEventListener('click', () => {
    alert('Exporting filtered Google Ads performance reports CSV...');
  });
}

// ----------------------------------------------------
// 2. Reputation Management Tab Renderers & Handlers
// ----------------------------------------------------
function renderReputationDashboard(reviews, state) {
  // Calculate dynamic stats
  const averageRating = reviews.length > 0 
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : '0.0';
  const pendingCount = reviews.filter(r => !r.replied).length;
  const positiveCount = reviews.filter(r => r.rating >= 4).length;
  const positivePercent = reviews.length > 0 ? Math.round((positiveCount / reviews.length) * 100) : 0;
  const responseRate = reviews.length > 0 
    ? Math.round((reviews.filter(r => r.replied).length / reviews.length) * 100)
    : 0;

  const selectedFilter = state.activeReviewFilter || 'all';

  // Apply sub-filters
  let finalReviews = reviews;
  if (selectedFilter === 'pending') {
    finalReviews = reviews.filter(r => !r.replied);
  } else if (selectedFilter === 'ai') {
    finalReviews = reviews.filter(r => !r.replied && r.aiReply);
  }

  return `
    <!-- Page Header -->
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Reputation Management</h2>
        <p>Monitor Google reviews, filter by building site, and approve AI suggested responses</p>
      </div>
      <div style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; border: 1px solid hsl(var(--color-gold)); background-color: hsla(var(--color-gold), 0.1); color: hsl(var(--color-gold)); font-size: 0.85rem; font-weight: 600;">
        <i data-lucide="sparkles" style="width: 14px; height: 14px;"></i> AI-Powered Assistance Active
      </div>
    </div>

    <!-- 4 KPI Cards -->
    <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-gold" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Average Rating</span>
          <i data-lucide="star" style="fill: hsl(var(--color-gold)); stroke: hsl(var(--color-gold));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${averageRating}</div>
        <div class="kpi-helper" style="color: var(--text-muted);">Based on ${reviews.length} reviews</div>
      </div>

      <div class="kpi-card card-orange" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Pending Replies</span>
          <i data-lucide="flag" style="color: hsl(var(--color-orange));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif; color: ${pendingCount > 0 ? 'hsl(var(--color-red))' : 'inherit'};">${pendingCount}</div>
        <div class="kpi-helper" style="color: var(--text-muted); font-weight: 500;">Need responses</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Positive Reviews</span>
          <i data-lucide="thumbs-up" style="color: hsl(var(--color-green));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${positivePercent}%</div>
        <div class="kpi-helper" style="color: var(--text-muted);">4+ star ratings</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default;">
        <div class="kpi-card-header">
          <span class="kpi-title" style="color: var(--text-secondary);">Response Rate</span>
          <i data-lucide="clock" style="color: hsl(var(--color-blue));"></i>
        </div>
        <div class="kpi-stat" style="font-size: 1.8rem; font-family: 'Inter', sans-serif;">${responseRate}%</div>
        <div class="kpi-helper" style="color: var(--text-muted);">Total responses posted</div>
      </div>
    </div>

    <!-- AI Notice Banner -->
    <div style="display: flex; gap: 12px; align-items: flex-start; padding: 16px; border-radius: 8px; border: 1px solid var(--border-color); background-color: var(--bg-secondary); margin-bottom: 24px;">
      <div style="color: hsl(var(--color-purple)); padding: 2px;">
        <i data-lucide="sparkles" style="width: 20px; height: 20px;"></i>
      </div>
      <div>
        <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; color: var(--text-primary); display: block; margin-bottom: 4px;">AI-Assisted Reputation Management:</strong>
        <span style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">Select a property to isolate customer reviews. Check AI suggested responses, click edit to refine, or approve them directly to publish to Google Business profiles.</span>
      </div>
    </div>

    <!-- Sub-sub tab pills -->
    <div class="filter-pills-row">
      <button class="filter-pill ${selectedFilter === 'all' ? 'active' : ''}" data-filter="all">All Reviews</button>
      <button class="filter-pill ${selectedFilter === 'pending' ? 'active' : ''}" data-filter="pending">Pending Reply (${pendingCount})</button>
      <button class="filter-pill ${selectedFilter === 'ai' ? 'active' : ''}" data-filter="ai">AI Suggested</button>
    </div>

    <!-- Reviews list -->
    <div class="reviews-list-container">
      ${finalReviews.length === 0 ? `
        <div style="text-align: center; padding: 40px; color: var(--text-secondary); background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;">
          <i data-lucide="inbox" style="width: 48px; height: 48px; stroke-width: 1.5px; margin-bottom: 12px; color: var(--text-muted);"></i>
          <p style="font-weight: 500;">No reviews match this filter.</p>
        </div>
      ` : finalReviews.map(r => {
        let starsHtml = '';
        for (let i = 1; i <= 5; i++) {
          starsHtml += `<i data-lucide="star" style="fill: ${i <= r.rating ? 'hsl(var(--color-gold))' : 'none'}; stroke: hsl(var(--color-gold));"></i>`;
        }

        let actionAreaHtml = '';
        if (r.replied) {
          actionAreaHtml = `
            <div class="posted-reply-box">
              <div class="posted-reply-header">Greens Nexus Response</div>
              <div class="posted-reply-body">${r.replyText}</div>
            </div>
          `;
        } else if (r.isEditingReply) {
          actionAreaHtml = `
            <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-top: 12px;">
              <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-primary); margin-bottom: 8px; font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; gap: 4px;">
                <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i> Edit Response to ${r.name}
              </div>
              <textarea class="reply-editor-textarea reply-edit-input-${r.id}" rows="4">${r.editingText || r.aiReply || ''}</textarea>
              <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button class="secondary-btn cancel-edit-btn" data-id="${r.id}" style="padding: 6px 12px; font-size: 0.8rem;">Cancel</button>
                <button class="primary-btn post-reply-btn" data-id="${r.id}" style="padding: 6px 14px; font-size: 0.8rem; background-color: #000000; color: #ffffff;">Approve & Post Reply</button>
              </div>
            </div>
          `;
        } else if (r.aiReply) {
          actionAreaHtml = `
            <div class="ai-suggestion-box">
              <div class="ai-suggestion-header">
                <i data-lucide="sparkles" style="width: 14px; height: 14px; fill: hsl(var(--color-blue)); color: hsl(var(--color-blue));"></i> AI Suggested Reply
              </div>
              <div class="ai-suggestion-text">"${r.aiReply}"</div>
              <div class="ai-suggestion-actions">
                <button class="ai-review-btn edit-ai-reply-btn" data-id="${r.id}">
                  <i data-lucide="sparkles" style="width: 14px; height: 14px;"></i> Review & Edit AI Reply
                </button>
              </div>
            </div>
          `;
        } else {
          actionAreaHtml = `
            <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-top: 12px;">
              <textarea class="reply-editor-textarea reply-write-input-${r.id}" placeholder="Write a response to ${r.name}..."></textarea>
              <div style="display: flex; justify-content: flex-end;">
                <button class="primary-btn post-write-btn" data-id="${r.id}" style="padding: 6px 14px; font-size: 0.8rem; background-color: #000000; color: #ffffff;">Post Reply</button>
              </div>
            </div>
          `;
        }

        let badgeHtml = '';
        if (r.replied) {
          badgeHtml = `<span class="review-badge-status review-badge-replied">Replied</span>`;
        } else if (r.badge) {
          const badgeClass = r.badgeColor === 'red' ? 'review-badge-new' : 'review-badge-suggested';
          badgeHtml = `<span class="review-badge-status ${badgeClass}">${r.badge}</span>`;
        }

        return `
          <div class="review-feed-card" id="review-card-${r.id}">
            <div class="review-feed-header">
              <div class="reviewer-row">
                <div class="reviewer-img-avatar">${r.name.charAt(0)}</div>
                <div class="reviewer-text-details">
                  <div class="reviewer-title-line">
                    <span class="reviewer-name-txt">${r.name}</span>
                    <span class="review-platform-badge">${r.platform || 'Google'}</span>
                    ${r.property ? `
                      <span class="review-property-badge">
                        <i data-lucide="building" style="width: 12px; height: 12px;"></i> ${r.property}
                      </span>
                    ` : ''}
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
                    <div class="review-stars-group">
                      ${starsHtml}
                    </div>
                    <span class="review-meta-time">${r.date}</span>
                  </div>
                </div>
              </div>
              <div>
                ${badgeHtml}
              </div>
            </div>
            
            <div class="review-comment-body">
              "${r.comment}"
            </div>

            ${actionAreaHtml}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function attachReputationHandlers(container, state, refreshView) {
  // Pills filters clicking
  const filterPills = container.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      state.activeReviewFilter = pill.getAttribute('data-filter');
      refreshView();
    });
  });

  // Action: Click "Review & Edit AI Reply"
  const editBtns = container.querySelectorAll('.edit-ai-reply-btn');
  editBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const review = state.reviews.find(r => r.id === id);
      if (review) {
        review.isEditingReply = true;
        review.editingText = review.aiReply;
        refreshView();
      }
    });
  });

  // Action: Click "Cancel" on reply editor
  const cancelBtns = container.querySelectorAll('.cancel-edit-btn');
  cancelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const review = state.reviews.find(r => r.id === id);
      if (review) {
        review.isEditingReply = false;
        review.editingText = '';
        refreshView();
      }
    });
  });

  // Action: Click "Approve & Post Reply"
  const postBtns = container.querySelectorAll('.post-reply-btn');
  postBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const textInput = container.querySelector(`.reply-edit-input-${id}`);
      const replyText = textInput.value.trim();

      if (replyText) {
        const review = state.reviews.find(r => r.id === id);
        if (review) {
          review.replied = true;
          review.replyText = replyText;
          review.isEditingReply = false;
          review.badge = '';
          review.badgeColor = '';
          alert(`Reply to ${review.name} approved and posted successfully!`);
          refreshView();
        }
      } else {
        alert('Please write a response before posting.');
      }
    });
  });

  // Action: Click "Post Reply" (for standard textarea)
  const postWriteBtns = container.querySelectorAll('.post-write-btn');
  postWriteBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const textInput = container.querySelector(`.reply-write-input-${id}`);
      const replyText = textInput.value.trim();

      if (replyText) {
        const review = state.reviews.find(r => r.id === id);
        if (review) {
          review.replied = true;
          review.replyText = replyText;
          review.badge = '';
          review.badgeColor = '';
          alert(`Reply to ${review.name} posted successfully!`);
          refreshView();
        }
      } else {
        alert('Please write a response before posting.');
      }
    });
  });
}

// Bind to window for router execution
window.renderMarketing = renderMarketing;
