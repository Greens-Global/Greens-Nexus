// views/sop.js
// Renders the Knowledge Base & SOP Application with Review SOP and LMS modules

function renderSOP(container, state, navigateTo) {
  const activeSubTab = state.activeSopSubTab || 'index';

  // Inject scoped styles for SOP & LMS view
  const styleId = 'sop-view-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    styleEl.innerHTML = `
      .sop-view {
        animation: fadeIn var(--transition-normal) ease-in-out;
      }
      
      /* Sub-tab navigation */
      .sop-tabs-nav {
        display: flex;
        gap: 8px;
        margin-bottom: 24px;
        border-bottom: 1px solid var(--border-color);
        padding-bottom: 1px;
      }
      
      .sop-tab-btn {
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
      
      .sop-tab-btn:hover {
        color: var(--text-primary);
      }
      
      .sop-tab-btn.active {
        color: var(--text-primary);
      }
      
      .sop-tab-btn.active::after {
        content: '';
        position: absolute;
        bottom: -1px;
        left: 0;
        right: 0;
        height: 2.5px;
        background-color: var(--text-primary);
        border-radius: 4px 4px 0 0;
      }

      /* LMS Card Layout */
      .lms-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }

      .lms-card {
        background-color: var(--bg-card);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 16px;
        transition: transform var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
      }

      .lms-card:hover {
        border-color: var(--border-hover);
        box-shadow: var(--shadow-md);
        transform: translateY(-2px);
      }

      .lms-progress-track {
        width: 100%;
        height: 6px;
        background-color: var(--border-color);
        border-radius: 3px;
        overflow: hidden;
      }

      .lms-progress-fill {
        height: 100%;
        background-color: hsl(var(--color-blue));
        border-radius: 3px;
        transition: width 0.3s ease;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // Render main markup wrapper with subtab switcher
  container.innerHTML = `
    <div class="sop-view">
      <!-- Sub-tab switcher -->
      <div class="sop-tabs-nav">
        <button class="sop-tab-btn ${activeSubTab === 'index' ? 'active' : ''}" data-tab="index">
          <i data-lucide="book-open" style="width: 18px; height: 18px;"></i> SOP Index
        </button>
        <button class="sop-tab-btn ${activeSubTab === 'review' ? 'active' : ''}" data-tab="review">
          <i data-lucide="check-square" style="width: 18px; height: 18px;"></i> Review SOP
        </button>
        <button class="sop-tab-btn ${activeSubTab === 'lms' ? 'active' : ''}" data-tab="lms">
          <i data-lucide="graduation-cap" style="width: 18px; height: 18px;"></i> LMS (Learning Portal)
        </button>
      </div>

      <div id="sop-panel-content">
        ${activeSubTab === 'index' ? renderSopIndex(state) :
          activeSubTab === 'review' ? renderSopReview(state) :
          renderSopLms(state)}
      </div>
    </div>
  `;

  // Bind Lucide Icons
  lucide.createIcons();

  // Attach event handlers for the Sub-tab Navigation
  const tabBtns = container.querySelectorAll('.sop-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const selectedTab = btn.getAttribute('data-tab');
      state.activeSopSubTab = selectedTab;
      navigateTo('sop');
    });
  });

  // Attach tab-specific handlers
  if (activeSubTab === 'index') {
    attachSopIndexHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'review') {
    attachSopReviewHandlers(container, state, navigateTo);
  } else if (activeSubTab === 'lms') {
    attachSopLmsHandlers(container, state, navigateTo);
  }
}

