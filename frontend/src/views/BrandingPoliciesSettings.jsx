// Settings > Global Settings > Branding & Policies (Sep 26, 2026).
//
// Three panels, each rendered inside an AdminConsole <Section> (so each only
// mounts, and fetches, once it is opened):
//   * BrandColorPanel     - the app and sign-in accent (backend routers/branding.py
//                           branding_config); applied at once via lib/brandAccent.js.
//   * EmailAppearancePanel - one theme for every Nexus email (backend
//                           email_theme.py, key email_theme_config) with a
//                           server-rendered preview in a sandboxed frame.
//   * SignInPolicyPanel   - the policy people accept at sign-in (backend
//                           routers/policy.py, key signin_policy_config): draft,
//                           publish a new version, and who has not accepted.
// Administrator only - the category is hidden from everyone else and every
// write endpoint checks the same level.
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { Check, Loader2, Upload, X, Download, Eye, Send } from 'lucide-react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { ACCENT_VARS, accentVars, setBrandAccent } from '../lib/brandAccent';
import { uploadToSupabase, imageFromPaste } from '../lib/docBuilderUpload';
import { PolicyText, formatPolicyVersion } from '../lib/policyText';
import { formatDateTime } from '../lib/datetime';

const LABEL = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--muted)', textTransform: 'uppercase', display: 'block', marginBottom: 6 };
const HINT = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const ROW = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' };
const IB = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const FIELD = { fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 4 };
const FULL = { width: '100%', boxSizing: 'border-box' };
const spin = <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />;

function SaveButton({ busy, onClick, children = 'Save', icon = <Check size={14} />, disabled }) {
  return (
    <button className="primary-btn" onClick={onClick} disabled={busy || disabled}
      style={{ ...IB, opacity: busy || disabled ? 0.6 : 1 }}>
      {busy ? spin : icon} {children}
    </button>
  );
}

// ── Brand Color ──────────────────────────────────────────────────────────
// Green and Blue presets, or any color (a wheel, lazy-loaded) with an
// opacity from 30% up. The floor is the backend's too: below ~30% a button is
// mostly page background and its white label stops being readable.
const ColorWheel = lazy(() => import('../components/ColorWheel'));
const ACCENTS = [['green', 'Green'], ['blue', 'Blue'], ['custom', 'Custom']];

