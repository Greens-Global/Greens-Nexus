// views/managerDashboard.js
// Renders the Manager Dashboard matching the Figma screenshot

function renderManagerDashboard(container, state, navigateTo) {
  // Setup data for our 6 active employees to match summary counts exactly
  const employees = [
    { name: 'Sarah Johnson', dept: 'Accounting', tasks: 8, est: 32, act: 18, completed: 3, inprogress: 4, overdue: 1, workload: 85 },
    { name: 'Michael Chen', dept: 'OPS', tasks: 12, est: 48, act: 24, completed: 5, inprogress: 6, overdue: 1, workload: 95 },
    { name: 'Emily Rodriguez', dept: 'Development', tasks: 6, est: 24, act: 12, completed: 2, inprogress: 3, overdue: 1, workload: 70 },
    { name: 'David Kim', dept: 'IT Support', tasks: 5, est: 20, act: 10, completed: 1, inprogress: 3, overdue: 1, workload: 60 },
    { name: 'Jessica Taylor', dept: 'Marketing', tasks: 9, est: 36, act: 20, completed: 4, inprogress: 4, overdue: 1, workload: 75 },
    { name: 'Marcus Vance', dept: 'OPS', tasks: 5, est: 20, act: 16, completed: 2, inprogress: 3, overdue: 0, workload: 50 }
  ];

  // Helper count totals
  const totalTasks = employees.reduce((sum, e) => sum + e.tasks, 0);
  const totalOverdue = employees.reduce((sum, e) => sum + e.overdue, 0);
  const totalEstHours = employees.reduce((sum, e) => sum + e.est, 0);
  const totalMembers = employees.length;

  container.innerHTML = `
    <div class="manager-dashboard-view" style="animation: fadeIn var(--transition-normal) ease-in-out;">
      <div class="view-header">
        <div class="view-title-group">
          <h2>Manager Dashboard</h2>
          <p>Team workload, task analytics, and performance overview</p>
        </div>
        <div style="display: flex; gap: 12px;">
          <button class="secondary-btn" id="manager-filter-btn" style="display: inline-flex; align-items: center; gap: 8px;">
            <i data-lucide="sliders-horizontal" style="width: 16px; height: 16px;"></i> Filters
          </button>
          <button class="secondary-btn" id="export-report-btn" style="display: inline-flex; align-items: center; gap: 8px;">
            <i data-lucide="download" style="width: 16px; height: 16px;"></i> Export Report
          </button>
        </div>
      </div>

      <!-- KPI Summary Cards (5 columns) -->
      <div class="cards-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom: 24px;">
        <!-- Card 1: Total Tasks -->
        <div class="kpi-card card-blue">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Total Tasks</span>
            <div class="kpi-icon-container" style="color: var(--text-secondary);">
              <i data-lucide="folder"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">${totalTasks}</div>
          <div class="kpi-helper">Across all employees</div>
        </div>

        <!-- Card 2: Overdue Tasks -->
        <div class="kpi-card card-red">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-red));">Overdue Tasks</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-red));">
              <i data-lucide="alert-circle"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-red));">${totalOverdue}</div>
          <div class="kpi-helper">Requires attention</div>
        </div>

        <!-- Card 3: Pending Action -->
        <div class="kpi-card card-orange">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-orange));">Pending Action</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-orange));">
              <i data-lucide="message-square"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-orange));">3</div>
          <div class="kpi-helper">No comment/action</div>
        </div>

        <!-- Card 4: Estimated Hours -->
        <div class="kpi-card card-blue">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-blue));">Estimated Hours</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-blue));">
              <i data-lucide="clock"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-blue));">${totalEstHours}h</div>
          <div class="kpi-helper">This week</div>
        </div>

        <!-- Card 5: Team Members -->
        <div class="kpi-card card-green">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Team Members</span>
            <div class="kpi-icon-container" style="color: var(--text-secondary);">
              <i data-lucide="users"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">${totalMembers}</div>
          <div class="kpi-helper">Active employees</div>
        </div>
      </div>

      <!-- Tab Selectors -->
      <div style="display: flex; gap: 8px; margin-bottom: 24px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; overflow-x: auto; white-space: nowrap;">
        <button class="secondary-btn manager-tab-btn active" data-tab="workload" style="border: none; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Workload by Employee</button>
        <button class="secondary-btn manager-tab-btn" data-tab="projects" style="border: none; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Project-wise Tasks</button>
        <button class="secondary-btn manager-tab-btn" data-tab="actions" style="border: none; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Pending Actions</button>
        <button class="secondary-btn manager-tab-btn" data-tab="calendar" style="border: none; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Team Calendar</button>
      </div>

      <!-- Main Data Area Card -->
      <div class="requisitions-list-card" id="manager-tab-content">
        <!-- Render Workload table by default -->
        ${renderWorkloadTable(employees)}
      </div>
    </div>
  `;

  lucide.createIcons();

  // Tab switcher binding
  const tabBtns = container.querySelectorAll('.manager-tab-btn');
  const tabContent = document.getElementById('manager-tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Toggle active states
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const selectedTab = btn.getAttribute('data-tab');

      // Update inner content based on tab selection
      if (selectedTab === 'workload') {
        tabContent.innerHTML = renderWorkloadTable(employees);
      } else if (selectedTab === 'projects') {
        tabContent.innerHTML = `
          <h3>Project-wise Tasks Analysis</h3>
          <p style="color: var(--text-secondary); margin-bottom: 20px;">Distribution of current construction project tasks across active job sites.</p>
          <div class="req-table-wrapper">
            <table class="req-table">
              <thead>
                <tr>
                  <th>Project Name</th>
                  <th>Department</th>
                  <th>Assigned Tasks</th>
                  <th>Progress</th>
                  <th>Priority Breakdown</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="font-weight: 600;">Oakridge Estate Subdivisions</td>
                  <td>Development</td>
                  <td>14 Tasks</td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <div style="flex: 1; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                        <div style="width: 75%; height: 100%; background-color: hsl(var(--color-blue)); border-radius: 3px;"></div>
                      </div>
                      <span style="font-size: 0.8rem; font-weight: 600;">75%</span>
                    </div>
                  </td>
                  <td><span class="status-badge" style="background-color: hsla(var(--color-red), 0.1); color: hsl(var(--color-red));">4 Urgent</span> <span class="status-badge" style="background-color: hsla(var(--color-orange), 0.1); color: hsl(var(--color-orange));">6 Medium</span></td>
                </tr>
                <tr>
                  <td style="font-weight: 600;">Downtown Commercial Complex</td>
                  <td>OPS</td>
                  <td>22 Tasks</td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <div style="flex: 1; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                        <div style="width: 50%; height: 100%; background-color: hsl(var(--color-orange)); border-radius: 3px;"></div>
                      </div>
                      <span style="font-size: 0.8rem; font-weight: 600;">50%</span>
                    </div>
                  </td>
                  <td><span class="status-badge" style="background-color: hsla(var(--color-red), 0.1); color: hsl(var(--color-red));">8 Urgent</span> <span class="status-badge" style="background-color: hsla(var(--color-blue), 0.1); color: hsl(var(--color-blue));">10 Low</span></td>
                </tr>
                <tr>
                  <td style="font-weight: 600;">Corporate Office Renovation</td>
                  <td>IT / Admin</td>
                  <td>9 Tasks</td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <div style="flex: 1; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                        <div style="width: 90%; height: 100%; background-color: hsl(var(--color-green)); border-radius: 3px;"></div>
                      </div>
                      <span style="font-size: 0.8rem; font-weight: 600;">90%</span>
                    </div>
                  </td>
                  <td><span class="status-badge" style="background-color: hsla(var(--color-green), 0.1); color: hsl(var(--color-green));">9 Completed</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        `;
      } else if (selectedTab === 'actions') {
        tabContent.innerHTML = `
          <h3>Pending Action Alerts</h3>
          <p style="color: var(--text-secondary); margin-bottom: 20px;">Manager alerts requiring approval or commentary.</p>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-primary);">
              <div>
                <strong style="color: hsl(var(--color-red));">Overdue Task Alert</strong>
                <div style="font-size: 0.9rem; margin-top: 4px;">Sarah Johnson has not updated "Q2 Invoice Audit" (due 2 days ago).</div>
              </div>
              <button class="primary-btn" style="padding: 6px 12px; font-size: 0.8rem;">Send Reminder</button>
            </div>
            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-primary);">
              <div>
                <strong style="color: hsl(var(--color-orange));">Material Approval Needed</strong>
                <div style="font-size: 0.9rem; margin-top: 4px;">Apex Concrete Requisition #8492 ($14,400) requires leadership sign-off.</div>
              </div>
              <button class="primary-btn" style="padding: 6px 12px; font-size: 0.8rem; background-color: hsl(var(--color-orange));">Review Req</button>
            </div>
            <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-primary);">
              <div>
                <strong style="color: hsl(var(--color-blue));">Shift Discrepancy</strong>
                <div style="font-size: 0.9rem; margin-top: 4px;">Michael Chen logged 12 hours overtime on Site-B excavation without approval.</div>
              </div>
              <button class="primary-btn" style="padding: 6px 12px; font-size: 0.8rem;">Acknowledge</button>
            </div>
          </div>
        `;
      } else if (selectedTab === 'calendar') {
        tabContent.innerHTML = `
          <h3>Team Schedule Calendar</h3>
          <p style="color: var(--text-secondary); margin-bottom: 20px;">Onsite shift and safety briefing rosters for the current week.</p>
          <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; text-align: center;">
            <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">
              <strong>Mon</strong><div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">May 25</div>
              <div style="background-color: hsla(var(--color-blue), 0.1); color: hsl(var(--color-blue)); padding: 4px; border-radius: 4px; font-size: 0.75rem; margin-top: 8px;">Safety briefing</div>
            </div>
            <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">
              <strong>Tue</strong><div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">May 26</div>
              <div style="background-color: hsla(var(--color-purple), 0.1); color: hsl(var(--color-purple)); padding: 4px; border-radius: 4px; font-size: 0.75rem; margin-top: 8px;">Foundation pouring</div>
            </div>
            <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">
              <strong>Wed</strong><div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">May 27</div>
              <div style="background-color: hsla(var(--color-green), 0.1); color: hsl(var(--color-green)); padding: 4px; border-radius: 4px; font-size: 0.75rem; margin-top: 8px;">Slab inspection</div>
            </div>
            <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">
              <strong>Thu</strong><div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">May 28</div>
              <div style="background-color: hsla(var(--color-orange), 0.1); color: hsl(var(--color-orange)); padding: 4px; border-radius: 4px; font-size: 0.75rem; margin-top: 8px;">Site audit</div>
            </div>
            <div style="border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">
              <strong>Fri</strong><div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">May 29</div>
              <div style="background-color: hsla(var(--color-red), 0.1); color: hsl(var(--color-red)); padding: 4px; border-radius: 4px; font-size: 0.75rem; margin-top: 8px;">Roster finalization</div>
            </div>
          </div>
        `;
      }
      lucide.createIcons();
    });
  });

  // Action event bindings
  document.getElementById('manager-filter-btn').addEventListener('click', () => {
    alert('Manager dashboard filters toggled.');
  });

  document.getElementById('export-report-btn').addEventListener('click', () => {
    alert('Exporting PDF Employee Workload Report...');
  });
}

