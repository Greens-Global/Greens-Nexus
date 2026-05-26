// views/dashboard.js
// Renders the main dashboard landing page matching the Figma screenshot

function renderDashboard(container, state, navigateTo) {
  // Update state values based on state arrays
  const tasksCount = state.tasks.filter(t => t.status !== 'done').length;
  const reviewsCount = state.reviews.filter(r => !r.replied).length;
  const approvalsCount = state.purchaseRequests.filter(p => p.status === 'pending').length;
  const purchasesCount = state.purchaseRequests.length;

  container.innerHTML = `
    <div class="dashboard-view">
      <!-- Greeting Section -->
      <section class="greeting-section">
        <h1 class="greeting-title">Good Evening, Pranshu</h1>
        <p class="greeting-sub">Here's what's happening with your work today</p>
      </section>

      <!-- KPI Cards Grid (4 Columns) -->
      <div class="cards-grid">
        <!-- 1. My Tasks -->
        <div class="kpi-card card-blue" data-nav="tasks">
          <div class="kpi-card-header">
            <span class="kpi-title">My Tasks</span>
            <div class="kpi-icon-container">
              <i data-lucide="check-square"></i>
            </div>
          </div>
          <div class="kpi-stat">${tasksCount}</div>
          <div class="kpi-helper">3 due today</div>
        </div>

        <!-- 2. Pending Approvals -->
        <div class="kpi-card card-orange" data-nav="purchase">
          <div class="kpi-card-header">
            <span class="kpi-title">Pending Approvals</span>
            <div class="kpi-icon-container">
              <i data-lucide="clock"></i>
            </div>
          </div>
          <div class="kpi-stat">${approvalsCount}</div>
          <div class="kpi-helper">Requires action</div>
        </div>

        <!-- 3. Team Workload -->
        <div class="kpi-card card-green">
          <div class="kpi-card-header">
            <span class="kpi-title">Team Workload</span>
            <div class="kpi-icon-container">
              <i data-lucide="users"></i>
            </div>
          </div>
          <div class="kpi-stat">87%</div>
          <div class="kpi-helper">Capacity</div>
        </div>

        <!-- 4. Upcoming Shifts -->
        <div class="kpi-card card-purple">
          <div class="kpi-card-header">
            <span class="kpi-title">Upcoming Shifts</span>
            <div class="kpi-icon-container">
              <i data-lucide="calendar"></i>
            </div>
          </div>
          <div class="kpi-stat">12</div>
          <div class="kpi-helper">This week</div>
        </div>

        <!-- 5. Open Purchase Requests -->
        <div class="kpi-card card-red" data-nav="purchase">
          <div class="kpi-card-header">
            <span class="kpi-title">Open Purchase Requests</span>
            <div class="kpi-icon-container">
              <i data-lucide="shopping-cart"></i>
            </div>
          </div>
          <div class="kpi-stat">${purchasesCount}</div>
          <div class="kpi-helper">Awaiting review</div>
        </div>

        <!-- 6. Recent SOP Updates -->
        <div class="kpi-card card-purple" data-nav="sop">
          <div class="kpi-card-header">
            <span class="kpi-title">Recent SOP Updates</span>
            <div class="kpi-icon-container">
              <i data-lucide="file-text"></i>
            </div>
          </div>
          <div class="kpi-stat">4</div>
          <div class="kpi-helper">New this week</div>
        </div>

        <!-- 7. Google Ads Performance -->
        <div class="kpi-card card-green" data-nav="marketing">
          <div class="kpi-card-header">
            <span class="kpi-title">Google Ads Performance</span>
            <div class="kpi-icon-container">
              <i data-lucide="trending-up"></i>
            </div>
          </div>
          <div class="kpi-stat">$4.2K</div>
          <div class="kpi-helper">This month</div>
        </div>

        <!-- 8. Google Reviews Pending -->
        <div class="kpi-card card-gold" data-nav="reputation">
          <div class="kpi-card-header">
            <span class="kpi-title">Google Reviews Pending</span>
            <div class="kpi-icon-container">
              <i data-lucide="star"></i>
            </div>
          </div>
          <div class="kpi-stat">${reviewsCount}</div>
          <div class="kpi-helper">Need reply</div>
        </div>
      </div>
    </div>
  `;

  // Initialize Lucide Icons for rendered content
  lucide.createIcons();

  // Attach navigation event handlers to clickable cards
  const clickableCards = container.querySelectorAll('.kpi-card[data-nav]');
  clickableCards.forEach(card => {
    card.addEventListener('click', () => {
      const destination = card.getAttribute('data-nav');
      if (destination === 'marketing') {
        state.activeMarketingSubTab = 'ads';
      }
      if (destination) {
        navigateTo(destination);
      }
    });
  });
}

// Bind to window for clarity (optional, but good practice in global scripts)
window.renderDashboard = renderDashboard;
