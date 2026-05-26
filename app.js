// app.js
// Core Router and Controller for Greens Nexus Master Dashboard

// 1. Initial State Definition (Initialized to match Figma counts exactly)
const state = {
  activeView: 'dashboard',
  theme: localStorage.getItem('gg-theme') || 'light',
  activeTaskSubTab: 'all',
  activeSopFilter: '',
  activeSopSubTab: 'index',
  activeITSubTab: 'access',
  activeAccountingSubTab: 'transactions',
  activeDevelopmentSubTab: 'dev-permits',
  activeOpsSubTab: 'ops-dashboard',
  activePropertyAssetSubTab: 'asset-portfolio',
  activeHRSubTab: 'hr-ms',
  activeInvestorSubTab: 'investor-dashboard',
  activeMarketingSubTab: 'ads',
  marketingPropertyFilter: 'all',
  activeReviewFilter: 'all',
  
  // 8 active tasks total (4 In Progress, 1 Overdue, 1 Needs Review, 2 To Do).
  // Exactly 3 have no comments (TASK-004, TASK-006, TASK-007).
  tasks: [
    { id: 'TASK-001', title: 'Update financial report Q2', assignee: 'Sarah Johnson', project: 'Financial Reporting', dueDate: '2026-05-23', hours: '4h est. / 2.5h actual', comment: 'Last: Working on final review (2 hours ago)', priority: 'High', status: 'In Progress', dept: 'Accounting', synced: true },
    { id: 'TASK-002', title: 'Review site concrete excavation', assignee: 'Michael Chen', project: 'Onsite Operations', dueDate: '2026-05-24', hours: '2h est. / 2.0h actual', comment: 'Last: Soil inspection complete (1 day ago)', priority: 'High', status: 'In Progress', dept: 'OPS', synced: true },
    { id: 'TASK-003', title: 'Draft subcontractor legal framing agreement', assignee: 'Emily Rodriguez', project: 'Legal & Contracts', dueDate: '2026-05-25', hours: '6h est. / 4.0h actual', comment: 'Last: Awaiting legal team review (3 hours ago)', priority: 'Medium', status: 'Needs Review', dept: 'Development', synced: true },
    { id: 'TASK-004', title: 'Regulatory permit filing Site-B', assignee: 'Emily Rodriguez', project: 'Regulatory Permitting', dueDate: '2026-05-22', hours: '3h est. / 3.0h actual', comment: '', priority: 'High', status: 'Overdue', dept: 'Development', synced: true },
    { id: 'TASK-005', title: 'Google Ads restructuring', assignee: 'Jessica Taylor', project: 'Marketing & Ads', dueDate: '2026-05-24', hours: '4h est. / 2.5h actual', comment: 'Last: Setup keyword match types (4 hours ago)', priority: 'Medium', status: 'In Progress', dept: 'Marketing', synced: true },
    { id: 'TASK-006', title: 'IT firewall server patching', assignee: 'David Kim', project: 'IT Security', dueDate: '2026-05-26', hours: '5h est. / 0h actual', comment: '', priority: 'Low', status: 'In Progress', dept: 'IT Support', synced: false },
    { id: 'TASK-007', title: 'Submit Q2 vendor invoice report', assignee: 'Sarah Johnson', project: 'Accounting Audit', dueDate: '2026-05-25', hours: '3h est. / 0h actual', comment: '', priority: 'Medium', status: 'To Do', dept: 'Accounting', synced: true },
    { id: 'TASK-008', title: 'Audit site concrete deliveries', assignee: 'Marcus Vance', project: 'Material Logs', dueDate: '2026-05-21', hours: '8h est. / 6h actual', comment: 'Last: Audit logs in progress (1 week ago)', priority: 'Low', status: 'To Do', dept: 'OPS', synced: true }
  ],
  
  // 6 total requests, 5 pending approvals. Matches KPI cards.
  purchaseRequests: [
    { id: 8492, item: 'Premium Ready-Mix Concrete - 120 Cubic Yards', vendor: 'Apex Building Supplies', cost: 120, qty: 120, dept: 'OPS', status: 'pending' },
    { id: 7721, item: 'Architectural Consulting Fees - Phase 3', vendor: 'Studio-D Designs', cost: 5000, qty: 1, dept: 'Development', status: 'pending' },
    { id: 3108, item: 'Heavy Duty Excavation Equipment Rental', vendor: 'Herc Rentals', cost: 1850, qty: 2, dept: 'OPS', status: 'pending' },
    { id: 6241, item: 'Autodesk AutoCAD Core Team Subscriptions', vendor: 'Autodesk Reseller', cost: 1680, qty: 6, dept: 'IT', status: 'pending' },
    { id: 4902, item: 'Corporate Financial Audit Consulting', vendor: 'Deloitte LLP', cost: 8500, qty: 1, dept: 'Accounting', status: 'pending' },
    { id: 1045, item: 'Google Local Service Ads - Q2 Budget Boost', vendor: 'Google Ads', cost: 4200, qty: 1, dept: 'Marketing', status: 'approved' }
  ],

  // Reviews state (8 total, 3 pending, matches rating & statistics)
  reviews: [
    { 
      id: 1, 
      name: 'John Smith', 
      property: 'Harbor View Condos', 
      platform: 'Google', 
      date: '2 hours ago', 
      rating: 5, 
      comment: 'Excellent service and professional team! The quality of construction is outstanding. We moved in last month and couldn\'t be happier with our new home.', 
      replied: false, 
      isNew: true, 
      badge: 'New Review', 
      badgeColor: 'red', 
      aiReply: 'Thank you so much for your wonderful review, John! We\'re thrilled to hear you\'re enjoying your new home at Harbor View Condos. Our team works hard to deliver exceptional quality, and it\'s great to know we exceeded your expectations. Welcome to the community, and please don\'t hesitate to reach out if you need anything!' 
    },
    { 
      id: 2, 
      name: 'Jane Doe', 
      property: 'Downtown Complex', 
      platform: 'Google', 
      date: '1 day ago', 
      rating: 4, 
      comment: 'Great experience overall. The team was responsive and professional. Only minor issue was some delays in the final walk-through, but everything was resolved quickly.', 
      replied: false, 
      isNew: false, 
      badge: 'AI Reply Suggested', 
      badgeColor: 'gray', 
      aiReply: 'Thank you for your feedback, Jane! We\'re glad you had a positive experience with our team at Downtown Complex. We apologize for the delays in the final walk-through and appreciate your patience as we resolved those issues. Your satisfaction is our priority, and we\'re always here if you need any support!' 
    },
    { 
      id: 3, 
      name: 'Marcus Brody', 
      property: 'Downtown Commercial Complex', 
      platform: 'Google', 
      date: '5 days ago', 
      rating: 3, 
      comment: 'The construction noise at the downtown project starts a bit too early. The building looks good but please respect city ordinance hours.', 
      replied: false, 
      isNew: false, 
      badge: '', 
      badgeColor: '', 
      aiReply: 'Thank you for your feedback, Marcus. We apologize for any inconvenience caused by construction noise. Our teams are instructed to adhere strictly to local noise ordinances and permit guidelines. We will review our scheduling to minimize early morning disturbances. We appreciate your patience as we complete this project.' 
    },
    { 
      id: 4, 
      name: 'Sarah Jenkins', 
      property: 'Oakridge Subdivision Phase 1', 
      platform: 'Google', 
      date: '2 hours ago', 
      rating: 5, 
      comment: 'Greens Nexus did an outstanding job developing our retail complex. From zoning approvals to the final walkthrough, they were communicative and professional. Highly recommended!', 
      replied: true, 
      replyText: 'Thank you Sarah! It was a pleasure working with you on this project. We appreciate your recommendation!' 
    },
    { 
      id: 5, 
      name: 'David Vance', 
      property: 'Onsite Development Site-B', 
      platform: 'Google', 
      date: '1 day ago', 
      rating: 4, 
      comment: 'Excellent build quality on our custom home. Minor delay due to rain, but the onsite supervisor kept us updated daily. The craftmanship is superb.', 
      replied: true, 
      replyText: 'We appreciate the feedback, David! Our onsite teams always strive to maintain clear communication, even during weather delays.' 
    },
    { 
      id: 6, 
      name: 'Amir Al-Mansoori', 
      property: 'North Industrial Warehouse', 
      platform: 'Google', 
      date: '2 days ago', 
      rating: 5, 
      comment: 'Professional real estate developers who know the local market inside out. Helped us acquire and permit our commercial warehouse site quickly.', 
      replied: true, 
      replyText: 'Thank you Amir! Navigating local permits is one of our specialties, and we are glad we could speed up the process for your warehouse site.' 
    },
    { 
      id: 7, 
      name: 'Elena Rostova', 
      property: 'Downtown Office Renovation', 
      platform: 'Google', 
      date: '1 week ago', 
      rating: 4, 
      comment: 'Very satisfied with our office renovation project. The project finished exactly on budget. Communication was a bit slow in the middle, but final delivery was excellent.', 
      replied: true, 
      replyText: 'Thank you for the review, Elena! We are glad you are happy with the renovation. We will work on keeping communication more frequent during the middle phases of our next projects.' 
    },
    { 
      id: 8, 
      name: 'Robert Chen', 
      property: 'Harbor View Residential', 
      platform: 'Google', 
      date: '1 week ago', 
      rating: 5, 
      comment: 'Greens Nexus project management is stellar. They kept subcontractors on a tight schedule. Safety protocols were top-tier throughout.', 
      replied: true, 
      replyText: 'Thank you Robert! Safety and efficiency are our core values, and we appreciate you highlighting them.' 
    }
  ],

  // Google Ads Campaign performance metrics
  marketingCampaigns: [
    { name: 'Harbor View - Search Ads', property: 'Harbor View', platform: 'Google Search', impressions: 45230, clicks: 1420, conversions: 68, abandonedCarts: 112, spend: 1250, costPerConv: 18.38, status: 'Active' },
    { name: 'Downtown Complex - Display', property: 'Downtown Complex', platform: 'Google Display', impressions: 38150, clicks: 980, conversions: 42, abandonedCarts: 89, spend: 890, costPerConv: 21.19, status: 'Active' },
    { name: 'Residential Towers - Remarketing', property: 'Residential Towers', platform: 'Remarketing', impressions: 21420, clicks: 865, conversions: 51, abandonedCarts: 78, spend: 1180, costPerConv: 23.14, status: 'Active' },
    { name: 'Commercial Spaces - Shopping', property: 'Commercial Spaces', platform: 'Google Shopping', impressions: 12580, clicks: 542, conversions: 18, abandonedCarts: 45, spend: 680, costPerConv: 37.78, status: 'Active' },
    { name: 'Luxury Condos - YouTube', property: 'Luxury Condos', platform: 'YouTube Ads', impressions: 7203, clicks: 231, conversions: 8, abandonedCarts: 18, spend: 250, costPerConv: 31.25, status: 'Paused' }
  ],

  // 4 recent SOP updates
  sopUpdates: [
    { id: 1, title: 'IT Security Policy v2.1', category: 'IT Procedures', status: 'Published', date: '2026-05-20' },
    { id: 2, title: 'Financial Reporting Guidelines', category: 'Accounting Guidelines', status: 'Under Review', date: '2026-05-19' },
    { id: 3, title: 'Site Safety Checklist', category: 'Safety Protocols', status: 'Published', date: '2026-05-18' },
    { id: 4, title: 'Code Review Process', category: 'Development Standards', status: 'Published', date: '2026-05-17' }
  ],

  // IT Config and site change logs state
  itConfig: {
    aiLabellingActive: true,
    unlabelledFilesCount: 147,
    checkerLastRun: '2 hours ago'
  },

  itChangeLogs: [
    { timestamp: '2026-05-20 14:32', user: 'John Doe', action: 'Updated', module: 'SOP System', details: 'IT Security Policy v2.1' },
    { timestamp: '2026-05-20 13:15', user: 'Jane Smith', action: 'Created', module: 'Asset Mgmt', details: 'Added Dell Latitude 5520' },
    { timestamp: '2026-05-20 11:45', user: 'Mike Johnson', action: 'Modified', module: 'Access Control', details: 'Updated team permissions' },
    { timestamp: '2026-05-20 10:22', user: 'Sarah Williams', action: 'Approved', module: 'SOP System', details: 'Finance SOP v1.3' },
    { timestamp: '2026-05-20 09:18', user: 'Admin', action: 'Sync', module: 'Egnyte', details: 'Access sheet updated' },
    { timestamp: '2026-05-19 16:40', user: 'IT Team', action: 'Deployed', module: 'Infrastructure', details: 'Network config change' }
  ],

  // 5 transactions matching the accounting screenshot
  accountingTrx: [
    { id: 'TRX-1234', title: 'Project Payment - Downtown Complex', date: 'May 20, 2026', cost: 125000 },
    { id: 'TRX-1235', title: 'Construction Materials', date: 'May 19, 2026', cost: -45200 },
    { id: 'TRX-1236', title: 'Contractor Payment', date: 'May 18, 2026', cost: -67500 },
    { id: 'TRX-1237', title: 'Property Sale Commission', date: 'May 17, 2026', cost: 89000 },
    { id: 'TRX-1238', title: 'Office Rent', date: 'May 16, 2026', cost: -12000 }
  ],

  // Operations Project data state
  opsProjects: [
    { id: 1, name: 'Downtown Commercial Complex', status: 'on-track', location: 'Main Street, Downtown', members: 24, dueDate: 'Aug 15, 2026', progress: 75 },
    { id: 2, name: 'Residential Tower - Phase 2', status: 'delayed', location: 'Harbor View District', members: 18, dueDate: 'Sep 30, 2026', progress: 45 },
    { id: 3, name: 'Industrial Warehouse', status: 'on-track', location: 'North Industrial Zone', members: 12, dueDate: 'Jun 10, 2026', progress: 92 }
  ],

  // Supply Chain logistics state
  opsLogistics: [
    { item: 'Steel Beams - 50 units', destination: 'Downtown Complex', eta: 'May 22, 2026', status: 'in-transit' },
    { item: 'Cement - 200 bags', destination: 'Residential Tower', eta: 'May 20, 2026', status: 'delivered' }
  ],

  // Heavy Equipment Status tracking state
  opsEquipment: [
    { name: 'Crane A-45', location: 'Downtown Complex', status: 'in-use', progress: 80 },
    { name: 'Excavator EX-12', location: 'Equipment Yard', status: 'available', progress: 0 }
  ],

  // Real estate development state
  devProjects: [
    { id: 1, name: 'Luxury Apartment Complex', type: 'Residential • 120 units', status: 'planning', location: 'Oceanview District', cost: 45, dueDate: 'Q4 2027', roi: 18 },
    { id: 2, name: 'Mixed-Use Development', type: 'Commercial • 85 units', status: 'pre-construction', location: 'Central Business District', cost: 68, dueDate: 'Q2 2028', roi: 22 },
    { id: 3, name: 'Suburban Housing Project', type: 'Residential • 250 units', status: 'construction', location: 'Green Valley', cost: 32, dueDate: 'Q1 2027', roi: 15 }
  ],

  // Asset Management state (6 seed items, supports offset math for KPI numbers)
  assets: [
    { id: 1, name: 'Dell Latitude 5520', category: 'Laptop', assignedTo: 'John Doe', status: 'Checked Out', lastSeen: '2026-05-20' },
    { id: 2, name: 'iPhone 13 Pro', category: 'Mobile', assignedTo: 'Jane Smith', status: 'Checked Out', lastSeen: '2026-05-19' },
    { id: 3, name: 'MacBook Pro 16"', category: 'Laptop', assignedTo: 'Mike Johnson', status: 'Checked Out', lastSeen: '2026-05-20' },
    { id: 4, name: 'Dell Monitor 27"', category: 'Monitor', assignedTo: 'Unassigned', status: 'Available', lastSeen: '2026-05-18' },
    { id: 5, name: 'Logitech Keyboard', category: 'Accessory', assignedTo: 'Sarah Williams', status: 'Overdue', lastSeen: '2026-05-10' },
    { id: 6, name: 'HP Printer', category: 'Printer', assignedTo: 'OPS Dept', status: 'Checked Out', lastSeen: '2026-05-19' }
  ],

  // Admin & Access Control State
  adminSettings: {
    ssoEnabled: true,
    mfaRequired: true,
    deptAccess: true,
    autoImport: false
  },

  users: [
    { id: 1, name: 'John Mitchell', dept: 'IT', role: 'IT Manager', accessLevel: 'Admin', specialAccess: ['Full System', 'User Management', '+1'], status: 'Active', lastLogin: '2026-05-21 09:30 AM' },
    { id: 2, name: 'Sarah Johnson', dept: 'Accounting', role: 'Financial Controller', accessLevel: 'Manager', specialAccess: ['Financial Reports', 'Budget Approval'], status: 'Active', lastLogin: '2026-05-21 08:15 AM' },
    { id: 3, name: 'Michael Chen', dept: 'OPS', role: 'Operations Lead', accessLevel: 'Manager', specialAccess: ['Site Access', 'Equipment Management'], status: 'Active', lastLogin: '2026-05-20 04:30 PM' },
    { id: 4, name: 'Emily Rodriguez', dept: 'Development', role: 'Senior Developer', accessLevel: 'Development', specialAccess: ['Code Repository', 'Deployment'], status: 'Active', lastLogin: '2026-05-21 10:00 AM' },
    { id: 5, name: 'David Park', dept: 'Marketing', role: 'Marketing Manager', accessLevel: 'Marketing', specialAccess: ['Analytics Dashboard', 'Social Media'], status: 'Active', lastLogin: '2026-05-21 07:45 AM' },
    { id: 6, name: 'Lisa Thompson', dept: 'Accounting', role: 'Accountant', accessLevel: 'Accounting', specialAccess: ['None'], status: 'Active', lastLogin: '2026-05-20 09:20 PM' },
    { id: 7, name: 'Robert Kim', dept: 'OPS', role: 'Site Supervisor', accessLevel: 'OPS', specialAccess: ['Safety Reports'], status: 'Inactive', lastLogin: '2026-05-15 11:00 AM' },
    { id: 8, name: 'Jennifer Lee', dept: 'Admin', role: 'HR Coordinator', accessLevel: 'View Only', specialAccess: ['None'], status: 'Active', lastLogin: '2026-05-21 08:00 AM' }
  ],

  accessLogs: [
    { timestamp: '2026-05-21 09:30 AM', user: 'John Mitchell', action: 'User login', module: 'Admin Panel', status: 'Success' },
    { timestamp: '2026-05-21 08:45 AM', user: 'Sarah Johnson', action: 'Role assigned', module: 'User Management', status: 'Success' },
    { timestamp: '2026-05-21 01:15 AM', user: 'Unknown IP', action: 'Failed login attempt', module: 'Login', status: 'Failed' },
    { timestamp: '2026-05-20 04:30 PM', user: 'Michael Chen', action: 'Access granted', module: 'OPS Dashboard', status: 'Success' },
    { timestamp: '2026-05-20 02:30 PM', user: 'Emily Rodriguez', action: 'Password reset', module: 'Security', status: 'Success' }
  ],

  // Website Management state (3 seed items)
  websites: [
    { id: 1, name: 'Main Website', domain: 'greensglobal.com', sslDays: 87, uptime: 99.98, status: 'Online' },
    { id: 2, name: 'Client Portal', domain: 'portal.greensglobal.com', sslDays: 45, uptime: 99.92, status: 'Online' },
    { id: 3, name: 'Blog', domain: 'blog.greensglobal.com', sslDays: 123, uptime: 100, status: 'Online' }
  ],

  // External Links state (6 seed items)
  externalLinks: [
    { id: 1, name: 'Procore Construction OS', url: 'https://www.procore.com', category: 'Operations', description: 'Primary construction management software for project logs, safety checklists, and plans.', clicks: 120 },
    { id: 2, name: 'Sage Intacct Accounting', url: 'https://www.sage.com', category: 'Accounting', description: 'Cloud ERP ledger for budgeting, invoice tracking, and audits.', clicks: 85 },
    { id: 3, name: 'Asana Workspace', url: 'https://asana.com', category: 'IT', description: 'Internal tasks tracker, team workload manager, and project scheduling board.', clicks: 230 },
    { id: 4, name: 'CoConstruct Portal', url: 'https://coconstruct.com', category: 'Operations', description: 'Custom home building estimating, scheduling, and subcontractor bidding portal.', clicks: 64 },
    { id: 5, name: 'Autodesk Build', url: 'https://construction.autodesk.com', category: 'Development', description: 'Design blueprint management, CAD specifications, and zoning docs.', clicks: 92 },
    { id: 6, name: 'HubSpot CRM', url: 'https://www.hubspot.com', category: 'Marketing', description: 'Marketing campaign manager, client lead logs, and sales pipeline tracker.', clicks: 105 }
  ],

  // Upgraded System States
  itAccessAccounts: [
    { id: 1, name: 'John Mitchell', role: 'IT Manager', vpnAccess: 'Active v2.4', mfaStatus: 'Enabled', lastActive: '2 min ago' },
    { id: 2, name: 'Sarah Johnson', role: 'Financial Controller', vpnAccess: 'Active v2.4', mfaStatus: 'Enabled', lastActive: '12 min ago' },
    { id: 3, name: 'Michael Chen', role: 'OPS Lead', vpnAccess: 'Inactive', mfaStatus: 'Enabled', lastActive: '1 hour ago' },
    { id: 4, name: 'Emily Rodriguez', role: 'Senior Developer', vpnAccess: 'Active v2.4', mfaStatus: 'Enabled', lastActive: 'Just now' },
    { id: 5, name: 'Lisa Thompson', role: 'Accountant', vpnAccess: 'Inactive', mfaStatus: 'Disabled', lastActive: '1 day ago' }
  ],

  itNetworkNodes: [
    { id: 'NET-01', name: 'Core Firewall Fortigate 100F', ip: '10.0.1.1', type: 'Firewall', ping: '1.2ms', status: 'Online' },
    { id: 'NET-02', name: 'Main WAN Router Cisco 4331', ip: '10.0.1.254', type: 'Router', ping: '2.5ms', status: 'Online' },
    { id: 'NET-03', name: 'Core Switch Catalyst 9300', ip: '10.0.2.1', type: 'Switch', ping: '0.8ms', status: 'Online' },
    { id: 'NET-04', name: 'OPS Trailer Switch Catalyst 1000', ip: '10.0.4.1', type: 'Switch', ping: '12.4ms', status: 'Online' },
    { id: 'NET-05', name: 'HQ Access Point Ubiquiti U6', ip: '10.0.5.10', type: 'Access Point', ping: '5.1ms', status: 'Online' },
    { id: 'NET-06', name: 'Guest Access Point Ubiquiti AC', ip: '10.0.5.11', type: 'Access Point', ping: '0.0ms', status: 'Offline' }
  ],

  lmsCourses: [
    { id: 101, title: 'Onsite Safety & Hazard Compliance', category: 'OPS', duration: '2 hours', progress: 100, status: 'Completed' },
    { id: 102, title: 'Sage Intacct Accounting Basics', category: 'Accounting', duration: '4 hours', progress: 40, status: 'Enrolled' },
    { id: 103, title: 'GDPR & Corporate IT Security Training', category: 'IT', duration: '1 hour', progress: 0, status: 'Enrolled' },
    { id: 104, title: 'Construction Blueprint Interpretation', category: 'Development', duration: '3 hours', progress: 100, status: 'Completed' },
    { id: 105, title: 'HubSpot Lead Routing & Sales Operations', category: 'Marketing', duration: '1.5 hours', progress: 85, status: 'Enrolled' }
  ],

  rampTransactions: [
    { id: 'TXN-9031', vendor: 'Apex Building Supplies', cost: 145.00, date: 'May 22, 2026', category: 'Office Supplies', memo: 'OPS Office Supplies & stationary', missing: false },
    { id: 'TXN-9032', vendor: 'Cemex Ready-Mix', cost: 1200.00, date: 'May 21, 2026', category: 'Materials', memo: '', missing: true },
    { id: 'TXN-9033', vendor: 'AWS Cloud Billing', cost: 452.10, date: 'May 20, 2026', category: 'IT Infrastructure', memo: '', missing: true },
    { id: 'TXN-9034', vendor: 'Home Depot', cost: 89.50, date: 'May 19, 2026', category: 'Tools', memo: 'Hand tools for Site-B framing crew', missing: false },
    { id: 'TXN-9035', vendor: 'Adobe Creative Cloud', cost: 79.99, date: 'May 18, 2026', category: 'Software Licences', memo: '', missing: true }
  ],

  amaEntities: [
    { id: 1, entity: 'Greens Nexus LLC', status: 'Active', feeRate: 3.5, billedYTD: 142000, nextBilling: '2026-06-01' },
    { id: 2, entity: 'GN Construction Con', status: 'Active', feeRate: 4.0, billedYTD: 98000, nextBilling: '2026-06-01' },
    { id: 3, entity: 'Greens Real Estate Dev Ltd', status: 'Pending Review', feeRate: 3.0, billedYTD: 0, nextBilling: 'TBD' },
    { id: 4, entity: 'Global Property Management Inc', status: 'Active', feeRate: 2.5, billedYTD: 45000, nextBilling: '2026-06-15' }
  ]
};

