import { topicFrequency } from '../reputation/aiReplyEngine'
import { ANCHOR_DATE, pctChange, formatCurrency, formatNumber } from '../shared/utils'

// Materiality gate for percent-based deltas — small wobbles don't produce a
// card, only genuinely notable shifts do.
function magnitudeSeverity(absPct) {
  if (absPct >= 20) return 'High'
  if (absPct >= 10) return 'Medium'
  if (absPct >= 5) return 'Low'
  return null
}

function trafficInsight(input) {
  const { sessions, organicSessions, gaSpend, yelpSpend } = input
  const delta = pctChange(sessions.current, sessions.previous)
  const severity = magnitudeSeverity(Math.abs(delta))
  if (!severity) return null

  const isDrop = delta < 0
  const spendDelta = pctChange(gaSpend.current + yelpSpend.current, gaSpend.previous + yelpSpend.previous)
  const organicDelta = pctChange(organicSessions.current, organicSessions.previous)

  let why
  let actions
  let impact

  if (isDrop) {
    if (spendDelta <= -10) {
      why = `This closely tracks a ${Math.abs(spendDelta).toFixed(0)}% drop in combined Google + Yelp ad spend over the same period, which is the most likely driver.`
      actions = [
        'Increase your Google Ads / Yelp Ads budget back toward its prior level',
        'Refresh ad creatives on your top campaigns to lift click-through rate',
        'Review keyword bids on underperforming campaigns',
      ]
    } else if (organicDelta <= -10) {
      why = `Organic sessions fell ${Math.abs(organicDelta).toFixed(0)}%, faster than paid traffic — pointing to a search-visibility issue rather than an ad-spend change.`
      actions = [
        'Review recent ranking changes for your tracked SEO keywords',
        'Publish a new Google Business Profile post to refresh visibility',
        'Check for any recent site or listing changes that could affect search ranking',
      ]
    } else {
      why = 'No single ad-spend or SEO change explains this drop on its own — likely a mix of seasonality and normal channel variance.'
      actions = ['Compare this period against the same period last year to check for seasonality', 'Review the lead-source mix for any channel shifts']
    }
    impact = 'If this trend continues, lead generation may decrease over the coming weeks.'
  } else {
    if (spendDelta >= 10) {
      why = `This aligns with a ${spendDelta.toFixed(0)}% increase in combined ad spend, suggesting the extra budget is translating into more visits.`
    } else if (organicDelta >= 10) {
      why = `Organic sessions grew ${organicDelta.toFixed(0)}%, suggesting improved search visibility is driving the gain.`
    } else {
      why = 'Traffic is up across the board without one dominant driver — a good sign of broad-based momentum.'
    }
    actions = ['Maintain the current budget and creative mix', 'Consider a modest budget increase on your best-performing campaigns to compound the gain']
    impact = 'This tailwind should support continued lead volume if it holds.'
  }

  return {
    id: 'traffic',
    severity,
    category: isDrop ? 'Risk' : 'Opportunity',
    title: isDrop ? `Website traffic is down ${Math.abs(delta).toFixed(0)}%` : `Website traffic is up ${delta.toFixed(0)}%`,
    whatHappened: `Website sessions ${isDrop ? 'decreased' : 'increased'} ${Math.abs(delta).toFixed(0)}% compared to the previous period.`,
    why,
    impact,
    actions,
    metrics: [
      { label: 'Sessions', value: `${formatNumber(sessions.previous)} → ${formatNumber(sessions.current)}` },
      { label: 'Organic sessions', value: `${formatNumber(organicSessions.previous)} → ${formatNumber(organicSessions.current)}` },
    ],
    metricKey: 'sessions',
  }
}

