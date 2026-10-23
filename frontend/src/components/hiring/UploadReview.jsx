// Check What Nexus Found (Hiring Setup screen 3, Oct 23). After a Word file is
// read for an offer letter, a hiring packet document or a job description:
// on the left every variable Nexus took or made, grouped by who fills it,
// plus the few things it could not work out (who signs a company line, where
// the role's duties go); on the right the document itself with each variable
// colored the same way. Clicking a colored span selects its row. The blanks
// are the WordTemplateWizard's own (lib/wordBlanks.js + lib/wordSamples.js);
// this screen only changes them, applyBlanks writes the template.
import { useMemo, useState } from 'react';
import { NEXUS_FIELDS, applyBlanks, tokensFor } from '../../lib/wordBlanks';
import { WHO, WHO_COLOR, becameOf, setWho, whoOf } from '../../lib/wordSamples';
import { formatDate } from '../../lib/datetime';

const box = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' };
const cap = { fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted)' };
const HEAD_COLOR = { nexus: '#15803d', you: '#1d4ed8', hire: '#7e22ce', same: 'var(--muted)', paper: 'var(--muted)' };
const WHO_NAME = Object.fromEntries(WHO);
const pill = (on) => ({ minHeight: 34, padding: '0 12px', borderRadius: 999, font: '700 12.5px Inter,sans-serif', cursor: 'pointer',
  border: `1px solid ${on ? 'var(--ink)' : 'var(--line)'}`, background: on ? 'var(--ink)' : 'var(--card)', color: on ? 'var(--card)' : 'var(--ink)' });

/** Signature line choices: a block key / flow role each (contract 3.7). */
const signerChoices = (ctx = {}) => [
  ['employee', 'The New Hire'], ['hr', 'HR'],
  ['signatory', `${ctx.signatoryName || 'Authorized Signatory'} (Signs For The Company)`], ['manager', 'Their Manager'],
];
const signerWords = (who, ctx) => ({ employee: 'the new hire', hr: 'HR', manager: 'their manager', company: 'the company',
  signatory: `${ctx.signatoryName || 'the authorized signatory'} for the company` }[who] || who);

const nexusLabel = Object.fromEntries(NEXUS_FIELDS);

