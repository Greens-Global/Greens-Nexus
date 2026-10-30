// One collection: its sub-collections, its pages in reading order, drafts
// for editors, and the owner's settings.
import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Settings, ArrowUp, ArrowDown } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { Av, SectionHead, Chip } from '../components/Chips';
import PageRow from '../components/PageCard';
import PeoplePick from '../components/PeoplePick';
import { useToast, errText } from '../components/Toast';
import { goKb, plural, colorFor } from '../lib';

function CollectionSettings({ col, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: col.name, description: col.description, owner_email: col.owner_email, review_every_months: col.review_every_months });
  const [order, setOrder] = useState(col.pages.map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const move = (i, d) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    setBusy(true);
    try { onSaved(await api.kbUpdateCollection(col.id, { ...form, review_every_months: Number(form.review_every_months) || 12, reading_order: order })); toast('Saved'); onClose(); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  const byId = Object.fromEntries(col.pages.map((p) => [p.id, p]));
  return (
    <Modal title={`${col.name} Settings`} onClose={onClose} footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={onClose}>Cancel</button><button type="button" className="kb-btn pri" disabled={busy} onClick={save}>Save</button></div>}>
      <div className="kb" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="kb-field"><label>Name</label><input className="kb-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="kb-field"><label>Description</label><textarea className="kb-textarea" style={{ minHeight: 70 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What lives here" /></div>
          <div className="kb-field"><label>Owner</label><PeoplePick value={form.owner_email} onChange={(v) => setForm({ ...form, owner_email: v })} preferManagers /><div className="kb-help">The owner approves pages here, hears about stale pages and reader reports, and can publish directly.</div></div>
          <div className="kb-field"><label>Review every</label><select className="kb-select" value={form.review_every_months} onChange={(e) => setForm({ ...form, review_every_months: e.target.value })}>{[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months</option>)}</select><div className="kb-help">Pages inherit this unless they set their own.</div></div>
        </div>
        <div>
          <div className="kb-label" style={{ marginBottom: 8 }}>Reading Order</div>
          <div className="kb-help" style={{ marginBottom: 8 }}>For a collection read like a manual. Pages not listed sort by title.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '48vh', overflow: 'auto' }}>
            {order.map((id, i) => byId[id] && (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--kb-line)', borderRadius: 8, fontSize: 13 }}>
                <span className="kb-meta" style={{ width: 18 }}>{i + 1}</span><span className="kb-grow kb-ellipsis">{byId[id].title}</span>
                <button type="button" className="kb-ibtn" style={{ width: 26, height: 26 }} aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button type="button" className="kb-ibtn" style={{ width: 26, height: 26 }} aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function CollectionView({ id, me }) {
  const [col, setCol] = useState(null);
  const [err, setErr] = useState('');
  const [settings, setSettings] = useState(false);
  const load = () => { setErr(''); api.kbCollection(id).then(setCol).catch((e) => setErr(errText(e))); };
  useEffect(() => { setCol(null); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AsyncSection loading={!col && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {col && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => (col.parent.length ? goKb('collection', col.parent[col.parent.length - 1].id) : goKb('home'))}><ArrowLeft /></button>
            <a href="#home" onClick={(e) => { e.preventDefault(); goKb('home'); }}>Knowledge Base</a>
            {col.parent.map((c) => <span key={c.id}> / <a href="#c" onClick={(e) => { e.preventDefault(); goKb('collection', c.id); }}>{c.name}</a></span>)}
            <span> / <b style={{ color: 'var(--kb-ink)' }}>{col.name}</b></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <Av name={col.owner_name} email={col.owner_email} size={44} color={colorFor(col.id)} />
            <div className="kb-grow">
              <h1 className="kb-h1" style={{ margin: 0, fontSize: 26 }}>{col.name}</h1>
              <div className="kb-sub">{col.description || 'No description yet.'} {col.owner_name ? `Owner: ${col.owner_name}.` : <Chip color="#dc2626">No owner</Chip>} Review every {col.review_every_months} months.</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {me?.can_author && <button type="button" className="kb-btn pri" onClick={() => goKb('editor', `new:${col.id}`)}><Plus />New Page</button>}
              {col.can_edit && <button type="button" className="kb-btn" onClick={() => setSettings(true)}><Settings />Settings</button>}
            </div>
          </div>
          <div className="kb-cols">
            <div className="kb-main">
              {col.children.length > 0 && (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <SectionHead title="Inside" />
                  <div className="kb-grid3">
                    {col.children.map((c) => (
                      <button key={c.id} type="button" className="kb-coll" onClick={() => goKb('collection', c.id)}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="kb-title kb-ellipsis">{c.name}</span><span className="kb-meta" style={{ marginLeft: 'auto' }}>{plural(c.pages, 'page')}</span></div>
                        {c.owner_name && <div className="kb-meta">{c.owner_name}</div>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="kb-card">
                <SectionHead title="Pages" sub={col.reading_order.length ? 'In reading order' : ''} />
                {col.pages.length === 0 && <div className="kb-empty">No published pages here yet.</div>}
                {col.pages.map((p) => <PageRow key={p.id} page={p} />)}
              </section>
              {col.drafts.length > 0 && (
                <section className="kb-card">
                  <SectionHead title="Drafts and Reviews" sub="Only editors see these" />
                  {col.drafts.map((p) => <PageRow key={p.id} page={p} showStatus onOpen={(pg) => goKb(pg.status === 'in_review' ? 'page' : 'editor', pg.id)} />)}
                </section>
              )}
            </div>
          </div>
          {settings && <CollectionSettings col={col} onClose={() => setSettings(false)} onSaved={setCol} />}
        </div>
      )}
    </AsyncSection>
  );
}
