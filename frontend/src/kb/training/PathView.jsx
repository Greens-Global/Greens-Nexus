// One learning path (Neil, 11/07/2026): what it is for, how far the person
// is, and its stages as a checklist - every course and policy in order with
// its state and one button. Start This Path puts an open path on your list;
// Continue opens the next thing not done.
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Clock, Layers, Users, PenLine, Pencil, Lock } from 'lucide-react';
import { api } from '../../api';
import AsyncSection from '../../components/AsyncState';
import { useTrailCrumbs } from '../../components/PageTrail';
import ProgressTrack from '../../ui/ProgressTrack';
import { Chip, Banner } from '../components/Chips';
import { useToast, errText } from '../components/Toast';
import { goKb, fmtDate, minutesText, plural, pathKindMeta, trainingColor } from '../lib';
import { KindChip, LevelChip, KIND_ICONS } from './cards';
import { nextOnPath, stagesOf, courseAction } from './catalogModel';

function openItem(it) {
  goKb(it.kind === 'course' ? 'course' : 'page', it.id);
}

function ItemRow({ it, n }) {
  const isCourse = it.kind === 'course';
  const label = isCourse ? courseAction({ my_status: it.status }) : it.done ? 'Open' : 'Read and Sign';
  return (
    <div className="kb-row link kb-wrap kb-path-item" role="link" tabIndex={0} onClick={() => openItem(it)} onKeyDown={(e) => { if (e.key === 'Enter') openItem(it); }}>
      <span className={`kb-step-num${it.done ? ' done' : ''}`} aria-hidden="true">{it.done ? <Check size={15} /> : n}</span>
      <div className="kb-grow" style={{ minWidth: 0 }}>
        <div className="kb-title" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{it.title}</span>
          <Chip color={isCourse ? '#1e7b4e' : '#7c3aed'} plain>{isCourse ? 'Course' : 'Policy'}</Chip>
          {isCourse && <LevelChip level={it.level} />}
          {isCourse && it.delivery === 'in_person' && <Chip color="#0f766e" plain>In Person</Chip>}
        </div>
        <div className="kb-meta kb-clamp2">{isCourse ? [it.description, it.est_minutes ? `about ${minutesText(it.est_minutes)}` : ''].filter(Boolean).join(' · ') : (it.summary || 'Read it and sign your name.')}</div>
        {isCourse && it.status === 'In Progress' && <ProgressTrack size="sm" value={(it.pct || 0) / 100} state="live" label={`${it.title} progress`} style={{ marginTop: 6, maxWidth: 220 }} />}
        {isCourse && it.published === false && <div className="kb-meta" style={{ color: '#b45309' }}>Not published yet - it opens once the author publishes it.</div>}
      </div>
      <Chip color={trainingColor(it.status)}>{it.status}</Chip>
      <button type="button" className={`kb-btn sm${!it.done ? ' pri' : ''}`} onClick={(e) => { e.stopPropagation(); openItem(it); }}>{!isCourse && !it.done && <PenLine />}{label}</button>
    </div>
  );
}

export default function PathView({ id, me }) {
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
        const m = pathKindMeta(path.kind);
        const Icon = KIND_ICONS[m.key];
        const done = !!path.completed_at || (path.total > 0 && path.done >= path.total);
        const next = nextOnPath(path);
        const stages = stagesOf(path);
        let n = 0;
        return (
          <div className="kb-page">
            {!path.active && <Banner kind="amber" icon={Lock}>This path is switched off. People cannot see it until it is turned on under Manage.</Banner>}
            <section className="kb-hero" style={{ '--tile': m.color }}>
              <div className="kb-hero-body">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="kb-ico" style={{ background: m.color }} aria-hidden="true"><Icon size={17} /></span>
                  <KindChip kind={path.kind} />
                  {path.for_me && <Chip color="#2b6cb0">For Your Role</Chip>}
                  {done && <Chip color="#1e7b4e"><Check size={11} style={{ marginLeft: -2 }} />Completed</Chip>}
                  {path.days_overdue > 0 && <Chip color="#dc2626">{plural(path.days_overdue, 'day')} overdue</Chip>}
                </div>
                <h1 className="kb-h1" style={{ margin: '10px 0 4px' }}>{path.name}</h1>
                {path.description && <p className="kb-sub" style={{ fontSize: 15, margin: 0, maxWidth: 720 }}>{path.description}</p>}
                <div className="kb-meta kb-tile-meta" style={{ marginTop: 12 }}>
                  <span><Layers size={13} />{plural(path.total, 'item')}{path.stages?.length ? ` in ${plural(path.stages.length, 'stage')}` : ''}</span>
                  {path.est_minutes > 0 && <span><Clock size={13} />about {minutesText(path.est_minutes)}</span>}
                  {path.audience_text && <span><Users size={13} />{path.audience_text}</span>}
                  {path.due_date && <span>Due {fmtDate(path.due_date)}</span>}
                  {path.completed_at && <span>Completed {fmtDate(path.completed_at)}</span>}
                </div>
                <ProgressTrack value={path.total ? path.done / path.total : 0} state={done ? 'done' : path.days_overdue ? 'overdue' : path.done ? 'live' : 'idle'} label="Path progress" valueText={`${path.done} of ${path.total} done`} style={{ marginTop: 14, maxWidth: 520 }} note={<><b>{path.done} of {path.total}</b> done</>} />
              </div>
              <div className="kb-hero-side">
                {done && <div className="kb-meta">Every item on this path is done. Open any of them again below.</div>}
                {!done && path.enrolled && next && <button type="button" className="kb-btn pri lg" onClick={() => openItem(next)}>{path.done ? 'Continue' : 'Start'}: {next.title}<ChevronRight /></button>}
                {!done && !path.enrolled && path.open_enrollment && <button type="button" className="kb-btn pri lg" disabled={busy} onClick={start}>Start This Path</button>}
                {!done && !path.enrolled && !path.open_enrollment && <div className="kb-meta">Your manager or a training author puts people on this path. Ask them if it is yours to take.</div>}
                {!done && !path.enrolled && next && <button type="button" className="kb-btn" onClick={() => openItem(next)}>Look at the First Item</button>}
                {path.can_edit && <button type="button" className="kb-btn ghost" onClick={() => goKb('plans')}><Pencil />Edit in Manage</button>}
              </div>
            </section>

            {stages.map((s) => (
              <section key={s.index} className="kb-card">
                <div className="kb-stage-head">
                  <span className="kb-stage-tag">{s.index >= 0 ? `Stage ${s.index + 1}` : 'Also on this path'}</span>
                  <h3 className="kb-h2" style={{ fontSize: 17 }}>{s.name || (stages.length === 1 ? 'What You Take' : 'Anytime')}</h3>
                  <span className="kb-meta" style={{ marginLeft: 'auto' }}>{s.items.filter((i) => i.done).length} of {s.items.length} done</span>
                </div>
                {s.items.map((it) => { n += 1; return <ItemRow key={`${it.kind}:${it.id}`} it={it} n={n} />; })}
              </section>
            ))}
            {!path.items.length && <div className="kb-card soft kb-empty">This path has nothing in it yet.</div>}
            {me?.can_author === false && null}
          </div>
        );
      })()}
    </AsyncSection>
  );
}