// ----------------------------------------------------
// 1. SOP Index Renderer & Handlers
// ----------------------------------------------------
function renderSopIndex(state) {
  const searchInput = document.getElementById('sop-search-input');
  const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const categories = [
    { name: 'IT Procedures', count: 24, icon: 'file-text' },
    { name: 'Accounting Guidelines', count: 18, icon: 'file-text' },
    { name: 'Operations Manual', count: 32, icon: 'file-text' },
    { name: 'Development Standards', count: 15, icon: 'file-text' },
    { name: 'Safety Protocols', count: 12, icon: 'shield' },
    { name: 'HR Policies', count: 20, icon: 'users' }
  ];

  const filteredUpdates = state.sopUpdates.filter(doc => {
    if (!searchQuery) return true;
    return doc.title.toLowerCase().includes(searchQuery) ||
           doc.category.toLowerCase().includes(searchQuery);
  });

  return `
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>SOP Index</h2>
        <p>Standard Operating Procedures and company documentation</p>
      </div>
      <button class="primary-btn" id="add-sop-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 8px;">
        <i data-lucide="file-plus" style="width: 16px; height: 16px;"></i> New SOP
      </button>
    </div>

    <!-- Search Bar -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 16px; margin-bottom: 24px; box-shadow: var(--shadow-sm);">
      <div style="position: relative; width: 100%;">
        <i data-lucide="search" style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; color: var(--text-muted);"></i>
        <input type="text" id="sop-search-input" class="form-input" style="padding-left: 44px; width: 100%; height: 44px;" placeholder="Search SOPs and documentation..." value="${searchQuery || ''}">
      </div>
    </div>

    <!-- SOP Categories Grid Section -->
    <div style="margin-bottom: 32px;">
      <div style="margin-bottom: 16px;">
        <h3 style="font-size: 1.15rem; font-family: 'Plus Jakarta Sans', sans-serif;">SOP Categories</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Browse by department and category</p>
      </div>

      <div class="cards-grid" style="grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 0;">
        ${categories.map(cat => `
          <div class="kpi-card category-card" data-cat="${cat.name}" style="padding: 20px; border-radius: 8px; flex-direction: row; align-items: center; gap: 16px; cursor: pointer; --card-hue: var(--color-blue); border: 1px solid var(--border-color);">
            <div style="width: 42px; height: 42px; border-radius: 8px; background-color: var(--bg-secondary); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
              <i data-lucide="${cat.icon}" style="width: 20px; height: 20px;"></i>
            </div>
            <div style="display: flex; flex-direction: column;">
              <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; color: var(--text-primary);">${cat.name}</strong>
              <span style="font-size: 0.8rem; color: var(--text-secondary);">${cat.count} documents</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Recent Updates List Section -->
    <div style="margin-bottom: 32px;">
      <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
        <i data-lucide="clock" style="width: 20px; height: 20px; color: var(--text-secondary);"></i>
        <div>
          <h3 style="font-size: 1.15rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Recent Updates</h3>
          <p style="color: var(--text-secondary); font-size: 0.85rem;">Latest SOP changes and additions</p>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${filteredUpdates.length === 0 
          ? `<div style="text-align: center; padding: 30px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-secondary);">No documents found matching "${searchQuery}".</div>`
          : filteredUpdates.map(doc => {
              const isPub = doc.status === 'Published';
              const statusClass = isPub ? 'status-badge status-approved' : 'status-badge status-pending';
              return `
                <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; box-shadow: var(--shadow-sm); cursor: pointer; transition: border-color var(--transition-fast);" class="sop-update-row" data-id="${doc.id}">
                  <div>
                    <strong style="font-size: 1rem; color: var(--text-primary);">${doc.title}</strong>
                    <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">${doc.category}</div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 20px;">
                    <span class="${statusClass}">${doc.status}</span>
                    <span style="font-size: 0.85rem; color: var(--text-secondary); font-weight: 500;">${doc.date}</span>
                  </div>
                </div>
              `;
            }).join('')
        }
      </div>
    </div>

    <!-- SOP AI Integration Section -->
    <div>
      <div style="margin-bottom: 16px;">
        <h3 style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 700;">Knowledge Base System</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Standard operating procedures with AI-powered editing</p>
      </div>

      <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 16px; align-items: center;">
          <div style="width: 48px; height: 48px; border-radius: 12px; background-color: hsla(215, 100%, 50%, 0.08); color: hsl(var(--color-blue)); display: flex; align-items: center; justify-content: center;">
            <i data-lucide="sparkles" style="width: 24px; height: 24px;"></i>
          </div>
          <div style="display: flex; flex-direction: column;">
            <strong style="font-size: 1.05rem; font-family: 'Plus Jakarta Sans', sans-serif; color: var(--text-primary);">SOP Editor with Claude AI integration</strong>
            <span style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 4px;">Auto-format to company SOP template</span>
            <a href="#" id="sop-configure-link" style="font-size: 0.85rem; color: hsl(var(--color-blue)); font-weight: 700; text-decoration: none; margin-top: 6px; display: inline-block;">Configure</a>
          </div>
        </div>
        <div>
          <span style="border: 1px solid var(--border-color); border-radius: 20px; padding: 4px 14px; font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Active</span>
        </div>
      </div>
    </div>

    <!-- Modal for New SOP Document -->
    <div class="modal-overlay" id="sop-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New SOP Document</h3>
          <button class="close-btn" id="close-sop-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-sop-form">
          <div class="form-grid" style="grid-template-columns: 1fr;">
            <div class="form-group">
              <label for="sop-title">Document Title</label>
              <input type="text" id="sop-title" class="form-input" placeholder="e.g. Excavation Trench Safety Guidelines" required>
            </div>
            <div class="form-group">
              <label for="sop-cat">Department Category</label>
              <select id="sop-cat" class="form-select">
                <option value="IT Procedures">IT Procedures</option>
                <option value="Accounting Guidelines">Accounting Guidelines</option>
                <option value="Operations Manual">Operations Manual</option>
                <option value="Development Standards">Development Standards</option>
                <option value="Safety Protocols" selected>Safety Protocols</option>
                <option value="HR Policies">HR Policies</option>
              </select>
            </div>
            <div class="form-group">
              <label for="sop-status">Publication Status</label>
              <select id="sop-status" class="form-select">
                <option value="Published" selected>Published</option>
                <option value="Under Review">Under Review</option>
              </select>
            </div>
            <div class="form-group">
              <label for="sop-date">Effective Date</label>
              <input type="date" id="sop-date" class="form-input" required>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button type="button" class="secondary-btn" id="cancel-sop-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Create Document</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachSopIndexHandlers(container, state, navigateTo) {
  // Search input typing handler
  const sInput = document.getElementById('sop-search-input');
  if (sInput) {
    sInput.addEventListener('input', () => {
      renderSOP(container, state, navigateTo);
      // Retain focus
      const tempInput = document.getElementById('sop-search-input');
      tempInput.focus();
      const val = tempInput.value;
      tempInput.value = '';
      tempInput.value = val;
    });
  }

  // Category cards click filtering
  const catCards = container.querySelectorAll('.category-card');
  catCards.forEach(card => {
    card.addEventListener('click', () => {
      const catName = card.getAttribute('data-cat');
      const searchBox = document.getElementById('sop-search-input');
      if (searchBox) {
        searchBox.value = catName;
        renderSOP(container, state, navigateTo);
      }
    });
  });

  // Modal controls
  const addBtn = document.getElementById('add-sop-btn');
  const modal = document.getElementById('sop-modal');
  const closeBtn = document.getElementById('close-sop-modal-btn');
  const cancelBtn = document.getElementById('cancel-sop-modal-btn');
  const form = document.getElementById('new-sop-form');

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      document.getElementById('sop-date').valueAsDate = new Date();
      modal.style.display = 'flex';
    });
  }

  const closeModal = () => {
    modal.style.display = 'none';
    form.reset();
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('sop-title').value.trim();
      const category = document.getElementById('sop-cat').value;
      const status = document.getElementById('sop-status').value;
      const date = document.getElementById('sop-date').value;

      const newDoc = {
        id: Date.now(),
        title: title,
        category: category,
        status: status,
        date: date
      };

      state.sopUpdates.unshift(newDoc);
      closeModal();
      renderSOP(container, state, navigateTo);
    });
  }

  // AI Configuration link
  const configLink = document.getElementById('sop-configure-link');
  if (configLink) {
    configLink.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Opening Claude AI SOP Auto-Formatting Configuration Dashboard...');
    });
  }

  // Row edit sandbox alert
  const rows = container.querySelectorAll('.sop-update-row');
  rows.forEach(row => {
    row.addEventListener('click', () => {
      alert('Loading full document workspace sandbox for editing...');
    });
  });
}