// WCAG relative luminance of a hex color laid over white at `alpha`.
function luminance(hex, alpha = 1) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  const [r, g, b] = [0, 2, 4].map(i => {
    const c = (alpha * parseInt(h.slice(i, i + 2), 16) + (1 - alpha) * 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function BrandColorPanel({ toastOk, toastErr }) {
  const [saved, setSaved] = useState(null);
  const [cfg, setCfg] = useState(null);     // { accent, customHex, opacity }
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const def = { accent: 'green', customHex: '', opacity: 100 };
    api.getBrandingConfig()
      .then(r => { const c = { ...def, ...r }; setSaved(c); setCfg(c); })
      .catch(() => { setSaved(def); setCfg(def); });
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api.updateBrandingConfig(cfg);
      setSaved(r); setCfg(r);
      setBrandAccent(r);
      toastOk('Brand color saved. Everyone sees it the next time Nexus loads.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  if (!cfg) return <SkeletonBlocks count={1} height={80} borderRadius={10} />;
  const set = (k, val) => setCfg(c => ({ ...c, [k]: val }));
  const custom = cfg.accent === 'custom';
  const hexOk = /^#[0-9a-f]{6}$/i.test(cfg.customHex || '');
  const v = accentVars(cfg);
  // White text needs 4.5:1 (WCAG AA, normal text) on the button color.
  const lowContrast = custom && hexOk && 1.05 / (luminance(cfg.customHex, cfg.opacity / 100) + 0.05) < 4.5;
  const swatch = (id) => (id === 'custom' ? (hexOk ? cfg.customHex : 'conic-gradient(red,yellow,lime,aqua,blue,magenta,red)') : ACCENT_VARS[id].brand);
  return (
    <>
      <div role="radiogroup" aria-label="Brand color" style={{ ...ROW, marginBottom: 14 }}>
        {ACCENTS.map(([id, label]) => {
          const on = id === cfg.accent;
          return (
            <button key={id} type="button" role="radio" aria-checked={on}
              onClick={() => setCfg(c => ({ ...c, accent: id, customHex: c.customHex || (id === 'custom' ? '#1d4ed8' : '') }))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: 'var(--ink)', background: 'var(--card)', border: on ? '2px solid var(--ink)' : '1px solid var(--line)' }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, background: swatch(id) }} />
              {label}
            </button>
          );
        })}
      </div>

      {custom && (
        <div style={{ ...ROW, alignItems: 'flex-start', gap: 20, marginBottom: 14 }}>
          <Suspense fallback={<SkeletonBlocks count={1} height={180} borderRadius={90} />}>
            <ColorWheel hex={hexOk ? cfg.customHex : '#1d4ed8'} onChange={h => set('customHex', h)} />
          </Suspense>
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={FIELD}>
              Hex
              <input className="form-input" value={cfg.customHex} aria-invalid={!hexOk} style={{ width: 110 }}
                onChange={e => set('customHex', e.target.value.trim().toLowerCase())} />
            </label>
            <label style={FIELD}>
              Opacity {cfg.opacity}%
              <input type="range" min={30} max={100} value={cfg.opacity} onChange={e => set('opacity', Number(e.target.value))} />
            </label>
          </div>
        </div>
      )}
      {custom && !hexOk && <div style={{ ...HINT, color: 'hsl(var(--color-red))', marginBottom: 10 }}>Enter a hex color such as #1d4ed8.</div>}
      {lowContrast && <div role="status" style={{ ...HINT, color: 'hsl(var(--color-red))', marginBottom: 10 }}>White button text on this color is hard to read (below the 4.5:1 contrast accessibility guidelines ask for). Try a darker color or a higher opacity.</div>}

      <label style={LABEL}>Preview</label>
      <div style={{ ...ROW, padding: 12, border: '1px solid var(--line)', borderRadius: 10, marginBottom: 14 }}>
        <span style={{ padding: '7px 14px', borderRadius: 8, background: v.brand, color: '#fff', fontSize: 13, fontWeight: 600 }}>Primary Button</span>
        <span style={{ padding: '6px 12px', borderRadius: 8, background: v.tint, color: v.brand, fontSize: 13, fontWeight: 600 }}>Selected Tab</span>
        <span style={{ fontSize: 13, color: v.brand, textDecoration: 'underline', fontWeight: 600 }}>A Link</span>
      </div>
      <SaveButton busy={busy} onClick={save} disabled={JSON.stringify(cfg) === JSON.stringify(saved) || (custom && !hexOk)} />
    </>
  );
}

// ── Email Appearance ─────────────────────────────────────────────────────
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function EmailAppearancePanel({ toastOk, toastErr }) {
  const [data, setData] = useState(null);     // { theme, defaults, samples }
  const [loadErr, setLoadErr] = useState(false);
  const [form, setForm] = useState(null);
  const [sample, setSample] = useState('task');
  const [html, setHtml] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadErr(false);
    api.getEmailTheme().then(d => { setData(d); setForm(d.theme); }).catch(() => setLoadErr(true));
  }, []);
  useEffect(load, [load]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const colorOk = form && HEX.test(form.accentColor || '');

  const preview = useCallback(async (f = form, s = sample) => {
    if (!f || !HEX.test(f.accentColor || '')) return;
    setPreviewBusy(true);
    try { setHtml((await api.previewEmailTheme({ ...f, sample: s })).html || ''); }
    catch (e) { toastErr(e?.message || 'Could not render the preview.'); }
    setPreviewBusy(false);
  }, [form, sample, toastErr]);

  // First preview once the saved theme is in.
  useEffect(() => { if (data) preview(data.theme, 'task'); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadLogo(file) {
    if (!file) return;
    setUploading(true);
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', `email-theme/${id}.${ext}`);
    setUploading(false);
    if (error) toastErr(error); else set('logoUrl', url);
  }

  async function save() {
    setBusy(true);
    try {
      const r = await api.updateEmailTheme(form);
      setData(d => ({ ...d, theme: r.theme }));
      setForm(r.theme);
      toastOk('Email appearance saved. New emails use it from now on.');
    } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy(false);
  }

  if (loadErr) return <ErrorBanner message="Email appearance couldn't be loaded right now." onRetry={load} />;
  if (!form) return <SkeletonBlocks count={2} height={60} borderRadius={10} />;
  const dirty = JSON.stringify(form) !== JSON.stringify(data.theme);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, alignItems: 'start' }}>
      <div onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); uploadLogo(f); } }}>
        <label style={LABEL}>Logo</label>
        <div style={ROW}>
          {form.logoUrl
            ? <img src={form.logoUrl} alt="Email logo" style={{ height: 32, maxWidth: 160, objectFit: 'contain', background: form.accentColor, padding: 6, borderRadius: 6 }} />
            : <span style={{ fontSize: 12, color: 'var(--muted)' }}>No logo - emails show the header text.</span>}
          <label className="secondary-btn" style={{ ...IB, cursor: 'pointer' }}>
            {uploading ? spin : <Upload size={14} />} Upload Logo
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
              onChange={e => { uploadLogo(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {form.logoUrl && (
            <button className="secondary-btn" onClick={() => set('logoUrl', '')} style={IB}>
              <X size={14} /> Remove
            </button>
          )}
        </div>
        <div style={HINT}>PNG with a transparent background works best, shown white-on-color in the header. Or press Ctrl+V to paste an image.</div>

        <div style={{ ...ROW, marginTop: 16, alignItems: 'flex-end' }}>
          <label style={{ ...LABEL, marginBottom: 0, display: 'grid', gap: 6, flex: '1 1 160px' }}>
            Header Text
            <input className="form-input" maxLength={60} value={form.headerText} placeholder="GREENS GLOBAL"
              onChange={e => set('headerText', e.target.value)} />
          </label>
          <label style={{ ...LABEL, marginBottom: 0, display: 'grid', gap: 6, flex: '1 1 160px' }}>
            Header Style
            {/* 'auto' (never chosen) shows as what it renders: the logo when there is one. */}
            <select className="form-input" value={form.headerStyle === 'auto' ? (form.logoUrl ? 'logo' : 'title') : form.headerStyle}
              onChange={e => set('headerStyle', e.target.value)}>
              <option value="title">Title Only</option>
              <option value="logo">Logo Only</option>
              <option value="logo_title">Logo and Title</option>
            </select>
          </label>
        </div>
        {!form.logoUrl && form.headerStyle !== 'title' && form.headerStyle !== 'auto' && <div style={HINT}>Until a logo is added, emails show the header text only.</div>}

        <label style={{ ...LABEL, marginTop: 16 }} htmlFor="et-accent">Accent Color</label>
        <div style={ROW}>
          <input type="color" aria-label="Pick accent color" value={colorOk && form.accentColor.length === 7 ? form.accentColor : data.defaults.accentColor}
            onChange={e => set('accentColor', e.target.value)} style={{ width: 40, height: 34, padding: 2, border: '1px solid var(--line)', borderRadius: 6, background: 'none' }} />
          <input id="et-accent" className="form-input" value={form.accentColor} onChange={e => set('accentColor', e.target.value.trim())}
            style={{ width: 110 }} aria-invalid={!colorOk} />
          {form.accentColor !== data.defaults.accentColor && (
            <button className="secondary-btn" onClick={() => set('accentColor', data.defaults.accentColor)}>Reset to Default</button>
          )}
        </div>
        {!colorOk && <div style={{ ...HINT, color: 'hsl(var(--color-red))' }}>Enter a hex color such as #0f3d2e.</div>}
        {colorOk && 1.05 / (luminance(form.accentColor) + 0.05) < 4.5 && <div style={{ ...HINT, color: 'hsl(var(--color-amber, 38 92% 40%))' }}>Header text is white, so a light color may be hard to read.</div>}
        <div style={HINT}>Used for the header band and main button of every email. The default keeps each email's current green.</div>

        <label style={{ ...LABEL, marginTop: 16 }} htmlFor="et-footer">Footer Text</label>
        <textarea id="et-footer" className="form-input" rows={2} maxLength={500} value={form.footerText}
          onChange={e => set('footerText', e.target.value)} style={{ ...FULL, resize: 'vertical' }}
          placeholder="For example: Greens Global - confidential, for the intended recipient only." />
        <label style={{ ...LABEL, marginTop: 12 }} htmlFor="et-address">Company Address Line</label>
        <input id="et-address" className="form-input" maxLength={200} value={form.companyAddressLine}
          onChange={e => set('companyAddressLine', e.target.value)} style={FULL} />
        <div style={HINT}>Both are added under each email's own footer note. Leave blank to add nothing.</div>

        <div style={{ ...ROW, marginTop: 16 }}>
          <SaveButton busy={busy} onClick={save} disabled={!dirty || !colorOk} />
        </div>
      </div>

      <div>
        <label style={LABEL} htmlFor="et-sample">Preview</label>
        <div style={{ ...ROW, marginBottom: 10 }}>
          <select id="et-sample" className="form-input" value={sample} onChange={e => { setSample(e.target.value); preview(form, e.target.value); }}>
            {data.samples.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button className="secondary-btn" onClick={() => preview()} disabled={!colorOk || previewBusy}
            style={IB}>
            {previewBusy ? spin : <Eye size={14} />} Preview
          </button>
        </div>
        {/* sandbox="" - no scripts, no navigation, no same-origin access. */}
        {html
          ? <iframe title="Email preview" sandbox="" srcDoc={html} style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 10, background: '#f4f5f7' }} />
          : <SkeletonBlocks count={1} height={520} borderRadius={10} />}
        <div style={HINT}>Sample content. Unsaved changes show here after Preview.</div>
      </div>
    </div>
  );
}

// ── Sign-In Policy ───────────────────────────────────────────────────────
function csvDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SignInPolicyPanel({ toastOk, toastErr }) {
  const [cfg, setCfg] = useState(null);     // { published, draft }
  const [loadErr, setLoadErr] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState('not_accepted');

  const apply = useCallback((c) => {
    setCfg(c);
    const src = c.draft || c.published;
    setTitle(src.title); setBody(src.body);
  }, []);
  const loadReport = useCallback(() => { api.policyReport().then(setReport).catch(() => setReport({ error: true })); }, []);
  const load = useCallback(() => {
    setLoadErr(false);
    api.policyConfig().then(apply).catch(() => setLoadErr(true));
    loadReport();
  }, [apply, loadReport]);
  useEffect(load, [load]);

  async function run(kind, fn, msg) {
    setBusy(kind);
    try { apply(await fn()); toastOk(msg); } catch (e) { toastErr(e?.message || 'Could not save.'); }
    setBusy('');
  }
  const saveDraft = () => run('draft', () => api.policySaveDraft({ title, body }), 'Draft saved. Nobody is asked to accept it until you publish.');
  const discard = () => run('discard', () => api.policyDiscardDraft(), 'Draft discarded.');
  async function publish() {
    await run('publish', () => api.policyPublish({ title, body }), 'New version published. Everyone will be asked to accept it at their next sign-in.');
    setConfirming(false);
    loadReport();
  }
  async function exportCsv() {
    try { csvDownload(await api.policyReportCsv(tab), `policy-${tab.replace('_', '-')}.csv`); } catch (e) { toastErr(e?.message || 'Could not export.'); }
  }

  if (loadErr) return <ErrorBanner message="The sign-in policy couldn't be loaded right now." onRetry={load} />;
  if (!cfg) return <SkeletonBlocks count={2} height={60} borderRadius={10} />;
  const pub = cfg.published;
  const matchesPublished = title.trim() === pub.title && body.trim() === pub.body;
  const matchesDraft = cfg.draft && title.trim() === cfg.draft.title && body.trim() === cfg.draft.body;
  const empty = !title.trim() || !body.trim();
  const lists = { accepted: report?.acceptedPeople || [], not_accepted: report?.pending || [] };
  const rows = lists[tab];

  return (
    <>
      <div style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)', fontSize: 12.5, color: 'var(--muted)', marginBottom: 16 }}>
        <strong style={{ color: 'var(--ink)' }}>Current version: {formatPolicyVersion(pub.version)}</strong>
        {pub.publishedAt ? ` - published ${formatDateTime(pub.publishedAt)}${pub.publishedBy ? ` by ${pub.publishedBy}` : ''}.` : ' - the original policy.'}
        {cfg.draft && <> There is an unpublished draft{cfg.draft.savedAt ? ` saved ${formatDateTime(cfg.draft.savedAt)}` : ''}.</>}
      </div>

      <label style={LABEL} htmlFor="sp-title">Title</label>
      <input id="sp-title" className="form-input" maxLength={200} value={title} onChange={e => setTitle(e.target.value)}
        style={{ ...FULL, marginBottom: 12 }} />
      <label style={LABEL} htmlFor="sp-body">Policy Text</label>
      <textarea id="sp-body" className="form-input" rows={14} value={body} onChange={e => setBody(e.target.value)}
        style={{ ...FULL, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
      <div style={HINT}>Start a line with "## " for a heading or "- " for a bullet. Leave a blank line between paragraphs. Keep the employee monitoring disclosure: people accept it here.</div>

      <div style={{ ...ROW, marginTop: 14 }}>
        <SaveButton busy={busy === 'draft'} onClick={saveDraft} disabled={empty || matchesDraft}>Save Draft</SaveButton>
        {cfg.draft && <button className="secondary-btn" onClick={discard} disabled={!!busy}>Discard Draft</button>}
        <button className="secondary-btn" onClick={() => setShowPreview(p => !p)} style={IB}>
          <Eye size={14} /> {showPreview ? 'Hide Preview' : 'Preview'}
        </button>
        <button className="secondary-btn" onClick={() => setConfirming(true)} disabled={empty || matchesPublished || !!busy}
          style={IB}>
          <Send size={14} /> Publish New Version
        </button>
      </div>

      {confirming && (
        <div role="alertdialog" aria-label="Publish new version" style={{ marginTop: 14, padding: 14, borderRadius: 10, border: '1px solid hsl(var(--color-red))', background: 'hsla(var(--color-red),0.06)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Publish this as the new policy?</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.5, marginBottom: 12 }}>
            Everyone, including people who accepted the current version, will have to read and accept this text the next time they open Nexus. Earlier acceptances stay on record. This cannot be undone, only replaced by another version.
          </div>
          <div style={ROW}>
            <SaveButton busy={busy === 'publish'} onClick={publish} icon={<Send size={14} />}>Publish and Ask Everyone</SaveButton>
            <button className="secondary-btn" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {showPreview && (
        <div style={{ marginTop: 14, padding: '16px 20px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card)', maxHeight: 360, overflowY: 'auto' }}>
          <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>{title}</div>
          <PolicyText body={body} />
        </div>
      )}

      <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
        <div style={{ ...ROW, justifyContent: 'space-between', marginBottom: 10 }}>
          <label style={{ ...LABEL, marginBottom: 0 }}>Acceptance for {formatPolicyVersion(pub.version)}</label>
          <button className="secondary-btn" onClick={exportCsv} disabled={!rows.length} style={IB}>
            <Download size={14} /> Export CSV
          </button>
        </div>
        {!report ? <SkeletonBlocks count={1} height={50} borderRadius={10} />
          : report.error ? <ErrorBanner message="The acceptance report couldn't be loaded." onRetry={loadReport} />
          : (
            <>
              <div style={{ fontSize: 13, color: 'var(--ink)', marginBottom: 10 }}>
                <strong>{report.accepted}</strong> of <strong>{report.total}</strong> active employees have accepted.
              </div>
              <div role="tablist" aria-label="Acceptance" className="scroll-tabs" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', marginBottom: 10 }}>
                {[['not_accepted', 'Not Accepted'], ['accepted', 'Accepted']].map(([k, l]) => (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setShowAll(false); }}
                    style={{ padding: '7px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, marginBottom: -1,
                      color: tab === k ? 'var(--wk-brand)' : 'var(--muted)', borderBottom: `2px solid ${tab === k ? 'var(--wk-brand)' : 'transparent'}` }}>
                    {l} ({lists[k].length})
                  </button>
                ))}
              </div>
              {rows.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{tab === 'accepted' ? 'Nobody has accepted this version yet.' : 'Everyone has accepted this version.'}</div> : (
                <div role="tabpanel" style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
                  {(showAll ? rows : rows.slice(0, 10)).map(p => (
                    <div key={p.email} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--line)', fontSize: 12.5, marginTop: -1, color: 'var(--muted)' }}>
                      <span style={{ flex: '1 1 30%', fontWeight: 600, color: 'var(--ink)', minWidth: 0 }}>{p.name}</span>
                      <span style={{ flex: '1 1 30%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email}</span>
                      <span style={{ flex: '0 1 18%', minWidth: 0 }}>{p.company}</span>
                      {p.acceptedAt && <span style={{ flex: '0 1 20%', minWidth: 0 }}>{formatDateTime(p.acceptedAt)}</span>}
                    </div>
                  ))}
                  {rows.length > 10 && (
                    <button className="secondary-btn" onClick={() => setShowAll(v => !v)} style={{ margin: 8 }}>
                      {showAll ? 'Show Fewer' : `Show All ${rows.length}`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
      </div>
    </>
  );
}
