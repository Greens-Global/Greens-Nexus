// Workflows > Templates (Oct 28 2026): the ready-made workflows, grouped by
// module, each with the trigger as a sentence and the blanks it asks for.
// Read-and-use only: Use Template copies one as a draft and opens the
// builder; saving a workflow AS a template lives in the builder, not here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutTemplate, Zap } from 'lucide-react';
import { api } from '../api';
import { ErrorBanner, SkeletonBlocks } from '../components/AsyncState';
import { Modal } from '../tasks/components';
import { useRole } from '../contexts/RoleContext';
import { useCatalog } from './lib/useCatalog';
import { describeTrigger } from './lib/text';
import { moduleLabel, sortModules, blankLabel } from './lib/modules';
import { errorText } from './lib/errors';

function Chip({ children, tone = 'muted' }) {
  return <span className={`status-badge pill-${tone}`} style={{ fontWeight: 600 }}>{children}</span>;
}

// The Use Template popup: a name and the company it runs for. A Global
// Admin may pick Every Company; anyone else starts on Your Company ('' -
// the server resolves the owner's own scope, as New Workflow does) and may
// pick one of the companies they can see.
function UseTemplateModal({ template, onClose, onCreated }) {
  const { myRole } = useRole();
  const everyCompany = myRole === 'owner';
  const [name, setName] = useState(template.name || '');
  const [companies, setCompanies] = useState(null);
  const [companyId, setCompanyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.getEntities().then((rows) => {
      if (!live) return;
      const list = Array.isArray(rows) ? rows : [];
      setCompanies(list);
    }).catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, []);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Give the workflow a name.'); return; }
    setBusy(true); setErr('');
    try {
      const wf = await api.wfUseTemplate(template.key, { name: trimmed, companyId });
      onCreated(wf);
    } catch (e) { setErr(errorText(e, 'The template could not be used.')); setBusy(false); }
  }

  return (
    <Modal title="Use Template" onClose={onClose} isDirty={name.trim() !== (template.name || '')}
      footer={<>
        <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-btn" onClick={create} disabled={busy}>{busy ? 'Creating...' : 'Create Draft'}</button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
          A copy of <strong style={{ color: 'var(--ink)' }}>{template.name}</strong> opens as a draft with its blanks marked. Nothing runs until you test and publish it.
        </p>
        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 }}>
          Name
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 }}>
          Company
          <select className="form-input" value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={companies === null}>
            <option value="">{everyCompany ? 'Every Company' : 'Your Company'}</option>
            {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {(template.blanks || []).length > 0 && (
          <div className="nx-fill" style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            You will fill in: {(template.blanks || []).map(blankLabel).join(', ')}.
          </div>
        )}
        {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--bad-fg)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

function TemplateCard({ t, sentence, onUse }) {
  return (
    <article style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="nx-set-tile" aria-hidden="true"><LayoutTemplate size={15} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, lineHeight: 1.3 }}>{t.name}</h3>
          {t.description && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>{t.description}</p>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink)' }}>
        <Zap size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
        <span style={{ minWidth: 0 }}>{sentence}</span>
      </div>
      {(t.blanks || []).length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
          <span>Fill in:</span>
          {t.blanks.map((b) => <Chip key={b}>{blankLabel(b)}</Chip>)}
        </div>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="primary-btn" onClick={() => onUse(t)}>Use Template</button>
      </div>
    </article>
  );
}

export default function Templates({ go }) {
  const { catalog } = useCatalog();
  const [state, setState] = useState({ status: 'loading', rows: [] });
  const [using, setUsing] = useState(null);
  const load = useCallback(() => {
    api.wfTemplates().then((rows) => setState({ status: 'ready', rows: Array.isArray(rows) ? rows : [] }))
      .catch(() => setState({ status: 'error', rows: [] }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const by = new Map();
    for (const t of state.rows) {
      const k = t.module || 'core';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(t);
    }
    return sortModules([...by.keys()]).map((k) => ({ key: k, label: moduleLabel(k), rows: by.get(k) }));
  }, [state.rows]);

  if (state.status === 'error') return <ErrorBanner message="The templates could not be loaded." onRetry={load} />;
  if (state.status === 'loading') return <SkeletonBlocks count={3} height={150} gridTemplateColumns="repeat(auto-fill, minmax(280px, 1fr))" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
        Start from a ready-made workflow. Using one makes a draft of your own with the blanks marked; it runs only once you test and publish it.
      </p>
      {groups.length === 0 ? (
        <div style={{ padding: '40px 16px', textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 12 }}>
          <LayoutTemplate size={26} style={{ color: 'var(--muted)' }} aria-hidden="true" />
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 10 }}>No Templates Yet</div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>A workflow saved as a template from the builder shows up here.</p>
        </div>
      ) : groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>{g.label}</h2>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {g.rows.map((t) => (
              <TemplateCard key={t.key} t={t} sentence={describeTrigger(t.definition?.trigger, catalog)} onUse={setUsing} />
            ))}
          </div>
        </section>
      ))}
      {using && (
        <UseTemplateModal template={using} onClose={() => setUsing(null)}
          onCreated={(wf) => { setUsing(null); if (wf?.id) go?.(`wf:${wf.id}`); }} />
      )}
    </div>
  );
}