// ----------------------------------------------------
// 2. SOP Review Renderer & Handlers
// ----------------------------------------------------
function renderSopReview(state) {
  const reviewDocs = state.sopUpdates.filter(d => d.status === 'Under Review');

  return `
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>SOP Approval Pipeline</h2>
        <p>Review draft SOP policies and approve them for organization-wide publication</p>
      </div>
    </div>

    <!-- Review Container Card -->
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: var(--shadow-sm);">
      <div style="margin-bottom: 20px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif; margin-bottom: 2px;">Drafts Awaiting Approval</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Click 'Approve & Publish' to move documents to the index directory</p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 16px;">
        ${reviewDocs.length === 0 
          ? `<div style="text-align: center; padding: 48px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-secondary);">
              <i data-lucide="check-circle-2" style="width: 40px; height: 40px; color: hsl(var(--color-green)); margin-bottom: 12px;"></i>
              <strong style="display: block; font-size: 1rem; color: var(--text-primary);">All Drafts Approved</strong>
              <span>No SOPs are currently awaiting review.</span>
             </div>`
          : reviewDocs.map(doc => `
              <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 18px 24px; background-color: var(--bg-secondary); display: flex; justify-content: space-between; align-items: center; gap: 16px;">
                <div>
                  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <strong style="font-size: 1.05rem; color: var(--text-primary);">${doc.title}</strong>
                    <span class="status-badge status-pending" style="font-size: 0.7rem; padding: 2px 6px;">Draft</span>
                  </div>
                  <div style="font-size: 0.8rem; color: var(--text-secondary); display: flex; gap: 16px;">
                    <span>Category: <strong>${doc.category}</strong></span>
                    <span>Created on: ${doc.date}</span>
                  </div>
                </div>
                <button class="primary-btn approve-sop-btn" data-id="${doc.id}" style="background-color: hsl(var(--color-green)); color: white; display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; height: 36px; padding: 0 16px;">
                  <i data-lucide="check-circle" style="width: 14px; height: 14px;"></i> Approve & Publish
                </button>
              </div>
            `).join('')
        }
      </div>
    </div>
  `;
}

