// Mirrors the real Google Business Profile API (mybusiness.googleapis.com /
// businessprofileperformance) resources for managing listing content:
// accounts.locations.localPosts, accounts.locations.media, and the Q&A
// resource. When the real API is wired in, only the fetch*Report()
// functions in gbpContentData.ts need to change — these adapters already
// know how to read that exact JSON.

export function adaptPosts(posts) {
  return posts.map((p) => ({
    // The full resource name (not just its trailing segment) is what's
    // globally unique — each facility's mock IDs restart from 1, so slicing
    // down to the last path segment alone would collide across facilities.
    id: p.name,
    facility: p.locationId,
    type: p.topicType,
    text: p.summary,
    imageUrl: p.media?.[0]?.sourceUrl,
    ctaLabel: p.callToAction?.actionType,
    ctaUrl: p.callToAction?.url,
    createdDate: p.createTime.slice(0, 10),
    expiresDate: p.updateTime.slice(0, 10),
    status: p.state,
  }))
}

export function adaptPhotos(media) {
  return media.map((m) => ({
    id: m.name,
    facility: m.locationId,
    url: m.sourceUrl,
    category: m.locationAssociation.category,
    uploadedDate: m.createTime.slice(0, 10),
  }))
}

export function adaptQuestions(questions) {
  return questions.map((q) => {
    const topAnswer = q.topAnswers?.[0]
    return {
      id: q.name,
      facility: q.locationId,
      question: q.text,
      askedBy: q.author,
      askedDate: q.createTime.slice(0, 10),
      answer: topAnswer?.text ?? null,
      answeredDate: topAnswer ? topAnswer.createTime.slice(0, 10) : null,
    }
  })
}
