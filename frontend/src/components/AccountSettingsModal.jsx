import { useState, useEffect, useCallback } from "react";
import { X, Settings, Check, AlertTriangle } from "lucide-react";
import { api } from "../api";

// Per-user settings (Jul 2026). Today it holds one thing - the personal Asana
// connection - but it's the home for anything else that belongs to the signed-in
// user rather than to the workspace (Manage -> Asana Sync is the admin surface
// and stays separate).
//
// Why a personal Asana grant exists at all: Asana attributes a story to whoever
// owns the token that posted it and offers no impersonation parameter, so a
// comment written in Nexus shows up under the shared service account unless the
// author has connected their own Asana. See backend/asana_oauth.py.
export default function AccountSettingsModal({ onClose, initialResult = "", initialReason = "" }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  // Result of the live "would this actually post as me" probe. Null until asked.
  const [check, setCheck] = useState(null);
  const [coverage, setCoverage] = useState(null);   // "is everything Asana assigns me in Nexus?"
  const [rescue, setRescue] = useState(null);       // result of "Bring These Into Nexus"
  const [error, setError] = useState(initialReason || "");
  // "connected" | "denied" | "error" - set when we've just come back from
  // Asana's consent screen, so the outcome is visible rather than silent.
  const [result, setResult] = useState(initialResult);

  const load = useCallback(() => {
    api.asanaOauthStatus()
      .then(setStatus)
      .catch(() => setError("Couldn't load your integration settings."));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy("connect"); setError(""); setResult("");
    try {
      const res = await api.asanaOauthStart();
      if (!res.url) { setError(res.error || "Connecting isn't available here."); return; }
      // Full navigation, not a popup: Asana's consent screen refuses to render
      // in a frame, and a popup would be blocked as often as not.
      window.location.href = res.url;
    } catch (e) {
      setError(e?.message || "Couldn't start the Asana connection.");
    } finally { setBusy(""); }
  }

  async function runCoverage() {
    setBusy('coverage'); setError(''); setCoverage(null); setRescue(null);
    try { setCoverage(await api.asanaOauthCoverage()); }
    catch (e) { setError(e.message || 'Could not count your Asana tasks.'); }
    finally { setBusy(''); }
  }

  // Pull the missing ones in through my own grant, then recount so the list
  // shrinks in front of the person rather than asking them to trust a number.
  async function runRescue() {
    setBusy('rescue'); setError(''); setRescue(null);
    try {
      const r = await api.asanaOauthRescue();
      setRescue(r);
      if (r?.ok) setCoverage(await api.asanaOauthCoverage());
    } catch (e) { setError(e.message || 'Could not bring the tasks in.'); }
    finally { setBusy(''); }
  }

  async function runCheck() {
    setBusy("check"); setError(""); setCheck(null);
    try {
      setCheck(await api.asanaOauthCheck());
    } catch (e) {
      setError(e?.message || "Couldn't test the Asana connection.");
    } finally { setBusy(""); }
  }

  async function disconnect() {
    setBusy("disconnect"); setError(""); setResult("");
    try {
      await api.asanaOauthDisconnect();
      setCheck(null);
      load();
    } catch (e) {
      setError(e?.message || "Couldn't disconnect.");
    } finally { setBusy(""); }
  }

  const connected = !!status?.connected;
  const configured = !!status?.configured;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: 460, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings size={16} style={{ color: 'var(--muted)' }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>Account Settings</span>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', fontFamily: 'Inter, sans-serif' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10 }}>
            Integrations
          </div>

          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)' }}>Asana account</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
                  {connected
                    ? <>Comments you post in Nexus appear in Asana as <strong style={{ color: 'var(--ink)' }}>{status.asanaName || status.asanaEmail || 'you'}</strong>.</>
                    : 'Connect your Asana account so comments you post in Nexus appear in Asana under your name instead of the shared sync account.'}
                </div>
              </div>
              {status && (
                connected ? (
                  <button onClick={disconnect} disabled={!!busy}
                    style={{ flexShrink: 0, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer', color: 'var(--ink)', fontFamily: 'inherit' }}>
                    {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                ) : (
                  <button onClick={connect} disabled={!!busy || !configured}
                    title={configured ? '' : status.notConfiguredReason}
                    style={{ flexShrink: 0, background: configured ? 'var(--pine)' : 'var(--line)', color: configured ? '#fff' : 'var(--muted)', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: (busy || !configured) ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                    {busy === 'connect' ? 'Opening Asana…' : 'Connect'}
                  </button>
                )
              )}
            </div>

            {connected && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: 'hsl(var(--color-green, 145 60% 36%))' }}>
                <Check size={13} /> Connected{status.asanaEmail ? ` as ${status.asanaEmail}` : ''}
              </div>
            )}

            {/* Connected is not the same as working. A grant whose vault key
                changed still reports connected while every comment posts as the
                shared account - so if a push has already failed, say so here
                rather than waiting for someone to press Test connection. */}
            {connected && status.lastError && !check?.willPostAsMe && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 12, lineHeight: 1.5, color: 'hsl(var(--color-amber, 38 92% 40%))' }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Your last comment did not post as you - {status.lastError}</span>
              </div>
            )}

            {/* "Connected" only means a grant is stored. Posting can still fall
                back to the shared account - a revoked grant, or one with no
                access to the project the task lives in - and the fallback is
                deliberately silent so a comment is never lost. This asks Asana
                what would actually happen. */}
            {connected && (
              <div style={{ marginTop: 10 }}>
                <button onClick={runCheck} disabled={!!busy}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', color: 'var(--ink)', fontFamily: 'inherit' }}>
                  {busy === 'check' ? 'Checking…' : 'Test connection'}
                </button>
                {check && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 12, lineHeight: 1.5,
                    color: (check.willPostAsMe && !check.partial) ? 'hsl(var(--color-green, 145 60% 36%))' : 'hsl(var(--color-amber, 38 92% 40%))' }}>
                    {(check.willPostAsMe && !check.partial) ? <Check size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                                        : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
                    <span>
                      {check.willPostAsMe && !check.partial
                        ? <>Working. Your comments post as <strong>{check.asanaName || check.asanaEmail}</strong>.</>
                        : check.partial
                          ? <>Partly working - {check.reason}</>
                          : <>Your comments are posting as{check.serviceAccountName ? <> <strong>{check.serviceAccountName}</strong></> : ' the shared sync account'} - {check.reason || 'reason unknown'}.</>}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* "Did all my Asana tasks make it?" - answered with the person's OWN
                grant, the only credential that sees their private (Only me)
                tasks. Lists whatever is missing with the reason, so it is
                actionable rather than just a number. */}
            {connected && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, minWidth: 0 }}>
                    Check that every Asana task assigned to you is in Nexus - including private ones only your account can see.
                  </div>
                  <button onClick={runCoverage} disabled={!!busy}
                    style={{ flexShrink: 0, background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', color: 'var(--ink)', fontFamily: 'inherit' }}>
                    {busy === 'coverage' ? 'Counting…' : 'Check My Asana Coverage'}
                  </button>
                </div>
                {busy === 'coverage' && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>Asking Asana for your full task list - this can take a minute for a few hundred tasks.</div>
                )}
                {coverage && !coverage.ok && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 12, lineHeight: 1.5, color: 'hsl(var(--color-amber, 38 92% 40%))' }}>
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} /><span>{coverage.reason || 'Could not count.'}</span>
                  </div>
                )}
                {coverage && coverage.ok && (
                  <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: coverage.missing === 0 ? 'hsl(var(--color-green, 145 60% 36%))' : 'var(--ink)' }}>
                      {coverage.missing === 0 ? <Check size={13} style={{ flexShrink: 0, marginTop: 3 }} /> : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 3, color: 'hsl(var(--color-amber, 38 92% 40%))' }} />}
                      <span>
                        Asana assigns you <strong>{coverage.asanaTotal}</strong> tasks ({coverage.asanaOpen} open). In Nexus: <strong>{coverage.inNexus}</strong> ({coverage.inNexusOpen} open).
                        {coverage.missing === 0
                          ? ' Everything is in.'
                          : <> Not in Nexus: <strong>{coverage.missing}</strong> ({coverage.missingOpen} open).</>}
                      </span>
                    </div>
                    {coverage.missing > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                        <button onClick={runRescue} disabled={!!busy}
                          style={{ background: 'var(--pine)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
                          {busy === 'rescue' ? 'Bringing them in…' : `Bring These ${coverage.missing} Into Nexus`}
                        </button>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Uses your Asana account. Tasks from archived or unimported projects land as personal tasks tagged with the project name.</span>
                      </div>
                    )}
                    {rescue && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 12, lineHeight: 1.5, color: rescue.ok ? 'hsl(var(--color-green, 145 60% 36%))' : 'hsl(var(--color-amber, 38 92% 40%))' }}>
                        {rescue.ok ? <Check size={13} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
                        <span>{rescue.ok
                          ? <>Brought in <strong>{rescue.created}</strong> task(s){rescue.comments ? ` with ${rescue.comments} comment(s)` : ''}{rescue.attachments ? ` and ${rescue.attachments} attachment(s)` : ''}. Reload the Tasks screen to see them.</>
                          : (rescue.reason || 'Could not bring the tasks in.')}</span>
                      </div>
                    )}
                    {coverage.missing > 0 && (
                      <div style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
                        {coverage.missingTasks.map((m) => (
                          <div key={m.gid} style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                              <span style={{ fontWeight: 600, color: m.completed ? 'var(--muted)' : 'var(--ink)', textDecoration: m.completed ? 'line-through' : 'none', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</span>
                              {m.dueOn && <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{m.dueOn}</span>}
                            </div>
                            <div style={{ color: 'var(--muted)' }}>{m.projects.length ? m.projects.join(', ') + ' - ' : ''}{m.reason}</div>
                          </div>
                        ))}
                        {coverage.missing > coverage.missingTasks.length && (
                          <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--muted)' }}>and {coverage.missing - coverage.missingTasks.length} more</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {status && !configured && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{status.notConfiguredReason}</span>
              </div>
            )}
          </div>

          {result === 'connected' && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'hsl(var(--color-green, 145 60% 36%))' }}>
              Your Asana account is connected.
            </div>
          )}
          {result === 'denied' && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>
              Connection cancelled - nothing changed.
            </div>
          )}
          {error && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'hsl(var(--color-red, 0 65% 51%))' }}>{error}</div>
          )}
          {!status && !error && (
            <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
          )}
        </div>
      </div>
    </div>
  );
}
