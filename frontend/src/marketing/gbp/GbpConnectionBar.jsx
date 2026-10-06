import { useState } from 'react'
import { CheckCircle2, AlertTriangle, RefreshCw, Link2, Unplug, Copy, X } from 'lucide-react'
import { formatDateTime } from '../../lib/datetime'
import { C } from '../theme'
import { useGbpPermissions, errorText, GBP_BAR } from './useGbp'

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
  border: '1px solid ' + C.gray200, fontSize: 12.5, fontWeight: 500, color: C.gray700, background: C.white, cursor: 'pointer',
}
const primaryBtn = { ...btn, border: 'none', background: C.emerald600, color: C.white }

const TONES = {
  ok: { background: C.emerald50, color: C.emerald700, border: C.emerald100 },
  warn: { background: C.amber50, color: C.amber700, border: C.amber200 },
  error: { background: C.red50, color: C.red700, border: C.red100 },
  info: { background: C.gray50, color: C.gray600, border: C.gray200 },
}

export function Notice({ kind = 'info', children, onClose }) {
  const t = TONES[kind] || TONES.info
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
      background: t.background, color: t.color, border: '1px solid ' + t.border, marginBottom: 12,
    }}>
      {kind === 'ok' ? <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}

// A Google connection (Business Profile by default, Google Ads with its own
// `config`): who is connected, when it last synced, and the admin's Connect /
// Disconnect plus everyone-with-editor Sync Now. `onSynced` lets the page
// reload its lists after a sync.
export default function GbpConnectionBar({ gbp, onSynced, config = GBP_BAR }) {
  const { isAdmin, canReply } = useGbpPermissions()
  const { status, loading, error, refresh, notice, setNotice } = gbp
  const [busy, setBusy] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [copied, setCopied] = useState(false)

  async function connect() {
    setBusy('connect')
    try {
      const out = await config.start()
      if (out?.error) { setNotice({ kind: 'error', text: out.error }); return }
      window.location.assign(out.url)
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e) })
    } finally {
      setBusy('')
    }
  }

  async function syncNow() {
    setBusy('sync')
    try {
      const out = await config.sync()
      setNotice({
        kind: 'ok',
        text: out?.skipped
          ? 'Already up to date - it synced less than a minute ago.'
          : config.syncedText(out),
      })
      onSynced?.()
      config.announce?.()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e) })
    } finally {
      setBusy('')
      refresh()
    }
  }

  async function disconnect() {
    setBusy('disconnect')
    try {
      await config.disconnect()
      setNotice({ kind: 'ok', text: config.disconnectedText })
      setConfirmDisconnect(false)
      config.announce?.()
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e) })
    } finally {
      setBusy('')
      refresh()
    }
  }

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(status.redirectUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked - the text is selectable */ }
  }

  const noticeEl = notice && (
    <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>
  )

  if (loading) return <div className="nx-skel" style={{ height: 52, borderRadius: 10, marginBottom: 12 }} />

  if (error === 'forbidden') {
    return <>{noticeEl}<Notice kind="info">{config.forbidden}</Notice></>
  }
  if (error) {
    return <>{noticeEl}<Notice kind="error">{error} <button onClick={refresh} style={{ ...btn, padding: '2px 8px', marginLeft: 6 }}>Retry</button></Notice></>
  }

  if (!status.connected) {
    return (
      <>
        {noticeEl}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px', borderRadius: 10, border: '1px dashed ' + C.gray300, background: C.gray50, marginBottom: 16,
        }}>
          <div style={{ minWidth: 0, flex: '1 1 320px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.gray900, marginBottom: 2 }}>{config.title} Is Not Connected</div>
            {status.configured ? (
              <div style={{ fontSize: 12.5, color: C.gray500 }}>
                {isAdmin
                  ? config.adminBlurb
                  : 'An administrator connects the Google account once.'}
                {' '}The figures below are sample data until then.
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: C.gray500 }}>
                {isAdmin ? status.notConfiguredReason : 'The Google connection is not set up on this server yet.'}
                {' '}The figures below are sample data until then.
                {isAdmin && status.redirectUri && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>Redirect URI for the Google OAuth client:</span>
                    <code style={{ fontSize: 11.5, padding: '2px 6px', borderRadius: 4, background: C.white, border: '1px solid ' + C.gray200, wordBreak: 'break-all' }}>{status.redirectUri}</code>
                    <button onClick={copyRedirect} style={{ ...btn, padding: '3px 8px', fontSize: 11.5 }}><Copy size={11} />{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                )}
              </div>
            )}
          </div>
          {isAdmin && status.configured && (
            <button onClick={connect} disabled={busy === 'connect'} style={{ ...primaryBtn, opacity: busy === 'connect' ? 0.7 : 1 }}>
              <Link2 size={13} />
              {busy === 'connect' ? 'Opening Google...' : 'Connect Google'}
            </button>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      {noticeEl}
      {status.needsReconnect ? (
        <Notice kind="error">
          {status.lastError}
          {isAdmin && (
            <button onClick={connect} disabled={!!busy} style={{ ...primaryBtn, padding: '4px 10px', marginLeft: 8 }}>
              <Link2 size={12} />Reconnect Google
            </button>
          )}
        </Notice>
      ) : status.lastError ? (
        <Notice kind="warn">The last sync did not finish: {status.lastError}</Notice>
      ) : null}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 10, border: '1px solid ' + C.gray200, background: C.white, marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap', fontSize: 12.5, color: C.gray500 }}>
          <CheckCircle2 size={15} style={{ color: C.emerald600, flexShrink: 0 }} />
          <span style={{ color: C.gray900, fontWeight: 500 }}>Connected to Google</span>
          <span>{status.accountLabel ? `${status.accountLabel} - ` : ''}{status.accountEmail}</span>
          <span>&middot; {config.countText(status)}</span>
          <span>&middot; Last synced {formatDateTime(status.lastSyncAt, 'never')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canReply && (
            <button onClick={syncNow} disabled={!!busy} style={{ ...btn, opacity: busy === 'sync' ? 0.7 : 1 }}>
              <RefreshCw size={13} />
              {busy === 'sync' ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
          {isAdmin && !confirmDisconnect && (
            <button onClick={() => setConfirmDisconnect(true)} disabled={!!busy} style={btn}>
              <Unplug size={13} />Disconnect
            </button>
          )}
          {isAdmin && confirmDisconnect && (
            <>
              <span style={{ fontSize: 12, color: C.gray500 }}>Stop syncing from Google?</span>
              <button onClick={disconnect} disabled={!!busy} style={{ ...btn, border: 'none', background: C.red600, color: C.white }}>
                {busy === 'disconnect' ? 'Disconnecting...' : 'Confirm Disconnect'}
              </button>
              <button onClick={() => setConfirmDisconnect(false)} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </>
  )
}
