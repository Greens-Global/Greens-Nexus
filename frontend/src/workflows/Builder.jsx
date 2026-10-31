// The workflow builder (Oct 2026): a page, not a popup. Two views of ONE
// definition (Neil, 10/30/2026): the Canvas - the Blueprint sheet in
// ./canvas, the desktop default - and the Recipe: left, When / Only If /
// Do, every card a sentence when collapsed, controls when open, so the
// workflow reads top to bottom as prose; right, a rail with Settings, Test
// and Versions (on the canvas the rail is the side panel when no block is
// selected). The view and the canvas skin are remembered per person
// (canvas/prefs.js); a phone always gets the recipe. Top: the name, the status, Save Draft, Test,
// Publish (disabled with the reason until the draft is clean and tested),
// Pause / Resume, Duplicate, Archive, Delete, Run for a manual trigger, and Save As
// Template (full level, once published). A workflow just made from a
// template opens with its blanks named above the recipe and the steps they
// sit in outlined (lib/blanks.js).
//
// Edits land in `draft`; the active version keeps running until Publish.
// The builder renders only what the catalog serves - nothing about a
// trigger, field or action is hard-coded here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, Copy, FlaskConical, History, LayoutTemplate, List, Pause, Play, Save, Settings, Upload, Waypoints } from 'lucide-react';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { useRole } from '../contexts/RoleContext';
import { dialog } from '../ui/dialog';
import HoldButton from '../ui/HoldButton';
import { useIsMobile } from '../lib/useIsMobile';
import { btn } from '../tasks/theme';
import { useCatalog } from './lib/useCatalog';
import { describeWorkflow } from './lib/text';
import { countSteps, findEntity, findEvent, normalizeDefinition, problems as findProblems, problemsSummary, triggerEntityKey } from './lib/definition';
import { WORKFLOW_STATUS, card, cardTitle, chip, hint, sentence } from './lib/text.builder-helpers';
import TriggerCard from './builder/TriggerCard';
import ConditionsCard from './builder/ConditionsCard';
import StepList from './builder/StepList';
import RailSettings from './builder/RailSettings';
import RailTest from './builder/RailTest';
import RailVersions from './builder/RailVersions';
import DescribeIt from './builder/DescribeIt';
import RunDialog from './builder/RunDialog';
import SaveTemplateDialog from './builder/SaveTemplateDialog';
import { blankLabel } from './lib/modules';
import { takeBlanks } from './lib/blanks';
import { Muted } from './ui';
import { errorProblems, errorText } from './lib/errors';
import Canvas from './canvas/Canvas';
import { builderView, canvasSkin, setBuilderView, setCanvasSkin } from './canvas/prefs';
import { replayPlan } from './canvas/replay';
import { runStatusMeta } from './lib/status';
import { formatDateTime } from '../lib/datetime';

const RAILS = [
  { key: 'settings', label: 'Settings', icon: Settings },
  { key: 'test', label: 'Test', icon: FlaskConical },
  { key: 'versions', label: 'Versions', icon: History },
];

// Companies for the scope picker: the role context's list when it has one,
// else whatever the catalog's company options say.
function companiesFromCatalog(catalog) {
  const ent = findEntity(catalog, 'company');
  const fromEntity = (ent?.fields || []).find((f) => f.key === 'id' || f.key === 'name');
  const opts = Array.isArray(fromEntity?.options) ? fromEntity.options : null;
  if (opts) return opts.map((o) => ({ id: o.value, name: o.label }));
  for (const e of catalog?.entities || []) {
    const f = (e.fields || []).find((x) => x.key === 'company' || x.key === 'company_id');
    if (Array.isArray(f?.options)) return f.options.map((o) => ({ id: o.value, name: o.label }));
  }
  return [];
}

