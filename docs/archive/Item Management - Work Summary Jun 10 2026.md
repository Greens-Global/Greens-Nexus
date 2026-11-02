# Item Management — Work Summary
**Date:** June 10, 2026  
**Branch:** dev  
**Commit:** b14f6ca

---

## Notification & Approval Fixes

### Checkout Pending Bell Approval (checkout_pending)
- Approve/Reject from the notification bell was broken for checkout requests — the approval UI only rendered for `inv_request` type. Fixed by including `checkout_pending` in the condition.
- Cart order approvals were sending the `order_id` as the `checkout_id` to the backend, causing 404s. Fixed by finding all pending checkouts sharing the same `orderId` and approving each individually.
- Cart rejections had the same wrong-ID bug — fixed the same way.

### Allocator Notification
- When a checkout was approved, the assigned allocator was never notified. Fixed by sending an `allocate_request` notification to the allocator's email on approval.

### Stale "Needs Action" Cards
- `checkout_pending` notifications were not being marked as actioned after the checkout was resolved. Fixed by auto-marking the notification actioned whenever a checkout status changes to approved, rejected, or cancelled.

### Item Returned Broadcast Bug
- Employees were receiving toast notifications for other people's item returns. Root cause: when `assigned_allocator_email` was empty, the backend sent a broadcast (`recipient = ""`). Fixed at three layers:
  - Backend: skip the `item_returned` notification entirely if no allocator is assigned
  - Toast: guard so broadcast `item_returned` only shows for managers
  - Bell: filter out broadcast `item_returned` for non-managers

---

## Employee "My Checkouts" — Rejected Item Flow

**Before:** Rejected items went straight to Past Checkouts with no explanation or recourse.

**After:**
- Rejected items now stay in **Active Checkouts** until the employee takes action
- Each rejected item shows the rejection reason (from the manager)
- Two action buttons appear:
  - **Request Again** — opens an inline form to enter a new comment, then re-submits a fresh checkout request for the same item
  - **Discard** — moves the item to Past Checkouts
- **Past Checkouts** now shows the rejection reason next to each rejected entry

---

## Cart Error Toast Formatting

**Before:** When multiple cart items failed to submit, the error appeared as a single run-on sentence:
> "Backhoe Loader" already has an active checkout request · "Dell Monitor 27"" already has an active checkout request · "Extension Ladder" already has an active…

**After:** Clean formatted toast with:
- Header: "X items couldn't be submitted"
- Bulleted list of item names
- Footer line (if all failures are the same type): "Each already has an active checkout request."

---

## Manager Checkouts Tab

### Completed Tab — Activity Summary
Each completed order now shows a human-readable summary in the order header:

> *Pranshu Pandey checked out 3 items on 06/09/2026 at 4:11 PM and returned them to Sahil Desai on 06/10/2026 at 2:30 PM for a total of 2 days and 3 hours.*

Handles all completion states:
- Returned: full checkout-to-return narrative with duration
- Rejected: "requested X on [date] — request was rejected (reason)"
- Cancelled: "cancelled their request for X on [date]"

### Search Bar
Widened from a fixed 220px to `flex: 1, max-width: 480px` so it fills the available tab strip space — search is the primary function.

### Stats Tiles (Available / Total Items / Checked Out / Missing Photos)
Previously showed on every tab including Checkouts, My Items, and Audit Log where they add no value. Now only visible on **Catalog** and **Manage** tabs.

---

## Audit Log — Plain English Details

**Before:** Details column showed raw JSON:
```
{"path": "/items/checkouts", "status": 201, "item_type": "Vehicles", "department": "Operations", "item_name": "Isuzu Box Truck", "reason": "Test", "days": 1, "requested_by": "..."}
```

**After:** Readable sentence per action type:
| Action | Formatted Output |
|--------|-----------------|
| Checked out item | `Isuzu Box Truck (Vehicles) for 1 day — "Test" [Operations]` |
| Deleted item cart | `Removed item from cart` |
| Approved | `MacBook Pro 14" → assigned to Sahil Desai` |
| Rejected | `Dell Monitor — Reason: "Not available for personal use"` |
| Returned | `Extension Ladder returned` |

Unknown action types fall back to key: value pairs (path and status are always hidden).

---

## Global Search (TopHeader)

The "Search Nexus…" bar in the top header was a static input with no functionality.

**Now:** Full navigation search —
- Type any module name (e.g. "inventory", "IT", "accounting") to get instant results
- Results respect your role and group access — restricted modules you can't access don't appear
- Click a result or press **Enter** to navigate
- Press **Escape** to clear
- First result is highlighted; keyboard-first design

---

## Admin Panel — Z#Inactive Display Names

Azure AD marks deactivated accounts with a "Z #Inactive" prefix in their display name. This prefix was leaking into the admin user list.

**Fix:** `cleanName()` is now applied in `Admin.jsx` to both sources:
- Users fetched from Microsoft Graph (`fromGraph`)
- Manually added users (`fromManual`)

The `cleanName` regex strips any variation of `Z #Inactive` / `Z#Inactive` (case-insensitive) from the start of a display name. The "Z#" avatar initials in the user card are also gone as a result.

---

## Access Architecture

### Group-Granted Modules Not Showing in Sidebar
Groups were only loaded when the Admin page mounted. Non-admin users who visited the admin page had their group grants loaded; everyone else did not. Fixed by loading groups in `RoleContext` on mount for **all users** — this is where `myGrantedModules` is computed.

### GET /groups 401 for Non-Admins
The `GET /groups` endpoint required administrator role, so the new on-mount call was failing for all non-admin users. Fixed with role-aware response:
- Administrators (level ≥ 4): receive all groups (for Access Manager management)
- Everyone else: receives only the groups they belong to (enough to compute `myGrantedModules`)

### Strict Access Guard (ProtectedView)
The old `renderView()` function sat outside the `RoleProvider` so it couldn't call `useRole()`. Any user could navigate to restricted views via browser devtools or the `nexus:navigate` event.

Fixed with a `ProtectedView` component that lives inside the provider tree:
- Access granted if: no restriction, OR role meets minimum, OR a Group explicitly grants that module
- Groups can grant **supervisor-level** screens but can never grant admin/owner screens (those require actual role level)
- Even if navigate is triggered externally, the view content never renders without valid access

### Purchase Requisition Removed from Sidebar
Merged into Item Management. Removed from `NAV` array, `MODULES`, and `VIEW_MIN_ROLES`.

---

## Files Changed

| File | Changes |
|------|---------|
| `frontend/src/views/InventoryManagement.jsx` | Rejected item flow, activity summary, audit log formatting, stats tile condition, search bar width, cart error toast, Re-Request feature |
| `frontend/src/components/TopHeader.jsx` | Global search implementation |
| `frontend/src/views/Admin.jsx` | cleanName import + applied to displayUsers |
| `frontend/src/components/NotificationBell.jsx` | checkout_pending approval, cart order fix, item_returned broadcast guard |
| `frontend/src/components/NotificationToasts.jsx` | checkout_pending actionable, item_returned manager-only guard |
| `frontend/src/contexts/RoleContext.jsx` | Groups loaded on mount for all users, Purchase Requisition removed from MODULES |
| `frontend/src/components/Sidebar.jsx` | Purchase Requisition removed from NAV |
| `frontend/src/App.jsx` | ProtectedView component, VIEW_MIN_ROLES map |
| `backend/routers/items.py` | allocate_request notification, auto-mark checkout_pending actioned, item_returned allocator-only fix |
| `backend/routers/groups.py` | GET /groups role-aware response (non-admins get own groups only) |
