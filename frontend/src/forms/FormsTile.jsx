// Workday > Fill a Form (Forms & Checklists, Neil 11/02/2026) - the tile in
// the Overview's actions cell beside Ask HR, Reimbursements and Purchase
// Request. It lists the forms this person may fill (GET /forms/mine - the
// server's audience rule, never a client guess), grouped by category, and
// opens one in the fill sheet (forms/FillForm.jsx, loaded on first use so
// the Workday page stays light). Nothing to fill = no tile.
//
// `autoOpen` is the Workday deep link ({ id, n }): `form:<templateId>` opens
// that form, `form:pick` the picker; `n` makes a second arrival open again.
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { ClipboardList, ArrowRight, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { Modal } from '../tasks/components';
import { ModalLoading } from '../components/AsyncState';
import { NX, FONT } from '../tasks/theme';
import { CATEGORY_ORDER, categoryLabel } from './formRules';

const FillForm = lazy(() => import('./FillForm'));

/** Forms gathered under their category labels, in the catalog's order. */
export function groupForms(forms) {
  const out = [];
  const order = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
  for (const f of [...(forms || [])].sort((a, b) => order(a.category) - order(b.category) || String(a.title).localeCompare(String(b.title)))) {
    const lbl = categoryLabel(f.category);
    const g = out.find((x) => x.label === lbl);
    if (g) g.forms.push(f); else out.push({ label: lbl, forms: [f] });
  }
  return out;
}

export function FormPicker({ forms, onPick, onClose }) {
  const groups = groupForms(forms);
  return (
    <Modal title="Fill a Form" onClose={onClose} zIndex={4050}>
      <div className="nx-fill" style={{ fontFamily: FONT }}>
        {!groups.length && <div style={{ fontSize: 13, color: NX.dim, padding: 20, textAlign: 'center' }}>There are no forms for you to fill yet.</div>}
        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: NX.dim, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{g.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {g.forms.map((f) => (
                <button key={f.id} type="button" onClick={() => onPick(f)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: `1px solid ${NX.border}`, background: NX.surface, cursor: 'pointer', fontFamily: 'inherit', color: NX.ink }}>
                  <span style={{ width: 34, height: 34, borderRadius: 10, background: 'hsla(var(--color-blue),0.10)', color: NX.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><ClipboardList size={17} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>{f.title}</span>
                    {f.description && <span style={{ display: 'block', fontSize: 12, color: NX.dim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.description}</span>}
                  </span>
                  <ChevronRight size={16} style={{ color: NX.faint, flexShrink: 0 }} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function FormsTile({ autoOpen = null, flash = () => {} }) {
  const [forms, setForms] = useState(null);     // null = loading
  const [picker, setPicker] = useState(false);
  const [filling, setFilling] = useState('');   // the template id in the fill sheet
  const [seen, setSeen] = useState(null);

  // GET /forms/mine is a bare array of forms (routers/forms.py).
  const load = useCallback(() => api.formsMine().then((r) => setForms(Array.isArray(r) ? r : r?.forms || [])).catch(() => setForms([])), []);
  useEffect(() => { load(); }, [load]);

  // A deep link arrival ({ id, n }) opens that form, or the picker, each time.
  const key = autoOpen ? `${autoOpen.id || autoOpen}|${autoOpen.n || 0}` : null;
  if (key !== seen) {
    setSeen(key);
    if (key) {
      const id = autoOpen.id || autoOpen;
      if (id === 'pick') { setPicker(true); setFilling(''); } else { setFilling(String(id)); setPicker(false); }
    }
  }

  const open = () => {
    if (forms && forms.length === 1) setFilling(forms[0].id);
    else setPicker(true);
  };
  const pick = (f) => { setPicker(false); setFilling(f.id); };
  const onSent = (entry) => { if (entry?.title) flash(`${entry.title} sent`); };

  const count = forms ? forms.length : 0;
  const tile = forms && forms.length > 0 ? (
    <button type="button" className="dk-stat wd-stat wd-askhr wd-forms" onClick={open}
      aria-label={count === 1 ? `Fill a Form, ${forms[0].title}` : `Fill a Form, ${count} forms`}>
      <span className="wd-askhr-badge" aria-hidden="true"><ClipboardList size={18} /></span>
      <span className="wd-stat-text">
        <span className="wd-askhr-title">Fill a Form</span>
        <span className="wd-askhr-sub">{count === 1 ? forms[0].title : `${count} forms`}</span>
      </span>
      <span className="wd-askhr-cta" aria-hidden="true">Open <ArrowRight size={13} /></span>
      <ArrowRight className="wd-askhr-go" size={15} aria-hidden="true" />
    </button>
  ) : null;

  return (
    <>
      {tile}
      {picker && <FormPicker forms={forms || []} onPick={pick} onClose={() => setPicker(false)} />}
      {filling && (
        <Suspense fallback={<ModalLoading zIndex={4100} />}>
          <FillForm templateId={filling} onClose={() => setFilling('')} onSent={onSent} />
        </Suspense>
      )}
    </>
  );
}
