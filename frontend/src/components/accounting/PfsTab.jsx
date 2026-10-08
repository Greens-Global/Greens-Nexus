import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Check, ChevronDown, ChevronUp, Database, FolderUp, GripVertical, KeyRound, Mail, Maximize2, Minimize2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, Figure } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { useNameResolver } from '../../lib/useNameResolver';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { EntityPicker, ExportMenu, PopoverPanel, SelectAllCheckbox, control, usePopover } from './reportControls';
import { downloadBlob, iso, priorMonthEnd } from './reportModel';
import SendReportDialog from './SendReportDialog';
import { conditionOf, refSuffix } from './pfsCondition';
import PfsAffiliated, { PfsExecutiveProfiles } from './PfsAffiliated';
import { US_STATES, normalizePfsDetails, zipError } from './pfsAddress';
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
// the statement's own, computed for the date picked at the top. Every export
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
// with its mortgage account as the loan); a New Guarantor prefilled from
// People, joint with two names; a Co-Borrower block on the Borrower tab.
//
// Oct 6 (Charmi, 10/03-10/04): the Statement view opens on the bank-style
// first page (Statement of Financial Condition), which is also page 1 of the
// PDF and the first sheet of the workbook; one Export menu; Institution is the
// bank, read from the bank account linked to the GL; Cash is its own section,
// first; lines are put in order by dragging or with the arrows.
//
// Oct 7 (Neil + Charmi): the guarantors are a dropdown at the top showing
// both names (the left panel is gone, the body is full width); tabs are
// Statement, Borrower(s), Affiliated Entities, History and Profile, Assets,
// Liabilities, Real Estate (Schedules tab removed - Schedule E/C still feed
// the statement and the files); Access Log sits beside the tabs; an Executive
// Profile per borrower; a co-borrower photo; every entity picker is the
// module's own (search by number, no historical entities); a line's share is
// read from Affiliated Entities unless typed; Liabilities sections from the
// server (Commercial / Residential Loans); an Investments group on Assets and
// the Statement with real estate at equity; the account number printed once;
// "Not found - Set It" where no bank was found; a whole row drags; Add From
// the Ledger fills the screen with a Select All; the PDF can carry a password.
//
// Oct 7, later (Charmi + Neil, circled on the Borrower(s) tab): City, State
// and ZIP are three fields on both blocks (an old combined value is split on
// read - pfsAddress.js), and the separate "Spouse or Co-Borrower" field is gone:
// the Co-Borrower block's Name is the one source of truth.

