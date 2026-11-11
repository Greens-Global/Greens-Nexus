// /outside/<token> - a construction outside link (Round Three item 4, Neil,
// 11/11/2026). No login: the token in the URL is the credential, and it
// reaches ONE thing (routers/construction_outside.py):
//   an RFI     the architect or engineer reads the question and its files
//              and answers once, with up to three files;
//   a sub      the subcontractor sees their open punch items on one job and
//              marks each one Done with a photo of the finished work.
// Phone first: big targets, the camera opens straight from Take Photo, and a
// photo can also be pasted (Ctrl+V) onto an item. Nothing else of the job is
// on this page - no money, no other records.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOutsideLink, submitOutsideAnswer, submitOutsideDone } from '../api.js';
import { formatDate } from '../lib/datetime';

const FONT = "'Inter', system-ui, sans-serif";
const muted = { color: 'var(--text-muted, #5f6358)' };
const card = { border: '1px solid var(--border-color, #d9d6cc)', borderRadius: 12, padding: 16, background: 'var(--bg-primary, #fff)' };
const btn = { minHeight: 44, padding: '10px 18px', borderRadius: 10, border: '1px solid var(--wk-brand, #1f7a44)', background: 'var(--wk-brand, #1f7a44)', color: '#fff', fontWeight: 600, fontSize: 15, fontFamily: FONT, cursor: 'pointer' };
const btn2 = { ...btn, background: 'var(--bg-primary, #fff)', color: 'var(--wk-brand, #1f7a44)' };
const MAX_FILES = 3;

const pastedFiles = (e) => [...(e.clipboardData?.files || [])].filter((f) => f && f.size);

