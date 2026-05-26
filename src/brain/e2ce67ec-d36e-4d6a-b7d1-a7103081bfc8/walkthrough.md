# Greens Global Portal - Comprehensive Upgrades Walkthrough

We have successfully implemented the comprehensive portal upgrades requested by the boss. Below is the technical breakdown of the implemented features, files added/modified, and instructions on how to manually verify them in the portal.

---

## 1. Global Navigation & Collapsible Submenus (`index.html`, `app.js`)
- **Collapsible Sidebar Dropdowns**: Converted all new and expanded departments into collapsible dropdown menus inside `index.html`. All submenus use unified chevron-up/down icon triggers, active-subtab highlights, and vertical layouts matching the existing IT and SOP sections.
- **Auto-Expanding/Collapsing Router (`app.js`)**: Rewrote the sidebar navigation engine inside `navigateTo`. When navigating to a specific subtab, its parent sidebar folder automatically expands, flips its chevron up, highlights the active subtab, and collapses all other sidebar sections.
- **Registered Routes**: Added routing cases and initialized state values for all new subtabs.

---

## 2. New Integrated Departments

### Human Resources (`views/hr.js`)
- **Microsoft AD Onboarding (`hr-ms`)**: Displays new hires and AD account creation statuses. Clicking **"Push to Microsoft AD"** connects to a simulated MS Graph API, animates a loading spinner, provisions the account/mailbox, and updates its active telemetry status.
- **Asana Onboarding Checklist (`hr-asana`)**: Displays onboarding task items synced from Asana. Clicking **"Mark Complete"** updates the status in the local state, and clicking **"Sync with Asana API"** performs a simulated synchronization.
- **Zoning & Corporate Disclosures (`hr-disclosures`)**: Tracks signed NDA and Conflict of Interest disclosures. Clicking **"View"** loads the document from a simulated secure vault.
- **Documents Directory (`hr-documents`)**: Central storage containing handbooks, benefits guides, tax forms, and direct deposit forms with simulation download triggers.

### Property Asset Management (`views/propertyAsset.js`)
- **Property Portfolio (`asset-portfolio`)**: Renders cards for managed buildings detailing units, occupancy rates, value, and managers. Includes a fully functional **"Add Property Asset"** modal to register new property assets.
- **Equipment Warranties (`asset-warranties`)**: Database of warranties for major systems (HVAC, elevators, generators). Dynamically warns the user if a warranty is expiring within 45 days.
- **As-Built Plans (`asset-plans`)**: Document room for engineering drawing records. Supports simulated file downloads.
- **Annual Safety Inspections (`asset-inspections`)**: Compliance tracker for fire sprinklers, elevators, and backflow preventers. Clicking **"Record Compliance"** simulates conducting the inspection and automatically shifts the due date by one year.

### Investor Relations (`views/investorRelations.js`)
- **Investor Dashboard (`investor-dashboard`)**: Financial summary displaying overall invested capital, average returns, and distributions. Includes a custom project equity breakdown bar chart. Includes an active **"Approve Q2 Distributions"** trigger.
- **Reports Room (`investor-reports`)**: Searchable and downloadable catalog of financial prospectus documents, capital tax forms, and fund audit records.

---

## 3. Upgrades to Existing Departments

### Operations (Construction) (`views/operations.js`)
- **Cubby Secure Cloud Vault (`ops-cubby`)**: Replaces the static operations list with a secure plan room. Includes directory folder browsing (`Blueprints & CAD drawings`, `Subcontractor Bid logs`, `Site Safety Audits`, etc.), simulated DWG file downloads, and a functional **"Upload Plan"** feature to append drawings to the cloud folder.

### Development (`views/development.js`)
- **Projects Directory (`dev-projects`)**: Displays active construction developments (existing list).
- **Permit Status (`dev-permits`)**: Displays municipality permit submissions. Includes a **"Check Live Status"** button that queries municipal servers to approve pending variances.
- **Project Plans (`dev-plans`)**: Access blueprints grouped by active development sites.
- **Property Details (`dev-details`)**: Acquired land parcels directory detailing size, zoning codes, APNs, and surveyor reports.

### Marketing & Reputation (`views/marketing.js`)
- **Global Property Filter**: Added a Property Filter dropdown in the header. Selecting a property filters the campaigns table in Google Ads and reviews list in Reputation Management.
- **Recalculated KPIs**: recaclculates all KPI cards dynamically (Impressions, Clicks, Conversions, Spend, CAC, Conversion Rate, Review Rating, and Pending responses) on-the-fly depending on the selected property!

---

## 4. Bug Fixes & Horizontal Tab Navigation Alignment
- **Construction Tab Syntax Fix**: Corrected a trailing parenthesis syntax typo (`});` instead of `}`) at line 586 in `views/operations.js`. This resolves the script loading error and restores full rendering functionality to the "Construction" (Xonstruction) tab.
- **HR Horizontal Navigation (`views/hr.js`)**: Added a horizontal navigation tab bar at the top of the HR page with buttons for "Onboarding - MS", "Onboarding - Asana", "Disclosures", and "Documents".
- **Investor Relations Horizontal Navigation (`views/investorRelations.js`)**: Added a horizontal navigation tab bar at the top of the page with buttons for "Investor Dashboard" and "Reports".
- **Bi-directional Synchronization**: Integrated all horizontal tab actions across upgraded views (IT, Operations, Development, Asset Management, HR, Investor Relations, Marketing) with `navigateTo(...)`. Now, clicking a horizontal tab updates the highlighted vertical menu item, and clicking a vertical menu item updates the horizontal active tab state seamlessly.

