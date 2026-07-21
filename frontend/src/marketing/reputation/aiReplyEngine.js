// --- Company knowledge base (the "system prompt" layer) --------------------
// Tone: warm, professional, solutions-oriented, concise. Thank/acknowledge
// before addressing substance. Never defensive. Always offer a concrete next
// step for anything below a 5-star experience.
export const COMPANY = {
  name: 'Greens Storage',
  phone: '(916) 555-1234',
}

function sentimentKey(sentiment) {
  return sentiment === 'Positive' ? 'positive' : sentiment === 'Neutral' ? 'neutral' : 'negative'
}

// --- Storage-industry topic table ------------------------------------------
// Each topic pairs keyword triggers (matched against the reviewer's own
// words) with ready-made, on-brand sentences per sentiment that name the
// topic specifically — this is what keeps a reply from reading generically.
const TOPICS = [
  {
    key: 'access',
    keywords: ['gate', 'access', 'hour', 'entry', 'lock'],
    lines: {
      positive: [
        "We're so glad our 24/7 gate access made things convenient for you.",
        'Great to hear our access hours worked well for your schedule.',
        "It's always nice to know the gate and entry setup made life easier, not harder.",
      ],
      neutral: [
        "Thanks for the note on gate access — we're always fine-tuning our entry system.",
        'We appreciate you flagging the access hours — good context for us as we plan any changes.',
        "Noted on the gate access — we'll keep that in mind as we look at improvements.",
      ],
      negative: [
        `We're sorry the gate access gave you trouble. Please call us at ${COMPANY.phone} so we can look into what happened.`,
        `That's not the reliability we want from our gate system — reach out at ${COMPANY.phone} and we'll get it sorted.`,
        `An access issue like that shouldn't happen, and we want to fix it — give us a call at ${COMPANY.phone} when you get a chance.`,
      ],
    },
  },
  {
    key: 'climate',
    keywords: ['climate', 'temperature', 'humid', 'ac ', 'heat', 'musty', 'smell', 'mold', 'mildew'],
    lines: {
      positive: [
        'Glad our climate-controlled units kept your things in great shape.',
        "It's wonderful to hear the climate control made a difference for your belongings.",
        'Happy to know the unit conditions gave you real peace of mind.',
      ],
      neutral: [
        'We appreciate the note on climate and unit conditions — always something we monitor closely.',
        'Thanks for mentioning the unit conditions — we keep a close eye on that across every facility.',
        "Good to know, and we'll keep watching the climate control on our end.",
      ],
      negative: [
        `We're sorry to hear about the smell/humidity issue — that's not acceptable, and we'd like to make it right. Please call ${COMPANY.phone}.`,
        `Unit conditions are something we take seriously. Reach out at ${COMPANY.phone} so we can inspect and resolve this.`,
        `That's a real concern, and we want to get it fixed quickly — call us at ${COMPANY.phone} so we can send someone to inspect the unit.`,
      ],
    },
  },
  {
    key: 'pricing',
    keywords: ['price', 'pricing', 'rate', 'cost', 'expensive', 'fee', 'charge'],
    lines: {
      positive: [
        "We're happy our rates felt like a good value for what you needed.",
        'Glad the pricing felt fair for the space and service you got.',
        "It means a lot to hear the value stood out to you.",
      ],
      neutral: [
        'We strive to keep our rates competitive while continuing to invest in the facility — thanks for the honest feedback.',
        "We hear you on pricing, and we're always weighing that against the upgrades we're making.",
        'Appreciate you being upfront about the rates — that feedback genuinely helps us plan ahead.',
      ],
      negative: [
        `We're sorry the rate increase came as a surprise — we aim to communicate these clearly, and we'd like to hear more. Call us at ${COMPANY.phone}.`,
        `That's fair feedback, and we want to do better on communicating pricing changes — reach out at ${COMPANY.phone} so we can talk it through.`,
        `We understand rate changes are frustrating without a heads-up. Call ${COMPANY.phone} and we'll go over the details with you directly.`,
      ],
    },
  },
  {
    key: 'staff',
    keywords: ['staff', 'help', 'friendly', 'rude', 'manager', 'employee', 'service'],
    lines: {
      positive: [
        "We'll be sure to pass along your kind words to our team — they'll be thrilled to hear it.",
        'Our team works hard to make every visit easy, and we love that it showed.',
        'Comments like this make our team\'s day — thank you for taking the time to share it.',
      ],
      neutral: [
        'Thanks for the note about our team — we always share feedback with them directly.',
        'We appreciate the honest read on our service — it goes straight to the team.',
        "Good to know how the team came across — we'll pass this along.",
      ],
      negative: [
        `That's not the level of service we expect from our team, and we're sorry you experienced it. Please call ${COMPANY.phone} so we can follow up directly.`,
        `We take feedback about our team seriously and want to make this right — reach us at ${COMPANY.phone}.`,
        `That falls short of what we expect from our staff. Please call ${COMPANY.phone} so we can address it with the team directly.`,
      ],
    },
  },
  {
    key: 'security',
    keywords: ['security', 'camera', 'safe', 'theft', 'break-in', 'break in', 'unsafe'],
    lines: {
      positive: [
        'So glad our security measures gave you peace of mind.',
        'Happy to hear the cameras and site security made you feel comfortable storing with us.',
        "It's great to know the security setup came through for you.",
      ],
      neutral: [
        'We appreciate the note on security — keeping the property safe is always a top priority.',
        'Thanks for the feedback on security — we review this regularly across our sites.',
        "Noted on the security setup — we're always looking at ways to strengthen it.",
      ],
      negative: [
        `Security concerns are something we take extremely seriously. Please call us right away at ${COMPANY.phone} so we can look into this immediately.`,
        `We want you to feel completely safe storing with us — call ${COMPANY.phone} right away so we can investigate this.`,
        `This is a priority for us to resolve. Please contact us at ${COMPANY.phone} as soon as you can so we can look into it.`,
      ],
    },
  },
  {
    key: 'moveIn',
    keywords: ['move-in', 'move in', 'moving', 'lease', 'sign up', 'reserve'],
    lines: {
      positive: [
        'So glad we could make your move-in quick and painless.',
        'Happy to hear the move-in process went smoothly for you.',
        'Great to know signing up and getting settled in was easy.',
      ],
      neutral: [
        'Thanks for sharing your move-in experience — always looking for ways to make it smoother.',
        'We appreciate the feedback on the move-in process — helps us spot where to improve.',
        "Good to hear how the move-in went — we're always refining that process.",
      ],
      negative: [
        `Sorry your move-in wasn't as smooth as it should've been — please call ${COMPANY.phone} so we can help sort it out.`,
        `That's not the first impression we want to give — reach out at ${COMPANY.phone} and we'll make it right.`,
        `We're sorry the move-in process fell short. Call ${COMPANY.phone} so we can understand what happened and fix it.`,
      ],
    },
  },
  {
    key: 'process',
    keywords: ['cart', 'checkout', 'wait', 'line', 'paperwork', 'process'],
    lines: {
      positive: [
        'Glad the process was quick and easy for you.',
        'Happy to hear everything moved along smoothly without any hassle.',
        "It's great to know the day-to-day process worked well for you.",
      ],
      neutral: [
        "Thanks for flagging that — we're always looking at ways to speed up the day-to-day process.",
        'We appreciate the note — small friction points like that are exactly what we want to hear about.',
        "Good feedback on the process — we'll keep looking at ways to streamline it.",
      ],
      negative: [
        `Sorry for the wait — that's not the experience we want. We'd love your input at ${COMPANY.phone} on how to speed things up.`,
        `That kind of delay shouldn't happen, and we're sorry it did — call ${COMPANY.phone} so we can look into it.`,
        `We hear you on the wait time — reach out at ${COMPANY.phone} so we can make sure it doesn't happen again.`,
      ],
    },
  },
  {
    key: 'unitSize',
    keywords: ['unit size', 'fit', 'too small', 'too big', '10x10', '5x5', 'size'],
    lines: {
      positive: [
        'Glad we could help you find the right size unit for your needs.',
        "It's great to hear the unit size worked out just right for what you needed to store.",
        'Happy to know the sizing ended up being a good fit.',
      ],
      neutral: [
        'Thanks for the feedback on unit sizing — always happy to help you find a better fit if needed.',
        'We appreciate you sharing that — sizing is something we like to get right for every customer.',
        "Good to know how the unit size worked out — let us know if you'd ever like to explore other options.",
      ],
      negative: [
        `Sorry the unit size didn't work out as expected — give us a call at ${COMPANY.phone} and we'll help find a better fit.`,
        `We want your unit to actually work for your needs — reach out at ${COMPANY.phone} so we can find something better suited.`,
        `That's frustrating, and we'd like to help fix it — call ${COMPANY.phone} and we'll look at sizing options with you.`,
      ],
    },
  },
  // Fallback when nothing else matches — still on-brand, not a canned line.
  {
    key: 'general',
    keywords: [],
    lines: {
      positive: [
        'Thrilled to hear you had such a smooth experience with us.',
        'So happy everything went well for you!',
        'Reviews like this make our whole team\'s day.',
      ],
      neutral: [
        'We appreciate you taking the time to share your thoughts with us.',
        'Thanks for the honest feedback — it genuinely helps us improve.',
        'We read every review closely, and yours is no exception.',
      ],
      negative: [
        `We're sorry your experience fell short of what we aim for. Please reach out to us at ${COMPANY.phone} so we can make this right.`,
        `That's not the standard we hold ourselves to, and we'd like to fix it — call ${COMPANY.phone} when you can.`,
        `We appreciate you telling us this directly. Please reach out at ${COMPANY.phone} so we can understand what happened.`,
      ],
    },
  },
]

