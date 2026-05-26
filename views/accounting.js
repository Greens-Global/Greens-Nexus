// views/accounting.js
// Renders the Accounting / Financial view with sub-modules

function renderAccounting(container, state, navigateTo) {
  const activeSubTab = state.activeAccountingSubTab || 'transactions';

  // Seed budgets data in state if not present
  if (!state.budgets) {
    state.budgets = [
      { id: 1, name: 'Real Estate Development', allocated: 3500000, spent: 2450000, color: 'blue', utilPercent: 70 },
      { id: 2, name: 'Operations (OPS)', allocated: 2000000, spent: 1900000, color: 'red', utilPercent: 95 },
      { id: 3, name: 'IT & Infrastructure Support', allocated: 450000, spent: 180000, color: 'green', utilPercent: 40 }
    ];
  }

  // Inject scoped styles
  const styleId = 'accounting-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .accounting-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      
      .accounting-tabs-scroll {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        overflow-x: auto;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border-color);
        scrollbar-width: thin;
      }
      
      .accounting-tabs-scroll::-webkit-scrollbar {
        height: 5px;
      }
      
      .accounting-tabs-scroll::-webkit-scrollbar-thumb {
        background-color: var(--border-hover);
        border-radius: 4px;
      }
      
      .acc-tab-pill {
        background: none;
        border: 1px solid var(--border-color);
        padding: 8px 16px;
        border-radius: 20px;
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
        color: var(--text-secondary);
        white-space: nowrap;
        transition: all var(--transition-fast);
      }
      
      .acc-tab-pill:hover {
        border-color: var(--text-secondary);
        color: var(--text-primary);
      }
      
      .acc-tab-pill.active {
        background-color: var(--text-primary);
        color: var(--bg-primary);
        border-color: var(--text-primary);
      }

      /* Import card style */
      .import-card {
        background-color: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .uploader-area {
        border: 2px dashed var(--border-color);
        border-radius: 8px;
        padding: 30px 20px;
        text-align: center;
        cursor: pointer;
        transition: border-color var(--transition-fast);
      }

      .uploader-area:hover {
        border-color: hsl(var(--color-blue));
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Top header controls change based on tab
  let headerControlsHtml = `
    <button class="secondary-btn" id="acc-export-btn" style="display: inline-flex; align-items: center; gap: 8px;">
      <i data-lucide="download" style="width: 16px; height: 16px;"></i> Export Report
    </button>
  `;
  
  if (activeSubTab === 'transactions' || activeSubTab === 'invoices') {
    headerControlsHtml += `
      <button class="primary-btn" id="add-invoice-btn" style="background-color: #000000; color: #ffffff;">
        <i data-lucide="plus" style="width: 16px; height: 16px;"></i> New Invoice
      </button>
    `;
  } else if (activeSubTab === 'budgets') {
    headerControlsHtml += `
      <button class="primary-btn" id="adjust-budget-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 8px;">
        <i data-lucide="sliders-horizontal" style="width: 16px; height: 16px;"></i> Adjust Budget
      </button>
    `;
  } else if (activeSubTab === 'ama') {
    headerControlsHtml += `
      <button class="primary-btn" id="add-ama-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 8px;">
        <i data-lucide="plus" style="width: 16px; height: 16px;"></i> New Agreement
      </button>
    `;
  }

  container.innerHTML = `
    <div class="accounting-view">
      <!-- Page Header -->
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>Accounting</h2>
          <p>Financial overview, transactions, and budget management</p>
        </div>
        <div style="display: flex; gap: 12px;" id="accounting-header-btns">
          ${headerControlsHtml}
        </div>
      </div>

      <!-- Financial KPI Cards (4 columns) -->
      <div class="cards-grid" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 24px;">
        <!-- Card 1: Total Revenue -->
        <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Total Revenue</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
              <i data-lucide="trending-up"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">$8.4M</div>
          <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">&uarr; 12.5% from last quarter</div>
        </div>

        <!-- Card 2: Total Expenses -->
        <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Total Expenses</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
              <i data-lucide="trending-down"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">$6.1M</div>
          <div class="kpi-helper" style="color: hsl(var(--color-green)); font-weight: 600;">&uarr; 8.2% from last quarter</div>
        </div>

        <!-- Card 3: Net Profit -->
        <div class="kpi-card card-red" style="cursor: default; padding: 20px;">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Net Profit</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-green));">
              <i data-lucide="dollar-sign"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">$2.3M</div>
          <div class="kpi-helper" style="color: hsl(var(--color-red)); font-weight: 600;">&darr; 18.9% from last quarter</div>
        </div>

        <!-- Card 4: Outstanding Invoices -->
        <div class="kpi-card card-red" style="cursor: default; padding: 20px;">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: var(--text-secondary);">Outstanding Invoices</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-red));">
              <i data-lucide="file-text"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem;">$450K</div>
          <div class="kpi-helper" style="color: hsl(var(--color-red)); font-weight: 600;">&darr; 5.3% from last quarter</div>
        </div>
      </div>

      <!-- Scrollable Tab selectors -->
      <div class="accounting-tabs-scroll">
        <button class="acc-tab-pill ${activeSubTab === 'transactions' ? 'active' : ''}" data-tab="transactions">Transactions</button>
        <button class="acc-tab-pill ${activeSubTab === 'invoices' ? 'active' : ''}" data-tab="invoices">Invoices</button>
        <button class="acc-tab-pill ${activeSubTab === 'budgets' ? 'active' : ''}" data-tab="budgets">Budgets</button>
        <button class="acc-tab-pill ${activeSubTab === 'imports' ? 'active' : ''}" data-tab="imports">Import Hub</button>
        <button class="acc-tab-pill ${activeSubTab === 'ramp' ? 'active' : ''}" data-tab="ramp">Ramp Cards</button>
        <button class="acc-tab-pill ${activeSubTab === 'ama' ? 'active' : ''}" data-tab="ama">AMA Entities</button>
        <button class="acc-tab-pill ${activeSubTab === 'mre' ? 'active' : ''}" data-tab="mre">MRE</button>
        <button class="acc-tab-pill ${activeSubTab === 'mri' ? 'active' : ''}" data-tab="mri">MRI</button>
        <button class="acc-tab-pill ${activeSubTab === 'reports' ? 'active' : ''}" data-tab="reports">Reports</button>
      </div>

      <!-- Tab view container -->
      <div id="accounting-tab-content" style="margin-bottom: 24px;">
        ${renderActiveTabContent(activeSubTab, state)}
      </div>

      <!-- Bottom panel cards -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 12px;">
        <!-- Card 1: Payment Processing -->
        <div class="sop-update-row bottom-acc-panel" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="credit-card"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Payment Processing</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Process payments</div>
          </div>
        </div>

        <!-- Card 2: Financial Reports -->
        <div class="sop-update-row bottom-acc-panel" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="trending-up"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Financial Reports</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Generate reports</div>
          </div>
        </div>

        <!-- Card 3: Tax Documents -->
        <div class="sop-update-row bottom-acc-panel" style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; box-shadow: var(--shadow-sm); display: flex; gap: 16px; align-items: center; cursor: pointer;">
          <div style="width: 44px; height: 44px; border-radius: 10px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
            <i data-lucide="dollar-sign"></i>
          </div>
          <div>
            <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif;">Tax Documents</strong>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">View tax filings</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal for New Invoice -->
    <div class="modal-overlay" id="invoice-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New Invoice</h3>
          <button class="close-btn" id="close-invoice-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-invoice-form">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="inv-title">Invoice Title / Reference</label>
              <input type="text" id="inv-title" class="form-input" placeholder="e.g. Subcontractor Payment - Framing Q2" required>
            </div>
            <div class="form-group">
              <label for="inv-type">Transaction Type</label>
              <select id="inv-type" class="form-select">
                <option value="inflow">Inflow (Income/Revenue)</option>
                <option value="outflow" selected>Outflow (Expense/Payment)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="inv-cost">Total Cost ($)</label>
              <input type="number" id="inv-cost" class="form-input" min="1" placeholder="e.g. 45000" required>
            </div>
            <div class="form-group">
              <label for="inv-date">Transaction Date</label>
              <input type="date" id="inv-date" class="form-input" required>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button type="button" class="secondary-btn" id="cancel-invoice-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save Invoice</button>
          </div>
        </form>
      </div>
    </div>
  `;

  lucide.createIcons();

  // Attach handlers
  attachAccountingHandlers(container, state, navigateTo);
}

// Renders content based on selected tab
function renderActiveTabContent(tabName, state) {
  if (tabName === 'transactions') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Recent Transactions</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Latest financial activities</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${state.accountingTrx.map(trx => {
            const isProfit = trx.cost > 0;
            const amountFormatted = Math.abs(trx.cost).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
            const amountText = isProfit ? `+$${amountFormatted}` : `-$${amountFormatted}`;
            const amountColor = isProfit ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))';
            const iconName = isProfit ? 'arrow-up-right' : 'arrow-down-right';
            const iconBg = isProfit ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)';

            return `
              <div class="sop-update-row" style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 8px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; transition: border-color var(--transition-fast); cursor: default;">
                <div style="display: flex; gap: 16px; align-items: center;">
                  <div style="width: 36px; height: 36px; border-radius: 50%; background-color: ${iconBg}; color: ${amountColor}; display: flex; align-items: center; justify-content: center;">
                    <i data-lucide="${iconName}" style="width: 18px; height: 18px; stroke-width: 2.5px;"></i>
                  </div>
                  <div>
                    <strong style="font-size: 0.95rem; color: var(--text-primary); font-family: 'Plus Jakarta Sans', sans-serif;">${trx.title}</strong>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">${trx.id} &bull; ${trx.date}</div>
                  </div>
                </div>
                <div style="font-size: 1.05rem; font-weight: 700; color: ${amountColor}; font-family: 'Inter', sans-serif;">
                  ${amountText}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else if (tabName === 'invoices') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Client Invoices</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Outstanding billing statements and due invoices</p>
        </div>
        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Invoice ID</th>
                <th>Client Name</th>
                <th>Project Name</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Due Date</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="font-family: monospace; font-weight: 600;">#INV-4029</td>
                <td style="font-weight: 600;">Apex Real Estate Holdings</td>
                <td>Downtown Commercial Complex</td>
                <td style="font-weight: 700;">$180,000</td>
                <td><span class="status-badge status-pending">Awaiting Payment</span></td>
                <td>2026-06-15</td>
              </tr>
              <tr>
                <td style="font-family: monospace; font-weight: 600;">#INV-4028</td>
                <td style="font-weight: 600;">Sarah Jenkins Estates</td>
                <td>Oakridge Subdivision Phase 1</td>
                <td style="font-weight: 700;">$270,000</td>
                <td><span class="status-badge status-pending">Awaiting Payment</span></td>
                <td>2026-06-12</td>
              </tr>
              <tr>
                <td style="font-family: monospace; font-weight: 600;">#INV-4027</td>
                <td style="font-weight: 600;">Metro Retail Corp.</td>
                <td>Commercial Retail Center Site-B</td>
                <td style="font-weight: 700;">$410,000</td>
                <td><span class="status-badge status-approved">Paid</span></td>
                <td>2026-05-18</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (tabName === 'budgets') {
    const budgets = state.budgets;
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Departmental Budgets</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Approved capital allocations and expenditures</p>
        </div>
        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Allocated Budget</th>
                <th>Spent Value</th>
                <th>Remaining Budget</th>
                <th>Utilization</th>
              </tr>
            </thead>
            <tbody>
              ${budgets.map(b => {
                const rem = b.allocated - b.spent;
                const util = Math.min(100, Math.round((b.spent / b.allocated) * 100));
                let utilColor = 'hsl(var(--color-blue))';
                if (util > 90) {
                  utilColor = 'hsl(var(--color-red))';
                } else if (util < 50) {
                  utilColor = 'hsl(var(--color-green))';
                }
                
                return `
                  <tr>
                    <td style="font-weight: 600;">${b.name}</td>
                    <td>${b.allocated.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}</td>
                    <td>${b.spent.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}</td>
                    <td style="font-weight: 600; color: ${rem < 0 ? 'hsl(var(--color-red))' : 'var(--text-primary)'};">${rem.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}</td>
                    <td>
                      <div style="display: flex; align-items: center; gap: 10px; width: 140px;">
                        <div style="flex: 1; height: 6px; background-color: var(--border-color); border-radius: 3px; overflow: hidden;">
                          <div style="width: ${util}%; height: 100%; background-color: ${utilColor}; border-radius: 3px;"></div>
                        </div>
                        <span style="font-size: 0.8rem; font-weight: 600;">${util}%</span>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Modal: Adjust Budget -->
      <div class="modal-overlay" id="budget-adjust-modal" style="display: none;">
        <div class="modal-content">
          <div class="modal-header">
            <h3>Adjust Capital Allocation</h3>
            <button class="close-btn" id="close-budget-modal-btn">
              <i data-lucide="x"></i>
            </button>
          </div>
          <form id="adjust-budget-form">
            <div class="form-grid" style="grid-template-columns: 1fr; gap: 16px;">
              <div class="form-group">
                <label for="budget-dept">Target Department</label>
                <select id="budget-dept" class="form-select">
                  ${budgets.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="budget-action">Adjustment Type</label>
                <select id="budget-action" class="form-select">
                  <option value="increase">Increase Allocation (+)</option>
                  <option value="decrease">Decrease Allocation (-)</option>
                </select>
              </div>
              <div class="form-group">
                <label for="budget-amt">Adjustment Amount ($)</label>
                <input type="number" id="budget-amt" class="form-input" min="1000" step="1000" placeholder="e.g. 50000" required>
              </div>
            </div>
            <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
              <button type="button" class="secondary-btn" id="cancel-budget-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn">Process Adjustment</button>
            </div>
          </form>
        </div>
      </div>
    `;
  } else if (tabName === 'imports') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Financial Import Hub</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Process Fidelity, QuickBooks Payroll, and Tally transactions into Sage Intacct</p>
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
          <!-- Fidelity -->
          <div class="import-card">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; border-radius: 6px; background-color: hsla(142, 70%, 45%, 0.1); color: hsl(142, 70%, 45%); display: flex; align-items: center; justify-content: center;">
                <i data-lucide="piggy-bank" style="width: 18px; height: 18px;"></i>
              </div>
              <strong style="font-size: 1rem;">Fidelity Investments</strong>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-secondary); height: 36px; line-height: 1.3;">Import retirement accounts, employee benefits, and capital logs.</p>
            <div class="uploader-area import-trigger" data-service="Fidelity">
              <i data-lucide="upload-cloud" style="width: 24px; height: 24px; color: var(--text-muted); margin-bottom: 8px;"></i>
              <span style="display: block; font-size: 0.8rem; font-weight: 600;">Drag file or Click to Browse</span>
              <span style="display: block; font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">Supports CSV, XLSX</span>
            </div>
            <div class="progress-bar-container" style="display: none; flex-direction: column; gap: 6px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.7rem; font-family: monospace;">
                <span>Processing...</span>
                <span class="progress-pct">0%</span>
              </div>
              <div style="width: 100%; height: 4px; background-color: var(--border-color); border-radius: 2px; overflow: hidden;">
                <div class="progress-fill" style="width: 0%; height: 100%; background-color: hsl(var(--color-green)); transition: width 0.1s linear;"></div>
              </div>
            </div>
          </div>

          <!-- QuickBooks Payroll -->
          <div class="import-card">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; border-radius: 6px; background-color: hsla(215, 100%, 50%, 0.1); color: hsl(var(--color-blue)); display: flex; align-items: center; justify-content: center;">
                <i data-lucide="users" style="width: 18px; height: 18px;"></i>
              </div>
              <strong style="font-size: 1rem;">QuickBooks Payroll</strong>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-secondary); height: 36px; line-height: 1.3;">Sync employee payroll journals and tax withholdings logs.</p>
            <div class="uploader-area import-trigger" data-service="QuickBooks Payroll">
              <i data-lucide="upload-cloud" style="width: 24px; height: 24px; color: var(--text-muted); margin-bottom: 8px;"></i>
              <span style="display: block; font-size: 0.8rem; font-weight: 600;">Drag file or Click to Browse</span>
              <span style="display: block; font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">Supports CSV, XML</span>
            </div>
            <div class="progress-bar-container" style="display: none; flex-direction: column; gap: 6px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.7rem; font-family: monospace;">
                <span>Processing...</span>
                <span class="progress-pct">0%</span>
              </div>
              <div style="width: 100%; height: 4px; background-color: var(--border-color); border-radius: 2px; overflow: hidden;">
                <div class="progress-fill" style="width: 0%; height: 100%; background-color: hsl(var(--color-blue)); transition: width 0.1s linear;"></div>
              </div>
            </div>
          </div>

          <!-- Tally (GG Con) -->
          <div class="import-card">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; border-radius: 6px; background-color: hsla(24, 95%, 50%, 0.1); color: hsl(var(--color-orange)); display: flex; align-items: center; justify-content: center;">
                <i data-lucide="database" style="width: 18px; height: 18px;"></i>
              </div>
              <strong style="font-size: 1rem;">Tally (GG Con)</strong>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-secondary); height: 36px; line-height: 1.3;">Import general ledger entries, contractor rates, and materials invoices.</p>
            <div class="uploader-area import-trigger" data-service="Tally (GG Con)">
              <i data-lucide="upload-cloud" style="width: 24px; height: 24px; color: var(--text-muted); margin-bottom: 8px;"></i>
              <span style="display: block; font-size: 0.8rem; font-weight: 600;">Drag file or Click to Browse</span>
              <span style="display: block; font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">Supports CSV, XML</span>
            </div>
            <div class="progress-bar-container" style="display: none; flex-direction: column; gap: 6px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.7rem; font-family: monospace;">
                <span>Processing...</span>
                <span class="progress-pct">0%</span>
              </div>
              <div style="width: 100%; height: 4px; background-color: var(--border-color); border-radius: 2px; overflow: hidden;">
                <div class="progress-fill" style="width: 0%; height: 100%; background-color: hsl(var(--color-orange)); transition: width 0.1s linear;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (tabName === 'ramp') {
    const trx = state.rampTransactions;
    const missingCount = trx.filter(t => t.missing).length;

    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Ramp Corporate Transactions</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">Review card receipts and missing expense details</p>
          </div>
          ${missingCount > 0 
            ? `<span style="background-color: hsla(var(--color-orange), 0.1); color: hsl(var(--color-orange)); border: 1px solid hsla(var(--color-orange), 0.2); font-size: 0.75rem; font-weight: 700; padding: 4px 12px; border-radius: 20px;">
                ${missingCount} Missing Memo Notifications
               </span>`
            : `<span style="background-color: hsla(var(--color-green), 0.1); color: hsl(var(--color-green)); border: 1px solid hsla(var(--color-green), 0.2); font-size: 0.75rem; font-weight: 700; padding: 4px 12px; border-radius: 20px;">
                &check; All Transaction Memos Complete
               </span>`
          }
        </div>

        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Transaction ID</th>
                <th>Vendor</th>
                <th>Category</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Expense Memo</th>
              </tr>
            </thead>
            <tbody>
              ${trx.map((t, idx) => {
                const amountFormatted = t.cost.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
                
                return `
                  <tr style="${t.missing ? 'background-color: hsla(var(--color-orange), 0.03);' : ''}">
                    <td style="font-family: monospace; font-size: 0.85rem; font-weight: 600;">${t.id}</td>
                    <td style="font-weight: 600;">${t.vendor}</td>
                    <td><span class="status-badge" style="background-color: var(--bg-secondary); color: var(--text-primary); font-size: 0.75rem; border-radius: 4px; padding: 2px 8px;">${t.category}</span></td>
                    <td style="font-weight: 700; font-family: 'Inter', sans-serif;">${amountFormatted}</td>
                    <td style="font-size: 0.85rem; color: var(--text-secondary);">${t.date}</td>
                    <td>
                      ${t.missing 
                        ? `<div style="display: flex; gap: 8px; align-items: center; max-width: 320px;">
                            <input type="text" class="form-input ramp-memo-input" style="height: 32px; font-size: 0.8rem; padding: 4px 8px; flex: 1; border-color: hsl(var(--color-orange));" placeholder="Enter missing memo details..." data-id="${t.id}">
                            <button class="primary-btn save-ramp-memo-btn" style="height: 32px; padding: 0 10px; background-color: hsl(var(--color-orange)); color: white; display: flex; align-items: center; justify-content: center;" data-id="${t.id}">
                              <i data-lucide="check" style="width: 14px; height: 14px;"></i>
                            </button>
                           </div>`
                        : `<span style="font-size: 0.85rem; color: var(--text-secondary);">${t.memo}</span>`
                      }
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } else if (tabName === 'ama') {
    const entities = state.amaEntities;
    const totalBilled = entities.reduce((sum, e) => sum + e.billedYTD, 0);
    const totalBilledFormatted = totalBilled.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Asset Management Agreement (AMA) Entities</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">Contract fee logs and billing rates for partner entities</p>
          </div>
          <div style="text-align: right;">
            <span style="font-size: 0.75rem; color: var(--text-secondary);">Total Billed YTD</span>
            <strong style="display: block; font-size: 1.5rem; font-family: 'Inter', sans-serif; color: hsl(var(--color-green));">${totalBilledFormatted}</strong>
          </div>
        </div>

        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Agreement ID</th>
                <th>Entity Name</th>
                <th>Fee Rate</th>
                <th>Billed YTD</th>
                <th>Next Invoice Date</th>
                <th>Agreement Status</th>
              </tr>
            </thead>
            <tbody>
              ${entities.map(e => {
                const isAct = e.status === 'Active';
                const badgeClass = isAct ? 'status-badge status-approved' : 'status-badge status-pending';
                const billedFormatted = e.billedYTD.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

                return `
                  <tr>
                    <td style="font-family: monospace; font-size: 0.85rem; font-weight: 600;">#AMA-00${e.id}</td>
                    <td style="font-weight: 600;">${e.entity}</td>
                    <td style="font-weight: 500;">${e.feeRate}% YTD</td>
                    <td style="font-weight: 700; font-family: 'Inter', sans-serif; color: hsl(var(--color-green));">${billedFormatted}</td>
                    <td style="font-size: 0.85rem; color: var(--text-secondary);">${e.nextBilling}</td>
                    <td><span class="${badgeClass}">${e.status}</span></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Modal: New AMA Entity Agreement -->
      <div class="modal-overlay" id="ama-modal" style="display: none;">
        <div class="modal-content" style="max-width: 500px;">
          <div class="modal-header">
            <h3>New AMA Entity Agreement</h3>
            <button class="close-btn" id="close-ama-modal-btn">
              <i data-lucide="x"></i>
            </button>
          </div>
          <form id="new-ama-form">
            <div class="form-grid" style="grid-template-columns: 1fr; gap: 16px;">
              <div class="form-group">
                <label for="ama-name">Partner Entity Name</label>
                <input type="text" id="ama-name" class="form-input" placeholder="e.g. Greens Nexus Capital LLC" required>
              </div>
              <div class="form-group">
                <label for="ama-fee">Agreement Fee Rate (%)</label>
                <input type="number" id="ama-fee" class="form-input" min="0.1" max="20" step="0.1" placeholder="e.g. 3.5" required>
              </div>
              <div class="form-group">
                <label for="ama-status">Agreement Status</label>
                <select id="ama-status" class="form-select">
                  <option value="Active">Active</option>
                  <option value="Pending Review">Pending Review</option>
                </select>
              </div>
            </div>
            <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
              <button type="button" class="secondary-btn" id="cancel-ama-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn">Create Agreement</button>
            </div>
          </form>
        </div>
      </div>
    `;
  } else if (tabName === 'reports') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Financial Reports & Ledgers</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Download official corporate financials and accounting sheets</p>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-secondary);">
            <div>
              <strong style="display: block; font-size: 0.95rem;">Profit & Loss Statement (Q2 Draft)</strong>
              <span style="font-size: 0.75rem; color: var(--text-secondary);">Last updated 2 hours ago &bull; PDF</span>
            </div>
            <button class="secondary-btn download-report-btn" data-name="Profit & Loss Q2" style="display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; height: 32px; padding: 0 12px;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Download
            </button>
          </div>

          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-secondary);">
            <div>
              <strong style="display: block; font-size: 0.95rem;">General Balance Sheet (YTD Ledger)</strong>
              <span style="font-size: 0.75rem; color: var(--text-secondary);">Last updated yesterday &bull; XLSX</span>
            </div>
            <button class="secondary-btn download-report-btn" data-name="Balance Sheet YTD" style="display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; height: 32px; padding: 0 12px;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Download
            </button>
          </div>

          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-secondary);">
            <div>
              <strong style="display: block; font-size: 0.95rem;">Greens Nexus Audits Ledger (2025)</strong>
              <span style="font-size: 0.75rem; color: var(--text-secondary);">Verified by Deloitte LLP &bull; PDF</span>
            </div>
            <button class="secondary-btn download-report-btn" data-name="Audit Ledger 2025" style="display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; height: 32px; padding: 0 12px;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Download
            </button>
          </div>

          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-secondary);">
            <div>
              <strong style="display: block; font-size: 0.95rem;">Capital Expenditures & Vendor Logs</strong>
              <span style="font-size: 0.75rem; color: var(--text-secondary);">Last updated 3 days ago &bull; CSV</span>
            </div>
            <button class="secondary-btn download-report-btn" data-name="CapEx Vendor Logs" style="display: inline-flex; align-items: center; gap: 6px; font-size: 0.8rem; height: 32px; padding: 0 12px;">
              <i data-lucide="download" style="width: 14px; height: 14px;"></i> Download
            </button>
          </div>
        </div>
      </div>
    `;
  } else if (tabName === 'mre') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Monthly Rental Entity (MRE)</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">Lease receivables, collected rent logs, and compliance calendars</p>
          </div>
          <button class="primary-btn" id="log-mre-payment-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 8px;">
            <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Log Tenant Payment
          </button>
        </div>

        <!-- MRE Stats Grid -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Total collected rent (YTD)</span>
            <strong style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: hsl(var(--color-green));">$2,145,000</strong>
          </div>
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Average Occupancy</span>
            <strong style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: hsl(var(--color-blue));">94.2%</strong>
          </div>
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Expiring Leases (45 Days)</span>
            <strong style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: hsl(var(--color-orange));">5 Leases</strong>
          </div>
        </div>

        <div class="req-table-wrapper">
          <table class="req-table">
            <thead>
              <tr>
                <th>Property Unit</th>
                <th>Tenant</th>
                <th>Monthly Rent</th>
                <th>Lease Range</th>
                <th>Payment Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="font-weight: 600;">Harbor View Condos - Unit 402</td>
                <td>James Wilson</td>
                <td style="font-family: 'Inter', sans-serif; font-weight: 600;">$3,200</td>
                <td style="font-size: 0.85rem; color: var(--text-secondary);">2025-06-01 to 2026-05-31</td>
                <td><span class="status-badge status-approved">Paid</span></td>
                <td><button class="secondary-btn mre-renew-btn" data-tenant="James Wilson" style="height: 28px; padding: 0 10px; font-size: 0.75rem;">Renew Lease</button></td>
              </tr>
              <tr>
                <td style="font-weight: 600;">Downtown Office Suite A</td>
                <td>Apex Retail Corp.</td>
                <td style="font-family: 'Inter', sans-serif; font-weight: 600;">$12,500</td>
                <td style="font-size: 0.85rem; color: var(--text-secondary);">2024-01-01 to 2026-12-31</td>
                <td><span class="status-badge status-approved">Paid</span></td>
                <td><button class="secondary-btn mre-renew-btn" data-tenant="Apex Retail Corp." style="height: 28px; padding: 0 10px; font-size: 0.75rem;">Manage</button></td>
              </tr>
              <tr>
                <td style="font-weight: 600;">Oakridge Subdivision Villa 12</td>
                <td>Sarah Jenkins</td>
                <td style="font-family: 'Inter', sans-serif; font-weight: 600;">$4,500</td>
                <td style="font-size: 0.85rem; color: var(--text-secondary);">2025-09-15 to 2026-09-14</td>
                <td><span class="status-badge status-pending">Pending</span></td>
                <td><button class="secondary-btn mre-notice-btn" data-tenant="Sarah Jenkins" style="height: 28px; padding: 0 10px; font-size: 0.75rem;">Send Notice</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Modal: Log MRE Payment -->
      <div class="modal-overlay" id="mre-payment-modal" style="display: none;">
        <div class="modal-content" style="max-width: 480px;">
          <div class="modal-header">
            <h3>Log Tenant Payment</h3>
            <button class="close-btn" id="close-mre-modal-btn">
              <i data-lucide="x"></i>
            </button>
          </div>
          <form id="new-mre-payment-form">
            <div class="form-grid" style="grid-template-columns: 1fr; gap: 16px;">
              <div class="form-group">
                <label for="mre-tenant">Tenant Name</label>
                <input type="text" id="mre-tenant" class="form-input" placeholder="e.g. John Mitchell" required>
              </div>
              <div class="form-group">
                <label for="mre-unit">Property Unit</label>
                <input type="text" id="mre-unit" class="form-input" placeholder="e.g. Harbor View - Suite 101" required>
              </div>
              <div class="form-group">
                <label for="mre-amount">Payment Amount ($)</label>
                <input type="number" id="mre-amount" class="form-input" min="1" placeholder="e.g. 3200" required>
              </div>
            </div>
            <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
              <button type="button" class="secondary-btn" id="cancel-mre-modal-btn">Cancel</button>
              <button type="submit" class="primary-btn">Submit Payment</button>
            </div>
          </form>
        </div>
      </div>
    `;
  } else if (tabName === 'mri') {
    return `
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">MRI Property Software Integration</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">Corporate property portfolios, landlord logs, and tenant records synchronization status</p>
          </div>
          <button class="primary-btn" id="mri-sync-btn" style="background-color: hsl(var(--color-blue)); color: #ffffff; display: inline-flex; align-items: center; gap: 8px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 600; font-size: 0.85rem; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer;">
            <i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i> Force Database Sync
          </button>
        </div>

        <!-- MRI Stats Grid -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Active Portfolios</span>
            <strong style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: var(--text-primary);">14 Portfolios</strong>
          </div>
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Synced Tenants</span>
            <strong style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: hsl(var(--color-green));">1,240 Records</strong>
          </div>
          <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; background-color: var(--bg-secondary);">
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">Last Database Sync</span>
            <strong id="mri-last-sync" style="font-size: 1.5rem; display: block; margin-top: 4px; font-family: 'Inter', sans-serif; color: hsl(var(--color-blue));">15 min ago</strong>
          </div>
        </div>

        <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; font-weight: 600;">
            <i data-lucide="activity" style="width: 16px; height: 16px; color: hsl(var(--color-blue));"></i> Live Connection Metrics
          </h4>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; font-family: monospace; font-size: 0.85rem; color: var(--text-secondary);">
            <div><span style="color: hsl(var(--color-green))">&bull;</span> MRI SaaS Endpoint: <code>https://api.mrisoftware.com/v3</code></div>
            <div><span style="color: hsl(var(--color-green))">&bull;</span> Connection Latency: <code>45ms</code></div>
            <div><span style="color: hsl(var(--color-green))">&bull;</span> Authentication Token: <code>Valid (Exp. 14 hrs)</code></div>
            <div><span style="color: hsl(var(--color-green))">&bull;</span> Sync Channel Mode: <code>Bi-directional API sync</code></div>
          </div>
        </div>

        <!-- Connection Logs -->
        <h4 style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 12px; font-weight: 600;">Recent Connection Sync Logs</h4>
        <div style="display: flex; flex-direction: column; gap: 8px;" id="mri-sync-logs">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid var(--border-color); border-radius: 6px; background-color: var(--bg-primary); font-size: 0.85rem;">
            <span>Sync matched 84 landlord profiles to Sage Intacct ledger.</span>
            <span style="color: var(--text-muted); font-size: 0.8rem; font-family: monospace;">2026-05-25 23:45</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid var(--border-color); border-radius: 6px; background-color: var(--bg-primary); font-size: 0.85rem;">
            <span>Successfully updated tenant balance logs for Harbor View Apartments.</span>
            <span style="color: var(--text-muted); font-size: 0.8rem; font-family: monospace;">2026-05-25 18:22</span>
          </div>
        </div>
      </div>
    `;
  }
  return '';
}

