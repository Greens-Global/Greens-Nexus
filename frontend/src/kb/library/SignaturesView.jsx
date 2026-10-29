// Who has signed a policy, who has not, Nudge (Resend when it signs through
// Nexus Sign), CSV.
import { useEffect, useState } from 'react';
import { ArrowLeft, Bell, Download } from 'lucide-react';
import { api, saveBlob } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { Av, Chip, Stat } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, fmtDateTime } from '../lib';
import { toCsv } from '../../operations/csv';

// Byte order mark: makes Excel read the file as UTF-8 (names with accents).
const BOM = String.fromCharCode(0xFEFF);

// toCsv defuses cells a spreadsheet would run as a formula (= + - @).
function csv(rows, cols) {
  return toCsv(cols.map((c) => c[0]), rows.map((r) => cols.map((c) => c[1](r))));
}

// A Nexus Sign envelope's state, as a chip (kb_policy_sign.state_for).
const ENVELOPE = {
  pending: ['Sent', '#2563eb'], declined: ['Declined', '#dc2626'], expired: ['Expired', '#b45309'], voided: ['Canceled', '#64748b'], '': ['Not Sent Yet', '#64748b'],
};

export default function SignaturesView({ id }) {
  const toast = useToast();
  const [page, setPage] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => { setErr(''); Promise.all([api.kbPage(id), api.kbSignatures(id)]).then(([p, s]) => { setPage(p); setData(s); }).catch((e) => setErr(errText(e))); };
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const nudge = async (emails = null) => {
    try {
      const r = await api.kbNudge(id, emails);
      if (r.resent) { toast(r.nudged ? `Sent ${r.nudged} new signing ${r.nudged === 1 ? 'request' : 'requests'}` : 'Everyone already has a signing request open'); load(); return; }
      toast(r.nudged ? `Nudged ${r.nudged} ${r.nudged === 1 ? 'person' : 'people'}` : 'Everyone was already nudged today');
    } catch (e) { toast(errText(e), 'err'); }
  };
  const viaSign = data?.signing === 'nexus_sign';
  const exportCsv = () => {
    const rows = [...data.signed.map((s) => ({ ...s, status: 'Signed' })), ...data.unsigned.map((u) => ({ ...u, status: u.envelope === 'declined' ? 'Declined' : u.overdue_days ? 'Overdue' : 'Not Signed' }))];
    saveBlob(new Blob([BOM, csv(rows, [['Name', (r) => r.name], ['Email', (r) => r.email], ['Status', (r) => r.status], ['Version', (r) => r.version || data.version], ['Signed', (r) => (r.signed_at ? fmtDateTime(r.signed_at) : '')], ['Due', (r) => (r.due ? fmtDate(r.due) : '')], ['Days Overdue', (r) => r.overdue_days || '']])], { type: 'text/csv;charset=utf-8' }), `${page.code || 'policy'}-signatures.csv`);
  };
  return (
    <AsyncSection loading={!data && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {data && page && (
        <div className="kb-page">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="kb-meta">
            <button type="button" className="kb-ibtn" style={{ width: 30, height: 30 }} aria-label="Back" onClick={() => goKb('page', id)}><ArrowLeft /></button>
            <a href="#p" onClick={(e) => { e.preventDefault(); goKb('page', id); }}>{page.title}</a> / <b style={{ color: 'var(--kb-ink)' }}>Signatures</b>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="kb-h1" style={{ margin: 0, fontSize: 24 }}>{page.title} <span className="kb-meta" style={{ fontWeight: 400 }}>v{data.version}</span></h1>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="kb-btn" onClick={exportCsv}><Download />CSV</button>
              <button type="button" className="kb-btn pri" disabled={!data.unsigned.length} onClick={() => nudge(null)}><Bell />{viaSign ? 'Resend to Everyone Unsigned' : 'Nudge Everyone Unsigned'}</button>
            </span>
          </div>
          <div className="kb-stats">
            <Stat value={`${data.signed_count} of ${data.audience_count}`} label="signed this version" />
            <Stat value={data.unsigned.length} label="not signed" color={data.unsigned.length ? '#dc2626' : undefined} />
            <Stat value={data.unsigned.filter((u) => u.overdue_days > 0).length} label="overdue" color="#dc2626" />
            <div className="kb-stat"><b style={{ fontSize: 15 }}>{data.audience_text}</b><span>who must sign{viaSign ? ' · through Nexus Sign' : ''}</span></div>
          </div>
          <div className="kb-cols">
            <section className="kb-card kb-main">
              <h3 className="kb-h3">Not Signed</h3>
              {data.unsigned.length === 0 && <div className="kb-empty">Everyone has signed v{data.version}.</div>}
              <table className="kb-table"><thead><tr><th>Person</th><th>Department</th><th>Due</th>{viaSign && <th>Nexus Sign</th>}<th>Signed Before</th><th /></tr></thead><tbody>
                {data.unsigned.map((u) => (
                  <tr key={u.email}>
                    <td><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Av name={u.name} email={u.email} size={24} />{u.name}</span></td>
                    <td>{u.department}</td>
                    <td>{u.due ? fmtDate(u.due) : ''}{u.overdue_days > 0 && <> <Chip color="#dc2626">{u.overdue_days} days late</Chip></>}</td>
                    {viaSign && <td title={u.declined_reason || undefined}><Chip color={(ENVELOPE[u.envelope] || ENVELOPE[''])[1]}>{(ENVELOPE[u.envelope] || ENVELOPE[''])[0]}</Chip></td>}
                    <td className="kb-meta">{u.signed_older ? `v${u.signed_older}` : 'Never'}</td>
                    <td><button type="button" className="kb-btn sm" disabled={viaSign && u.envelope === 'pending'} onClick={() => nudge([u.email])}><Bell />{viaSign ? 'Resend' : 'Nudge'}</button></td>
                  </tr>
                ))}
              </tbody></table>
            </section>
            <section className="kb-card kb-rail">
              <h3 className="kb-h3">Signed v{data.version}</h3>
              {data.signed.length === 0 && <div className="kb-empty">No signatures yet.</div>}
              {data.signed.map((s) => (
                <div key={s.email} className="kb-row"><Av name={s.name} email={s.email} size={24} /><div className="kb-grow"><div className="kb-title">{s.name}</div><div className="kb-meta">{fmtDateTime(s.signed_at)}{s.method === 'nexus_sign' ? ' · Nexus Sign' : s.typed_name ? ` · typed "${s.typed_name}"` : s.method === 'legacy' ? ' · before the rebuild' : ''}</div></div></div>
              ))}
            </section>
          </div>
        </div>
      )}
    </AsyncSection>
  );
}
