// Paper posters at a site (Workplace Notices part 6). The online copies add
// to the paper ones; they never replace them at the office or a job site.
// One site's checklist: the posters it needs now, which current versions are
// confirmed up (with a photo), confirm more, and print the QR sheet that
// hangs beside them.
import { useState } from 'react';
import QRCode from 'qrcode';
import { Camera, Printer } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';
import { filesFromPaste } from '../tasks/lib';
import { Chip, areaLabel } from './lib';

const STATUS = {
  confirmed: { label: 'Posted', bg: 'hsla(var(--color-green),0.1)', color: 'hsl(var(--color-green))' },
  missing:   { label: 'Not Confirmed', bg: 'rgba(220,38,38,0.08)', color: '#b91c1c' },
  no_file:   { label: 'No Approved File', bg: 'var(--wk-hover)', color: 'var(--muted)' },
};

export default function SitePosters({ site, onChanged, toastOk, toastErr }) {
  const [picked, setPicked] = useState([]);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const missing = site.required.filter(r => r.status === 'missing');
  const toggle = (id) => setPicked(x => (x.includes(id) ? x.filter(y => y !== id) : [...x, id]));
  const confirm = () => {
    const form = new FormData();
    form.append('notice_ids', picked.join(','));
    form.append('photo', photo);
    setBusy(true);
    api.confirmNoticePosting(site.id, form).then(() => { setPicked([]); setPhoto(null); toastOk?.('Confirmed.'); onChanged?.(); })
      .catch(e => toastErr?.(e?.message || 'Could not save it.')).finally(() => setBusy(false));
  };
  const onPaste = (e) => { const f = filesFromPaste(e)[0]; if (f) { e.preventDefault(); setPhoto(f); } };

  return (
    <div onPaste={onPaste} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {!site.required.length && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{site.state ? 'No posters apply here right now.' : 'This site has no state in its address - fix it in the Location Library.'}</div>}
      {site.required.map(r => (
        <label key={r.noticeId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '4px 0' }}>
          {r.status === 'missing' ? <input type="checkbox" checked={picked.includes(r.noticeId)} onChange={() => toggle(r.noticeId)} /> : <span style={{ width: 13 }} />}
          <span style={{ flex: 1 }}>{r.title}<span style={{ color: 'var(--muted)', fontSize: 12 }}> - {areaLabel(r.area)}{r.label ? `, ${r.label}` : ''}</span></span>
          {r.status === 'confirmed' && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{formatDateTime(r.confirmedAt)}</span>}
          <Chip spec={STATUS[r.status]} />
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        {missing.length > 0 && (
          <>
            <button className="secondary-btn" onClick={() => setPicked(missing.map(m => m.noticeId))} style={{ fontSize: 12 }}>Select All Not Confirmed</button>
            <label className="secondary-btn" style={{ fontSize: 12, cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Camera size={12} /> {photo ? photo.name : 'Add Photo'}
              <input type="file" accept="image/*" capture="environment" hidden onChange={e => { setPhoto(e.target.files?.[0] || null); e.target.value = ''; }} />
            </label>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>or press Ctrl+V to paste a photo</span>
            <button className="primary-btn" disabled={busy || !photo || !picked.length} onClick={confirm} style={{ fontSize: 12 }}>Confirm {picked.length || ''} Posted</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button className="secondary-btn" onClick={() => printSheet(site)} style={{ fontSize: 12 }}><Printer size={12} /> Print QR Sheet</button>
      </div>
    </div>
  );
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The sheet beside the posters: the list that must be up here, and a QR code
// to the online copies. Opened in its own window and printed from there.
async function printSheet(site) {
  const link = `${window.location.origin}/workday/notices`;
  const qr = await QRCode.toDataURL(link, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
  const rows = site.required.filter(r => r.status !== 'no_file')
    .map(r => `<li>${esc(r.title)}${r.formCode ? ` <span>(${esc(r.formCode)})</span>` : ''}</li>`).join('');
  const w = window.open('', '_blank', 'width=820,height=1000');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Workplace Notices - ${esc(site.name)}</title>
<style>body{font-family:Inter,Arial,sans-serif;margin:40px;color:#0f172a}h1{font-size:24px;margin:0 0 4px}p{color:#475569}
ul{columns:2;font-size:14px;line-height:1.7}li span{color:#64748b}.qr{display:flex;gap:20px;align-items:center;border:2px solid #0f172a;padding:16px;margin-top:24px}</style>
</head><body><h1>Workplace Notices - ${esc(site.name)}</h1><p>${esc(site.address)}</p>
<p>These labor law posters are required at this site and must stay posted where everyone can read them:</p><ul>${rows}</ul>
<div class="qr"><img src="${qr}" width="160" height="160" alt="QR code"/><div><b>Digital copies</b><br/>Scan to open your Workplace Notices in Nexus (sign in required). The paper posters above remain the official posting.<br/><small>${esc(link)}</small></div></div>
<script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
}