function leadsInsight(input) {
  const { leads, sessions, leadToMoveInRate } = input
  const delta = pctChange(leads.current, leads.previous)
  const severity = magnitudeSeverity(Math.abs(delta))
  if (!severity) return null

  const isDrop = delta < 0
  const sessionsDelta = pctChange(sessions.current, sessions.previous)

  let why
  let actions
  let impact

  if (isDrop) {
    if (sessionsDelta <= -10) {
      why = `Website traffic is also down ${Math.abs(sessionsDelta).toFixed(0)}% over the same period — fewer visits is the most direct explanation for fewer leads.`
      actions = ['Address the underlying traffic drop first', 'Review lead-capture forms for friction']
    } else {
      why = 'Traffic held roughly steady, so this looks like a conversion-funnel issue rather than a traffic problem — fewer visitors are converting into leads.'
      actions = ['Review landing page CTAs and lead forms for friction', 'Check the recent lead-source mix for a shift toward lower-intent channels', 'Test simplifying the inquiry form']
    }
    impact = 'Fewer leads now typically shows up as fewer move-ins 2-4 weeks out unless offset elsewhere.'
  } else {
    why = sessionsDelta >= 10
      ? `Traffic is also up ${sessionsDelta.toFixed(0)}%, so more visitors are the main driver.`
      : 'Conversion from existing traffic improved — visitors are converting into leads at a higher rate.'
    actions = ['Maintain current campaigns and landing pages', 'Make sure lead follow-up speed keeps pace with the higher volume']
    impact = 'This should translate into more move-ins in the coming weeks if follow-up keeps pace.'
  }

  return {
    id: 'leads',
    severity,
    category: isDrop ? 'Risk' : 'Opportunity',
    title: isDrop ? `Leads are down ${Math.abs(delta).toFixed(0)}%` : `Leads are up ${delta.toFixed(0)}%`,
    whatHappened: `Total leads ${isDrop ? 'decreased' : 'increased'} ${Math.abs(delta).toFixed(0)}% compared to the previous period.`,
    why,
    impact,
    actions,
    metrics: [
      { label: 'Leads', value: `${formatNumber(leads.previous)} → ${formatNumber(leads.current)}` },
      { label: 'Lead → Move-In rate', value: `${leadToMoveInRate.previous.toFixed(1)}% → ${leadToMoveInRate.current.toFixed(1)}%` },
    ],
    tab: 'leads',
  }
}

function costPerLeadInsight(input) {
  const { costPerLead, leads, gaSpend, yelpSpend } = input
  const delta = pctChange(costPerLead.current, costPerLead.previous)
  const severity = magnitudeSeverity(Math.abs(delta))
  if (!severity) return null

  const isWorse = delta > 0
  const spendDelta = pctChange(gaSpend.current + yelpSpend.current, gaSpend.previous + yelpSpend.previous)
  const leadsDelta = pctChange(leads.current, leads.previous)

  let why
  let actions
  let impact

  if (isWorse) {
    if (spendDelta > 5 && leadsDelta < spendDelta - 5) {
      why = `Ad spend rose ${spendDelta.toFixed(0)}% but leads only grew ${leadsDelta.toFixed(0)}% over the same period — spend is outpacing the leads it's generating.`
    } else if (leadsDelta < -5) {
      why = `Lead volume fell ${Math.abs(leadsDelta).toFixed(0)}% while spend held steady, pushing the cost of each remaining lead higher.`
    } else {
      why = 'Spend and lead volume both shifted enough to raise the blended cost per lead.'
    }
    actions = ['Pause or reduce budget on your lowest-converting campaigns', 'Reallocate budget toward top-performing campaigns', 'Review targeting and keywords for wasted spend']
    impact = 'A rising cost per lead compresses margin on every new tenant acquired unless offset by higher move-in value.'
  } else {
    why = spendDelta < -5
      ? `Spend fell ${Math.abs(spendDelta).toFixed(0)}% while lead volume held up, improving efficiency.`
      : 'Lead volume grew faster than spend, improving efficiency.'
    actions = ['Maintain the current budget allocation', 'Consider reinvesting the savings into your best-performing campaigns']
    impact = 'A lower cost per lead means more leads for the same budget — a good time to consider scaling spend.'
  }

  return {
    id: 'cost-per-lead',
    severity,
    category: 'Efficiency',
    title: isWorse ? `Cost per lead is up ${Math.abs(delta).toFixed(0)}%` : `Cost per lead is down ${Math.abs(delta).toFixed(0)}%`,
    whatHappened: `Cost per lead ${isWorse ? 'increased' : 'decreased'} from ${formatCurrency(costPerLead.previous)} to ${formatCurrency(costPerLead.current)}.`,
    why,
    impact,
    actions,
    metrics: [
      { label: 'Cost per lead', value: `${formatCurrency(costPerLead.previous)} → ${formatCurrency(costPerLead.current)}` },
      { label: 'Combined ad spend', value: `${formatCurrency(gaSpend.previous + yelpSpend.previous)} → ${formatCurrency(gaSpend.current + yelpSpend.current)}` },
    ],
    tab: 'google-ads',
  }
}

