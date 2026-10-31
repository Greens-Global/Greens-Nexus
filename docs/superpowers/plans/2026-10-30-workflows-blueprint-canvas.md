# Workflows Blueprint Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workflow builder gets a graph-paper canvas view of the same definition: computed layout, SVG connectors with insert points, drag and drop between lanes, a right-hand inspector hosting the existing step controls, run replay, and silhouette thumbnails on the Workflows list and Templates.

**Architecture:** A pure layout engine (`workflows/canvas/layout.js`) turns the definition's lane tree into nodes, edges, frames and insert points in world pixels. `Canvas.jsx` renders them (divs for nodes, one SVG for ink), owns pan / zoom / drag with pointer events and FLIP relayout, and reports edits as new definitions through the existing `insertAt` / `removeAt` helpers. Builder.jsx hosts it behind a Canvas / Recipe toggle; the inspector reuses StepCard's `Editor`. Nothing about the stored definition changes; the list endpoint gains one compact `shape` field for thumbnails.

**Tech Stack:** React 19, plain SVG + Pointer Events + WAAPI (no canvas library), vitest + testing-library, FastAPI for the one-field addition.

**Spec:** the approved mockup https://claude.ai/artifact/DNVzU9aSAK3bcJEHHgDB8m (decisions 10/30/2026: Paper skin default with a Night toggle; Canvas default on desktop, Recipe one click away, remembered per person, phones always Recipe; all three phases in one PR). The design doc `docs/superpowers/specs/2026-10-28-workflows-design.md` gets a note that the "no node canvas" non-goal is reversed by this decision.

## Global Constraints

- American English, Title Case for titles / buttons / labels, sentence case for hints; MM/DD/YYYY via `lib/datetime.js`; no em dashes in copy.
- Motion: only `transform` / `opacity`; durations from `--dur-xs/sm/md/lg`, easing `var(--ease-out)`; the one spring is `cubic-bezier(.34,1.4,.64,1)` for drops / snap-back; respect `prefers-reduced-motion` (use `useReducedMotion` from `lib/motion.js`); the only infinite animation is the trigger's "listening" ring while the workflow is Active.
- No new dependency. The canvas files load inside the Builder's existing lazy chunk (Builder is already `lazy()` in WorkflowsApp); bundle budget stays under 16200 KB (`npm run build` runs the check).
- Shared files append only: `frontend/src/api.js`, `backend/models.py` (not touched), `style.css` (new rules appended in one block).
- Never render blank: the canvas sits inside the Builder's `AsyncSection`; a layout error falls back to the recipe with a notice (wrap `layout()` in try/catch in Canvas).
- Existing tests keep passing: `Builder.test.jsx` tests drive the recipe, so its `beforeEach` sets `localStorage.setItem('wf-builder-view', 'recipe')`.
- jsdom has no `getTotalLength`, `getBoundingClientRect` returns zeros: every DOM measurement in Canvas is guarded (`typeof el.getTotalLength === 'function'`, fall back to width 0).
- Keyboard: every node is `tabIndex=0` with `role="button"` and an `aria-label` of its sentence; Enter / Space opens it; Escape closes the inspector.

## Review Focus

1. Dropping a branch node into its own lane (an If dragged onto its Then connector) must be refused: `canDrop(dragged, hot)` returns false when the hot's lane is inside the dragged subtree. Test in `layout.test.js` (`laneInside`).
2. A lane that ends in Stop has no join and no trailing insert point; a branch whose lanes ALL end in Stop has no exit, and the next root step is unreachable - the layout still draws it (below the branch, no edge in) and the Publish problems list already says so. Test: `layout()` of such a definition has no `join-*` node.
3. Skipped steps (`enabled === false`) render at 60% opacity with the sentence struck, and the replay walker steps over them without lighting them. Test in `replay.test.js`.
4. Pan / zoom must never leave the sheet off screen: Fit always recenters; zoom clamps to [0.3, 2]. Test the clamp in `viewport.test.js`.
5. A run whose steps do not match the current draft (edited since the run) must not crash the replay: unknown `stepId`s are skipped, and a note "This run used version N" shows. Test in `replay.test.js`.

---

### Task 1: Layout engine (pure)

**Files:**
- Create: `frontend/src/workflows/canvas/layout.js`
- Test: `frontend/src/workflows/canvas/layout.test.js`

