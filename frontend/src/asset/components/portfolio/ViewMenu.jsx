import { useEffect, useState } from 'react';
import { ChevronDown, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { MENU_PANEL, MenuHeading, MenuItem, MenuSep, menuKeys, useMenu } from './menuParts.jsx';
import { SUGGESTED_VIEWS, suggestedFilters, applyFilters } from '../../lib/portfolioQuery.js';

/** The view's name as the page's first word (Neil, 11/17/2026): suggested, saved, or a preset. */
export function viewTitle(view, saved = []) {
  if (!view || !view.id || view.id === 'all') return 'All Properties';
  const s = SUGGESTED_VIEWS.find(([k]) => k === view.id);
  if (s) return s[1];
  const mine = saved.find((v) => v.id === view.id);
  return mine?.name || view.name || 'Custom View';
}

/**
 * The Views menu: Suggested (counted live), Your Views (kept per person in the profile, table
 * 'asset-portfolio'), Save Current View..., Manage Views (rename, delete), Copy Link to This
 * View. Sharing is the link - there is no shared-views store.
 */
export function ViewMenu({ view, title, edited, ctx, me, saved = [], onSave, onApply, onCopyLink, askSave = 0 }) {
  const { open, setOpen, btn, panel, close } = useMenu();
  const [mode, setMode] = useState('pick');   // pick | save | manage
  const [name, setName] = useState('');
  // "Save as View" beside the filter words opens this menu on its Save step.
  useEffect(() => { if (askSave) { setMode('save'); setName(''); setOpen(true); } }, [askSave, setOpen]);
  const [renaming, setRenaming] = useState(null);
  const count = (filters) => applyFilters(ctx, filters).length;
  const shut = () => { close(); setMode('pick'); setRenaming(null); };
  const isOn = (id) => view?.id === id && !edited;

  const save = () => {
    const n = name.trim();
    if (!n) return;
    const id = `u${Date.now().toString(36)}`;
    const filters = { ...(view.filters || {}), q: '' };
    onSave([...saved, { id, name: n, filters, groupBy: view.groupBy || 'none', sort: view.sort || 'name', mode: view.mode || '', columns: view.columns || null }]);
    onApply({ ...view, id, name: n });
    setName('');
    shut();
  };

  return (
    <>
      <button ref={btn} type="button" className="pt-view-btn" aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setMode('pick'); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <span>{title}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {edited && <span className="pt-view-edited">- edited</span>}
      <AnchoredMenu anchorRef={btn} open={open} onClose={shut} minWidth={300} style={{ ...MENU_PANEL, maxWidth: 360 }} aria-label="Views">
        <div ref={panel} onKeyDown={mode === 'pick' ? menuKeys : undefined}>
          {mode === 'pick' && (
            <>
              <MenuHeading>Suggested</MenuHeading>
              {SUGGESTED_VIEWS.map(([id, label]) => (
                <MenuItem key={id} radio checked={isOn(id)} count={count(suggestedFilters(id, me))}
                  onClick={() => { shut(); onApply({ id, name: label, filters: suggestedFilters(id, me), groupBy: id === 'development' ? 'stage' : 'none', sort: 'name' }); }}>
                  {label}
                </MenuItem>
              ))}
              {saved.length > 0 && (
                <>
                  <MenuSep />
                  <MenuHeading>Your Views</MenuHeading>
                  {saved.map((v) => (
                    <MenuItem key={v.id} radio checked={isOn(v.id)} count={count(v.filters)} onClick={() => { shut(); onApply({ ...v }); }}>{v.name}</MenuItem>
                  ))}
                </>
              )}
              <MenuSep />
              <MenuItem Icon={Plus} onClick={() => { setMode('save'); setName(edited || view.id === 'all' ? '' : title); }}>Save Current View...</MenuItem>
              {saved.length > 0 && <MenuItem Icon={Pencil} onClick={() => setMode('manage')}>Manage Views</MenuItem>}
              <MenuItem Icon={Link2} onClick={() => { shut(); onCopyLink(); }}>Copy Link to This View</MenuItem>
            </>
          )}
          {mode === 'save' && (
            <form className="pt-menu-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <label className="pt-menu-label" htmlFor="pt-save-view">Name this view</label>
              <input id="pt-save-view" data-autofocus className="form-input" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="California Self-Storage" />
              <div className="pt-menu-hint-line">Kept for you. Copy Link shares it with anyone who can open Asset Management.</div>
              <div className="pt-menu-actions">
                <button type="button" className="secondary-btn" onClick={() => setMode('pick')}>Back</button>
                <button type="submit" className="primary-btn" disabled={!name.trim()}>Save View</button>
              </div>
            </form>
          )}
          {mode === 'manage' && (
            <div className="pt-menu-form">
              <div className="pt-menu-label">Your Views</div>
              {saved.map((v) => (
                <div key={v.id} className="pt-manage-row">
                  {renaming?.id === v.id ? (
                    <form style={{ display: 'flex', gap: 6, flex: 1 }} onSubmit={(e) => { e.preventDefault(); const n = renaming.name.trim(); if (n) onSave(saved.map((x) => (x.id === v.id ? { ...x, name: n } : x))); setRenaming(null); }}>
                      <input className="form-input" autoFocus value={renaming.name} maxLength={60} aria-label={`Rename ${v.name}`}
                        onChange={(e) => setRenaming({ id: v.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} />
                      <button type="submit" className="secondary-btn">Save</button>
                    </form>
                  ) : (
                    <>
                      <span className="pt-manage-name">{v.name}</span>
                      <button type="button" className="pt-icon-btn" aria-label={`Rename ${v.name}`} onClick={() => setRenaming({ id: v.id, name: v.name })}><Pencil size={14} /></button>
                      <button type="button" className="pt-icon-btn" aria-label={`Delete ${v.name}`} onClick={() => onSave(saved.filter((x) => x.id !== v.id))}><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              ))}
              {!saved.length && <div className="pt-menu-hint-line">No saved views.</div>}
              <div className="pt-menu-actions"><button type="button" className="secondary-btn" onClick={() => setMode('pick')}>Done</button></div>
            </div>
          )}
        </div>
      </AnchoredMenu>
    </>
  );
}