// 2. Element Selectors
const mainViewport = document.getElementById('main-viewport');
const viewTitleElement = document.getElementById('current-view-title');
const navItems = document.querySelectorAll('.nav-item');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const mobileToggle = document.getElementById('mobile-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

// 3. Routing & View Switcher Controller
function navigateTo(viewName) {
  state.activeView = viewName;
  
  // Highlight correct sidebar item
  navItems.forEach(item => {
    if (item.getAttribute('data-view') === viewName) {
      item.classList.add('active');
      viewTitleElement.textContent = item.querySelector('span').textContent;
    } else {
      item.classList.remove('active');
    }
  });

  // Handle collapsing/expanding submenus and highlighting active subtabs
  const allSubmenus = {
    'it': { elementId: 'it-submenu', itemId: 'it-nav-item', activeTab: state.activeITSubTab || 'access' },
    'sop': { elementId: 'sop-submenu', itemId: 'sop-nav-item', activeTab: state.activeSopSubTab || 'index' },
    'ops': { elementId: 'ops-submenu', itemId: 'ops-nav-item', activeTab: state.activeOpsSubTab || 'ops-dashboard' },
    'development': { elementId: 'development-submenu', itemId: 'development-nav-item', activeTab: state.activeDevelopmentSubTab || 'dev-permits' },
    'property-asset': { elementId: 'property-asset-submenu', itemId: 'property-asset-nav-item', activeTab: state.activePropertyAssetSubTab || 'asset-portfolio' },
    'hr': { elementId: 'hr-submenu', itemId: 'hr-nav-item', activeTab: state.activeHRSubTab || 'hr-ms' },
    'investor-relations': { elementId: 'investor-relations-submenu', itemId: 'investor-relations-nav-item', activeTab: state.activeInvestorSubTab || 'investor-dashboard' },
    'marketing': { elementId: 'marketing-submenu', itemId: 'marketing-nav-item', activeTab: state.activeMarketingSubTab === 'reputation' ? 'marketing-reputation' : 'marketing-ads' },
    'accounting': { elementId: 'accounting-submenu', itemId: 'accounting-nav-item', activeTab: state.activeAccountingSubTab || 'transactions' }
  };

  Object.keys(allSubmenus).forEach(key => {
    const data = allSubmenus[key];
    const submenu = document.getElementById(data.elementId);
    const parentItem = document.getElementById(data.itemId);
    
    if (submenu && parentItem) {
      if (viewName === key) {
        submenu.style.display = 'flex';
        parentItem.classList.add('submenu-open');
        const toggleBtn = parentItem.querySelector('.submenu-toggle-btn');
        if (toggleBtn) {
          toggleBtn.innerHTML = '<i data-lucide="chevron-up" style="width: 14px; height: 14px;"></i>';
        }
        
        // Highlight active subtab in submenu
        const submenuItems = submenu.querySelectorAll('.submenu-item');
        submenuItems.forEach(subItem => {
          const subview = subItem.getAttribute('data-subview');
          if (subview === data.activeTab) {
            subItem.classList.add('active');
          } else {
            subItem.classList.remove('active');
          }
        });
      } else {
        submenu.style.display = 'none';
        parentItem.classList.remove('submenu-open');
        const toggleBtn = parentItem.querySelector('.submenu-toggle-btn');
        if (toggleBtn) {
          toggleBtn.innerHTML = '<i data-lucide="chevron-down" style="width: 14px; height: 14px;"></i>';
        }
      }
    }
  });
  lucide.createIcons();

  // Render view
  mainViewport.className = 'viewport'; // Reset class for transition animation trigger
  void mainViewport.offsetWidth; // Force reflow to restart animation
  mainViewport.classList.add('fade-in');

  switch (viewName) {
    case 'dashboard':
      window.renderDashboard(mainViewport, state, navigateTo);
      break;
    case 'manager-dashboard':
      window.renderManagerDashboard(mainViewport, state, navigateTo);
      break;
    case 'tasks':
      window.renderTasks(mainViewport, state, navigateTo);
      break;
    case 'sop':
      window.renderSOP(mainViewport, state, navigateTo);
      break;
    case 'it':
      window.renderIT(mainViewport, state, navigateTo);
      break;
    case 'ops':
      window.renderOperations(mainViewport, state, navigateTo);
      break;
    case 'development':
      window.renderDevelopment(mainViewport, state, navigateTo);
      break;
    case 'property-asset':
      window.renderPropertyAsset(mainViewport, state, navigateTo);
      break;
    case 'hr':
      window.renderHR(mainViewport, state, navigateTo);
      break;
    case 'investor-relations':
      window.renderInvestorRelations(mainViewport, state, navigateTo);
      break;
    case 'accounting':
      window.renderAccounting(mainViewport, state, navigateTo);
      break;
    case 'purchase':
      window.renderPurchase(mainViewport, state, navigateTo);
      break;
    case 'marketing':
      window.renderMarketing(mainViewport, state, navigateTo);
      break;
    case 'asset':
      state.activeITSubTab = 'asset';
      navigateTo('it');
      break;
    case 'access':
      state.activeITSubTab = 'access';
      navigateTo('it');
      break;
    case 'integrations':
      state.activeITSubTab = 'integrations';
      navigateTo('it');
      break;
    case 'network':
      state.activeITSubTab = 'network';
      navigateTo('it');
      break;
    case 'sop-index':
      state.activeSopSubTab = 'index';
      navigateTo('sop');
      break;
    case 'sop-review':
      state.activeSopSubTab = 'review';
      navigateTo('sop');
      break;
    case 'lms':
      state.activeSopSubTab = 'lms';
      navigateTo('sop');
      break;
    case 'admin':
      window.renderAdmin(mainViewport, state, navigateTo);
      break;
    case 'website':
      state.activeITSubTab = 'website';
      navigateTo('it');
      break;
    case 'external-links':
      window.renderExternalLinks(mainViewport, state, navigateTo);
      break;
    case 'reputation':
      state.activeMarketingSubTab = 'reputation';
      navigateTo('marketing');
      break;
      
    // Construction (Operations) subviews
    case 'ops-dashboard':
      state.activeOpsSubTab = 'ops-dashboard';
      navigateTo('ops');
      break;
    case 'ops-cubby':
      state.activeOpsSubTab = 'ops-cubby';
      navigateTo('ops');
      break;

    // Development subviews
    case 'dev-permits':
      state.activeDevelopmentSubTab = 'dev-permits';
      navigateTo('development');
      break;
    case 'dev-plans':
      state.activeDevelopmentSubTab = 'dev-plans';
      navigateTo('development');
      break;
    case 'dev-details':
      state.activeDevelopmentSubTab = 'dev-details';
      navigateTo('development');
      break;

    // Property Asset subviews
    case 'asset-portfolio':
      state.activePropertyAssetSubTab = 'asset-portfolio';
      navigateTo('property-asset');
      break;
    case 'asset-warranties':
      state.activePropertyAssetSubTab = 'asset-warranties';
      navigateTo('property-asset');
      break;
    case 'asset-plans':
      state.activePropertyAssetSubTab = 'asset-plans';
      navigateTo('property-asset');
      break;
    case 'asset-inspections':
      state.activePropertyAssetSubTab = 'asset-inspections';
      navigateTo('property-asset');
      break;

    // HR subviews
    case 'hr-ms':
      state.activeHRSubTab = 'hr-ms';
      navigateTo('hr');
      break;
    case 'hr-asana':
      state.activeHRSubTab = 'hr-asana';
      navigateTo('hr');
      break;
    case 'hr-disclosures':
      state.activeHRSubTab = 'hr-disclosures';
      navigateTo('hr');
      break;
    case 'hr-documents':
      state.activeHRSubTab = 'hr-documents';
      navigateTo('hr');
      break;

    // Investor Relations subviews
    case 'investor-dashboard':
      state.activeInvestorSubTab = 'investor-dashboard';
      navigateTo('investor-relations');
      break;
    case 'investor-reports':
      state.activeInvestorSubTab = 'investor-reports';
      navigateTo('investor-relations');
      break;

    // Marketing subviews
    case 'marketing-ads':
      state.activeMarketingSubTab = 'ads';
      navigateTo('marketing');
      break;
    case 'marketing-reputation':
      state.activeMarketingSubTab = 'reputation';
      navigateTo('marketing');
      break;

    // Accounting subviews
    case 'transactions':
    case 'invoices':
    case 'budgets':
    case 'imports':
    case 'ramp':
    case 'ama':
    case 'mre':
    case 'mri':
    case 'reports':
      state.activeAccountingSubTab = viewName;
      navigateTo('accounting');
      break;
      
    default:
      renderPlaceholderView(mainViewport, viewName);
  }

  // Close sidebar on mobile after navigation
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
}

// 4. Render Placeholder Application Sandbox for Non-Implemented Tabs
function renderPlaceholderView(container, viewName) {
  const formattedTitle = viewName
    .replace('-', ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  container.innerHTML = `
    <div style="max-width: 800px; margin: 60px auto; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 24px;">
      <div style="width: 80px; height: 80px; border-radius: 20px; background-color: hsla(var(--color-blue), 0.1); color: hsl(var(--color-blue)); display: flex; align-items: center; justify-content: center;">
        <i data-lucide="layers" style="width: 40px; height: 40px;"></i>
      </div>
      <div>
        <h2 style="font-size: 2rem; margin-bottom: 8px;">${formattedTitle} Sub-Application</h2>
        <p style="color: var(--text-secondary); max-width: 500px; margin: 0 auto;">
          This micro-application is registered in the Greens Nexus Master Portal. The sub-application's sandbox container is loaded and ready for integration.
        </p>
      </div>
      <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 24px; font-family: monospace; font-size: 0.85rem; color: var(--text-secondary); text-align: left; width: 100%;">
        <div style="display: flex; gap: 8px; margin-bottom: 6px;"><span style="color: hsl(var(--color-green))">&check;</span> Micro-App Handshake Established</div>
        <div style="display: flex; gap: 8px; margin-bottom: 6px;"><span style="color: hsl(var(--color-green))">&check;</span> Context tokens injected successfully</div>
        <div style="display: flex; gap: 8px;"><span style="color: hsl(var(--color-orange))">&bull;</span> Awaiting final UI build pipelines for production release...</div>
      </div>
      <button class="primary-btn" id="back-home-btn">
        <i data-lucide="arrow-left"></i> Return to Dashboard
      </button>
    </div>
  `;

  lucide.createIcons();

  document.getElementById('back-home-btn').addEventListener('click', () => {
    navigateTo('dashboard');
  });
}

// 5. Theme Toggling Logic
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const darkIcon = themeToggleBtn.querySelector('.theme-icon-dark');
  const lightIcon = themeToggleBtn.querySelector('.theme-icon-light');

  if (theme === 'dark') {
    darkIcon.style.display = 'none';
    lightIcon.style.display = 'block';
  } else {
    darkIcon.style.display = 'block';
    lightIcon.style.display = 'none';
  }
}

themeToggleBtn.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  state.theme = newTheme;
  localStorage.setItem('gg-theme', newTheme);
  applyTheme(newTheme);
});

