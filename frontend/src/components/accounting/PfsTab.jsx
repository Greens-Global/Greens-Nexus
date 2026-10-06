import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, ChevronDown, ChevronUp, Database, FolderUp, GripVertical, Lock, Mail, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, Figure } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { ExportMenu, control } from './reportControls';
import { downloadBlob, iso, priorMonthEnd } from './reportModel';
import SendReportDialog from './SendReportDialog';
import { conditionOf } from './pfsCondition';
import PfsAffiliated, { PfsCoExecutiveProfile } from './PfsAffiliated';
import { PfsAccessLog, PfsLockIcon, PfsLockNow, PfsUnlockPanel, isLockedError, usePfsLocks } from './PfsLock';

// Accounting -> PFS: personal financial statements (Neil, Sep 25).
//
// A lender's first question on a loan is the guarantor's personal financial
// statement. Accounting used to build it in Excel on top of a ledger add-in;
// here a guarantor is set up once - who they are, what they own and owe, and
// for each figure whether it comes from the ledger (an entity's accounts, at
// the share they own) or is kept by hand - and after that a statement is a
// date and a click.
//
// One section is on screen at a time. The figures shown beside each line are
// the statement's own, computed for the date picked at the top. "Produce PDF"
// keeps the statement exactly as it was and writes who produced it to the
// audit log. Owners and people explicitly granted this screen see it; nobody
// else does, administrators included.
//
// Sep 30 (Neil, call of 09/29 - "an emergency"): a spouse on the statement;
// "Add From the Ledger" sets up an entity's bank, retirement, investment and
// loan accounts in one go, each as a ledger line at its share, grouped by GL
// code so a whole group is one tick; four real estate categories; the date
// starts on the last month-end, the last closed period.
//
// Oct 2 (Charmi + Neil, Teams 10/01-10/02): the ledger picker's guesses come
// from the server (type, title, GL group) and every line has "Move to..."; Add
// From the Ledger on Liabilities and Real Estate (a land or building account
// with its mortgage account as the loan); Produce Excel beside Produce PDF; a
// New Guarantor prefilled from People, joint with two names; a Co-Borrower
// block on the Borrower tab; a Schedules tab (Schedule E per property with an
// entity, Schedule C per business interest with one, for the calendar year of
// the date); Jewelry & Personal Property as its own category.
//
// Oct 6 (Charmi, 10/03-10/04): the Statement view opens on the bank-style
// first page (Statement of Financial Condition), which is also page 1 of the
// PDF and the first sheet of the workbook; one Export menu - the one Reports
// has (PDF, Excel, Email, Save to Files) - instead of two Produce buttons,
// every file still kept on record and audited; Institution is the bank, read
// from the bank account linked to the GL; Cash is its own section, first;
// Vehicles is a section; Jewelry and Personal Property are Personal Holdings;
// lines are put in order by dragging or with the arrows, kept per guarantor.

const SECTIONS = [
  { key: 'statement', label: 'Statement' },
  { key: 'affiliated', label: 'Affiliated Entities' },   // Oct 6 (Charmi, 10/04) - PfsAffiliated.jsx
  { key: 'borrower', label: 'Borrower' },
  { key: 'asset', label: 'Assets' },
  { key: 'liability', label: 'Liabilities' },
  { key: 'real_estate', label: 'Real Estate' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'history', label: 'History and Profile' },
];
const SECTION_LABEL = { asset: 'Assets', liability: 'Liabilities', real_estate: 'Real Estate' };
const CO_BORROWER = [
  ['name', 'Name'], ['address', 'Street Address'], ['city_state_zip', 'City, State, ZIP'], ['phone', 'Phone'], ['email', 'Email'],
  ['date_of_birth', 'Date of Birth', 'date'], ['marital_status', 'Marital Status'], ['employer', 'Employer'], ['title', 'Title'],
  ['ssn_last4', 'Social Security Number - Last 4 Digits'],
];
const KINDS = { individual: 'Individual', joint: 'Joint', trust: 'Trust' };
const DETAILS = [
  ['address', 'Street Address'], ['city_state_zip', 'City, State, ZIP'], ['phone', 'Phone'], ['email', 'Email'],
  ['date_of_birth', 'Date of Birth', 'date'], ['marital_status', 'Marital Status'], ['employer', 'Employer'], ['title', 'Title'],
  ['ssn_last4', 'Social Security Number - Last 4 Digits'],
];
const RE_DETAILS = [['address', 'Address'], ['property_type', 'Property Type'], ['legal_owner', 'Legal Owner'], ['ownership_type', 'Ownership Type'], ['lender', 'Lender'], ['interest_rate', 'Interest Rate'], ['monthly_payment', 'Monthly Payment']];

