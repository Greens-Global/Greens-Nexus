// Operations -> Rate Management, rebuilt as Miranda's CMA (Competitive Market
// Analysis, Oct 21 2026): "I don't like that the CMA is all on one page ...
// my mockup was set up so that each section is digestible and clear." Four
// screens, each its own item in the Pricing menu (FacilityOperations.jsx):
//
//   market           CMA Overview            cma/CmaOverview.jsx
//   market-comps     Comp Set & Manual Entry cma/CmaCompSet.jsx
//   market-history   Rate History            cma/CmaHistory.jsx
//   market-review    Review & Push           cma/CmaReview.jsx
//
// The facility is the page's one Facility dropdown (Neil), never a row of site
// pills. The overview data (GET /facility-ops/rates) is loaded once here and
// shared; the other screens read their own. The math is the server's
// (backend/ops_cma.py). Push to Cubby only exists behind the Operations switch
// (Settings > Global Settings > Operations, OFF by default): while it is off
// the Review screen ends in Mark Entered in Cubby and the server refuses pushes.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, LoadingState } from '../components/AsyncState';
import CmaOverview from './cma/CmaOverview';
import CmaCompSet from './cma/CmaCompSet';
import CmaHistory from './cma/CmaHistory';
import CmaReview from './cma/CmaReview';
import './cma/cma.css';

export default function RateManagement({ facility, section: sectionProp, onSection }) {
  const facilityId = facility?.id;
  const [own, setOwn] = useState('overview');
  const section = sectionProp || own;
  const go = (s) => { if (onSection) onSection(s); else setOwn(s); window.scrollTo?.({ top: 0, behavior: 'smooth' }); };
  const [state, setState] = useState({ status: 'loading', data: null });

  const load = useCallback(async () => {
    if (!facilityId) return;
    try {
      setState({ status: 'ready', data: await api.getOpsRates(facilityId) });
    } catch (err) {
      console.error('Operations: could not load rate management', err);
      setState((s) => (s.data?.facilityId === facilityId ? s : { status: 'error', data: null }));
    }
  }, [facilityId]);
  useEffect(() => { load(); }, [load]);

  if (!facility) {
    return (
      <div className="dash-card">
        <div className="dash-card-title">Pick a Facility</div>
        <div className="dash-card-sub">Pick a facility above to see Rate Management. Rates are set against the competitors around one facility at a time.</div>
      </div>
    );
  }
  const v = state.data?.facilityId === facilityId ? state.data : null;
  if (section === 'comps') return <CmaCompSet key={facilityId} facility={facility} onSection={go} />;
  if (section === 'review') return <CmaReview key={facilityId} facility={facility} onSection={go} onChanged={load} />;
  if (state.status === 'error' && !v) return <ErrorBanner message="Couldn't load rate management." onRetry={load} />;
  if (!v) return <LoadingState size="section" label="Loading rate management" minHeight={240} />;
  if (section === 'history') return <CmaHistory key={facilityId} facility={facility} view={v} onSection={go} />;
  return <CmaOverview key={facilityId} view={v} facility={facility} onSection={go} onReload={load}
    onView={(data) => setState({ status: 'ready', data })} />;
}
