import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { MapPin, Pencil, History, Copy, ExternalLink, QrCode, Download, Plus, Trash2, Building2 } from 'lucide-react'
import { api } from '../../api'
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState'
import { formatDate, formatDateTime } from '../../lib/datetime'
import Modal from '../shared/Modal'
import StarRating from '../shared/StarRating'
import { FACILITIES } from '../shared/facilities'
import { C } from '../theme'
import { errorText } from './useGbp'
import { DAY_LABEL, formToRegular, formToSpecial, hoursProblem, regularToForm, specialToForm } from './hours'
import { Notice } from './GbpConnectionBar'
import GooglePerformanceSection from './GooglePerformanceSection'
import GooglePostsTab from './GooglePostsTab'
import GooglePhotosTab from './GooglePhotosTab'

const DESCRIPTION_MAX = 750   // Google's limit (gbp.update_listing)

const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 6,
  border: '1px solid ' + C.gray200, fontSize: 12, fontWeight: 500, color: C.gray600, background: C.white, cursor: 'pointer',
}
const primaryBtn = { ...btn, border: 'none', background: C.emerald600, color: C.white }
const input = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 13,
  color: C.gray800, background: C.white, outline: 'none', fontFamily: 'inherit',
}
const label = { display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 4 }

const FIELD_LABEL = {
  'profile.description': 'Description', 'phoneNumbers.primaryPhone': 'Phone', websiteUri: 'Website',
  regularHours: 'Hours', specialHours: 'Holiday Hours',
}
// Posts and photos are logged in the same history, as an action not a field.
const ACTION_LABEL = {
  'post:create': 'published a post', 'post:edit': 'edited a post', 'post:delete': 'deleted a post',
  'photo:add': 'added a photo', 'photo:delete': 'removed a photo',
}
const STALE_PHOTO_DAYS = 60
const CARD_TABS = [
  { key: 'listing', label: 'Listing' },
  { key: 'posts', label: 'Posts' },
  { key: 'photos', label: 'Photos' },
]

function formatClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`
}

function HoursSummary({ location }) {
  const { days, complex, hasHours } = regularToForm(location.regularHours)
  if (!hasHours) return <span style={{ color: C.gray400 }}>No hours on Google</span>
  if (complex) return <span>Set in Google (split or overnight hours)</span>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 2 }}>
      {days.map((d) => (
        <div key={d.day} style={{ display: 'contents' }}>
          <span style={{ color: C.gray500 }}>{DAY_LABEL[d.day].slice(0, 3)}</span>
          <span>{d.closed ? 'Closed' : `${formatClock(d.open)} - ${formatClock(d.close)}`}</span>
        </div>
      ))}
    </div>
  )
}

function ReviewLink({ location }) {
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState('')
  if (!location.reviewLink) {
    return <div style={{ fontSize: 12, color: C.gray400 }}>Google has not given this location a Place ID yet, so there is no review link.</div>
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(location.reviewLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked - the link is selectable */ }
  }
  async function toggleQr() {
    if (qr) { setQr(''); return }
    setQr(await QRCode.toDataURL(location.reviewLink, { width: 480, margin: 2, errorCorrectionLevel: 'M' }))
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={copy} style={btn}><Copy size={12} />{copied ? 'Copied' : 'Copy Review Link'}</button>
        <a href={location.reviewLink} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none' }}><ExternalLink size={12} />Open</a>
        <button onClick={toggleQr} style={btn}><QrCode size={12} />{qr ? 'Hide QR Code' : 'QR Code'}</button>
      </div>
      <div style={{ fontSize: 11, color: C.gray400, marginTop: 4, wordBreak: 'break-all' }}>
        {location.reviewLink} - the same link works on an NFC tag.
      </div>
      {qr && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={qr} alt={`QR code for leaving a Google review of ${location.title}`} width={120} height={120}
               style={{ borderRadius: 6, border: '1px solid ' + C.gray200, background: '#fff' }} />
          <a href={qr} download={`review-qr-${location.key}.png`} style={{ ...btn, textDecoration: 'none' }}>
            <Download size={12} />Download PNG
          </a>
        </div>
      )}
    </div>
  )
}

function ListingHistory({ location }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.getGbpListingHistory(location.key).then(setRows).catch((e) => setErr(errorText(e)))
  }, [location.key])
  if (err) return <div role="alert" style={{ fontSize: 12, color: C.red600 }}>{err}</div>
  if (!rows) return <SkeletonBlocks count={2} height={20} borderRadius={6} />
  if (rows.length === 0) return <div style={{ fontSize: 12, color: C.gray400 }}>No listing edits have been made from Nexus yet.</div>
  return rows.map((h, i) => (
    <div key={i} style={{ fontSize: 12, color: h.ok ? C.gray600 : C.red600, padding: '3px 0' }}>
      <strong style={{ fontWeight: 500 }}>{h.byName || h.by}</strong>{' '}
      {ACTION_LABEL[h.fields[0]] || `changed ${h.fields.map((f) => FIELD_LABEL[f] || f).join(', ')}`}
      {' '}&middot; {formatDateTime(h.at)}
      {!h.ok && <> &middot; Google refused it: {h.error}</>}
    </div>
  ))
}

function EditListingModal({ location, onClose, onSaved }) {
  const regular = useMemo(() => regularToForm(location.regularHours), [location.regularHours])
  const special = useMemo(() => specialToForm(location.specialHours), [location.specialHours])
  const initial = useMemo(() => ({
    description: location.description || '', phone: location.phone || '', website: location.website || '',
    days: regular.days, holidays: special.rows,
  }), [location, regular, special])
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const changes = {}
  if (form.description.trim() !== initial.description.trim()) changes.description = form.description
  if (form.phone.trim() !== initial.phone.trim()) changes.phone = form.phone
  if (form.website.trim() !== initial.website.trim()) changes.website = form.website
  if (!regular.complex && JSON.stringify(form.days) !== JSON.stringify(initial.days)) changes.regularHours = formToRegular(form.days)
  if (!special.complex && JSON.stringify(form.holidays) !== JSON.stringify(initial.holidays)) changes.specialHours = formToSpecial(form.holidays)
  const dirty = Object.keys(changes).length > 0
  const problem = form.description.length > DESCRIPTION_MAX
    ? `Google allows up to ${DESCRIPTION_MAX} characters in the description.`
    : hoursProblem(regular.complex ? [] : form.days, special.complex ? [] : form.holidays)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setDay = (i, patch) => set('days', form.days.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const setHoliday = (i, patch) => set('holidays', form.holidays.map((h, j) => (j === i ? { ...h, ...patch } : h)))

  async function save() {
    if (!dirty || problem) return
    setSaving(true)
    setErr('')
    try {
      onSaved(await api.updateGbpListing(location.key, changes))
      onClose()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Edit Listing - ${location.title}`} onClose={onClose} isDirty={dirty} onSave={save}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Notice kind="info">Changes go to Google as soon as you save. Google may hold some edits for its own review before they show publicly.</Notice>
        <div>
          <label style={label} htmlFor="gbp-desc">Description</label>
          <textarea id="gbp-desc" rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} style={{ ...input, resize: 'vertical' }} />
          <div style={{ fontSize: 11, textAlign: 'right', color: form.description.length > DESCRIPTION_MAX ? C.red600 : C.gray400 }}>
            {form.description.length} / {DESCRIPTION_MAX}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div>
            <label style={label} htmlFor="gbp-phone">Phone</label>
            <input id="gbp-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} style={input} />
          </div>
          <div>
            <label style={label} htmlFor="gbp-web">Website</label>
            <input id="gbp-web" value={form.website} onChange={(e) => set('website', e.target.value)} style={input} />
          </div>
        </div>

        <div>
          <div style={label}>Hours</div>
          {regular.complex ? (
            <div style={{ fontSize: 12.5, color: C.gray500 }}>These hours have split, overnight or 24-hour spans - edit them in Google so nothing is flattened.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {form.days.map((d, i) => (
                <div key={d.day} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                  <span style={{ width: 90, color: C.gray700 }}>{DAY_LABEL[d.day]}</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.gray600 }}>
                    <input type="checkbox" checked={d.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} />Closed
                  </label>
                  {!d.closed && (
                    <>
                      <input type="time" value={d.open} onChange={(e) => setDay(i, { open: e.target.value })} style={{ ...input, width: 130 }} aria-label={`${DAY_LABEL[d.day]} opens`} />
                      <span style={{ color: C.gray400 }}>to</span>
                      <input type="time" value={d.close} onChange={(e) => setDay(i, { close: e.target.value })} style={{ ...input, width: 130 }} aria-label={`${DAY_LABEL[d.day]} closes`} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div style={label}>Holiday Hours</div>
          {special.complex ? (
            <div style={{ fontSize: 12.5, color: C.gray500 }}>Some holiday hours span several days - edit them in Google so nothing is flattened.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {form.holidays.length === 0 && <div style={{ fontSize: 12.5, color: C.gray400 }}>No holiday hours set.</div>}
              {form.holidays.map((h, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                  <input type="date" value={h.date} onChange={(e) => setHoliday(i, { date: e.target.value })} style={{ ...input, width: 160 }} aria-label="Holiday date" />
                  {h.date && <span style={{ fontSize: 12, color: C.gray500 }}>{formatDate(`${h.date}T12:00:00`)}</span>}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.gray600 }}>
                    <input type="checkbox" checked={h.closed} onChange={(e) => setHoliday(i, { closed: e.target.checked })} />Closed
                  </label>
                  {!h.closed && (
                    <>
                      <input type="time" value={h.open} onChange={(e) => setHoliday(i, { open: e.target.value })} style={{ ...input, width: 130 }} aria-label="Holiday opens" />
                      <span style={{ color: C.gray400 }}>to</span>
                      <input type="time" value={h.close} onChange={(e) => setHoliday(i, { close: e.target.value })} style={{ ...input, width: 130 }} aria-label="Holiday closes" />
                    </>
                  )}
                  <button onClick={() => set('holidays', form.holidays.filter((_, j) => j !== i))} style={btn} aria-label="Remove holiday"><Trash2 size={12} /></button>
                </div>
              ))}
              <div>
                <button onClick={() => set('holidays', [...form.holidays, { date: '', closed: true, open: '09:00', close: '17:00' }])} style={btn}>
                  <Plus size={12} />Add Holiday
                </button>
              </div>
            </div>
          )}
        </div>

        {(problem || err) && <div role="alert" style={{ fontSize: 12.5, color: C.red600 }}>{problem || err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ ...btn, border: 'none', background: 'transparent' }}>Cancel</button>
          <button onClick={save} disabled={!dirty || !!problem || saving} style={{ ...primaryBtn, opacity: !dirty || problem || saving ? 0.6 : 1 }}>
            {saving ? 'Saving to Google...' : 'Save to Google'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function stalePhotos(location) {
  if (!location.lastPhotoAt) return location.photoCount === 0 && !!location.syncedAt
  return Date.now() - new Date(location.lastPhotoAt).getTime() > STALE_PHOTO_DAYS * 86400000
}

function LocationCard({ location, canEdit, canPost, onChange }) {
  const [tab, setTab] = useState('listing')
  const [editing, setEditing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [mapErr, setMapErr] = useState('')
  const [saved, setSaved] = useState('')

  async function mapFacility(facility) {
    setMapErr('')
    try {
      onChange(await api.mapGbpLocation(location.key, facility))
    } catch (e) {
      setMapErr(errorText(e))
    }
  }

  const facilityOptions = [...new Set([...FACILITIES, ...(location.facility ? [location.facility] : [])])]

  return (
    <div style={{ background: C.white, border: '1px solid ' + C.gray200, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: C.gray900 }}>{location.title}</span>
            {location.pendingGoogleReview && (
              <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 500, background: C.amber50, color: C.amber700 }}>
                Pending Google Review
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: C.gray500, marginTop: 2 }}>
            <MapPin size={12} />{location.address || 'No address on Google'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: C.gray600, marginTop: 4 }}>
            <StarRating value={Math.round(location.avgRating || 0)} size={12} />
            <span>{location.reviewCount ? `${location.avgRating.toFixed(1)} from ${location.reviewCount.toLocaleString('en-US')} review${location.reviewCount === 1 ? '' : 's'}` : 'No reviews yet'}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setShowHistory((v) => !v)} style={btn}><History size={12} />{showHistory ? 'Hide History' : 'History'}</button>
          {canEdit && <button onClick={() => setEditing(true)} style={primaryBtn}><Pencil size={12} />Edit Listing</button>}
        </div>
      </div>

      {saved && <Notice kind="ok" onClose={() => setSaved('')}>{saved}</Notice>}

      <div className="scroll-tabs" role="tablist" style={{ display: 'flex', gap: 18, boxShadow: 'inset 0 -1px 0 ' + C.gray200, marginBottom: 14 }}>
        {CARD_TABS.map((t) => {
          const active = tab === t.key
          return (
            <button key={t.key} role="tab" aria-selected={active} onClick={() => setTab(t.key)} style={{
              padding: '6px 0', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
              color: active ? C.gray900 : C.gray500, boxShadow: active ? 'inset 0 -2px 0 ' + C.emerald600 : 'none', whiteSpace: 'nowrap',
            }}>
              {t.label}{t.key === 'photos' && location.photoCount ? ` (${location.photoCount})` : ''}
            </button>
          )
        })}
      </div>

      {tab === 'posts' && <GooglePostsTab location={location} canEdit={canPost} />}
      {tab === 'photos' && (
        <GooglePhotosTab location={location} canEdit={canPost}
                         onCountChange={(n) => onChange({ ...location, photoCount: n })} />
      )}

      {tab === 'listing' && (<>
      {stalePhotos(location) && (
        <Notice kind="warn">
          No new photo on Google in over {STALE_PHOTO_DAYS} days - fresh photos help the listing rank.
          {canPost && <button onClick={() => setTab('photos')} style={{ ...btn, padding: '2px 8px', marginLeft: 8 }}>Add a Photo</button>}
        </Notice>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, fontSize: 12.5, color: C.gray700 }}>
        <div>
          <div style={label}>Description</div>
          <div style={{ whiteSpace: 'pre-wrap', color: location.description ? C.gray700 : C.gray400 }}>{location.description || 'No description on Google'}</div>
          <div style={{ ...label, marginTop: 12 }}>Phone &amp; Website</div>
          <div>{location.phone || <span style={{ color: C.gray400 }}>No phone</span>}</div>
          <div style={{ wordBreak: 'break-all' }}>{location.website || <span style={{ color: C.gray400 }}>No website</span>}</div>
        </div>
        <div>
          <div style={label}>Hours</div>
          <HoursSummary location={location} />
        </div>
        <div>
          <div style={label}>Ask for Reviews</div>
          <ReviewLink location={location} />
          <div style={{ ...label, marginTop: 12, display: 'flex', alignItems: 'center', gap: 4 }}><Building2 size={12} />Nexus Property</div>
          {canEdit ? (
            <select value={location.facility || ''} onChange={(e) => mapFacility(e.target.value)} style={{ ...input, width: 'auto', minWidth: 200 }} aria-label="Nexus property">
              <option value="">Not Mapped</option>
              {facilityOptions.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          ) : (
            <div>{location.facility || <span style={{ color: C.gray400 }}>Not mapped</span>}</div>
          )}
          {mapErr && <div role="alert" style={{ fontSize: 12, color: C.red600, marginTop: 4 }}>{mapErr}</div>}
        </div>
      </div>

      </>)}

      {showHistory && (
        <div style={{ marginTop: 12, borderTop: '1px solid ' + C.gray100, paddingTop: 10 }}>
          <ListingHistory key={location.syncedAt} location={location} />
        </div>
      )}

      {editing && (
        <EditListingModal
          location={location}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            onChange(next)
            setSaved(next.pendingGoogleReview
              ? 'Saved. Google is reviewing the change before it shows publicly.'
              : 'Saved. The listing on Google is updated.')
          }}
        />
      )}
    </div>
  )
}

