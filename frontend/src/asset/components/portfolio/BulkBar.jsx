import { useState } from 'react';
import AnchoredMenu from '../../../components/AnchoredMenu';
import { MENU_PANEL, MenuItem, menuKeys, useMenu } from './menuParts.jsx';
import { DEV_STAGE_OPTIONS } from '../../lib/propertyFields.js';

function ActionMenu({ label, children, width = 240 }) {
  const { open, setOpen, btn, panel, close } = useMenu();
  return (
    <>
      <button ref={btn} type="button" className="pt-link" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} minWidth={width} style={{ ...MENU_PANEL, maxHeight: 360 }} aria-label={label}>
        <div ref={panel} onKeyDown={menuKeys}>{children(() => close())}</div>
      </AnchoredMenu>
    </>
  );
}

/**
 * The quiet line a selection brings (Neil, 11/17/2026): "3 selected - Set Company, Set Asset
 * Manager, Set Stage, Clear". Each choice goes through the store's own save (one row each,
 * one Activity entry per asset); a company the person may not assign is refused by the server
 * row by row, and the refusal says so.
 */
export function BulkBar({ count, companies = [], canClearCompany = false, managers = [], onSet, onClear, canEdit = true }) {
  const [name, setName] = useState('');
  if (!count) return null;
  const assignable = companies.filter((c) => c.assignable);
  return (
    <div className="pt-bulk" role="region" aria-label="Selected properties">
      <b>{count} selected</b>
      {canEdit ? (
        <>
          <span className="pt-sep" aria-hidden="true">·</span>
          <ActionMenu label="Set Company">
            {(close) => (
              <>
                {assignable.map((c) => <MenuItem key={c.id} onClick={() => { close(); onSet('company', c.id); }}>{c.name}</MenuItem>)}
                {canClearCompany && <MenuItem onClick={() => { close(); onSet('company', ''); }}>No Company</MenuItem>}
                {!assignable.length && !canClearCompany && <div className="pt-menu-hint-line">No company you may assign.</div>}
              </>
            )}
          </ActionMenu>
          <span className="pt-sep" aria-hidden="true">·</span>
          <ActionMenu label="Set Asset Manager" width={280}>
            {(close) => (
              <>
                <form className="pt-menu-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { close(); onSet('manager', name.trim()); setName(''); } }}>
                  <input data-autofocus className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Type a name" aria-label="Asset manager's name"
                    onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.form.parentElement.querySelector('[role="menuitem"]')?.focus(); } }} />
                </form>
                {managers.filter((m) => !name.trim() || m.label.toLowerCase().includes(name.trim().toLowerCase())).slice(0, 8).map((m) => (
                  <MenuItem key={m.key} onClick={() => { close(); onSet('manager', m.label); setName(''); }}>{m.label}</MenuItem>
                ))}
                {name.trim() && <MenuItem onClick={() => { close(); onSet('manager', name.trim()); setName(''); }}>Set to "{name.trim()}"</MenuItem>}
              </>
            )}
          </ActionMenu>
          <span className="pt-sep" aria-hidden="true">·</span>
          <ActionMenu label="Set Stage">
            {(close) => DEV_STAGE_OPTIONS.map((s) => <MenuItem key={s} onClick={() => { close(); onSet('stage', s); }}>{s}</MenuItem>)}
          </ActionMenu>
        </>
      ) : <span className="pt-dim">Changing several at once needs edit access to Asset Management.</span>}
      <span className="pt-sep" aria-hidden="true">·</span>
      <button type="button" className="pt-link is-quiet" onClick={onClear}>Clear</button>
    </div>
  );
}