function Answer({ token, onDone }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = useRef(null);
  const add = (list) => setFiles((cur) => [...cur, ...list].slice(0, MAX_FILES));
  const send = async (e) => {
    e.preventDefault();
    if (busy || text.trim().length < 2) return;
    setBusy(true); setError('');
    const form = new FormData();
    form.append('answer', text.trim());
    files.forEach((f) => form.append('files', f));
    try { await submitOutsideAnswer(token, form); onDone(); }
    catch (err) { setError(err.message || 'Your answer did not send. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={send} onPaste={(e) => { const f = pastedFiles(e); if (f.length) { e.preventDefault(); add(f); } }}
      style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Your Answer">
      <h2 style={{ fontSize: 16, margin: 0 }}>Your Answer</h2>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Answer"
        placeholder="Write the answer here." style={{ width: '100%', fontFamily: FONT, fontSize: 15, padding: 10, borderRadius: 8, border: '1px solid var(--border-color, #d9d6cc)', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" style={btn2} onClick={() => pick.current?.click()} disabled={files.length >= MAX_FILES}>Attach a File</button>
        <span style={{ fontSize: 13, ...muted }}>A PDF or a photo, up to {MAX_FILES} - or press Ctrl+V to paste one.</span>
        <input ref={pick} type="file" multiple accept="application/pdf,image/*" hidden
          onChange={(e) => { add([...(e.target.files || [])]); e.target.value = ''; }} />
      </div>
      {files.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>{f.name || 'Pasted image'}{' '}
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name || 'file'}`}
                style={{ border: 'none', background: 'none', color: 'var(--wk-brand, #1f7a44)', cursor: 'pointer', fontFamily: FONT }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {error && <div role="alert" style={{ color: '#b42318', fontSize: 14 }}>{error}</div>}
      <div><button type="submit" style={btn} disabled={busy || text.trim().length < 2}>{busy ? 'Sending…' : 'Send Answer'}</button></div>
    </form>
  );
}

function PunchItem({ token, item, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const cam = useRef(null);
  const send = async (file) => {
    if (!file || busy) return;
    setBusy(true); setError('');
    const form = new FormData();
    form.append('photo', file);
    if (note.trim()) form.append('note', note.trim());
    try { await submitOutsideDone(token, item.id, form); onDone(); }
    catch (err) { setError(err.message || 'That did not send. Please try again.'); setBusy(false); }
  };
  return (
    <li data-outside-item={item.id} onPaste={(e) => { const f = pastedFiles(e)[0]; if (f && !item.done) { e.preventDefault(); send(f); } }}
      style={{ ...card, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {item.photoUrl && <img src={item.photoUrl} alt={`Finished: ${item.title}`} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15, overflowWrap: 'anywhere', textDecoration: item.done ? 'line-through' : 'none' }}>{item.title}</div>
          <div style={{ fontSize: 13, ...muted }}>
            {[item.location, item.dueOn ? `Due ${formatDate(item.dueOn, item.dueOn)}` : '', item.done ? `Done ${formatDate(item.doneAt?.slice(0, 10), '')}` : ''].filter(Boolean).join(' · ')}
          </div>
          {item.notes && <p style={{ fontSize: 14, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{item.notes}</p>}
        </div>
      </div>
      {!item.done && (
        <>
          <input value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Note for ${item.title}`} placeholder="A note (optional)"
            style={{ fontFamily: FONT, fontSize: 15, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color, #d9d6cc)' }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={btn} disabled={busy} onClick={() => cam.current?.click()}>{busy ? 'Sending…' : 'Take Photo and Mark Done'}</button>
            <span style={{ fontSize: 13, ...muted }}>A photo of the finished work - or press Ctrl+V to paste one.</span>
          </div>
          <input ref={cam} type="file" accept="image/*" capture="environment" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; send(f); }} />
        </>
      )}
      {error && <div role="alert" style={{ color: '#b42318', fontSize: 14 }}>{error}</div>}
    </li>
  );
}

export default function PublicOutside({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState('');
  const load = useCallback(() => {
    fetchOutsideLink(token).then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message || 'This link could not be opened.'));
  }, [token]);
  useEffect(() => {
    let on = true;
    fetchOutsideLink(token).then((d) => { if (on) setData(d); })
      .catch((e) => { if (on) setError(e.message || 'This link could not be opened.'); });
    return () => { on = false; };
  }, [token]);
  const job = data?.job?.name || 'Greens';
  useEffect(() => { document.title = data ? `${job} - ${data.kind === 'rfi' ? 'RFI' : 'Punch List'}` : 'Greens'; }, [data, job]);
  const rfi = data?.rfi;
  const open = (data?.items || []).filter((i) => !i.done).length;
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-secondary, #f3f1ec)', color: 'var(--text-primary, #1d1f1a)', fontFamily: FONT, padding: '0 16px calc(28px + env(safe-area-inset-bottom, 0px))' }}>
      <main style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <header style={{ padding: '18px 0 4px' }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>{job}</h1>
          {data?.job?.address && <div style={{ fontSize: 13, ...muted }}>{data.job.address}</div>}
          {data?.for && <div style={{ fontSize: 13, ...muted, marginTop: 2 }}>For {data.for}</div>}
        </header>
        {error ? <div role="alert" style={{ ...card, fontSize: 15 }}>{error}</div>
          : !data ? <div style={{ padding: 48, textAlign: 'center', fontSize: 14, ...muted }}>Loading…</div>
          : data.kind === 'rfi' ? (
            <>
              <section style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="The RFI">
                <h2 style={{ fontSize: 17, margin: 0 }}>{[rfi.number, rfi.subject].filter(Boolean).join(' - ') || 'Request for Information'}</h2>
                {rfi.dueOn && <div style={{ fontSize: 13, ...muted }}>Answer needed by {formatDate(rfi.dueOn, rfi.dueOn)}</div>}
                <p style={{ fontSize: 15, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{rfi.question || 'No question text - see the files.'}</p>
                {rfi.files?.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                    {rfi.files.map((f, i) => <li key={i}>{f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name}</li>)}
                  </ul>
                )}
              </section>
              {thanks && <div role="status" style={{ ...card, fontSize: 15, borderColor: 'var(--wk-brand, #1f7a44)' }}>{thanks}</div>}
              {data.canAnswer ? (
                <Answer token={token} onDone={() => { setThanks('Thank you - your answer was sent.'); load(); }} />
              ) : (
                <section style={{ ...card }} aria-label="The Answer">
                  <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>Answered{rfi.answeredOn ? ` ${formatDate(rfi.answeredOn, rfi.answeredOn)}` : ''}</h2>
                  <p style={{ fontSize: 15, margin: 0, whiteSpace: 'pre-wrap' }}>{rfi.answer}</p>
                </section>
              )}
            </>
          ) : (
            <>
              <section style={{ ...card }} aria-label="Your Punch List">
                <h2 style={{ fontSize: 17, margin: '0 0 4px' }}>{data.sub?.name ? `${data.sub.name} - Punch List` : 'Your Punch List'}</h2>
                <div style={{ fontSize: 14, ...muted }}>
                  {data.items.length === 0 ? 'Nothing on your list right now.' : open ? `${open} item${open === 1 ? '' : 's'} to finish. Mark each one Done with a photo of the finished work.` : 'Everything on your list is done. Thank you.'}
                </div>
              </section>
              {thanks && <div role="status" style={{ ...card, fontSize: 15, borderColor: 'var(--wk-brand, #1f7a44)' }}>{thanks}</div>}
              <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {data.items.map((it) => <PunchItem key={it.id} token={token} item={it} onDone={() => { setThanks(`Marked Done: ${it.title}.`); load(); }} />)}
              </ul>
            </>
          )}
        {data?.expiresAt && <p style={{ fontSize: 12, ...muted, textAlign: 'center' }}>This link is for you only and works until {formatDate(data.expiresAt.slice(0, 10), '')}.</p>}
      </main>
    </div>
  );
}
