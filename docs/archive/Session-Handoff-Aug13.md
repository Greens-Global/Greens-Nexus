# Session Handoff - Aug 13, 2026 (Remote Support arc)

Resume with: *"read docs/Session-Handoff-Aug13.md and continue."*
Everything below is on the `dev` branch. Safe to delete once fully done + prod-released.

## Already shipped this session (dev)
- Live view + attended remote control: fullscreen keeps controls + keyboard-lock,
  popout window, binary file transfer, one-controller-per-PC guard.
- Agent 0.8.1: WGC capturer (fixes black screen on Windows Settings).
- Employee Tracking is a grantable module (viewer = watch, full = control/admin).
- Presence badges (animated eye + viewer count + wrench = who's supporting).
- Zoom + support-PFP cursor in the main modal.
- Mobile: autoplay nudge + ICE-failure handling.
- Per-person tier override (nexus_roles.tier_pinned).
- Install one-liner uses -EncodedCommand (paste-proof).
- Bundle hosted: agent-bundle-0.8.1.zip on dev Supabase agent-dist.

## Code follow-ups (this pass) - ALL DONE
- [x] 1. Popout parity: zoom + support-PFP cursor (hide crosshair). (bb15aa6)
- [x] 2. ET viewer-grant: friendly view-only state + read-only owner. (bb15aa6)
- [x] 3. Roles: tier_pinned in GET /roles + "Override" badge in Access Manager. (647e189)
- [x] 4. Mobile: agent prefers H.264 in the offer (iOS Safari). Agent 0.8.2. (31ee719)
- [x] 5. Chrome-share screenshots labeled "Chrome share" (bonus). (bb15aa6)
- [x] Verified: npm build + backend py_compile clean each step.

Latest agent bundle: agent-bundle-0.8.2.zip (dev Supabase agent-dist), public-read OK.

## YOUR actions (not code)
- [ ] Set NEXUS_AGENT_BUNDLE_URL on dev Azure -> .../agent-dist/agent-bundle-0.8.2.zip
- [ ] Re-run the install one-liner on each PC to update the agent to 0.8.2.
- [ ] Test mobile live view again (iPhone Safari) - H.264 should fix the "connecting"
      hang; if not, tell me the exact device/browser.

## BIG remaining: PROD release (dev -> main)
- [ ] dev -> main PR + merge.
- [ ] Enable RLS on prod: live_view_sessions, agent_pairings. New columns
      (control_* on live_view_sessions, tier_pinned on nexus_roles) migrate via
      main.py's Postgres list automatically.
- [ ] Prod Azure env: 5 agent vars + 2 Cloudflare TURN vars + install/bundle/enroll vars.
- [ ] Host agent bundle + install.ps1 on PROD Supabase (no agent-dist bucket there yet);
      rotate CF TURN token.
- [ ] get_advisors after release; roll agent to PCs.

## Notes / gotchas
- Anon Supabase key can INSERT new bucket objects but NOT overwrite/delete existing
  ones -> use versioned bundle filenames (agent-bundle-X.Y.Z.zip); current.zip alias
  is stale (0.7.0) and unmaintainable via anon.
- Pre-apply new columns on the dev DB before pushing (SELECTs 500 otherwise between
  push and deploy).
