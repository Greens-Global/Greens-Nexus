// Items phase 4 - the item a tag opened: a sheet from the right (full screen
// on a phone) with what the item is, where it is now, and the one or two
// things this person can do with it. Also the calm states around it: still
// loading, and "You Do Not Have Access to This Item" when the server walls it
// off (a tag from another company, or a deleted item) - never a blank screen.
//
// The redesign's item record can take this sheet's place: ItemScanHost's
// `renderItem` prop draws the found item instead (see index.js).
import { Package, Lock, ScanLine, MapPin } from 'lucide-react';
import { Modal } from '../../tasks/components';
import { btn, NX } from '../../tasks/theme';
import { SkeletonBlocks } from '../../components/AsyncState';
import { TypeBadge, StatusBadge } from '../ui/badges';
import { InUseSummary } from '../checkout/InUseSummary';

export function ItemQuickSheet({ status, item, view, onAction, onClose, onScanAnother }) {
  const title = status === 'found' && item ? item.name : 'Item';
  const footer = (
    <>
      {onScanAnother && (
        <button type="button" style={{ ...btn('outline'), marginRight: 'auto' }} onClick={onScanAnother}>
          <ScanLine size={14} /> Scan Another
        </button>
      )}
      <button type="button" style={btn('ghost')} onClick={onClose}>{status === 'denied' ? 'Back to Items' : 'Close'}</button>
    </>
  );
  return (
    <Modal title={title} onClose={onClose} footer={footer} width={520} minHeight="40vh" zIndex={4200}>
      {status === 'loading' && (
        <div role="status" aria-label="Loading the item"><SkeletonBlocks count={3} height={64} borderRadius={10} /></div>
      )}
      {status === 'denied' && <NoAccess />}
      {status === 'error' && (
        <div role="alert" style={{ fontSize: 13.5, color: NX.dim, lineHeight: 1.5 }}>
          Nexus could not load this item right now. Check your connection, then open the link again.
        </div>
      )}
      {status === 'found' && item && <ItemBody item={item} view={view} onAction={onAction} />}
    </Modal>
  );
}

export function NoAccess() {
  return (
    <div role="alert" data-testid="nx-item-no-access" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12, padding: '32px 12px' }}>
      <span style={{ width: 52, height: 52, borderRadius: 16, background: NX.surface2, border: `1px solid ${NX.border}`, color: NX.dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <Lock size={22} />
      </span>
      <div style={{ fontSize: 17, fontWeight: 700, color: NX.ink }}>You Do Not Have Access to This Item</div>
      <div style={{ fontSize: 13.5, color: NX.dim, lineHeight: 1.55, maxWidth: 420 }}>
        It belongs to another company, or it was deleted. If you think you should see it, ask whoever manages your items.
      </div>
    </div>
  );
}

function Row({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: `1px solid ${NX.border2}`, fontSize: 13.5 }}>
      <div style={{ width: 110, flexShrink: 0, color: NX.dim, fontWeight: 600 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, color: NX.ink, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

function ItemBody({ item, view, onAction }) {
  const actions = view?.actions || [];
  const co = view?.checkout;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ width: 88, height: 88, borderRadius: 12, flexShrink: 0, overflow: 'hidden', background: NX.surface2, border: `1px solid ${NX.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: NX.faint }}>
          {item.photoUrl ? <img src={item.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Package size={26} />}
        </div>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <TypeBadge type={item.itemType} />
            <StatusBadge status={item.status} item={item} />
          </div>
          {item.serialNumber && <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, fontWeight: 600, color: NX.ink }}>{item.serialNumber}</div>}
          {item.location && <div style={{ fontSize: 12.5, color: NX.dim, display: 'flex', alignItems: 'center', gap: 4 }}><MapPin size={12} /> {item.location}</div>}
        </div>
      </div>

      {view?.state && (
        <div role="status" style={{ fontSize: 14, fontWeight: 600, color: NX.ink, padding: '11px 14px', borderRadius: 10, background: NX.surface2, border: `1px solid ${NX.border}` }}>
          {view.state}
        </div>
      )}
      {co && co.status === 'allocated' && <InUseSummary checkout={co} />}

      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {actions.map((a) => (
            <button key={a.key} type="button" onClick={() => onAction?.(a.key)}
              style={{ ...btn(a.primary ? 'primary' : 'outline'), minHeight: 40, padding: '9px 16px', fontSize: 13.5 }}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      <div>
        <Row label="Department">{item.department}</Row>
        <Row label="Make">{[item.make, item.model, item.year].filter(Boolean).join(' ')}</Row>
        <Row label="Assigned To">{item.assignedToName}</Row>
      </div>
    </div>
  );
}
