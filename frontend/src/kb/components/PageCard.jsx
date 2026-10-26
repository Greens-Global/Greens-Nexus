// One page as a row (lists, search results, rails).
import { Pin } from 'lucide-react';
import { TypeChip, VerifiedChip, StatusChip } from './Chips';
import { goKb, fmtDate } from '../lib';

export default function PageRow({ page, snippet, showStatus = false, right, compact = false, onOpen }) {
  const open = () => (onOpen ? onOpen(page) : goKb('page', page.id));
  return (
    <div className="kb-row link" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
         style={{ alignItems: compact ? 'center' : 'flex-start' }}>
      <TypeChip type={page.page_type} />
      <div className="kb-grow">
        <div className="kb-title" style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className={compact ? 'kb-ellipsis' : ''} style={compact ? { maxWidth: '100%' } : {}}>{page.title}</span>
          {page.code && <span className="kb-meta" style={{ fontWeight: 400 }}>{page.code}</span>}
          {page.version && page.status === 'approved' && <span className="kb-meta" style={{ fontWeight: 400 }}>v{page.version}</span>}
          {page.pinned && <Pin size={12} style={{ color: 'var(--kb-green)' }} />}
        </div>
        {!compact && (snippet || page.summary) && <div className="kb-meta" style={{ marginTop: 2, fontSize: 13 }}>{snippet || page.summary}</div>}
        {!compact && (
          <div className="kb-meta" style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {showStatus && <StatusChip status={page.status} />}
            <VerifiedChip page={page} />
            {(page.collection || []).length > 0 && <span>{page.collection.map((c) => c.name).join(' / ')}</span>}
            {page.owner_name && <span>· {page.owner_name}</span>}
            {page.updated_at && <span>· {fmtDate(page.updated_at)}</span>}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}
