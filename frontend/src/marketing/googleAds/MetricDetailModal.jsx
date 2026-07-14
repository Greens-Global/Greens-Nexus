import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import Modal from '../shared/Modal'
import { parseISO } from './utils'
import { C } from '../theme'

function dailyValue(r, key) {
  switch (key) {
    case 'impressions':
      return r.impressions
    case 'clicks':
      return r.clicks
    case 'conversions':
      return r.conversions
    case 'spend':
      return r.spend
    case 'ctr':
      return r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0
    case 'costPerConv':
      return r.conversions > 0 ? r.spend / r.conversions : 0
    case 'avgCpc':
      return r.clicks > 0 ? r.spend / r.clicks : 0
  }
}

function campaignValue(c, key) {
  switch (key) {
    case 'impressions':
      return c.impressions
    case 'clicks':
      return c.clicks
    case 'conversions':
      return c.conversions
    case 'spend':
      return c.spend
    case 'ctr':
      return c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0
    case 'costPerConv':
      return c.conversions > 0 ? c.spend / c.conversions : 0
    case 'avgCpc':
      return c.clicks > 0 ? c.spend / c.clicks : 0
  }
}

export default function MetricDetailModal({ metricKey, label, rows, campaigns, format, onClose }) {
  const chartData = useMemo(
    () =>
      rows.map((r) => ({
        label: parseISO(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
        value: dailyValue(r, metricKey),
      })),
    [rows, metricKey],
  )

  const campaignRows = useMemo(
    () =>
      [...campaigns]
        .map((c) => ({ name: c.name, value: campaignValue(c, metricKey) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8),
    [campaigns, metricKey],
  )

  const maxValue = campaignRows.length > 0 ? campaignRows[0].value : 0

  return (
    <Modal title={label} onClose={onClose} width="max-w-2xl">
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: C.gray400, textTransform: 'uppercase', letterSpacing: '0.025em', marginBottom: 8 }}>Trend over selected range</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} minTickGap={24} />
            <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v) => format(Number(v) || 0)}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            />
            <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: C.gray400, textTransform: 'uppercase', letterSpacing: '0.025em', marginBottom: 8 }}>Top campaigns by {label.toLowerCase()}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {campaignRows.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: C.gray700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: 160, flexShrink: 0 }}>{c.name}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 9999, background: C.gray100, overflow: 'hidden' }}>
                <div
                  style={{ height: '100%', borderRadius: 9999, background: C.blue500, width: maxValue > 0 ? `${(c.value / maxValue) * 100}%` : '0%' }}
                />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, color: C.gray900, width: 80, textAlign: 'right', flexShrink: 0 }}>{format(c.value)}</span>
            </div>
          ))}
          {campaignRows.length === 0 && (
            <div style={{ color: C.gray400, fontSize: 13, padding: '16px 0', textAlign: 'center' }}>No campaigns in this view.</div>
          )}
        </div>
      </div>
    </Modal>
  )
}