function reviewRatingInsight(input) {
  const { reviewRating, recentPositiveReviewTexts, recentNegativeReviewTexts } = input
  const delta = reviewRating.current - reviewRating.previous
  const absDelta = Math.abs(delta)

  let severity = null
  if (absDelta >= 0.3) severity = 'High'
  else if (absDelta >= 0.15) severity = 'Medium'
  else if (absDelta >= 0.05) severity = 'Low'
  if (!severity) return null

  const isUp = delta > 0
  const topics = topicFrequency(isUp ? recentPositiveReviewTexts : recentNegativeReviewTexts)
  const topTopics = topics.slice(0, 2).map((t) => t.label)
  const topicPhrase = topTopics.length > 0 ? topTopics.join(' and ') : 'a mix of factors across recent reviews'

  const why = isUp
    ? `Recent reviews show a noticeable amount of praise for ${topicPhrase}.`
    : `Several recent reviews raise concerns about ${topicPhrase}.`
  const actions = isUp
    ? ["Recognize the team for the specific praise above — keep reinforcing what's working", 'Ask recent happy customers for a review to compound the trend']
    : [`Address the recurring ${topTopics[0] ?? 'issue'} concern directly with the team`, "Respond to pending reviews promptly to show you're listening", 'Follow up with recently dissatisfied customers where possible']
  const impact = isUp
    ? 'A higher rating improves trust for prospective tenants comparing you to competitors.'
    : 'A falling rating can reduce conversion from prospects who compare ratings before reaching out.'

  return {
    id: 'review-rating',
    severity,
    category: 'Reputation',
    title: isUp ? `Review rating improved to ${reviewRating.current.toFixed(1)}★` : `Review rating dropped to ${reviewRating.current.toFixed(1)}★`,
    whatHappened: `Overall rating moved from ${reviewRating.previous.toFixed(1)}★ to ${reviewRating.current.toFixed(1)}★.`,
    why,
    impact,
    actions,
    metrics: [{ label: 'Overall rating', value: `${reviewRating.previous.toFixed(1)}★ → ${reviewRating.current.toFixed(1)}★` }],
    tab: 'reputation',
  }
}

function sentimentInsight(input) {
  const { sentimentPositivePct } = input
  const deltaPts = sentimentPositivePct.current - sentimentPositivePct.previous
  const abs = Math.abs(deltaPts)

  let severity = null
  if (abs >= 15) severity = 'High'
  else if (abs >= 8) severity = 'Medium'
  else if (abs >= 3) severity = 'Low'
  if (!severity) return null

  const isUp = deltaPts > 0

  return {
    id: 'sentiment',
    severity,
    category: 'Reputation',
    title: isUp ? `Positive sentiment is up ${deltaPts.toFixed(0)} pts` : `Positive sentiment is down ${abs.toFixed(0)} pts`,
    whatHappened: `The share of positive reviews ${isUp ? 'rose' : 'fell'} ${abs.toFixed(0)} percentage points this period.`,
    why: isUp
      ? 'A larger share of recent reviews are landing in the positive bucket, ahead of any change in the average star rating.'
      : "A larger share of recent reviews are landing in the neutral or negative bucket — a leading signal that often shows up in the average rating shortly after.",
    impact: isUp
      ? 'Early sign that recent service changes are resonating with customers.'
      : "This often precedes a drop in the average star rating if the underlying cause isn't addressed.",
    actions: isUp
      ? ["Keep the current service approach — it's working"]
      : ['Review the most recent negative reviews for a common theme', 'Respond to pending reviews to show responsiveness'],
    metrics: [{ label: 'Positive review share', value: `${sentimentPositivePct.previous.toFixed(0)}% → ${sentimentPositivePct.current.toFixed(0)}%` }],
    tab: 'reputation',
  }
}