// Every Google location the connected account manages: the listing (edit
// description, phone, website, hours, holiday hours), its review link with a
// QR code for signs and NFC tags, and the Nexus property it is.
export default function GoogleListingsPanel({ canEdit, canPost, reloadKey = 0 }) {
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setLocations(await api.getGbpLocations() || [])
    } catch (e) {
      setError(errorText(e, 'The Google locations could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, reloadKey])

  const replace = (next) => setLocations((ls) => ls.map((l) => (l.id === next.id ? next : l)))

  return (
    <>
    {locations.length > 0 && <GooglePerformanceSection locations={locations} reloadKey={reloadKey} />}
    <AsyncSection
      loading={loading}
      error={!!error}
      errorMessage={error}
      onRetry={load}
      isEmpty={locations.length === 0}
      skeleton={<SkeletonBlocks count={2} height={220} />}
      emptyContent={(
        <div style={{ textAlign: 'center', padding: '40px 12px', color: C.gray400, fontSize: 13 }}>
          No locations have synced from Google yet. Make sure the connected account is a Manager on the locations, then Sync Now.
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {locations.map((l) => <LocationCard key={l.id} location={l} canEdit={canEdit} canPost={canPost} onChange={replace} />)}
      </div>
    </AsyncSection>
    </>
  )
}
