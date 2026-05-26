// views/externalLinks.js
// Renders the External Links Portal / start page matching homepage aesthetics

function renderExternalLinks(container, state, navigateTo) {
  const activeCategory = state.activeLinkCategory || 'all';
  const isAdminMode = state.linkAdminMode || false;
  const searchQuery = state.activeLinkSearchQuery || '';

  // Inject scoped styles for External Links portal
  const styleId = 'external-links-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .links-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }

      .links-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
        margin-top: 24px;
      }

      .link-portal-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        min-height: 180px;
        transition: transform var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
        cursor: pointer;
        position: relative;
      }

      .link-portal-card:hover {
        border-color: var(--border-hover);
        box-shadow: var(--shadow-md);
        transform: translateY(-2px);
      }

      .link-card-top {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        margin-bottom: 12px;
      }

      .link-category-icon-box {
        width: 42px;
        height: 42px;
        border-radius: 10px;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        flex-shrink: 0;
      }

      .link-card-details {
        display: flex;
        flex-direction: column;
      }

      .link-name-txt {
        font-family: 'Plus Jakarta Sans', sans-serif;
        font-weight: 700;
        font-size: 1.05rem;
        color: var(--text-primary);
        line-height: 1.3;
      }

      .link-url-txt {
        font-size: 0.8rem;
        color: hsl(var(--color-blue));
        margin-top: 2px;
        font-family: monospace;
        text-decoration: none;
      }

      .link-url-txt:hover {
        text-decoration: underline;
      }

      .link-desc-txt {
        font-size: 0.85rem;
        color: var(--text-secondary);
        line-height: 1.5;
        margin-bottom: 16px;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .link-card-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: auto;
      }

      .link-pill-cat {
        font-size: 0.725rem;
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        padding: 2px 6px;
        border-radius: 4px;
        color: var(--text-secondary);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .link-clicks-count {
        font-size: 0.75rem;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        gap: 4px;
        font-weight: 500;
      }

      .link-admin-actions {
        display: flex;
        gap: 6px;
        margin-top: 12px;
        border-top: 1px solid var(--border-color);
        padding-top: 12px;
        justify-content: flex-end;
      }

      .link-action-btn {
        background: none;
        border: 1px solid var(--border-color);
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--text-secondary);
        transition: all var(--transition-fast);
      }

      .link-action-btn:hover {
        background-color: var(--bg-secondary);
        color: var(--text-primary);
        border-color: var(--border-hover);
      }

      .link-delete-btn:hover {
        border-color: hsla(var(--color-red), 0.2);
        color: hsl(var(--color-red));
        background-color: hsla(var(--color-red), 0.05);
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Filter links
  let filteredLinks = state.externalLinks;

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredLinks = filteredLinks.filter(l => 
      l.name.toLowerCase().includes(q) || 
      l.description.toLowerCase().includes(q) ||
      l.url.toLowerCase().includes(q)
    );
  }

  // Category filter
  if (activeCategory === 'frequent') {
    filteredLinks = filteredLinks.filter(l => l.clicks >= 100);
  } else if (activeCategory !== 'all') {
    filteredLinks = filteredLinks.filter(l => l.category.toLowerCase() === activeCategory.toLowerCase());
  }

  container.innerHTML = `
    <div class="links-view">
      <!-- Page Header -->
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>External Links</h2>
          <p>Quick-start links to external systems, tools, and portals</p>
        </div>
        <div style="display: flex; gap: 16px; align-items: center;">
          <!-- iOS Switch for Admin Mode -->
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">Admin Edit Mode</span>
            <label class="ios-switch">
              <input type="checkbox" id="toggle-link-admin-mode" ${isAdminMode ? 'checked' : ''}>
              <span class="ios-slider"></span>
            </label>
          </div>
          <button class="primary-btn" id="add-link-header-btn" style="background-color: #000000; color: #ffffff; display: ${isAdminMode ? 'inline-flex' : 'none'};">
            <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Add Link
          </button>
        </div>
      </div>

      <!-- Search Bar -->
      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 16px; margin-bottom: 24px; box-shadow: var(--shadow-sm);">
        <div style="position: relative; width: 100%;">
          <i data-lucide="search" style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: var(--text-muted);"></i>
          <input type="text" id="links-search-input" class="form-input" style="padding-left: 44px; width: 100%; height: 44px;" placeholder="Search external links and tools..." value="${searchQuery}">
        </div>
      </div>

      <!-- Category Filter Pills -->
      <div class="filter-pills-row" style="margin-bottom: 24px;">
        <button class="filter-pill ${activeCategory === 'all' ? 'active' : ''}" data-cat="all">All Links</button>
        <button class="filter-pill ${activeCategory === 'operations' ? 'active' : ''}" data-cat="operations">Operations</button>
        <button class="filter-pill ${activeCategory === 'accounting' ? 'active' : ''}" data-cat="accounting">Accounting</button>
        <button class="filter-pill ${activeCategory === 'it' ? 'active' : ''}" data-cat="it">IT Support</button>
        <button class="filter-pill ${activeCategory === 'development' ? 'active' : ''}" data-cat="development">Development</button>
        <button class="filter-pill ${activeCategory === 'marketing' ? 'active' : ''}" data-cat="marketing">Marketing</button>
        <button class="filter-pill ${activeCategory === 'frequent' ? 'active' : ''}" data-cat="frequent" style="display: flex; align-items: center; gap: 4px;">
          <i data-lucide="zap" style="width: 12px; height: 12px;"></i> Most Frequent
        </button>
      </div>

      <!-- Links Grid -->
      ${filteredLinks.length === 0 ? `
        <div style="text-align: center; padding: 60px; color: var(--text-secondary); background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;">
          <i data-lucide="link-2" style="width: 48px; height: 48px; stroke-width: 1.5px; margin-bottom: 12px; color: var(--text-muted);"></i>
          <p style="font-weight: 500;">No links found matching your criteria.</p>
        </div>
      ` : `
        <div class="links-grid">
          ${filteredLinks.map(link => {
            // Icon selection
            let iconName = 'globe';
            if (link.category === 'Operations') iconName = 'building';
            else if (link.category === 'Accounting') iconName = 'credit-card';
            else if (link.category === 'IT') iconName = 'monitor';
            else if (link.category === 'Development') iconName = 'code';
            else if (link.category === 'Marketing') iconName = 'megaphone';

            return `
              <div class="link-portal-card" data-url="${link.url}" data-id="${link.id}">
                <div>
                  <div class="link-card-top">
                    <div class="link-category-icon-box">
                      <i data-lucide="${iconName}"></i>
                    </div>
                    <div class="link-card-details">
                      <span class="link-name-txt">${link.name}</span>
                      <span class="link-url-txt">${link.url.replace('https://', '').replace('www.', '')}</span>
                    </div>
                  </div>
                  <p class="link-desc-txt">${link.description}</p>
                </div>
                
                <div class="link-card-footer">
                  <span class="link-pill-cat">${link.category}</span>
                  <span class="link-clicks-count">
                    <i data-lucide="bar-chart-2" style="width: 12px; height: 12px;"></i> ${link.clicks} visits
                  </span>
                </div>

                ${isAdminMode ? `
                  <div class="link-admin-actions">
                    <button class="link-action-btn edit-link-btn" data-id="${link.id}">
                      <i data-lucide="edit-2" style="width: 12px; height: 12px;"></i> Edit
                    </button>
                    <button class="link-action-btn link-delete-btn delete-link-btn" data-id="${link.id}">
                      <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i> Delete
                    </button>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>

    <!-- Modal: Add / Edit Link -->
    <div class="modal-overlay" id="link-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="link-modal-title">Add External Link</h3>
          <button class="close-btn" id="close-link-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="link-form">
          <input type="hidden" id="link-form-id">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="link-form-name">Link Name / Title</label>
              <input type="text" id="link-form-name" class="form-input" placeholder="e.g. Procore, Sage Intacct" required>
            </div>
            <div class="form-group">
              <label for="link-form-url">URL Address</label>
              <input type="url" id="link-form-url" class="form-input" placeholder="e.g. https://www.procore.com" required>
            </div>
            <div class="form-group">
              <label for="link-form-category">Category</label>
              <select id="link-form-category" class="form-select">
                <option value="Operations">Operations</option>
                <option value="Accounting">Accounting</option>
                <option value="IT">IT Support</option>
                <option value="Development">Development</option>
                <option value="Marketing">Marketing</option>
                <option value="General">General / Others</option>
              </select>
            </div>
            <div class="form-group">
              <label for="link-form-desc">Description</label>
              <textarea id="link-form-desc" class="form-textarea" rows="3" placeholder="Brief description of when/why to use this system..." required></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-link-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn" id="save-link-submit-btn">Save Link</button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Bind Lucide Icons
  lucide.createIcons();

  // Search input typing handler
  const linksSearch = document.getElementById('links-search-input');
  linksSearch.addEventListener('input', (e) => {
    state.activeLinkSearchQuery = e.target.value;
    
    // Quick inline live filter to keep focus
    const q = e.target.value.toLowerCase();
    const cards = container.querySelectorAll('.link-portal-card');
    
    cards.forEach(card => {
      const text = card.textContent.toLowerCase();
      const url = card.getAttribute('data-url').toLowerCase();
      if (text.includes(q) || url.includes(q)) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
  });

  // Category pills selection
  const filterPills = container.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      state.activeLinkCategory = pill.getAttribute('data-cat');
      renderExternalLinks(container, state, navigateTo);
    });
  });

  // Admin Mode Toggling
  const adminToggle = document.getElementById('toggle-link-admin-mode');
  adminToggle.addEventListener('change', () => {
    state.linkAdminMode = adminToggle.checked;
    renderExternalLinks(container, state, navigateTo);
  });

  // Modal controls
  const addLinkBtn = document.getElementById('add-link-header-btn');
  const linkModal = document.getElementById('link-modal');
  const closeLinkBtn = document.getElementById('close-link-modal-btn');
  const cancelLinkBtn = document.getElementById('cancel-link-modal-btn');
  const linkForm = document.getElementById('link-form');
  const modalTitle = document.getElementById('link-modal-title');
  const submitBtn = document.getElementById('save-link-submit-btn');

  const closeLinkModal = () => {
    linkModal.style.display = 'none';
    linkForm.reset();
  };

  closeLinkBtn.addEventListener('click', closeLinkModal);
  cancelLinkBtn.addEventListener('click', closeLinkModal);

  // Add Link trigger
  if (addLinkBtn) {
    addLinkBtn.addEventListener('click', () => {
      document.getElementById('link-form-id').value = '';
      modalTitle.textContent = 'Add External Link';
      submitBtn.textContent = 'Save Link';
      linkModal.style.display = 'flex';
    });
  }

  // Row card clicking:
  // - In normal mode: records visit (clicks++) and opens URL in new window
  // - In admin mode: edit/delete handles itself; clicking other card areas visits URL
  const cards = container.querySelectorAll('.link-portal-card');
  cards.forEach(card => {
    card.addEventListener('click', (e) => {
      // Prevent click if editing/deleting
      if (e.target.closest('.link-action-btn')) {
        return;
      }
      
      const id = parseInt(card.getAttribute('data-id'));
      const targetUrl = card.getAttribute('data-url');
      const link = state.externalLinks.find(l => l.id === id);
      
      if (link) {
        link.clicks += 1; // Increment click stats
        renderExternalLinks(container, state, navigateTo);
        window.open(targetUrl, '_blank');
      }
    });
  });

  // Edit Link trigger
  const editBtns = container.querySelectorAll('.edit-link-btn');
  editBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      const link = state.externalLinks.find(l => l.id === id);
      if (link) {
        document.getElementById('link-form-id').value = link.id;
        document.getElementById('link-form-name').value = link.name;
        document.getElementById('link-form-url').value = link.url;
        document.getElementById('link-form-category').value = link.category;
        document.getElementById('link-form-desc').value = link.description;

        modalTitle.textContent = 'Edit External Link';
        submitBtn.textContent = 'Save Changes';
        linkModal.style.display = 'flex';
      }
    });
  });

  // Delete Link trigger
  const deleteBtns = container.querySelectorAll('.delete-link-btn');
  deleteBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      const link = state.externalLinks.find(l => l.id === id);
      if (link && confirm(`Are you sure you want to remove "${link.name}" from your External Links page?`)) {
        state.externalLinks = state.externalLinks.filter(l => l.id !== id);
        renderExternalLinks(container, state, navigateTo);
      }
    });
  });

  // Form Submit handler
  linkForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const idVal = document.getElementById('link-form-id').value;
    const name = document.getElementById('link-form-name').value.trim();
    const url = document.getElementById('link-form-url').value.trim();
    const category = document.getElementById('link-form-category').value;
    const description = document.getElementById('link-form-desc').value.trim();

    if (idVal) {
      // Edit mode
      const id = parseInt(idVal);
      const index = state.externalLinks.findIndex(l => l.id === id);
      if (index !== -1) {
        state.externalLinks[index].name = name;
        state.externalLinks[index].url = url;
        state.externalLinks[index].category = category;
        state.externalLinks[index].description = description;
      }
    } else {
      // Create mode
      const newLink = {
        id: Math.floor(100 + Math.random() * 900),
        name: name,
        url: url,
        category: category,
        description: description,
        clicks: 0
      };
      state.externalLinks.push(newLink);
    }

    closeLinkModal();
    renderExternalLinks(container, state, navigateTo);
  });
}

// Bind to window for router execution
window.renderExternalLinks = renderExternalLinks;
