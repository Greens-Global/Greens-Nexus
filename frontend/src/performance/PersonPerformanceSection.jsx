// People > a person's profile > Performance (Neil, Oct 29 2026): their
// numbers this quarter, their current goals and their reviews - past ones
// with the signed copies - on the same page the employee sees. Only for
// whoever may read them (the person's reporting chain and HR); anyone else
// gets nothing here at all, not an error.
import { useEffect, useState } from 'react';
import { api } from '../api';
import PersonPerformance from './PersonPerformance';
import { HD } from './lib';

export default function PersonPerformanceSection({ email, name, toastOk, toastErr }) {
  const [ctx, setCtx] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [allowed, setAllowed] = useState(null);
  useEffect(() => {
    let live = true;
    if (!email) return undefined;
    Promise.all([api.perfMe(), api.perfReviews(email)])
      .then(([c, r]) => { if (live) { setCtx(c); setReviews(r?.team || []); setAllowed(true); } })
      .catch(() => { if (live) setAllowed(false); });
    return () => { live = false; };
  }, [email]);
  if (!allowed || !ctx) return null;
  const reportsToMe = (ctx.reports || []).some(r => r.email === (email || '').toLowerCase());
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="profile-performance">
      <span style={{ ...HD, fontSize: 15 }}>Performance</span>
      <PersonPerformance ctx={ctx} email={email} name={name} reviews={reviews} canAdd={reportsToMe || ctx.isHr}
        toastOk={toastOk} toastErr={toastErr} />
    </div>
  );
}
