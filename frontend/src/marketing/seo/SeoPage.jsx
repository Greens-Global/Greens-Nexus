import { useMemo, useRef, useState } from 'react'
import SeoHeader from './SeoHeader'
import SeoStatCards from './SeoStatCards'
import SeoDistributionCharts from './SeoDistributionCharts'
import SeoSectionNav from './SeoSectionNav'
import KeywordExplorerCard from './KeywordExplorerCard'
import KeywordHeatmap from './KeywordHeatmap'
import RankTrackerCard from './RankTrackerCard'
import SerpOverviewModal from './SerpOverviewModal'
import AddTrackedKeywordModal from './AddTrackedKeywordModal'
import { keywordDatabase, trackedKeywords as initialTrackedKeywords } from './data'
import { computeTrackedStats, filterKeywordsByRegion, filterTrackedByRegion } from './aggregate'
import { ALL_REGIONS, REGIONS } from '../shared/facilities'
import { downloadCSV, formatNumber } from '../shared/utils'
import { C } from '../theme'

export default function SeoPage({ onNavigate, alerts, insights, onClearAlert }) {
  const [tracked, setTracked] = useState(initialTrackedKeywords)
  const [selectedKeyword, setSelectedKeyword] = useState(null)
  const [addModal, setAddModal] = useState(null)
  const [region, setRegion] = useState(ALL_REGIONS)
  const [highlighted, setHighlighted] = useState(null)
  const explorerRef = useRef(null)
  const heatmapRef = useRef(null)
  const trackerRef = useRef(null)
  const sectionRefs = {
    explorer: explorerRef,
    heatmap: heatmapRef,
    tracker: trackerRef,
  }

  function jumpToSection(key) {
    sectionRefs[key]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setHighlighted(key)
    setTimeout(() => setHighlighted((prev) => (prev === key ? null : prev)), 1500)
  }

  const scopedDatabase = useMemo(() => filterKeywordsByRegion(keywordDatabase, region), [region])
  const scopedTracked = useMemo(() => filterTrackedByRegion(tracked, region), [tracked, region])

  const trackedNames = new Set(tracked.map((t) => t.keyword))
  const stats = computeTrackedStats(scopedTracked)
  const defaultFacility = REGIONS.find((r) => r.name === region)?.facilities[0]

  function addTrackedKeyword(keyword, facility, priority) {
    const startPosition = Math.min(40, Math.max(1, Math.round(10 + keyword.difficulty / 5)))
    const today = new Date().toISOString().slice(0, 10)
    const next = {
      id: `tk-custom-${Date.now()}`,
      keyword: keyword.keyword,
      facility,
      priority,
      url: `https://greensstorage.com/${facility.toLowerCase().replace(/[^a-z]+/g, '-')}/`,
      volume: keyword.volume,
      difficulty: keyword.difficulty,
      history: [{ date: today, position: startPosition }],
    }
    setTracked((prev) => [next, ...prev])
  }

  function removeTrackedKeyword(id) {
    setTracked((prev) => prev.filter((t) => t.id !== id))
  }

  function downloadReport() {
    const rows = [
      ['SEO Research Report'],
      [],
      ['Rank Tracker'],
      ['Keyword', 'Facility', 'Priority', 'Current Position', 'Volume', 'Difficulty', 'URL'],
      ...tracked.map((t) => [
        t.keyword,
        t.facility,
        t.priority,
        t.history[t.history.length - 1]?.position ?? '',
        t.volume,
        t.difficulty,
        t.url,
      ]),
      [],
      ['Keyword Database'],
      ['Keyword', 'Volume', 'Difficulty', 'CPC', 'Intent'],
      ...keywordDatabase.map((k) => [k.keyword, k.volume, k.difficulty, k.cpc.toFixed(2), k.intent]),
    ]
    downloadCSV(`seo-research-report.csv`, rows)
  }

  return (
    <div>
      <SeoHeader region={region} onRegionChange={setRegion} onDownload={downloadReport} onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <SeoStatCards stats={stats} totalKeywordUniverse={scopedDatabase.length} />

      <SeoDistributionCharts keywords={scopedDatabase} />

      <SeoSectionNav onJump={jumpToSection} />

      <div
        style={{ marginBottom: 16, borderRadius: 12, transition: 'box-shadow .15s', boxShadow: highlighted === 'explorer' ? `0 0 0 2px ${C.emerald400}` : 'none' }}
        ref={explorerRef}
      >
        <KeywordExplorerCard
          database={scopedDatabase}
          trackedKeywordNames={trackedNames}
          onSelectKeyword={setSelectedKeyword}
          onTrackKeyword={(k) => setAddModal({ preset: k })}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12,minmax(0,1fr))',
          gap: 16,
          marginBottom: 16,
          alignItems: 'stretch',
          borderRadius: 12,
          transition: 'box-shadow .15s',
          boxShadow: highlighted === 'heatmap' ? `0 0 0 2px ${C.emerald400}` : 'none',
        }}
        ref={heatmapRef}
      >
        <div style={{ gridColumn: 'span 12' }}>
          <KeywordHeatmap keywords={scopedDatabase} />
        </div>
      </div>

      <div
        style={{ borderRadius: 12, transition: 'box-shadow .15s', boxShadow: highlighted === 'tracker' ? `0 0 0 2px ${C.emerald400}` : 'none' }}
        ref={trackerRef}
      >
        <RankTrackerCard rows={scopedTracked} onAddKeyword={() => setAddModal({})} onRemove={removeTrackedKeyword} />
      </div>

      <p style={{ fontSize: 11, color: C.gray400, marginTop: 12 }}>
        {formatNumber(scopedDatabase.length)} keywords in the research database · {scopedTracked.length} currently tracked
        {region !== ALL_REGIONS ? ` in ${region}` : ''}
      </p>

      {selectedKeyword && <SerpOverviewModal keyword={selectedKeyword} onClose={() => setSelectedKeyword(null)} />}

      {addModal && (
        <AddTrackedKeywordModal
          database={keywordDatabase}
          trackedKeywordNames={trackedNames}
          presetKeyword={addModal.preset}
          initialFacility={defaultFacility}
          onAdd={addTrackedKeyword}
          onClose={() => setAddModal(null)}
        />
      )}
    </div>
  )
}
