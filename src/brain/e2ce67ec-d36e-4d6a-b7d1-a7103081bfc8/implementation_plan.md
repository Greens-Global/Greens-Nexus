# Implementation Plan - Portal Upgrades & Department Integrations

We will perform comprehensive portal upgrades to introduce new departments (Investor Relations, Asset Management, HR) and expand existing ones (Operations, Development, Marketing & Reputation) to match feedback from the client's boss.

---

## Proposed Changes

### 1. Global Navigation & Routing Restructuring

#### [MODIFY] [index.html](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/index.html)
- Add new sidebar submenus for:
  - **Construction/Operations** (`data-view="ops"`):
    - Project Dashboard (`ops-dashboard`)
    - Cubby Integration (`ops-cubby`)
  - **Development** (`data-view="development"`):
    - Projects Directory (`dev-projects`)
    - Permit Status (`dev-permits`)
    - Project Plans (`dev-plans`)
    - Property Details (`dev-details`)
  - **Asset Management** (`data-view="property-asset"`):
    - Property Portfolio (`asset-portfolio`)
    - Equipment Warranties (`asset-warranties`)
    - As-Built Plans (`asset-plans`)
    - Annual Inspections (`asset-inspections`)
  - **HR** (`data-view="hr"`):
    - Onboarding - MS (`hr-ms`)
    - Onboarding - Asana (`hr-asana`)
    - Disclosures Log (`hr-disclosures`)
    - Documents (`hr-documents`)
  - **Investor Relations** (`data-view="investor-relations"`):
    - Investor Dashboard (`investor-dashboard`)
    - Reports (`investor-reports`)
- Keep scripts references for all view controllers at the bottom of the page, registering new files:
  - `views/hr.js`
  - `views/propertyAsset.js`
  - `views/investorRelations.js`

#### [MODIFY] [app.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/app.js)
- Extend `state` to include new datasets:
  - `state.activeOpsSubTab = 'ops-dashboard'`
  - `state.activeDevelopmentSubTab = 'dev-projects'` (changing default state name or mapping)
  - `state.activePropertyAssetSubTab = 'asset-portfolio'`
  - `state.activeHRSubTab = 'hr-ms'`
  - `state.activeInvestorSubTab = 'investor-dashboard'`
  - `state.marketingPropertyFilter = 'all'` (for the new property filtering)
  - HR onboarding tracking tables (Azure AD account status, outlook configuration, laptop tracking, and Asana checklist integration).
  - Permit tracking status records (tracking ID, project, city, status, submission date, permit type).
  - Blueprints, warranties, and annual building safety records data.
  - Equity funding lists and investor reports catalogs.
- Update `navigateTo(viewName)` to handle new routes and expand the corresponding submenu while collapsing all others.
- Update the sidebar submenu click handlers in the startup block to support all collapsible sections.

---

### 2. New Views & Bug Fixes Implementation

#### [MODIFY] [views/operations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/operations.js)
- **Fix syntax error**: Correct line 586 from `});` to `}`. This resolves the parsing exception that prevents the "Construction Overview" (Xonstruction) tab from loading/rendering.
- Ensure horizontal tab styling matches other views.

#### [MODIFY] [views/hr.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/hr.js)
- **Add horizontal navigation**: Inject the `.hr-tabs-nav` header at the top of the main viewport inside `renderHR`.
- **Add buttons**: "Onboarding - MS" (leads to `hr-ms`), "Onboarding - Asana" (`hr-asana`), "Disclosures" (`hr-disclosures`), "Documents" (`hr-documents`).
- **Wire event handlers**: Attach click listeners that set `state.activeHRSubTab = target` and call `navigateTo('hr')` to sync with the sidebar submenu.
- **Add styling**: Inject CSS styles inside the scoped stylesheet element for `.hr-tabs-nav` and `.hr-tab-btn`.

#### [MODIFY] [views/investorRelations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/investorRelations.js)
- **Add horizontal navigation**: Inject the `.investor-tabs-nav` header at the top of the main viewport inside `renderInvestorRelations`.
- **Add buttons**: "Investor Dashboard" (leads to `investor-dashboard`), "Reports" (`investor-reports`).
- **Wire event handlers**: Attach click listeners that set `state.activeInvestorSubTab = target` and call `navigateTo('investor-relations')` to sync with the sidebar submenu.
- **Add styling**: Inject CSS styles inside the scoped stylesheet element for `.investor-tabs-nav` and `.investor-tab-btn`.

#### [NEW] [propertyAsset.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/propertyAsset.js)
- Build the Property Asset Management view supporting four subtabs:
  - **Property Portfolio**: Detailed inventory card list of commercial, residential, and mixed-use real estate assets currently managed (e.g. Harbor View Condos, Downtown Complex), displaying acreage, purchase details, occupancy rates, and local managers.
  - **Equipment Warranties**: Database tracker for building systems (HVAC, fire pump generators, elevators, roofing). Tracks vendor contact, warranty start/expiration dates, and provides a warning label for items expiring soon.
  - **As-Built Plans**: Central plan room for architectural, structural, and mechanical drawings (final CAD files) for post-construction inspections.
  - **Annual Inspections**: Status dashboard showing fire alarm inspections, structural audits, backflow tests, elevator certifications, and next safety inspection schedules.

