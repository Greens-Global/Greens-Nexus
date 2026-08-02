import { useState, useEffect } from 'react';
import { SkeletonBlocks } from '../components/AsyncState';
import { TrendingUp, TrendingDown, DollarSign, FileText, ArrowUpRight, ArrowDownRight, CreditCard, SlidersHorizontal, Download, Plus, X, UploadCloud, PiggyBank, Loader2, Check, Wallet, ClipboardList, Receipt, Plane, FileCheck, Landmark, BookOpen, Building2, Briefcase, RefreshCcw, LayoutGrid, Map, Layers, FileSignature, Users, Plug, Gift, Settings, Search, Columns3, CalendarDays, Ban, Lock } from 'lucide-react';
import { api } from '../api';
import ModuleTabs from '../components/ModuleTabs';

const INIT_TRX = [
  { id: 'TRX-1234', title: 'Project Payment - Downtown Complex', date: 'May 20, 2026', cost: 125000 },
  { id: 'TRX-1235', title: 'Construction Materials', date: 'May 19, 2026', cost: -45200 },
  { id: 'TRX-1236', title: 'Contractor Payment', date: 'May 18, 2026', cost: -67500 },
  { id: 'TRX-1237', title: 'Property Sale Commission', date: 'May 17, 2026', cost: 89000 },
  { id: 'TRX-1238', title: 'Office Rent', date: 'May 16, 2026', cost: -12000 },
];

const INIT_BUDGETS = [
  { id: 1, name: 'Real Estate Development', allocated: 3500000, spent: 2450000 },
  { id: 2, name: 'Operations (OPS)', allocated: 2000000, spent: 1900000 },
  { id: 3, name: 'IT & Infrastructure Support', allocated: 450000, spent: 180000 },
];

const AMA_ENTITIES = [
  { id: 1, entity: 'Greens Nexus LLC', status: 'Active', feeRate: 3.5, billedYTD: 142000, nextBilling: '2026-06-01' },
  { id: 2, entity: 'GN Construction Co', status: 'Active', feeRate: 4.0, billedYTD: 98000, nextBilling: '2026-06-01' },
  { id: 3, entity: 'Greens Real Estate Dev Ltd', status: 'Pending Review', feeRate: 3.0, billedYTD: 0, nextBilling: 'TBD' },
  { id: 4, entity: 'Global Property Management Inc', status: 'Active', feeRate: 2.5, billedYTD: 45000, nextBilling: '2026-06-15' },
];

const VENDORS = [
  { name: "Cascade Concrete Co.",    trade: "Concrete",    w9: "On file", coi: "2026-09-14", is1099: true,  gl: "5100 · Site Work",         pos: 7, active: true  },
  { name: "Northwest Roll-Up Doors", trade: "Roll-up Doors",w9:"On file", coi: "2026-06-02", is1099: true,  gl: "5220 · Doors & Hardware",  pos: 4, active: true  },
  { name: "Ironline Fencing",        trade: "Fencing",     w9: "Pending", coi: "2026-05-30", is1099: true,  gl: "5140 · Perimeter",         pos: 2, active: true  },
  { name: "Summit Paving LLC",       trade: "Paving",      w9: "On file", coi: "2026-04-18", is1099: true,  gl: "5160 · Asphalt",           pos: 5, active: true  },
  { name: "SecureTech Systems",      trade: "Security",    w9: "On file", coi: "2027-01-22", is1099: false, gl: "5400 · Access Control",    pos: 3, active: true  },
  { name: "Evergreen Electrical",    trade: "Electrical",  w9: "Expired", coi: "2026-03-01", is1099: true,  gl: "5300 · MEP",               pos: 6, active: false },
];

const AMA_FLAGGED = [
  { id: "T-4821", date: "2026-05-22", vendor: "Home Depot #4412",  amount: 1284.55, coder: "R. Okafor", q: "Materials for Lakeline gate repair - which job?", days: 4,  status: "Open"      },
  { id: "T-4806", date: "2026-05-20", vendor: "Shell Fleet",       amount: 96.20,   coder: "M. Lind",   q: "Fuel - Construction truck or Ops van?",          days: 6,  status: "In Review" },
  { id: "T-4790", date: "2026-05-18", vendor: "Amazon Business",   amount: 442.10,  coder: "S. Patel",  q: "Office supplies vs. facility supplies split?",   days: 8,  status: "Open"      },
  { id: "T-4775", date: "2026-05-15", vendor: "Grainger",          amount: 2110.00, coder: "R. Okafor", q: "HVAC parts - capitalize or expense?",            days: 11, status: "Open"      },
];

const TABS = ['transactions', 'invoices', 'budgets', 'imports', 'ramp', 'vendors', 'ask-accountant', 'ama', 'mre', 'mri', 'reports'];
const TAB_LABELS = { transactions: 'Transactions', invoices: 'Invoices', budgets: 'Budgets', imports: 'Import Hub', ramp: 'Ramp Cards', vendors: 'Vendors', 'ask-accountant': 'Ask My Accountant', ama: 'AMA Entities', mre: 'MRE', mri: 'MRI', reports: 'Reports' };

// Ramp's own left-nav sections. Funds/Cards/Requests/Budgets live together
// under Ramp's "Manage spend" group, so that group becomes one entry in our
// top-level sub-tab strip (rendered in-page rather than a sidebar - matches
// the Marketing module's SEO sub-tabs pattern - since it's nested inside our
// own Accounting sidebar entry); picking it reveals a segmented control for
// the 4 grouped sections. Only "Cards" is wired to real data so far.
const RAMP_SPEND_SECTIONS = [
  { key: 'funds', label: 'Funds', Icon: Wallet },
  { key: 'cards', label: 'Cards', Icon: CreditCard },
  { key: 'requests', label: 'Requests', Icon: ClipboardList },
  { key: 'budgets', label: 'Budgets', Icon: SlidersHorizontal },
];

const RAMP_TOP_SECTIONS = [
  { key: 'manage-spend', label: 'Manage Spend', Icon: CreditCard },
  { key: 'expenses', label: 'Expenses', Icon: Receipt },
  { key: 'travel', label: 'Travel', Icon: Plane },
  { key: 'bill-pay', label: 'Bill Pay', Icon: FileCheck },
  { key: 'banking', label: 'Banking', Icon: Landmark },
  { key: 'accounting', label: 'Accounting', Icon: BookOpen },
  { key: 'vendors', label: 'Vendors', Icon: Building2 },
  { key: 'company', label: 'Company', Icon: Briefcase },
];