// Separate function to render workload table HTML
function renderWorkloadTable(employees) {
  return `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <div>
        <h3 style="font-size: 1.15rem; font-family: 'Plus Jakarta Sans', sans-serif;">Employee Workload Analysis</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Task distribution and estimated time per employee</p>
      </div>
    </div>
    <div class="req-table-wrapper">
      <table class="req-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Department</th>
            <th>Total Tasks</th>
            <th>Estimated Hours</th>
            <th>Actual Hours</th>
            <th>Completed</th>
            <th>In Progress</th>
            <th>Overdue</th>
            <th>Workload</th>
          </tr>
        </thead>
        <tbody>
          ${employees.map(e => {
            return `
              <tr>
                <td style="font-weight: 600;">${e.name}</td>
                <td>${e.dept}</td>
                <td style="font-weight: 500;">${e.tasks}</td>
                <td>${e.est}h</td>
                <td>${e.act}h</td>
                <td>
                  <span style="display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background-color: var(--text-primary); color: var(--bg-primary); font-weight: 700; font-size: 0.75rem;">
                    ${e.completed}
                  </span>
                </td>
                <td style="padding-left: 18px; font-weight: 600; color: var(--text-secondary);">${e.inprogress}</td>
                <td>
                  ${e.overdue > 0 
                    ? `<span style="display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background-color: hsl(var(--color-red)); color: white; font-weight: 700; font-size: 0.75rem;">${e.overdue}</span>`
                    : `<span style="color: var(--text-muted); font-size: 0.75rem; font-weight: 500;">0</span>`
                  }
                </td>
                <td>
                  <div style="display: flex; align-items: center; gap: 10px; width: 140px;">
                    <div style="flex: 1; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                      <div style="width: ${e.workload}%; height: 100%; background-color: ${e.workload >= 90 ? 'hsl(var(--color-red))' : e.workload >= 75 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-blue))'}; border-radius: 3px;"></div>
                    </div>
                    <span style="font-size: 0.8rem; font-weight: 600; min-width: 28px;">${e.workload}%</span>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

window.renderManagerDashboard = renderManagerDashboard;