function npsInsight(input) {
  const { nps } = input
  const delta = nps.current - nps.previous
  const abs = Math.abs(delta)

  let severity = null
  if (abs >= 10) severity = 'High'
  else if (abs >= 5) severity = 'Medium'
  else if (abs >= 2) severity = 'Low'
  if (!severity) return null

  const isUp = delta > 0

  return {
    id: 'nps',
    severity,
    category: 'Reputation',
    title: isUp ? `NPS improved to ${Math.round(nps.current)}` : `NPS dropped to ${Math.round(nps.current)}`,
    whatHappened: `Net Promoter Score moved from ${Math.round(nps.previous)} to ${Math.round(nps.current)}.`,
    why: isUp
      ? 'More customers are willing to recommend you than last period — usually a downstream effect of a smoother move-in experience or better support interactions.'
      : 'Fewer customers are willing to recommend you than last period, often an early warning sign before it shows up in star ratings.',
    impact: isUp
      ? 'Higher NPS typically correlates with more referral-driven leads over time.'
      : "A declining NPS can quietly erode referral-driven lead flow before it's visible elsewhere.",
    actions: isUp
      ? ['Ask promoters for a public review or referral']
      : ['Review recent survey comments for a common complaint', 'Follow up personally with detractors where possible'],
    metrics: [{ label: 'NPS', value: `${Math.round(nps.previous)} → ${Math.round(nps.current)}` }],
    metricKey: 'nps',
  }
}

function seoInsight(input) {
  const { seo } = input
  if (seo.trackedCount === 0) return null

  const isBad = seo.declined > seo.improved && seo.declined >= 3
  const isGood = seo.improved > seo.declined && seo.improved >= 3
  if (!isBad && !isGood) return null

  const severity = isBad ? (seo.declined >= 6 ? 'High' : 'Medium') : 'Low'

  if (isBad) {
    const worst = seo.worstDecliners.slice(0, 2).map((w) => `"${w.keyword}" (down ${w.delta} spot${w.delta === 1 ? '' : 's'})`).join(', ')
    return {
      id: 'seo',
      severity,
      category: 'Risk',
      title: `${seo.declined} tracked keywords lost ranking`,
      whatHappened: `${seo.declined} of your ${seo.trackedCount} tracked keywords dropped in position this period, vs. ${seo.improved} that improved.`,
      why: worst
        ? `The steepest drops are ${worst} — often a sign of new competitor content, a search algorithm change, or an on-page issue on those pages.`
        : 'Multiple keywords lost ground, suggesting a broader ranking factor rather than one-off noise.',
      impact: 'Lower rankings on these terms reduce organic visibility and, over time, organic-driven leads.',
      actions: ['Review and refresh on-page content for the declining keywords', 'Check for new competitor content ranking above you', 'Publish a Google Business Profile post to reinforce local relevance'],
      metrics: [
        { label: 'Improved / Declined', value: `${seo.improved} / ${seo.declined}` },
        { label: 'Avg. position', value: seo.avgPosition.toFixed(1) },
      ],
      tab: 'seo',
    }
  }

  return {
    id: 'seo',
    severity,
    category: 'Opportunity',
    title: `${seo.improved} tracked keywords gained ranking`,
    whatHappened: `${seo.improved} of your ${seo.trackedCount} tracked keywords improved position this period, vs. ${seo.declined} that declined.`,
    why: 'Consistent with recent content or optimization work paying off across multiple terms.',
    impact: 'Improved rankings typically compound into more organic traffic and leads over the following weeks.',
    actions: ['Keep publishing and optimizing content for your remaining target keywords', 'Double down on whatever recent SEO work drove this'],
    metrics: [
      { label: 'Improved / Declined', value: `${seo.improved} / ${seo.declined}` },
      { label: 'Avg. position', value: seo.avgPosition.toFixed(1) },
    ],
    tab: 'seo',
  }
}

function gbpEngagementInsight(input) {
  const { gbp } = input
  if (gbp.unansweredQuestions === 0 && gbp.stalePhotoProperties.length === 0) return null

  const severity = gbp.unansweredQuestions >= 5 || gbp.stalePhotoProperties.length >= 3 ? 'Medium' : 'Low'
  const parts = []
  if (gbp.unansweredQuestions > 0) parts.push(`${gbp.unansweredQuestions} unanswered Q&A question${gbp.unansweredQuestions === 1 ? '' : 's'}`)
  if (gbp.stalePhotoProperties.length > 0) parts.push(`${gbp.stalePhotoProperties.length} propert${gbp.stalePhotoProperties.length === 1 ? 'y' : 'ies'} with no new photos in 60+ days`)

  return {
    id: 'gbp-engagement',
    severity,
    category: 'Reputation',
    title: 'Your business listings need attention',
    whatHappened: `${parts.join(' and ')}.`,
    why: 'Unanswered questions and stale photo galleries make listings look inactive, which Google and Yelp both weight in local ranking and which prospects notice when comparing options.',
    impact: 'Inactive-looking listings tend to convert fewer viewers into calls, clicks, and leads.',
    actions: [
      ...(gbp.unansweredQuestions > 0 ? ['Answer the outstanding Q&A questions on your business listings'] : []),
      ...(gbp.stalePhotoProperties.length > 0 ? [`Upload fresh photos for: ${gbp.stalePhotoProperties.join(', ')}`] : []),
    ],
    metrics: [
      { label: 'Unanswered questions', value: String(gbp.unansweredQuestions) },
      { label: 'Properties with stale photos', value: String(gbp.stalePhotoProperties.length) },
    ],
    tab: 'listings',
  }
}