// Ramp's "Expenses" group splits into card-sourced vs. out-of-pocket spend.
const RAMP_EXPENSE_SECTIONS = [
  { key: 'card-transactions', label: 'Card transactions', Icon: CreditCard },
  { key: 'reimbursements', label: 'Reimbursements', Icon: RefreshCcw },
];

// Ramp's "Travel" group splits into the spend summary vs. trip booking/mgmt.
const RAMP_TRAVEL_SECTIONS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'trip-management', label: 'Trip management', Icon: Map },
];

// Ramp's "Accounting" group (GL sync side of things) - Stack is Ramp's newer
// rules-based coding feature, flagged "New" the same way Ramp does.
const RAMP_ACCOUNTING_SECTIONS = [
  { key: 'card-transactions', label: 'Card transactions', Icon: CreditCard },
  { key: 'stack', label: 'Stack', Icon: Layers, badge: 'New' },
];

// Ramp's "Vendors" group splits into the vendor list vs. contract lifecycle.
const RAMP_VENDOR_SECTIONS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'contracts-renewals', label: 'Contracts & renewals', Icon: FileSignature },
];

// Ramp's "Company" group - org-wide settings, not spend workflows.
const RAMP_COMPANY_SECTIONS = [
  { key: 'people', label: 'People', Icon: Users },
  { key: 'statements-payments', label: 'Statements & payments', Icon: FileText },
  { key: 'integrations', label: 'Integrations', Icon: Plug },
  { key: 'rewards', label: 'Rewards', Icon: Gift },
  { key: 'settings', label: 'Settings', Icon: Settings },
];

const fmt = (n) => Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtUsd = (n) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

// Ramp's Funds column picker - order and default on/off state match Ramp's
// own "manage columns" panel (Name is pinned, Submission/Expense approval
// policy start hidden). Sample rows are fictional - deliberately NOT the
// real names/amounts from a live Ramp screenshot, to avoid committing real
// employee financial data into source control.
const FUNDS_COLUMNS = [
  { key: 'name', label: 'Name', locked: true },
  { key: 'owner', label: 'Owner' },
  { key: 'amountIssued', label: 'Amount issued' },
  { key: 'amountUsed', label: 'Amount used' },
  { key: 'utilization', label: 'Utilization' },
  { key: 'lastUsed', label: 'Last used' },
  { key: 'paymentMethods', label: 'Payment methods' },
  { key: 'spendProgram', label: 'Spend program' },
  { key: 'department', label: 'Department' },
  { key: 'location', label: 'Location' },
  { key: 'createdAt', label: 'Created at' },
  { key: 'lockReason', label: 'Lock reason' },
  { key: 'submissionPolicy', label: 'Submission policy', offByDefault: true },
  { key: 'expenseApprovalPolicy', label: 'Expense approval policy', offByDefault: true },
  { key: 'startDate', label: 'Start date' },
  { key: 'autoLockDate', label: 'Auto-lock date' },
];
const DEFAULT_FUNDS_COLUMN_STATE = Object.fromEntries(FUNDS_COLUMNS.map(c => [c.key, !c.offByDefault]));
const FUNDS_NUMERIC_COLUMNS = new Set(['amountIssued', 'amountUsed', 'utilization']);

