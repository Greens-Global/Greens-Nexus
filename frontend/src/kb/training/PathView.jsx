// One learning path (Neil, 11/07/2026): what it is for and how far the
// person is - the ladder with every stage named - then the stages as a
// numbered checklist of courses and policies, each with its state and one
// button. Start this path puts an open path on your list; Continue opens
// the next thing not done.
import { useEffect, useState } from 'react';
import { Check, ChevronRight, PenLine, Pencil, Lock } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { useTrailCrumbs } from '../../components/PageTrail';
import ProgressTrack from '../../ui/ProgressTrack';
import { Banner } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, minutesText, plural, trainingColor } from '../lib';
import { LevelChip, PathLadder, pathWho } from './cards';
import { nextOnPath, stagesOf, courseAction } from './catalogModel';

function openItem(it) {
  goKb(it.kind === 'course' ? 'course' : 'page', it.id);
}

function ItemRow({ it, n }) {
  const isCourse = it.kind === 'course';
  const label = isCourse ? courseAction({ my_status: it.status }) : it.done ? 'Open' : 'Read and Sign';
  return (
    <div className="kb-item" role="link" tabIndex={0} onClick={() => openItem(it)} onKeyDown={(e) => { if (e.key === 'Enter') openItem(it); }}>
      <span className={`kb-item-n${it.done ? ' done' : ''}`} aria-hidden="true">{it.done ? <Check size={14} /> : n}</span>
      <div className="kb-item-text">
        <div className="kb-prow-title">{it.title}<span className="kb-item-kind">{isCourse ? 'Course' : 'Policy to Sign'}</span></div>
        <div className="kb-meta kb-crow-facts">
          {isCourse && <LevelChip level={it.level} />}
          {isCourse && it.est_minutes > 0 && <span>about {minutesText(it.est_minutes)}</span>}
          {isCourse && it.delivery === 'in_person' && <span>In Person</span>}
          {isCourse && it.published === false && <span style={{ color: '#b45309' }}>Not Published Yet</span>}
        </div>
        {(isCourse ? it.description : it.summary) && <div className="kb-prow-desc kb-clamp2">{isCourse ? it.description : it.summary}</div>}
        {isCourse && it.status === 'In Progress' && <ProgressTrack size="sm" value={(it.pct || 0) / 100} state="live" label={`${it.title} progress`} valueText={`${it.pct || 0}% done`} style={{ marginTop: 8, maxWidth: 200 }} />}
      </div>
      <div className="kb-item-side">
        <span className="kb-state" style={{ color: trainingColor(it.status) }}>{it.status}</span>
        <button type="button" className={`kb-btn sm${!it.done ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); openItem(it); }}>{!isCourse && !it.done && <PenLine />}{label}</button>
      </div>
    </div>
  );
}

export default function PathView({ id }) {
  const toast = useToast();
  const [path, setPath] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useTrailCrumbs([{ label: 'Training', onClick: () => goKb('training') }, { label: 'Catalog', onClick: () => goKb('catalog') }]);
  const load = () => { setErr(''); return api.kbPlan(id).then(setPath).catch((e) => setErr(errText(e))); };
  useEffect(() => { setPath(null); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setBusy(true);
    try { setPath(await api.kbEnrollPlan(id)); toast('Added to your training. Start with the first item.'); } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };

  return (
    <AsyncSection loading={!path && !err} error={err ? new Error(err) : null} errorMessage={err} onRetry={load}>
      {path && (() => {
        const done = !!path.completed_at || (path.total > 0 && path.done >= path.total);
        const next = nextOnPath(path);
        const stages = stagesOf(path);
        const facts = [plural(path.total, 'item'), path.est_minutes > 0 ? `about ${minutesText(path.est_minutes)}` : '', path.due_date && !done ? `due ${fmtDate(path.due_date)}` : '', path.completed_at ? `completed ${fmtDate(path.completed_at)}` : ''].filter(Boolean).join(' · ');
        let n = 0;
        return (
          <div className="kb-page kb-read">
            {!path.active && <Banner kind="amber" icon={Lock}>This path is switched off. People cannot see it until it is turned on under Manage.</Banner>}
            <header className="kb-lead">
              <div className="kb-lead-text">
                <div className="kb-kicker">{pathWho(path)}{path.for_me ? ' · For Your Role' : ''}</div>
                <h1 className="kb-h1 kb-lead-title">{path.name}</h1>
                {path.description && <p className="kb-lead-sub">{path.description}</p>}
                <div className="kb-meta">{facts}</div>
              </div>
              <div className="kb-lead-side">
                {done && <span className="kb-mark done" style={{ alignSelf: 'flex-start' }}><Check size={12} />Completed</span>}
                {!done && path.enrolled && next && <button type="button" className="kb-btn pri lg" onClick={() => openItem(next)}>{path.done ? 'Continue' : 'Start'}: {next.title}<ChevronRight /></button>}
                {!done && !path.enrolled && path.open_enrollment && <button type="button" className="kb-btn pri lg" disabled={busy} onClick={start}>Start This Path</button>}
                {!done && !path.enrolled && !path.open_enrollment && <div className="kb-meta">Your manager or a training author puts people on this path. Ask them if it is yours to take.</div>}
                {!done && !path.enrolled && next && <button type="button" className="kb-btn" onClick={() => openItem(next)}>Look at the First Item</button>}
                {path.can_edit && <button type="button" className="kb-btn ghost" onClick={() => goKb('plans')}><Pencil />Edit in Manage</button>}
              </div>
            </header>
            <div className="kb-lead-ladder">
              <PathLadder p={path} names size="lg" />
              <div className="kb-meta" style={{ marginTop: 6 }}><b style={{ color: 'var(--kb-ink)' }}>{path.done} of {path.total}</b> done{!!path.days_overdue && !done && <span style={{ color: '#dc2626' }}> · {plural(path.days_overdue, 'day')} overdue</span>}</div>
            </div>

            {stages.map((s) => (
              <section key={s.index} className="kb-stage">
                <div className="kb-stage-head">
                  <span className="kb-stage-n">{s.index >= 0 ? s.index + 1 : ''}</span>
                  <h2 className="kb-stage-title">{s.name || (stages.length === 1 ? 'What You Take' : 'Anytime')}</h2>
                  <span className="kb-meta kb-stage-count">{s.items.filter((i) => i.done).length} of {s.items.length} done</span>
                </div>
                <div className="kb-stage-items">
                  {s.items.map((it) => { n += 1; return <ItemRow key={`${it.kind}:${it.id}`} it={it} n={n} />; })}
                </div>
              </section>
            ))}
            {!path.items.length && <div className="kb-empty-state"><div className="kb-empty-title">This Path Has Nothing in It Yet</div></div>}
          </div>
        );
      })()}
    </AsyncSection>
  );
}
