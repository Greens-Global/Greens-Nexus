# Execution Checklist - Greens Global Portal Upgrades

We will track the implementation of the new sections and tabs in the portal as detailed in the approved implementation plan.

---

## 1. Global Layout & Routing Configuration
- [x] Restructure sidebar navigation to support collapsible submenus for all new/modified sections (`index.html`)
  - [x] Construction / Operations dropdown subtabs
  - [x] Development dropdown subtabs
  - [x] Asset Management dropdown subtabs
  - [x] HR dropdown subtabs
  - [x] Investor Relations dropdown subtabs
- [x] Initialize state datasets, navigation switch cases, and auto-expanding menu handlers (`app.js`)
  - [x] Add seed data arrays for onboarding, permits, warranties, inspections, investor portfolios
  - [x] Connect submenu click events and write navigation router logic
  - [x] Add route switch cases for all subviews

---

## 2. New Views Creation
- [x] Build HR operations dashboard (`views/hr.js`)
  - [x] Microsoft AD Account provisioning view & simulation
  - [x] Asana Onboarding Checklist integrations
  - [x] Legal disclosures & NDA signings log
  - [x] HR documents vault
- [x] Build Property Asset Management dashboard (`views/propertyAsset.js`)
  - [x] Property Portfolio specs
  - [x] Mechanical/HVAC Equipment Warranties log
  - [x] As-Built final CAD designs vault
  - [x] Annual Inspections & Certifications table
- [x] Build Investor Relations dashboard (`views/investorRelations.js`)
  - [x] Investor dashboard with equity distributions, funding rounds, KPIs
  - [x] Investor reports & financial prospectus downloads

---

## 3. Existing Views Upgrades
- [x] Expand Operations View with Cubby Integration (`views/operations.js`)
  - [x] Folder explorer browser simulation
  - [x] Vault sync status logs
  - [x] Add/upload drawings simulation
- [x] Expand Development View (`views/development.js`)
  - [x] Project Directory (existing)
  - [x] Permit Status table & submissions tracker
  - [x] Design plans & MEP blueprints by project
  - [x] Property acquisition specs
- [x] Upgrade Marketing & Reputation View with Property Filter (`views/marketing.js`)
  - [x] Add Property Filter dropdown selector in the header
  - [x] Filter Google Ads campaigns table & recalculate KPIs dynamically
  - [x] Filter Google Reviews feed & recalculate reviews KPIs dynamically

---

## 4. Bug Fixes & Horizontal Tab Navigation Alignment
- [x] Fix syntax error in `views/operations.js` to restore Construction tab rendering
- [x] Add horizontal tab bar `.hr-tabs-nav` to HR view (`views/hr.js`) and wire click listeners
- [x] Add horizontal tab bar `.investor-tabs-nav` to Investor Relations view (`views/investorRelations.js`) and wire click listeners
- [x] Verify vertical-horizontal tab synchronization for all upgraded department pages

---

## 5. Development Tab Cleanup & Purchase Requisition Enhancements
- [x] Remove Projects Directory from Development tab in sidebar (`index.html`)
- [x] Update default Development tab to Permit Status in routing/state (`app.js`)
- [x] Remove Projects Directory subtab from horizontal tab bar and rendering (`views/development.js`)
- [x] Update Purchase Requisition form to use dropdown for Item selection and remove Proposed Vendor & Unit Cost inputs (`views/purchase.js`)
- [x] Update Purchase Requisition submit handler and table renderer for zero cost / empty vendor (`views/purchase.js`)

---

## 6. Accounting Upgrades & Sidebar Dividers
- [x] Restructure and reorder sidebar navigation into 7 grouped sections (`index.html`)
- [x] Convert Accounting into a collapsible menu with all 9 subtabs (`index.html`, `app.js`)
- [x] Implement MRE and MRI subtabs vertically in sidebar and horizontally on page (`views/accounting.js`, `app.js`)
- [x] Add styled, elegant subtle gray group separators between sections (`style.css`)