function leadPipelineInsight(input) {
  const { leadsPipeline } = input
  if (leadsPipeline.total === 0) return null
  const unassignedPct = (leadsPipeline.unassigned / leadsPipeline.total) * 100
  if (unassignedPct < 10) return null

  const severity = unassignedPct >= 25 ? 'High' : unassignedPct >= 15 ? 'Medium' : 'Low'

  return {
    id: 'lead-pipeline',
    severity,
    category: 'Risk',
    title: `${leadsPipeline.unassigned} leads are unassigned`,
    whatHappened: `${leadsPipeline.unassigned} of ${leadsPipeline.total} leads (${unassignedPct.toFixed(0)}%) currently have no owner.`,
    why: 'Leads without an assigned staff member typically sit longer before first contact, which lowers the odds of converting them.',
    impact: 'Unassigned leads are at higher risk of going cold and being lost to a competitor who responds faster.',
    actions: ['Assign the unassigned leads in the Leads pipeline', 'Set a process to auto-assign new leads going forward'],
    metrics: [{ label: 'Unassigned leads', value: `${leadsPipeline.unassigned} / ${leadsPipeline.total}` }],
    tab: 'leads',
  }
}

function adPlatformMixInsight(input) {
  const { google, yelp } = input.adPlatforms
  if (google.costPerConv <= 0 || yelp.costPerConv <= 0) return null

  const diffPct = pctChange(yelp.costPerConv, google.costPerConv)
  if (Math.abs(diffPct) < 20) return null

  const yelpCheaper = diffPct < 0
  const severity = Math.abs(diffPct) >= 50 ? 'Medium' : 'Low'
  const cheaperPlatform = yelpCheaper ? 'Yelp Ads' : 'Google Ads'
  const pricierPlatform = yelpCheaper ? 'Google Ads' : 'Yelp Ads'

  return {
    id: 'ad-platform-mix',
    severity,
    category: 'Efficiency',
    title: `${cheaperPlatform} are converting more efficiently than ${pricierPlatform}`,
    whatHappened: `Cost per conversion on ${cheaperPlatform} (${formatCurrency(yelpCheaper ? yelp.costPerConv : google.costPerConv)}) is meaningfully lower than ${pricierPlatform} (${formatCurrency(yelpCheaper ? google.costPerConv : yelp.costPerConv)}).`,
    why: 'This usually reflects differences in audience intent or competition levels between the two platforms for your target keywords.',
    impact: 'Shifting budget toward the more efficient platform could lower your blended cost per lead without spending more overall.',
    actions: [`Consider shifting some budget from ${pricierPlatform} toward ${cheaperPlatform}`, 'Monitor conversion volume after any reallocation to confirm the trend holds'],
    metrics: [
      { label: 'Google cost/conversion', value: formatCurrency(google.costPerConv) },
      { label: 'Yelp cost/conversion', value: formatCurrency(yelp.costPerConv) },
    ],
    tab: 'google-ads',
  }
}

