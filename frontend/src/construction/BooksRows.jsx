// The Books rows on Edit Job (Neil, 11/03/2026, plan phase 4): the job's
// EXISTING Intacct Project-Job code and the entity it books to - the
// dimension the accounting reports already filter by. Managers with
// Accounting access only (the server checks it again on save). A caller with
// company-wide accounting access picks from every code on the ledger; one
// limited to certain entities picks from the codes already on their
// entity's ledger lines, and a code with no lines yet is mapped by someone
// with company-wide access (the server's /construction/books/projects).
import { SettingRow, SettingCard } from '../components/settings/SettingsUI';
import { useBookChoices } from './lib/money';

export default function BooksRows({ books }) {
  const { draft, patch } = books;
  const { data, error } = useBookChoices(draft.intacctEntity, books.show);
  const entities = data?.entities || [];
  const codes = data?.codes || [];
  const loading = !data && !error;
  const picked = codes.find((c) => c.code === draft.intacctProjectId.trim()) || null;
  // A code with no lines on the entity saves (the server warns too): Money
  // reads nothing for it until costs post.
  const noLines = !!(data && draft.intacctEntity && draft.intacctProjectId.trim() && !picked?.onEntity);
  return (
    <SettingCard>
      <SettingRow title="Entity" htmlFor="job-entity" desc="The Intacct entity this job books to."
        control={(
          <select id="job-entity" aria-label="Entity" className="form-input" style={{ width: 'min(280px, 52vw)' }}
            value={draft.intacctEntity} onChange={(e) => patch({ intacctEntity: e.target.value })} disabled={loading && !entities.length}>
            <option value="">{loading ? 'Loading…' : 'Not Mapped'}</option>
            {draft.intacctEntity && !entities.some((e) => e.code === draft.intacctEntity) && <option value={draft.intacctEntity}>{draft.intacctEntity}</option>}
            {entities.map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
          </select>
        )} />
      <SettingRow title="Project-Job" htmlFor="job-project-job"
        desc={data?.limited
          ? "The Intacct Project-Job its costs post to. Your accounting access lists the codes already on this entity's lines; a new code is mapped by someone with company-wide accounting access."
          : 'The Intacct Project-Job its costs post to. Money reads the books by this code - nothing is keyed into Nexus.'}
        control={(
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
            <input id="job-project-job" aria-label="Project-Job" className="form-input" list="job-project-job-codes" style={{ width: 'min(280px, 52vw)' }}
              value={draft.intacctProjectId} placeholder={draft.intacctEntity ? 'Type or pick a code' : 'Pick the entity first'}
              disabled={!draft.intacctEntity && !draft.intacctProjectId}
              onChange={(e) => patch({ intacctProjectId: e.target.value })} />
            <datalist id="job-project-job-codes">
              {codes.map((c) => <option key={c.code} value={c.code}>{c.name ? `${c.code} - ${c.name}` : c.code}</option>)}
            </datalist>
          </span>
        )} />
      {error && <div role="alert" style={{ padding: '8px 16px', fontSize: 13, color: 'hsl(var(--color-red))' }}>{error}</div>}
      {noLines && (
        <div data-books-warning="" role="status" style={{ padding: '8px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
          {picked || data.limited
            ? `${draft.intacctProjectId.trim()} has no lines on this entity yet. It saves; Money shows nothing until costs post to it.`
            : `${draft.intacctProjectId.trim()} is not on the books - the save will refuse it.`}
        </div>
      )}
    </SettingCard>
  );
}