function attachAccountingHandlers(container, state, navigateTo) {
  // Tab switching pills binding
  const tabPills = container.querySelectorAll('.acc-tab-pill');
  tabPills.forEach(pill => {
    pill.addEventListener('click', () => {
      const selectedTab = pill.getAttribute('data-tab');
      state.activeAccountingSubTab = selectedTab;
      renderAccounting(container, state, navigateTo);
    });
  });

  // Modal: Invoice controls
  const invoiceBtn = document.getElementById('add-invoice-btn');
  const invoiceModal = document.getElementById('invoice-modal');
  const closeInvBtn = document.getElementById('close-invoice-modal-btn');
  const cancelInvBtn = document.getElementById('cancel-invoice-modal-btn');
  const invoiceForm = document.getElementById('new-invoice-form');

  const closeInvoiceModal = () => {
    if (invoiceModal) invoiceModal.style.display = 'none';
    if (invoiceForm) invoiceForm.reset();
  };

  if (invoiceBtn) {
    invoiceBtn.addEventListener('click', () => {
      document.getElementById('inv-date').valueAsDate = new Date();
      invoiceModal.style.display = 'flex';
    });
  }

  if (closeInvBtn) closeInvBtn.addEventListener('click', closeInvoiceModal);
  if (cancelInvBtn) cancelInvBtn.addEventListener('click', closeInvoiceModal);

  if (invoiceForm) {
    invoiceForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('inv-title').value.trim();
      const type = document.getElementById('inv-type').value;
      const cost = parseFloat(document.getElementById('inv-cost').value);
      const dateInput = new Date(document.getElementById('inv-date').value);
      const dateFormatted = dateInput.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      const newTrx = {
        id: `TRX-${Math.floor(1239 + Math.random() * 9000)}`,
        title: title,
        date: dateFormatted,
        cost: type === 'outflow' ? -cost : cost
      };

      state.accountingTrx.unshift(newTrx);
      closeInvoiceModal();
      renderAccounting(container, state, navigateTo);
    });
  }

  // Adjust Budget Controls
  const adjustBudgetBtn = document.getElementById('adjust-budget-btn');
  const budgetModal = document.getElementById('budget-adjust-modal');
  const closeBgtBtn = document.getElementById('close-budget-modal-btn');
  const cancelBgtBtn = document.getElementById('cancel-budget-modal-btn');
  const budgetForm = document.getElementById('adjust-budget-form');

  const closeBudgetModal = () => {
    if (budgetModal) budgetModal.style.display = 'none';
    if (budgetForm) budgetForm.reset();
  };

  if (adjustBudgetBtn) {
    adjustBudgetBtn.addEventListener('click', () => {
      budgetModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  if (closeBgtBtn) closeBgtBtn.addEventListener('click', closeBudgetModal);
  if (cancelBgtBtn) cancelBgtBtn.addEventListener('click', closeBudgetModal);

  if (budgetForm) {
    budgetForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const deptId = parseInt(document.getElementById('budget-dept').value);
      const actionType = document.getElementById('budget-action').value;
      const amount = parseFloat(document.getElementById('budget-amt').value);

      const targetBudget = state.budgets.find(b => b.id === deptId);
      if (targetBudget) {
        if (actionType === 'increase') {
          targetBudget.allocated += amount;
        } else {
          targetBudget.allocated -= amount;
        }
        targetBudget.utilPercent = Math.min(100, Math.round((targetBudget.spent / targetBudget.allocated) * 100));
        
        // Log transaction
        state.accountingTrx.unshift({
          id: `TRX-${Math.floor(2000 + Math.random() * 8000)}`,
          title: `Budget Adjustment - ${targetBudget.name}`,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          cost: actionType === 'increase' ? -amount : amount
        });

        alert(`Budget for ${targetBudget.name} successfully updated.`);
        closeBudgetModal();
        renderAccounting(container, state, navigateTo);
      }
    });
  }

  // Export report
  const exportBtn = document.getElementById('acc-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      alert('Generating financial audits and balance sheets ledger export...');
    });
  }

  // Bottom action buttons alerts
  const actionPanels = container.querySelectorAll('.bottom-acc-panel');
  actionPanels.forEach(panel => {
    panel.addEventListener('click', () => {
      const panelTitle = panel.querySelector('strong').textContent;
      alert(`Loading accounting database for ${panelTitle}...`);
    });
  });

  // Import Hub File Processing Simulation
  const importTriggers = container.querySelectorAll('.import-trigger');
  importTriggers.forEach(trigger => {
    trigger.addEventListener('click', () => {
      const service = trigger.getAttribute('data-service');
      const progressContainer = trigger.parentElement.querySelector('.progress-bar-container');
      const progressFill = trigger.parentElement.querySelector('.progress-fill');
      const progressPct = trigger.parentElement.querySelector('.progress-pct');

      trigger.style.display = 'none';
      progressContainer.style.display = 'flex';
      progressFill.style.width = '0%';
      progressPct.textContent = '0%';

      let pct = 0;
      const interval = setInterval(() => {
        pct += 10;
        progressFill.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;

        if (pct >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            progressContainer.style.display = 'none';
            trigger.style.display = 'block';
            alert(`Import completed successfully! Sync matched 42 journal ledger transactions from ${service} to Sage Intacct.`);
            
            // Add a simulated sync transaction
            state.accountingTrx.unshift({
              id: `TRX-${Math.floor(5000 + Math.random() * 5000)}`,
              title: `${service} Import Sync`,
              date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
              cost: service === 'Fidelity' ? 142000 : service === 'QuickBooks Payroll' ? -85000 : -12500
            });
            
            renderAccounting(container, state, navigateTo);
          }, 300);
        }
      }, 100);
    });
  });

  // Save Ramp Memo Handler
  const saveMemoBtns = container.querySelectorAll('.save-ramp-memo-btn');
  saveMemoBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tid = btn.getAttribute('data-id');
      const input = container.querySelector(`.ramp-memo-input[data-id="${tid}"]`);
      if (input && input.value.trim() !== '') {
        const targetTrx = state.rampTransactions.find(t => t.id === tid);
        if (targetTrx) {
          targetTrx.memo = input.value.trim();
          targetTrx.missing = false;
          alert(`Memo saved for transaction ${tid}. warning cleared.`);
          renderAccounting(container, state, navigateTo);
        }
      } else {
        alert('Please enter a valid memo before saving.');
      }
    });
  });

  // Add AMA Entity Agreement Handlers
  const addAmaBtn = document.getElementById('add-ama-btn');
  const amaModal = document.getElementById('ama-modal');
  const closeAmaBtn = document.getElementById('close-ama-modal-btn');
  const cancelAmaBtn = document.getElementById('cancel-ama-modal-btn');
  const amaForm = document.getElementById('new-ama-form');

  const closeAmaModal = () => {
    if (amaModal) amaModal.style.display = 'none';
    if (amaForm) amaForm.reset();
  };

  if (addAmaBtn) {
    addAmaBtn.addEventListener('click', () => {
      amaModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  if (closeAmaBtn) closeAmaBtn.addEventListener('click', closeAmaModal);
  if (cancelAmaBtn) cancelAmaBtn.addEventListener('click', closeAmaModal);

  if (amaForm) {
    amaForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const entity = document.getElementById('ama-name').value.trim();
      const fee = parseFloat(document.getElementById('ama-fee').value);
      const status = document.getElementById('ama-status').value;

      const newAgreement = {
        id: state.amaEntities.length + 1,
        entity: entity,
        status: status,
        feeRate: fee,
        billedYTD: 0,
        nextBilling: '2026-07-01'
      };

      state.amaEntities.push(newAgreement);
      closeAmaModal();
      renderAccounting(container, state, navigateTo);
    });
  }

  // Reports download handlers
  const downloadBtns = container.querySelectorAll('.download-report-btn');
  downloadBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      btn.innerHTML = `<i data-lucide="loader" style="width: 14px; height: 14px;" class="spin"></i> Downloading...`;
      lucide.createIcons();
      btn.disabled = true;

      setTimeout(() => {
        alert(`Successfully downloaded: ${name}`);
        btn.innerHTML = `<i data-lucide="download" style="width: 14px; height: 14px;"></i> Download`;
        lucide.createIcons();
        btn.disabled = false;
      }, 1000);
    });
  });

  // MRE payment modal handlers
  const mrePaymentBtn = document.getElementById('log-mre-payment-btn');
  const mreModal = document.getElementById('mre-payment-modal');
  const closeMreBtn = document.getElementById('close-mre-modal-btn');
  const cancelMreBtn = document.getElementById('cancel-mre-modal-btn');
  const mreForm = document.getElementById('new-mre-payment-form');

  const closeMreModal = () => {
    if (mreModal) mreModal.style.display = 'none';
    if (mreForm) mreForm.reset();
  };

  if (mrePaymentBtn) {
    mrePaymentBtn.addEventListener('click', () => {
      mreModal.style.display = 'flex';
      lucide.createIcons();
    });
  }

  if (closeMreBtn) closeMreBtn.addEventListener('click', closeMreModal);
  if (cancelMreBtn) cancelMreBtn.addEventListener('click', closeMreModal);

  if (mreForm) {
    mreForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const tenant = document.getElementById('mre-tenant').value.trim();
      const unit = document.getElementById('mre-unit').value.trim();
      const amount = parseFloat(document.getElementById('mre-amount').value);

      alert(`Payment of $${amount.toLocaleString()} logged successfully for tenant ${tenant} (${unit})!`);
      closeMreModal();
      
      // Add simulated transaction to recent ledger
      state.accountingTrx.unshift({
        id: `TRX-${Math.floor(6000 + Math.random() * 4000)}`,
        title: `Rent Payment - ${tenant} (${unit})`,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        cost: amount
      });
      renderAccounting(container, state, navigateTo);
    });
  }

  // MRE action buttons (renew lease, send notice)
  const mreRenewBtns = container.querySelectorAll('.mre-renew-btn');
  mreRenewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tenant = btn.getAttribute('data-tenant');
      alert(`Initiated Lease Renewal workflow for ${tenant} in DocuSign secure routing.`);
    });
  });

  const mreNoticeBtns = container.querySelectorAll('.mre-notice-btn');
  mreNoticeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tenant = btn.getAttribute('data-tenant');
      alert(`Delivered automated monthly rent reminder notification letter to ${tenant} via secure tenant email portal.`);
    });
  });

  // MRI connection sync action
  const mriSyncBtn = document.getElementById('mri-sync-btn');
  if (mriSyncBtn) {
    mriSyncBtn.addEventListener('click', () => {
      mriSyncBtn.innerHTML = `<i data-lucide="loader" style="width: 16px; height: 16px;" class="spin"></i> Syncing databases...`;
      mriSyncBtn.disabled = true;
      lucide.createIcons();

      setTimeout(() => {
        const lastSyncEl = document.getElementById('mri-last-sync');
        if (lastSyncEl) {
          lastSyncEl.textContent = 'Just now';
        }
        
        const logsContainer = document.getElementById('mri-sync-logs');
        if (logsContainer) {
          const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
          const newLogHtml = `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid var(--border-color); border-radius: 6px; background-color: var(--bg-primary); font-size: 0.85rem; animation: fadeIn var(--transition-fast) ease-in-out;">
              <span>Bi-directional sync completed. Updated 12 new tenant profiles.</span>
              <span style="color: var(--text-muted); font-size: 0.8rem; font-family: monospace;">${nowStr}</span>
            </div>
          `;
          logsContainer.innerHTML = newLogHtml + logsContainer.innerHTML;
        }

        alert('MRI connection database successfully synchronized with internal Sage Intacct ledger!');
        mriSyncBtn.innerHTML = `<i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i> Force Database Sync`;
        mriSyncBtn.disabled = false;
        lucide.createIcons();
      }, 1500);
    });
  }
}

window.renderAccounting = renderAccounting;