function budgetPacingInsight(input) {
  const { budgetPacing } = input
  if (budgetPacing.monthCoverage <= 0) return null

  const candidates = (['google', 'yelp'])
    .map((key) => {
      const p = budgetPacing[key]
      if (p.budget <= 0) return null
      const projected = p.spendMonthToDate / budgetPacing.monthCoverage
      return { platform: key === 'google' ? 'Google Ads' : 'Yelp Ads', projected, projectedPct: (projected / p.budget) * 100, budget: p.budget, spend: p.spendMonthToDate }
    })
    .filter((c) => c !== null && c.projectedPct >= 110)
    .sort((a, b) => b.projectedPct - a.projectedPct)

  const worst = candidates[0]
  if (!worst) return null

  const severity = worst.projectedPct >= 130 ? 'High' : worst.projectedPct >= 115 ? 'Medium' : 'Low'

  return {
    id: 'budget-pacing',
    severity,
    category: 'Risk',
    title: `${worst.platform} is pacing to overspend its monthly budget`,
    whatHappened: `Based on spend so far this month, ${worst.platform} is on pace to reach ${formatCurrency(worst.projected)} against a ${formatCurrency(worst.budget)} monthly budget (~${Math.round(worst.projectedPct)}%).`,
    why: "This month's daily spend rate, extrapolated across the remaining days, exceeds the monthly budget you set for this platform.",
    impact: 'Without a change, this platform will exceed its monthly ad budget before the month ends.',
    actions: [`Lower daily budget caps on ${worst.platform} campaigns`, 'Pause your lowest-converting campaigns for the rest of the month', 'Increase the monthly budget if the extra spend is intentional'],
    metrics: [
      { label: 'Spend so far this month', value: formatCurrency(worst.spend) },
      { label: 'Monthly budget', value: formatCurrency(worst.budget) },
    ],
    tab: 'google-ads',
  }
}

function goalPacingInsight(input) {
  const { goalPacing } = input
  if (goalPacing.goal <= 0 || goalPacing.monthCoverage <= 0) return null

  const projected = goalPacing.leadsMonthToDate / goalPacing.monthCoverage
  const projectedPct = (projected / goalPacing.goal) * 100

  if (projectedPct >= 90 && projectedPct < 120) return null

  const isAtRisk = projectedPct < 90
  const severity = isAtRisk ? (projectedPct < 70 ? 'High' : 'Medium') : 'Low'

  return {
    id: 'goal-pacing',
    severity,
    category: isAtRisk ? 'Risk' : 'Opportunity',
    title: isAtRisk ? `Pacing to miss this month's lead goal` : `Pacing to beat this month's lead goal`,
    whatHappened: `At the current pace, you're projected to reach ${Math.round(projected)} leads this month (~${Math.round(projectedPct)}% of your ${Math.round(goalPacing.goal)}-lead goal).`,
    why: isAtRisk
      ? 'Leads captured so far this month, extrapolated across the remaining days, fall short of the monthly goal.'
      : "Leads captured so far this month, extrapolated across the remaining days, comfortably clear the monthly goal.",
    impact: isAtRisk
      ? 'Missing the lead goal typically means fewer move-ins next month unless the pace picks up.'
      : 'A strong pace like this is a good opportunity to test scaling spend while conversion is working.',
    actions: isAtRisk
      ? ['Increase ad spend or promotional activity for the rest of the month', 'Review which properties are furthest behind their goal']
      : ['Consider raising next month\'s goal to match this pace', 'Reinvest any budget headroom into your best-performing channels'],
    metrics: [
      { label: 'Leads month-to-date', value: formatNumber(goalPacing.leadsMonthToDate) },
      { label: 'Monthly goal', value: formatNumber(goalPacing.goal) },
    ],
    metricKey: 'totalLeads',
  }
}

function bestWorstPropertyInsight(input) {
  const eligible = input.propertyRows.filter((p) => p.leads >= 5)
  if (eligible.length < 2) return null

  const withRate = eligible.map((p) => ({ ...p, rate: (p.moveIns / p.leads) * 100 }))
  const best = [...withRate].sort((a, b) => b.rate - a.rate)[0]
  const worst = [...withRate].sort((a, b) => a.rate - b.rate)[0]
  const gap = best.rate - worst.rate
  if (gap < 15) return null

  const severity = gap >= 35 ? 'High' : gap >= 25 ? 'Medium' : 'Low'

  return {
    id: 'property-gap',
    severity,
    category: 'Risk',
    title: `${worst.name} is converting far below ${best.name}`,
    whatHappened: `${worst.name} converts ${worst.rate.toFixed(0)}% of leads to move-ins vs. ${best.rate.toFixed(0)}% at ${best.name} — a ${gap.toFixed(0)}-point gap.`,
    why: 'Both properties are drawing from similar channels, so a gap this wide usually points to differences in follow-up speed, tour experience, or local pricing rather than lead quality.',
    impact: `Closing even half this gap at ${worst.name} would meaningfully increase move-ins without spending more on lead generation.`,
    actions: [`Review lead follow-up speed and tour process at ${worst.name}`, `Compare pricing and promotions between ${worst.name} and ${best.name}`, 'Shadow the higher-converting property\'s process for a quick audit'],
    metrics: [
      { label: `${best.name} conversion`, value: `${best.rate.toFixed(0)}%` },
      { label: `${worst.name} conversion`, value: `${worst.rate.toFixed(0)}%` },
    ],
    tab: 'leads',
  }
}

