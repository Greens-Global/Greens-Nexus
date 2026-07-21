import { useMemo, useState } from 'react'
import SeoHeader from './SeoHeader'
import SeoSubTabs from './SeoSubTabs'
import SeoStatCards from './SeoStatCards'
import SeoDistributionCharts from './SeoDistributionCharts'
import KeywordExplorerCard from './KeywordExplorerCard'
import KeywordHeatmap from './KeywordHeatmap'
import RankTrackerCard from './RankTrackerCard'
import LocalSearchCard from './LocalSearchCard'
import WebsitePerformanceStatCards from './WebsitePerformanceStatCards'
import OrganicTrafficChart from './OrganicTrafficChart'
import TopLandingPagesCard from './TopLandingPagesCard'
import CompetitorsCard from './CompetitorsCard'
import SerpOverviewModal from './SerpOverviewModal'
import AddTrackedKeywordModal from './AddTrackedKeywordModal'
import { keywordDatabase, trackedKeywords as initialTrackedKeywords } from './data'
import { localSearchRows } from './localSearchData'
import { coreWebVitals, organicTrafficTrend, topLandingPages } from './websitePerformanceData'
import {
  computeTrackedStats,
  computeCompetitorSummary,
  computeOwnDomainSummary,
  filterKeywordsByRegion,
  filterLocalByRegion,
  filterTrackedByRegion,
} from './aggregate'
import { ALL_REGIONS, REGIONS } from '../shared/facilities'
import { downloadCSV, formatNumber } from '../shared/utils'
import { C } from '../theme'

export default function SeoPage({ onNavigate, alerts, insights, onClearAlert }) {
  const [tab, setTab] = useState('overview')
  const [tracked, setTracked] = useState(initialTrackedKeywords)
  const [selectedKeyword, setSelectedKeyword] = useState(null)
  const [addModal, setAddModal] = useState(null)
  const [region, setRegion] = useState(ALL_REGIONS)

  const scopedDatabase = useMemo(() => filterKeywordsByRegion(keywordDatabase, region), [region])
  const scopedTracked = useMemo(() => filterTrackedByRegion(tracked, region), [tracked, region])
  const scopedLocalRows = useMemo(() => filterLocalByRegion(localSearchRows, region), [region])

  const trackedNames = new Set(tracked.map((t) => t.keyword))
  const stats = computeTrackedStats(scopedTracked)
  const defaultFacility = REGIONS.find((r) => r.name === region)?.facilities[0]

  const ownDomainSummary = useMemo(() => computeOwnDomainSummary(scopedDatabase), [scopedDatabase])
  const competitorSummary = useMemo(() => computeCompetitorSummary(scopedDatabase), [scopedDatabase])
  const totalOrganicSessions = useMemo(() => organicTrafficTrend.reduce((a, p) => a + p.sessions, 0), [])

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

      <SeoSubTabs active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <>
          <SeoStatCards stats={stats} totalKeywordUniverse={scopedDatabase.length} />
          <SeoDistributionCharts keywords={scopedDatabase} />
          <p style={{ fontSize: 11, color: C.gray400, marginTop: 4 }}>
            {formatNumber(scopedDatabase.length)} keywords in the research database · {scopedTracked.length} currently tracked
            {region !== ALL_REGIONS ? ` in ${region}` : ''}
          </p>
        </>
      )}

      {tab === 'rankings' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 16, alignItems: 'start' }}>
          <KeywordExplorerCard
            database={scopedDatabase}
            trackedKeywordNames={trackedNames}
            onSelectKeyword={setSelectedKeyword}
            onTrackKeyword={(k) => setAddModal({ preset: k })}
          />
          <RankTrackerCard rows={scopedTracked} onAddKeyword={() => setAddModal({})} onRemove={removeTrackedKeyword} />
        </div>
      )}

      {tab === 'local' && <LocalSearchCard rows={scopedLocalRows} />}

      {tab === 'heatmap' && <KeywordHeatmap keywords={scopedDatabase} />}

      {tab === 'performance' && (
        <>
          <WebsitePerformanceStatCards vitals={coreWebVitals} totalOrganicSessions={totalOrganicSessions} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'stretch' }}>
            <div style={{ gridColumn: 'span 6' }}>
              <OrganicTrafficChart data={organicTrafficTrend} />
            </div>
            <div style={{ gridColumn: 'span 6' }}>
              <TopLandingPagesCard rows={topLandingPages} />
            </div>
          </div>
        </>
      )}

      {tab === 'competitors' && <CompetitorsCard own={ownDomainSummary} competitors={competitorSummary} />}

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