const SECTIONS = [
  { key: 'statement', label: 'Statement' },
  { key: 'borrower', label: 'Borrower(s)' },
  { key: 'affiliated', label: 'Affiliated Entities' },   // Oct 6 (Charmi, 10/04) - PfsAffiliated.jsx
  { key: 'history', label: 'History and Profile' },
  { key: 'asset', label: 'Assets' },
  { key: 'liability', label: 'Liabilities' },
  { key: 'real_estate', label: 'Real Estate' },
];
const SECTION_LABEL = { asset: 'Assets', liability: 'Liabilities', real_estate: 'Real Estate' };
// Investments on the Assets tab (Oct 7, item 36): these asset categories, then
// real estate at equity, under one heading with a subtotal.
const INVEST_KEYS = ['investment', 'business'];
const CO_BORROWER = [
  ['name', 'Name'], ['address', 'Street Address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['phone', 'Phone'], ['email', 'Email'],
  ['date_of_birth', 'Date of Birth', 'date'], ['marital_status', 'Marital Status'], ['employer', 'Employer'], ['title', 'Title'],
  ['ssn_last4', 'Social Security Number - Last 4 Digits'],
];
const KINDS = { individual: 'Individual', joint: 'Joint', trust: 'Trust' };
const DETAILS = [
  ['address', 'Street Address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['phone', 'Phone'], ['email', 'Email'],
  ['date_of_birth', 'Date of Birth', 'date'], ['marital_status', 'Marital Status'], ['employer', 'Employer'], ['title', 'Title'],
  ['ssn_last4', 'Social Security Number - Last 4 Digits'],
];
const RE_DETAILS = [['address', 'Address'], ['property_type', 'Property Type'], ['legal_owner', 'Legal Owner'], ['ownership_type', 'Ownership Type'], ['lender', 'Lender'], ['interest_rate', 'Interest Rate'], ['monthly_payment', 'Monthly Payment']];
const LOCK_HINT = 'Each file opens with a one-time code emailed to you, for 30 minutes in this tab, and its borrowers are told. Every open, change and statement is logged.';

const pct = (n) => `${(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const hint = { fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 };
const linkBtn = { border: 'none', background: 'none', font: 'inherit', fontSize: '0.74rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer', padding: 0 };

// The PDF goes to the server and back for its password (pdf-lib cannot
// encrypt). Bytes <-> base64 in slices, so a large file does not overflow
// the call stack.
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Where a line's share comes from, for the hover (Oct 7, item 28).
function shareSource(l) {
  const a = l?.affiliatedShare;
  if (l?.shareFrom === 'affiliated' && a) return `From Affiliated Entities: ${a.text || pct(a.pct)}${a.inherited || a.via ? ` (through ${a.affiliateName || a.via})` : ''}`;
  if (a) return `Typed by hand. Affiliated Entities says ${pct(a.pct)}: ${a.text || ''}`.trim();
  return 'Typed by hand';
}

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
  const [asking, setAsking] = useState('');         // 'pdf' | 'email' | 'egnyte' - the PDF password step
  const [mismatch, setMismatch] = useState(null);   // lines whose % differs from Affiliated Entities
  const [note, setNote] = useState('');
  const seq = useRef(0);
  // Oct 7 (item 37): the PDF's password, typed at export and forgotten right
  // after - kept in a ref (never state, never storage, never logged).
  const password = useRef('');
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
    api.getPfsMeta().then(setMeta).catch(() => setMeta({ assetCategories: [], liabilityCategories: [], realEstateKinds: [], historyQuestions: [], retiredCategories: [] }));
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

  // Oct 7 (item 28): lines whose share differs from Affiliated Entities are
  // offered once - Update or Keep - never changed silently.
  const profileId = profile?.id || '';
  const wantMismatch = canEdit && !!profileId && fileOpen;
  useEffect(() => {
    if (!wantMismatch) return undefined;
    let alive = true;
    api.getPfsShareMismatches(profileId)
      .then((d) => { if (alive) setMismatch(d?.count ? { ...d, profileId } : null); })
      .catch(() => { if (alive) setMismatch(null); });
    return () => { alive = false; };
  }, [wantMismatch, profileId, statement]);
  const shownMismatch = wantMismatch && mismatch?.profileId === profileId ? mismatch : null;

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
  const buildFile = async (kept, format, preparedBy, name = '', pass = '') => {
    if (format === 'xlsx') {
      const { buildPfsWorkbook } = await import('./pfsXlsx');
      const bytes = await buildPfsWorkbook({ statement: kept, preparedBy });
      return new File([bytes], name || `${stemOf(kept)}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    const { buildPfsPdf } = await import('./pfsPdf');
    let bytes = await buildPfsPdf({ statement: kept, photo: profile.photo, preparedBy });
    if (pass) {
      // Oct 7 (item 37): AES-256 on the server; the password goes with this
      // one request and is never kept or logged there or here.
      const r = await api.encryptPfsPdf(profile.id, { pdf: toBase64(bytes), password: pass, ...(kept.id ? { statementId: kept.id } : {}) });
      bytes = fromBase64(r.pdf);
    }
    return new File([bytes], name || `${stemOf(kept)}.pdf`, { type: 'application/pdf' });
  };
  const fileFor = async (kept, format, preparedBy, pass = '') => {
    const f = await buildFile(kept, format, preparedBy, '', pass);
    downloadBlob(f.name, new Blob([f], { type: f.type }));
  };
  // Email / Save to Files (the Reports tab's dialog): the statement is
  // produced - kept on record, audited with where it went - then built into
  // the file that is sent.
  const sendFile = async (format, name) => {
    const fmt = format === 'excel' ? 'xlsx' : 'pdf';
    const made = await api.producePfsStatement(profile.id, asOf, fmt, sending === 'email' ? 'email' : 'files');
    const f = await buildFile(made, fmt, nameOf(myEmail) || '', name, fmt === 'pdf' ? password.current : '');
    api.getPfsStatements(profile.id).then((list) => setPast(list || [])).catch(() => {});
    return f;
  };
  const produce = async (format = 'pdf') => {
    if (producing || !profile) return;
    setProducing(format);
    setError('');
    setNote('');
    const what = format === 'xlsx' ? 'Excel workbook' : 'PDF';
    const pass = format === 'pdf' ? password.current : '';
    password.current = '';
    try {
      const made = await api.producePfsStatement(profile.id, asOf, format, 'download');
      await fileFor(made, format, nameOf(myEmail) || '', pass);
      setNote(`${what} produced${pass ? ', protected with the password,' : ''} and the statement kept on record.`);
      setPast(await api.getPfsStatements(profile.id));
    } catch (e) {
      setError(`The ${what} was not produced: ${e?.message || 'the statement could not be read.'}`);
    } finally {
      setProducing('');
    }
  };
  // After the password step: download the PDF, or open the send dialog.
  const afterPassword = (pass) => {
    const next = asking;
    setAsking('');
    password.current = pass || '';
    if (next === 'pdf') produce('pdf');
    else setSending(next);
  };
  const closeSend = () => { password.current = ''; setSending(null); };
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
  const resolveMismatch = (action) => api.resolvePfsShareMismatches(profile.id, mismatch.lines.map((l) => l.id), action)
    .then((r) => {
      setMismatch(null);
      setNote(action === 'update' ? `${r?.updated ?? mismatch.count} ${(r?.updated ?? mismatch.count) === 1 ? 'line now follows' : 'lines now follow'} Affiliated Entities.` : 'Kept as typed. These lines are not offered again.');
      return refresh(profile.id, asOf);
    })
    .catch((e) => setError(e?.message || 'Could not change the lines.'));
  const pickFile = (id) => { setOpenId(id); setSection('statement'); };
  const current = (profiles || []).find((p) => p.id === openId) || null;

  return (
    <AsyncSection loading={profiles === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ minWidth: 0, display: 'grid', gap: 10 }}>
        {/* Oct 7 (Neil): one bar - the guarantor, Lock Now, As of, Export; then the tabs with the Access Log beside them. */}
        <div style={{ ...card, padding: '8px 10px', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <GuarantorPicker profiles={profiles || []} current={current} canEdit={canEdit} locks={locks} onPick={pickFile} onNew={() => setCreating(true)} />
            {profile && fileOpen && (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {locks.untilOf(profile.id) && <PfsLockNow fileId={profile.id} until={locks.untilOf(profile.id)} onLocked={locks.markLocked} />}
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>As of</span>
                <input type="date" value={asOf} aria-label="Statement date" style={control} onChange={(e) => e.target.value && setAsOf(e.target.value)} />
                {/* Oct 6 (Charmi): "an option to Export to Excel and PDF and not
                    separate tabs/buttons - the exact one you had for reports".
                    Every choice keeps the statement on record and audits it. */}
                <ExportMenu disabled={!!producing || working || !statement} items={[
                  { key: 'pdf', label: 'PDF', hint: 'Financial condition first, then every schedule; a password if you like', onPick: () => setAsking('pdf'), busy: producing === 'pdf' },
                  { key: 'excel', label: 'Excel', hint: 'One sheet per section, live totals; kept on record', onPick: () => produce('xlsx'), busy: producing === 'xlsx' },
                  { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, statement attached', Icon: Mail, onPick: () => setAsking('email') },
                  { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setAsking('egnyte') },
                ]} />
              </div>
            )}
          </div>
          {((profile && fileOpen) || canEdit) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 8 }}>
              {profile && fileOpen ? (
                <div className="scroll-tabs" style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
                  {SECTIONS.map((s) => (
                    <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
                      style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : <div style={{ flex: 1 }} />}
              {canEdit && <button type="button" className="acct-drill" onClick={() => setShowLog(true)} style={{ fontSize: '0.76rem', whiteSpace: 'nowrap', flexShrink: 0 }}>Access Log</button>}
            </div>
          )}
        </div>
        {asking && <PdfPassword next={asking} onCancel={() => setAsking('')} onGo={afterPassword} />}
        {error && <div style={bad}>{error}</div>}
        {openId && !fileOpen && <PfsUnlockPanel key={openId} file={current || { id: openId }} onUnlocked={locks.markOpen} />}
        {(!openId || fileOpen) && !profile && !working && <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{canEdit ? 'Nobody is set up yet. Start with New Guarantor: a person, a couple filing jointly, or a trust.' : 'No guarantor has been set up yet.'}</div>}
        {fileOpen && !profile && working && <SkeletonBlocks count={3} />}
        {profile && fileOpen && (
          <>
            {note && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--ok-fg, #15803d)' }}>{note}</div>}
            {shownMismatch && <ShareMismatch data={shownMismatch} onUpdate={() => resolveMismatch('update')} onKeep={() => resolveMismatch('keep')} />}
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
                  investments={section === 'asset' ? statement?.investments || null : null} retired={section === 'liability' ? meta?.retiredCategories || [] : []}
                  onOpenRealEstate={() => setSection('real_estate')}
                  onBulk={() => setBulk({ section })} onMove={move} onReorder={reorder}
                  onAdd={(category) => setEditing({ section, category, label: '', institution: '', accountRef: '', ownershipPct: 100, source: 'manual', ledgerEntity: '', ledgerAccounts: [], manualValue: 0, manualAsOf: asOf, details: {}, notes: '' })}
                  onEdit={(l, focus = '') => setEditing({ ...l, focus, institution: l.source === 'ledger' && !l.details?.institutionManual ? (figures.get(l.id)?.institution ?? l.institution) : l.institution })}
                  onDelete={(l) => api.deletePfsLine(profile.id, l.id).then(() => refresh(profile.id, asOf)).catch((e) => setError(e?.message || 'Could not remove the line.'))} />
              )}
              {section === 'history' && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <History profile={profile} canEdit={canEdit} onSave={saveProfile} />
                  <PfsExecutiveProfiles key={profile.id} profile={profile} canEdit={canEdit} onLocked={locks.markLocked} />
                </div>
              )}
              {section === 'affiliated' && <PfsAffiliated key={profile.id} profile={profile} canEdit={canEdit} onLocked={locks.markLocked} />}
            </div>
          </>
        )}
      </div>
      {editing && (
        <LineEditor line={editing} profileId={profile?.id} categories={categories[editing.section]} asOf={asOf} onClose={() => setEditing(null)}
          onSave={(body) => (editing.id ? api.updatePfsLine(profile.id, editing.id, body) : api.addPfsLine(profile.id, body)).then(() => { setEditing(null); return refresh(profile.id, asOf); })} />
      )}
      {bulk && (
        <LedgerBulkAdd section={bulk.section} profileId={profile?.id} categories={categories[bulk.section]} asOf={asOf} onClose={() => setBulk(null)}
          onSave={(body) => api.addPfsLinesBulk(profile.id, body).then((r) => { setBulk(null); setNote(`${r.added} ${r.added === 1 ? 'line' : 'lines'} added from the ledger.`); return refresh(profile.id, asOf); })} />
      )}
      {sending && profile && (
        <SendReportDialog mode={sending} title={`Personal Financial Statement - ${profile.displayName || profile.name} - ${formatDate(asOf)}`}
          baseName={`PFS_${profile.name.replace(/[^A-Za-z0-9]+/g, '-')}_${asOf}`} what="statement" formats={['pdf', 'excel']}
          makeFile={sendFile} onClose={closeSend} onDone={(text) => { closeSend(); setNote(`${text} The statement was kept on record.`); }} />
      )}
      {creating && (
        <NewGuarantor onClose={() => setCreating(false)}
          onCreate={(body) => api.createPfsProfile(body).then((p) => loadProfiles().then(() => { locks.markOpen(p.id, new Date(Date.now() + 30 * 60_000).toISOString()); setCreating(false); setOpenId(p.id); setSection('borrower'); }))} />
      )}
      {showLog && <PfsAccessLog files={profiles || []} initialFileId={openId} onClose={() => setShowLog(false)} />}
    </AsyncSection>
  );
}

// The guarantors as a dropdown at the top (Oct 7, items 3 + 27): each file by
// both names ("Neil R. Kadakia and Archana N. Kadakia"), its kind and its
// lock; archived files dimmed; search matches either person; "+ New
// Guarantor" for editors. Works before any file is unlocked.
const fileName = (p) => p.displayName || p.name || 'Unnamed';
function GuarantorPicker({ profiles, current, canEdit, locks, onPick, onNew }) {
  const [open, setOpen, ref] = usePopover();
  const [q, setQ] = useState('');
  const nameOf = fileName;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? profiles.filter((p) => fileName(p).toLowerCase().includes(s) || (p.name || '').toLowerCase().includes(s)) : profiles;
  }, [profiles, q]);
  const lock = (p) => locks.enabled && <span title={LOCK_HINT} style={{ display: 'inline-flex', flexShrink: 0 }}><PfsLockIcon open={locks.isOpen(p.id)} /></span>;
  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0, maxWidth: '100%' }}>
      <button type="button" onClick={() => { setOpen((v) => !v); setQ(''); }} aria-haspopup="listbox" aria-expanded={open} title={current ? nameOf(current) : 'Pick a guarantor'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 220, border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-card)', color: 'var(--text-primary)', font: 'inherit', padding: '4px 10px', cursor: 'pointer', textAlign: 'left' }}>
        {current && lock(current)}
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: '0.95rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current ? nameOf(current) : 'Pick a Guarantor'}</span>
          {current && <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{KINDS[current.kind] || 'Individual'}{current.archived ? ' · Archived' : ''}</span>}
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align="left" role="dialog" aria-label="Guarantors"
        style={{ width: 'min(460px, 92vw)', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 8 }}>
        {profiles.length > 0 && (
          <div style={{ position: 'relative', marginBottom: 6 }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a guarantor" aria-label="Search a guarantor" autoFocus style={{ ...control, width: '100%', paddingLeft: 26 }} />
          </div>
        )}
        <div role="listbox" aria-label="Guarantor files" style={{ display: 'grid', gap: 1, maxHeight: 'min(480px, calc(100vh - 220px))', overflowY: 'auto' }}>
          {!profiles.length && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '6px 4px' }}>Nobody is set up yet. A guarantor is a person, a couple filing jointly, or a trust.</div>}
          {shown.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === current?.id} onClick={() => { setOpen(false); onPick(p.id); }} title={nameOf(p)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, padding: '6px 8px', font: 'inherit', cursor: 'pointer', color: 'var(--text-primary)', background: p.id === current?.id ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', opacity: p.archived ? 0.55 : 1 }}>
              {lock(p)}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'normal' }}>{nameOf(p)}</span>
                <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{KINDS[p.kind] || 'Individual'}{p.archived ? ' · Archived' : ''}</span>
              </span>
            </button>
          ))}
          {profiles.length > 0 && !shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>No guarantor matches.</div>}
        </div>
        {canEdit && (
          <div style={{ borderTop: '1px solid var(--border-color)', marginTop: 6, paddingTop: 6 }}>
            <button type="button" onClick={() => { setOpen(false); onNew(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', background: 'none', borderRadius: 6, padding: '6px 8px', font: 'inherit', fontSize: '0.8rem', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer' }}>
              <Plus size={14} /> New Guarantor
            </button>
          </div>
        )}
      </PopoverPanel>
    </div>
  );
}

