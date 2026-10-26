// The Build Mode module (lazy - BuildMode.jsx mounts it only when the person
// has Build Mode and it is on). Owns the lifecycle of a mode-on: the console
// and network buffers, the one tab-capture stream, the hotkeys; and wires the
// Overlay, Pins, Composer, Edit In Place and the Panel together. Everything
// it changed on the page is undone when it unmounts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useIsMobile } from '../lib/useIsMobile';
import { pollWhileVisible } from '../lib/pollWhileVisible';
import { formatDate, formatTime } from '../lib/datetime';
import Overlay, { ToolStrip, nextColor } from './Overlay';
import Pins from './Pins';
import Composer from './Composer';
import EditInPlace, { restoreAllEdits, restoreEdit } from './EditInPlace';
import Panel from './Panel';
import { store, useBuildStore, turnOff, saveSettings, takePendingPin, toast, loadDrafts, saveDraft, removeDraft, newId } from './store';
import { describeTarget, rectOf, anchorRect, stateOf, preloadSourceFiles } from './lib/capture';
import { startTabCapture, stopTabCapture, captureStatus, grabFrame, withUiHidden, makeShots, shiftItems } from './lib/screenshot';
import { useRole } from '../contexts/RoleContext';
import { startRecording, stopRecording, isRecording, startSpeech, speechSupported } from './lib/recorder';
import { startBuffers, stopBuffers, pauseBuffers, snapshotBuffers } from './lib/buffers';
import { setActionContext, pauseActions, snapshotActions } from './lib/actions';
import { sensitiveRects } from './lib/privacy';
import { uploadDevNoteFile } from './lib/upload';
import { installHotkeys } from './lib/hotkeys';
import { MARKUP_TOOLS, pinHeld } from './meta';
import { NAV, isNavItemVisible } from '../components/Sidebar';

const TESTING_NAV = NAV.find((item) => item.view === 'testing');

const BUILD_ID = import.meta.env.VITE_BUILD_ID || 'dev';

const newDraft = (target, view, sub) => ({
  id: newId(), kind: 'bug', priority: 'normal', comment: '', attachments: [], target, route: view, sub: sub || '', edit: null, transcript: '', markup: [], createdAt: new Date().toISOString(),
});