const FUNDS_DATA = {
  issued: [
    { id: 1, name: 'T. Alvarez', owner: 'T. Alvarez', frequency: 'Monthly', issued: 600, used: 90, lastUsed: '2026-07-05', methods: ['Virtual card'], program: 'Field Supplies', department: 'Construction', location: 'Austin, TX', createdAt: '2025-11-02', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2025-11-02', autoLockDate: '-' },
    { id: 2, name: 'J. Reyes', owner: 'J. Reyes', frequency: 'Monthly', issued: 750, used: 0, lastUsed: '2026-01-24', methods: ['Virtual card'], program: 'Field Supplies', department: 'Construction', location: 'Dallas, TX', createdAt: '2025-09-18', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2025-09-18', autoLockDate: '-' },
    { id: 3, name: 'Facilities Expenses', owner: 'K. Whitfield', frequency: 'Monthly', issued: 2500, used: 0, lastUsed: '2026-05-30', methods: ['Virtual card'], program: 'Facilities Ops', department: 'Facilities', location: 'Denver, CO', createdAt: '2025-08-01', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Director approval', startDate: '2025-08-01', autoLockDate: '-' },
    { id: 4, name: 'D. Sato', owner: 'D. Sato', frequency: 'Monthly', issued: 220000, used: 6200, lastUsed: '2026-07-24', methods: ['Virtual card', 'Reimbursements'], program: 'Executive', department: 'Executive', location: 'Remote', createdAt: '2024-03-10', lockReason: '-', submissionPolicy: 'Executive', expenseApprovalPolicy: 'Board approval', startDate: '2024-03-10', autoLockDate: '-' },
    { id: 5, name: 'N. Brantley', owner: 'N. Brantley', frequency: 'Monthly', issued: 240000, used: 0, lastUsed: '2025-06-24', methods: ['Virtual card', 'Reimbursements'], program: 'Real Estate Development', department: 'Real Estate Development', location: 'Austin, TX', createdAt: '2024-06-24', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Director approval', startDate: '2024-06-24', autoLockDate: '-' },
    { id: 6, name: 'N. Brantley', owner: 'N. Brantley', frequency: 'Monthly', issued: 95000, used: 19800, lastUsed: '2026-07-26', methods: ['Virtual card', 'Reimbursements'], program: 'Real Estate Development', department: 'Real Estate Development', location: 'Austin, TX', createdAt: '2025-07-26', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Director approval', startDate: '2025-07-26', autoLockDate: '-' },
    { id: 7, name: 'R. Okafor', owner: 'R. Okafor', frequency: 'Monthly', issued: 210000, used: 1350, lastUsed: '2026-07-26', methods: ['Virtual card', 'Reimbursements'], program: 'Operations (OPS)', department: 'Operations (OPS)', location: 'Dallas, TX', createdAt: '2024-07-26', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2024-07-26', autoLockDate: '-' },
    { id: 8, name: 'M. Lind', owner: 'M. Lind', frequency: 'Monthly', issued: 15000, used: 0, lastUsed: '2026-01-29', methods: ['Virtual card', 'Reimbursements'], program: 'IT & Infrastructure Support', department: 'IT & Infrastructure', location: 'Remote', createdAt: '2025-01-29', lockReason: '-', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2025-01-29', autoLockDate: '-' },
  ],
  terminated: [
    { id: 101, name: 'A. Whitmore', owner: 'A. Whitmore', frequency: 'Monthly', issued: 1500, used: 0, lastUsed: '2026-04-10', methods: ['Virtual card'], program: 'Facilities Ops', department: 'Facilities', location: 'Denver, CO', createdAt: '2025-10-10', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2025-10-10', autoLockDate: '2026-04-10', terminated: true },
    { id: 102, name: 'B. Callahan', owner: 'B. Callahan', frequency: 'Monthly', issued: 1000, used: 0, lastUsed: '2023-10-14', methods: ['Virtual card', 'Reimbursements'], program: 'Field Supplies', department: 'Construction', location: 'Austin, TX', createdAt: '2023-04-14', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2023-04-14', autoLockDate: '2023-10-14', terminated: true },
    { id: 103, name: 'C. Marsh', owner: 'C. Marsh', frequency: 'Monthly', issued: 200, used: 0, lastUsed: '2023-09-10', methods: ['Virtual card', 'Reimbursements'], program: 'Field Supplies', department: 'Construction', location: 'Dallas, TX', createdAt: '2023-03-10', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2023-03-10', autoLockDate: '2023-09-10', terminated: true },
    { id: 104, name: 'C. Marsh (Temporary)', owner: 'C. Marsh', frequency: 'Monthly', issued: 200, used: 0, lastUsed: '2024-09-30', methods: ['Virtual card'], program: 'Field Supplies', department: 'Construction', location: 'Dallas, TX', createdAt: '2024-03-30', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2024-03-30', autoLockDate: '2024-09-30', terminated: true, temporary: true },
    { id: 105, name: 'C. Marsh', owner: 'C. Marsh', frequency: 'Monthly', issued: 5000, used: 0, lastUsed: '2024-11-15', methods: ['Virtual card'], program: 'Facilities Ops', department: 'Facilities', location: 'Dallas, TX', createdAt: '2024-05-15', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Director approval', startDate: '2024-05-15', autoLockDate: '2024-11-15', terminated: true },
    { id: 106, name: 'E. Solano (Temporary)', owner: 'E. Solano', frequency: 'Monthly', issued: 200, used: 0, lastUsed: null, methods: ['Virtual card'], program: 'Field Supplies', department: 'Construction', location: 'Austin, TX', createdAt: '2025-01-05', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2025-01-05', autoLockDate: '2025-02-05', terminated: true, temporary: true },
    { id: 107, name: 'E. Solano', owner: 'E. Solano', frequency: 'Monthly', issued: 500, used: 0, lastUsed: '2024-07-13', methods: ['Virtual card', 'Reimbursements'], program: 'Field Supplies', department: 'Construction', location: 'Austin, TX', createdAt: '2024-01-13', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2024-01-13', autoLockDate: '2024-07-13', terminated: true },
    { id: 108, name: 'F. Bianchi', owner: 'F. Bianchi', frequency: 'Monthly', issued: 300, used: 0, lastUsed: '2024-10-20', methods: ['Virtual card', 'Reimbursements'], program: 'Operations (OPS)', department: 'Operations (OPS)', location: 'Remote', createdAt: '2024-04-20', lockReason: 'Fund terminated', submissionPolicy: 'Standard', expenseApprovalPolicy: 'Manager approval', startDate: '2024-04-20', autoLockDate: '2024-10-20', terminated: true },
  ],
};

const AVATAR_COLORS = ['blue', 'green', 'orange', 'red'];
const initials = (name) => name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

function FundsAvatar({ name, idx }) {
  const color = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  return (
    <span style={{ width: 24, height: 24, borderRadius: '50%', backgroundColor: `hsla(var(--color-${color}), 0.15)`, color: `hsl(var(--color-${color}))`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0 }}>
      {initials(name)}
    </span>
  );
}

function fundsCell(row, key) {
  switch (key) {
    case 'name': return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <strong>{row.name}</strong>
        {row.terminated && <Ban size={13} style={{ color: 'hsl(var(--color-red))', flexShrink: 0 }} />}
      </span>
    );
    case 'owner': return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <FundsAvatar name={row.owner} idx={row.id} />{row.owner}
        {row.temporary && <Users size={12} style={{ color: 'var(--text-muted)' }} />}
      </span>
    );
    case 'amountIssued': return <div><div style={{ fontWeight: 700 }}>{fmtUsd(row.issued)}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{row.frequency}</div></div>;
    case 'amountUsed': return <span style={{ fontWeight: 700 }}>{fmtUsd(row.used)}</span>;
    case 'utilization': return `${Math.round((row.used / row.issued) * 100)}%`;
    case 'lastUsed': return row.lastUsed || '-';
    case 'paymentMethods': return row.methods.join(', ');
    case 'spendProgram': return row.program;
    case 'department': return row.department;
    case 'location': return row.location;
    case 'createdAt': return row.createdAt;
    case 'lockReason': return row.lockReason;
    case 'submissionPolicy': return row.submissionPolicy;
    case 'expenseApprovalPolicy': return row.expenseApprovalPolicy;
    case 'startDate': return row.startDate;
    case 'autoLockDate': return row.autoLockDate;
    default: return null;
  }
}

function FundsSection() {
  const [fundsTab, setFundsTab] = useState('issued');
  const [search, setSearch] = useState('');
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columns, setColumns] = useState(DEFAULT_FUNDS_COLUMN_STATE);

  const q = search.trim().toLowerCase();
  const rows = FUNDS_DATA[fundsTab].filter(r => !q || r.name.toLowerCase().includes(q) || r.owner.toLowerCase().includes(q));
  const visibleColumns = FUNDS_COLUMNS.filter(c => c.locked || columns[c.key]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 4 }}>Manage spend</div>
          <h2 style={{ fontSize: '1.8rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: 0 }}>Funds</h2>
        </div>
        <button className="primary-btn">Request</button>
      </div>

      <div style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--border-color)', marginBottom: 16 }}>
        {['issued', 'terminated'].map(t => (
          <button key={t} onClick={() => setFundsTab(t)}
            style={{
              background: 'none', border: 'none', padding: '4px 0 10px', marginBottom: -1,
              fontSize: '0.9rem', fontWeight: 600, textTransform: 'capitalize', cursor: 'pointer',
              color: fundsTab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
              borderBottom: `2px solid ${fundsTab === t ? 'var(--text-primary)' : 'transparent'}`,
            }}>
            {t}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input type="text" className="form-input" placeholder="Search or filter..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: 32, height: 34, fontSize: '0.85rem' }} />
        </div>
        {fundsTab === 'terminated' && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 12px', height: 34, borderRadius: 999, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            <Lock size={12} />
            <span>State</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Terminated</span>
          </div>
        )}
        <div style={{ position: 'relative' }}>
          <button className="secondary-btn" style={{ height: 34, width: 34, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setColumnsOpen(o => !o)} title="Manage columns">
            <Columns3 size={15} />
          </button>
          {columnsOpen && (
            <div style={{ position: 'absolute', right: 0, top: 40, zIndex: 20, width: 240, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md)', padding: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 280, overflowY: 'auto' }}>
                {FUNDS_COLUMNS.map(c => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: '0.85rem', color: c.locked ? 'var(--text-muted)' : 'var(--text-primary)', cursor: c.locked ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={c.locked || !!columns[c.key]} disabled={c.locked}
                      onChange={() => setColumns(prev => ({ ...prev, [c.key]: !prev[c.key] }))} />
                    {c.label}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', marginTop: 8, paddingTop: 8 }}>
                <button onClick={() => setColumns(Object.fromEntries(FUNDS_COLUMNS.map(c => [c.key, true])))}
                  style={{ background: 'none', border: 'none', color: 'hsl(var(--color-blue))', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>Select all</button>
                <button onClick={() => setColumns(DEFAULT_FUNDS_COLUMN_STATE)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>Reset</button>
              </div>
            </div>
          )}
        </div>
        <button className="secondary-btn" style={{ height: 34, width: 34, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Date range">
          <CalendarDays size={15} />
        </button>
        <button className="secondary-btn" style={{ height: 34, width: 34, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Export">
          <Download size={15} />
        </button>
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' }}>
        {rows.length === 0 ? (
          <p style={{ padding: 24, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            {fundsTab === 'issued' ? 'No funds match your search.' : 'No terminated funds.'}
          </p>
        ) : (
        <div className="req-table-wrapper">
          <table className="req-table stack-table">
            <thead>
              <tr>
                {visibleColumns.map(c => <th key={c.key} style={{ textAlign: FUNDS_NUMERIC_COLUMNS.has(c.key) ? 'right' : 'left' }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  {visibleColumns.map(c => (
                    <td key={c.key} data-th={c.label} style={{ textAlign: FUNDS_NUMERIC_COLUMNS.has(c.key) ? 'right' : 'left' }}>
                      {fundsCell(r, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  );
}

function RampSectionPlaceholder({ label, Icon }) {
  return (
    <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '48px 24px', boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
      <div style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: 'hsla(var(--color-blue), 0.1)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={22} />
      </div>
      <h3 style={{ fontSize: '1.05rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', maxWidth: 360 }}>This Ramp {label.toLowerCase()} view isn't wired up yet - coming in a future update.</p>
    </div>
  );
}

// Rounded segmented control for a group nested under one top-level sub-tab
// (Manage Spend's Funds/Cards/Requests/Budgets, Expenses' two sources, etc).
function RampSegmentedTabs({ sections, active, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 2, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 999, padding: 4, marginBottom: 20 }}>
      {sections.map(({ key, label, Icon, badge }) => {
        const isActive = active === key;
        return (
          <button key={key} onClick={() => onChange(key)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 16px', borderRadius: 999, border: 'none',
              backgroundColor: isActive ? 'var(--text-primary)' : 'transparent',
              color: isActive ? 'var(--bg-primary)' : 'var(--text-secondary)',
              fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
              transition: 'background-color .15s, color .15s',
            }}>
            <Icon size={14} /> {label}
            {badge && (
              <span style={{
                fontSize: '0.65rem', fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                backgroundColor: isActive ? 'var(--bg-primary)' : 'hsla(var(--color-blue), 0.15)',
                color: isActive ? 'var(--text-primary)' : 'hsl(var(--color-blue))',
              }}>{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function Accounting({ activeSub, onSubChange }) {
  const sub = activeSub || 'transactions';
  const [trx, setTrx] = useState(INIT_TRX);
  const [budgets, setBudgets] = useState(INIT_BUDGETS);
  const [ramp, setRamp] = useState([]);
  const [rampLoading, setRampLoading] = useState(true);
  const [rampError, setRampError] = useState('');
  const [rampMemoDrafts, setRampMemoDrafts] = useState({});
  const [rampSavingId, setRampSavingId] = useState(null);
  const [rampSection, setRampSection] = useState('manage-spend');
  const [rampSpendSection, setRampSpendSection] = useState('cards');
  const [rampExpenseSection, setRampExpenseSection] = useState('card-transactions');
  const [rampTravelSection, setRampTravelSection] = useState('overview');
  const [rampAccountingSection, setRampAccountingSection] = useState('card-transactions');
  const [rampVendorSection, setRampVendorSection] = useState('overview');
  const [rampCompanySection, setRampCompanySection] = useState('people');
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [invForm, setInvForm] = useState({ title: '', type: 'outflow', cost: '', date: new Date().toISOString().split('T')[0] });
  const [budgetForm, setBudgetForm] = useState({ dept: '1', action: 'increase', amt: '' });

  useEffect(() => {
    api.getRamp()
      .then(rows => setRamp(Array.isArray(rows) ? rows : []))
      .catch(() => setRampError('Could not load Ramp card transactions.'))
      .finally(() => setRampLoading(false));
  }, []);

  const saveRampMemo = (id) => {
    const memo = (rampMemoDrafts[id] ?? '').trim();
    if (!memo) return;
    setRampSavingId(id);
    api.updateRampMemo(id, memo)
      .then(updated => {
        setRamp(prev => prev.map(t => t.id === id ? updated : t));
        setRampMemoDrafts(prev => { const next = { ...prev }; delete next[id]; return next; });
      })
      .catch(() => setRampError('Could not save that memo - try again.'))
      .finally(() => setRampSavingId(null));
  };

  const submitInvoice = (e) => {
    e.preventDefault();
    const cost = parseFloat(invForm.cost) * (invForm.type === 'outflow' ? -1 : 1);
    const id = `TRX-${Math.floor(1000 + Math.random() * 9000)}`;
    const d = new Date(invForm.date);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    setTrx(prev => [{ id, title: invForm.title, date: dateStr, cost }, ...prev]);
    setShowInvoiceModal(false);
    setInvForm({ title: '', type: 'outflow', cost: '', date: new Date().toISOString().split('T')[0] });
  };

  const submitBudget = (e) => {
    e.preventDefault();
    const id = parseInt(budgetForm.dept);
    const amt = parseInt(budgetForm.amt);
    setBudgets(prev => prev.map(b => b.id === id ? { ...b, allocated: b.allocated + (budgetForm.action === 'increase' ? amt : -amt) } : b));
    setShowBudgetModal(false);
    setBudgetForm({ dept: '1', action: 'increase', amt: '' });
  };

  const utilColor = (util) => util > 90 ? 'hsl(var(--color-red))' : util < 50 ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Accounting</h2>
          <p>Financial overview, transactions, and budget management</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} /> Export Report
          </button>
          {(sub === 'transactions' || sub === 'invoices') && (
            <button className="primary-btn" onClick={() => setShowInvoiceModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Plus size={16} /> New Invoice
            </button>
          )}
          {sub === 'budgets' && (
            <button className="primary-btn" onClick={() => setShowBudgetModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={16} /> Adjust Budget
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        {[
          { label: 'Total Revenue',        value: '$8.4M', helper: '↑ 12.5% from last quarter', color: 'card-green', helperColor: 'hsl(var(--color-green))', Icon: TrendingUp,   sub: 'transactions' },
          { label: 'Total Expenses',       value: '$6.1M', helper: '↑ 8.2% from last quarter',  color: 'card-green', helperColor: 'hsl(var(--color-green))', Icon: TrendingDown, sub: 'budgets' },
          { label: 'Net Profit',           value: '$2.3M', helper: '↓ 18.9% from last quarter', color: 'card-red',   helperColor: 'hsl(var(--color-red))',   Icon: DollarSign,   sub: 'reports' },
          { label: 'Outstanding Invoices', value: '$450K', helper: '↓ 5.3% from last quarter',  color: 'card-red',   helperColor: 'hsl(var(--color-red))',   Icon: FileText,     sub: 'invoices' },
        ].map(({ label, value, helper, color, helperColor, Icon, sub: target }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'pointer' }} onClick={() => onSubChange(target)}>
            <div className="kpi-card-header">
              <span className="kpi-title">{label}</span>
              <div className="kpi-icon-container"><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
            <div className="kpi-helper" style={{ color: helperColor, fontWeight: 600 }}>{helper}</div>
          </div>
        ))}
      </div>

      {/* Scrollable Tab Pills */}
      {/* Desktop: tabs render centered in the top header; phones keep the
          in-page strip (ModuleTabs handles both) */}
      <ModuleTabs tabs={TABS.map(t => ({ key: t, label: TAB_LABELS[t] }))} active={sub} onChange={onSubChange} />

      {/* Tab Content */}
      <div style={{ marginBottom: 24 }}>

        {/* Transactions */}
        {sub === 'transactions' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Recent Transactions</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Latest financial activities</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {trx.map(t => {
                const pos = t.cost > 0;
                const color = pos ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))';
                return (
                  <div key={t.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: pos ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)', color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {pos ? <ArrowUpRight size={18} strokeWidth={2.5} /> : <ArrowDownRight size={18} strokeWidth={2.5} />}
                      </div>
                      <div>
                        <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{t.title}</strong>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{t.id} · {t.date}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color }}>{pos ? '+' : '-'}{fmt(t.cost)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Invoices */}
        {sub === 'invoices' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Client Invoices</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Outstanding billing statements and due invoices</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead>
                  <tr><th>Invoice ID</th><th>Client Name</th><th>Project Name</th><th>Amount</th><th>Status</th><th>Due Date</th></tr>
                </thead>
                <tbody>
                  {[
                    { id: '#INV-4029', client: 'Apex Real Estate Holdings', project: 'Downtown Commercial Complex',   amount: '$180,000', paid: false, due: '2026-06-15' },
                    { id: '#INV-4028', client: 'Sarah Jenkins Estates',     project: 'Oakridge Subdivision Phase 1',  amount: '$270,000', paid: false, due: '2026-06-12' },
                    { id: '#INV-4027', client: 'Metro Retail Corp.',        project: 'Commercial Retail Center Site-B', amount: '$410,000', paid: true, due: '2026-05-18' },
                  ].map(inv => (
                    <tr key={inv.id}>
                      <td data-th="Invoice" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{inv.id}</td>
                      <td style={{ fontWeight: 600 }}>{inv.client}</td>
                      <td data-th="Project">{inv.project}</td>
                      <td data-th="Amount" style={{ fontWeight: 700 }}>{inv.amount}</td>
                      <td data-th="Status"><span className={`status-badge ${inv.paid ? 'status-approved' : 'status-pending'}`}>{inv.paid ? 'Paid' : 'Awaiting Payment'}</span></td>
                      <td data-th="Due">{inv.due}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Budgets */}
        {sub === 'budgets' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Departmental Budgets</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Approved capital allocations and expenditures</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Department</th><th>Allocated Budget</th><th>Spent Value</th><th>Remaining Budget</th><th>Utilization</th></tr></thead>
                <tbody>
                  {budgets.map(b => {
                    const rem = b.allocated - b.spent;
                    const util = Math.min(100, Math.round((b.spent / b.allocated) * 100));
                    return (
                      <tr key={b.id}>
                        <td style={{ fontWeight: 600 }}>{b.name}</td>
                        <td data-th="Allocated">{fmt(b.allocated)}</td>
                        <td data-th="Spent">{fmt(b.spent)}</td>
                        <td data-th="Remaining" style={{ fontWeight: 600, color: rem < 0 ? 'hsl(var(--color-red))' : 'var(--text-primary)' }}>{fmt(rem)}</td>
                        <td data-th="Utilization">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 140 }}>
                            <div style={{ flex: 1, height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ width: `${util}%`, height: '100%', backgroundColor: utilColor(util), borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{util}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Import Hub */}
        {sub === 'imports' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Financial Import Hub</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Process Fidelity, QuickBooks Payroll, and Tally transactions into Sage Intacct</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
              {[
                { name: 'Fidelity Investments', desc: 'Import retirement accounts, employee benefits, and capital logs.' },
                { name: 'QuickBooks Payroll', desc: 'Import payroll runs, W-4 deductions, and contractor payments.' },
                { name: 'Tally Import', desc: 'Import Tally accounting entries and GST transaction logs.' },
              ].map(svc => (
                <div key={svc.name} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 6, backgroundColor: 'hsla(var(--color-blue), 0.1)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <PiggyBank size={18} />
                    </div>
                    <strong style={{ fontSize: '1rem' }}>{svc.name}</strong>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{svc.desc}</p>
                  <div style={{ border: '2px dashed var(--border-color)', borderRadius: 8, padding: '24px 16px', textAlign: 'center', cursor: 'pointer' }}>
                    <UploadCloud size={24} style={{ color: 'var(--text-muted)', marginBottom: 8 }} />
                    <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600 }}>Drag file or Click to Browse</span>
                    <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>Supports CSV, XLSX</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Ramp Cards */}
        {sub === 'ramp' && (
          <div>
            {/* Ramp's own sub-nav, replicated as an in-page tab strip (see SEO's
                sub-tabs in the Marketing module) rather than a sidebar, since
                this is already nested under our Accounting sidebar entry. */}
            <div className="scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 20, paddingBottom: 8, borderBottom: '1px solid var(--border-color)' }}>
              {RAMP_TOP_SECTIONS.map(({ key, label, Icon }) => (
                <button key={key} className={`tab-pill${rampSection === key ? ' active' : ''}`}
                  style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setRampSection(key)}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>

            {rampSection === 'manage-spend' ? (
              <>
                {/* Funds / Cards / Requests / Budgets - Ramp's "Manage spend"
                    group, as a segmented pill control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_SPEND_SECTIONS} active={rampSpendSection} onChange={setRampSpendSection} />

                {rampSpendSection === 'cards' ? (
                  <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
                    <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Ramp Corporate Card Transactions</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Review and add missing memo references to card transactions</p>
                    {rampError && <p style={{ color: 'hsl(var(--color-red))', fontSize: '0.85rem', marginBottom: 16 }}>{rampError}</p>}
                    {rampLoading ? (
                      <SkeletonBlocks count={4} height={40} />
                    ) : ramp.length === 0 ? (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>No Ramp card transactions yet.</p>
                    ) : (
                    <div className="req-table-wrapper">
                      <table className="req-table stack-table">
                        <thead><tr><th>Transaction ID</th><th>Vendor</th><th>Category</th><th>Date</th><th>Amount</th><th>Memo / Reference</th><th>Status</th></tr></thead>
                        <tbody>
                          {ramp.map(t => {
                            const saving = rampSavingId === t.id;
                            return (
                            <tr key={t.id}>
                              <td data-th="Txn" style={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600 }}>{t.id}</td>
                              <td style={{ fontWeight: 600 }}>{t.vendor}</td>
                              <td data-th="Category" style={{ color: 'var(--text-secondary)' }}>{t.category}</td>
                              <td data-th="Date" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t.date}</td>
                              <td data-th="Amount" style={{ fontWeight: 700 }}>${t.cost.toFixed(2)}</td>
                              <td data-th="Memo">
                                {t.missing
                                  ? <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      <input type="text" className="form-input" style={{ height: 28, fontSize: '0.8rem', padding: '4px 8px' }}
                                        value={rampMemoDrafts[t.id] ?? ''} disabled={saving}
                                        onChange={e => setRampMemoDrafts(p => ({ ...p, [t.id]: e.target.value }))}
                                        onKeyDown={e => { if (e.key === 'Enter') saveRampMemo(t.id); }}
                                        placeholder="Add memo..." />
                                      <button className="secondary-btn" style={{ height: 28, width: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={saving || !(rampMemoDrafts[t.id] ?? '').trim()} onClick={() => saveRampMemo(t.id)}>
                                        {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                                      </button>
                                    </div>
                                  : <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.memo}</span>
                                }
                              </td>
                              <td data-th="Status">
                                <span style={{ backgroundColor: t.missing ? 'hsla(var(--color-orange), 0.1)' : 'hsla(var(--color-green), 0.1)', color: t.missing ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
                                  {t.missing ? 'Missing Memo' : 'Complete'}
                                </span>
                              </td>
                            </tr>
                          );})}
                        </tbody>
                      </table>
                    </div>
                    )}
                  </div>
                ) : rampSpendSection === 'funds' ? (
                  <FundsSection />
                ) : (
                  <RampSectionPlaceholder
                    label={RAMP_SPEND_SECTIONS.find(s => s.key === rampSpendSection).label}
                    Icon={RAMP_SPEND_SECTIONS.find(s => s.key === rampSpendSection).Icon}
                  />
                )}
              </>
            ) : rampSection === 'expenses' ? (
              <>
                {/* Card transactions / Reimbursements - Ramp's "Expenses"
                    group, as a segmented pill control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_EXPENSE_SECTIONS} active={rampExpenseSection} onChange={setRampExpenseSection} />
                <RampSectionPlaceholder
                  label={RAMP_EXPENSE_SECTIONS.find(s => s.key === rampExpenseSection).label}
                  Icon={RAMP_EXPENSE_SECTIONS.find(s => s.key === rampExpenseSection).Icon}
                />
              </>
            ) : rampSection === 'travel' ? (
              <>
                {/* Overview / Trip management - Ramp's "Travel" group, as a
                    segmented pill control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_TRAVEL_SECTIONS} active={rampTravelSection} onChange={setRampTravelSection} />
                <RampSectionPlaceholder
                  label={RAMP_TRAVEL_SECTIONS.find(s => s.key === rampTravelSection).label}
                  Icon={RAMP_TRAVEL_SECTIONS.find(s => s.key === rampTravelSection).Icon}
                />
              </>
            ) : rampSection === 'accounting' ? (
              <>
                {/* Card transactions / Stack - Ramp's "Accounting" group, as a
                    segmented pill control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_ACCOUNTING_SECTIONS} active={rampAccountingSection} onChange={setRampAccountingSection} />
                <RampSectionPlaceholder
                  label={RAMP_ACCOUNTING_SECTIONS.find(s => s.key === rampAccountingSection).label}
                  Icon={RAMP_ACCOUNTING_SECTIONS.find(s => s.key === rampAccountingSection).Icon}
                />
              </>
            ) : rampSection === 'vendors' ? (
              <>
                {/* Overview / Contracts & renewals - Ramp's "Vendors" group,
                    as a segmented pill control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_VENDOR_SECTIONS} active={rampVendorSection} onChange={setRampVendorSection} />
                <RampSectionPlaceholder
                  label={RAMP_VENDOR_SECTIONS.find(s => s.key === rampVendorSection).label}
                  Icon={RAMP_VENDOR_SECTIONS.find(s => s.key === rampVendorSection).Icon}
                />
              </>
            ) : rampSection === 'company' ? (
              <>
                {/* People / Statements & payments / Integrations / Rewards /
                    Settings - Ramp's "Company" group, as a segmented pill
                    control under its own tab. */}
                <RampSegmentedTabs sections={RAMP_COMPANY_SECTIONS} active={rampCompanySection} onChange={setRampCompanySection} />
                <RampSectionPlaceholder
                  label={RAMP_COMPANY_SECTIONS.find(s => s.key === rampCompanySection).label}
                  Icon={RAMP_COMPANY_SECTIONS.find(s => s.key === rampCompanySection).Icon}
                />
              </>
            ) : (
              <RampSectionPlaceholder
                label={RAMP_TOP_SECTIONS.find(s => s.key === rampSection).label}
                Icon={RAMP_TOP_SECTIONS.find(s => s.key === rampSection).Icon}
              />
            )}
          </div>
        )}

        {/* Vendors */}
        {sub === 'vendors' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Vendor & Subcontractor Registry</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>W-9 status, COI expiry, 1099 eligibility, and GL mapping</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead>
                  <tr><th>Vendor</th><th>Trade</th><th>W-9</th><th>COI Expiry</th><th>1099</th><th>GL Account</th><th>Open POs</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {VENDORS.map(v => {
                    const coiDate = new Date(v.coi);
                    const today = new Date('2026-05-28');
                    const daysLeft = Math.round((coiDate - today) / 86400000);
                    const coiOk = daysLeft > 30;
                    const coiWarn = daysLeft > 0 && daysLeft <= 30;
                    return (
                      <tr key={v.name}>
                        <td style={{ fontWeight: 600 }}>{v.name}</td>
                        <td data-th="Trade" style={{ color: 'var(--text-secondary)' }}>{v.trade}</td>
                        <td data-th="W-9">
                          <span style={{ backgroundColor: v.w9 === 'On file' ? 'hsla(var(--color-green), 0.1)' : v.w9 === 'Pending' ? 'hsla(var(--color-orange), 0.1)' : 'hsla(var(--color-red), 0.1)', color: v.w9 === 'On file' ? 'hsl(var(--color-green))' : v.w9 === 'Pending' ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{v.w9}</span>
                        </td>
                        <td data-th="COI Expiry">
                          <span style={{ color: coiOk ? 'var(--text-primary)' : coiWarn ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))', fontWeight: coiOk ? 400 : 600, fontFamily: 'monospace', fontSize: '0.85rem' }}>{v.coi}{!coiOk && <span style={{ marginLeft: 4, fontSize: '0.7rem' }}>{daysLeft <= 0 ? '(expired)' : `(${daysLeft}d)`}</span>}</span>
                        </td>
                        <td data-th="1099" style={{ textAlign: 'center' }}>{v.is1099 ? <span style={{ color: 'hsl(var(--color-green))', fontWeight: 700 }}>✓</span> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                        <td data-th="GL Account" style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{v.gl}</td>
                        <td data-th="Open POs" style={{ textAlign: 'center', fontWeight: 600 }}>{v.pos}</td>
                        <td data-th="Status"><span style={{ backgroundColor: v.active ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)', color: v.active ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{v.active ? 'Active' : 'Inactive'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Ask My Accountant */}
        {sub === 'ask-accountant' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
              <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Ask My Accountant</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Transactions flagged for coding clarification - routed to your accountant for review</p>
              <div className="req-table-wrapper">
                <table className="req-table stack-table">
                  <thead>
                    <tr><th>Ticket</th><th>Date</th><th>Vendor</th><th>Amount</th><th>Coded By</th><th>Question</th><th>Days Open</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {AMA_FLAGGED.map(f => (
                      <tr key={f.id}>
                        <td data-th="Ticket" style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.8rem' }}>{f.id}</td>
                        <td data-th="Date" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{f.date}</td>
                        <td style={{ fontWeight: 600 }}>{f.vendor}</td>
                        <td data-th="Amount" style={{ fontWeight: 700 }}>${f.amount.toFixed(2)}</td>
                        <td data-th="Coded by" style={{ color: 'var(--text-secondary)' }}>{f.coder}</td>
                        <td data-th="Question" style={{ maxWidth: 260, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{f.q}</td>
                        <td data-th="Days open" style={{ textAlign: 'center' }}>
                          <span style={{ backgroundColor: f.days >= 7 ? 'hsla(var(--color-red), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: f.days >= 7 ? 'hsl(var(--color-red))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{f.days}d</span>
                        </td>
                        <td data-th="Status">
                          <span style={{ backgroundColor: f.status === 'In Review' ? 'hsla(var(--color-blue), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: f.status === 'In Review' ? 'hsl(var(--color-blue))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{f.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 12, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Flag a new transaction for review</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group"><label>Vendor / Payee</label><input type="text" className="form-input" placeholder="e.g. Home Depot #4412" /></div>
                <div className="form-group"><label>Amount ($)</label><input type="number" className="form-input" placeholder="e.g. 1284.55" /></div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}><label>Your question for the accountant</label><input type="text" className="form-input" placeholder="e.g. Should this be capitalized or expensed?" /></div>
              </div>
              <button className="primary-btn" style={{ marginTop: 12 }}>Submit for Review</button>
            </div>
          </div>
        )}

        {/* AMA Entities */}
        {sub === 'ama' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>AMA Entity Billing Tracker</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Asset Management Agreement entities, fee rates, and billing schedules</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Entity Name</th><th>Status</th><th>Fee Rate</th><th>Billed YTD</th><th>Next Billing</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {AMA_ENTITIES.map(e => {
                    const active = e.status === 'Active';
                    return (
                      <tr key={e.id}>
                        <td style={{ fontWeight: 600 }}>{e.entity}</td>
                        <td data-th="Status">
                          <span style={{ backgroundColor: active ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: active ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{e.status}</span>
                        </td>
                        <td data-th="Fee rate" style={{ fontWeight: 600 }}>{e.feeRate}%</td>
                        <td data-th="Billed YTD" style={{ fontWeight: 700 }}>${e.billedYTD.toLocaleString()}</td>
                        <td data-th="Next billing" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{e.nextBilling}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>View Agreement</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MRE */}
        {sub === 'mre' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>MRE Tenant Payment Register</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Monthly rent collections and tenant payment statuses</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>Rent Amount</th><th>Due Date</th><th>Status</th></tr></thead>
                <tbody>
                  {[
                    { tenant: 'Apex Retail Corp', unit: 'Suite 101', property: 'Downtown Commercial Complex', rent: 18000, due: '2026-06-01', status: 'Paid' },
                    { tenant: 'Metro Coffee House', unit: 'Suite 102', property: 'Downtown Commercial Complex', rent: 6500, due: '2026-06-01', status: 'Paid' },
                    { tenant: 'Harbor View Resident - Unit 4B', unit: 'Unit 4B', property: 'Harbor View Condos', rent: 3200, due: '2026-06-01', status: 'Pending' },
                    { tenant: 'Warehouse Logistics LLC', unit: 'Bay A', property: 'North Industrial Warehouse', rent: 12000, due: '2026-06-15', status: 'Paid' },
                  ].map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.tenant}</td>
                      <td data-th="Unit" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.unit}</td>
                      <td data-th="Property">{r.property}</td>
                      <td data-th="Rent" style={{ fontWeight: 700 }}>${r.rent.toLocaleString()}</td>
                      <td data-th="Due" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.due}</td>
                      <td data-th="Status"><span className={`status-badge ${r.status === 'Paid' ? 'status-approved' : 'status-pending'}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MRI */}
        {sub === 'mri' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>MRI Software Sync</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Real-time MRI property management software integration status</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { module: 'General Ledger Sync', lastSync: '2026-05-27 09:15 AM', records: 1240, status: 'Synced' },
                { module: 'Tenant Ledger Export', lastSync: '2026-05-27 09:10 AM', records: 86, status: 'Synced' },
                { module: 'Accounts Payable', lastSync: '2026-05-26 11:00 PM', records: 42, status: 'Pending Review' },
                { module: 'Budget Variance Report', lastSync: '2026-05-26 06:00 PM', records: 18, status: 'Synced' },
              ].map((m, i) => (
                <div key={i} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{m.module}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>Last sync: {m.lastSync} · {m.records} records</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ backgroundColor: m.status === 'Synced' ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: m.status === 'Synced' ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{m.status}</span>
                    <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>Force Sync</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reports */}
        {sub === 'reports' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Financial Report Downloads</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Download certified financial statements and audit documents</p>
            <div className="req-table-wrapper">
              <table className="req-table stack-table">
                <thead><tr><th>Report Name</th><th>Period</th><th>Generated By</th><th>File Size</th><th style={{ textAlign: 'right' }}>Download</th></tr></thead>
                <tbody>
                  {[
                    { name: 'Q1 2026 Financial Statement', period: 'Jan – Mar 2026', by: 'Deloitte LLP', size: '4.2 MB' },
                    { name: 'Annual Budget Variance Report FY2025', period: 'Full Year 2025', by: 'Internal Finance', size: '2.8 MB' },
                    { name: 'Q4 2025 Audited Balance Sheet', period: 'Oct – Dec 2025', by: 'Deloitte LLP', size: '5.1 MB' },
                    { name: 'Cash Flow Projection H2 2026', period: 'Jul – Dec 2026', by: 'CFO Office', size: '1.4 MB' },
                  ].map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td data-th="Period" style={{ color: 'var(--text-secondary)' }}>{r.period}</td>
                      <td data-th="Generated by">{r.by}</td>
                      <td data-th="Size" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.size}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Download size={12} /> Download PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
        {[
          { label: 'Payment Processing', sub: 'Process payments', Icon: CreditCard },
          { label: 'Financial Reports', sub: 'Generate reports', Icon: TrendingUp },
          { label: 'Tax Documents', sub: 'View tax filings', Icon: DollarSign },
        ].map(({ label, sub: s, Icon }) => (
          <div key={label} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)', display: 'flex', gap: 16, alignItems: 'center', cursor: 'pointer' }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
              <Icon size={20} />
            </div>
            <div>
              <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</strong>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{s}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Invoice Modal */}
      {showInvoiceModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create New Invoice</h3>
              <button className="close-btn" onClick={() => setShowInvoiceModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitInvoice}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Invoice Title / Reference</label>
                  <input type="text" className="form-input" required placeholder="e.g. Subcontractor Payment - Framing Q2" value={invForm.title} onChange={e => setInvForm(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Transaction Type</label>
                  <select className="form-select" value={invForm.type} onChange={e => setInvForm(p => ({ ...p, type: e.target.value }))}>
                    <option value="inflow">Inflow (Income/Revenue)</option>
                    <option value="outflow">Outflow (Expense/Payment)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Total Cost ($)</label>
                  <input type="number" className="form-input" required min="1" placeholder="e.g. 45000" value={invForm.cost} onChange={e => setInvForm(p => ({ ...p, cost: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Transaction Date</label>
                  <input type="date" className="form-input" required value={invForm.date} onChange={e => setInvForm(p => ({ ...p, date: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowInvoiceModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Save Invoice</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Budget Adjustment Modal */}
      {showBudgetModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Adjust Capital Allocation</h3>
              <button className="close-btn" onClick={() => setShowBudgetModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitBudget}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Target Department</label>
                  <select className="form-select" value={budgetForm.dept} onChange={e => setBudgetForm(p => ({ ...p, dept: e.target.value }))}>
                    {budgets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Adjustment Type</label>
                  <select className="form-select" value={budgetForm.action} onChange={e => setBudgetForm(p => ({ ...p, action: e.target.value }))}>
                    <option value="increase">Increase Allocation (+)</option>
                    <option value="decrease">Decrease Allocation (-)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Adjustment Amount ($)</label>
                  <input type="number" className="form-input" required min="1000" step="1000" placeholder="e.g. 50000" value={budgetForm.amt} onChange={e => setBudgetForm(p => ({ ...p, amt: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowBudgetModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Process Adjustment</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
