// views/tasks.js
// Renders the Tasks sub-application (Detailed List layout matching screenshot)

function renderTasks(container, state, navigateTo) {
  // Read search query if search input exists
  const searchInput = document.getElementById('task-search-input');
  const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

  // Get active sub-tab pill selection
  const activeSubTab = state.activeTaskSubTab || 'all';

  // Calculate detailed counts from state
  const totalTasks = state.tasks.length;
  const inProgressCount = state.tasks.filter(t => t.status === 'In Progress').length;
  const overdueCount = state.tasks.filter(t => t.status === 'Overdue').length;
  const noCommentsCount = state.tasks.filter(t => !t.comment || t.comment.includes('No comment')).length;
  const needsReviewCount = state.tasks.filter(t => t.status === 'Needs Review').length;

  // Filter tasks list based on search and active pill selection
  let filteredTasks = state.tasks;

  if (activeSubTab === 'needs-attention') {
    filteredTasks = filteredTasks.filter(t => t.status === 'Overdue' || t.priority === 'High' || t.priority === 'Urgent');
  }

  if (searchQuery) {
    filteredTasks = filteredTasks.filter(t => 
      t.title.toLowerCase().includes(searchQuery) ||
      t.project.toLowerCase().includes(searchQuery) ||
      t.assignee.toLowerCase().includes(searchQuery) ||
      t.id.toLowerCase().includes(searchQuery)
    );
  }

  container.innerHTML = `
    <div class="tasks-view" style="animation: fadeIn var(--transition-normal) ease-in-out;">
      <div class="view-header" style="margin-bottom: 24px;">
        <div class="view-title-group">
          <h2>Tasks</h2>
          <p>Asana-integrated task system with full project tracking</p>
        </div>
        <div style="display: flex; gap: 12px;">
          <button class="secondary-btn" id="asana-sync-btn" style="display: inline-flex; align-items: center; gap: 8px;">
            <i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i> Sync with Asana
          </button>
          <button class="primary-btn" id="add-task-btn" style="background-color: #000000; color: #ffffff;">
            <i data-lucide="plus"></i> New Task
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
        </div>

        <!-- Card 2: In Progress -->
        <div class="kpi-card card-blue">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-blue));">In Progress</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-blue));">
              <i data-lucide="clock"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-blue));">${inProgressCount}</div>
        </div>

        <!-- Card 3: Overdue -->
        <div class="kpi-card card-red">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-red));">Overdue</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-red));">
              <i data-lucide="triangle"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-red));">${overdueCount}</div>
        </div>

        <!-- Card 4: No Comments -->
        <div class="kpi-card card-orange">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-orange));">No Comments</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-orange));">
              <i data-lucide="message-square"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-orange));">${noCommentsCount}</div>
        </div>

        <!-- Card 5: Needs Review -->
        <div class="kpi-card card-purple">
          <div class="kpi-card-header">
            <span class="kpi-title" style="color: hsl(var(--color-purple));">Needs Review</span>
            <div class="kpi-icon-container" style="color: hsl(var(--color-purple));">
              <i data-lucide="user-check"></i>
            </div>
          </div>
          <div class="kpi-stat" style="font-size: 2rem; color: hsl(var(--color-purple));">${needsReviewCount}</div>
        </div>
      </div>

      <!-- Pill Selectors for Filter Status -->
      <div style="display: flex; gap: 8px; margin-bottom: 24px;">
        <button class="secondary-btn subtab-pill-btn ${activeSubTab === 'all' ? 'active' : ''}" data-subtab="all" style="border: none; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">All Tasks</button>
        <button class="secondary-btn subtab-pill-btn ${activeSubTab === 'mobile' ? 'active' : ''}" data-subtab="mobile" style="border: none; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Mobile View</button>
        <button class="secondary-btn subtab-pill-btn ${activeSubTab === 'needs-attention' ? 'active' : ''}" data-subtab="needs-attention" style="border: none; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 0.85rem;">Needs Attention</button>
      </div>

      <!-- Search and Filter Input -->
      <div style="display: flex; gap: 12px; margin-bottom: 24px; align-items: center;">
        <div style="position: relative; flex: 1; max-width: 400px;">
          <i data-lucide="search" style="position: absolute; left: 14px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--text-muted);"></i>
          <input type="text" id="task-search-input" class="form-input" style="padding-left: 40px; width: 100%;" placeholder="Search tasks..." value="${searchQuery || ''}">
        </div>
        <button class="secondary-btn" id="task-filter-detail-btn" style="display: inline-flex; align-items: center; gap: 8px;">
          <i data-lucide="sliders-horizontal" style="width: 16px; height: 16px;"></i> Filters
        </button>
      </div>

      <!-- Detailed Tasks List -->
      <div style="display: flex; flex-direction: column; gap: 16px;">
        ${filteredTasks.length === 0 
          ? `<div style="text-align: center; padding: 40px; color: var(--text-secondary); border: 1px dashed var(--border-color); border-radius: 12px;">No matching tasks found.</div>`
          : filteredTasks.map(task => renderDetailedTaskCard(task)).join('')
        }
      </div>
    </div>

    <!-- Modal for New Task -->
    <div class="modal-overlay" id="task-modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New Task</h3>
          <button class="close-btn" id="close-modal-btn">
            <i data-lucide="x"></i>
          </button>
        </div>
        <form id="new-task-form">
          <div class="form-grid">
            <div class="form-group form-group-full">
              <label for="task-title">Task Name</label>
              <input type="text" id="task-title" class="form-input" placeholder="e.g. Update financial report Q2" required>
            </div>
            <div class="form-group">
              <label for="task-assignee">Assignee Name</label>
              <input type="text" id="task-assignee" class="form-input" placeholder="Sarah Johnson" required>
            </div>
            <div class="form-group">
              <label for="task-project">Project / Category</label>
              <input type="text" id="task-project" class="form-input" placeholder="Financial Reporting" required>
            </div>
            <div class="form-group">
              <label for="task-est">Est. Hours</label>
              <input type="number" id="task-est" class="form-input" min="1" placeholder="4" required>
            </div>
            <div class="form-group">
              <label for="task-act">Actual Hours</label>
              <input type="number" id="task-act" class="form-input" min="0" placeholder="2.5" step="0.1">
            </div>
            <div class="form-group">
              <label for="task-priority">Priority</label>
              <select id="task-priority" class="form-select">
                <option value="Low">Low</option>
                <option value="Medium" selected>Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
            <div class="form-group">
              <label for="task-status">Status</label>
              <select id="task-status" class="form-select">
                <option value="To Do">To Do</option>
                <option value="In Progress">In Progress</option>
                <option value="Needs Review">Needs Review</option>
                <option value="Overdue">Overdue</option>
              </select>
            </div>
            <div class="form-group">
              <label for="task-dept">Department</label>
              <select id="task-dept" class="form-select">
                <option value="Accounting">Accounting</option>
                <option value="OPS">Operations (OPS)</option>
                <option value="IT Support">IT Support</option>
                <option value="Development">Development</option>
                <option value="Marketing">Marketing</option>
                <option value="Admin">Admin</option>
              </select>
            </div>
            <div class="form-group">
              <label for="task-due">Due Date</label>
              <input type="date" id="task-due" class="form-input" required>
            </div>
            <div class="form-group form-group-full">
              <label for="task-comment">Latest Comment (Optional)</label>
              <input type="text" id="task-comment" class="form-input" placeholder="Working on final review...">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="secondary-btn" id="cancel-modal-btn">Cancel</button>
            <button type="submit" class="primary-btn">Save Task</button>
          </div>
        </form>
      </div>
    </div>
  `;

  lucide.createIcons();

  // Task Search Typing Handler
  const sInput = document.getElementById('task-search-input');
  if (sInput) {
    sInput.addEventListener('input', () => {
      // Re-render view with current search (throttling manually via local state)
      renderTasks(container, state, navigateTo);
      // Refocus cursor to the end
      const tempInput = document.getElementById('task-search-input');
      tempInput.focus();
      const val = tempInput.value;
      tempInput.value = '';
      tempInput.value = val;
    });
  }

  // Bind Add Task UI Controls
  const addBtn = document.getElementById('add-task-btn');
  const modal = document.getElementById('task-modal');
  const closeBtn = document.getElementById('close-modal-btn');
  const cancelBtn = document.getElementById('cancel-modal-btn');
  const form = document.getElementById('new-task-form');

  addBtn.addEventListener('click', () => {
    document.getElementById('task-due').valueAsDate = new Date();
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
    const est = parseInt(document.getElementById('task-est').value) || 0;
    const act = parseFloat(document.getElementById('task-act').value) || 0;
    const commentVal = document.getElementById('task-comment').value.trim();
    
    const newTask = {
      id: `TASK-0${state.tasks.length + 1}`,
      title: document.getElementById('task-title').value,
      assignee: document.getElementById('task-assignee').value,
      project: document.getElementById('task-project').value,
      dueDate: document.getElementById('task-due').value,
      hours: `${est}h est. / ${act ? act + 'h' : '0h'} actual`,
      comment: commentVal ? `Last: ${commentVal} (Just now)` : 'No comment added',
      priority: document.getElementById('task-priority').value,
      status: document.getElementById('task-status').value,
      dept: document.getElementById('task-dept').value,
      synced: true
    };

    state.tasks.unshift(newTask);
    closeModal();
    renderTasks(container, state, navigateTo);
  });

  // Pill selectors trigger
  const pills = container.querySelectorAll('.subtab-pill-btn');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      state.activeTaskSubTab = pill.getAttribute('data-subtab');
      renderTasks(container, state, navigateTo);
    });
  });

  // Direct action button triggers inside task cards
  const completeRowBtns = container.querySelectorAll('.row-complete-btn');
  completeRowBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const taskIndex = state.tasks.findIndex(t => t.id === id);
      if (taskIndex !== -1) {
        state.tasks[taskIndex].status = 'Completed';
        renderTasks(container, state, navigateTo);
      }
    });
  });

  const commentRowBtns = container.querySelectorAll('.row-comment-btn');
  commentRowBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const commentText = prompt('Enter a new comment for this task:');
      if (commentText) {
        const taskIndex = state.tasks.findIndex(t => t.id === id);
        if (taskIndex !== -1) {
          state.tasks[taskIndex].comment = `Last: ${commentText} (Just now)`;
          renderTasks(container, state, navigateTo);
        }
      }
    });
  });

  // Asana sync button event
  document.getElementById('asana-sync-btn').addEventListener('click', () => {
    alert('Synchronizing local task ledger with Asana cloud databases...');
  });

  document.getElementById('task-filter-detail-btn').addEventListener('click', () => {
    alert('Task filter overlays toggled.');
  });
}

