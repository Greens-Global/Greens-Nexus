// Operations > Reports > Reports: Cubby's report list, interactive (Neil,
// Oct 20). Pick a report on the left; it opens as a table that follows the
// facility and period, sorts, searches, opens tenants and units, and saves as
// a CSV. Where a report comes from is printed on it: Cubby's own report, built
// in Nexus from the synced Cubby data, or not available from Cubby yet.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorBanner, LoadingState, SkeletonBlocks } from '../components/AsyncState';
import { formatDate, formatDateTime } from '../lib/datetime';
import DrillPanel from './DrillPanel';
import ReportTable from './ReportTable';

const SOURCE = {
  cubby: ['Cubby Report', 'pill-info'],
  nexus: ['Built From Cubby Data', 'pill-ok'],
  unavailable: ['Not Available From Cubby Yet', 'pill-warn'],
};

// The facility is the page's Facility dropdown (Oct 20): All, or the one picked.
export default function CubbyReports({ scope, range }) {
  const [catalog, setCatalog] = useState({ status: 'loading' });
  const [picked, setPicked] = useState('rent-roll');
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [report, setReport] = useState({ status: 'idle' });
  const [drill, setDrill] = useState(null);
  const one = scope.length === 1 ? scope[0] : null;

  // The page's period picker sets the dates; the boxes can then narrow them.
  useEffect(() => { setFrom(range.from); setTo(range.to); }, [range.from, range.to]);

  useEffect(() => {
    let live = true;
    api.opsReportCatalog()
      .then((data) => { if (live) setCatalog({ status: 'ready', data }); })
      .catch((err) => { if (live) setCatalog({ status: 'error', error: err }); });
    return () => { live = false; };
  }, []);

  const meta = useMemo(() => catalog.data?.reports.find((r) => r.key === picked), [catalog.data, picked]);

  const load = useCallback(async () => {
    if (!meta) return;
    setReport((r) => ({ status: 'loading', data: r.data?.key === meta.key ? r.data : null }));
    try {
      const data = await api.opsReport(meta.key, { facilityId: one?.id || '', start: meta.period ? from : '', end: meta.period ? to : '' });
      setReport({ status: 'ready', data });
    } catch (err) {
      console.error('Operations report failed', err);
      setReport({ status: 'error', error: err?.message || "Couldn't build this report." });
    }
  }, [meta, one, from, to]);

  useEffect(() => { load(); }, [load]);

  const onDrill = useCallback((kind, fid, id) => setDrill([kind, fid, id]), []);

  if (catalog.status === 'loading') return <div className="dash-card"><SkeletonBlocks count={3} height={60} /></div>;
  if (catalog.status === 'error') return <ErrorBanner message="Couldn't load the report list." />;

  const { categories, reports } = catalog.data;
  const data = report.data;
  const where = one ? one.shortName : 'All Facilities';

  return (
    <div className="ops-rep-grid">
      <nav className="dash-card ops-rep-list" aria-label="Reports">
        {categories.map((cat) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div className="ops-drill-h">{cat}</div>
            {reports.filter((r) => r.category === cat).map((r) => (
              <button key={r.key} type="button" className="ops-rep-item" aria-current={r.key === picked ? 'true' : undefined}
                onClick={() => setPicked(r.key)}>
                <span>{r.title}</span>
                {r.source === 'unavailable' && <span className="status-badge pill-warn" style={{ fontSize: 10 }}>Not Available</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="dash-card" style={{ minWidth: 0 }}>
        {meta && (
          <>
            <div className="dash-card-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div className="dash-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {meta.title} <span className={`status-badge ${SOURCE[meta.source][1]}`}>{SOURCE[meta.source][0]}</span>
                </div>
                <div className="dash-card-sub">{meta.about}</div>
              </div>
            </div>
            <div className="ops-rep-bar">
              {meta.period && (
                <>
                  <label className="ops-period"><span>From</span>
                    <input type="date" className="form-input" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
                  </label>
                  <label className="ops-period"><span>To</span>
                    <input type="date" className="form-input" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
                  </label>
                </>
              )}
              {!meta.period && <span className="ops-note" style={{ margin: 0 }}>{where} - as of the last Cubby sync.</span>}
            </div>
            {report.status === 'loading' && !data && <LoadingState size="section" label={`Building ${meta.title}`} minHeight={220} />}
            {report.status === 'error' && <ErrorBanner message={report.error} onRetry={load} />}
            {data && data.key === meta.key && (
              <div style={{ opacity: report.status === 'loading' ? 0.55 : 1, transition: 'opacity .15s' }}>
                {data.notes?.length > 0 && data.available !== false && (
                  <ul className="ops-rep-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                )}
                {data.available === false
                  ? <div className="ops-empty">{data.notes?.[0]}</div>
                  : (
                    <>
                      <ReportTable title={data.title} where={where} asOf={data.period?.to || data.asOf} columns={data.columns} rows={data.rows}
                        totals={data.totals} groups={data.groups} onDrill={onDrill} />
                      <p className="ops-note" style={{ marginTop: 10 }}>
                        {data.period ? `${formatDate(data.period.from)} - ${formatDate(data.period.to)}. ` : ''}
                        {data.fetchedAt ? `Cubby data from ${formatDateTime(data.fetchedAt)}. ` : ''}
                        Tenant name, unit and money only: no phone, email or address. Click a tenant or a unit to see more.
                      </p>
                    </>
                  )}
              </div>
            )}
          </>
        )}
      </div>
      {drill && <DrillPanel key={drill.join(':')} target={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