// Short, secondary acknowledgment used when a review touches on a second
// topic — keeps the reply concrete about more of what was actually said
// without stacking two full sentences and making it read like a form letter.
const SECONDARY_MENTION = {
  positive: (label) => `Glad the ${label} stood out for you too.`,
  neutral: (label) => `We also noted what you shared about ${label}.`,
  negative: (label) => `We also want to make sure we address the ${label} you mentioned.`,
}

function detectTopics(reviewText) {
  const lower = reviewText.toLowerCase()
  const matches = TOPICS
    .filter((t) => t.key !== 'general')
    .map((t) => ({ topic: t, index: Math.min(...t.keywords.map((k) => lower.indexOf(k)).filter((i) => i >= 0)) }))
    .filter((m) => Number.isFinite(m.index))
    .sort((a, b) => a.index - b.index)
    .map((m) => m.topic)
  return matches.length > 0 ? matches : [TOPICS[TOPICS.length - 1]]
}

const TOPIC_LABELS = {
  access: 'gate access',
  climate: 'climate control',
  pricing: 'pricing',
  staff: 'staff & service',
  security: 'security',
  moveIn: 'the move-in experience',
  process: 'checkout/process speed',
  unitSize: 'unit sizing',
}

// Reused by the Insights AI-analyst engine to explain *why* a rating or
// sentiment shift happened — tallies which storage-industry topics show up
// most often across a set of review texts (excluding the generic fallback).
export function topicFrequency(reviewTexts) {
  const counts = new Map()
  for (const text of reviewTexts) {
    const topic = detectTopics(text)[0]
    if (topic.key === 'general') continue
    counts.set(topic.key, (counts.get(topic.key) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: TOPIC_LABELS[key] ?? key, count }))
    .sort((a, b) => b.count - a.count)
}