export default function BuildModeApp({ view, sub }) {
  const s = useBuildStore();
  const isMobile = useIsMobile();
  // The caller (acting-as identity when one is on): the Queue counts only
  // their own open pins for Send To Claude Code. Absent in tests.
  const role = useRole();
  const myEmail = (role?.myEmail || '').toLowerCase();
  // Open In Testing (v2 regression link) only for people the sidebar shows
  // Testing to - the same isNavItemVisible check, with the QA module's switch.
  const [qaEnabled, setQaEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve(api.qaEnabled?.()).then((r) => { if (live) setQaEnabled(!!r?.enabled); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const canTesting = !!role && !!TESTING_NAV && isNavItemVisible(TESTING_NAV, { isExternal: role.isExternal, can: role.can, myGrantedModules: role.myGrantedModules, qaEnabled });
  const me = useMemo(() => ({ email: myEmail, canTesting }), [myEmail, canTesting]);
  const blocked = (s.blockedRoutes || []).includes(view);
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  const [saving, setSaving] = useState('');
  const [voiceOn, setVoiceOn] = useState(false);
  const [interim, setInterim] = useState('');
  const [recorded, setRecorded] = useState(null);      // { video, sheet, sheetUrl, transcript, durationMs }
  const speechStop = useRef(null);
  const pickElRef = useRef(null);
  const handlers = useRef({});

  // ── Lifecycle of one mode-on ─────────────────────────────────────────────
  useEffect(() => {
    startBuffers();
    startTabCapture();
    if (import.meta.env.VITE_NX_SRC) preloadSourceFiles();   // the source-stamp file table (dev builds)
    store.set({ showPins: store.get().settings?.pinsOnLoad !== false });
    return () => {
      stopBuffers();
      stopTabCapture();
      restoreAllEdits();
      if (isRecording()) stopRecording();
      speechStop.current?.();
      store.set({ pick: null, editPick: null, markup: [], openPinId: '', panelOpen: false, recording: null, extraPin: null });
    };
  }, []);
  useEffect(() => { pauseBuffers(blocked); pauseActions(blocked); }, [blocked]);
  useEffect(() => { setActionContext(view, sub); }, [view, sub]);
  // A new screen: the pick and any edit belong to the old one. The draft stays in storage.
  useEffect(() => { restoreAllEdits(); store.set({ pick: null, editPick: null }); }, [view, sub]);

  // ── Pins on this screen (20 s poll while visible, bumped by `version`) ───
  const loadPins = useCallback(async () => {
    if (blocked) { store.set({ pins: [] }); return; }
    try { const list = await api.devNotesPins(view, sub || ''); store.set({ pins: Array.isArray(list) ? list : [] }); } catch { /* keep the last list */ }
  }, [view, sub, blocked]);
  // Every 30 s while visible, on focus, after every thread / verify / dismiss
  // (onPinChanged bumps `version`) and when the Panel closes - so progress,
  // Needs Input and Fixed - Verify show up without a reload.
  useEffect(() => {
    loadPins();
    const stop = pollWhileVisible(loadPins, 30000);
    const onFocus = () => loadPins();
    window.addEventListener('focus', onFocus);
    return () => { stop(); window.removeEventListener('focus', onFocus); };
  }, [loadPins, s.version]);
  useEffect(() => { if (!s.panelOpen) loadPins(); }, [s.panelOpen]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deep link: /dev-notes?pin=<id> or a bell ─────────────────────────────
  useEffect(() => {
    const id = takePendingPin();
    if (!id) return;
    api.devNotesGet(id).then((n) => {
      store.set({ extraPin: n, openPinId: n.id, showPins: true });
      if (n.route && (n.route !== view || (n.sub && n.sub !== sub))) {
        window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: n.route, sub: n.sub || null } }));
      }
    }).catch((e) => toast(e?.message || 'That pin could not be found'));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drafts ───────────────────────────────────────────────────────────────
  const updateDraft = useCallback((patch) => {
    setDraft((d) => { if (!d) return d; const next = { ...d, ...(typeof patch === 'function' ? patch(d) : patch) }; saveDraft(next); return next; });
  }, []);
  useEffect(() => { if (draft) updateDraft({ markup: s.markup }); }, [s.markup]);  // eslint-disable-line react-hooks/exhaustive-deps
  // The newest unsent draft for this screen comes back where it was.
  useEffect(() => {
    if (blocked || store.get().pick) return;
    const d = loadDrafts().find((x) => x.route === view);
    if (!d?.target) return;
    const a = anchorRect(d.target);
    if (!a) return;
    pickElRef.current = a.el || null;
    setDraft(d);
    store.set({ pick: { target: d.target, rect: { x: a.x, y: a.y, w: a.w, h: a.h }, mode: d.target.mode || 'element' }, markup: Array.isArray(d.markup) ? d.markup : [] });
    toast('Draft restored - finish it or discard it');
  }, [view]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Picking ──────────────────────────────────────────────────────────────
  const onPick = useCallback((target, rect, mode, el) => {
    if (blocked) return;
    const st = store.get();
    if (st.tool === 'edit') {
      if (!el) { toast('Pick an element to edit - a region has no text or style of its own'); return; }
      if (st.editPick?.el && st.editPick.el !== el) restoreEdit(st.editPick.el);
      store.set({ editPick: { el, target, rect }, pick: null, openPinId: '' });
      return;
    }
    pickElRef.current = el || null;
    // Computed outside the updater: StrictMode runs updaters twice, which
    // used to mint two ids and leave an orphan draft in storage.
    const prev = draftRef.current;
    const next = prev && st.pick ? { ...prev, target, route: view, sub: sub || '' } : newDraft(target, view, sub);
    saveDraft(next);
    draftRef.current = next;
    setDraft(next);
    store.set({ pick: { target, rect, mode }, openPinId: '' });
  }, [blocked, view, sub]);

  const ensureComposer = () => {
    if (store.get().pick) return;
    const el = document.querySelector('main .viewport') || document.querySelector('main') || document.body;
    onPick(describeTarget(el, 'element'), rectOf(el), 'element', el);
  };

  const cancelComposer = (discard) => {
    if (discard && draft) { removeDraft(draft.id); setDraft(null); setRecorded(null); store.set({ pick: null, markup: [] }); }
    else store.set({ pick: null });
    stopVoice();
  };

  // ── Edit In Place ────────────────────────────────────────────────────────
  const onEditSave = (edit) => {
    const ep = store.get().editPick;
    if (!ep) return;
    const d = { ...newDraft(ep.target, view, sub), kind: 'edit', edit, comment: edit.note || '' };
    pickElRef.current = ep.el;
    setDraft(d); saveDraft(d);
    store.set({ editPick: null, pick: { target: ep.target, rect: ep.rect, mode: 'element' }, tool: 'pin' });
  };
  const onEditCancel = () => store.set({ editPick: null });

  // ── Voice (hold-to-talk / M) ─────────────────────────────────────────────
  const stopVoice = () => { speechStop.current?.(); speechStop.current = null; setVoiceOn(false); setInterim(''); };
  const startVoice = () => {
    if (speechStop.current || !speechSupported()) return;
    ensureComposer();
    speechStop.current = startSpeech({
      onFinal: (t) => updateDraft((d) => ({ comment: `${(d.comment || '').replace(/\s+$/, '')}${d.comment ? ' ' : ''}${t}` })),
      onInterim: setInterim,
      onError: () => { stopVoice(); toast('The microphone is not allowed in this browser'); },
    });
    setVoiceOn(true);
  };
  const toggleVoice = () => (speechStop.current ? stopVoice() : startVoice());

  // ── Record (V) ───────────────────────────────────────────────────────────
  const toggleRecord = async () => {
    if (store.get().recording || isRecording()) { stopRecording(); return; }
    if (blocked) return;
    ensureComposer();
    try {
      const ok = await startRecording({
        onTranscript: (t) => store.set((st) => (st.recording ? { recording: { ...st.recording, transcript: t } } : null)),
        onDone: (r) => {
          store.set({ recording: null });
          if (!r?.video) return;
          setRecorded({ ...r, sheetUrl: r.sheet ? URL.createObjectURL(r.sheet) : '' });
          updateDraft({ transcript: r.transcript || '' });
          toast('Recording attached - save the pin to keep it');
        },
      });
      if (ok) store.set({ recording: { startedAt: Date.now(), transcript: '' } });
    } catch (e) { toast(e?.message || 'Recording is not available here'); }
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const save = async (sendNow) => {
    const pick = store.get().pick;
    if (!draft || !pick) return;
    if (blocked) { toast('Build Mode is off on this screen'); return; }
    if (store.get().recording) { toast('Stop the recording first'); return; }
    setSaving(sendNow ? 'send' : 'save');
    stopVoice();
    try {
      // Markup is stored in page coordinates; the shot is of the viewport at
      // this scroll, so the items move to viewport coordinates for the burn.
      const items = store.get().markup;
      const scrollAt = { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) };
      const vpItems = shiftItems(items, -scrollAt.x, -scrollAt.y);
      const vp = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1, ua: navigator.userAgent, phone: isMobile, theme: document.documentElement.getAttribute('data-theme') || 'light' };
      let screenshotUrl = '', pageShotUrl = '';
      if (captureStatus() === 'live') {
        const boxes = sensitiveRects();
        const frame = await withUiHidden(() => grabFrame());
        if (frame) {
          const shots = await makeShots({ frame, rect: pick.rect, markup: { items: vpItems }, vp, boxes });
          if (shots.page) pageShotUrl = await uploadDevNoteFile(draft.id, 'page', shots.page, 'png');
          if (shots.element) screenshotUrl = await uploadDevNoteFile(draft.id, 'screenshot', shots.element, 'png');
        }
      }
      let videoUrl = '', contactSheetUrl = '';
      if (recorded?.video) {
        videoUrl = await uploadDevNoteFile(draft.id, 'video', recorded.video, 'webm');
        if (recorded.sheet) contactSheetUrl = await uploadDevNoteFile(draft.id, 'sheet', recorded.sheet, 'png');
      }
      const { consoleLog, networkLog } = snapshotBuffers();
      const target = pick.target;
      const body = {
        id: draft.id, kind: draft.kind, priority: draft.priority, comment: draft.comment || '',
        route: view, sub: sub || '', url: window.location.href, buildId: BUILD_ID, viewport: vp,
        // base 'page': items in page px; rel = the target's page origin at capture;
        // scroll = the viewport's offset when the shot was taken.
        target, markup: { base: 'page', items, rel: { ox: target?.rect?.pageX ?? target?.rect?.x ?? 0, oy: target?.rect?.pageY ?? target?.rect?.y ?? 0 }, scroll: scrollAt },
        edit: draft.edit || {}, screenshotUrl, pageShotUrl, videoUrl, contactSheetUrl,
        transcript: recorded?.transcript || draft.transcript || '', attachments: draft.attachments || [],
        consoleLog, networkLog, actions: snapshotActions(), state: stateOf(pickElRef.current) || {},
        // Used only when this pin starts a new Build Session: the title in the
        // person's local time (the server's own fallback would be UTC).
        sessionTitle: `Build Session ${formatDate(new Date())} ${formatTime(new Date())}`,
      };
      const note = await api.devNotesCreate(body);
      // On someone else's area the server holds the pin for them (v2) - only
      // its word counts: no `held` = not held.
      const heldFor = note.held === true ? (note.ownerName || 'its owner') : '';
      let sent = !!s.settings?.sendInstantly && !heldFor;
      if (sendNow && !sent && !heldFor) {
        try { await api.devNotesDispatch({ noteIds: [note.id] }); sent = true; }
        catch (e) { toast(`Pin #${note.number} saved, but not sent: ${e?.message || 'dispatch failed'}`); }
      }
      removeDraft(draft.id);
      setDraft(null); setRecorded(null);
      store.set((st) => ({ pick: null, markup: [], version: st.version + 1 }));
      if (heldFor) toast(`Pin #${note.number} saved - it waits for ${heldFor}`);
      else if (sent || !sendNow) toast(sent ? `Pin #${note.number} sent to Claude Code` : `Pin #${note.number} saved to your Build Session`);
    } catch (e) {
      toast(e?.message || 'The pin could not be saved');
    } finally { setSaving(''); }
  };

  // ── Hotkeys (handlers through a ref so the listener installs once) ───────
  handlers.current = {
    tool: (id) => store.set({ tool: id }),
    video: toggleRecord,
    voice: toggleVoice,
    queue: () => store.set((st) => ({ panelOpen: !st.panelOpen })),
    undo: () => store.set((st) => ({ markup: st.markup.slice(0, -1) })),
    color: () => store.set((st) => ({ color: nextColor(st.color) })),
    // Esc closes our things first. It turns the mode OFF only when nothing of
    // ours is open AND the key was pressed on the page itself (body / our
    // overlay) - never from inside a Nexus dialog or a field, where Esc means
    // "close that". The chip, the menu and Ctrl/Cmd+Shift+. are the explicit
    // off paths.
    escape: (e) => {
      const st = store.get();
      if (st.panelOpen) { store.set({ panelOpen: false }); return; }
      if (st.editPick) { restoreEdit(st.editPick.el); store.set({ editPick: null }); return; }
      if (st.pick) { store.set({ pick: null }); stopVoice(); return; }
      if (st.openPinId) { store.set({ openPinId: '' }); return; }
      if (MARKUP_TOOLS.has(st.tool)) { store.set({ tool: 'pin' }); return; }
      const t = e?.target;
      const ours = !!t?.closest?.('[data-nx-devnotes]');
      if (!ours && t?.closest?.('[role="dialog"], .modal, [data-modal], .modal-overlay, .nx-overlay, input, textarea, select, [contenteditable="true"]')) return;
      if (!ours && t !== document.body && t !== document.documentElement && t !== document) return;
      turnOff();
    },
  };
  useEffect(() => installHotkeys({
    tool: (id) => handlers.current.tool(id), video: () => handlers.current.video(), voice: () => handlers.current.voice(),
    queue: () => handlers.current.queue(), undo: () => handlers.current.undo(), color: () => handlers.current.color(), escape: (e) => handlers.current.escape(e),
  }), []);

  // ── Pins list (+ a deep-linked pin the route list does not carry) ────────
  const pins = useMemo(() => {
    const extra = s.extraPin;
    if (extra && extra.route === view && !s.pins.some((p) => p.id === extra.id)) return [...s.pins, extra];
    return s.pins;
  }, [s.pins, s.extraPin, view]);
  const onPinChanged = (note) => {
    if (!note?.id) return;
    store.set((st) => ({
      pins: st.pins.some((p) => p.id === note.id) ? st.pins.map((p) => (p.id === note.id ? note : p)) : st.pins,
      extraPin: st.extraPin?.id === note.id ? note : st.extraPin,
      version: st.version + 1,
    }));
  };
  const openPin = pins.find((p) => p.id === s.openPinId) || null;
  const faint = useMemo(() => {
    if (!openPin?.markup?.items?.length) return { items: [], offset: { dx: 0, dy: 0 } };
    // Items and rel are page coordinates; the target's viewport x now minus
    // its page origin at capture is exactly the viewport shift to draw at.
    const a = anchorRect(openPin.target);
    const rel = openPin.markup.rel || { ox: openPin.target?.rect?.pageX || 0, oy: openPin.target?.rect?.pageY || 0 };
    return { items: openPin.markup.items, offset: a ? { dx: a.x - rel.ox, dy: a.y - rel.oy } : { dx: -(window.scrollX || 0), dy: -(window.scrollY || 0) } };
  }, [openPin]);

  const openFromPanel = (pin) => {
    store.set({ panelOpen: false, openPinId: pin.id, extraPin: pin, showPins: true });
    if (pin.route && (pin.route !== view || (pin.sub && pin.sub !== sub))) {
      window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: pin.route, sub: pin.sub || null } }));
    }
  };

  const panel = (
    <Panel open={s.panelOpen} tab={s.panelTab} onTab={(t) => store.set({ panelTab: t })} onClose={() => store.set({ panelOpen: false })}
      settings={s.settings} onSettings={saveSettings} onOpenPin={openFromPanel} version={s.version} onDispatched={() => store.set((st) => ({ version: st.version + 1 }))} myEmail={myEmail} />
  );
  const toastEl = s.toast && <div className="bm-toast" role="status">{s.toast.text}</div>;

  if (blocked) {
    return (
      <div data-nx-devnotes="1" className="bm-root">
        <div className="bm-blocked" role="status">
          <span>Build Mode is off on this screen - nothing here is captured.</span>
          <button type="button" className="bm-btn bm-btn-sm" onClick={() => store.set({ panelOpen: true })}>Queue</button>
          <button type="button" className="bm-btn bm-btn-sm bm-btn-ghost" onClick={turnOff}>Turn Off</button>
        </div>
        {panel}
        {toastEl}
      </div>
    );
  }

  const queueCount = pins.filter((p) => p.status === 'open' && !pinHeld(p)).length;
  return (
    <div data-nx-devnotes="1" className="bm-root">
      <Overlay tool={s.tool} color={s.color} interactive={!s.editPick && !s.panelOpen && s.tool !== 'browse'} items={s.markup}
        onAdd={(item) => store.set((st) => ({ markup: [...st.markup, item] }))} onPick={onPick}
        faintItems={faint.items} faintOffset={faint.offset} />
      <Pins pins={pins} me={me} openPinId={s.openPinId} show={s.showPins} onOpen={(id) => store.set({ openPinId: id, pick: null })} onClose={() => store.set({ openPinId: '' })} onChanged={onPinChanged} />
      {s.pick && draft && (
        <Composer pick={s.pick} draft={draft} onChange={updateDraft} onCancel={cancelComposer} onSave={save} saving={saving} settings={s.settings} view={view}
          capture={s.capture} recording={s.recording} onRecord={toggleRecord} onStopRecord={() => stopRecording()} recorded={recorded}
          voiceOn={voiceOn} interim={interim} onVoiceStart={startVoice} onVoiceStop={stopVoice}
          markupCount={s.markup.length} onClearMarkup={() => store.set({ markup: [] })} />
      )}
      {s.editPick && <EditInPlace key={s.editPick.target?.selector} editPick={s.editPick} onSave={onEditSave} onCancel={onEditCancel} />}
      <ToolStrip tool={s.tool} onTool={(id) => store.set({ tool: id })} color={s.color} onColor={() => store.set((st) => ({ color: nextColor(st.color) }))}
        canUndo={s.markup.length > 0} onUndo={() => store.set((st) => ({ markup: st.markup.slice(0, -1) }))}
        onVideo={toggleRecord} recording={!!s.recording} onVoice={toggleVoice} voiceOn={voiceOn} voiceSupported={speechSupported()}
        onQueue={() => store.set((st) => ({ panelOpen: !st.panelOpen }))} queueCount={queueCount} onOff={turnOff}
        showPins={s.showPins} onTogglePins={() => store.set((st) => ({ showPins: !st.showPins }))} isMobile={isMobile} />
      {panel}
      {toastEl}
    </div>
  );
}