function campaignEfficiencyInsight(input) {
  const active = input.campaigns.filter((c) => c.status === 'Active' && c.conversions > 0 && c.spend > 0)
  if (active.length < 3) return null

  const withCost = active.map((c) => ({ ...c, costPerConv: c.spend / c.conversions }))
  const avgCost = withCost.reduce((a, c) => a + c.costPerConv, 0) / withCost.length
  const worst = [...withCost].sort((a, b) => b.costPerConv - a.costPerConv)[0]
  const ratio = worst.costPerConv / avgCost
  if (ratio < 1.6) return null

  const severity = ratio >= 2.2 ? 'High' : ratio >= 1.8 ? 'Medium' : 'Low'

  return {
    id: 'campaign-efficiency',
    severity,
    category: 'Efficiency',
    title: `"${worst.name}" is burning budget with a high cost per conversion`,
    whatHappened: `"${worst.name}" (${worst.facility}) costs ${formatCurrency(worst.costPerConv)} per conversion, ${Math.round((ratio - 1) * 100)}% above the ${formatCurrency(avgCost)} average across your active campaigns.`,
    why: 'A cost per conversion this far above your other active campaigns usually means broad targeting, weak ad copy, or bidding on low-intent keywords.',
    impact: 'Reallocating this budget to a better-performing campaign would generate more conversions for the same spend.',
    actions: [`Review targeting and keywords on "${worst.name}"`, 'Pause or lower the budget on this campaign', 'Shift the freed-up budget to your most efficient active campaign'],
    metrics: [
      { label: 'Campaign cost/conversion', value: formatCurrency(worst.costPerConv) },
      { label: 'Account average', value: formatCurrency(avgCost) },
    ],
    tab: 'google-ads',
  }
}

function seoOpportunityInsight(input) {
  const opp = input.seoOpportunity
  if (!opp || opp.volume < 1000 || opp.difficulty > 40) return null

  return {
    id: 'seo-opportunity',
    severity: opp.volume >= 5000 ? 'Medium' : 'Low',
    category: 'Opportunity',
    title: `"${opp.keyword}" is a high-volume keyword you're not tracking`,
    whatHappened: `"${opp.keyword}" gets ${formatNumber(opp.volume)} searches/month at a difficulty of only ${opp.difficulty} (Easy/Medium), but it isn't in your rank tracker.`,
    why: 'Low-difficulty, high-volume keywords are the most cost-effective organic opportunities — they take less content/backlink effort to rank for than competitive head terms.',
    impact: 'Ranking on page one for this term could drive meaningful organic traffic without any ad spend.',
    actions: [`Add "${opp.keyword}" to your rank tracker`, 'Create or optimize a page specifically targeting this keyword'],
    metrics: [
      { label: 'Monthly search volume', value: formatNumber(opp.volume) },
      { label: 'Keyword difficulty', value: String(opp.difficulty) },
    ],
    tab: 'seo',
  }
}

function leadResponseTimeInsight(input) {
  const { staleLeads } = input
  if (staleLeads.count === 0) return null

  const severity = staleLeads.oldestDays >= 7 ? 'High' : staleLeads.oldestDays >= 4 ? 'Medium' : 'Low'

  return {
    id: 'lead-response-time',
    severity,
    category: 'Risk',
    title: `${staleLeads.count} new lead${staleLeads.count === 1 ? '' : 's'} still waiting on first contact`,
    whatHappened: `${staleLeads.count} lead${staleLeads.count === 1 ? '' : 's'} in the "New" stage ${staleLeads.count === 1 ? 'has' : 'have'} gone ${staleLeads.oldestDays}+ days without a stage change.`,
    why: 'Leads that sit untouched lose interest quickly — response speed is one of the strongest predictors of whether a lead converts.',
    impact: 'Every day of delay lowers the odds this lead tours or moves in, and raises the odds a competitor reaches them first.',
    actions: ['Contact the oldest unattended leads today', 'Set an internal SLA for first response time', 'Consider auto-assigning new leads to reduce delay'],
    metrics: [
      { label: 'Leads awaiting contact', value: String(staleLeads.count) },
      { label: 'Oldest lead', value: `${staleLeads.oldestDays} days` },
    ],
    tab: 'leads',
  }
}

