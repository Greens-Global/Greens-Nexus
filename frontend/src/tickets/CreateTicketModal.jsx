// CreateTicketModal - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Paperclip, Image as ImageIcon, ScanText, Camera, ImagePlus, Check, Copy, Send, CircleCheck, Circle,
  Monitor, Building2, Warehouse, ShieldCheck, Receipt, Users, HardHat, LifeBuoy, Briefcase, Video,
} from 'lucide-react';
import TicketToken from '../components/icons/TicketToken';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { useRole } from '../contexts/RoleContext';
import { filesFromPaste, externalizeInlineImages } from '../tasks/lib';
import RichDescription, { isEmptyDoc } from '../tasks/RichDescription';
import {
  stashDraft, appendDraftFile, takeDraft, setDraftUiMounted, finishRecording,
} from './recordingDraft';
import { NX, FONT, btn, input as inputStyle, PRIORITY_ORDER, PRIORITY_META } from '../tasks/theme';
import { PrioritySignal } from '../components/StatusLabel';
import { setPendingOpen } from '../lib/pendingOpen';
import { Modal, usePeople, useIsMobile } from '../tasks/components';
import { dialog as appDialog } from '../ui/dialog';
import { BottomSheet } from '../tasks/MobileTaskBar';
import {
  requiredHint, TICKET_TYPE_META, TICKET_TYPE_ORDER, NO_RECORDING_TYPES,
  slaDueFromPriority, isBlankFieldValue,
  label, field,
  topicQuestionDefs,
  helpGroupFor,
  intakeFieldsFor, intakeDefaults, defaultIntakeType, richToPlain,
  FIRST_RESPONSE_HOURS, fmtMoment, ticketNoShort, suggestPriority,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_KEY, topicOptions } from './ticketMeta';
import { useTicketConfig, COMPANY_FIELD, typeRequiresApproval } from './ticketConfig';
import {
  TypeFieldInput, TicketSelect, TicketPeopleMultiSelect,
} from './TicketAtoms';
import TicketDeflection from '../support/TicketDeflection';
// Help Center (Oct 2026): what is already known to be broken, and the
// "searched, then filed a ticket" record (support/helpLog.js).
import { KnownIssuesNotice } from '../support/KnownIssues';
import { logHelpSearch } from '../support/helpLog';
import { seedHtml } from '../support/ticketSeed';
import AnchoredMenu from '../components/AnchoredMenu';
import { TicketPropertyIntake } from './TicketPropertyFields';
import { useTicketPropertyRules, propertyRequiredFor, usePropertyUnits } from './ticketPropertyLink';
import { uploadTicketEvidence } from './evidenceUpload';
import { checkMedia, mediaKind, withType } from '../lib/voice';
import { groupTakesProperty, isBuildingGroup } from './propertyMeta';
import CreateModeTabs from './CreateModeTabs';
import { TicketEquipmentIntake } from './TicketEquipment';
import { equipmentError } from './ticketEquipmentError';
import { SuggestedTopicChips } from './TicketAi';
import {
  areaForTopic, offeredAtIntake,
  priorityOptions, typeIntakeOptions,
  uploadTicketFile, attachFailed, useCollaboratorExtras,
} from './ticketViewShared';
import { HelpTopicField } from './HelpTopicField';
import { RecordUploadButtons, PendingFileChip } from './TicketEvidence';
import { STOP_VOICE_FIRST } from '../lib/voice';
import { MapSpotIntake, dataUrlToFile } from './TicketMapSpot';