// Export > PDF / Email / Save to Files (Oct 7, item 37): an optional password
// for the PDF, typed here and forgotten once the file is made.
function PdfPassword({ next, onCancel, onGo }) {
  const [value, setValue] = useState('');
  const short = value.length > 0 && value.length < 4;
  const go = (e) => { e.preventDefault(); if (!short) onGo(value); };
  const action = next === 'pdf' ? 'Download PDF' : 'Continue';
  return (
    <form onSubmit={go} aria-label="PDF Password" style={{ ...card, padding: '10px 12px', display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 300px', minWidth: 0 }}>
        <label style={label} htmlFor="pfs-pdf-password">Protect With a Password</label>
        <div style={{ position: 'relative', maxWidth: 360 }}>
          <KeyRound size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
          <input id="pfs-pdf-password" type="password" autoComplete="new-password" value={value} maxLength={128} autoFocus placeholder="Optional"
            onChange={(e) => setValue(e.target.value)} style={{ ...control, width: '100%', paddingLeft: 28 }} />
        </div>
        <div style={hint}>
          Optional - for example the main guarantor's Social Security number - it is never saved.{next !== 'pdf' ? ' Applies when the PDF is sent; an Excel file goes as it is.' : ''}
        </div>
        {short && <div style={{ ...hint, color: 'var(--bad-fg, #dc2626)' }}>A password is at least 4 characters.</div>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="secondary-btn" onClick={onCancel} style={{ fontSize: '0.78rem' }}>Cancel</button>
        <button type="submit" className="primary-btn" disabled={short} style={{ fontSize: '0.78rem' }}>{action}</button>
      </div>
    </form>
  );
}

// "N lines use a different % than Affiliated Entities - Update / Keep" (Oct 7, item 28).
function ShareMismatch({ data, onUpdate, onKeep }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (fn) => { setBusy(true); Promise.resolve(fn()).finally(() => setBusy(false)); };
  const n = data.count;
  return (
    <div role="region" aria-label="Share differs from Affiliated Entities" style={{ ...card, padding: '8px 12px', borderColor: '#b45309', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.8rem', color: '#92400e' }}>
        <AlertTriangle size={14} style={{ flexShrink: 0 }} />
        <span style={{ flex: '1 1 260px' }}>{n} {n === 1 ? 'line uses' : 'lines use'} a different % than Affiliated Entities.</span>
        <button type="button" style={linkBtn} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</button>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => act(onUpdate)} style={{ fontSize: '0.76rem', padding: '3px 12px' }}>Update</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => act(onKeep)} style={{ fontSize: '0.76rem', padding: '3px 12px' }}>Keep</button>
      </div>
      {open && (
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead><tr><th scope="col">Line</th><th scope="col">Entity</th><th scope="col" className="acct-num">On the Line</th><th scope="col" className="acct-num">Affiliated Entities</th></tr></thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id}><td>{l.label}</td><td>{l.affiliateName || l.entity}</td><td className="acct-num">{pct(l.ownershipPct)}</td><td className="acct-num" title={l.text || undefined}>{pct(l.affiliatedPct)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// The first page (Charmi, 10/04: "You need to build out the first page of our
// PFS"): the bank-style Statement of Financial Condition - the names and the
// date, every asset and liability line of a bank's form with the share owned
// and the amount, the totals and net worth, contingent liabilities, and the
// year's income from the schedules when there are any. Page 1 of the PDF and
// the first sheet of the workbook say the same. Then Investments, then the
// statements produced.
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
  const inv = statement.investments?.groups?.length ? statement.investments : null;
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
                {a?.answer === 'Yes' ? `Guarantor, co-maker or endorser on other debt: Yes${a.note ? ` - ${a.note}` : ''}.` : a?.answer === 'No' ? 'None. Not a guarantor, co-maker or endorser on any other debt.' : 'None listed. The answer on History and Profile ("guarantor, co-maker or endorser") is printed here.'}
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
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>At the share owned, from each entity's ledger for the calendar year.</div>
            </div>
          )}
        </div>
      </section>
      {inv && (
        <section aria-label="Investments" style={{ ...card, padding: '12px 16px', display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
            <strong style={{ fontSize: '0.9rem' }}>{inv.label || 'Investments'}</strong>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Total Investments <strong style={{ color: 'var(--text-primary)' }}><Amount value={inv.total} /></strong></span>
          </div>
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <tbody>
              {inv.groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="acct-section"><td>{g.key === 'real_estate_equity' ? 'Real Estate (Equity)' : g.label}</td><td className="acct-num"><Amount value={g.total} /></td></tr>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ paddingLeft: 18 }}>{r.label}{g.key === 'real_estate_equity' && r.categoryLabel ? <span style={{ marginLeft: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.categoryLabel}</span> : null}</td>
                      <td className="acct-num"><Amount value={g.key === 'real_estate_equity' ? r.equity : r.adjusted} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="acct-grand"><td>Total Investments</td><td className="acct-num"><Amount value={inv.total} /></td></tr>
            </tbody>
          </table>
          {inv.note && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{inv.note}</div>}
        </section>
      )}
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

// A cover photo, kept small: at most 320 pixels on its long side, as a JPEG.
function downscale(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read the image.'));
      img.onload = () => {
        const scale = Math.min(1, 320 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
const imageFromPaste = (e) => [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));

// One cover photo: Choose Photo / Remove / Ctrl+V paste (Oct 7, item 38: the
// co-borrower's works the same as the borrower's). `own` = paste into THIS
// photo only (click the box first); otherwise the card's paste lands here.
function PhotoField({ title, value, onChange, canEdit, alt, own = false }) {
  const pick = (file) => { if (file && file.type.startsWith('image/')) downscale(file).then(onChange).catch(() => {}); };
  const onPaste = own ? (e) => { const f = imageFromPaste(e); if (f && canEdit) { e.preventDefault(); e.stopPropagation(); pick(f); } } : undefined;
  return (
    <div role="group" aria-label={title} tabIndex={own && canEdit ? 0 : undefined} onPaste={onPaste} style={{ borderRadius: 8, outlineOffset: 2 }}>
      <div style={label}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {value ? <img src={value} alt={alt} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)' }} />
          : <div style={{ width: 72, height: 72, borderRadius: 8, border: '1px dashed var(--border-color)', display: 'grid', placeItems: 'center', fontSize: '0.7rem', color: 'var(--text-muted)' }}>No photo</div>}
        {canEdit && (
          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <label className="secondary-btn" style={{ fontSize: '0.76rem', cursor: 'pointer' }}>
                Choose Photo<input type="file" accept="image/*" aria-label={`Choose ${title}`} style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
              </label>
              {value && <button type="button" className="secondary-btn" style={{ fontSize: '0.76rem' }} onClick={() => onChange('')}>Remove</button>}
            </div>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{own ? 'or click here and press Ctrl+V to paste one' : 'or press Ctrl+V to paste one'}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Borrower({ profile, canEdit, onSave }) {
  const [name, setName] = useState(profile.name);
  const [kind, setKind] = useState(profile.kind);
  // The details as the Oct 7 form reads them (pfsAddress.js): an old combined
  // City, State, ZIP is split and an old spouse name is the co-borrower's; it
  // is saved that way on the next save, and only a real edit makes it dirty.
  const baseDetails = useMemo(() => normalizePfsDetails(profile.details), [profile.details]);
  const [details, setDetails] = useState(baseDetails);
  const [photo, setPhoto] = useState(profile.photo || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify([name, kind, details, photo]) !== JSON.stringify([profile.name, profile.kind, baseDetails, profile.photo || '']);
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
    setName(profile.name); setKind(profile.kind); setDetails(normalizePfsDetails(profile.details)); setPhoto(profile.photo || ''); setError('');
  }, [profile]);
  const members = details.members || [];
  const set = (k, v) => setDetails((d) => ({ ...d, [k]: v }));
  const setCo = (k, v) => setDetails((d) => {
    const co = { ...(d.coBorrower || {}) };
    if (v === '' || v == null) delete co[k]; else co[k] = v;
    return { ...d, coBorrower: co };
  });
  // A paste anywhere on the card (outside the co-borrower's photo) is the borrower's cover photo.
  const onPaste = (e) => { const f = imageFromPaste(e); if (f && canEdit) { e.preventDefault(); downscale(f).then(setPhoto).catch(() => {}); } };
  const save = () => {
    setBusy(true);
    setError('');
    setSaved(false);
    onSave({ name, kind, details, photo })
      .then(() => { dirtyRef.current = false; setSaved(true); })
      .catch((e) => setError(e?.message || 'Could not save.'))
      .finally(() => setBusy(false));
  };
  const coName = details.coBorrower?.name || 'the co-borrower';
  const zipBad = Boolean(zipError(details.zip) || zipError(details.coBorrower?.zip));
  // One field of either block: State is a list of the US states, ZIP is
  // checked as it is typed, the last four of the SSN are digits only.
  const field = (k, text, type, value, onValue, prefix) => {
    const id = `${prefix}${k}`;
    const zipMsg = k === 'zip' ? zipError(value) : '';
    return (
      <div key={k}>
        <label style={label} htmlFor={id}>{text}</label>
        {k === 'state' ? (
          <select id={id} value={value || ''} disabled={!canEdit} onChange={(e) => onValue(e.target.value)} style={{ ...control, width: '100%' }}>
            <option value="">Select...</option>
            {value && !US_STATES.includes(value) && <option value={value}>{value}</option>}
            {US_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        ) : (
          <input id={id} type={type || 'text'} value={value || ''} disabled={!canEdit} maxLength={k === 'ssn_last4' ? 4 : k === 'zip' ? 10 : 200}
            inputMode={k === 'ssn_last4' || k === 'zip' ? 'numeric' : undefined} aria-invalid={zipMsg ? true : undefined} aria-describedby={zipMsg ? `${id}-error` : undefined}
            onChange={(e) => onValue(k === 'ssn_last4' ? e.target.value.replace(/\D/g, '').slice(0, 4) : k === 'zip' ? e.target.value.replace(/[^\d-]/g, '') : e.target.value)}
            style={{ ...control, width: '100%', ...(zipMsg ? { borderColor: 'var(--bad-fg, #dc2626)' } : null) }} />
        )}
        {zipMsg && <div id={`${id}-error`} style={{ ...hint, color: 'var(--bad-fg, #dc2626)' }}>{zipMsg}</div>}
        {k === 'ssn_last4' && <div style={hint}>{prefix === 'pfs-co-' ? 'Last four digits only; a longer number is refused.' : 'Only the last four digits are kept. It prints as XXX-XX-1234.'}</div>}
      </div>
    );
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {DETAILS.map(([k, text, type]) => field(k, text, type, details[k], (v) => set(k, v), 'pfs-'))}
      </div>
      <PhotoField title="Photo on the Cover" value={photo} onChange={setPhoto} canEdit={canEdit} alt={`${name} as shown on the cover`} />
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
        <div>
          <div style={{ ...label, marginBottom: 2 }}>Co-Borrower</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>The spouse or co-borrower on the statement, printed with the borrower's name and signing too. Leave the name blank for a statement in one name.</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {CO_BORROWER.map(([k, text, type]) => field(k, text, type, details.coBorrower?.[k], (v) => setCo(k, v), 'pfs-co-'))}
        </div>
        <PhotoField title="Co-Borrower Photo on the Cover" own value={details.coBorrower?.photo || ''} onChange={(v) => setCo('photo', v)} canEdit={canEdit} alt={`${coName} as shown on the cover`} />
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
      {error && <div style={bad}>{error}</div>}
      {saved && !dirty && !error && <div style={{ fontSize: '0.78rem', color: 'hsl(var(--color-green))', fontWeight: 600 }}>Saved. The statement reads these details now.</div>}
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy || !name.trim() || zipBad} style={{ fontSize: '0.8rem' }}>{busy ? 'Saving...' : 'Save Changes'}</button>
          {dirty && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}

// The financial history questions. The executive profiles are their own
// section below (PfsExecutiveProfiles, one per borrower - Oct 7, item 15).
function History({ profile, canEdit, onSave }) {
  const [history, setHistory] = useState(profile.history || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setHistory(profile.history || []); }, [profile]);
  const dirty = JSON.stringify(history) !== JSON.stringify(profile.history || []);
  const set = (i, patch) => setHistory((h) => h.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = () => {
    setBusy(true);
    setError('');
    onSave({ history }).catch((e) => setError(e?.message || 'Could not save.')).finally(() => setBusy(false));
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
// a row, or use the arrows (the keyboard way) - and the order is kept for the
// guarantor, so the statement and its files print it that way.
// Oct 7: the WHOLE row drags (the grip is the hint) and the whole row is the
// drop target (Charmi: "the rows are not draggable"); Assets shows an
// Investments group with real estate at equity; Liabilities lists lines of a
// retired section (Contingent) read-only.
function Lines({ section, profile, categories, allCategories = [], figures, asOf, canEdit, onAdd, onEdit, onDelete, onBulk, onMove, onReorder, investments = null, retired = [], onOpenRealEstate }) {
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
  const retiredKeys = new Set(retired.map((r) => r.key));
  const known = new Set(categories.map((c) => c.key));
  const retiredLines = lines.filter((l) => !known.has(l.category) && (retiredKeys.has(l.category) || section === 'liability'));

  const table = (c, rows, readOnly = false) => {
    const editable = canEdit && !readOnly;
    const total = rows.reduce((s, l) => s + (real ? (figures.get(l.id)?.equity || 0) : (figures.get(l.id)?.adjusted || 0)), 0);
    return (
      <div className="acct-lines-wrap" style={{ maxHeight: 'none' }}>
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr>
              {editable && <th scope="col" aria-label="Order" style={{ width: 22 }} />}
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
              const canDrag = editable && rows.length > 1;
              const dropping = dragging && dragging.category === c.key && over === l.id && dragging.id !== l.id;
              const ref = refSuffix(l.label, l.accountRef);
              const missing = !real && f?.institutionMissing;
              return (
                <tr key={l.id} data-line={l.id}
                  draggable={canDrag || undefined}
                  onDragStart={canDrag ? (e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', l.id); } catch { /* some browsers refuse */ } setDragging({ id: l.id, category: c.key }); } : undefined}
                  onDragEnd={canDrag ? () => { setDragging(null); setOver(''); } : undefined}
                  onDragOver={canDrag && dragging?.category === c.key ? (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; if (over !== l.id) setOver(l.id); } : undefined}
                  onDrop={canDrag && dragging?.category === c.key ? (e) => { e.preventDefault(); drop(rows, l.id); } : undefined}
                  style={{ cursor: canDrag ? 'grab' : undefined, opacity: dragging?.id === l.id ? 0.45 : 1, boxShadow: dropping ? 'inset 0 2px 0 var(--wk-brand, #2b45e1)' : undefined }}>
                  {editable && (
                    <td style={{ whiteSpace: 'nowrap', padding: '0 2px' }}>
                      {canDrag && <span title="Drag the row to reorder" aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--text-muted)', verticalAlign: 'middle' }}><GripVertical size={14} /></span>}
                    </td>
                  )}
                  <td title={l.notes || undefined}>{l.label}{ref ? <span className="acct-code" style={{ marginLeft: 8 }}>{ref}</span> : null}</td>
                  {/* Oct 6 (Charmi): the bank, from the bank account linked to the GL - the statement's own reading. */}
                  <td>
                    {real ? (l.details?.legal_owner || '')
                      : missing ? (editable
                        ? <button type="button" className="acct-drill" onClick={() => onEdit(l, 'institution')} style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }} title="No bank record or bank name was found for this account">Not found - Set It</button>
                        : <span style={{ color: 'var(--text-muted)' }}>Not found</span>)
                        : (f ? f.institution : l.institution)}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }} title={from}>{from}</td>
                  <td className="acct-num" title={shareSource(l)}>
                    <Figure text={pct(l.ownershipPct)} />
                    {l.shareFrom === 'affiliated' && <span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--text-muted)' }}>Affiliated</span>}
                  </td>
                  {real ? <><td className="acct-num"><Amount value={f?.valueAdjusted} /></td><td className="acct-num"><Amount value={f?.loanAdjusted} /></td><td className="acct-num"><Amount value={f?.equity} /></td></>
                    : <><td className="acct-num"><Amount value={f?.balance} /></td><td className="acct-num"><Amount value={f?.adjusted} /></td></>}
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {editable && (confirm === l.id ? (
                      <>
                        <button type="button" className="acct-drill" style={{ color: 'var(--bad-fg, #dc2626)', marginRight: 10 }} onClick={() => { setConfirm(''); onDelete(l); }}>Remove</button>
                        <button type="button" className="acct-drill" onClick={() => setConfirm('')}>Keep</button>
                      </>
                    ) : moving === l.id ? (
                      <select autoFocus value={`${l.section}:${l.category}`} aria-label={`Move ${l.label} to`} style={{ ...control, height: 26, fontSize: '0.76rem' }}
                        onBlur={() => setMoving('')}
                        onChange={(e) => { const [s, k] = e.target.value.split(':'); setMoving(''); if (s !== l.section || k !== l.category) onMove(l, s, k); }}>
                        {allCategories.map((g) => (
                          <optgroup key={g.section} label={g.label}>
                            {g.categories.map((x) => <option key={x.key} value={`${g.section}:${x.key}`}>{x.label}</option>)}
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
              <td colSpan={(real ? 6 : 5) + (editable ? 1 : 0)}>Total {c.label}{real ? ' - Equity' : ''}</td>
              <td className="acct-num"><Amount value={total} /></td><td />
            </tr>
          </tbody>
        </table>
      </div>
    );
  };
  const categoryCard = (c, nested = false) => {
    const rows = lines.filter((l) => l.category === c.key);
    return (
      <div key={c.key} style={nested ? { border: '1px solid var(--border-color)', borderRadius: 10, padding: 10 } : { ...card, padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: rows.length ? 6 : 0 }}>
          <strong style={{ fontSize: '0.86rem' }}>{c.label}</strong>
          {canEdit && <button type="button" className="secondary-btn" onClick={() => onAdd(c.key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px' }}><Plus size={12} /> Add</button>}
        </div>
        {rows.length > 0 ? table(c, rows) : <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Nothing listed.</div>}
      </div>
    );
  };
  // Oct 7 (Charmi, item 36): Investments - Investment Accounts, Business
  // Interests, and each property at equity (its detail stays on Real Estate) -
  // with one subtotal. Real estate is counted once, in the totals; here it is shown.
  const investCats = section === 'asset' ? categories.filter((c) => INVEST_KEYS.includes(c.key)) : [];
  const reEquity = investments?.groups?.find((g) => g.key === 'real_estate_equity') || null;
  const investTotal = investments?.total ?? investCats.reduce((s, c) => s + lines.filter((l) => l.category === c.key).reduce((t, l) => t + (figures.get(l.id)?.adjusted || 0), 0), 0);
  const investBlock = investCats.length > 0 && (
    <section key="investments" aria-label="Investments" style={{ ...card, padding: 10, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: '0.92rem' }}>Investments</strong>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Total Investments <strong style={{ color: 'var(--text-primary)' }}><Amount value={investTotal} /></strong></span>
      </div>
      {investCats.map((c) => categoryCard(c, true))}
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: reEquity?.rows?.length ? 6 : 0 }}>
          <strong style={{ fontSize: '0.86rem' }}>Real Estate (Equity)</strong>
          <button type="button" className="acct-drill" onClick={onOpenRealEstate} style={{ fontSize: '0.76rem' }}>Open Real Estate</button>
        </div>
        {reEquity?.rows?.length ? (
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead><tr><th scope="col">Property</th><th scope="col" className="acct-num">Owned</th><th scope="col" className="acct-num">Market Value</th><th scope="col" className="acct-num">Loan Balance</th><th scope="col" className="acct-num">Equity</th></tr></thead>
            <tbody>
              {reEquity.rows.map((r) => (
                <tr key={r.id}>
                  <td><button type="button" className="acct-drill" onClick={onOpenRealEstate}>{r.label}</button>{r.categoryLabel ? <span style={{ marginLeft: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.categoryLabel}</span> : null}</td>
                  <td className="acct-num"><Figure text={pct(r.ownershipPct)} /></td>
                  <td className="acct-num"><Amount value={r.valueAdjusted} /></td><td className="acct-num"><Amount value={r.loanAdjusted} /></td><td className="acct-num"><Amount value={r.equity} /></td>
                </tr>
              ))}
              <tr className="acct-grand"><td colSpan={4}>Total Real Estate - Equity</td><td className="acct-num"><Amount value={reEquity.total} /></td></tr>
            </tbody>
          </table>
        ) : <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No property on the Real Estate tab.</div>}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{investments?.note || 'Real estate is shown here at equity; its market value and loans are counted once, in the totals.'}</div>
    </section>
  );
  let investDone = false;
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
        if (investCats.length && INVEST_KEYS.includes(c.key)) {
          if (investDone) return null;
          investDone = true;
          return investBlock;
        }
        return categoryCard(c);
      })}
      {retiredLines.length > 0 && (
        <div style={{ ...card, padding: 10 }}>
          <div style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: '0.86rem' }}>{retired[0]?.label ? `${retired[0].label} (Retired)` : 'Contingent Liabilities (Retired)'}</strong>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>No longer a section of the statement. These lines are kept as they were, listed here read-only, and never added into total liabilities.</div>
          </div>
          {table({ key: retiredLines[0].category, label: retired[0]?.label || 'Contingent Liabilities' }, retiredLines, true)}
        </div>
      )}
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Figures are as of {formatDate(asOf)}. Adjusted = balance at the share owned; hover a share to see where it comes from.</div>
    </div>
  );
}

// Where one figure comes from: kept by hand, or read from the ledger (one
// entity, one or more of its balance sheet accounts).
function FigureSource({ value, onChange, asOf, idPrefix, manualLabel, asOfLabel = 'Figure Taken On', entityLabel = 'Entity' }) {
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
            <span style={label}>{entityLabel}</span>
            {/* Oct 7 (items 12 + 14): the module's entity picker - search by name or number, no historical entities (the current one stays). */}
            {entities === null ? <SkeletonBlocks count={1} height={30} /> : (
              <EntityPicker entities={entities} value={value.entity || ''} ariaLabel={entityLabel} onChange={(code) => onChange({ ...value, entity: code, accounts: [] })} style={{ width: '100%', maxWidth: 'none' }} />
            )}
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
    if (/home loan|residential|primary residence/.test(t) && categories.some((c) => c.key === 'residential_loan')) return 'residential_loan';
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

// The share of an entity on Affiliated Entities (Oct 7, item 28), or null.
function useAffiliatedShare(profileId, entity) {
  const [got, setGot] = useState({ key: '', share: null });
  const key = profileId && entity ? `${profileId}|${entity}` : '';
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    api.getPfsAffiliatedShares(profileId, [entity])
      .then((d) => { if (alive) setGot({ key, share: d?.resolved?.[entity] || d?.shares?.[entity] || null }); })
      .catch(() => { if (alive) setGot({ key, share: null }); });
    return () => { alive = false; };
  }, [key, profileId, entity]);
  if (!key) return { entity: '', share: null, loading: false };
  return got.key === key ? { entity, share: got.share, loading: false } : { entity, share: null, loading: true };
}

// Remember a dialog's full-screen choice per viewer (try/catch: storage can be off).
const FULL_KEY = 'nexus:pfs-ledger-add-full';
const readFull = () => { try { return localStorage.getItem(FULL_KEY) === '1'; } catch { return false; } };
const writeFull = (v) => { try { localStorage.setItem(FULL_KEY, v ? '1' : '0'); } catch { /* storage off */ } };

// Add From the Ledger: one entity, its balance sheet accounts of this
// section grouped by GL code (the first three digits - Intacct's account
// groups), a tick per account or per group, a category and a share for each.
// Every tick becomes a line that reads the ledger (Neil, call of 09/29).
// Oct 2: on Liabilities and on Real Estate too. A real estate pick is a land
// or building account (the entity's asset side) that becomes a property line
// of the kind picked, with one of the entity's liability accounts as its
// mortgage, read from the ledger (Charmi, 10/01).
// Oct 7: nearly full screen (Maximize for all of it, remembered), a Select
// All box in the header, the module's entity picker, and Share Owned filled
// from Affiliated Entities (items 16, 45, 7, 28).
function LedgerBulkAdd({ section, profileId, categories, asOf, onClose, onSave }) {
  const real = section === 'real_estate';
  const [entities, setEntities] = useState(null);
  const [entity, setEntity] = useState('');
  const [all, setAll] = useState(null);      // every balance sheet account of the entity
  const [q, setQ] = useState('');
  const [typedShare, setShare] = useState(100);
  const [typed, setTyped] = useState(false);   // Share Owned typed by hand
  const [rows, setRows] = useState({});     // code -> { on, category, pct (null = the share above), loan }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [full, setFull] = useState(readFull);
  const aff = useAffiliatedShare(profileId, entity);
  const affShare = aff.entity === entity ? aff.share : null;
  const fromAffiliated = !!affShare && !typed;
  // The share used: Affiliated Entities' until one is typed.
  const share = fromAffiliated ? affShare.pct : typedShare;
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
  const state = (a) => rows[a.code] || { on: false, category: suggestCategory(section, a.title, a.suggested, categories), pct: null, loan: real && a.suggested?.section === 'real_estate' ? firstLoan : '' };
  const pctOf = (st) => (st.pct == null ? share : st.pct);
  const setRow = (code, patch) => setRows((r) => ({ ...r, [code]: { ...state((accounts || []).find((x) => x.code === code) || { code, title: '' }), ...patch } }));
  const setMany = (list, on) => setRows((r) => { const n = { ...r }; list.forEach((a) => { n[a.code] = { ...state(a), on }; }); return n; });
  const toggleGroup = (list) => setMany(list, !list.every((a) => state(a).on));
  const picked = (accounts || []).filter((a) => state(a).on);
  const shownOn = shown.filter((a) => state(a).on).length;
  const total = picked.reduce((s, a) => s + a.amount * (Number(pctOf(state(a))) || 0) / 100, 0);
  const entityName = (entities || []).find((e) => e.code === entity)?.name || '';
  const typeShare = (v) => { setTyped(true); setShare(v); setRows((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, { ...x, pct: null }]))); };
  const useAffiliated = () => setTyped(false);
  const save = () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError('');
    onSave({
      section, category: categories[0]?.key, entity, entityName, ownershipPct: Number(share) || 0, shareFrom: fromAffiliated ? 'affiliated' : 'manual',
      accounts: picked.map((a) => {
        const st = state(a);
        // A row with its own % stays manual; the rest follow Affiliated Entities when it is the source.
        const own = st.pct != null ? { ownershipPct: Number(st.pct) || 0 } : fromAffiliated ? {} : { ownershipPct: Number(share) || 0 };
        return { code: a.code, label: a.title, category: st.category, ...own, ...(real ? { loanAccount: st.loan || '' } : {}) };
      }),
    }).catch((e) => { setError(e?.message || 'Could not add the lines.'); setBusy(false); });
  };
  const catLabel = (k) => categories.find((c) => c.key === k)?.label || k;
  const flip = () => setFull((v) => { writeFull(!v); return !v; });
  const size = full
    ? { maxWidth: '100vw', width: '100vw', height: '100vh', maxHeight: '100vh', borderRadius: 0 }
    : { maxWidth: '96vw', width: 'min(1400px, 96vw)', height: '92vh', maxHeight: '92vh' };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation" style={full ? { padding: 0 } : undefined}>
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Add from the ledger" onClick={(e) => e.stopPropagation()}
        style={{ ...size, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>Add {SECTION_LABEL[section]} From the Ledger</h3>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {real ? 'Each land or building account picked becomes a property line that reads the ledger; its mortgage account is the loan.' : 'Each account picked becomes a line that reads the ledger as of the statement date.'} Balances shown are as of {formatDate(asOf)}.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={flip} aria-pressed={full} aria-label={full ? 'Back to window size' : 'Fill the screen'} title={full ? 'Back to window size' : 'Fill the screen'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 5 }}>
              {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
          </div>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, alignContent: 'start', flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 2fr) minmax(200px, 1fr)', gap: 10, alignItems: 'start' }}>
            <div style={{ minWidth: 0 }}>
              <span style={label}>Entity</span>
              {entities === null ? <SkeletonBlocks count={1} height={30} /> : (
                <EntityPicker entities={entities} value={entity} onChange={(code) => { setEntity(code); setTyped(false); }} ariaLabel="Entity" style={{ width: '100%', maxWidth: 'none' }} />
              )}
            </div>
            <div>
              <label style={label} htmlFor="pfs-bulk-share">Share Owned (%) for New Lines</label>
              <input id="pfs-bulk-share" type="number" min="0" max="100" step="0.01" value={share} onChange={(e) => typeShare(e.target.value)} style={{ ...control, width: '100%' }} />
              {entity && !aff.loading && (
                <div style={hint}>
                  {affShare ? (
                    fromAffiliated ? `From Affiliated Entities: ${affShare.text || pct(affShare.pct)}`
                      : <>Typed by hand. Affiliated Entities says {pct(affShare.pct)}. <button type="button" style={linkBtn} onClick={useAffiliated}>Use Affiliated %</button></>
                  ) : 'Not on Affiliated Entities. Add it there to fill this in.'}
                </div>
              )}
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
              </div>
              {!accounts && <SkeletonBlocks count={3} height={28} />}
              {accounts && !shown.length && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: 8 }}>{accounts.length ? 'No account matches.' : `This entity has no ${real ? 'asset' : section} accounts with a balance as of this date.`}</div>}
              {groups.length > 0 && (
                <div className="acct-lines-wrap" style={{ maxHeight: 'none' }}>
                  <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                    <thead>
                      <tr>
                        <th scope="col" style={{ width: 30 }}><SelectAllCheckbox checked={shownOn} total={shown.length} onChange={(on) => setMany(shown, on)} label="Select All" /></th>
                        <th scope="col">Account</th><th scope="col" style={{ width: 190 }}>Listed Under</th>{real && <th scope="col" style={{ width: 230 }}>Mortgage Account</th>}
                        <th scope="col" className="acct-num" style={{ width: 96 }}>Share %</th><th scope="col" className="acct-num" style={{ width: 130 }}>Balance</th>
                      </tr>
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
                                  <select value={st.category} aria-label={`Category for ${a.code}`} onChange={(e) => setRow(a.code, { category: e.target.value, on: true })} style={{ ...control, height: 26, fontSize: '0.76rem', maxWidth: 180 }}>
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
                                <td className="acct-num"><input type="number" min="0" max="100" step="0.01" value={pctOf(st)} aria-label={`Share for ${a.code}`} onChange={(e) => setRow(a.code, { pct: e.target.value, on: true })} style={{ ...control, height: 26, width: 84, fontSize: '0.76rem', textAlign: 'right' }} /></td>
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
        <div className="modal-footer" style={{ flexShrink: 0 }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={save} disabled={!picked.length || busy}>{busy ? 'Adding...' : `Add ${picked.length || ''} ${picked.length === 1 ? 'Line' : 'Lines'}`.replace('  ', ' ')}</button>
        </div>
      </div>
    </div>
  );
}

function LineEditor({ line, profileId, categories, asOf, onClose, onSave }) {
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
  // Oct 7 (item 28): the share from Affiliated Entities for the line's ledger
  // entity. A new line - or one that already follows it - takes it; a % typed
  // by hand wins (shareFrom "manual"), with "Use Affiliated %" to go back.
  const shareEntity = l.source === 'ledger' ? l.ledgerEntity : '';
  const aff = useAffiliatedShare(profileId, shareEntity);
  const affShare = aff.entity && aff.entity === shareEntity ? aff.share : (shareEntity ? null : l.affiliatedShare || null);
  const follows = l.shareFrom === 'affiliated' || (!line.id && l.shareFrom !== 'manual');
  const usingAff = follows && !!affShare;
  const pctValue = usingAff ? affShare.pct : l.ownershipPct;
  let shareFrom = l.shareFrom;                     // an existing line kept as it is (none = set up before Oct 7)
  if (usingAff) shareFrom = 'affiliated';
  else if (!line.id) shareFrom = 'manual';
  else if (l.shareFrom === 'affiliated' && shareEntity && !aff.loading) shareFrom = 'manual';   // its entity has no row now
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const figure = { source: l.source, entity: l.ledgerEntity, accounts: l.ledgerAccounts, value: l.manualValue, asOf: l.manualAsOf };
  const ready = l.label.trim() && (l.source === 'manual' || (l.ledgerEntity && l.ledgerAccounts.length)) && (!real || loan.source === 'manual' || (loan.entity && loan.accounts.length));
  const focusInstitution = line.focus === 'institution';
  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const base = real ? { ...l.details, loan: { ...loan, value: Number(loan.value) || 0 } } : { ...(l.details || {}) };
    const details = shareFrom ? { ...base, shareFrom } : base;
    onSave({
      section: l.section, category: l.category, label: l.label.trim(), institution: l.institution, accountRef: l.accountRef, ownershipPct: Number(pctValue) || 0,
      source: l.source, ledgerEntity: l.ledgerEntity, ledgerAccounts: l.ledgerAccounts, manualValue: Number(l.manualValue) || 0, manualAsOf: l.manualAsOf || '',
      details, sort: l.sort || 0, notes: l.notes || '',
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
              <input id="pfs-l-label" type="text" value={l.label} maxLength={160} autoFocus={!focusInstitution} onChange={(e) => set({ label: e.target.value })} style={{ ...control, width: '100%' }} />
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
                <input id="pfs-l-inst" type="text" value={l.institution} maxLength={160} autoFocus={focusInstitution} placeholder={l.source === 'ledger' ? 'The bank linked to the account' : ''}
                  onChange={(e) => set({ institution: e.target.value, details: { ...(l.details || {}), institutionManual: !!e.target.value.trim() } })} style={{ ...control, width: '100%' }} />
                {focusInstitution && <div style={hint}>No bank record or bank name was found for this account. Type the bank; it is kept as typed.</div>}
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
          <div style={{ maxWidth: 420 }}>
            <label style={label} htmlFor="pfs-l-pct">Share Owned (%)</label>
            <input id="pfs-l-pct" type="number" min="0" max="100" step="0.01" value={pctValue} onChange={(e) => set({ ownershipPct: e.target.value, shareFrom: 'manual' })} style={{ ...control, width: '100%', maxWidth: 220 }} />
            {affShare ? (
              <div style={hint}>
                {shareFrom === 'affiliated' ? `From Affiliated Entities: ${affShare.text || pct(affShare.pct)}`
                  : <>Typed by hand. Affiliated Entities says {pct(affShare.pct)}. <button type="button" style={linkBtn} onClick={() => set({ shareFrom: 'affiliated' })}>Use Affiliated %</button></>}
              </div>
            ) : shareEntity && !aff.loading ? <div style={hint}>Not on Affiliated Entities. Add it there to fill this in.</div> : null}
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
              <span style={label}>{real ? 'Entity for Schedule E' : 'Entity for Schedule C'}</span>
              <EntityPick ariaLabel={real ? 'Entity for Schedule E' : 'Entity for Schedule C'} value={l.details?.schedule_entity || ''} onChange={(v) => set({ details: { ...l.details, schedule_entity: v } })}
                blank={l.source === 'ledger' && l.ledgerEntity ? `Same as the figure (${l.ledgerEntity})` : 'No Schedule'} />
              <div style={hint}>The entity whose ledger carries this {real ? "property's rents and expenses" : "business's receipts and expenses"}; its P&L for the calendar year becomes the schedule.</div>
            </div>
          )}
          {real && (
            <div>
              <div style={label}>Loan Balance</div>
              <FigureSource idPrefix="pfs-loan" asOf={asOf} manualLabel="Loan Balance" entityLabel="Loan Entity" value={loan} onChange={(f) => set({ details: { ...l.details, loan: f } })} />
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
    if (kind === 'joint' && second.trim()) details.coBorrower = { name: second.trim() };
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

// One ledger entity, for the schedule a line reports on - the module's entity picker.
function EntityPick({ ariaLabel, value, onChange, blank = 'None' }) {
  const [entities, setEntities] = useState(null);
  useEffect(() => {
    api.getPfsLedgerEntities().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);
  if (entities === null) return <SkeletonBlocks count={1} height={30} />;
  return <EntityPicker entities={entities} value={value || ''} onChange={onChange} noneLabel={blank} ariaLabel={ariaLabel} style={{ width: '100%', maxWidth: 'none' }} />;
}