---

## 5. Development Tab Cleanup & Purchase Requisition Enhancements
- **Development Tab Cleanup**: Removed the "Projects Directory" submenu/subtab from the Development section vertically in the sidebar (`index.html`) and horizontally inside the view (`views/development.js`). Updated routing and state configurations in `app.js` to fallback and default to "Permit Status" (`dev-permits`).
- **Purchase Requisition Upgrades**:
  - Replaced the "Item / Service Name" text field with a pre-configured `<select>` dropdown offering 18 specific hardware, software, security, and apparel options (Laptop, PC, Monitors, Speakers, Headset, Mouse, Keyboard, Battery Backup, Webcam, Safety Vest, Safety Helmet, Hand Tools, Power Tools, Nametag, Uniforms, Keys & Key Sets, Tablet, Phone).
  - Removed the "Proposed Vendor" input group and the "Unit Cost" input group to simplify the requisition flow.
  - Updated the submission handlers and log table row renderers in `views/purchase.js` to gracefully support zero cost and blank vendor inputs.

---

## Created & Modified Files

- [index.html](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/index.html) **[MODIFIED]**
- [app.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/app.js) **[MODIFIED]**
- [views/operations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/operations.js) **[MODIFIED]**
- [views/development.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/development.js) **[MODIFIED]**
- [views/marketing.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/marketing.js) **[MODIFIED]**
- [views/hr.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/hr.js) **[MODIFIED]**
- [views/propertyAsset.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/propertyAsset.js) **[MODIFIED]**
- [views/investorRelations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/investorRelations.js) **[MODIFIED]**
- [views/purchase.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/purchase.js) **[MODIFIED]**
- [task.md](file:///C:/Users/DELL/.gemini/antigravity/brain/e2ce67ec-d36e-4d6a-b7d1-a7103081bfc8/task.md) **[MODIFIED]**
- [views/accounting.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/accounting.js) **[MODIFIED]**
- [style.css](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/style.css) **[MODIFIED]**

---

## 6. Accounting Upgrades & Sidebar Dividers
- **MRE & MRI Integrations (`views/accounting.js`)**: Integrated MRE Real Estate Accounting and MRI Property Software import cards into the Financial Import Hub, allowing automated file parsing and importing logs to Sage Intacct with a real-time progress simulation.
- **Sidebar Grouped Separators (`index.html`, `style.css`)**: Implemented the precise 7-group department clustering layout using clean `.nav-divider` separator lines.
  - **Styling**: Configured with a subtle `#e5e7eb` color in light mode and `var(--border-color)` in dark mode.
  - **Spacing & Indent**: Styled with a balanced `16px` vertical margin and `12px` horizontal margin, ensuring they are inset from the sidebar bounds and do not touch the outer edges directly, providing a high-end enterprise aesthetic.

---

## Verification Guide

1. **Test Sidebar & Horizontal Sync**: Click **HR**. Observe that the horizontal navigation bar with 4 subtabs appears at the top. Click "Onboarding - Asana" on the horizontal bar and verify that the sidebar highlights "Onboarding - Asana". Click "Documents" in the sidebar and verify the horizontal bar shifts to "Documents".
2. **Verify Construction Tab**: Click the **Construction** tab. Verify that the dashboard loads fully without breaking. Click between "Project Dashboard" and "Cubby Integration" horizontally and verify synchronization with the sidebar.
3. **Verify Development Tab Cleanup**: Click **Development**. Verify that "Projects Directory" is completely gone from both the vertical sidebar navigation and the horizontal page tab bar, and the view defaults directly to "Permit Status".
4. **Verify Purchase Requisitions**: Click **Purchase Requisition**. Submit a new requisition:
   - Select an item from the new "Item Selection" dropdown (e.g. Laptop).
   - Enter a Quantity (e.g. 5) and choose a department.
   - Click **Submit Requisition**.
   - Verify that the item is appended to the log table on the right with a total cost of `—` (representing zero cost), no vendor name, and the status set to `pending`. Verify that old requisitions still show their total costs and vendors correctly.
5. **Verify Accounting Import Hub**: Click **Accounting**, select **Import Hub** from the tabs. Verify two new cards for "MRE Real Estate" and "MRI Property Software" are rendered with dynamic icons. Click "Drag file or Click to Browse" on either card and verify that the progress bar animates to 100% and successfully posts a simulated transaction sync log to the Recent Transactions tab.
6. **Verify Sidebar Dividers Styling**: Toggle between Light and Dark themes in the top-right corner. Verify that the separator divider lines match the current theme color scheme and line up correctly with the sidebar items.
