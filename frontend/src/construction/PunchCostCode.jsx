// The cost code at punch-in (Construction Round Three item 3, Neil,
// 11/11/2026). On the Time Clock page, above the punch row, only when the
// person's shift today is placed on a job whose managers listed labor cost
// codes (GET /construction/my-cost-codes). Never required: "No Cost Code"
// is always a choice and nothing is blocked. The last code is remembered
// per person and per job (lib/punchCostCode.js) and goes with the next
// punch-in through punchDurable; the server keeps it only for that job.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { rememberCode, rememberedCode, setPunchCostCode } from '../lib/punchCostCode';

// The person's own calendar day - what the Time Clock calls today.
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function PunchCostCode() {
  const { myEmail } = useRole();
  const [offer, setOffer] = useState(null);   // { jobId, jobName, codes } | null
  const [code, setCode] = useState('');

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.getMyCostCodes(localDay()))
      .then((d) => {
        if (!live || !d?.codes?.length) return;
        const last = rememberedCode(myEmail, d.jobId);
        const pick = d.codes.some((c) => c.code === last) ? last : '';
        setOffer(d);
        setCode(pick);
        setPunchCostCode(pick ? { jobId: d.jobId, code: pick } : null);
      })
      .catch(() => { /* no offer: the punch goes without a code, as always */ });
    return () => { live = false; setPunchCostCode(null); };
  }, [myEmail]);

  if (!offer) return null;
  const choose = (v) => {
    setCode(v);
    rememberCode(myEmail, offer.jobId, v);
    setPunchCostCode(v ? { jobId: offer.jobId, code: v } : null);
  };
  return (
    <label data-punch-cost-code="" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)', flexBasis: '100%' }}>
      <span>Cost Code on <b style={{ color: 'var(--text-primary)' }}>{offer.jobName}</b></span>
      <select className="form-input" aria-label="Cost Code" value={code} onChange={(e) => choose(e.target.value)}
        style={{ width: 'min(260px, 100%)', minHeight: 40 }}>
        <option value="">No Cost Code</option>
        {offer.codes.map((c) => <option key={c.code} value={c.code}>{c.name ? `${c.code} - ${c.name}` : c.code}</option>)}
      </select>
    </label>
  );
}