**Interfaces:**
- Consumes: the definition shape from `lib/definition.js` (`steps`, `then` / `else`, `branches`, `steps` of a For Each, `settings.faultSteps`, `enabled`), `lanesOf(step)` for approval branch keys.
- Produces:
  ```js
  export const NODE_W = 264, NODE_H = 68, STOP_W = 160, V_GAP = 64, H_GAP = 48, JOIN_R = 6, GHOST_H = 44, FRAME_PAD = 24;
  /** @returns {{ nodes: Node[], edges: Edge[], frames: Frame[], hots: Hot[], w: number, h: number }} */
  export function layout(definition, { catalog } = {});
  // Node: { id, kind: 'trigger'|'gate'|'action'|'if'|'approval'|'wait'|'for_each'|'stop'|'join'|'ghost'|'fault', x, y, w, h, step?, path?: LanePath, index?: number }
  // Edge: { id, d, from, to, label?, dashed?, a: {x,y}, b: {x,y} }
  // Frame: { id, x, y, w, h, label }        // For Each loop frame
  // Hot:  { id, x, y, edge, insert: { path: LanePath, index } }   // an insert point
  // LanePath = the lane's address from the definition root, as lib/definition.js describes it:
  //   ['steps'] | ['steps', 2, 'then'] | ['steps', 0, 'branches', 'Approve'] | ['steps', 1, 'steps'] | ['settings', 'faultSteps']
  export function laneAt(definition, path);              // the array a LanePath names
  export function laneInside(definition, path, stepId);  // true when the lane at `path` is inside the step with `stepId` (its own lanes, recursively)
  export function replaceLane(definition, path, nextArray); // a new definition with that lane swapped (immutable)
  export function walkOrder(definition, pick = () => 0);  // node ids a run visits, in order: trigger, gate (when conditions exist), steps; at a branch `pick(step)` returns the lane index to follow (default the first); For Each descends once, then its frame id; a branch that rejoins ends with `join-<id>`; stops at Stop; skips `enabled === false`
  export function bezierPoint(a, b, t);                  // point on the edge's cubic at t
  ```
- Layout rules (from the mockup): trigger at the top, then the gate node when `conditions.length > 0`, then the root lane; If / Else fans Then left and Else right; an approval has one lane per `lanesOf(step)` key; branch lanes rejoin at a `join-<stepId>` dot when any lane is open; For Each draws its lane inside a dashed frame `frame-<stepId>` labeled LOOP and exits at the frame's bottom; Stop (`STOP_W` wide) closes a lane; an empty lane shows a `ghost-<pathKey>` node of `GHOST_H`. Every edge between two steps of one lane, from a branch node into each lane, and from a lane's end to its join / frame bottom carries ONE hot whose `insert` is where a dropped step lands. The root lane's open end gets a dashed 40px tail edge with a hot at `['steps'].length`. The fault lane (`settings.faultSteps`) sits 120px right of the main tree under a dashed `fault` header node. Coordinates are shifted so the minimum is (60, 60); `w` / `h` are the sheet's size.