// 6. Mobile Sidebar Responsive Controls
mobileToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('active');
});

sidebarOverlay.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
});

// 7. Click Handlers for Sidebar items
navItems.forEach(item => {
  if (item.classList.contains('has-submenu')) {
    const mainRow = item.querySelector('.nav-item-main');
    const toggleBtn = item.querySelector('.submenu-toggle-btn');
    const submenu = item.querySelector('.sidebar-submenu');

    mainRow.addEventListener('click', (e) => {
      // If toggle arrow clicked, expand/collapse list and sync chevron
      if (e.target.closest('.submenu-toggle-btn')) {
        e.stopPropagation();
        const isExpanded = submenu.style.display === 'flex';
        if (isExpanded) {
          submenu.style.display = 'none';
          item.classList.remove('submenu-open');
          toggleBtn.innerHTML = '<i data-lucide="chevron-down" style="width: 14px; height: 14px;"></i>';
        } else {
          submenu.style.display = 'flex';
          item.classList.add('submenu-open');
          toggleBtn.innerHTML = '<i data-lucide="chevron-up" style="width: 14px; height: 14px;"></i>';
        }
        lucide.createIcons();
        return;
      }

      // If clicked the rest of the main row, load default view
      const targetView = item.getAttribute('data-view');
      navigateTo(targetView);
    });

    // Wire up individual submenu item clicks
    const submenuItems = item.querySelectorAll('.submenu-item');
    const parentView = item.getAttribute('data-view');
    submenuItems.forEach(subItem => {
      subItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const subview = subItem.getAttribute('data-subview');
        if (parentView === 'it') {
          state.activeITSubTab = subview;
          navigateTo('it');
        } else if (parentView === 'sop') {
          state.activeSopSubTab = subview;
          navigateTo('sop');
        } else if (parentView === 'ops') {
          state.activeOpsSubTab = subview;
          navigateTo('ops');
        } else if (parentView === 'development') {
          state.activeDevelopmentSubTab = subview;
          navigateTo('development');
        } else if (parentView === 'property-asset') {
          state.activePropertyAssetSubTab = subview;
          navigateTo('property-asset');
        } else if (parentView === 'hr') {
          state.activeHRSubTab = subview;
          navigateTo('hr');
        } else if (parentView === 'investor-relations') {
          state.activeInvestorSubTab = subview;
          navigateTo('investor-relations');
        } else if (parentView === 'marketing') {
          state.activeMarketingSubTab = subview === 'marketing-ads' ? 'ads' : 'reputation';
          navigateTo('marketing');
        } else if (parentView === 'accounting') {
          state.activeAccountingSubTab = subview;
          navigateTo('accounting');
        }
      });
    });
  } else {
    // Standard navigation items
    item.addEventListener('click', () => {
      const targetView = item.getAttribute('data-view');
      navigateTo(targetView);
    });
  }
});

// 8. Application Startup
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme
  applyTheme(state.theme);
  
  // Navigate to initial view
  navigateTo('dashboard');
});
