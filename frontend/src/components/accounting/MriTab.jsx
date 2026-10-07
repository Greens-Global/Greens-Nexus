import LeasingTab from './LeasingTab';

// Accounting -> MRI, Monthly Recurring Income (Neil, call of 09/29: "Leasing
// is a placeholder - it should be MRI, covering leases and the interest and
// loan payments coming in"). MRE, the expense side, is a separate screen.
//
// Oct 7 (Charmi, item 54: "Don't need two different tabs here, just need
// filters. We are tracking any source of income that is coming in. This
// should be a type and a column and a filter."): the Leasing and Interest
// and Loan Payments tabs are gone. MRI is ONE list - every lease, every
// interest or loan payment kept here, and the interest and loan income
// accounts read from the ledger - with a Type column and a Type filter
// (LeasingTab). This file keeps the tab's name for the Accounting view.

export { isRecurringIncomeAccount } from './LeasingTab';

export default function MriTab({ canEdit = false, canDelete = false }) {
  return <LeasingTab canEdit={canEdit} canDelete={canDelete} />;
}
