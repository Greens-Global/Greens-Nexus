// Version B world for the Time module (11/03/2026 exploration): the .tob
// scope carries its own palette and remaps the house variables inside it,
// so every component rendered under it inherits the world. Injected once
// by TimeAdmin; TimeOffDesk only uses the class names.
export const TOB_CSS = `
.tob { --tob-ink:#16242e; --tob-dim:#5b6b74; --tob-faint:#8fa0a8; --tob-line:#e3e8e6; --tob-paper:#f7faf8;
  --tob-card:#ffffff; --tob-accent:#1f7a43; --tob-wash:#e9f4ec; --tob-red:#b3261e; --tob-amber:#9a6700;
  color: var(--tob-ink); }
/* The sections that reuse existing components (Calendar, Balances,
   Delegations, History) inherit this world through the house variables:
   remapped inside .tob only, so one palette runs through every section. */
/* Payroll's person panel joins the world: a flat rail against a hairline,
   not a floating box (the Time Off rail is the pattern). */
.tob .pr-sidebar { border: none !important; border-right: 1px solid var(--tob-line) !important;
  border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
.tob { --card: var(--tob-card); --ink: var(--tob-ink); --muted: var(--tob-dim); --line: var(--tob-line);
  --mist: var(--tob-paper); --wk-line: var(--tob-line); --wk-line2: var(--tob-line); --wk-brand: var(--tob-accent);
  --wk-brand-tint: var(--tob-wash); --wk-hover: var(--tob-paper); --wk-dim: var(--tob-dim);
  --wk-faint: var(--tob-faint); --wk-ink: var(--tob-ink); --wk-card: var(--tob-card); --wk-shadow: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .tob {
  --tob-ink:#e8efea; --tob-dim:#9db0a6; --tob-faint:#6d8077; --tob-line:#27332d; --tob-paper:#121a16;
  --tob-card:#182219; --tob-accent:#4cc27e; --tob-wash:#1b3326; --tob-red:#ff8a80; --tob-amber:#e2b93b; } }
.tob-shell { display:grid; grid-template-columns: 172px 1fr; gap: 20px; align-items: start; }
.tob-rail { display:flex; flex-direction:column; gap:2px; position:sticky; top:12px; }
.tob-rail button { display:flex; align-items:center; gap:9px; width:100%; padding:9px 12px; border:none; cursor:pointer;
  background:none; border-radius:9px; font: 600 13px/1.3 inherit; font-family:inherit; color:var(--tob-dim); text-align:left;
  position:relative; transition: background .14s ease-out, color .14s ease-out; }
.tob-rail button[aria-selected="true"] { background:var(--tob-wash); color:var(--tob-accent); font-weight:700; }
.tob-rail button[aria-selected="true"]::before { content:''; position:absolute; left:0; top:9px; bottom:9px; width:2.5px;
  border-radius:4px; background:var(--tob-accent); }
.tob-rail .tob-n { margin-left:auto; font-size:11px; font-weight:700; color:#fff; background:var(--tob-red);
  border-radius:20px; padding:1px 7px; font-variant-numeric:tabular-nums; }
.tob-head h2 { margin:0; font-size:24px; font-weight:700; letter-spacing:-0.015em; }
.tob-head p { margin:3px 0 0; font-size:13px; color:var(--tob-dim); }
.tob-queue { background:var(--tob-card); border:1px solid var(--tob-line); border-radius:14px; margin-top:16px; overflow:hidden; }
.tob-q-head { display:flex; align-items:baseline; gap:8px; padding:12px 18px 8px; }
.tob-q-head b { font-size:13px; font-weight:700; }
.tob-q-head span { font-size:12px; color:var(--tob-dim); }
.tob-q-row { display:flex; align-items:center; gap:12px; padding:11px 18px; border-top:1px solid var(--tob-line);
  animation: tobIn .32s cubic-bezier(.2,.7,.3,1) backwards; }
.tob-q-row.tob-out { opacity:0; transform:translateX(14px); transition: opacity .18s ease-out, transform .18s ease-out; }
.tob-ledger { background:var(--tob-card); border:1px solid var(--tob-line); border-radius:14px; margin-top:14px;
  overflow:auto; max-height:56vh; overscroll-behavior:contain; }
.tob-grid { display:grid; grid-template-columns: 190px 105px 1fr 64px 150px 120px; gap:10px; min-width:760px;
  padding:9px 18px; align-items:center; }
.tob-ledger .tob-grid + .tob-grid { border-top:1px solid var(--tob-line); }
.tob-lhead { position:sticky; top:0; z-index:1; background:var(--tob-card); box-shadow:0 1px 0 var(--tob-line);
  font-size:12px; font-weight:600; color:var(--tob-faint); letter-spacing:.01em; }
.tob-dot { display:inline-block; width:7px; height:7px; border-radius:99px; margin-right:6px; vertical-align:1px; }
.tob-chip { padding:5px 12px; border-radius:8px; border:1px solid transparent; background:none; cursor:pointer;
  font:600 13px/1.3 inherit; font-family:inherit; color:var(--tob-dim); transition: background .14s ease-out, color .14s ease-out; }
.tob-chip[aria-pressed="true"] { background:var(--tob-ink); color:var(--tob-paper); font-weight:700; }
.tob-ok { background:var(--tob-accent); color:#fff; border:none; border-radius:9px; padding:6px 14px; cursor:pointer;
  font:700 13px/1.4 inherit; font-family:inherit; display:inline-flex; align-items:center; gap:5px;
  transition: filter .14s ease-out, transform .1s ease-out; }
.tob-no { background:none; border:1px solid var(--tob-line); border-radius:9px; padding:6px 12px; cursor:pointer;
  font:600 13px/1.4 inherit; font-family:inherit; color:var(--tob-red); display:inline-flex; align-items:center; gap:5px;
  transition: border-color .14s ease-out; }
.tob input, .tob select { font-family:inherit; }
.tob-in { border:1px solid var(--tob-line); background:var(--tob-card); color:var(--tob-ink); border-radius:9px;
  padding:7px 10px; font-size:13px; }
.tob button:focus-visible, .tob input:focus-visible, .tob select:focus-visible { outline:2px solid var(--tob-accent); outline-offset:2px; }
.tob-view { animation: tobFade .18s ease-out; }
@media (hover:hover) and (pointer:fine) {
  .tob-rail button:not([aria-selected="true"]):hover { background:var(--tob-wash); color:var(--tob-ink); }
  .tob-ok:hover { filter:brightness(1.07); }
  .tob-no:hover { border-color:var(--tob-red); }
  .tob-chip:not([aria-pressed="true"]):hover { color:var(--tob-ink); }
  .tob-ledger .tob-grid:not(.tob-lhead):hover { background:var(--tob-paper); }
}
.tob-ok:active { transform:scale(.97); }
@keyframes tobIn { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:none; } }
@keyframes tobFade { from { opacity:0; } to { opacity:1; } }
/* Every click answers (11/03/2026): controls ease their colors, pressables
   dip while pressed, and each tab's header and work surface arrive with one
   short entrance - transform and opacity only, nothing loops. */
.tob button, .tob select, .tob input, .tob a {
  transition: background-color .15s ease-out, color .15s ease-out, border-color .15s ease-out,
    box-shadow .15s ease-out, opacity .15s ease-out, transform .12s ease-out; }
.tob button:not(:disabled):active { transform: scale(.96); }
.tob-head { animation: tobIn .28s cubic-bezier(.2,.7,.3,1); }
.tob-ledger { animation: tobFade .2s ease-out; }
.tob .pr-sidebar { animation: tobFade .2s ease-out; }
@media (prefers-reduced-motion: reduce) { .tob *, .tob *::before { animation:none !important; transition:none !important; } }
@media (max-width: 900px) { .tob-shell { grid-template-columns: 1fr; }
  .tob-rail { flex-direction:row; overflow-x:auto; position:static; }
  .tob-rail button[aria-selected="true"]::before { display:none; } }
`;