export default function UploadReview({ doc, blanks, setBlanks, purpose, context = {}, jdChoice, setJdChoice }) {
  const [selected, setSelected] = useState('');
  const [asHire, setAsHire] = useState(false);
  const pick = (id) => { setSelected(id); document.getElementById(`ur-${id}`)?.scrollIntoView?.({ block: 'nearest' }); };
  const sigs = blanks.filter(b => b.kind === 'signature');
  const section = purpose === 'hire' ? blanks.find(b => b.kind === 'section') : null;
  const fields = blanks.filter(b => b.kind !== 'signature' && b.kind !== 'section');
  const set = (id, fn) => setBlanks(list => list.map(b => (b.id === id ? fn(b) : b)));
  // Turn Back Into Text: a recognized sample stays as it was; a found ____ is left blank.
  const unmake = (b) => (b.kind === 'text' ? setBlanks(list => list.filter(x => x.id !== b.id)) : set(b.id, x => setWho(x, 'paper')));

  const applied = useMemo(() => {
    const withAnswer = blanks.map(b => (b.kind === 'section' ? { ...b, answer: jdChoice } : b));
    const tokens = tokensFor(withAnswer);
    const byToken = {};
    withAnswer.forEach((b, i) => { if (tokens[i] && !byToken[tokens[i]]) byToken[tokens[i]] = b; });
    if (section && jdChoice === 'inside') byToken.role_description = byToken.role_description || section;
    return { doc: applyBlanks(doc, withAnswer).doc, byToken };
  }, [doc, blanks, jdChoice, section]);

  const sample = {
    full_name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith', start_date: '11/02/2026', salary: '$85,000 per year',
    job_title: context.roleNames?.[0] || 'Accountant', company_legal: context.companyLegal, company: context.companyName,
    company_address: context.companyAddress, today: formatDate(new Date()), offer_expires: '10/30/2026',
    signatory: [context.signatoryName, context.signatoryTitle].filter(Boolean).join(', '),
    role_description: "[The role's duties, filled in for each hire]",
  };
  const company = sigs.filter(s => s.fill === 'sign' && s.who !== 'employee');
  const signers = [...new Set(sigs.filter(s => s.fill === 'sign').map(s => s.who))].sort((a, b) => (b === 'employee') - (a === 'employee'));
  const asks = purpose === 'offer' ? [] : company.concat(sigs.filter(s => s.fill !== 'sign'));
  const counts = `Found ${fields.length} blank${fields.length === 1 ? '' : 's'}, ${sigs.length} signature line${sigs.length === 1 ? '' : 's'}${section ? ` and a ${section.label} section` : ''}.`;

  // ── the preview ──
  const chip = (token, key) => {
    const b = applied.byToken[token];
    const who = b ? (b.kind === 'section' ? 'nexus' : whoOf(b)) : 'nexus';
    const label = b ? (b.kind === 'section' ? "The Role's Duties" : becameOf(b)) : (nexusLabel[token] || token);
    const text = asHire ? (sample[token] || `[${label}]`) : `[${label}]`;
    const on = b && b.id === selected;
    return (
      <span key={key} role="button" tabIndex={0} title={`${label} - ${WHO_NAME[who]}`} data-token={token}
        onClick={() => b && pick(b.id)} onKeyDown={e => e.key === 'Enter' && b && pick(b.id)}
        style={{ background: WHO_COLOR[who], color: '#0f172a', padding: '0 3px', borderRadius: 3, cursor: 'pointer',
          border: who === 'paper' ? '1px dashed #94a3b8' : 'none', outline: on ? '2px solid #0f172a' : 'none', fontStyle: token === 'role_description' ? 'italic' : 'normal' }}>
        {text}
      </span>
    );
  };
  const inline = (n, i) => {
    if (n.type === 'mergeField') return chip(n.attrs?.token, i);
    if (n.type === 'hardBreak') return <br key={i} />;
    if (n.type !== 'text') return null;
    const m = new Set((n.marks || []).map(x => x.type));
    return <span key={i} style={{ fontWeight: m.has('bold') ? 700 : undefined, fontStyle: m.has('italic') ? 'italic' : undefined, textDecoration: m.has('underline') ? 'underline' : undefined }}>{n.text}</span>;
  };
  const block = (n, i) => {
    const kids = (n.content || []);
    switch (n.type) {
      case 'paragraph': return <p key={i} style={{ margin: '0 0 8px', minHeight: '1em', textAlign: n.attrs?.textAlign || undefined }}>{kids.map(inline)}</p>;
      case 'heading': return <div key={i} style={{ fontWeight: 700, margin: '12px 0 6px', fontSize: n.attrs?.level === 1 ? 16 : 14.5 }}>{kids.map(inline)}</div>;
      case 'bulletList': return <ul key={i} style={{ margin: '0 0 8px', paddingLeft: 22 }}>{kids.map(block)}</ul>;
      case 'orderedList': return <ol key={i} style={{ margin: '0 0 8px', paddingLeft: 22 }}>{kids.map(block)}</ol>;
      case 'listItem': return <li key={i}>{kids.map(block)}</li>;
      case 'table': return <table key={i} style={{ borderCollapse: 'collapse', width: '100%', margin: '0 0 10px', fontSize: 13 }}><tbody>{kids.map(block)}</tbody></table>;
      case 'tableRow': return <tr key={i}>{kids.map(block)}</tr>;
      case 'tableCell': case 'tableHeader': return <td key={i} style={{ border: '1px solid #cbd5e1', padding: '4px 6px', verticalAlign: 'top' }}>{kids.map(block)}</td>;
      case 'signatureBlock': return (
        <div key={i} style={{ borderTop: '1px solid #94a3b8', paddingTop: 4, margin: '18px 0 10px', fontSize: 12.5, maxWidth: 280 }}>
          {n.attrs?.label ? `${n.attrs.label} - ` : ''}Signed by {signerWords(n.attrs?.role || 'employee', context)}
        </div>
      );
      case 'pageBreak': return <hr key={i} style={{ border: 'none', borderTop: '1px dashed #cbd5e1', margin: '14px 0' }} />;
      default: return kids.length ? <div key={i}>{kids.map(block)}</div> : null;
    }
  };

  // ── one variable row ──
  const row = (b) => {
    const who = whoOf(b);
    const on = b.id === selected;
    const nexusOpts = NEXUS_FIELDS.some(([k]) => k === b.token) || b.fill !== 'nexus' ? NEXUS_FIELDS : [...NEXUS_FIELDS, [b.token, b.label]];
    return (
      <div key={b.id} id={`ur-${b.id}`} onClick={() => setSelected(b.id)}
        style={{ padding: '8px 10px', borderRadius: 10, border: `1px solid ${on ? 'var(--ink)' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
          <span style={{ background: WHO_COLOR[who], color: '#0f172a', padding: '0 4px', borderRadius: 3, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.found || b.context}>
            {b.found || b.label}
          </span>
          <span style={{ color: 'var(--muted)' }}>became</span>
          <b>{becameOf(b)}</b>
          {b.places?.length > 1 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{b.places.length} places</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <select className="form-input" style={{ flex: '1 1 180px', fontSize: 12.5 }} value={who} aria-label={`Who fills ${becameOf(b)}`}
            onChange={e => set(b.id, x => setWho(x, e.target.value))}>
            {WHO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {who === 'nexus' && (
            <select className="form-input" style={{ flex: '1 1 180px', fontSize: 12.5 }} value={b.token} aria-label={`Nexus field for ${becameOf(b)}`}
              onChange={e => set(b.id, x => setWho(x, 'nexus', e.target.value))}>
              {nexusOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          {['ask', 'hr', 'same'].includes(b.fill) && (
            <input className="form-input" style={{ flex: '1 1 160px', fontSize: 12.5 }} value={b.label} aria-label={`Name for ${b.found || b.label}`}
              onChange={e => set(b.id, x => ({ ...x, label: e.target.value }))} />
          )}
          {b.fill === 'same' && (
            <input className="form-input" style={{ flex: '1 1 160px', fontSize: 12.5 }} value={b.value || ''} placeholder="Type it once"
              aria-label={`Value for ${b.label}`} onChange={e => set(b.id, x => ({ ...x, value: e.target.value }))} />
          )}
          {(b.kind === 'text' || b.fill !== 'leave') && b.kind !== 'existing' && (
            <button type="button" className="secondary-btn" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); unmake(b); }}>Turn Back Into Text</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="nx-fill" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 12, padding: '10px 14px', fontSize: 13.5, fontWeight: 600, color: '#065f46' }}>{counts}</div>

          <div style={box}>
            <div style={cap}>Signs</div>
            <div style={{ fontSize: 13.5, marginTop: 4 }}>
              {purpose === 'offer'
                ? <>The new hire.{company.length > 0 && ' Only the new hire signs an offer letter, so Nexus leaves the company line off.'}</>
                : !signers.length ? 'No signature lines were found in this file.'
                  : `${signers.map(w => signerWords(w, context)).join(', then ').replace(/^./, c => c.toUpperCase())}.`}
            </div>
          </div>

          {(section || asks.length > 0) && (
            <div style={{ ...box, border: '2px solid var(--ink)', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>Nexus Needs Your Help With</div>
              {section && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>"{section.label}" looks like a job description. Where should each role's duties go?</div>
                  <div role="radiogroup" aria-label="Where the duties go" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[['inside', `Print Them In ${section.label} (Recommended)`], ['page', 'On Their Own Page After This'], ['none', 'Not In This Packet']].map(([k, l]) => (
                      <button key={k} type="button" role="radio" aria-checked={jdChoice === k} style={pill(jdChoice === k)} onClick={() => setJdChoice(k)}>{l}</button>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {{ inside: `Each hire gets their role's duties printed right here, in ${section.label}. One packet works for every role.`,
                      page: "The role's job description goes on its own page right after this document. This section keeps its text.",
                      none: 'No job description in this packet. This section keeps the text you wrote.' }[jdChoice] || ''}
                  </div>
                </div>
              )}
              {asks.map(s => (
                <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Who signs "{s.context}"?</div>
                  <div role="radiogroup" aria-label={`Who signs ${s.context}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {[...signerChoices(context), ['leave', 'Not A Signature']].map(([k, l]) => {
                      const on = k === 'leave' ? s.fill !== 'sign' : s.fill === 'sign' && s.who === k;
                      return <button key={k} type="button" role="radio" aria-checked={on} style={pill(on)}
                        onClick={() => set(s.id, x => (k === 'leave' ? { ...x, fill: 'leave' } : { ...x, fill: 'sign', who: k }))}>{l}</button>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {WHO.map(([k, l]) => {
            const list = fields.filter(b => whoOf(b) === k);
            if (!list.length) return null;
            return (
              <div key={k} style={{ ...box, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: HEAD_COLOR[k] }}>{l} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>({list.length})</span></div>
                {list.map(row)}
              </div>
            );
          })}
        </div>

        <div style={{ flex: '1 1 420px', minWidth: 0, background: '#ffffff', color: '#1e293b', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 26px',
          fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 14, lineHeight: 1.65, maxHeight: '70vh', overflowY: 'auto' }}>
          <div style={{ fontFamily: 'Inter,sans-serif', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ ...cap, color: '#64748b', flex: 1 }}>Preview</span>
            <div role="radiogroup" aria-label="Preview as" style={{ display: 'flex', gap: 4 }}>
              {[[false, 'Show Variables'], [true, 'As A Hire']].map(([v, l]) => (
                <button key={l} type="button" role="radio" aria-checked={asHire === v} onClick={() => setAsHire(v)}
                  style={{ ...pill(asHire === v), minHeight: 28, fontSize: 11.5, border: '1px solid #cbd5e1', background: asHire === v ? '#0f172a' : '#fff', color: asHire === v ? '#fff' : '#0f172a' }}>{l}</button>
              ))}
            </div>
          </div>
          {(applied.doc.content || []).map(block)}
          <div style={{ fontFamily: 'Inter,sans-serif', display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 18, fontSize: 11.5, color: '#475569' }}>
            {[['nexus', 'Nexus fills it'], ['you', 'You answer'], ['hire', 'New hire fills it']].map(([k, l]) => (
              <span key={k}><span style={{ display: 'inline-block', width: 10, height: 10, background: WHO_COLOR[k], borderRadius: 2, marginRight: 4 }} />{l}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