export default function Builder({ id, go, runId = '' }) {
  const { catalog, loading: catalogLoading, error: catalogError, isNew } = useCatalog();
  const role = useRole() || {};
  const isMobile = useIsMobile();
  const isGlobalAdmin = role.myRole === 'owner';
  const canSaveTemplate = typeof role.canAccessModule === 'function' && role.canAccessModule('workflows', 'administrator', 'full');

  const [workflow, setWorkflow] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [definition, setDefinitionState] = useState(null);
  const [savedJson, setSavedJson] = useState('');
  const [meta, setMetaState] = useState({ name: '', ownerEmail: '', companyId: '', runAs: 'owner' });
  const [savedMeta, setSavedMeta] = useState('');
  const [tested, setTested] = useState(false);
  const [lastTest, setLastTest] = useState(null);
  const [rail, setRail] = useState('settings');
  const [openCard, setOpenCard] = useState('');          // 'when' | 'onlyIf' | ''
  const [view, setViewState] = useState(() => builderView());   // 'canvas' | 'recipe' (phones: always the recipe)
  const [skin, setSkinState] = useState(() => canvasSkin());    // 'paper' | 'night'
  const [selectedId, setSelectedId] = useState(null);           // the canvas block open in the side panel
  const [replay, setReplay] = useState(null);                   // a run's story playing on the canvas (canvas/replay.js)
  const replayedRun = useRef('');
  const setView = (v) => { setViewState(v); setBuilderView(v); setSelectedId(null); setReplay(null); };
  const setSkin = (sk) => { setSkinState(sk); setCanvasSkin(sk); };
  const [runOpen, setRunOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [blanks, setBlanks] = useState([]);           // template blanks, this open only
  const blanksTaken = useRef('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [serverProblems, setServerProblems] = useState([]);
  const [people, setPeople] = useState([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api.getPeopleDirectory().then((rows) => {
      if (!alive) return;
      setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    api.wfGet(id).then((w) => {
      if (!alive) return;
      // the template blanks are taken once per workflow, with its first
      // load; a reload (Publish, Pause) keeps the outline up
      if (blanksTaken.current !== id) { blanksTaken.current = id; setBlanks(takeBlanks(id)); }
      const def = normalizeDefinition(w.draft || w.definition);
      setLoadError(null);
      setWorkflow(w);
      setDefinitionState(def);
      setSavedJson(JSON.stringify(def));
      const m = { name: w.name || '', ownerEmail: w.ownerEmail || '', companyId: w.companyId || '', runAs: w.runAs || 'owner' };
      setMetaState(m);
      setSavedMeta(JSON.stringify(m));
      setTested(!!w.testedCurrent);
      setServerProblems(w.problems || []);
      setOpenCard(w.draft || (w.definition?.trigger?.kind && (w.definition.trigger.event || w.definition.trigger.entity)) ? '' : 'when');
    }).catch((e) => { if (alive) setLoadError(e); });
    return () => { alive = false; };
  }, [id, reload]);

  // Replay On Canvas (10/30/2026): a run id in the address (wf:<id>:run:<runId>,
  // from a run's drawer) plays that run's story on the sheet once the draft
  // is here - once per run id, whatever the draft does afterwards.
  useEffect(() => {
    if (!runId || !definition || !workflow || replayedRun.current === runId) return undefined;
    replayedRun.current = runId;
    let alive = true;
    api.wfRunGet(runId).then((run) => {
      if (!alive || !run) return;
      setViewState('canvas');
      setSelectedId(null);
      const when = run.startedAt || run.createdAt || run.at || '';
      setReplay({ ...replayPlan(definition, run, workflow.version), label: `Replaying the run${when ? ` from ${formatDateTime(when)}` : ''} · ${runStatusMeta(run.status).label}` });
    }).catch(() => {});
    return () => { alive = false; };
  }, [runId, definition, workflow]);

  const setDefinition = (next) => { setDefinitionState(next); setTested(false); setServerProblems([]); };
  const setMeta = (patch) => setMetaState((m) => ({ ...m, ...patch }));

  const dirty = definition !== null && (JSON.stringify(definition) !== savedJson || JSON.stringify(meta) !== savedMeta);
  const problems = useMemo(() => (definition && catalog ? findProblems(definition, catalog) : []), [definition, catalog]);
  const allProblems = problems.length ? problems : serverProblems;

  const trigger = definition?.trigger;
  const eventDef = trigger?.kind === 'event' ? findEvent(catalog, trigger.event) : null;
  const entityDef = findEntity(catalog, triggerEntityKey(trigger, catalog));
  const companies = Array.isArray(role.companies) && role.companies.length ? role.companies : companiesFromCatalog(catalog);
  const ctx = useMemo(() => ({ catalog, isNew, entityDef, eventDef, people, companies, loopNames: [], blanks }), [catalog, isNew, entityDef, eventDef, people, companies, blanks]);

  const status = workflow?.status || 'draft';
  const statusMeta = WORKFLOW_STATUS[status] || { label: status, color: '#64748b' };
  const stepCount = definition ? countSteps(definition) : 0;
  const publishReason = !definition ? 'Loading'
    : allProblems.length ? problemsSummary(allProblems)
      : !tested ? 'Test this workflow before publishing'
        : status === 'archived' ? 'An archived workflow cannot be published'
          : '';

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const saveDraft = async () => {
    if (!definition) return null;
    setBusy('save');
    try {
      // The pinned call is wfSaveDraft(id, definition); the name, scope and
      // run-as travel as a third argument the shell may wire to the same PUT.
      const res = await api.wfSaveDraft(id, definition, { name: meta.name, companyId: meta.companyId, runAs: meta.runAs });
      setSavedJson(JSON.stringify(definition));
      setSavedMeta(JSON.stringify(meta));
      if (res && typeof res === 'object' && res.id) {
        setWorkflow(res);
        if ('testedCurrent' in res) setTested(!!res.testedCurrent);
        setServerProblems(res.problems || []);
      }
      flash('Draft saved.');
      return res;
    } catch (e) {
      // A 422 carries the definition's problems: they land under Publish
      // (the server's list stands in for the local one) and in the alert.
      const list = errorProblems(e);
      if (list.length) setServerProblems(list);
      await dialog.alert(errorText(e, 'The draft could not be saved.'));
      return null;
    } finally { setBusy(''); }
  };

  const publish = async () => {
    if (publishReason) return;
    const lines = describeWorkflow(definition, catalog) || [];
    const summary = lastTest?.summary ? `\n\nLast test: ${lastTest.summary}` : '';
    const ok = await dialog.confirm(`${lines.join('\n') || 'Publish this workflow?'}${summary}`, { title: 'Publish', confirmText: 'Publish' });
    if (!ok) return;
    setBusy('publish');
    try {
      if (dirty) {
        const saved = await api.wfSaveDraft(id, definition, { name: meta.name, companyId: meta.companyId, runAs: meta.runAs });
        setSavedJson(JSON.stringify(definition));
        setSavedMeta(JSON.stringify(meta));
        if (saved && typeof saved === 'object' && saved.id) setWorkflow(saved);
      }
      await api.wfPublish(id, { note: '' });
      flash('Published.');
      setReload((n) => n + 1);
    } catch (e) {
      const list = errorProblems(e);
      if (list.length) setServerProblems(list);
      else await dialog.alert(errorText(e, 'The workflow could not be published.'));
    } finally { setBusy(''); }
  };

  const setStatus = async (next, reason = '') => {
    setBusy(next);
    try {
      await api.wfStatus(id, { status: next, reason });
      if (next === 'archived') { go('list'); return; }
      setReload((n) => n + 1);
    } catch (e) {
      await dialog.alert(errorText(e, 'The status could not be changed.'));
    } finally { setBusy(''); }
  };

  const archive = async () => {
    const ok = await dialog.confirm('Archive this workflow? It stops running and leaves the list. Runs are kept.', { title: 'Archive Workflow', confirmText: 'Archive', danger: true });
    if (ok) setStatus('archived');
  };

  // Delete is a hold on the button (Hold to confirm, Neil, Oct 30 2026): one
  // workflow, so no dialog; a refusal rewinds it with the reason under it,
  // success shows the check and then goes back to the list (onDone).
  const removeMessage = `Delete "${meta.name || 'this workflow'}" for good? It stops running and cannot be brought back. Runs still waiting are cancelled; its past runs stay in Runs.`;
  const remove = async () => {
    setBusy('delete');
    try {
      await api.wfDelete(id);
    } catch (e) {
      setBusy('');
      throw new Error(errorText(e, 'The workflow could not be deleted.'), { cause: e });
    }
  };

  const duplicate = async () => {
    setBusy('duplicate');
    try {
      const r = await api.wfDuplicate(id, { name: `${meta.name || 'Workflow'} (Copy)`, companyId: meta.companyId });
      if (r?.id) go(`wf:${r.id}`);
    } catch (e) {
      await dialog.alert(errorText(e, 'The workflow could not be duplicated.'));
    } finally { setBusy(''); }
  };

  const reown = async (owner) => {
    const who = people.find((p) => p.email === owner)?.name || owner;
    const ok = await dialog.confirm(`Make ${who} the owner? The workflow runs with their access from the next run on.`, { title: 'Change Owner', confirmText: 'Change Owner' });
    if (!ok) return;
    try {
      const res = await api.wfReown(id, { owner });
      setMetaState((m) => ({ ...m, ownerEmail: owner }));
      setSavedMeta((s) => { try { return JSON.stringify({ ...JSON.parse(s || '{}'), ownerEmail: owner }); } catch { return s; } });
      // the server answers with the workflow as it now stands (a new owner may lack a grant: needs_attention, problems)
      if (res && typeof res === 'object' && res.id) { setWorkflow(res); setServerProblems(res.problems || []); }
      flash('Owner changed.');
    } catch (e) {
      await dialog.alert(errorText(e, 'The owner could not be changed.'));
    }
  };

  const onTemplateSaved = () => { setTemplateOpen(false); flash('Saved as a template'); };

  const onTested = (run) => { setTested(true); setLastTest(run); };
  const onDraft = (def, list) => {
    setDefinition(normalizeDefinition(def));
    if (list?.length) setServerProblems(list);
    setOpenCard('');
  };

  if (!id) {
    return <div style={{ padding: 24, ...hint }}>Choose a workflow from the list. <button type="button" onClick={() => go('list')} style={btn('outline')}>Workflows</button></div>;
  }

  const loading = !workflow || !definition || catalogLoading;
  const canEdit = status !== 'archived';
  const published = (workflow?.version || 0) > 0 && status !== 'draft';
  const blankLabels = blanks.map(blankLabel).filter((l, i, a) => l && a.indexOf(l) === i);
  const canvasOn = view === 'canvas' && !isMobile;

  // The rail - Settings / Test / Versions - drawn once, in the recipe's aside
  // or in the canvas's side panel while no block is selected.
  const railTabs = (
    <div role="tablist" aria-label="Builder rail" className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
      {RAILS.map((r) => (
        <button key={r.key} type="button" role="tab" aria-selected={rail === r.key} onClick={() => setRail(r.key)} style={{
          ...chip, cursor: 'pointer', fontWeight: 600,
          ...(rail === r.key ? { background: 'var(--nx-primary)', color: '#fff', borderColor: 'var(--nx-primary)' } : null),
        }}><r.icon size={13} /> {r.label}</button>
      ))}
    </div>
  );
  const railBody = (
    <>
      {rail === 'settings' && (
        <RailSettings workflow={workflow} meta={meta} onMeta={setMeta} definition={definition} onDefinition={setDefinition} ctx={ctx}
          people={people} companies={companies} isGlobalAdmin={isGlobalAdmin} onReown={reown} />
      )}
      {rail === 'test' && (
        <RailTest workflow={workflow} definition={definition} dirty={dirty} onBeforeTest={saveDraft} onTested={onTested}
          onReplay={canvasOn ? (result) => { setSelectedId(null); setReplay({ ...replayPlan(definition, result, workflow?.version), label: 'Replaying the test run' }); } : undefined} />
      )}
      {rail === 'versions' && <RailVersions workflow={workflow} onRestored={() => setReload((n) => n + 1)} />}
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: isMobile ? '12px 16px 40px' : '16px 20px 40px', fontFamily: 'inherit' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => go('list')} aria-label="Back to Workflows" style={{ ...btn('ghost'), padding: 6 }}><ArrowLeft size={16} /></button>
        <input type="text" value={meta.name} onChange={(e) => setMeta({ name: e.target.value })} aria-label="Workflow name" placeholder="Name this workflow" disabled={!workflow || !canEdit} style={{
          flex: '1 1 220px', minWidth: 160, fontSize: 18, fontWeight: 700, border: '1px solid transparent', borderRadius: 8, padding: '4px 8px',
          background: 'transparent', color: 'var(--nx-ink)', fontFamily: 'inherit',
        }} />
        <StatusLabel label={statusMeta.label} color={statusMeta.color} />
        {workflow?.version > 0 && <span style={{ ...chip, fontSize: 11.5 }}>Version {workflow.version}</span>}
        {dirty && <span style={{ ...chip, fontSize: 11.5, color: 'hsl(var(--color-orange))', borderColor: 'hsl(var(--color-orange))' }}>Unsaved</span>}
        {notice && <span style={{ ...hint, color: 'var(--nx-primary)' }}>{notice}</span>}
        <span style={{ flex: 1 }} />
        {!isMobile && (
          <span role="group" aria-label="Builder view" style={{ display: 'inline-flex', border: '1px solid var(--nx-border)', borderRadius: 9, overflow: 'hidden' }}>
            {[['canvas', 'Canvas', Waypoints], ['recipe', 'Recipe', List]].map(([key, label, Icon]) => (
              <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 600,
                background: view === key ? 'var(--wk-brand-tint, var(--nx-hover))' : 'transparent', color: view === key ? 'var(--nx-primary)' : 'var(--nx-dim)',
              }}><Icon size={13} /> {label}</button>
            ))}
          </span>
        )}
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {trigger?.kind === 'manual' && status === 'active' && (
            <button type="button" onClick={() => setRunOpen(true)} style={btn('outline')}><Play size={14} /> Run</button>
          )}
          {status === 'active' && <button type="button" onClick={() => setStatus('paused')} disabled={!!busy} style={btn('outline')}><Pause size={14} /> Pause</button>}
          {(status === 'paused' || status === 'needs_attention') && <button type="button" onClick={() => setStatus('active')} disabled={!!busy} style={btn('outline')}><Play size={14} /> Resume</button>}
          <button type="button" onClick={duplicate} disabled={!!busy || !workflow} style={btn('outline')}><Copy size={14} /> Duplicate</button>
          {canSaveTemplate && published && (
            <button type="button" onClick={() => setTemplateOpen(true)} disabled={!!busy} style={btn('outline')}><LayoutTemplate size={14} /> Save As Template</button>
          )}
          {canEdit && <button type="button" onClick={archive} disabled={!!busy || !workflow} style={btn('outline')}><Archive size={14} /> Archive</button>}
          <HoldButton size="sm" label="Delete" doneLabel="Deleted" onConfirm={remove} onDone={() => go('list')}
            disabled={(!!busy && busy !== 'delete') || !workflow} fallbackMessage={removeMessage} />
          <button type="button" onClick={saveDraft} disabled={!!busy || !definition || !canEdit} style={btn('outline')}><Save size={14} /> {busy === 'save' ? 'Saving...' : 'Save Draft'}</button>
          <button type="button" onClick={() => { setRail('test'); setSelectedId(null); }} disabled={!definition || !canEdit} style={btn('outline')}><FlaskConical size={14} /> Test</button>
          <button type="button" onClick={publish} disabled={!!publishReason || !!busy} title={publishReason || 'Publish this draft as a new version'}
            aria-disabled={!!publishReason} style={{ ...btn('primary'), opacity: publishReason || busy ? 0.55 : 1, cursor: publishReason ? 'not-allowed' : 'pointer' }}>
            <Upload size={14} /> {busy === 'publish' ? 'Publishing...' : 'Publish'}
          </button>
        </span>
      </div>
      {publishReason && definition && (
        <div style={{ ...hint, display: 'flex', flexDirection: 'column', gap: 2 }} role="status">
          <span>Publish is off: {publishReason}.</span>
          {allProblems.length > 1 && (
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {allProblems.slice(0, 8).map((p, i) => <li key={i}>{p.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {workflow?.pausedReason && status !== 'active' && <div style={{ ...hint, color: 'hsl(var(--color-orange))' }}>Paused: {workflow.pausedReason}</div>}
      {workflow?.companyEnabled === false && <Muted style={{ fontSize: 12.5, color: 'hsl(var(--color-orange))' }}>Paused: company switch. Workflows are off for this company in Settings &gt; Workflows.</Muted>}

      <AsyncSection loading={loading && !loadError && !catalogError} error={loadError || catalogError} isEmpty={false}
        errorMessage="This workflow could not be loaded." onRetry={() => setReload((n) => n + 1)}
        skeleton={<SkeletonBlocks count={3} height={110} />}>
        {definition && catalog && canvasOn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {blankLabels.length > 0 && (
              <div role="note" aria-label="Template blanks" style={{ ...hint, padding: '8px 12px', border: '1px dashed var(--nx-primary)', borderRadius: 10, color: 'var(--nx-ink)' }}>
                <strong>Fill in:</strong> {blankLabels.join(', ')}. The outlined blocks are the ones the template left for you.
              </div>
            )}
            <Canvas definition={definition} catalog={catalog} ctx={ctx} skin={skin} onSkin={setSkin} selectedId={selectedId} onSelect={setSelectedId}
              onChange={setDefinition} canEdit={canEdit} workflowStatus={status} blanks={blanks} people={people} isNew={isNew} entityDef={entityDef} eventDef={eventDef}
              replay={replay} onReplayDone={() => setReplay(null)}
              overlay={stepCount === 0 && canEdit ? <DescribeIt onDraft={onDraft} companyId={meta.companyId || ''} /> : null}
              panel={(
                <>
                  <div className="wfc-panel-tabs" role="tablist" aria-label="Builder rail">
                    {RAILS.map((r) => (
                      <button key={r.key} type="button" role="tab" className="wfc-panel-tab" aria-selected={rail === r.key} onClick={() => setRail(r.key)}><r.icon size={13} /> {r.label}</button>
                    ))}
                  </div>
                  <div className="wfc-panel-bd" key={rail}>{railBody}</div>
                  {rail === 'settings' && !!workflow?.ownerName && <div className="wfc-panel-ft" style={{ ...hint }}>Owner: {workflow.ownerName}</div>}
                </>
              )} />
            <div className="wfc-hints" aria-hidden="true">
              <span><b>Drag</b> a block from the dock onto a connector</span>
              <span><b>Drag</b> a step to another lane; it snaps home if you let go elsewhere</span>
              <span><b>Click</b> a block to open it</span>
              <span><b>Scroll</b> to pan, hold Ctrl or Cmd to zoom</span>
            </div>
          </div>
        )}
        {definition && catalog && !canvasOn && (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 380px', gap: 16, alignItems: 'start' }}>
            {/* The recipe */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              {blankLabels.length > 0 && (
                <div role="note" aria-label="Template blanks" style={{ ...hint, padding: '8px 12px', border: '1px dashed var(--nx-primary)', borderRadius: 10, color: 'var(--nx-ink)' }}>
                  <strong>Fill in:</strong> {blankLabels.join(', ')}. The outlined steps are the ones the template left for you.
                </div>
              )}
              {stepCount === 0 && canEdit && <DescribeIt onDraft={onDraft} companyId={meta.companyId || ''} />}
              <TriggerCard definition={definition} onChange={setDefinition} catalog={catalog} isNew={isNew} people={people}
                open={openCard === 'when'} onToggle={() => setOpenCard(openCard === 'when' ? '' : 'when')} />
              <ConditionsCard definition={definition} onChange={setDefinition} entityDef={entityDef} eventDef={eventDef} catalog={catalog} people={people}
                open={openCard === 'onlyIf'} onToggle={() => setOpenCard(openCard === 'onlyIf' ? '' : 'onlyIf')} />
              <section style={card} aria-label="Do">
                <div style={cardTitle}>Do</div>
                {!entityDef && trigger?.kind !== 'schedule' && <div style={hint}>Choose a trigger first so the steps know which record they are about.</div>}
                <StepList steps={definition.steps} onChange={(steps) => setDefinition({ ...definition, steps })} ctx={ctx} depth={0}
                  emptyText="No steps yet. Add the first one." />
              </section>
            </div>

            {/* The rail */}
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 10, position: isMobile ? 'static' : 'sticky', top: 12 }}>
              {railTabs}
              <div style={{ ...card, padding: 14 }}>
                {railBody}
              </div>
              {rail === 'settings' && !!workflow?.ownerName && <div style={{ ...sentence, ...hint }}>Owner: {workflow.ownerName}</div>}
            </aside>
          </div>
        )}
      </AsyncSection>

      {runOpen && workflow && <RunDialog workflow={workflow} entityDef={entityDef} people={people} onClose={() => setRunOpen(false)} go={go} />}
      {templateOpen && workflow && <SaveTemplateDialog workflow={workflow} onClose={() => setTemplateOpen(false)} onSaved={onTemplateSaved} />}
    </div>
  );
}