// ── Create ───────────────────────────────────────────────────────────────────
// `fromTask` (Convert to Ticket, Neil 10/05): { id, title, description,
// priority, ownerId, fileCount, collaboratorIds } - the form opens pre-filled
// from the task (its assignees and collaborators as the ticket's collaborators),
// names every required field the task could not supply, and on create the
// server links the ticket to the task, copies its files and (when asked)
// closes the task. `onCreated(ticket)` runs after a successful create.
// `forProperty` (Property Tickets, Neil 10/05): { id, name } - opened from a
// property in Asset Management; the ticket is linked to it and the building
// department is preselected, so a title and a category are all that is left.
// `onBatch` (Neil, Oct 13 2026): given by a caller that can also open Batch
// Create - the title becomes the Create a Ticket | Batch Create switch. What
// was typed is stashed (recordingDraft) so switching back brings it back.
// `mapSpot` (Mark an Issue on the Map, Charmi Oct 20 2026): { spot, snapshot }
// from the site map - the spot goes with the ticket as map_spot, the map's
// picture is attached once the ticket exists, and a photo is asked for.
// `initial` (Help Center, Oct 2026): { subject, description, type } handed
// over from help - Ask Nexus's File a Ticket, "I Need To..." - plain text.
export function CreateTicketModal({ onClose, fromTask = null, onCreated = null, forProperty = null, onBatch = null, mapSpot = null, initial = null }) {
  // Reachable standalone from Support.jsx without TicketsView ever mounting
  // (its own ticket composer) - needs its own call so intake-field/SLA
  // overrides are loaded before the type-dependent form renders there too.
  useTicketConfig();
  const { createTicket, projects = [], myEmail } = useTasks();
  const { myEmail: roleEmail, can, myGrantedModules } = useRole();
  // Who "me" is - the Requester field's default. The store's copy first, the
  // signed-in identity as the fallback for a form mounted outside the Tasks
  // view (Support), before the store has loaded.
  const me = (myEmail || roleEmail || '').toLowerCase();
  // The curated Nexus People list (/myhr/directory) - never M365/GAL.
  const people = usePeople();
  const collabExtras = useCollaboratorExtras();
  const isMobile = useIsMobile();
  const [companies, setCompanies] = useState([]);
  const [allDepts, setAllDepts] = useState([]);
  useEffect(() => {
    api.getTicketCompanies().then(setCompanies).catch(() => setCompanies([]));
  }, []);
  // Departments come scoped to the requester's own company UNLESS an admin
  // has turned the company field on (Sep 19) - then the requester may be
  // filing for a different company than their own, so the unfiltered list
  // (every company's departments, each carrying its own companyId) is
  // fetched instead and narrowed client-side to whichever company is
  // currently picked, same as deptOptions already does below.
  useEffect(() => {
    (COMPANY_FIELD.enabled ? api.getTicketDepartments() : api.getMyTicketDepartments())
      .then(setAllDepts).catch(() => setAllDepts([]));
  }, [COMPANY_FIELD.enabled]);
  // A draft stashed during a screen recording (recordingDraft.js) seeds the
  // form when it reopens - possibly after the user navigated to another view
  // and back. Consumed exactly once per mount via the ref guard.
  const seedRef = useRef(undefined);
  // A conversion starts from the task, never from a recording draft (which
  // stays stashed for the form it belongs to).
  if (seedRef.current === undefined) seedRef.current = fromTask ? null : (takeDraft() || null);
  const seed = seedRef.current;
  // Opens on Incident (Neil, Oct 1 2026: "nine times out of ten it is simply
  // an incident") - preselected, still changeable. See defaultIntakeType.
  const initialType = useRef(!fromTask && initial?.type && TICKET_TYPE_ORDER.includes(initial.type)
    ? initial.type : defaultIntakeType()).current;
  const blankForm = () => ({
    subject: fromTask?.title || initial?.subject || '', description: fromTask?.description || seedHtml(initial?.description),
    type: initialType,
    priority: PRIORITY_ORDER.includes(fromTask?.priority) ? fromTask.priority : 'medium', status: 'open',
    // Who the ticket is FOR (Neil, Oct 1): you, unless you pick a colleague.
    // A converted task is for whoever owns it - they asked for the work.
    requesterId: (fromTask?.ownerId || myEmail || '').toLowerCase() || null, companyId: '', hrDepartmentId: '', application: '',
    // Collaborators (Oct 14 2026): others pulled onto it from the start - a
    // converted task's assignees and collaborators, less whoever it is for.
    watcherIds: [...new Set((fromTask?.collaboratorIds || []).map((e) => (e || '').toLowerCase()).filter(Boolean))]
      .filter((e) => e !== (fromTask?.ownerId || myEmail || '').toLowerCase()),
    propertyAssetId: forProperty?.id || '',
    // Report an Issue on the Ops Site Map's unit card names the unit too (Oct 20 2026)
    propertyUnit: forProperty?.unit || '',
  });
  const [form, setForm] = useState(() => seed?.form || blankForm());
  // Close the task once the ticket exists, so the work is not tracked twice.
  const [closeSource, setCloseSource] = useState(true);
  // How many guide answers the Suggested Articles block was showing.
  const deflectCount = useRef(0);
  // Per-type field values (keyed by field key), pre-answered where the
  // question has a sensible default - Who is affected? = One User, When did
  // it start? = now.
  const [tf, setTf] = useState(() => seed?.tf || intakeDefaults(initialType));
  // Only nag after a failed submit - except on a conversion, where showing
  // what the task could not fill in is the point (Neil: "this is missing,
  // this is missing").
  const [showErrors, setShowErrors] = useState(!!fromTask);
  const [busy, setBusy] = useState(false);
  // The finish screen (Neil, Oct 28 2026): after Create the form turns into
  // "Ticket #N Is In" - which desk has it, when to expect a reply, what
  // happens next - instead of closing without a word. { ticket, files }.
  const [done, setDone] = useState(null);
  const [equipErr, setEquipErr] = useState('');   // TicketEquipmentIntake's server refusal
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // An incident's answers move Priority along with them (suggestPriority)
  // until the person sets Priority themselves.
  const setTfVal = (k, v) => {
    setTf((p) => ({ ...p, [k]: v }));
    const sp = suggestPriority(form.type, { ...tf, [k]: v });
    if (sp && !prioTouched) set('priority', sp);
  };
  // The admin's saved type order arrives after mount (useTicketConfig). If it
  // took Incident out of intake, move off it - but only while the person has
  // not picked a type themselves.
  const typeTouched = useRef(!!seed?.form || (!!initial?.type && initialType === initial.type));
  // A picked priority (or one carried from a task or a draft) is never moved.
  const [prioTouched, setPrioTouched] = useState(() => !!seed?.form || PRIORITY_ORDER.includes(fromTask?.priority));
  const typeOrderKey = TICKET_TYPE_ORDER.join(',');
  useEffect(() => {
    if (typeTouched.current || TICKET_TYPE_ORDER.includes(form.type)) return;
    const next = defaultIntakeType();
    setForm((f) => ({ ...f, type: next }));
    setTf((prev) => ({ ...Object.fromEntries(Object.entries(prev).filter(([k]) => k.startsWith('svc_'))), ...intakeDefaults(next) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeOrderKey]);
  // No follow-up questions per topic (Pranshu, Oct 1: "A Few More Details" -
  // Which facility? Unit? - was not needed). The topic and the description are
  // the whole ask; the server still files the ticket under the topic's area.
  // Company field on intake (Sep 19, Pranshu: "End user don't have the
  // ability to choose company... admin have the control to turn on/off the
  // company field"). Off (the default): no picker, departments come
  // pre-scoped to the requester's own company. On: `enabledCompanies` is the
  // admin-picked subset a requester may choose from - a picker only shows
  // when there's a real choice to make (2+); exactly one auto-fills silently.
  const enabledCompanies = COMPANY_FIELD.enabled
    ? companies.filter((c) => COMPANY_FIELD.companyIds.includes(c.id)) : [];
  const showCompanyPicker = enabledCompanies.length > 1;
  useEffect(() => {
    if (COMPANY_FIELD.enabled && enabledCompanies.length === 1 && form.companyId !== enabledCompanies[0].id) {
      set('companyId', enabledCompanies[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [COMPANY_FIELD.enabled, enabledCompanies.length && enabledCompanies[0]?.id]);
  // Departments narrow to whichever company is in play: the requester's own
  // (the field is off, or on with nothing picked yet) or the one they chose.
  const deptOptions = (COMPANY_FIELD.enabled
    ? allDepts.filter((d) => d.companyId === form.companyId)
    : allDepts).filter(offeredAtIntake)
    // Raised from a property in Asset Management: only property tickets, so
    // only the building and site teams (Pranshu, 10/06).
    .filter((d) => !forProperty || groupTakesProperty(helpGroupFor(d.name)));
  // The chosen department's NAME - what the help topics are listed by.
  const deptName = deptOptions.find((d) => d.id === form.hrDepartmentId)?.name || '';
  // Ask "Which property?" only for a team that takes one - a building, site
  // operations or site security team (the server enforces the same rule).
  const deptTakesProperty = groupTakesProperty(helpGroupFor(deptName));
  // Ops review (Neil, Oct 20): a Buildings & Maintenance ticket names its
  // property, and at a Cubby store its unit - TicketPropertyFields.jsx. The
  // desk may file without (the server's rule too).
  const propRules = useTicketPropertyRules();
  // Neil, Oct 28 2026: naming the property is what makes a maintenance ticket
  // workable, so a Buildings & Maintenance team asks for it as soon as it is
  // picked - not only once a maintenance topic is (the server's rule).
  const buildingTeam = isBuildingGroup(helpGroupFor(deptName));
  // The desk too (Neil, Oct 28 2026: "yes should have to pick property but
  // other or none should also be an option") - on this form; Batch Create and
  // the server keep the desk's exemption.
  const mustNameProperty = deptTakesProperty && !forProperty
    && (buildingTeam || propertyRequiredFor(propRules, form.application));
  const propUnits = usePropertyUnits(deptTakesProperty ? (form.propertyAssetId || '') : '');
  // Raised from a property (Asset Management): start on the team that handles
  // buildings once the departments arrive - once, and never over a pick.
  // Adjusting state while rendering (React's pattern for "derive once from
  // async data"), guarded by the flag so it runs a single time.
  const [pickBuildingDept, setPickBuildingDept] = useState(!!forProperty);
  if (pickBuildingDept && deptOptions.length) {
    setPickBuildingDept(false);
    const building = deptOptions.find((d) => isBuildingGroup(helpGroupFor(d.name)));
    if (building && !form.hrDepartmentId) set('hrDepartmentId', building.id);
  }
  // intakeFieldsFor, not TYPE_FIELDS: retired fields stay in the definitions
  // so tickets that already captured one still render it, but nobody is asked
  // for them again; radios are asked as dropdowns; and the error-message
  // question only appears once the department is IT (Neil, Oct 1).
  const typeFieldDefs = useMemo(() => intakeFieldsFor(form.type, deptName), [form.type, deptName]);
  // Requester picker: me first, then everyone else on the People list.
  const requester = form.requesterId || me;
  const requesterOptions = useMemo(() => {
    const nameFor = (email) => people.find((p) => p.email === email)?.name || email;
    const others = people.filter((p) => p.email !== me && !p.external)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }))
      .map((p) => ({ id: p.email, label: p.name, desc: p.email }));
    const mine = me ? [{ id: me, label: `${nameFor(me)} (Me)`, desc: me }] : [];
    // Someone picked who is not in the loaded list (a recording draft from a
    // session where the list differed) still shows as themselves.
    const known = new Set([me, ...others.map((o) => o.id)]);
    const extra = requester && !known.has(requester) ? [{ id: requester, label: requester, desc: '' }] : [];
    return [...mine, ...extra, ...others];
  }, [people, me, requester]);
  const onBehalf = !!requester && !!me && requester !== me;
  // A converted task's owner who is not on the People list (an external
  // collaborator) cannot be a requester - fall back to me once the list is in.
  useEffect(() => {
    if (fromTask && people.length && form.requesterId && form.requesterId !== me
        && !people.some((p) => p.email === form.requesterId && !p.external)) set('requesterId', me || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people.length]);

  // ── Validation ──
  // One step now (Neil, Sep 30: "consolidate step one and step 2... there's
  // no need to have multi-step actually on this"), so one list. Recomputed
  // each render, so red marks clear as soon as a field is filled; only the
  // CURRENT type's fields are checked - leftovers from a previously selected
  // type are never submitted. Department is only demanded when there are
  // departments to choose from (an inescapable form otherwise), company only
  // when its picker is shown. What it is about is always demanded: "Other"
  // with nothing typed told the team nothing.
  const missing = useMemo(() => {
    const out = new Set();
    if (!form.subject.trim()) out.add('subject');
    if (showCompanyPicker && !form.companyId) out.add('companyId');
    if (deptOptions.length > 0 && !form.hrDepartmentId) out.add('hrDepartmentId');
    if (!form.application.trim()) out.add('application');
    for (const f of typeFieldDefs) {
      if (f.req && isBlankFieldValue(tf[f.key])) out.add(f.key);
    }
    if (mustNameProperty && !form.propertyAssetId && !form.propertyNone) out.add('propertyAssetId');
    if (mustNameProperty && form.propertyAssetId && propUnits.required && !String(form.propertyUnit || '').trim()) out.add('propertyUnit');
    return out;
  }, [form.subject, form.companyId, form.hrDepartmentId, form.application, showCompanyPicker, deptOptions, typeFieldDefs, tf,
    mustNameProperty, form.propertyAssetId, form.propertyNone, form.propertyUnit, propUnits.required]);

  // ── Mobile capture shortcuts (mirrors CreateTaskModal) ──
  // Photo / attach / scan sit in the footer so they're one tap away on a phone.
  // Files are held locally and uploaded once the ticket exists - the attachment
  // API is keyed by ticket id, so there is nothing to attach to until then.
  const camRef = useRef(null);
  const libRef = useRef(null);
  const vidRef = useRef(null);
  const attachRef = useRef(null);
  const scanRef = useRef(null);
  const [attachments, setAttachments] = useState(seed?.attachments || []);
  const [photoMenu, setPhotoMenu] = useState(false);
  const photoBtnRef = useRef(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  // While a screen recording runs, the whole modal steps aside (see the early
  // return before `shell`): the backdrop at z-4000 both buried the recorder's
  // Stop pill and closed-and-discarded the form on any outside click. Hiding
  // the RENDER while this component stays mounted keeps every field intact.
  const [recActive, setRecActive] = useState(false);
  // A voice note still recording: Create waits for Stop, or the clip is lost.
  const [voiceRec, setVoiceRec] = useState(false);
  // Tell the draft stash whether this form is alive: on Stop it either lets
  // the mounted form reappear, or (form unmounted - the user navigated away
  // to reproduce the issue) routes the app back here to resume from the stash.
  useEffect(() => { setDraftUiMounted(true); return () => setDraftUiMounted(false); }, []);
  const onRecChange = (v) => {
    setRecActive(v);
    if (v) stashDraft({ form, tf, attachments });
    else finishRecording();
  };
  const onFiles = (e) => {
    // A video from the camera or the library keeps the video limit and a
    // real type (an iPhone .mov can come with none) - Neil, Oct 30 2026.
    const picked = Array.from(e.target.files || []).map(withType); e.target.value = '';
    const tooBig = picked.map((f) => (mediaKind(f) ? checkMedia(f) : '')).filter(Boolean);
    const list = picked.filter((f) => !mediaKind(f) || !checkMedia(f));
    if (tooBig.length) appDialog.alert(tooBig[0], { title: 'Not Added' });
    if (list.length) setAttachments((prev) => [...prev, ...list]);
  };
  const addFile = (f) => { appendDraftFile(f); setAttachments((prev) => [...prev, f]); };
  // Ctrl+V of a screenshot anywhere in the form. Inside the description the
  // editor has already embedded it in place (and marked the event handled);
  // anywhere else - the title, a dropdown - it is attached instead.
  const onFormPaste = (e) => {
    if (e.defaultPrevented) return;
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addFile);
  };
  // ABC scanner → OCR the photo server-side and append the text to the Title.
  const onScan = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setOcrBusy(true);
    try {
      const { text } = await api.ocrImage(f);
      if (text && text.trim()) set('subject', (form.subject ? `${form.subject} ` : '') + text.trim().replace(/\s+/g, ' '));
      else appDialog.alert('No text found in the image.');
    } catch { appDialog.alert("Couldn't extract text from the image."); }
    finally { setOcrBusy(false); }
  };

  const hasPhoto = attachments.some((f) => (f.type || '').startsWith('image/'));
  const submit = async () => {
    if (busy || voiceRec) return;
    if (missing.size) { setShowErrors(true); return; }
    // A marked spot asks for a photo - strongly, never a wall.
    if (mapSpot && !hasPhoto && !(await appDialog.confirm('A photo of the spot shows the maintenance team exactly what to fix. Create the ticket without one?',
      { title: 'Add a Photo?', confirmText: 'Create Without a Photo', cancelText: 'Add a Photo' }))) return;
    setBusy(true);
    try {
      // Persist the current type's fields AND the current service area's,
      // dropping blanks. Both live on the same typeFields JSON - the `svc_`
      // prefix is what keeps the two sets from colliding. Leftovers from a
      // type or a topic the user moved away from are never submitted, because
      // only the CURRENT definitions are walked.
      const typeFields = {};
      for (const f of typeFieldDefs) {
        if (!isBlankFieldValue(tf[f.key])) typeFields[f.key] = tf[f.key];
      }
      // Rich description (Oct 1). A picture pasted into it is held inline (a
      // data: URL) while typing, exactly like Create a Task; before saving it
      // goes to ticket storage and the description points at the stored copy,
      // so the ticket, its activity snapshot and its emails never carry a
      // megabyte of base64. Each one is also filed under Attachments once the
      // ticket exists. A failed upload keeps the inline copy - never worse.
      const inlineImages = [];
      // A screenshot alone is a description too - isEmptyDoc only sees text.
      const description = (isEmptyDoc(form.description) && !/<img\b/i.test(form.description || '')) ? ''
        : await externalizeInlineImages(form.description, async (f) => {
          const url = await uploadTicketEvidence(f, 'image');
          inlineImages.push({ name: f.name, size: `${Math.max(1, Math.round(f.size / 1024))} KB`, kind: 'image', url });
          return { url };
        });
      // The topic's "Which one?" - only while it is still one of the picked
      // topic's own sub-options (a company or department change can leave a
      // stale one behind).
      if (topicOptions(form.application, helpGroupFor(deptName)).includes(tf[HELP_SUBTOPIC_KEY])) {
        typeFields[HELP_SUBTOPIC_KEY] = tf[HELP_SUBTOPIC_KEY];
      }
      const created = await createTicket({
        subject: form.subject.trim(), description, type: form.type, priority: form.priority,
        // No status (and never an assignee) from this form: the server opens
        // every new ticket, and a non-desk requester sending either is refused
        // (403). Sent only if something ever picks a status other than Open.
        ...(form.status && form.status !== 'open' ? { status: form.status } : {}),
        // Requester = who it is for (defaults to me; the server checks anyone
        // else against the People list and records me as the creator). SLA due
        // date is derived from priority; the service area from the topic.
        requesterId: requester || '', companyId: form.companyId || '', hrDepartmentId: form.hrDepartmentId || '',
        application: form.application.trim(),
        // Collaborators - the server adds you too when it is for someone else.
        watcherIds: (form.watcherIds || []).filter((e) => e && e !== requester),
        // A preview only - the server sets the deadline (sla_due_at) itself.
        slaDueOn: slaDueFromPriority(form.priority).slice(0, 10),
        typeFields,
        ...(fromTask ? { fromTaskId: fromTask.id, closeSourceTask: closeSource } : {}),
        ...(form.propertyAssetId && deptTakesProperty ? { propertyAssetId: form.propertyAssetId, propertyUnit: String(form.propertyUnit || '').trim() } : {}),
        ...(!form.propertyAssetId && form.propertyNone && deptTakesProperty ? { propertyNone: true } : {}),
        // Raised from the property itself: it stays that property's ticket.
        ...(forProperty && form.propertyAssetId === forProperty.id ? { propertyLocked: true } : {}),
        // Equipment (TicketEquipment.jsx) - checked server-side (ticket_items.py).
        ...(form.items?.length ? { item_ids: form.items.map((i) => i.id) } : {}),
        // Mark an Issue on the Map - checked and stored by the server (ticket_map_spot.py).
        ...(mapSpot?.spot ? { map_spot: (({ modelId, u, v, y, r, outline, unit, building, place }) => ({ modelId, u, v, y, r, outline, unit, building, place }))(mapSpot.spot) } : {}),
      });
      // Attachments can only be posted once the ticket has an id. A storage
      // failure here must not lose the ticket that was just created - the
      // ticket still saves, and any failed file gets one combined warning
      // (not one alert per file) rather than being silently dropped.
      if (created?.id && inlineImages.length) {
        await Promise.all(inlineImages.map((a) => api.addTicketAttachment(created.id, a).catch(attachFailed(a.name))));
      }
      // The marked map goes up like any other photo ("Map Location ..." - the drawer's card finds it by name).
      const mapFile = created?.id && mapSpot?.snapshot ? dataUrlToFile(mapSpot.snapshot, `Map Location - ${(mapSpot.spot?.place || 'Spot').replace(/[^\w .,-]+/g, ' ').trim()}.jpg`) : null;
      let stored = inlineImages.length;
      if (created?.id && (attachments.length || mapFile)) {
        const files = mapFile ? [mapFile, ...attachments] : attachments;
        const results = await Promise.all(files.map((f) => uploadTicketFile(created.id, f)));
        const failed = files.filter((_, i) => !results[i]);
        stored += files.length - failed.length;
        if (failed.length) {
          appDialog.alert(`Ticket created, but ${failed.length} attachment${failed.length > 1 ? 's' : ''} couldn't be stored (${failed.map((f) => f.name).join(', ')}) - they won't be playable/downloadable.`);
        }
      }
      // Suggested Articles showed answers and the person filed anyway - what
      // the guide is missing. Only then: a ticket filed with no suggestions
      // on screen is not a search, and its title is not a search term.
      if (!fromTask && deflectCount.current > 0) logHelpSearch(form.subject, deflectCount.current, 'ticket-form');
      onCreated?.(created);
      // A property's ticket tabs in Asset Management refresh on this, and so do
      // the Help Center's list and the Help panel's Messages (Oct 28 2026: a
      // ticket filed from the "?" panel never showed until a reload).
      window.dispatchEvent(new CustomEvent('nexus:tickets-changed', { detail: { propertyId: created?.propertyAssetId || '' } }));
      setBusy(false);
      if (created?.id) setDone({ ticket: created, files: stored });
      else onClose();
    } catch (e) { if (equipmentError(e)) setEquipErr(equipmentError(e)); else appDialog.alert(`Could not create ticket: ${e.message || e}`); setBusy(false); }
  };

  const sel = { ...inputStyle, appearance: 'auto', cursor: 'pointer' };

  // Recording in progress: get out of the way. The form (and its portal
  // backdrop) disappears so the person can reproduce the issue and reach the
  // recorder's Stop pill; this component stays mounted, so on stop the form
  // returns exactly as they left it, with the clip attached. The chip is a
  // pointer-events-free hint - the recorder pill owns Stop/Cancel.
  if (recActive) {
    return (
      <div style={{ position: 'fixed', left: 18, bottom: 18, zIndex: 5990, pointerEvents: 'none',
        background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 12, padding: '10px 14px',
        boxShadow: '0 8px 30px rgba(0,0,0,.18)', fontSize: 12.5, color: NX.dim, maxWidth: 300, fontFamily: FONT }}>
        Recording for your ticket - the form reopens with everything intact when you press Stop.
      </div>
    );
  }

  // Phones get the Asana-style bottom sheet (same chrome as quick-create task);
  // desktop keeps the centred modal. A plain function, not a component - defining
  // a component inline would remount the whole form on every render and drop focus.
  // `extras` is the icon row, which sits on its own line above the actions.
  // The popup carries the same ticket glyph the sidebar uses, top-left of
  // its header (Neil, Sep 22) - both shells render the title as a node.
  const heading = (text) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <TicketToken size={18} style={{ color: NX.brand ?? 'var(--wk-brand)', flexShrink: 0 }} />
      {onBatch && !fromTask && !done
        ? <CreateModeTabs active="single" onChange={() => { stashDraft({ form, tf, attachments }); onBatch(); }} />
        : text}
    </span>
  );
  const shell = (text, { footer, extras, children }) => { const title = heading(text); return (isMobile ? (
    <BottomSheet title={title} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
      {/* Pinned to the bottom of the sheet's scroll area: the ticket form is long,
          and Create Ticket must not scroll out of reach. Negative margins + padding
          let the bar span the sheet's full width over BottomSheet's 16px padding. */}
      <div style={{
        position: 'sticky', bottom: -16, zIndex: 2, background: NX.surface,
        borderTop: `1px solid ${NX.border2}`, marginTop: 14,
        marginLeft: -16, marginRight: -16, marginBottom: -16,
        padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {extras}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{footer}</div>
      </div>
    </BottomSheet>
  ) : (
    <Modal title={title} onClose={onClose} footer={footer}>{children}</Modal>
  )); };

  const req = <span style={{ color: NX.red }}>*</span>;
  const sub = (text) => <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>{text}</div>;
  const err = (k) => showErrors && missing.has(k);
  const brand = NX.brand ?? 'var(--wk-brand)';

  // ── The finish screen (Neil, Oct 28 2026) ──
  // Open Ticket: straight into the drawer where a ticket screen is already up
  // (the desk or Support listens for nexus:open-ticket), else to the one this
  // person can open - the Tickets desk for administrators and module grants,
  // Support (their own requests, the same drawer) for everyone else.
  if (done) {
    const t = done.ticket;
    const code = ticketNoShort(t.code);
    const desk = deptName || t.hrDepartmentName || '';
    const forName = onBehalf ? (people.find((p) => p.email === requester)?.name || requester) : '';
    const link = `${window.location.origin}/support?ticket=${t.id}`;
    const openIt = () => {
      const here = window.location.pathname.split('/')[1];
      if (here !== 'tickets' && here !== 'support') {
        setPendingOpen('ticket', t.id);
        const isDesk = (typeof can === 'function' && can('administrator')) || myGrantedModules?.has?.('tickets');
        window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: isDesk ? 'tickets' : 'support', sub: null } }));
      }
      setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: t.id } })), 0);
      onClose();
    };
    const another = () => {
      setForm(blankForm()); setTf(intakeDefaults(initialType)); setAttachments([]);
      setShowErrors(false); setEquipErr(''); setDone(null);
    };
    const facts = [
      ['Title', t.subject || form.subject],
      ['Desk', desk || 'The help desk'],
      t.propertyName || (form.propertyAssetId && forProperty?.name)
        ? ['Property', `${t.propertyName || forProperty.name}${t.propertyUnit ? ` - ${t.propertyUnit}` : ''}`] : null,
      ['Priority', <PrioritySignal key="p" priority={t.priority || form.priority} />],
      t.firstResponseDueAt ? ['First Reply By', fmtMoment(t.firstResponseDueAt)] : null,
      done.files ? ['Attachments', `${done.files} uploaded`] : null,
      fromTask ? ['From the Task', `${fromTask.title}${closeSource ? ' - closed' : ''}`] : null,
    ].filter(Boolean);
    const steps = [
      ['Received', t.createdAt ? fmtMoment(t.createdAt) : 'just now'],
      ...(typeRequiresApproval(t.type || form.type) ? [['Approved', 'this type waits for approval before work starts']] : []),
      ['Assigned', 'to someone on the desk'],
      ['Worked On', "replies show in the ticket's conversation"],
      ['Resolved', 'you confirm it is fixed, or reopen it'],
    ];
    return shell('Ticket Created', {
      footer: (<>
        <CopyLinkButton link={link} />
        {!fromTask && !mapSpot && <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={another}>Create Another</button>}
        <button style={{ ...btn('primary'), ...(fromTask || mapSpot ? { marginLeft: 'auto' } : null) }} onClick={openIt} autoFocus>Open Ticket</button>
      </>),
      children: (
        <div role="status" style={{ display: 'flex', flexDirection: 'column', padding: isMobile ? '4px 0' : '8px 12px' }}>
          <span aria-hidden="true" style={{ width: 44, height: 44, borderRadius: '50%', border: `2px solid ${brand}`, color: brand,
            display: 'grid', placeItems: 'center', marginBottom: 14 }}><Check size={24} strokeWidth={2.4} /></span>
          <div style={{ fontSize: 21, fontWeight: 700, color: NX.ink, letterSpacing: '-0.01em' }}>
            {code ? `Ticket ${code} Is In` : 'Your Ticket Is In'}
          </div>
          <div style={{ fontSize: 13.5, color: NX.dim, lineHeight: 1.55, marginTop: 6 }}>
            {desk ? `${desk} has it.` : 'The help desk has it.'}{' '}
            {forName
              ? `${forName} gets a bell and an email when someone replies or the status changes, and you are following it too.`
              : 'You will get a bell and an email when someone replies or the status changes.'}
          </div>
          <dl style={{ margin: '18px 0 0', borderTop: `1px solid ${NX.border2}` }}>
            {facts.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 16, padding: '10px 0', borderBottom: `1px solid ${NX.border2}` }}>
                <dt style={{ fontSize: 13, color: NX.muted ?? NX.dim, flex: 'none', width: 120 }}>{k}</dt>
                <dd style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: NX.ink, flex: 1, minWidth: 0, textAlign: 'right', overflowWrap: 'anywhere' }}>{v}</dd>
              </div>
            ))}
          </dl>
          <div style={{ fontSize: 12, fontWeight: 700, color: NX.dim, margin: '20px 0 8px' }}>What Happens Next</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {steps.map(([name, note], i) => (
              <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, color: i ? NX.dim : NX.ink }}>
                <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center',
                  fontSize: 11, fontWeight: 700, border: `1.5px solid ${i ? NX.border : brand}`, color: i ? NX.faint : brand }}>{i + 1}</span>
                <span><b style={{ fontWeight: 600, color: NX.ink }}>{name}</b> - {note}</span>
              </li>
            ))}
          </ol>
        </div>
      ),
    });
  }

  // Convert to Ticket: what came across, and each required field still empty.
  const fieldLabel = (k) => ({ subject: 'Title', companyId: 'Company', hrDepartmentId: 'Department',
    application: 'What Do You Need Help With?', propertyAssetId: 'Property', propertyUnit: 'Unit' }[k] || typeFieldDefs.find((f) => f.key === k)?.label || k);
  const carried = fromTask ? ['title', 'description', 'priority', 'requester',
    ...((form.watcherIds || []).length ? ['collaborators'] : []),
    ...(fromTask.fileCount ? [`${fromTask.fileCount} file${fromTask.fileCount > 1 ? 's' : ''}`] : [])] : [];

  const pickDept = (v) => {
    set('hrDepartmentId', v);
    // A new team has its own list - the old pick (and any follow-up
    // answers that came with it) belonged to the other one.
    set('application', '');
    setTf((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith('svc_'))));
  };
  const pickTopic = (name) => {
    set('application', name);
    // Keep only the answers the new topic also asks: swapping one
    // maintenance topic for another asks the same "Which site?", and
    // throwing away the site already picked would be gratuitous.
    const asks = new Set(topicQuestionDefs(name, areaForTopic(name)).map((f) => f.key));
    setTf((prev) => Object.fromEntries(
      Object.entries(prev).filter(([k]) => !k.startsWith('svc_') || asks.has(k))));
  };
  const firstReply = FIRST_RESPONSE_HOURS[form.priority];
  const suggested = suggestPriority(form.type, tf);
  // Desk-Ready rows: [name, done, required].
  const answered = typeFieldDefs.filter((f) => !isBlankFieldValue(tf[f.key])).length;
  const canRecord = !NO_RECORDING_TYPES.includes(form.type);
  const readiness = [
    deptOptions.length ? ['Team', !!form.hrDepartmentId, true] : null,
    ['What It Is About', !!form.application.trim(), true],
    ['Title', !!form.subject.trim(), true],
    ['A Few Lines on What Is Happening', richToPlain(form.description).trim().length >= 20, false],
    [canRecord ? 'Screenshot or Recording' : 'Screenshot or File',
      attachments.length > 0 || /<img\b/i.test(form.description || '') || !!mapSpot?.snapshot, false],
    typeFieldDefs.length ? [`${TICKET_TYPE_META[form.type]?.label || 'Type'} Details (${answered} of ${typeFieldDefs.length})`, answered === typeFieldDefs.length, false] : null,
    buildingTeam || mustNameProperty ? ['Property', !!form.propertyAssetId || !!form.propertyNone, mustNameProperty] : null,
  ].filter(Boolean);
  const readyCount = readiness.filter((r) => r[1]).length;
  const secHead = (n, text, hint, id) => (
    <div id={id} style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 8px', marginBottom: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: brand, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: NX.ink }}>{text}</span>
      {hint && <span style={{ fontSize: 12, color: NX.faint }}>{hint}</span>}
    </div>
  );
  const railHead = (text, extra) => (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
      <span style={{ ...label, marginBottom: 0 }}>{text}</span>{extra}
    </div>
  );
  const railRow = { paddingBottom: 14, marginBottom: 14, borderBottom: `1px solid ${NX.border2}` };

  // ── One screen (Neil, Oct 28 2026 - replaces the Sep 30 single column) ──
  // Left, in two numbered parts: 1 What Is Wrong (team, topic, title, what is
  // happening with the recording / file bar, the articles that may already
  // answer it) and 2 Details for the Desk (type, priority, the type's
  // questions, the property). Right rail: who (requester, collaborators,
  // company, equipment), Desk-Ready and where it goes. Phones fold the rail
  // under the form.
  const main = (
    <div style={{ minWidth: 0, padding: isMobile ? 0 : '20px 22px' }}>
      {mapSpot?.spot && <MapSpotIntake spot={mapSpot.spot} propertyName={forProperty?.name} snapshot={mapSpot.snapshot} hasPhoto={hasPhoto} />}
      {fromTask && (
        <div role="status" style={{ border: `1px solid ${NX.border}`, background: NX.surface2, borderRadius: 10,
          padding: '10px 12px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, color: NX.dim }}>
          <div>From the task <b style={{ color: NX.ink }}>{fromTask.title}</b>: {carried.join(', ')} filled in.</div>
          {missing.size > 0
            ? <div style={{ color: NX.red, fontWeight: 600, marginTop: 4 }}>
                Still needed: {[...missing].map(fieldLabel).join(', ')}
              </div>
            : <div style={{ color: NX.green, fontWeight: 600, marginTop: 4 }}>Everything required is filled in - check the Type, then convert.</div>}
        </div>
      )}

      {secHead(1, 'What Is Wrong')}
      {/* Which team: tiles while there are few enough to see at once (each
          with a taste of what it handles), the searchable list past eight,
          nothing at all when the company has no departments. */}
      {deptOptions.length > 0 && (
        <div style={field}>
          <label style={label} id="ct-team">Which Team Can Help? {req}</label>
          {deptOptions.length <= 8 ? (
            <div role="radiogroup" aria-labelledby="ct-team"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
              {deptOptions.map((d) => {
                const on = form.hrDepartmentId === d.id;
                const Icon = deptIcon(d.name);
                const taste = (helpGroupFor(d.name)?.topics || []).slice(0, 3).map((tp) => tp.name.replace(/\s*\(.*\)$/, '')).join(', ');
                return (
                  <button key={d.id} type="button" role="radio" aria-checked={on} onClick={() => { if (!on) pickDept(d.id); }}
                    className="nx-ct-tile"
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 9, textAlign: 'left', cursor: 'pointer', fontFamily: FONT,
                      padding: '9px 11px', borderRadius: 10, background: NX.surface,
                      border: `1px solid ${on ? brand : err('hrDepartmentId') ? NX.red : NX.border}`,
                      boxShadow: on ? `inset 0 0 0 1px ${brand}` : 'none' }}>
                    <Icon size={17} strokeWidth={1.9} style={{ color: on ? brand : NX.dim, flex: 'none', marginTop: 1 }} aria-hidden="true" />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: NX.ink, lineHeight: 1.3 }}>{d.name}</span>
                      {taste && <span title={taste} style={{ display: 'block', fontSize: 11.5, color: NX.faint, lineHeight: 1.35, marginTop: 2,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{taste}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <TicketSelect value={form.hrDepartmentId} onChange={pickDept}
              placeholder="Select department" searchPlaceholder="Search departments…" emptyText="No departments to choose from."
              invalid={err('hrDepartmentId')} style={sel}
              options={[['', 'Select department'], ...deptOptions.map((d) => [d.id, d.name])]} />
          )}
          {err('hrDepartmentId') && <div style={requiredHint}>Pick the team that should handle it</div>}
        </div>
      )}

      <div style={field}>
        <label style={label}>What Do You Need Help With? {req}</label>
        <HelpTopicField key={form.hrDepartmentId || 'none'} deptName={deptName} value={form.application}
          invalid={err('application')}
          subValue={tf[HELP_SUBTOPIC_KEY] || ''} onSubChange={(v) => setTfVal(HELP_SUBTOPIC_KEY, v)}
          onChange={pickTopic} />
        {err('application') && <div style={requiredHint}>Required</div>}
        {/* Suggested Help Topic chips (TicketAi.jsx) - a click fills it, never automatic. */}
        <SuggestedTopicChips subject={form.subject} description={form.description} departmentId={form.hrDepartmentId}
          value={form.application} onPick={pickTopic} />
        {sub(helpGroupFor(deptName) ? 'Pick the closest match, or Other to type it.' : 'Name it in a few words.')}
      </div>

      {deptTakesProperty && (
        // Property + Unit (Ops review, Oct 20), right under the topic: a
        // maintenance ticket is only workable once the desk knows where.
        // Raised from the property itself (forProperty), it is fixed.
        <TicketPropertyIntake fixed={forProperty} value={form.propertyAssetId} unit={form.propertyUnit || ''}
          none={!!form.propertyNone} onNone={(v) => set('propertyNone', v)}
          onChange={(v) => { set('propertyAssetId', v); set('propertyUnit', ''); }}
          onUnitChange={(v) => set('propertyUnit', v)}
          required={mustNameProperty} unitRequired={mustNameProperty && propUnits.required}
          invalidProperty={err('propertyAssetId')} invalidUnit={err('propertyUnit')}
          text={`${form.subject} ${form.description || ''}`} units={propUnits} style={sel} />
      )}

      {!fromTask && <KnownIssuesNotice />}
      <div style={field}>
        <label style={label}>Title {req}</label>
        <input autoFocus value={form.subject} onChange={(e) => set('subject', e.target.value)} placeholder="What is the issue? e.g. Light out in the front office"
          style={{ ...inputStyle, ...(err('subject') ? { borderColor: NX.red } : null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        {err('subject') && <div style={requiredHint}>Required</div>}
      </div>

      {/* Rich description (Neil, Oct 1): the Task module's own editor. The
          recording / file bar sits right under it (Neil, Oct 28 2026: calm,
          not the red dashed card) - still the first thing below the text. */}
      <div style={field}>
        <label style={label}>What Is Happening?</label>
        <RichDescription value={form.description} onChange={(html) => set('description', html)} minHeight={isMobile ? 90 : 120}
          placeholder="What is happening? What were you doing, and what did you expect?" />
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', marginTop: 6 }}>
          <RecordUploadButtons quiet showRecord={!NO_RECORDING_TYPES.includes(form.type)}
            onFile={addFile} onRecordingChange={onRecChange} onVoiceRecordingChange={setVoiceRec} />
          {!isMobile && <span style={{ fontSize: 12, color: NX.faint }}>or press Ctrl+V to paste a screenshot</span>}
        </div>
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {attachments.map((f, i) => (
              <PendingFileChip key={`${f.name}-${i}`} file={f} onRemove={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))} />
            ))}
          </div>
        )}
      </div>

      {/* Self-service before a ticket (Neil, Sep 26): guide articles that
          match what is being typed. Advisory only - it never blocks Create
          Ticket, and shows nothing when nothing is a confident match.
          "This Solved My Problem" closes the form without creating one. */}
      <TicketDeflection subject={form.subject} description={richToPlain(form.description)} onSolved={onClose}
        onResults={(n) => { deflectCount.current = n; }} />

      {/* Details for the desk (Neil, Oct 28 2026: "a lot of detail missing").
          The type, its questions and the priority sit in the form, not the
          rail, so they read as part of the ticket; every one is pre-answered
          where it can be, so the common ticket still needs no clicks here. */}
      <section aria-labelledby="ct-s2" style={{ borderTop: `1px solid ${NX.border2}`, paddingTop: 18, marginTop: 6 }}>
        {secHead(2, 'Details for the Desk', 'Pre-filled where we can - change anything that is not right.', 'ct-s2')}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <div style={{ ...field, marginBottom: 0 }}>
            <label style={label}>Type {req}</label>
            <TicketSelect value={form.type} options={typeIntakeOptions()} style={sel} onChange={(v) => {
              set('type', v);
              // Clear the outgoing type's own fields, but KEEP the service
              // answers - a type that no longer asks one simply does not render
              // or submit it, because both walk the current definitions.
              typeTouched.current = true;
              const kept = Object.fromEntries(Object.entries(tf).filter(([k]) => k.startsWith('svc_')));
              const next = { ...kept, ...intakeDefaults(v, kept) };
              setTf(next);
              const sp = suggestPriority(v, next);
              if (sp && !prioTouched) set('priority', sp);
            }} />
            {/* The definition of whichever type is picked. */}
            {TICKET_TYPE_META[form.type]?.hint && sub(TICKET_TYPE_META[form.type].hint)}
            {/* Admin switch per type (Settings > Ticket Manager > SLA & Ticket
                Types) - read from the loaded taxonomy, never a hardcoded list. */}
            {typeRequiresApproval(form.type) && (
              <div style={{ fontSize: 11.5, color: NX.amber, marginTop: 4 }}>This type needs approval before the team can start work on it.</div>
            )}
          </div>
          <div style={{ ...field, marginBottom: 0 }}>
            <label style={label}>Priority</label>
            <TicketSelect value={form.priority} onChange={(v) => { setPrioTouched(true); set('priority', v); }} options={priorityOptions()} style={sel} />
            {suggested && suggested === form.priority && !prioTouched
              && sub('Set from who is affected and whether you can keep working.')}
            {suggested && suggested !== form.priority && (
              <div style={{ fontSize: 11.5, color: NX.faint, marginTop: 4 }}>
                Your answers suggest {PRIORITY_META[suggested]?.label}.{' '}
                <button type="button" onClick={() => { setPrioTouched(false); set('priority', suggested); }}
                  style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: NX.blue ?? NX.dim, cursor: 'pointer' }}>Use It</button>
              </div>
            )}
          </div>
          {typeFieldDefs.map((f) => (
            <div key={f.key} style={{ ...field, marginBottom: 0, gridColumn: (f.full || f.type === 'textarea' || f.type === 'checklist') ? '1 / -1' : 'auto' }}>
              <label style={label}>{f.label}{f.req && <span style={{ color: NX.red }}> *</span>}</label>
              <TypeFieldInput field={f} value={tf[f.key]} onChange={(v) => setTfVal(f.key, v)} people={people} projects={projects}
                invalid={err(f.key)} />
              {err(f.key) && <div style={requiredHint}>Required</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const rail = (
    <aside aria-label="Who and Where" style={isMobile
      ? { borderTop: `1px solid ${NX.border2}`, paddingTop: 16, marginTop: 6 }
      : { background: NX.surface2, borderLeft: `1px solid ${NX.border2}`, padding: '20px 20px', minWidth: 0 }}>
      {/* Requester (Neil, Oct 1 2026): who the ticket is FOR - you by
          default, anyone on the People list otherwise. They get the updates,
          see it as theirs, and confirm or reopen it; you stay on as a watcher. */}
      <div style={railRow}>
        {railHead('Requester')}
        <TicketSelect value={requester} onChange={(v) => set('requesterId', v || me || null)}
          options={requesterOptions} placeholder="Select a person" searchPlaceholder="Search people…"
          emptyText="No one matches." style={sel} />
        {sub(onBehalf
          ? 'Raising this on their behalf - they get the updates, and you can still follow it.'
          : 'Raising it for someone else? Pick them here.')}
      </div>
      {/* Collaborators (Sagar, Oct 14 2026), as on a task: anyone else who
          should follow it - they can open it, reply and get its updates. */}
      <div style={railRow}>
        {railHead('Collaborators')}
        <TicketPeopleMultiSelect value={form.watcherIds || []} options={requesterOptions.filter((o) => o.id !== requester)} {...collabExtras}
          onChange={(list) => set('watcherIds', list)} />
        {sub('Anyone else who should follow it and can reply.')}
      </div>
      {/* Company picker (Sep 19, Pranshu) - only once an admin has turned it
          on AND offered 2+ companies; the teams are always that company's. */}
      {showCompanyPicker && (
        <div style={railRow}>
          {railHead(<>Company {req}</>)}
          <TicketSelect value={form.companyId} onChange={(v) => { set('companyId', v); set('hrDepartmentId', ''); set('application', ''); }}
            placeholder="Select company" searchPlaceholder="Search companies…" emptyText="No companies to choose from."
            invalid={err('companyId')} style={sel}
            options={[['', 'Select company'], ...enabledCompanies.map((c) => [c.id, c.name])]} />
          {err('companyId') && <div style={requiredHint}>Required</div>}
        </div>
      )}
      <div style={{ ...railRow, paddingBottom: 0 }}>
        <TicketEquipmentIntake value={form.items || []} onChange={(v) => { setEquipErr(''); set('items', v); }}
          requester={requester || ''} companyId={form.companyId || ''} error={equipErr} />
      </div>
      {/* Desk-Ready (Neil, Oct 28 2026): what the assignee will have to go
          on. Required items are the form's own; the rest are recommended and
          never block Create Ticket - a nudge, not a wall. */}
      <div style={railRow}>
        {railHead('Desk-Ready', <span style={{ fontSize: 12, color: NX.faint, fontVariantNumeric: 'tabular-nums' }}>{readyCount} of {readiness.length}</span>)}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {readiness.map(([name, ok, required]) => (
            <li key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, lineHeight: 1.4, color: ok ? NX.ink : NX.dim }}>
              {ok
                ? <CircleCheck size={15} style={{ color: brand, flex: 'none', marginTop: 1 }} aria-label="Done" />
                : <Circle size={15} style={{ color: NX.faint, flex: 'none', marginTop: 1 }} aria-label="Not yet" />}
              <span>{name}{!ok && <span style={{ color: required ? NX.red : NX.faint }}> - {required ? 'required' : 'recommended'}</span>}</span>
            </li>
          ))}
        </ul>
        {sub('The more the desk has, the fewer questions come back to you.')}
      </div>
      {/* Where it goes: the desk, the usual first reply for this priority,
          and that the desk has the last word on priority. */}
      <div>
        {railHead('Where It Goes')}
        <div style={{ fontSize: 13, fontWeight: 600, color: deptName ? NX.ink : NX.faint }}>
          {deptName || (deptOptions.length ? 'Pick a team to route it' : 'The help desk')}
        </div>
        <div style={{ fontSize: 12.5, color: NX.dim, lineHeight: 1.55, marginTop: 3 }}>
          {firstReply ? <div>Usual first reply: within {hoursText(firstReply)}</div> : null}
          <div>Priority: {PRIORITY_META[form.priority]?.label || form.priority} - the desk may change it</div>
          {/* Admin switch per type (Settings > Ticket Manager > SLA & Ticket
              Types) - read from the loaded taxonomy, never a hardcoded list. */}
          {typeRequiresApproval(form.type) && (
            <div style={{ color: NX.amber }}>This type needs approval before the team can start work on it.</div>
          )}
        </div>
      </div>
    </aside>
  );

  return shell(fromTask ? 'Convert to Ticket' : 'Create a Ticket', {
    // Phone only - same trio as Create a Task, so raising a ticket from a phone
    // can capture a photo of the problem without leaving the form.
    extras: (<>
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 'auto', position: 'relative' }}>
          <button ref={photoBtnRef} type="button" title="Add Photo or Video" aria-label="Add Photo or Video" onClick={() => setPhotoMenu((v) => !v)}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><ImageIcon size={20} /></button>
          <button type="button" title="Attach file" aria-label="Attach file" onClick={() => attachRef.current?.click()}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim }}><Paperclip size={20} /></button>
          <button type="button" title="Scan text" aria-label="Scan text" disabled={ocrBusy} onClick={() => scanRef.current?.click()}
            style={{ ...btn('ghost'), padding: 7, color: NX.dim, opacity: ocrBusy ? 0.5 : 1 }}><ScanText size={20} /></button>
          {ocrBusy && <span style={{ fontSize: 12, color: NX.faint }}>Scanning…</span>}
          {attachments.length > 0 && <span style={{ fontSize: 12, color: NX.faint, marginLeft: 2 }}>{attachments.length}</span>}
          {/* Flips upward on its own - the footer is pinned to the bottom of the modal. */}
          <AnchoredMenu anchorRef={photoBtnRef} open={photoMenu} onClose={() => setPhotoMenu(false)} minWidth={180}
            style={{ background: NX.surface, border: `1px solid ${NX.border}`, borderRadius: 10, boxShadow: '0 10px 28px rgba(0,0,0,0.18)', padding: 4 }}>
            <button type="button" role="menuitem" onClick={() => { setPhotoMenu(false); camRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Camera size={16} /> Take Photo</button>
            <button type="button" role="menuitem" onClick={() => { setPhotoMenu(false); vidRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><Video size={16} /> Record Video</button>
            <button type="button" role="menuitem" onClick={() => { setPhotoMenu(false); libRef.current?.click(); }} style={{ ...btn('ghost'), width: '100%', justifyContent: 'flex-start', gap: 8 }}><ImagePlus size={16} /> Choose From Device</button>
          </AnchoredMenu>
          {/* capture="environment" opens the rear camera on a phone. */}
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onFiles} />
          <input ref={libRef} type="file" accept="image/*,video/*" multiple style={{ display: 'none' }} onChange={onFiles} />
          <input ref={vidRef} type="file" accept="video/*" capture="environment" style={{ display: 'none' }} onChange={onFiles} />
          <input ref={attachRef} type="file" multiple style={{ display: 'none' }} onChange={onFiles} />
          <input ref={scanRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onScan} />
        </div>
      )}
    </>),
    footer: (
      <>
        {showErrors && missing.size > 0 && (
          <span style={{ fontSize: 12.5, color: NX.red, fontWeight: 600 }}>
            {missing.size} required field{missing.size > 1 ? 's' : ''} still empty
          </span>
        )}
        {fromTask && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: NX.dim, cursor: 'pointer' }}>
            <input type="checkbox" checked={closeSource} onChange={(e) => setCloseSource(e.target.checked)} />
            Close the task
          </label>
        )}
        <button style={{ ...btn('outline'), marginLeft: 'auto' }} onClick={onClose}>Cancel</button>
        {voiceRec && <span role="status" style={{ fontSize: 12, color: NX.red }}>{STOP_VOICE_FIRST}</span>}
        <button style={{ ...btn('primary'), opacity: busy || voiceRec ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={submit} disabled={busy || voiceRec}
          title={voiceRec ? STOP_VOICE_FIRST : undefined}>
          {!busy && <Send size={14} aria-hidden="true" />}
          {busy ? (fromTask ? 'Converting…' : 'Creating…') : (fromTask ? 'Convert to Ticket' : 'Create Ticket')}
        </button>
      </>
    ),
    // The modal body's own 20px padding is undone so the rail runs edge to
    // edge and full height beside the form.
    children: (
      <div onPaste={onFormPaste} style={isMobile ? { display: 'contents' } : {
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 300px)', margin: -20, flex: '1 0 auto',
      }}>
        {main}
        {rail}
      </div>
    ),
  });
}