// --- Greeting / sign-off (brand voice bookends) -----------------------------
const GREETINGS = {
  positive: ['Thank you so much', 'We really appreciate you', "Thanks so much for this"],
  neutral: ['Thanks for your feedback', 'We appreciate the honest feedback', 'Thanks for sharing this'],
  negative: ['Thank you for letting us know', 'We hear you', 'Thank you for flagging this'],
}

const SIGNOFFS = {
  positive: (facility) => [
    `We'll be sure to pass this along to the ${facility} team!`,
    'Reviews like yours make our day.',
    'We hope to see you again soon!',
  ],
  neutral: (facility) => [
    `We're always working to improve at ${facility}.`,
    'Thanks again for helping us get better.',
    "We take feedback like this seriously and act on it where we can.",
  ],
  negative: (facility) => [
    `This isn't the standard we hold ${facility} to, and we want to fix it.`,
    'We appreciate you giving us the chance to make this right.',
    "We won't consider this resolved until you're satisfied.",
  ],
}

function pickVariant(items, index) {
  return items[((index % items.length) + items.length) % items.length]
}

// --- Staged composition (the "prompt workflow") -----------------------------
// 1. Greeting        — sentiment-appropriate opener + name
// 2. Acknowledgment   — the topic-specific line(s) detected from the review
//                       text, in the order the customer actually raised them
// 3. Resolution       — baked into the topic line(s) above (thanks / openness / fix)
// 4. Sign-off         — consistent brand voice closer
export function generateAiReply(input) {
  const { sentiment, facility, name, reviewText, variantIndex } = input
  const sKey = sentimentKey(sentiment)
  const [primaryTopic, secondaryTopic] = detectTopics(reviewText)

  const greeting = pickVariant(GREETINGS[sKey], variantIndex)
  const primaryLine = pickVariant(primaryTopic.lines[sKey], variantIndex + 7)
  const signoff = pickVariant(SIGNOFFS[sKey](facility), variantIndex + 13)

  const secondaryLine = secondaryTopic && secondaryTopic.key !== primaryTopic.key
    ? SECONDARY_MENTION[sKey](TOPIC_LABELS[secondaryTopic.key] ?? secondaryTopic.key)
    : null

  const punctuation = sKey === 'positive' ? '!' : '.'
  const body = [primaryLine, secondaryLine, signoff].filter(Boolean).join(' ')
  return `${greeting}, ${name}${punctuation} ${body}`
}

export function replyVariationCount() {
  return 4
}