function reviewBacklogInsight(input) {
  const { agingCount } = input.reviewBacklog
  if (agingCount === 0) return null

  const severity = agingCount >= 5 ? 'High' : agingCount >= 2 ? 'Medium' : 'Low'

  return {
    id: 'review-backlog',
    severity,
    category: 'Reputation',
    title: `${agingCount} review${agingCount === 1 ? '' : 's'} overdue for a reply`,
    whatHappened: `${agingCount} review${agingCount === 1 ? '' : 's'} ${agingCount === 1 ? 'has' : 'have'} been waiting more than 48 hours for a response.`,
    why: 'Prospective tenants reading reviews often check whether a business responds, and how quickly — an aging backlog signals inattentiveness even if the reviews themselves are positive.',
    impact: 'Slow reply times reduce trust for anyone comparing you to competitors by reading reviews.',
    actions: ['Clear the oldest pending replies first', 'Approve or edit the AI-drafted replies waiting in the queue'],
    metrics: [{ label: 'Reviews overdue (48h+)', value: String(agingCount) }],
    tab: 'reputation',
  }
}

function platformRatingGapInsight(input) {
  const rated = input.platformRatings.filter((p) => p.reviews >= 5)
  if (rated.length < 2) return null

  const best = [...rated].sort((a, b) => b.rating - a.rating)[0]
  const worst = [...rated].sort((a, b) => a.rating - b.rating)[0]
  const gap = best.rating - worst.rating
  if (gap < 0.5) return null

  const severity = gap >= 1 ? 'Medium' : 'Low'

  return {
    id: 'platform-rating-gap',
    severity,
    category: 'Reputation',
    title: `${worst.platform} rating lags well behind ${best.platform}`,
    whatHappened: `${worst.platform} sits at ${worst.rating.toFixed(1)}★ vs. ${best.rating.toFixed(1)}★ on ${best.platform} — a ${gap.toFixed(1)}-star gap.`,
    why: 'A large gap between platforms usually means one platform is getting less attention for review requests or replies, not that the underlying experience differs.',
    impact: `Prospects who happen to check ${worst.platform} see a meaningfully worse impression than the rest of your reputation.`,
    actions: [`Prioritize responding to pending ${worst.platform} reviews`, `Ask recent happy customers to leave a review specifically on ${worst.platform}`],
    metrics: [
      { label: `${best.platform} rating`, value: `${best.rating.toFixed(1)}★` },
      { label: `${worst.platform} rating`, value: `${worst.rating.toFixed(1)}★` },
    ],
    tab: 'reputation',
  }
}

const RULES = [
  trafficInsight,
  leadsInsight,
  costPerLeadInsight,
  reviewRatingInsight,
  sentimentInsight,
  npsInsight,
  seoInsight,
  gbpEngagementInsight,
  leadPipelineInsight,
  adPlatformMixInsight,
  budgetPacingInsight,
  goalPacingInsight,
  bestWorstPropertyInsight,
  campaignEfficiencyInsight,
  seoOpportunityInsight,
  leadResponseTimeInsight,
  reviewBacklogInsight,
  platformRatingGapInsight,
]

const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 }

// Two or three sentences: what changed, why it matters, and the single
// highest-priority action. A real insight API should return this string
// directly rather than the UI reassembling it from separate fields.
function buildSummary(draft) {
  const action = draft.actions[0]
  if (!action) return `${draft.whatHappened} ${draft.impact}`.trim()
  const actionText = action.charAt(0).toLowerCase() + action.slice(1)
  const actionSentence = `Recommended: ${actionText}${actionText.endsWith('.') ? '' : '.'}`
  return `${draft.whatHappened} ${draft.impact} ${actionSentence}`
}

export function generateInsights(input) {
  const generatedAt = `${ANCHOR_DATE}T00:00:00Z`
  return RULES.map((rule) => rule(input))
    .filter((draft) => draft !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((draft) => ({ ...draft, summary: buildSummary(draft), generatedAt }))
}
