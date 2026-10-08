import { ArrowRight, Banknote, KeyRound, Receipt } from 'lucide-react';

// Tools > Import Hub (Neil, 10/04: "create a Tools section in accounting").
// Every screen that builds its records by reading the ledger, in one list, so
// nobody has to remember which tab hides which "Set Up From the Ledger"
// button. Each card only points at its screen (a tab change) - the scans
// themselves run there, as background jobs on the API, with their own
// progress bar. None of the scans keeps a "last run" record the API exposes
// today (each scan is rebuilt on demand), so the cards say what the scan
// reads instead of when it last ran.

const SOURCES = [
  {
    key: 'loans', Icon: Banknote, title: 'Loans & Financing', action: 'Set Up From the Ledger',
    body: "Reads each entity's balance sheet and proposes a loan for every liability account whose title says loan, mortgage, note, line of credit or a lender's name. Balances are read from the ledger every month after that.",
    where: 'Loans & Financing > Set Up From the Ledger',
  },
  {
    key: 'mri', Icon: KeyRound, title: 'MRI - Monthly Recurring Income', action: 'Set Up From the Ledger',
    body: 'Proposes one lease per entity and customer from what posted to the rent, lease and tenant income accounts, with the rent as it changed month to month.',
    where: 'Reporting > MRI > Leasing > Set Up From the Ledger',
  },
  {
    key: 'mre', Icon: Receipt, title: 'MRE - Monthly Recurring Expenses', action: 'Scan the Ledger',
    body: 'Finds the expenses that post every month and lists what each costs per month and per entity.',
    where: 'Reporting > MRE',
  },
];

/** `available`: the sub keys this person may open; `onOpen(key)` switches the tab. */
export default function ImportHub({ available = [], onOpen }) {
  const shown = SOURCES.filter((s) => available.includes(s.key));
  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        Every setup that reads the Nexus Accounting ledger. Each scan runs on the server and keeps going if you leave the screen.
      </div>
      {shown.length === 0 ? (
        <div style={{ ...card, padding: 16, fontSize: '0.84rem', color: 'var(--text-muted)' }}>None of the ledger setups are open to you.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {shown.map(({ key, Icon, title, action, body, where }) => (
            <div key={key} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', padding: 6, borderRadius: 8, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}><Icon size={16} /></span>
                <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700 }}>{title}</h3>
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.45, color: 'var(--text-secondary)', flex: 1 }}>{body}</p>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{where}</div>
              <button type="button" className="primary-btn" onClick={() => onOpen?.(key)}
                style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
                {action} <ArrowRight size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