function renderDetailedTaskCard(task) {
  // Determine Priority color variables
  let priorityClass = '';
  if (task.priority === 'High' || task.priority === 'Urgent') {
    priorityClass = 'tag-urgent';
  } else if (task.priority === 'Medium') {
    priorityClass = 'tag-medium';
  } else {
    priorityClass = 'tag-low';
  }

  // Format Due Date
  const dateObj = new Date(task.dueDate);
  const formattedDate = dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });

  return `
    <div style="background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px 24px; box-shadow: var(--shadow-sm); display: flex; justify-content: space-between; align-items: center; gap: 24px; position: relative;">
      
      <!-- Left side contents -->
      <div style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
        <!-- Code & Title -->
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: var(--text-muted); font-size: 0.8rem; font-family: monospace; font-weight: 600;">${task.id}</span>
          <span style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">${task.title}</span>
        </div>

        <!-- Meta Indicators -->
        <div style="display: flex; flex-wrap: wrap; gap: 16px; align-items: center; font-size: 0.825rem; color: var(--text-secondary);">
          <div style="display: flex; align-items: center; gap: 6px;">
            <i data-lucide="user" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
            <span>${task.assignee}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <i data-lucide="folder" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
            <span>${task.project}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <i data-lucide="calendar" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
            <span>${formattedDate}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <i data-lucide="clock" style="width: 14px; height: 14px; color: var(--text-muted);"></i>
            <span>${task.hours}</span>
          </div>
        </div>

        <!-- Subcomment -->
        ${task.comment ? `
          <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px; padding-left: 2px;">
            <i data-lucide="message-square" style="width: 14px; height: 14px; color: hsl(var(--color-orange));"></i>
            <span style="font-style: italic;">${task.comment}</span>
          </div>
        ` : ''}
      </div>

      <!-- Right side capsules & Action icons -->
      <div style="display: flex; align-items: center; gap: 16px; flex-shrink: 0;">
        <!-- Pills -->
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="task-tag ${priorityClass}" style="margin-bottom: 0; padding: 4px 10px; border-radius: 20px;">${task.priority}</span>
          <span class="status-badge" style="background-color: var(--border-color); color: var(--text-secondary); border-radius: 20px; padding: 4px 10px;">${task.status}</span>
          <span class="status-badge" style="background-color: hsla(215, 100%, 50%, 0.1); color: hsl(215, 100%, 45%); border-radius: 20px; padding: 4px 10px;">${task.dept}</span>
          
          ${task.synced 
            ? `<span class="status-badge" style="background-color: #111827; color: #ffffff; display: inline-flex; align-items: center; gap: 4px; border-radius: 20px; padding: 4px 10px;">
                <i data-lucide="check" style="width: 12px; height: 12px; stroke: #10b981; stroke-width: 3.5px;"></i> Synced
               </span>`
            : `<span class="status-badge" style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-secondary); border-radius: 20px; padding: 4px 10px;">Local</span>`
          }
        </div>

        <!-- Action Icons -->
        <div style="display: flex; gap: 8px;">
          <button class="secondary-btn row-comment-btn" data-id="${task.id}" style="padding: 6px; border-radius: 8px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;" title="Add comment">
            <i data-lucide="message-square" style="width: 16px; height: 16px;"></i>
          </button>
          ${task.status !== 'Completed' ? `
            <button class="secondary-btn row-complete-btn" data-id="${task.id}" style="padding: 6px; border-radius: 8px; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;" title="Mark completed">
              <i data-lucide="check-circle" style="width: 16px; height: 16px;"></i>
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

window.renderTasks = renderTasks;