// "4 hours", "1 day", "2 days".
function hoursText(h) {
  if (h >= 24 && h % 24 === 0) { const d = h / 24; return `${d} day${d > 1 ? 's' : ''}`; }
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// A line icon for a team tile, from the kind of help most of its topics
// give (Settings > Tickets > Help Topics), else from its name.
const AREA_ICON = {
  facilities: Building2, storageops: Warehouse, security: ShieldCheck, finance: Receipt, hr: Users, field: HardHat,
  hardware: Monitor, email: Monitor, files: Monitor, network: Monitor, collab: Monitor, tasks: Monitor,
};
function deptIcon(name) {
  const votes = new Map();
  for (const tp of helpGroupFor(name)?.topics || []) {
    const icon = AREA_ICON[tp.area];
    if (icon) votes.set(icon, (votes.get(icon) || 0) + 1);
  }
  if (votes.size) return [...votes].sort((a, b) => b[1] - a[1])[0][0];
  const n = String(name || '').toLowerCase();
  if (/\bit\b|tech|computer|software/.test(n)) return Monitor;
  if (/build|facilit|mainten|property/.test(n)) return Building2;
  if (/\bhr\b|people|human/.test(n)) return Users;
  if (/financ|account|payable|payroll/.test(n)) return Receipt;
  if (/secur/.test(n)) return ShieldCheck;
  if (/field|construct/.test(n)) return HardHat;
  if (/storage|warehouse/.test(n)) return Warehouse;
  if (/admin|office/.test(n)) return Briefcase;
  return LifeBuoy;
}

// Copies the ticket's link (the same /support?ticket= link its emails carry -
// Support opens it for anyone the ticket is shared with) and says so.
function CopyLinkButton({ link }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" style={{ ...btn('outline'), display: 'inline-flex', alignItems: 'center', gap: 7 }}
      onClick={() => { navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {}); }}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? 'Link Copied' : 'Copy Link'}
    </button>
  );
}
