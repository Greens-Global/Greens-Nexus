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
      ],
      neutral: ['Thanks for the note on gate access — we\'re always fine-tuning our entry system.'],
      negative: [
        `We're sorry the gate access gave you trouble. Please call us at ${COMPANY.phone} so we can look into what happened.`,
        `That's not the reliability we want from our gate system — reach out at ${COMPANY.phone} and we'll get it sorted.`,
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
      ],
      neutral: ['We appreciate the note on climate and unit conditions — always something we monitor closely.'],
      negative: [
        `We're sorry to hear about the smell/humidity issue — that's not acceptable, and we'd like to make it right. Please call ${COMPANY.phone}.`,
        `Unit conditions are something we take seriously. Reach out at ${COMPANY.phone} so we can inspect and resolve this.`,
      ],
    },
  },
  {
    key: 'pricing',
    keywords: ['price', 'pricing', 'rate', 'cost', 'expensive', 'fee', 'charge'],
    lines: {
      positive: ["We're happy our rates felt like a good value for what you needed."],
      neutral: [
        'We strive to keep our rates competitive while continuing to invest in the facility — thanks for the honest feedback.',
        "We hear you on pricing, and we're always weighing that against the upgrades we're making.",
      ],
      negative: [
        `We're sorry the rate increase came as a surprise — we aim to communicate these clearly, and we'd like to hear more. Call us at ${COMPANY.phone}.`,
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
      ],
      neutral: ['Thanks for the note about our team — we always share feedback with them directly.'],
      negative: [
        `That's not the level of service we expect from our team, and we're sorry you experienced it. Please call ${COMPANY.phone} so we can follow up directly.`,
      ],
    },
  },
  {
    key: 'security',
    keywords: ['security', 'camera', 'safe', 'theft', 'break-in', 'break in', 'unsafe'],
    lines: {
      positive: ['So glad our security measures gave you peace of mind.'],
      neutral: ['We appreciate the note on security — keeping the property safe is always a top priority.'],
      negative: [
        `Security concerns are something we take extremely seriously. Please call us right away at ${COMPANY.phone} so we can look into this immediately.`,
      ],
    },
  },
  {
    key: 'moveIn',
    keywords: ['move-in', 'move in', 'moving', 'lease', 'sign up', 'reserve'],
    lines: {
      positive: ['So glad we could make your move-in quick and painless.'],
      neutral: ['Thanks for sharing your move-in experience — always looking for ways to make it smoother.'],
      negative: [`Sorry your move-in wasn't as smooth as it should've been — please call ${COMPANY.phone} so we can help sort it out.`],
    },
  },
  {
    key: 'process',
    keywords: ['cart', 'checkout', 'wait', 'line', 'paperwork', 'process'],
    lines: {
      positive: ['Glad the process was quick and easy for you.'],
      neutral: [
        "Thanks for flagging that — we're always looking at ways to speed up the day-to-day process.",
      ],
      negative: [`Sorry for the wait — that's not the experience we want. We'd love your input at ${COMPANY.phone} on how to speed things up.`],
    },
  },
  {
    key: 'unitSize',
    keywords: ['unit size', 'fit', 'too small', 'too big', '10x10', '5x5', 'size'],
    lines: {
      positive: ['Glad we could help you find the right size unit for your needs.'],
      neutral: ['Thanks for the feedback on unit sizing — always happy to help you find a better fit if needed.'],
      negative: [`Sorry the unit size didn't work out as expected — give us a call at ${COMPANY.phone} and we'll help find a better fit.`],
    },
  },
  // Fallback when nothing else matches — still on-brand, not a canned line.
  {
    key: 'general',
    keywords: [],
    lines: {
      positive: ['Thrilled to hear you had such a smooth experience with us.', 'So happy everything went well for you!'],
      neutral: ['We appreciate you taking the time to share your thoughts with us.'],
      negative: [`We're sorry your experience fell short of what we aim for. Please reach out to us at ${COMPANY.phone} so we can make this right.`],
    },
  },
]

function detectTopic(reviewText) {
  const lower = reviewText.toLowerCase()
  const match = TOPICS.find((t) => t.key !== 'general' && t.keywords.some((k) => lower.includes(k)))
  return match ?? TOPICS[TOPICS.length - 1]
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
    const topic = detectTopic(text)
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
  neutral: (facility) => [`We're always working to improve at ${facility}.`, 'Thanks again for helping us get better.'],
  negative: (facility) => [
    `This isn't the standard we hold ${facility} to, and we want to fix it.`,
    'We appreciate you giving us the chance to make this right.',
  ],
}

function pickVariant(items, index) {
  return items[((index % items.length) + items.length) % items.length]
}

// --- Staged composition (the "prompt workflow") -----------------------------
// 1. Greeting      — sentiment-appropriate opener + name
// 2. Acknowledgment — the topic-specific line detected from the review text
// 3. Resolution     — baked into the topic line above (thanks / openness / fix)
// 4. Sign-off       — consistent brand voice closer
export function generateAiReply(input) {
  const { sentiment, facility, name, reviewText, variantIndex } = input
  const sKey = sentimentKey(sentiment)
  const topic = detectTopic(reviewText)

  const greeting = pickVariant(GREETINGS[sKey], variantIndex)
  const topicLine = pickVariant(topic.lines[sKey], variantIndex + 7)
  const signoff = pickVariant(SIGNOFFS[sKey](facility), variantIndex + 13)

  const punctuation = sKey === 'positive' ? '!' : '.'
  return `${greeting}, ${name}${punctuation} ${topicLine} ${signoff}`
}

export function replyVariationCount() {
  return 4
}