function attachSopReviewHandlers(container, state, navigateTo) {
  const approveBtns = container.querySelectorAll('.approve-sop-btn');
  approveBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const doc = state.sopUpdates.find(d => d.id === id);
      if (doc) {
        doc.status = 'Published';
        alert(`SOP "${doc.title}" approved and published to the company index directory.`);
        renderSOP(container, state, navigateTo);
      }
    });
  });
}

// ----------------------------------------------------
// 3. LMS Renderer & Handlers
// ----------------------------------------------------
function renderSopLms(state) {
  const courses = state.lmsCourses;
  const totalCourses = courses.length;
  const completedCount = courses.filter(c => c.status === 'Completed').length;
  const inProgressCount = courses.filter(c => c.status === 'Enrolled').length;

  return `
    <div class="view-header" style="margin-bottom: 24px;">
      <div class="view-title-group">
        <h2>Learning Management System (LMS)</h2>
        <p>Assign and monitor professional construction compliance courses and training</p>
      </div>
      <button class="primary-btn" id="add-course-btn" style="background-color: #000000; color: #ffffff; display: inline-flex; align-items: center; gap: 6px;">
        <i data-lucide="plus" style="width: 16px; height: 16px;"></i> Register Course
      </button>
    </div>

    <!-- LMS KPI Grid -->
    <div class="cards-grid" style="grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Total Courses</span>
          <div class="kpi-icon-container">
            <i data-lucide="book-open" style="width: 20px; height: 20px;"></i>
          </div>
        </div>
        <div class="kpi-stat" style="font-size: 2rem;">${totalCourses}</div>
        <div class="kpi-helper">Compliance courses cataloged</div>
      </div>

      <div class="kpi-card card-green" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Completed Training</span>
          <div class="kpi-icon-container">
            <i data-lucide="badge-check" style="width: 20px; height: 20px; color: hsl(var(--color-green));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-green)); font-size: 2rem;">${completedCount}</div>
        <div class="kpi-helper">Completed credentials issued</div>
      </div>

      <div class="kpi-card card-blue" style="cursor: default; padding: 20px;">
        <div class="kpi-card-header">
          <span class="kpi-title">Ongoing Training</span>
          <div class="kpi-icon-container">
            <i data-lucide="users" style="width: 20px; height: 20px; color: hsl(var(--color-blue));"></i>
          </div>
        </div>
        <div class="kpi-stat" style="color: hsl(var(--color-blue)); font-size: 2rem;">${inProgressCount}</div>
        <div class="kpi-helper">Enrolled course paths in progress</div>
      </div>
    </div>

    <!-- Training Course Catalog -->
    <div style="margin-bottom: 24px;">
      <div style="margin-bottom: 16px;">
        <h3 style="font-size: 1.1rem; font-family: 'Plus Jakarta Sans', sans-serif;">Greens Nexus Course Catalog</h3>
        <p style="color: var(--text-secondary); font-size: 0.85rem;">Compliance training curricula</p>
      </div>

      <div class="lms-grid">
        ${courses.map(course => {
          const isComp = course.status === 'Completed';
          const badgeClass = isComp ? 'status-badge status-approved' : 'status-badge status-pending';
          
          return `
            <div class="lms-card">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                  <span class="status-badge" style="background-color: var(--border-color); color: var(--text-secondary); font-size: 0.7rem; border-radius: 4px; padding: 1px 6px;">${course.category}</span>
                  <span class="${badgeClass}" style="font-size: 0.7rem; padding: 1px 6px;">${course.status}</span>
                </div>
                <strong style="font-size: 0.95rem; font-family: 'Plus Jakarta Sans', sans-serif; display: block; margin-bottom: 4px; color: var(--text-primary); line-height: 1.3;">${course.title}</strong>
                <span style="font-size: 0.8rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
                  <i data-lucide="clock" style="width: 12px; height: 12px;"></i> ${course.duration} training
                </span>
              </div>

              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; margin-bottom: 4px;">
                  <span style="color: var(--text-secondary);">Syllabus Progress</span>
                  <strong style="font-family: monospace;">${course.progress}%</strong>
                </div>
                <div class="lms-progress-track">
                  <div class="lms-progress-fill" style="width: ${course.progress}%; background-color: ${isComp ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))'};"></div>
                </div>
              </div>

              <div style="border-top: 1px solid var(--border-color); padding-top: 12px; display: flex; justify-content: flex-end;">
                ${isComp 
                  ? `<button class="secondary-btn" style="height: 32px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" disabled>
                      <i data-lucide="check" style="width: 12px; height: 12px;"></i> Course Complete
                    </button>`
                  : `<button class="primary-btn start-training-btn" data-id="${course.id}" style="height: 32px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px; background-color: #000000; color: #ffffff; padding: 0 12px;">
                      <i data-lucide="play" style="width: 12px; height: 12px;"></i> Study Lesson
                    </button>`
                }
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Modal for New Course -->
    <div class="modal-overlay" id="lms-course-modal" style="display: none;">
      <div class="modal-content" style="max-width: 500px;">
        <div class="modal-header">
          <h3>Register New Compliance Course</h3>
          <button class="close-btn" id="close-course-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-course-form">
          <div class="form-grid" style="grid-template-columns: 1fr; gap: 16px;">
            <div class="form-group">
              <label for="course-title">Course Title</label>
              <input type="text" id="course-title" class="form-input" placeholder="e.g. Forklift Certification Training" required>
            </div>
            <div class="form-group">
              <label for="course-cat">Department Category</label>
              <select id="course-cat" class="form-select">
                <option value="OPS">Operations (OPS)</option>
                <option value="Accounting">Accounting</option>
                <option value="IT">IT Infrastructure</option>
                <option value="Development">Real Estate Dev</option>
                <option value="Marketing">Marketing</option>
              </select>
            </div>
            <div class="form-group">
              <label for="course-duration">Estimated Duration</label>
              <input type="text" id="course-duration" class="form-input" placeholder="e.g. 2 hours, 45 minutes" required>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button type="button" class="secondary-btn" id="cancel-course-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Create Course</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function attachSopLmsHandlers(container, state, navigateTo) {
  // Study Lesson progress handler
  const studyBtns = container.querySelectorAll('.start-training-btn');
  studyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.getAttribute('data-id'));
      const course = state.lmsCourses.find(c => c.id === id);
      if (course) {
        course.progress += 20;
        if (course.progress >= 100) {
          course.progress = 100;
          course.status = 'Completed';
          alert(`Congratulations! You have completed "${course.title}". compliance certificate issued.`);
        } else {
          alert(`Progress saved. Lesson study in progress. Course completed: ${course.progress}%`);
        }
        renderSOP(container, state, navigateTo);
      }
    });
  });

  // Modal Controls
  const addBtn = document.getElementById('add-course-btn');
  const modal = document.getElementById('lms-course-modal');
  const closeBtn = document.getElementById('close-course-modal-btn');
  const cancelBtn = document.getElementById('cancel-course-modal-btn');
  const form = document.getElementById('new-course-form');

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
    });
  }

  const closeModal = () => {
    modal.style.display = 'none';
    form.reset();
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('course-title').value.trim();
      const category = document.getElementById('course-cat').value;
      const duration = document.getElementById('course-duration').value.trim();

      const newCourse = {
        id: Math.floor(200 + Math.random() * 800),
        title: title,
        category: category,
        duration: duration,
        progress: 0,
        status: 'Enrolled'
      };

      state.lmsCourses.push(newCourse);
      closeModal();
      renderSOP(container, state, navigateTo);
    });
  }
}

window.renderSOP = renderSOP;
