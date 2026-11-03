// Settings > Hiring & Onboarding > Federal Forms (Neil, 11/02/2026). Read-only:
// the edition of each form built into Nexus, when it lapses, Current /
// Expiring / Expired as a soft label, and where the form came from. Nothing
// to set - an edition changes in code (docs/Federal-Forms.md), and the daily
// watch tells HR and administrators when one is about to lapse. The states
// and the wording come from GET /hr/federal-forms/status; nothing is worked
// out here.
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { SettingRow } from './SettingsUI';
import { StatusLabel } from '../StatusLabel';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';

const STATE_META = {
  ok:       { label: 'Current',  color: '#16a34a' },
  expiring: { label: 'Expiring', color: '#d97706' },
  expired:  { label: 'Expired',  color: '#dc2626' },
};

// One sentence per form: the server's message, with the edition and the
// expiry added only where the message does not already say them.
function describe(f) {
  const msg = String(f.message || '').trim();
  const parts = [];
  if (f.editionLabel && !msg.includes(f.editionLabel)) parts.push(`Edition ${f.editionLabel}.`);
  if (msg) parts.push(msg);
  if (f.expires && !/\d{2}\/\d{2}\/\d{4}/.test(msg)) parts.push(`Expires ${f.expires}.`);
  return parts.join(' ');
}

export default function FederalFormsStatus() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.federalFormsStatus()
      .then(r => { if (live) setRows(Array.isArray(r?.forms) ? r.forms : []); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [tick]);
  return (
    <AsyncSection loading={!rows && !error} error={!!error} onRetry={() => { setError(false); setRows(null); setTick(t => t + 1); }}
      errorMessage="The form editions could not be loaded right now."
      skeleton={<div style={{ padding: 14 }}><SkeletonBlocks count={3} height={44} borderRadius={8} /></div>}>
      <div className="nx-set-note" style={{ borderTop: 'none', borderBottom: '1px solid var(--line)' }}>
        HR and administrators are told before an edition lapses. A new edition needs a Nexus update - ask your Nexus administrator.
      </div>
      {rows?.map(f => {
        const meta = STATE_META[f.state] || STATE_META.ok;
        const http = /^https?:\/\//i.test(String(f.sourceUrl || ''));
        return (
          <SettingRow key={f.kind} title={f.title}
            desc={(
              <>
                {/* The message usually carries the edition and the date itself ("Form W-4
                    (2026) is current through 01/31/2027."); each is added only when it does
                    not, so neither ever reads twice. */}
                {describe(f)}
                {' '}
                {http
                  ? <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--wk-brand, var(--pine))', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>Source <ExternalLink size={11} aria-hidden="true" /></a>
                  : <span>Built in Nexus.</span>}
              </>
            )}
            control={<StatusLabel label={meta.label} color={meta.color} title={f.message || undefined} />} />
        );
      })}
      {rows && rows.length === 0 && <div className="nx-set-note">No forms are registered on this server.</div>}
    </AsyncSection>
  );
}
