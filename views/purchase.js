// views/purchase.js
// Renders the Purchase Requisition / Approvals application

function renderPurchase(container, state, navigateTo) {
  container.innerHTML = `
    <div class="purchase-view">
      <div class="view-header">
        <div class="view-title-group">
          <h2>Purchase Requisition & Approvals</h2>
          <p>Request construction materials, software licenses, or assets and approve pending requisitions</p>
        </div>
      </div>

      <div class="purchase-split">
        <!-- Left: Submit Request Form -->
        <div class="purchase-form-card">
          <h3>Create Purchase Requisition</h3>
          <form id="new-purchase-form">
            <div class="form-grid" style="grid-template-columns: 1fr;">
              <div class="form-group">
                <label for="req-item">Item Selection</label>
                <select id="req-item" class="form-select" required>
                  <option value="" disabled selected>Select an item...</option>
                  <option value="Laptop">Laptop</option>
                  <option value="PC">PC</option>
                  <option value="Monitors">Monitors</option>
                  <option value="Speakers">Speakers</option>
                  <option value="Headset">Headset</option>
                  <option value="Mouse">Mouse</option>
                  <option value="Keyboard">Keyboard</option>
                  <option value="Battery Backup">Battery Backup</option>
                  <option value="Webcam">Webcam</option>
                  <option value="Safety Vest">Safety Vest</option>
                  <option value="Safety Helmet">Safety Helmet</option>
                  <option value="Hand Tools">Hand Tools</option>
                  <option value="Power Tools">Power Tools</option>
                  <option value="Nametag">Nametag</option>
                  <option value="Uniforms">Uniforms</option>
                  <option value="Keys & Key Sets">Keys & Key Sets</option>
                  <option value="Tablet">Tablet</option>
                  <option value="Phone">Phone</option>
                </select>
              </div>
              <div class="form-group">
                <label for="req-qty">Quantity</label>
                <input type="number" id="req-qty" class="form-input" min="1" value="1" placeholder="Quantity" required>
              </div>
              <div class="form-group">
                <label for="req-dept">Department</label>
                <select id="req-dept" class="form-select">
                  <option value="OPS">Operations (OPS)</option>
                  <option value="Accounting">Accounting</option>
                  <option value="IT">IT Support</option>
                  <option value="Development">Real Estate Development</option>
                  <option value="Marketing">Marketing & Sales</option>
                  <option value="Admin">Administration</option>
                </select>
              </div>
            </div>
            <button type="submit" class="primary-btn" style="width: 100%; justify-content: center; margin-top: 10px;">
              <i data-lucide="send"></i> Submit Requisition
            </button>
          </form>
        </div>

        <!-- Right: Requisitions List & Approvals -->
        <div class="requisitions-list-card">
          <h3>Recent Requisition Logs</h3>
          <div class="req-table-wrapper">
            <table class="req-table">
              <thead>
                <tr>
                  <th>Req ID</th>
                  <th>Item / Department</th>
                  <th>Total Cost</th>
                  <th>Status</th>
                  <th style="text-align: right;">Actions</th>
                </tr>
              </thead>
              <tbody id="requisitions-tbody">
                ${state.purchaseRequests.map(req => {
                  const totalCost = req.cost 
                    ? (req.cost * req.qty).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) 
                    : '—';
                  
                  let actionsHtml = '';
                  if (req.status === 'pending') {
                    actionsHtml = `
                      <button class="primary-btn approve-btn" data-id="${req.id}" style="padding: 4px 8px; font-size: 0.75rem; background-color: hsl(var(--color-green)); border-radius: 4px;">Approve</button>
                      <button class="secondary-btn reject-btn" data-id="${req.id}" style="padding: 4px 8px; font-size: 0.75rem; color: hsl(var(--color-red)); border-color: hsla(var(--color-red), 0.2); border-radius: 4px;">Reject</button>
                    `;
                  } else {
                    actionsHtml = `<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500;">Closed</span>`;
                  }

                  return `
                    <tr>
                      <td>#${req.id}</td>
                      <td>
                        <div class="req-item-name">${req.item}</div>
                        <div class="req-item-dept">${req.dept}${req.vendor ? ` &bull; Vendor: ${req.vendor}` : ''}</div>
                      </td>
                      <td style="font-weight: 600;">${totalCost}</td>
                      <td>
                        <span class="status-badge status-${req.status}">${req.status}</span>
                      </td>
                      <td style="text-align: right; white-space: nowrap;">
                        ${actionsHtml}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  lucide.createIcons();

  // Form Submit Handler
  const form = document.getElementById('new-purchase-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const newReq = {
      id: Math.floor(1000 + Math.random() * 9000),
      item: document.getElementById('req-item').value,
      vendor: '',
      cost: 0,
      qty: parseInt(document.getElementById('req-qty').value),
      dept: document.getElementById('req-dept').value,
      status: 'pending'
    };

    state.purchaseRequests.unshift(newReq);
    form.reset();
    renderPurchase(container, state, navigateTo);
  });

  // Action Buttons Handlers (Approve/Reject)
  const approveBtns = container.querySelectorAll('.approve-btn');
  approveBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const reqIndex = state.purchaseRequests.findIndex(r => r.id === id);
      if (reqIndex !== -1) {
        state.purchaseRequests[reqIndex].status = 'approved';
        renderPurchase(container, state, navigateTo);
      }
    });
  });

  const rejectBtns = container.querySelectorAll('.reject-btn');
  rejectBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const reqIndex = state.purchaseRequests.findIndex(r => r.id === id);
      if (reqIndex !== -1) {
        state.purchaseRequests[reqIndex].status = 'rejected';
        renderPurchase(container, state, navigateTo);
      }
    });
  });
}

window.renderPurchase = renderPurchase;