const pct = (n) => `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };

export default function PfsTab({ canEdit = false }) {
  const { myEmail } = useRole();
  const nameOf = useNameResolver();
  const [meta, setMeta] = useState(null);
  const [profiles, setProfiles] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState('');
  const [profile, setProfile] = useState(null);        // the open profile, with its lines
  // The last month-end: the last closed period is what a lender is sent.
  const [asOf, setAsOf] = useState(() => priorMonthEnd(iso(new Date())));
  const [statement, setStatement] = useState(null);
  const [working, setWorking] = useState(false);
  const [section, setSection] = useState('statement');
  const [editing, setEditing] = useState(null);         // a line being added or changed
  const [bulk, setBulk] = useState(null);               // { section } - Add From the Ledger
  const [creating, setCreating] = useState(false);
  const [past, setPast] = useState([]);
  const [producing, setProducing] = useState('');   // 'pdf' | 'xlsx' while one is being made
  const [sending, setSending] = useState(null);     // 'email' | 'egnyte' - the Export menu's send dialogs
  const [note, setNote] = useState('');
  const seq = useRef(0);
  // Oct 6 (Charmi, 10/04): every file is locked until opened with a one-time
  // code (PfsLock.jsx; the server enforces it). The Access Log for editors.
  const locks = usePfsLocks();
  const { markLocked } = locks;
  const fileOpen = locks.isOpen(openId);
  const [showLog, setShowLog] = useState(false);

  const loadProfiles = useCallback(() => api.getPfsProfiles()
    .then((list) => { setProfiles(list || []); return list || []; })
    .catch((e) => { setProfiles((p) => p || []); setError(e?.message || 'Could not load the profiles.'); return []; }), []);
  useEffect(() => {
    api.getPfsMeta().then(setMeta).catch(() => setMeta({ assetCategories: [], liabilityCategories: [], realEstateKinds: [], historyQuestions: [] }));
    loadProfiles().then((list) => setOpenId((id) => id || list.find((p) => !p.archived)?.id || ''));
  }, [loadProfiles]);

  // The open profile, and its statement for the date picked.
  const refresh = useCallback((id, date) => {
    if (!id) { setProfile(null); setStatement(null); return Promise.resolve(); }
    const mine = ++seq.current;
    setWorking(true);
    setError('');
    // The profile shows as soon as it is read; the statement (the ledger, the
    // bank records, the schedules) follows behind a skeleton (Oct 6).
    const p = api.getPfsProfile(id).then((x) => { if (mine === seq.current) setProfile(x); return x; });
    return Promise.all([p, api.getPfsStatement(id, date), api.getPfsStatements(id)])
      .then(([x, s, list]) => { if (mine === seq.current) { setProfile(x); setStatement(s); setPast(list || []); } })
      .catch((e) => { if (mine !== seq.current) return; if (isLockedError(e)) markLocked(id); else setError(e?.message || 'Could not load the statement.'); })
      .finally(() => { if (mine === seq.current) setWorking(false); });
  }, [markLocked]);
  useEffect(() => { setNote(''); refresh(fileOpen ? openId : '', asOf); }, [openId, asOf, refresh, fileOpen]);

  const categories = useMemo(() => ({
    asset: meta?.assetCategories || [], liability: meta?.liabilityCategories || [], real_estate: meta?.realEstateKinds || [],
  }), [meta]);
  // Every place a line can be moved to, grouped by section ("Move to...").
  const allCategories = useMemo(() => ['asset', 'liability', 'real_estate'].map((s) => ({ section: s, label: SECTION_LABEL[s], categories: categories[s] })), [categories]);
  // Figures by line id, from the statement.
  const figures = useMemo(() => {
    const m = new Map();
    [...(statement?.assets || []), ...(statement?.liabilities || []), ...(statement?.realEstate || [])].forEach((g) => g.rows.forEach((r) => m.set(r.id, r)));
    return m;
  }, [statement]);

  const saveProfile = (patch) => api.updatePfsProfile(profile.id, { name: profile.name, kind: profile.kind, ...patch })
    .then(() => Promise.all([loadProfiles(), refresh(profile.id, asOf)]));

  // The file for a statement: the PDF, or the Excel workbook (Neil, 10/01:
  // "in excel also"). pdf-lib and jszip are large; each loads only when asked for.
  const stemOf = (kept) => `PFS_${profile.name.replace(/[^A-Za-z0-9]+/g, '-')}_${kept.asOf}`;
  const buildFile = async (kept, format, preparedBy, name = '') => {
    if (format === 'xlsx') {
      const { buildPfsWorkbook } = await import('./pfsXlsx');
      const bytes = await buildPfsWorkbook({ statement: kept, preparedBy });
      return new File([bytes], name || `${stemOf(kept)}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    const { buildPfsPdf } = await import('./pfsPdf');
    const bytes = await buildPfsPdf({ statement: kept, photo: profile.photo, preparedBy });
    return new File([bytes], name || `${stemOf(kept)}.pdf`, { type: 'application/pdf' });
  };
  const fileFor = async (kept, format, preparedBy) => {
    const f = await buildFile(kept, format, preparedBy);
    downloadBlob(f.name, new Blob([f], { type: f.type }));
  };
  // Email / Save to Files (the Reports tab's dialog): the statement is
  // produced - kept on record, audited with where it went - then built into
  // the file that is sent.
  const sendFile = async (format, name) => {
    const fmt = format === 'excel' ? 'xlsx' : 'pdf';
    const made = await api.producePfsStatement(profile.id, asOf, fmt, sending === 'email' ? 'email' : 'files');
    const f = await buildFile(made, fmt, nameOf(myEmail) || '', name);
    api.getPfsStatements(profile.id).then((list) => setPast(list || [])).catch(() => {});
    return f;
  };
  const produce = async (format = 'pdf') => {
    if (producing || !profile) return;
    setProducing(format);
    setError('');
    setNote('');
    const what = format === 'xlsx' ? 'Excel workbook' : 'PDF';
    try {
      const made = await api.producePfsStatement(profile.id, asOf, format, 'download');
      await fileFor(made, format, nameOf(myEmail) || '');
      setNote(`${what} produced and the statement kept on record.`);
      setPast(await api.getPfsStatements(profile.id));
    } catch (e) {
      setError(`The ${what} was not produced: ${e?.message || 'the statement could not be read.'}`);
    } finally {
      setProducing('');
    }
  };
  const reprint = async (row, format = 'pdf') => {
    setError('');
    try {
      const kept = await api.getPfsSavedStatement(row.id);
      await fileFor(kept, format, nameOf(kept.generatedBy) || '');
    } catch (e) {
      setError(e?.message || 'Could not open that statement.');
    }
  };
  // A new order of the lines in one category: shown at once, kept on the
  // server, the statement re-read so every figure follows (Charmi, 10/04).
  const reorder = (ids) => {
    const rank = new Map(ids.map((id, i) => [id, i + 1]));
    setProfile((p) => (p ? { ...p, lines: p.lines.map((l) => (rank.has(l.id) ? { ...l, sort: rank.get(l.id) } : l)).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.label.localeCompare(b.label)) } : p));
    return api.reorderPfsLines(profile.id, ids)
      .then(() => refresh(profile.id, asOf))
      .catch((e) => { setError(e?.message || 'Could not keep the new order.'); return refresh(profile.id, asOf); });
  };
  const move = (l, section, category) => api.movePfsLine(profile.id, l.id, section, category)
    .then(() => { setNote(`${l.label} moved to ${categories[section]?.find((c) => c.key === category)?.label || category}.`); return refresh(profile.id, asOf); })
    .catch((e) => setError(e?.message || 'Could not move the line.'));

  return (
    <AsyncSection loading={profiles === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 270px) 1fr', gap: 12, alignItems: 'start' }}>
        <div style={{ ...card, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
            <strong style={{ fontSize: '0.86rem' }}>Guarantors</strong>
            {canEdit && (
              <button type="button" className="secondary-btn" onClick={() => setCreating(true)} aria-label="New Guarantor" title="New Guarantor" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', padding: '4px 10px' }}>
                <Plus size={13} /> New
              </button>
            )}
          </div>
          {(profiles || []).length === 0 && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '6px 2px' }}>Nobody is set up yet. A guarantor is a person, a couple filing jointly, or a trust.</div>}
          <div style={{ display: 'grid', gap: 2 }}>
            {(profiles || []).map((p) => (
              <button key={p.id} type="button" onClick={() => { setOpenId(p.id); setSection('statement'); }} aria-pressed={p.id === openId}
                style={{ textAlign: 'left', border: 'none', borderRadius: 8, padding: '7px 9px', cursor: 'pointer', font: 'inherit', background: p.id === openId ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', color: 'var(--text-primary)', opacity: p.archived ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  {locks.enabled && <PfsLockIcon open={locks.isOpen(p.id)} />}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{KINDS[p.kind] || 'Individual'}{p.archived ? ' · archived' : ''}</div>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-color)' }}>
            <Lock size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Only owners and people granted this screen can open it. Each file opens with a one-time code emailed to you, for 30 minutes in this tab, and its borrowers are told. Every open, change and statement is logged.</span>
          </div>
          {canEdit && (
            <button type="button" className="acct-drill" onClick={() => setShowLog(true)} style={{ fontSize: '0.74rem', marginTop: 6 }}>Access Log</button>
          )}
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
            Add each guarantor once; a joint statement lists both names.
          </div>
        </div>

        <div style={{ minWidth: 0, display: 'grid', gap: 10 }}>
          {error && <div style={bad}>{error}</div>}
          {openId && !fileOpen && <PfsUnlockPanel key={openId} file={(profiles || []).find((p) => p.id === openId) || { id: openId }} onUnlocked={locks.markOpen} />}
          {(!openId || fileOpen) && !profile && !working && <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{canEdit ? 'Start with New Guarantor.' : 'No guarantor has been set up yet.'}</div>}
          {fileOpen && !profile && working && <SkeletonBlocks count={3} />}
          {profile && fileOpen && (
            <>
              <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <div style={{ minWidth: 0, marginRight: 6 }}>
                  <div style={{ fontSize: '0.98rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile.displayName || profile.name}</div>
                </div>
                <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
                  {SECTIONS.map((s) => (
                    <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
                      style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {locks.untilOf(profile.id) && <PfsLockNow fileId={profile.id} until={locks.untilOf(profile.id)} onLocked={locks.markLocked} />}
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>As of</span>
                  <input type="date" value={asOf} aria-label="Statement date" style={control} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
                  {/* Oct 6 (Charmi): "an option to Export to Excel and PDF and not
                      separate tabs/buttons - the exact one you had for reports".
                      Every choice keeps the statement on record and audits it. */}
                  <ExportMenu disabled={!!producing || working || !statement} items={[
                    { key: 'pdf', label: 'PDF', hint: 'Financial condition first, then every schedule; kept on record', onPick: () => produce('pdf'), busy: producing === 'pdf' },
                    { key: 'excel', label: 'Excel', hint: 'One sheet per section, live totals; kept on record', onPick: () => produce('xlsx'), busy: producing === 'xlsx' },
                    { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, statement attached', Icon: Mail, onPick: () => setSending('email') },
                    { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
                  ]} />
                </div>
              </div>
              {note && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--ok-fg, #15803d)' }}>{note}</div>}
              {(statement?.warnings || []).length > 0 && (
                <div style={{ ...card, padding: '8px 12px', borderColor: '#b45309', display: 'grid', gap: 4 }}>
                  {statement.warnings.map((w) => (
                    <div key={w} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.8rem', color: '#92400e' }}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{w}</div>
                  ))}
                </div>
              )}

              <div style={{ opacity: working && section !== 'statement' ? 0.6 : 1 }}>
                {/* Oct 6 (Charmi): a skeleton while the statement is read, never a blank or stale page. */}
                {section === 'statement' && (working || !statement) && (
                  <div aria-busy="true" aria-label="Loading the statement" style={{ display: 'grid', gap: 10 }}>
                    <SkeletonBlocks count={1} height={64} />
                    <SkeletonBlocks count={6} height={28} />
                  </div>
                )}
                {section === 'statement' && statement && !working && <Summary statement={statement} past={past} nameOf={nameOf} onReprint={reprint} />}
                {section === 'borrower' && <Borrower profile={profile} canEdit={canEdit} onSave={saveProfile} />}
                {['asset', 'liability', 'real_estate'].includes(section) && (
                  <Lines section={section} profile={profile} categories={categories[section]} allCategories={allCategories} figures={figures} asOf={asOf} canEdit={canEdit}
                    onBulk={() => setBulk({ section })} onMove={move} onReorder={reorder}
                    onAdd={(category) => setEditing({ section, category, label: '', institution: '', accountRef: '', ownershipPct: 100, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 0, manualAsOf: asOf, details: {}, notes: '' })}
                    onEdit={(l) => setEditing({ ...l, institution: l.source === 'ledger' && !l.details?.institutionManual ? (figures.get(l.id)?.institution ?? l.institution) : l.institution })}
                    onDelete={(l) => api.deletePfsLine(profile.id, l.id).then(() => refresh(profile.id, asOf)).catch((e) => setError(e?.message || 'Could not remove the line.'))} />
                )}
                {section === 'schedules' && statement && <Schedules statement={statement} profile={profile} />}
                {section === 'history' && <History profile={profile} canEdit={canEdit} onSave={saveProfile} />}
                {section === 'history' && <div style={{ marginTop: 10 }}><PfsCoExecutiveProfile key={profile.id} profile={profile} canEdit={canEdit} onLocked={locks.markLocked} /></div>}
                {section === 'affiliated' && <PfsAffiliated key={profile.id} profile={profile} canEdit={canEdit} onLocked={locks.markLocked} />}
              </div>
            </>
          )}
        </div>
      </div>
      {editing && (
        <LineEditor line={editing} categories={categories[editing.section]} asOf={asOf} onClose={() => setEditing(null)}
          onSave={(body) => (editing.id ? api.updatePfsLine(profile.id, editing.id, body) : api.addPfsLine(profile.id, body)).then(() => { setEditing(null); return refresh(profile.id, asOf); })} />
      )}
      {bulk && (
        <LedgerBulkAdd section={bulk.section} categories={categories[bulk.section]} asOf={asOf} onClose={() => setBulk(null)}
          onSave={(body) => api.addPfsLinesBulk(profile.id, body).then((r) => { setBulk(null); setNote(`${r.added} ${r.added === 1 ? 'line' : 'lines'} added from the ledger.`); return refresh(profile.id, asOf); })} />
      )}
      {sending && profile && (
        <SendReportDialog mode={sending} title={`Personal Financial Statement - ${profile.displayName || profile.name} - ${formatDate(asOf)}`}
          baseName={`PFS_${profile.name.replace(/[^A-Za-z0-9]+/g, '-')}_${asOf}`} what="statement" formats={['pdf', 'excel']}
          makeFile={sendFile} onClose={() => setSending(null)} onDone={(text) => { setSending(null); setNote(`${text} The statement was kept on record.`); }} />
      )}
      {creating && (
        <NewGuarantor onClose={() => setCreating(false)}
          onCreate={(body) => api.createPfsProfile(body).then((p) => loadProfiles().then(() => { locks.markOpen(p.id, new Date(Date.now() + 30 * 60_000).toISOString()); setCreating(false); setOpenId(p.id); setSection('borrower'); }))} />
      )}
      {showLog && <PfsAccessLog files={profiles || []} initialFileId={openId} onClose={() => setShowLog(false)} />}
    </AsyncSection>
  );
}

// The first page (Charmi, 10/04: "You need to build out the first page of our
// PFS"): the bank-style Statement of Financial Condition - the names and the
// date, every asset and liability line of a bank's form with the share owned
// and the amount, the totals and net worth, contingent liabilities, and the
// year's income from the schedules when there are any. Page 1 of the PDF and
// the first sheet of the workbook say the same. Then the statements produced.
function Summary({ statement, past, nameOf, onReprint }) {
  const cond = conditionOf(statement);
  const KIND_TEXT = { individual: 'Individual', joint: 'Joint', trust: 'Trust' };
  const rows = (list) => list.map((r) => (
    <tr key={r.key || r.label}>
      <td>{r.label}</td>
      <td className="acct-num" style={{ color: 'var(--text-secondary)' }}>{r.count ? r.ownership : ''}</td>
      <td className="acct-num">{r.count || r.amount ? <Amount value={r.amount} /> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
    </tr>
  ));
  const head = (title) => (
    <thead><tr><th scope="col">{title}</th><th scope="col" className="acct-num" style={{ width: 110 }}>Ownership</th><th scope="col" className="acct-num" style={{ width: 150 }}>Amount</th></tr></thead>
  );
  const a = cond.contingentAnswer;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <section aria-label="Statement of Financial Condition" style={{ ...card, padding: '14px 16px', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...label, color: 'var(--wk-brand, #2b45e1)', marginBottom: 2 }}>Statement of Financial Condition</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>{statement.profile?.displayName || statement.profile?.name}</div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>As of {formatDate(statement.asOf)} · {KIND_TEXT[statement.profile?.kind] || 'Individual'} statement · amounts at the share owned</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={label}>Net Worth</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: statement.totals.netWorth < 0 ? 'var(--bad-fg, #dc2626)' : 'var(--text-primary)' }}><Amount value={statement.totals.netWorth} /></div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            {head('Assets')}
            <tbody>
              {rows(cond.assets)}
              <tr className="acct-grand"><td>Total Assets</td><td /><td className="acct-num"><Amount value={cond.totals.assets} /></td></tr>
            </tbody>
          </table>
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            {head('Liabilities')}
            <tbody>
              {rows(cond.liabilities)}
              <tr className="acct-grand"><td>Total Liabilities</td><td /><td className="acct-num"><Amount value={cond.totals.liabilities} /></td></tr>
              <tr className="acct-grand"><td>Net Worth</td><td /><td className="acct-num"><Amount value={statement.totals.netWorth} /></td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>Total Liabilities and Net Worth</td><td /><td className="acct-num"><Amount value={cond.totals.liabilities + statement.totals.netWorth} /></td></tr>
            </tbody>
          </table>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
          <div>
            <div style={label}>Contingent Liabilities</div>
            {cond.contingent.length > 0 ? (
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead><tr><th scope="col">Guarantee</th><th scope="col">Lender</th><th scope="col" className="acct-num">Ownership</th><th scope="col" className="acct-num">Amount</th></tr></thead>
                <tbody>
                  {cond.contingent.map((x, i) => <tr key={i}><td title={x.notes || undefined}>{x.label}</td><td>{x.institution}</td><td className="acct-num"><Figure text={pct(x.ownershipPct)} /></td><td className="acct-num"><Amount value={x.amount} /></td></tr>)}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {a?.answer === 'Yes' ? `Guarantor, co-maker or endorser on other debt: Yes${a.note ? ` - ${a.note}` : ''}.` : a?.answer === 'No' ? 'None. Not a guarantor, co-maker or endorser on any other debt.' : 'None listed. Add a guarantee under Liabilities > Contingent Liabilities; it is listed here, never added into the total.'}
              </div>
            )}
          </div>
          {cond.income && (
            <div>
              <div style={label}>Annual Income {cond.income.year}</div>
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <tbody>
                  {cond.income.lines.map((x) => <tr key={x.key}><td>{x.label}</td><td className="acct-num"><Amount value={x.amount} /></td></tr>)}
                  <tr className="acct-grand"><td>Total Annual Income</td><td className="acct-num"><Amount value={cond.income.total} /></td></tr>
                </tbody>
              </table>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>At the share owned, from the Schedules tab.</div>
            </div>
          )}
        </div>
      </section>
      <div style={{ ...card, padding: 12 }}>
        <div style={label}>Statements Produced</div>
        {!past.length && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>None yet. Every export keeps the statement exactly as it was sent.</div>}
        {past.length > 0 && (
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead><tr><th scope="col">As Of</th><th scope="col">Produced</th><th scope="col">By</th><th scope="col" className="acct-num">Net Worth</th><th scope="col" aria-label="Open" /></tr></thead>
            <tbody>
              {past.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.asOf)}</td><td>{formatDateTime(s.generatedAt)}</td><td>{nameOf(s.generatedBy)}</td><td className="acct-num"><Amount value={s.netWorth} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button type="button" className="acct-drill" onClick={() => onReprint(s, 'pdf')}>Open PDF</button>
                    <button type="button" className="acct-drill" style={{ marginLeft: 10 }} onClick={() => onReprint(s, 'xlsx')}>Open Excel</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Borrower({ profile, canEdit, onSave }) {
  const [name, setName] = useState(profile.name);
  const [kind, setKind] = useState(profile.kind);
  const [details, setDetails] = useState(profile.details || {});
  const [photo, setPhoto] = useState(profile.photo || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify([name, kind, details, photo]) !== JSON.stringify([profile.name, profile.kind, profile.details || {}, profile.photo || '']);
  // The form follows the profile it shows - but never over what is being
  // typed. A statement refresh behind this form (the date, a line, a second
  // tab) used to hand back a new profile object and reset every field
  // (Charmi, 10/02: "I have added information twice here and it is not
  // taking it"). Now only a DIFFERENT guarantor, or a clean form, reloads.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const shownId = useRef(profile.id);
  useEffect(() => {
    if (shownId.current === profile.id && dirtyRef.current) return;
    shownId.current = profile.id;
    setName(profile.name); setKind(profile.kind); setDetails(profile.details || {}); setPhoto(profile.photo || ''); setError('');
  }, [profile]);
  const members = details.members || [];
  const set = (k, v) => setDetails((d) => ({ ...d, [k]: v }));
  // The photo is drawn small on the cover, so it is kept small: at most 320
  // pixels on its long side, as a JPEG.
  const pick = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 320 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        setPhoto(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  const onPaste = (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f && canEdit) { e.preventDefault(); pick(f); } };
  const save = () => {
    setBusy(true);
    setError('');
    setSaved(false);
    onSave({ name, kind, details, photo })
      .then(() => { dirtyRef.current = false; setSaved(true); })
      .catch((e) => setError(e?.message || 'Could not save.'))
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }} onPaste={onPaste}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) minmax(140px, 1fr)', gap: 10 }}>
        <div>
          <label style={label} htmlFor="pfs-name">Name on the Statement</label>
          <input id="pfs-name" type="text" value={name} disabled={!canEdit} maxLength={160} onChange={(e) => setName(e.target.value)} style={{ ...control, width: '100%' }} />
        </div>
        <div>
          <label style={label} htmlFor="pfs-kind">Statement Type</label>
          <select id="pfs-kind" value={kind} disabled={!canEdit} onChange={(e) => setKind(e.target.value)} style={{ ...control, width: '100%' }}>
            {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label style={label} htmlFor="pfs-spouse">Spouse or Co-Borrower</label>
        <input id="pfs-spouse" type="text" value={details.spouse || ''} disabled={!canEdit} maxLength={160} placeholder="Printed with the name, as in Neil R. Kadakia and Archana Kadakia"
          onChange={(e) => set('spouse', e.target.value)} style={{ ...control, width: '100%', maxWidth: 520 }} />
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Leave blank for a statement in one name. The spouse signs the statement too.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {DETAILS.map(([k, text, type]) => (
          <div key={k}>
            <label style={label} htmlFor={`pfs-${k}`}>{text}</label>
            <input id={`pfs-${k}`} type={type || 'text'} value={details[k] || ''} disabled={!canEdit} maxLength={k === 'ssn_last4' ? 4 : 200} inputMode={k === 'ssn_last4' ? 'numeric' : undefined}
              onChange={(e) => set(k, k === 'ssn_last4' ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value)} style={{ ...control, width: '100%' }} />
            {k === 'ssn_last4' && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Only the last four digits are kept. It prints as XXX-XX-1234.</div>}
          </div>
        ))}
      </div>
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
        <div>
          <div style={{ ...label, marginBottom: 2 }}>Co-Borrower</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>The spouse or co-borrower on the statement, printed under the borrower. Leave the name blank when there is none.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {CO_BORROWER.map(([k, text, type]) => (
            <div key={k}>
              <label style={label} htmlFor={`pfs-co-${k}`}>{text}</label>
              <input id={`pfs-co-${k}`} type={type || 'text'} value={details.coBorrower?.[k] || ''} disabled={!canEdit} maxLength={k === 'ssn_last4' ? 4 : 200} inputMode={k === 'ssn_last4' ? 'numeric' : undefined}
                onChange={(e) => set('coBorrower', { ...(details.coBorrower || {}), [k]: k === 'ssn_last4' ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value })} style={{ ...control, width: '100%' }} />
              {k === 'ssn_last4' && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Last four digits only; a longer number is refused.</div>}
            </div>
          ))}
        </div>
      </div>
      {kind !== 'individual' && (
        <div>
          <div style={label}>Parties to This Statement</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {members.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <input type="text" value={m.name} disabled={!canEdit} placeholder="Name" aria-label={`Name of party ${i + 1}`} onChange={(e) => set('members', members.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} style={{ ...control, flex: 2 }} />
                <input type="text" value={m.role || ''} disabled={!canEdit} placeholder="Role, such as Trustee" aria-label={`Role of party ${i + 1}`} onChange={(e) => set('members', members.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)))} style={{ ...control, flex: 1 }} />
                {canEdit && <button type="button" style={icon} aria-label={`Remove party ${i + 1}`} onClick={() => set('members', members.filter((_, k) => k !== i))}><Trash2 size={14} /></button>}
              </div>
            ))}
            {canEdit && members.length < 6 && <button type="button" className="secondary-btn" style={{ fontSize: '0.76rem', justifySelf: 'start', display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={() => set('members', [...members, { name: '', role: '' }])}><Plus size={13} /> Add Party</button>}
          </div>
        </div>
      )}
      <div>
        <div style={label}>Photo on the Cover</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {photo ? <img src={photo} alt={`${name} as shown on the cover`} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)' }} />
            : <div style={{ width: 72, height: 72, borderRadius: 8, border: '1px dashed var(--border-color)', display: 'grid', placeItems: 'center', fontSize: '0.7rem', color: 'var(--text-muted)' }}>No photo</div>}
          {canEdit && (
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <label className="secondary-btn" style={{ fontSize: '0.76rem', cursor: 'pointer' }}>
                  Choose Photo<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
                </label>
                {photo && <button type="button" className="secondary-btn" style={{ fontSize: '0.76rem' }} onClick={() => setPhoto('')}>Remove</button>}
              </div>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>or press Ctrl+V to paste one</span>
            </div>
          )}
        </div>
      </div>
      {error && <div style={bad}>{error}</div>}
      {saved && !dirty && !error && <div style={{ fontSize: '0.78rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}>Saved. The statement reads these details now.</div>}
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy || !name.trim()} style={{ fontSize: '0.8rem' }}>{busy ? 'Saving...' : 'Save Changes'}</button>
          {dirty && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}

function History({ profile, canEdit, onSave }) {
  const [history, setHistory] = useState(profile.history || []);
  const [text, setText] = useState(profile.executiveProfile || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setHistory(profile.history || []); setText(profile.executiveProfile || ''); }, [profile]);
  const dirty = JSON.stringify([history, text]) !== JSON.stringify([profile.history || [], profile.executiveProfile || '']);
  const set = (i, patch) => setHistory((h) => h.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = () => {
    setBusy(true);
    setError('');
    onSave({ history, executiveProfile: text }).catch((e) => setError(e?.message || 'Could not save.')).finally(() => setBusy(false));
  };
  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 12 }}>
      <div>
        <div style={label}>Financial History - answered once, printed every time</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {history.map((h, i) => (
            <div key={h.question} style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 2fr) 110px minmax(180px, 2fr)', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: '0.82rem' }}>{h.question}</span>
              <select value={h.answer || ''} disabled={!canEdit} aria-label={`Answer: ${h.question}`} onChange={(e) => set(i, { answer: e.target.value })} style={control}>
                <option value="">Not answered</option><option value="No">No</option><option value="Yes">Yes</option>
              </select>
              <input type="text" value={h.note || ''} disabled={!canEdit} maxLength={400} placeholder={h.answer === 'Yes' ? 'Explain' : 'Note, if any'} aria-label={`Note: ${h.question}`} onChange={(e) => set(i, { note: e.target.value })} style={control} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <label style={label} htmlFor="pfs-exec">Executive Profile - {profile.name}</label>
        <textarea id="pfs-exec" value={text} disabled={!canEdit} maxLength={6000} rows={9} onChange={(e) => setText(e.target.value)}
          placeholder="Who they are, what they have built, and their history with lenders."
          style={{ ...control, width: '100%', height: 'auto', padding: 9, lineHeight: 1.5, resize: 'vertical' }} />
      </div>
      {error && <div style={bad}>{error}</div>}
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy} style={{ fontSize: '0.8rem' }}>{busy ? 'Saving...' : 'Save Changes'}</button>
          {dirty && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}

// The lines of one section, grouped the way the statement prints them, each
// with its figure for the date picked.
// Oct 6 (Charmi, 10/04): rows are put in order within their category - drag
// a row by its handle, or use the arrows (the keyboard way) - and the order is
// kept for the guarantor, so the statement and its files print it that way.
function Lines({ section, profile, categories, allCategories = [], figures, asOf, canEdit, onAdd, onEdit, onDelete, onBulk, onMove, onReorder }) {
  const [confirm, setConfirm] = useState('');
  const [moving, setMoving] = useState('');     // the line whose "Move to..." is open
  const [dragging, setDragging] = useState(null);   // { id, category } of the row being dragged
  const [over, setOver] = useState('');
  const real = section === 'real_estate';
  const ordered = (rows, from, to) => { const n = rows.map((l) => l.id); const [id] = n.splice(from, 1); n.splice(to, 0, id); return n; };
  const shift = (rows, i, by) => { const j = i + by; if (j < 0 || j >= rows.length || !onReorder) return; onReorder(ordered(rows, i, j)); };
  const drop = (rows, target) => {
    const from = rows.findIndex((x) => x.id === dragging?.id);
    const to = rows.findIndex((x) => x.id === target);
    setDragging(null);
    setOver('');
    if (from < 0 || to < 0 || from === to || !onReorder) return;
    onReorder(ordered(rows, from, to));
  };
  const lines = profile.lines.filter((l) => l.section === section);
  const bulkHint = real
    ? 'Pick an entity: its land and building accounts become property lines that read the ledger, each with its mortgage account as the loan.'
    : 'Pick an entity and its accounts by GL group - every account becomes a line that reads the ledger for any date.';
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {canEdit && onBulk && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="primary-btn" onClick={onBulk} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' }}>
            <Database size={14} /> Add From the Ledger
          </button>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{bulkHint}</span>
        </div>
      )}
      {categories.map((c) => {
        const rows = lines.filter((l) => l.category === c.key);
        const total = rows.reduce((s, l) => s + (real ? (figures.get(l.id)?.equity || 0) : (figures.get(l.id)?.adjusted || 0)), 0);
        return (
          <div key={c.key} style={{ ...card, padding: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: rows.length ? 6 : 0 }}>
              <strong style={{ fontSize: '0.86rem' }}>{c.label}</strong>
              {canEdit && <button type="button" className="secondary-btn" onClick={() => onAdd(c.key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px' }}><Plus size={12} /> Add</button>}
            </div>
            {rows.length > 0 && (
              <div className="acct-lines-wrap" style={{ maxHeight: 'none' }}>
                <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                  <thead>
                    <tr>
                      {canEdit && <th scope="col" aria-label="Order" style={{ width: 22 }} />}
                      <th scope="col">{real ? 'Property' : 'Description'}</th><th scope="col">{real ? 'Legal Owner' : 'Institution'}</th><th scope="col">Figure From</th>
                      <th scope="col" className="acct-num">Owned</th>
                      {real ? <><th scope="col" className="acct-num">Market Value</th><th scope="col" className="acct-num">Loan Balance</th><th scope="col" className="acct-num">Equity</th></>
                        : <><th scope="col" className="acct-num">Balance</th><th scope="col" className="acct-num">Adjusted</th></>}
                      <th scope="col" aria-label="Change" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l, i) => {
                      const f = figures.get(l.id);
                      const from = l.source === 'ledger' ? `Ledger · ${l.ledgerEntity} · ${l.ledgerAccounts.join(', ')}` : `Kept by hand${l.manualAsOf ? ` · ${formatDate(l.manualAsOf)}` : ''}`;
                      const dropping = dragging && dragging.category === c.key && over === l.id && dragging.id !== l.id;
                      return (
                        <tr key={l.id}
                          onDragOver={canEdit && dragging?.category === c.key ? (e) => { e.preventDefault(); if (over !== l.id) setOver(l.id); } : undefined}
                          onDrop={canEdit && dragging?.category === c.key ? (e) => { e.preventDefault(); drop(rows, l.id); } : undefined}
                          style={{ opacity: dragging?.id === l.id ? 0.45 : 1, boxShadow: dropping ? 'inset 0 2px 0 var(--wk-brand, #2b45e1)' : undefined }}>
                          {canEdit && (
                            <td style={{ whiteSpace: 'nowrap', padding: '0 2px' }}>
                              <span draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', l.id); } catch { /* some browsers refuse */ } setDragging({ id: l.id, category: c.key }); }}
                                onDragEnd={() => { setDragging(null); setOver(''); }} title="Drag to reorder"
                                style={{ cursor: 'grab', display: 'inline-flex', color: 'var(--text-muted)', verticalAlign: 'middle' }}><GripVertical size={14} /></span>
                            </td>
                          )}
                          <td title={l.notes || undefined}>{l.label}{l.accountRef ? <span className="acct-code" style={{ marginLeft: 8 }}>{l.accountRef}</span> : null}</td>
                          {/* Oct 6 (Charmi): the bank, from the bank account linked to the GL - the statement's own reading. */}
                          <td>{real ? (l.details?.legal_owner || '') : (f ? f.institution : l.institution)}</td>
                          <td style={{ color: 'var(--text-secondary)' }} title={from}>{from}</td>
                          <td className="acct-num"><Figure text={pct(l.ownershipPct)} /></td>
                          {real ? <><td className="acct-num"><Amount value={f?.valueAdjusted} /></td><td className="acct-num"><Amount value={f?.loanAdjusted} /></td><td className="acct-num"><Amount value={f?.equity} /></td></>
                            : <><td className="acct-num"><Amount value={f?.balance} /></td><td className="acct-num"><Amount value={f?.adjusted} /></td></>}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canEdit && (confirm === l.id ? (
                              <>
                                <button type="button" className="acct-drill" style={{ color: 'var(--bad-fg, #dc2626)', marginRight: 10 }} onClick={() => { setConfirm(''); onDelete(l); }}>Remove</button>
                                <button type="button" className="acct-drill" onClick={() => setConfirm('')}>Keep</button>
                              </>
                            ) : moving === l.id ? (
                              <select autoFocus value={`${l.section}:${l.category}`} aria-label={`Move ${l.label} to`} style={{ ...control, height: 26, fontSize: '0.76rem' }}
                                onBlur={() => setMoving('')}
                                onChange={(e) => { const [s, c] = e.target.value.split(':'); setMoving(''); if (s !== l.section || c !== l.category) onMove(l, s, c); }}>
                                {allCategories.map((g) => (
                                  <optgroup key={g.section} label={g.label}>
                                    {g.categories.map((c) => <option key={c.key} value={`${g.section}:${c.key}`}>{c.label}</option>)}
                                  </optgroup>
                                ))}
                              </select>
                            ) : (
                              <>
                                {rows.length > 1 && (
                                  <>
                                    <button type="button" style={{ ...icon, opacity: i === 0 ? 0.3 : 1 }} disabled={i === 0} aria-label={`Move ${l.label} up`} title="Move up" onClick={() => shift(rows, i, -1)}><ChevronUp size={14} /></button>
                                    <button type="button" style={{ ...icon, opacity: i === rows.length - 1 ? 0.3 : 1 }} disabled={i === rows.length - 1} aria-label={`Move ${l.label} down`} title="Move down" onClick={() => shift(rows, i, 1)}><ChevronDown size={14} /></button>
                                  </>
                                )}
                                <button type="button" style={icon} aria-label={`Move ${l.label}`} title="Move to..." onClick={() => setMoving(l.id)}><ArrowRightLeft size={14} /></button>
                                <button type="button" style={icon} aria-label={`Change ${l.label}`} onClick={() => onEdit(l)}><Pencil size={14} /></button>
                                <button type="button" style={icon} aria-label={`Remove ${l.label}`} onClick={() => setConfirm(l.id)}><Trash2 size={14} /></button>
                              </>
                            ))}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="acct-grand">
                      <td colSpan={(real ? 6 : 5) + (canEdit ? 1 : 0)}>Total {c.label}{real ? ' - Equity' : ''}</td>
                      <td className="acct-num"><Amount value={total} /></td><td />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {!rows.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Nothing listed.</div>}
          </div>
        );
      })}
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Figures are as of {formatDate(asOf)}. Adjusted = balance at the share owned.</div>
    </div>
  );
}

// Where one figure comes from: kept by hand, or read from the ledger (one
// entity, one or more of its balance sheet accounts).
function FigureSource({ value, onChange, asOf, idPrefix, manualLabel, asOfLabel = 'Figure Taken On' }) {
  const [entities, setEntities] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const ledger = value.source === 'ledger';
  useEffect(() => {
    if (!ledger || entities) return;
    api.getPfsLedgerEntities().then((d) => setEntities(d?.entities || [])).catch((e) => { setEntities([]); setError(e?.message || 'Could not load the entities.'); });
  }, [ledger, entities]);
  useEffect(() => {
    if (!ledger || !value.entity) { setAccounts(null); return undefined; }
    let alive = true;
    setAccounts(null);
    api.getPfsLedgerAccounts(value.entity, asOf)
      .then((d) => { if (alive) setAccounts(d?.accounts || []); })
      .catch((e) => { if (alive) { setAccounts([]); setError(e?.message || 'Could not load the accounts.'); } });
    return () => { alive = false; };
  }, [ledger, value.entity, asOf]);
  const picked = new Set(value.accounts || []);
  const shown = (accounts || []).filter((a) => { const s = q.trim().toLowerCase(); return !s || a.code.toLowerCase().includes(s) || a.title.toLowerCase().includes(s); });
  const sum = (accounts || []).filter((a) => picked.has(a.code)).reduce((s, a) => s + a.amount, 0);
  const toggle = (code) => { const n = new Set(picked); if (n.has(code)) n.delete(code); else n.add(code); onChange({ ...value, accounts: [...n] }); };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div role="radiogroup" aria-label="Where the figure comes from" style={{ display: 'flex', gap: 6 }}>
        {[['manual', 'Kept by Hand'], ['ledger', 'From the Ledger']].map(([k, text]) => (
          <button key={k} type="button" role="radio" aria-checked={value.source === k} onClick={() => onChange({ ...value, source: k })}
            style={{ ...control, cursor: 'pointer', fontWeight: value.source === k ? 700 : 500, border: `1px solid ${value.source === k ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: value.source === k ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: value.source === k ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
            {text}
          </button>
        ))}
      </div>
      {!ledger && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={label} htmlFor={`${idPrefix}-value`}>{manualLabel}</label>
            <AmountInput id={`${idPrefix}-value`} value={value.value ?? ''} onChange={(v) => onChange({ ...value, value: v == null ? '' : v })} style={{ ...control, width: '100%' }} />
          </div>
          {value.asOf !== undefined && (
            <div>
              <label style={label} htmlFor={`${idPrefix}-asof`}>{asOfLabel}</label>
              <input id={`${idPrefix}-asof`} type="date" value={value.asOf || ''} onChange={(e) => onChange({ ...value, asOf: e.target.value })} style={{ ...control, width: '100%' }} />
            </div>
          )}
        </div>
      )}
      {ledger && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>
            <label style={label} htmlFor={`${idPrefix}-entity`}>Entity</label>
            <select id={`${idPrefix}-entity`} value={value.entity || ''} onChange={(e) => onChange({ ...value, entity: e.target.value, accounts: [] })} style={{ ...control, width: '100%' }}>
              <option value="">{entities ? 'Pick an entity...' : 'Loading...'}</option>
              {(entities || []).map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
            </select>
          </div>
          {value.entity && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={label}>Accounts - balance as of {formatDate(asOf)}</span>
                <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{picked.size} picked · <Amount value={sum} /></span>
              </div>
              <div style={{ position: 'relative' }}>
                <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
                <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search account by name or code" aria-label="Search account by name or code" style={{ ...control, width: '100%', paddingLeft: 26 }} />
              </div>
              <div role="listbox" aria-multiselectable="true" aria-label="Accounts" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6, border: '1px solid var(--border-color)', borderRadius: 8, padding: 4, display: 'grid', gap: 1 }}>
                {!accounts && <SkeletonBlocks count={2} height={28} />}
                {shown.map((a) => (
                  <button key={a.code} type="button" role="option" aria-selected={picked.has(a.code)} onClick={() => toggle(a.code)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, background: picked.has(a.code) ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '4px 8px', font: 'inherit', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                    <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{picked.has(a.code) ? <Check size={14} /> : null}</span>
                    <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{a.code}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                    <Amount value={a.amount} />
                  </button>
                ))}
                {accounts && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 8 }}>{accounts.length ? 'No account matches.' : 'This entity has no balance sheet accounts as of this date.'}</div>}
              </div>
            </div>
          )}
        </div>
      )}
      {error && <div style={{ fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
    </div>
  );
}

// Which statement category a ledger account belongs to. The server's guess
// (`suggested`: the account's type, then its title, then its GL group - see
// classify_account in routers/pfs.py) when it has one for this section; the
// title alone otherwise. A suggestion the person can change per line.
export function suggestCategory(section, title, suggested = null, categories = []) {
  if (suggested?.section === section && suggested.category) return suggested.category;
  const t = (title || '').toLowerCase();
  if (section === 'real_estate') return categories[0]?.key || 'domestic_commercial';
  if (section === 'liability') {
    if (/credit card|\bamex\b|\bvisa\b|mastercard/.test(t)) return 'credit_card';
    if (/line of credit|\bloc\b|credit line|heloc/.test(t)) return 'loc';
    if (/\bauto\b|vehicle|car loan/.test(t)) return 'auto';
    if (/mortgage|loan|note payable|notes payable|n\/p/.test(t)) return 'business_loan';
    return 'other_liability';
  }
  if (/^\s*cash\s*$|petty cash|cash on hand|cash in hand/.test(t)) return 'cash';
  if (/401\s*k|\bira\b|roth|retirement|pension|\bsep\b|403|\bhsa\b/.test(t)) return 'retirement';
  if (/brokerage|etrade|e\*trade|webull|fidelity|schwab|robinhood|investment|stock|bond|mutual|vanguard|crypto|coinbase/.test(t)) return 'investment';
  if (/insurance|life policy|cash value/.test(t)) return 'insurance';
  if (/vehicle|automobile|\bauto\b|\bcar\b|boat/.test(t)) return 'vehicles';
  if (/jewel|watch|collectib|furniture|household/.test(t)) return 'personal';
  if (/checking|chkg|savings|bank|cash|money market|\bcd\b|venmo|paypal|treasur|earmarked|f&m/.test(t)) return 'bank';
  return 'other_holding';
}

// Add From the Ledger: one entity, its balance sheet accounts of this
// section grouped by GL code (the first three digits - Intacct's account
// groups), a tick per account or per group, a category and a share for each.
// Every tick becomes a line that reads the ledger (Neil, call of 09/29).
// Oct 2: on Liabilities and on Real Estate too. A real estate pick is a land
// or building account (the entity's asset side) that becomes a property line
// of the kind picked, with one of the entity's liability accounts as its
// mortgage, read from the ledger (Charmi, 10/01: "the wiring is not done
// here and also Real Estate").
function LedgerBulkAdd({ section, categories, asOf, onClose, onSave }) {
  const real = section === 'real_estate';
  const [entities, setEntities] = useState(null);
  const [entity, setEntity] = useState('');
  const [all, setAll] = useState(null);      // every balance sheet account of the entity
  const [q, setQ] = useState('');
  const [share, setShare] = useState(100);
  const [rows, setRows] = useState({});     // code -> { on, category, pct, loan }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accounts = useMemo(() => (all ? all.filter((a) => a.section === (real ? 'asset' : section)) : null), [all, real, section]);
  const loans = useMemo(() => (all || []).filter((a) => a.section === 'liability'), [all]);
  useEffect(() => {
    api.getPfsLedgerEntities().then((d) => setEntities(d?.entities || [])).catch((e) => { setEntities([]); setError(e?.message || 'Could not load the entities.'); });
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!entity) { setAll(null); return undefined; }
    let alive = true;
    setAll(null);
    setRows({});
    api.getPfsLedgerAccounts(entity, asOf)
      .then((d) => { if (alive) setAll(d?.accounts || []); })
      .catch((e) => { if (alive) { setAll([]); setError(e?.message || 'Could not load the accounts.'); } });
    return () => { alive = false; };
  }, [entity, asOf]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (accounts || []).filter((a) => !s || a.code.toLowerCase().includes(s) || a.title.toLowerCase().includes(s));
  }, [accounts, q]);
  // GL groups: accounts sharing their first three digits.
  const groups = useMemo(() => {
    const m = new Map();
    shown.forEach((a) => { const g = a.code.slice(0, 3); if (!m.has(g)) m.set(g, []); m.get(g).push(a); });
    return [...m.entries()];
  }, [shown]);
  // A real estate pick starts ticked when the ledger says it is land or a
  // building; its mortgage starts as the entity's first mortgage-like account.
  const firstLoan = loans.find((a) => /mortgage/i.test(a.title))?.code || '';
  const state = (a) => rows[a.code] || { on: false, category: suggestCategory(section, a.title, a.suggested, categories), pct: share, loan: real && a.suggested?.section === 'real_estate' ? firstLoan : '' };
  const setRow = (code, patch) => setRows((r) => ({ ...r, [code]: { ...state((accounts || []).find((x) => x.code === code) || { code, title: '' }), ...patch } }));
  const toggleGroup = (list) => {
    const allOn = list.every((a) => state(a).on);
    setRows((r) => { const n = { ...r }; list.forEach((a) => { n[a.code] = { ...state(a), on: !allOn }; }); return n; });
  };
  const picked = (accounts || []).filter((a) => state(a).on);
  const total = picked.reduce((s, a) => s + a.amount * (Number(state(a).pct) || 0) / 100, 0);
  const entityName = (entities || []).find((e) => e.code === entity)?.name || '';
  const save = () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError('');
    onSave({
      section, category: categories[0]?.key, entity, entityName, ownershipPct: Number(share) || 0,
      accounts: picked.map((a) => ({ code: a.code, label: a.title, category: state(a).category, ownershipPct: Number(state(a).pct) || 0, ...(real ? { loanAccount: state(a).loan || '' } : {}) })),
    }).catch((e) => { setError(e?.message || 'Could not add the lines.'); setBusy(false); });
  };
  const catLabel = (k) => categories.find((c) => c.key === k)?.label || k;
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Add from the ledger" onClick={(e) => e.stopPropagation()} style={{ maxWidth: real ? 980 : 860 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Add {SECTION_LABEL[section]} From the Ledger</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {real ? 'Each land or building account picked becomes a property line that reads the ledger; its mortgage account is the loan.' : 'Each account picked becomes a line that reads the ledger as of the statement date.'} Balances shown are as of {formatDate(asOf)}.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 2fr) minmax(120px, 1fr)', gap: 10 }}>
            <div>
              <label style={label} htmlFor="pfs-bulk-entity">Entity</label>
              <select id="pfs-bulk-entity" value={entity} onChange={(e) => setEntity(e.target.value)} style={{ ...control, width: '100%' }}>
                <option value="">{entities ? 'Pick an entity...' : 'Loading...'}</option>
                {(entities || []).map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="pfs-bulk-share">Share Owned (%) for New Lines</label>
              <input id="pfs-bulk-share" type="number" min="0" max="100" step="0.01" value={share}
                onChange={(e) => { setShare(e.target.value); setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, pct: e.target.value }]))); }} style={{ ...control, width: '100%' }} />
            </div>
          </div>
          {entity && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
                  <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
                  <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search account by name or code" aria-label="Search account by name or code" style={{ ...control, width: '100%', paddingLeft: 26 }} />
                </div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{picked.length} picked · at share <Amount value={total} /></span>
                {shown.length > 0 && (
                  <button type="button" onClick={() => toggleGroup(shown)} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.76rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', padding: 0 }}>
                    {shown.every((a) => state(a).on) ? 'Clear All' : 'Select All'}
                  </button>
                )}
              </div>
              {!accounts && <SkeletonBlocks count={3} height={28} />}
              {accounts && !shown.length && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: 8 }}>{accounts.length ? 'No account matches.' : `This entity has no ${real ? 'asset' : section} accounts with a balance as of this date.`}</div>}
              {groups.length > 0 && (
                <div className="acct-lines-wrap" style={{ maxHeight: 'min(440px, 50vh)' }}>
                  <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                    <thead>
                      <tr><th scope="col" aria-label="Pick" style={{ width: 30 }} /><th scope="col">Account</th><th scope="col">Listed Under</th>{real && <th scope="col">Mortgage Account</th>}<th scope="col" className="acct-num">Share %</th><th scope="col" className="acct-num">Balance</th></tr>
                    </thead>
                    <tbody>
                      {groups.map(([g, list]) => (
                        <Fragment key={g}>
                          <tr className="acct-section" onClick={() => toggleGroup(list)} title="Click to pick or clear this GL group">
                            <td><input type="checkbox" aria-label={`GL group ${g}`} checked={list.every((a) => state(a).on)} onChange={() => toggleGroup(list)} onClick={(e) => e.stopPropagation()} /></td>
                            <td colSpan={real ? 4 : 3}>GL group {g}xx · {list.length} {list.length === 1 ? 'account' : 'accounts'}</td>
                            <td className="acct-num"><Amount value={list.reduce((s, a) => s + a.amount, 0)} /></td>
                          </tr>
                          {list.map((a) => {
                            const st = state(a);
                            return (
                              <tr key={a.code}>
                                <td><input type="checkbox" aria-label={`${a.code} ${a.title}`} checked={st.on} onChange={(e) => setRow(a.code, { on: e.target.checked })} /></td>
                                <td><span className="acct-code">{a.code}</span>{a.title}{a.suggested && a.suggested.section !== section && <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>looks like {SECTION_LABEL[a.suggested.section]?.toLowerCase()}</span>}</td>
                                <td>
                                  <select value={st.category} aria-label={`Category for ${a.code}`} onChange={(e) => setRow(a.code, { category: e.target.value, on: true })} style={{ ...control, height: 26, fontSize: '0.76rem' }}>
                                    {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                                  </select>
                                </td>
                                {real && (
                                  <td>
                                    <select value={st.loan || ''} aria-label={`Mortgage account for ${a.code}`} onChange={(e) => setRow(a.code, { loan: e.target.value, on: true })} style={{ ...control, height: 26, fontSize: '0.76rem', maxWidth: 220 }}>
                                      <option value="">No loan on the ledger</option>
                                      {loans.map((x) => <option key={x.code} value={x.code}>{x.code} {x.title}</option>)}
                                    </select>
                                  </td>
                                )}
                                <td className="acct-num"><input type="number" min="0" max="100" step="0.01" value={st.pct} aria-label={`Share for ${a.code}`} onChange={(e) => setRow(a.code, { pct: e.target.value, on: true })} style={{ ...control, height: 26, width: 84, fontSize: '0.76rem', textAlign: 'right' }} /></td>
                                <td className="acct-num"><Amount value={a.amount} /></td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {picked.length > 0 && (
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                  Listed under: {[...new Set(picked.map((a) => state(a).category))].map(catLabel).join(', ')}. An account already on this statement from the same entity is skipped.
                </div>
              )}
            </div>
          )}
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={!picked.length || busy}>{busy ? 'Adding...' : `Add ${picked.length || ''} ${picked.length === 1 ? 'Line' : 'Lines'}`.replace('  ', ' ')}</button>
        </div>
      </div>
    </div>
  );
}

function LineEditor({ line, categories, asOf, onClose, onSave }) {
  const real = line.section === 'real_estate';
  const [l, setL] = useState(line);
  // Personal Holdings carry what Jewelry & Personal Property did (Oct 6): an
  // appraised value, the appraisal date, and who appraised it.
  const jewelry = l.category === 'personal' || l.category === 'jewelry';
  // The entity whose P&L is this line's Schedule E (a property) or Schedule C
  // (a business interest), when the figure itself does not read the ledger.
  const scheduled = real || (l.section === 'asset' && l.category === 'business');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (p) => setL((x) => ({ ...x, ...p }));
  const loan = { source: 'manual', entity: '', accounts: [], value: 0, ...(l.details?.loan || {}) };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const figure = { source: l.source, entity: l.ledgerEntity, accounts: l.ledgerAccounts, value: l.manualValue, asOf: l.manualAsOf };
  const ready = l.label.trim() && (l.source === 'manual' || (l.ledgerEntity && l.ledgerAccounts.length)) && (!real || loan.source === 'manual' || (loan.entity && loan.accounts.length));
  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    onSave({
      section: l.section, category: l.category, label: l.label.trim(), institution: l.institution, accountRef: l.accountRef, ownershipPct: Number(l.ownershipPct) || 0,
      source: l.source, ledgerEntity: l.ledgerEntity, ledgerAccounts: l.ledgerAccounts, manualValue: Number(l.manualValue) || 0, manualAsOf: l.manualAsOf || '',
      details: real ? { ...l.details, loan: { ...loan, value: Number(loan.value) || 0 } } : (l.details || {}), sort: l.sort || 0, notes: l.notes || '',
    }).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={line.id ? `Change ${line.label}` : 'Add a line'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{line.id ? 'Change Line' : `Add to ${categories.find((c) => c.key === l.category)?.label || 'the Statement'}`}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <label style={label} htmlFor="pfs-l-label">{real ? 'Property' : 'Description'}</label>
              <input id="pfs-l-label" type="text" value={l.label} maxLength={160} autoFocus onChange={(e) => set({ label: e.target.value })} style={{ ...control, width: '100%' }} />
            </div>
            <div>
              <label style={label} htmlFor="pfs-l-cat">Listed Under</label>
              <select id="pfs-l-cat" value={l.category} onChange={(e) => set({ category: e.target.value })} style={{ ...control, width: '100%' }}>
                {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
          </div>
          {!real && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <div>
                <label style={label} htmlFor="pfs-l-inst">Institution</label>
                {/* Oct 6: a ledger line's Institution is read from the bank account
                    linked to its GL; typing one here keeps what was typed instead. */}
                <input id="pfs-l-inst" type="text" value={l.institution} maxLength={160} placeholder={l.source === 'ledger' ? 'The bank linked to the account' : ''}
                  onChange={(e) => set({ institution: e.target.value, details: { ...(l.details || {}), institutionManual: !!e.target.value.trim() } })} style={{ ...control, width: '100%' }} />
              </div>
              <div>
                <label style={label} htmlFor="pfs-l-ref">Account Ending In</label>
                <input id="pfs-l-ref" type="text" value={l.accountRef} maxLength={40} onChange={(e) => set({ accountRef: e.target.value })} style={{ ...control, width: '100%' }} />
              </div>
            </div>
          )}
          {real && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
              {RE_DETAILS.map(([k, text]) => (
                <div key={k}>
                  <label style={label} htmlFor={`pfs-l-${k}`}>{text}</label>
                  <input id={`pfs-l-${k}`} type="text" value={l.details?.[k] || ''} maxLength={200} onChange={(e) => set({ details: { ...l.details, [k]: e.target.value } })} style={{ ...control, width: '100%' }} />
                </div>
              ))}
            </div>
          )}
          <div style={{ maxWidth: 220 }}>
            <label style={label} htmlFor="pfs-l-pct">Share Owned (%)</label>
            <input id="pfs-l-pct" type="number" min="0" max="100" step="0.01" value={l.ownershipPct} onChange={(e) => set({ ownershipPct: e.target.value })} style={{ ...control, width: '100%' }} />
          </div>
          <div>
            <div style={label}>{real ? 'Market Value' : jewelry ? 'Appraised Value' : 'Balance'}</div>
            {jewelry && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: 6 }}>Personal holdings - jewelry, art, furnishings, personal property - are kept by hand: the appraised value and the date of the appraisal.</div>}
            <FigureSource idPrefix="pfs-fig" asOf={asOf} manualLabel={real ? 'Fair Market Value' : jewelry ? 'Appraised Value' : 'Balance'} asOfLabel={jewelry ? 'Appraisal Date' : 'Figure Taken On'} value={figure}
              onChange={(f) => set({ source: f.source, ledgerEntity: f.entity || '', ledgerAccounts: f.accounts || [], manualValue: f.value, manualAsOf: f.asOf })} />
          </div>
          {jewelry && (
            <div style={{ maxWidth: 320 }}>
              <label style={label} htmlFor="pfs-l-appraiser">Appraised By</label>
              <input id="pfs-l-appraiser" type="text" value={l.details?.appraiser || ''} maxLength={160} onChange={(e) => set({ details: { ...l.details, appraiser: e.target.value } })} style={{ ...control, width: '100%' }} />
            </div>
          )}
          {scheduled && (
            <div style={{ maxWidth: 420 }}>
              <label style={label} htmlFor="pfs-l-sched">{real ? 'Entity for Schedule E' : 'Entity for Schedule C'}</label>
              <EntityPick id="pfs-l-sched" value={l.details?.schedule_entity || ''} onChange={(v) => set({ details: { ...l.details, schedule_entity: v } })}
                blank={l.source === 'ledger' && l.ledgerEntity ? `Same as the figure (${l.ledgerEntity})` : 'No schedule'} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>The entity whose ledger carries this {real ? "property's rents and expenses" : "business's receipts and expenses"}; its P&L for the calendar year becomes the schedule.</div>
            </div>
          )}
          {real && (
            <div>
              <div style={label}>Loan Balance</div>
              <FigureSource idPrefix="pfs-loan" asOf={asOf} manualLabel="Loan Balance" value={loan} onChange={(f) => set({ details: { ...l.details, loan: f } })} />
            </div>
          )}
          <div>
            <label style={label} htmlFor="pfs-l-notes">Note</label>
            <input id="pfs-l-notes" type="text" value={l.notes || ''} maxLength={400} onChange={(e) => set({ notes: e.target.value })} style={{ ...control, width: '100%' }} />
          </div>
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={!ready || busy}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// New Guarantor (Charmi, 10/01: "how can we see Rajesh & Darshana Kadakia,
// Sahil & Charmi Desai"): the name is prefilled from Nexus People (the
// curated directory, never the GAL), a Joint statement takes the second
// person too, and both names print on the statement.
function NewGuarantor({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('individual');
  const [second, setSecond] = useState('');
  const [email, setEmail] = useState('');
  const [people, setPeople] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.getPeopleDirectory().then((list) => setPeople(list || [])).catch(() => setPeople([]));
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pickPerson = (e, who) => {
    const p = (people || []).find((x) => x.email === e.target.value);
    if (!p) return;
    if (who === 'first') { setName(p.name || ''); setEmail(p.email || ''); } else setSecond(p.name || '');
  };
  const save = (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    const details = {};
    if (email) details.email = email;
    if (kind === 'joint' && second.trim()) details.spouse = second.trim();
    onCreate({ name: name.trim(), kind, details }).catch((err) => { setError(err?.message || 'Could not create the profile.'); setBusy(false); });
  };
  const picker = (id, who, text) => (
    <select id={id} defaultValue="" onChange={(e) => pickPerson(e, who)} style={{ ...control, width: '100%' }} aria-label={text}>
      <option value="">{people ? text : 'Loading People...'}</option>
      {(people || []).map((p) => <option key={p.email} value={p.email}>{p.name}{p.companyName ? ` - ${p.companyName}` : ''}</option>)}
    </select>
  );
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form className="modal-content" role="dialog" aria-modal="true" aria-label="New guarantor" onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>New Guarantor</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>Add each guarantor once; a joint statement lists both names.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12 }}>
          <div>
            <label style={label} htmlFor="pfs-new-kind">Statement Type</label>
            <select id="pfs-new-kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...control, width: '100%' }}>
              {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label style={label} htmlFor="pfs-new-person">Prefill From People</label>
            {picker('pfs-new-person', 'first', 'Pick a person...')}
          </div>
          <div>
            <label style={label} htmlFor="pfs-new-name">Name on the Statement</label>
            <input id="pfs-new-name" type="text" value={name} maxLength={160} autoFocus onChange={(e) => setName(e.target.value)} style={{ ...control, width: '100%' }} />
          </div>
          {kind === 'joint' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                <label style={label} htmlFor="pfs-new-second-person">Second Person From People</label>
                {picker('pfs-new-second-person', 'second', 'Pick the second person...')}
              </div>
              <div>
                <label style={label} htmlFor="pfs-new-second">Second Name on the Statement</label>
                <input id="pfs-new-second" type="text" value={second} maxLength={160} placeholder="Printed with the first, as in Rajesh J. Kadakia and Darshana R. Kadakia" onChange={(e) => setSecond(e.target.value)} style={{ ...control, width: '100%' }} />
              </div>
            </div>
          )}
          {error && <div style={bad}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-btn" disabled={!name.trim() || busy}>{busy ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

// One ledger entity, for the schedule a line reports on.
function EntityPick({ id, value, onChange, blank = 'None' }) {
  const [entities, setEntities] = useState(null);
  useEffect(() => {
    api.getPfsLedgerEntities().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);
  return (
    <select id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ ...control, width: '100%' }}>
      <option value="">{entities ? blank : 'Loading...'}</option>
      {(entities || []).map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
    </select>
  );
}

// Schedules (Charmi, 10/01: "SCH C and Sch E reporting"): Schedule E, one
// block per real estate line whose ledger entity is known - rents received,
// then the expenses on the IRS lines, the net; Schedule C, one block per
// business interest with an entity - gross receipts, cost of goods sold, the
// Part II expense lines, net profit. The calendar year of the statement date,
// from the entity's P&L through the accounting app; account titles decide the
// line. Printed on the PDF and the Excel workbook with the statement.
function Schedules({ statement, profile }) {
  const sch = statement.schedules || { year: statement.asOf?.slice(0, 4), e: [], c: [] };
  const block = (b, { income, net, withCogs }) => (
    <div key={b.lineId} style={{ ...card, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: '0.86rem' }}>{b.label}</strong>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginLeft: 8 }}>Entity {b.entity}{b.address ? ` · ${b.address}` : ''} · {pct(b.ownershipPct)} owned</span>
        </div>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{net}: <Amount value={b.net} /></span>
      </div>
      <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
        <tbody>
          <tr><td>{income}</td><td className="acct-num"><Amount value={b.income} /></td></tr>
          {withCogs && <tr><td>Cost of Goods Sold</td><td className="acct-num"><Amount value={b.cogs} /></td></tr>}
          {withCogs && <tr className="acct-grand"><td>Gross Profit</td><td className="acct-num"><Amount value={b.income - b.cogs} /></td></tr>}
          {b.lines.map((x) => (
            <tr key={x.key} title={x.accounts.map((a) => `${a.code} ${a.title}`).join('\n')}>
              <td style={{ paddingLeft: 18 }}>{x.label}<span className="acct-code" style={{ marginLeft: 8 }}>{x.accounts.length} {x.accounts.length === 1 ? 'account' : 'accounts'}</span></td>
              <td className="acct-num"><Amount value={x.amount} /></td>
            </tr>
          ))}
          <tr className="acct-grand"><td>Total Expenses</td><td className="acct-num"><Amount value={b.expenses} /></td></tr>
          <tr className="acct-grand"><td>{net}</td><td className="acct-num"><Amount value={b.net} /></td></tr>
          <tr><td style={{ color: 'var(--text-secondary)' }}>At {pct(b.ownershipPct)} owned</td><td className="acct-num"><Amount value={b.netAtShare} /></td></tr>
        </tbody>
      </table>
    </div>
  );
  const candidates = profile.lines.filter((l) => l.section === 'real_estate' || (l.section === 'asset' && l.category === 'business'));
  const empty = (
    <div style={{ ...card, padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
      {candidates.length
        ? 'No property or business interest names a ledger entity yet. Open a line and set its entity for Schedule E or Schedule C, or add it from the ledger; the schedule is read from that entity\'s P&L.'
        : 'Schedule E lists each property on the Real Estate tab that has a ledger entity; Schedule C lists each Business Interest with one. Add those lines first.'}
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>Calendar year {sch.year}, from each entity's ledger. Account titles decide the IRS line; hover a line to see its accounts.</div>
      <div style={label}>Schedule E - Rental Real Estate</div>
      {sch.e.length ? sch.e.map((b) => block(b, { income: 'Rents Received', net: 'Net Income (Loss)', withCogs: false })) : empty}
      <div style={{ ...label, marginTop: 6 }}>Schedule C - Profit or Loss From Business</div>
      {sch.c.length ? sch.c.map((b) => block(b, { income: 'Gross Receipts', net: 'Net Profit (Loss)', withCogs: true })) : (sch.e.length ? <div style={{ ...card, padding: 14, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>No Business Interest line names a ledger entity.</div> : null)}
    </div>
  );
}