#### [NEW] [investorRelations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/investorRelations.js)
- Build the Investor Relations view supporting two subtabs:
  - **Investor Dashboard**: Financial summary displaying total invested equity, average investor ROI performance, number of active investors, and recent deposit entries. Contains project-wise equity breakdown charts (styled using semantic HTML grids and progress bars).
  - **Reports**: Catalogs containing investor prospectuses, Q1/Q2 financial audits, K-1 tax forms, and annual investor letters. Supports text search and download simulations.

---

### 3. Existing Views Upgrades

#### [MODIFY] [views/operations.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/operations.js)
- Update to support two sub-views:
  - **Project Dashboard**: The existing active projects, logistics, and heavy equipment tracking interface.
  - **Cubby Integration**: Vault telemetry card (Sync status: Connected, Vault capacity: 42%, cloud nodes). Directory browser structure listing engineering files, blueprints, and subcontracting bids. Includes interactive "Sync Vault", "Upload Drawing", and "Download file" simulated operations.

#### [MODIFY] [index.html](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/index.html)
- Remove the "Projects Directory" (`data-subview="dev-projects"`) vertical submenu item from the sidebar navigation.

#### [MODIFY] [app.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/app.js)
- Change default active subtab `activeDevelopmentSubTab` in initial state from `'dev-projects'` to `'dev-permits'`.
- Remove `case 'dev-projects'` from `navigateTo('development')` routing block.
- Fallback subtab for Development submenu auto-expand should be `'dev-permits'` instead of `'dev-projects'`.

#### [MODIFY] [views/development.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/development.js)
- Remove **Projects Directory** tab option horizontally and vertically.
- Default to `dev-permits` if `activeSubTab` is not set or equals `dev-projects`.
- Render only three subtabs horizontally: Permit Status, Project Plans, Property Details.
- Remove `renderDevProjectsTab` and `attachDevProjectsHandlers` functions.

#### [MODIFY] [views/purchase.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/purchase.js)
- Replace "Item / Service Name" text input with a `<select id="req-item" ...>` dropdown featuring: Laptop, PC, Monitors, Speakers, Headset, Mouse, Keyboard, Battery Backup, Webcam, Safety Vest, Safety Helmet, Hand Tools, Power Tools, Nametag, Uniforms, Keys & Key Sets, Tablet, Phone.
- Remove "Proposed Vendor" and "Unit Cost ($)" form groups from the submitting layout.
- Update submission handlers to use `vendor: ''` and `cost: 0` for newly created logs.
- Update table renderer to render `—` if cost is zero or empty.

#### [MODIFY] [views/marketing.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/marketing.js)
- Introduce a global **Property Filter dropdown** in the header of the Marketing & Reputation view.
- Filter the campaign listings table and Google Ads statistics (Impressions, Clicks, Conversions, Spend, and CAC) dynamically based on the selected property. Recalculate KPIs on-the-fly!
- Filter Google Reviews list and Reputation stats (Average Rating, Pending Responses count, Positive % score) based on the selected property.

#### [MODIFY] [views/accounting.js](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/views/accounting.js)
- In the Financial Import Hub subtab (`tabName === 'imports'`), add two new integration cards: **MRE Real Estate Accounting** and **MRI Property Software**.
- Configure uploader trigger elements for these new platforms so they simulate standard syncing logs.
- Adjust the grid columns template to utilize `repeat(auto-fill, minmax(280px, 1fr))` for a clean layout.

#### [MODIFY] [index.html](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/index.html)
- Add divider elements (`<li class="nav-divider"></li>`) between all major department navigation items in the sidebar.
- Add `<div class="nav-header-divider"></div>` below the "NAVIGATION" section title.

#### [MODIFY] [style.css](file:///C:/Users/DELL/.gemini/antigravity/scratch/master-construction-portal/style.css)
- Add CSS styling selectors for `.nav-divider` and `.nav-header-divider` to specify soft separators with low opacity (`var(--border-color)` with `opacity: 0.6` or similar) and appropriate spacing.

---

## Verification Plan

### Automated/Console Tests
- Verify that no Javascript runtime errors occur during navigation or filtering.
- Ensure responsive CSS styling wraps cards and grid rows properly for desktop, tablet, and mobile views.

### Manual Verification
1. **Sidebar Navigation**: Click every sidebar submenu option (IT, Operations, Development, Asset Mgmt, HR, Investor Relations) to verify it expands correctly, transitions the content view, highlight states match, and others collapse gracefully.
2. **Horizontal Tabs Synchronization**: Click horizontal subtabs (e.g. "Onboarding - Asana" in HR) and confirm that the sidebar submenu updates its highlighted active subtab. Click vertical submenu items (e.g. "Documents" in HR) and confirm that the horizontal tab updates its active highlight styling.
3. **Operations - Construction Tab**: Verify the Construction view renders without breaking, and you can switch between "Project Dashboard" and "Cubby Integration" horizontally.
4. **Investor Portal & HR Portal**: Verify they display the new horizontal tab bar at the top of their page.