- [ ] **Step 1: Write the failing tests** (`layout.test.js`): `layout(empty)` has a trigger node and a ghost with a hot at `['steps'], 0`; the HR example (copy the mockup's: 1 action, approval with two lanes [3 steps / action + stop], for_each with 1 step, 1 action) yields 1 join, 1 frame, no join for a branch whose lanes all end in Stop; `laneInside` is true for the If's own `then` path and false for a sibling; `replaceLane` leaves the input untouched; `walkOrder` follows lane 0, skips a disabled step, stops at Stop; `bezierPoint(a, b, .5)` is the midpoint.
- [ ] **Step 2: Run** `npx vitest run src/workflows/canvas/layout.test.js` - FAIL (module missing).
- [ ] **Step 3: Implement** `layout.js` by porting the mockup's `layout()` (measure then place, recursive) to the real definition shape and LanePaths.
- [ ] **Step 4: Run the test** - PASS.
- [ ] **Step 5: Commit** `feat(workflows): canvas layout engine`.

### Task 2: Canvas styles and viewport

**Files:**
- Create: `frontend/src/workflows/canvas/canvas.css` (imported by Canvas.jsx)
- Create: `frontend/src/workflows/canvas/viewport.js`
- Test: `frontend/src/workflows/canvas/viewport.test.js`

**Interfaces:**
- `viewport.js`: `export const MIN_ZOOM = 0.3, MAX_ZOOM = 2; export function zoomAt(view, factor, px, py)`, `export function fitView(view, sheet, box, pad = 40)`, `export function openingView(sheet, box, triggerNode, scale = 0.85)` (centered on the trigger column, y = 28), `export function toWorld(view, box, cx, cy)`, `export function toScreen(view, box, wx, wy)`. `view = { x, y, s }`, `box = { left, top, width, height }`.
- `canvas.css`: all canvas rules under `.wfc` with skin tokens on `.wfc[data-skin="paper"]` (default) and `.wfc[data-skin="night"]` exactly as the mockup's `--cv-*` set; node, edge, hot, ghost, frame, join, dock, inspector, zoom controls, minimap, hintbar classes copied from the mockup with the `--cv-` prefix kept; `@media (prefers-reduced-motion: reduce)` turns the animations off. The grid is the four-layer `linear-gradient` background on `.wfc-sheet`; `background-size` / `background-position` are set from the view by Canvas.

- [ ] **Step 1: Tests** for `zoomAt` clamping, `fitView` centering, `toWorld(toScreen(p)) === p`.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** `feat(workflows): canvas viewport math and skins`.

### Task 3: Canvas component (read, select, pan, zoom, minimap)

**Files:**
- Create: `frontend/src/workflows/canvas/Canvas.jsx`, `CanvasNode.jsx`, `Minimap.jsx`, `useCanvasView.js`
- Modify: `frontend/src/workflows/builder/StepCard.jsx` (export `Editor`; add prop `lanes = true` - when false the `<Lane>` blocks are not rendered, the canvas shows them)
- Test: `frontend/src/workflows/canvas/Canvas.test.jsx`

**Interfaces:**
- ```jsx
  <Canvas definition catalog ctx skin onSkin selectedId onSelect onChange   // onChange(nextDefinition)
          canEdit replay /* { order: string[], statusById: Record<id,'done'|'waiting'|'failed'|'skipped'>, note?: string } | null */
          onReplayDone />
  ```
- `CanvasNode` draws one node: icon tile colored by kind (`if` purple, `approval` indigo, `wait` orange, `for_each` teal, `stop` slate) or by module for actions / trigger (`MODULE_COLOR` map in `canvas/palette.js`: core slate, hr purple, tasks blue, tickets orange, time green, shifts teal, items gold, approvals indigo), a mono kind label (`Action · Tasks`), the sentence from `describeStep(step, catalog)` / `describeTrigger` / the conditions summary, a status dot. Trigger: rounded left end, `listening` class when `workflowStatus === 'active'`. Gate: the chevron clip-path. Stop: pill. Fault header: dashed. Ghost: dashed "Drop a step here". Skipped: 60% opacity, struck sentence.
- Opening view: `openingView` (reading size, top of the flow); Fit button recenters; `⌘`/Ctrl + wheel zooms at the pointer, plain wheel pans; drag on the sheet pans; `+` / `-` buttons zoom at center; the percentage is shown. Minimap (172 x 112) shows node rects and the viewport box; hidden under 640px (phones never show the canvas anyway).
- Entering: nodes rise 10px over `--dur-md`, 30ms apart; edges draw in with stroke-dashoffset (guard `getTotalLength`). Disabled under reduced motion and when `import.meta.env.MODE === 'test'`.

- [ ] **Step 1: Tests**: renders a node per step with its sentence as the accessible name; clicking a node calls `onSelect(id)`; Fit / zoom buttons change the percentage text; the sheet has `data-skin="paper"` by default and `night` when passed.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** `feat(workflows): canvas view with pan, zoom and minimap`.

### Task 4: Inspector, dock, drag and drop

**Files:**
- Create: `frontend/src/workflows/canvas/Inspector.jsx`, `Dock.jsx`, `useDragDrop.js`
- Modify: `frontend/src/workflows/canvas/Canvas.jsx`
- Test: `frontend/src/workflows/canvas/dragdrop.test.jsx`

**Interfaces:**
- `Inspector`: a 316px glass panel on the canvas's right, slides in over `--dur-lg`. Header: kind icon, kind label, "Step N" / "When this happens" / "Only run when"; body: for the trigger the existing `TriggerCard` contents, for the gate `ConditionsCard` contents, for a step `Editor` from StepCard with `lanes={false}`; footer: Skip / Include toggle (`toggleAt`), Remove (`removeAt`), Move Up / Move Down (`moveAt`) for a step. Props: `{ definition, catalog, ctx, selectedId, onChange, onClose, canEdit }`. Escape closes.
- `Dock`: the left 196px column with the six blocks (`STEP_KINDS` from `lib/definition.js`, icons from `STEP_ICONS`); each block starts a palette drag; a tap (no movement) on a block appends it to the root lane. New steps come from the same factory `AddStepMenu` uses (find it there - export it as `newStep(kind, catalog)` if it is inline).
- `useDragDrop({ layoutRef, viewRef, boxRef, onInsert, onMove, canDrop })`: pointer handlers for node drags and palette drags; threshold 5px before a drag starts; the lifted node follows the pointer with `rotate(1.5deg)`; the nearest hot within 40 screen px is armed (`.armed`, its edge `.hot`, an empty lane's ghost `.armed`); release on a hot calls `onMove(stepId, fromPath, fromIndex, toPath, toIndex)` / `onInsert(kind, toPath, toIndex)`, else the node springs back. `canDrop` refuses a hot whose lane is inside the dragged step (`laneInside`) and the dragged step's own two neighboring hots.
- Relayout after an edit is FLIP: old positions by id, `el.animate(translate old -> new, 380ms spring)`; new nodes rise in; moved edges morph `d` via WAAPI in a try/catch.
- Clicking a hot inserts an Action there (same as the mockup).

- [ ] **Step 1: Tests**: pointer down + move + up from a dock block over the first hot inserts a step (definition passed to `onChange` has one more root step); dragging a step onto its own lane's hot calls nothing; dropping a step into the Else lane moves it (`then` loses it, `else` gains it); the inspector shows the Editor's controls for the selected step and Remove deletes it. Mock `getBoundingClientRect` on the sheet to a 1000 x 700 box so hots have screen positions.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** `feat(workflows): canvas drag and drop, dock and inspector`.

### Task 5: Builder integration

**Files:**
- Create: `frontend/src/workflows/canvas/prefs.js` (`builderView()` / `setBuilderView(v)`, `canvasSkin()` / `setCanvasSkin(s)`; localStorage keys `wf-builder-view`, `wf-canvas-skin`; try/catch; defaults `'canvas'` and `'paper'`)
- Modify: `frontend/src/workflows/Builder.jsx`, `frontend/src/workflows/Builder.test.jsx` (beforeEach sets the recipe view)
- Test: `frontend/src/workflows/BuilderCanvas.test.jsx`

**Interfaces:**
- Top bar gains a segmented control `Canvas | Recipe` (`role="group"`, `aria-pressed`), hidden on phones (`useIsMobile` true forces the recipe), and on the canvas a `Paper | Night` control. The choice is saved with `prefs.js`.
- In canvas view the grid becomes: the canvas takes the full width (the rail's Settings / Test / Versions move into the inspector as a fourth state when nothing is selected: tabs Settings, Test, Versions at the inspector's top, so the right column is the one panel). In recipe view nothing changes from today.
- Template blanks: the outlined steps carry `data-blank` on their canvas nodes (dashed accent border), and the "Fill in:" note shows above the canvas as it does above the recipe.
- `DescribeIt` shows as a floating card on the empty sheet when `stepCount === 0 && canEdit`.
- Builder passes `replay` (Task 6) and clears it on `onReplayDone`.

- [ ] **Step 1: Tests**: on desktop the builder opens on the canvas (a node with the trigger sentence is in the document, the recipe "Do" section is not); clicking Recipe shows the "Do" section and saves `wf-builder-view=recipe`; with `wf-builder-view=recipe` stored the recipe opens; on a phone (mock `matchMedia` to match) the toggle is absent and the recipe shows.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run src/workflows` - PASS, including the existing Builder tests.
- [ ] **Step 5: Commit** `feat(workflows): canvas is the builder's default view`.

### Task 6: Run replay

**Files:**
- Create: `frontend/src/workflows/canvas/replay.js`, `useReplay.js`
- Modify: `frontend/src/workflows/lib/sub.js` (`wf:<id>:run:<runId>` parses to `{ screen: 'builder', id, runId }`; `buildSub('builder', id, runId)`), `RunDrawer.jsx` (button "Replay On Canvas" -> `go(buildSub('builder', run.workflowId, run.id))`), `builder/RailTest.jsx` (after a test, "Replay On Canvas" plays the test's steps), `Builder.jsx` (loads `api.wfRunGet(runId)` when the sub carries one and builds the replay)
- Test: `frontend/src/workflows/canvas/replay.test.js`, `frontend/src/workflows/lib/sub.test.js` (extend)

**Interfaces:**
- `replayPlan(definition, run)` -> `{ order: string[], statusById, note }`: `order` is `walkOrder(definition, pick)` where `pick` follows the lane the run actually took (an approval step's `output.option` / `output.decision` when present, else the first), cut off after the last step the run reached; `statusById[stepId]` from `run.steps[].status` mapped `done|succeeded -> 'done'`, `waiting|retry -> 'waiting'`, `failed -> 'failed'`, `skipped -> 'skipped'`, `planned -> 'done'` (a test run); unknown stepIds are dropped and `note = 'This run used version N'` when `run.version` differs from the workflow's.
- `useReplay(replay, { reduced })` drives the classes: for each id in order, the edge from the previous id gets `.live` for 420ms then `.hot`; the node gets `.waitlit` for 1100ms when its status is waiting, `.lit` (green) when done, `.failed` (red ring) when failed and the sequence stops there with the inspector opened on that step; after the last, hold 2.6s then clear and call `onReplayDone`. Under reduced motion every class is applied at once with no timers.
- Builder shows a small bar over the canvas while replaying: "Replaying run from <formatDateTime(run.startedAt)> · <status>" with a Stop button.

- [ ] **Step 1: Tests**: `replayPlan` follows the Decline lane when the output says so, drops unknown ids, flags the version; `parseSub('wf:w1:run:r9')`.
- [ ] **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** - PASS.
- [ ] **Step 5: Commit** `feat(workflows): replay a run on the canvas`.

### Task 7: Thumbnails on the list and Templates

**Files:**
- Modify: `backend/workflows/store.py` (`serialize_workflow` list row gains `"shape": shape_of(definition)`), `backend/workflows/templates.py` or the `/templates` route (`shape` on each template), `backend/test_workflows_api.py` (one test: the list row's `shape` for a two-step draft is `[["action"],["if",[["action"],[]]]]`-style)
- Create: `frontend/src/workflows/canvas/shape.js` (`shapeOf(definition)` mirrors the Python; `definitionFromShape(shape)` builds a minimal definition for `layout()`), `Thumbnail.jsx` (an SVG of the layout at `preserveAspectRatio="xMidYMid meet"`: rounded node rects filled with the kind / module color (module unknown from a shape: use the kind color, actions slate), edges as 3px strokes, joins as dots; the fault lane left out)
- Modify: `frontend/src/workflows/WorkflowList.jsx` (a 56 x 36 thumbnail cell before the name on desktop rows, 72 x 48 on phone cards), `Templates.jsx` (a 100% x 110 thumbnail at each card's top)
- Test: `frontend/src/workflows/canvas/shape.test.js`, extend `WorkflowList.test.jsx` / `Templates.test.jsx` for the presence of `[data-testid="wf-thumb"]`

**Interfaces:**
- `shape` grammar (both languages): a lane is a list; each step is `[kind]` or `[kind, [lane, lane, ...]]` for `if` (two lanes), `approval` (one per branch key, in `lanesOf` order), `for_each` (one lane). Kinds are the six step kinds. Nothing else travels (no titles, no params).
- `shape_of(definition) -> list` in `store.py`, pure, with a docstring saying the frontend mirrors it in `canvas/shape.js`.

- [ ] **Step 1: Tests** both sides. **Step 2: Run** - FAIL. **Step 3: Implement.** **Step 4: Run** `python -m pytest backend/test_workflows_api.py -q` and `npx vitest run src/workflows` - PASS.
- [ ] **Step 5: Commit** `feat(workflows): silhouette thumbnails on the list and templates`.

### Task 8: Docs, lint, build

**Files:**
- Modify: `docs/superpowers/specs/2026-10-28-workflows-design.md` (under Non-goals: "A node canvas - REVERSED 10/30/2026 (Neil): the Blueprint canvas, plan `docs/superpowers/plans/2026-10-30-workflows-blueprint-canvas.md`; the recipe stays as the second view and the phone view."), `CLAUDE.md` Workflows paragraph (one sentence: the builder's canvas is a computed layout of the definition - `workflows/canvas/layout.js`; never store node coordinates).

- [ ] **Step 1:** `cd frontend && npm run lint && npx vitest run src/workflows && npm run build` - all green, the bundle check passes.
- [ ] **Step 2:** `ruff check backend/` and `python -m pytest backend/test_workflows_api.py -q`.
- [ ] **Step 3: Commit** `docs(workflows): canvas reverses the no-canvas non-goal`.
