// Manage > Collections: the shelves, their owners and review cycles.
import { useEffect, useState } from 'react';
import { Plus, ChevronRight } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Modal } from '../../tasks/components';
import { Av, Chip } from '../components/Chips';
import PeoplePick from '../components/PeoplePick';
import { useToast, errText } from '../components/Toast';
import { goKb, colorFor, plural } from '../lib';

export default function CollectionsAdmin({ me }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [create, setCreate] = useState(null);   // {parent_id}
  const [form, setForm] = useState({ name: '', department: '', owner_email: '', description: '', review_every_months: 12 });
  const load = () => { setErr(''); api.kbCollections().then(setRows).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, []);
  const save = async () => {
    try { await api.kbCreateCollection({ ...form, parent_id: create.parent_id || '', department: create.parent_id ? '' : (form.department || form.name) }); toast('Collection created'); setCreate(null); setForm({ name: '', department: '', owner_email: '', description: '', review_every_months: 12 }); load(); } catch (e) { toast(errText(e), 'err'); }
  };
  const setOwner = async (c, email) => { try { await api.kbUpdateCollection(c.id, { owner_email: email }); load(); } catch (e) { toast(errText(e), 'err'); } };
  const tops = (rows || []).filter((c) => !c.parent_id);
  return (
    <div className="kb-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>Collections</h1>
        <div className="kb-seg">
          <button type="button" onClick={() => goKb('health')}>Health</button>
          <button type="button" onClick={() => goKb('compliance')}>Compliance</button>
          <button type="button" className="on">Collections</button>
          <button type="button" onClick={() => goKb('plans')}>Plans and Rules</button>
        </div>
        {me?.can_manage && <button type="button" className="kb-btn pri" style={{ marginLeft: 'auto' }} onClick={() => setCreate({ parent_id: '' })}><Plus />New Collection</button>}
      </div>
      <div className="kb-meta">Top level is a department. Under it, one level of sub-collections. Every collection has an owner who approves its pages, hears about stale ones, and can publish directly.</div>
      <AsyncSection loading={!rows && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load} isEmpty={rows && rows.length === 0} emptyContent={<div className="kb-card soft kb-empty">No collections. Run the migration from Health to create one per department, or add one here.</div>}>
        <section className="kb-card" style={{ padding: 0 }}>
          <table className="kb-table">
            <thead><tr><th>Collection</th><th>Owner</th><th>Review Every</th><th>Pages</th><th /></tr></thead>
            <tbody>
              {tops.map((c) => [c, ...(rows || []).filter((x) => x.parent_id === c.id)].map((x, i) => (
                <tr key={x.id} style={!x.active ? { opacity: .5 } : {}}>
                  <td><span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: i ? 22 : 0 }}>{i ? <ChevronRight size={14} style={{ color: 'var(--kb-dim)' }} /> : <Av name={x.owner_name} email={x.owner_email} size={24} color={colorFor(x.id)} />}<a href="#c" onClick={(e) => { e.preventDefault(); goKb('collection', x.id); }} style={{ fontWeight: i ? 500 : 600, color: 'inherit' }}>{x.name}</a>{!x.active && <Chip color="#9ca3af">Inactive</Chip>}</span>{x.description && <div className="kb-meta" style={{ paddingLeft: i ? 44 : 32 }}>{x.description}</div>}</td>
                  <td style={{ minWidth: 240 }}>{me?.can_manage || me?.owned_collections?.includes(x.id) ? <PeoplePick value={x.owner_email} onChange={(v) => setOwner(x, v)} preferManagers placeholder="Assign an owner" /> : (x.owner_name || <Chip color="#dc2626">None</Chip>)}</td>
                  <td>{x.review_every_months} months</td>
                  <td>{plural(x.pages, 'page')}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{!i && me?.can_manage && <button type="button" className="kb-btn sm ghost" onClick={() => setCreate({ parent_id: x.id, parent_name: x.name })}><Plus />Sub-collection</button>}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </section>
      </AsyncSection>
      {create && (
        <Modal title={create.parent_id ? `New Sub-collection in ${create.parent_name}` : 'New Collection'} onClose={() => setCreate(null)} minHeight="40vh" footer={<div className="kb" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="kb-btn" onClick={() => setCreate(null)}>Cancel</button><button type="button" className="kb-btn pri" disabled={!form.name.trim()} onClick={save}>Create</button></div>}>
          <div className="kb" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="kb-field"><label>Name</label><input className="kb-input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={create.parent_id ? 'Site Operations' : 'Operations'} /></div>
            {!create.parent_id && <div className="kb-field"><label>People department it stands for</label><input className="kb-input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Same as the name, usually" /><div className="kb-help">Used for page codes (OPS-014) and the compliance filters.</div></div>}
            <div className="kb-field"><label>Owner</label><PeoplePick value={form.owner_email} onChange={(v) => setForm({ ...form, owner_email: v })} preferManagers /></div>
            <div className="kb-field"><label>Description</label><input className="kb-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What lives here" /></div>
            <div className="kb-field"><label>Review every</label><select className="kb-select" style={{ width: 160 }} value={form.review_every_months} onChange={(e) => setForm({ ...form, review_every_months: Number(e.target.value) })}>{[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months</option>)}</select></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
