import { describe, it, expect, afterEach } from 'vitest';
import { HELP_TOPICS, topicQuestionDefs, allTopicQuestionDefs, labelFromKey } from './ticketMeta';

// Submit a Ticket asks no follow-up questions per topic any more (Oct 1); these
// helpers are how the drawer still labels the answers older tickets hold.

afterEach(() => { HELP_TOPICS.length = 0; });

const withTopics = (topics) => HELP_TOPICS.push({ label: 'IT', departments: ['it'], topics });

describe('follow-up answers on older tickets', () => {
  it("labels a ticket's answers from its topic's area questions", () => {
    withTopics([{ name: 'Cameras', area: 'security' }]);
    expect(topicQuestionDefs('Cameras', 'security').map((f) => f.key)).toEqual(['svc_facility', 'svc_deviceOrGate']);
  });

  it("labels them from a topic's own saved list, a site question as a site dropdown", () => {
    withTopics([{ name: 'Cameras', area: 'security', questions: [
      { key: 'svc_facility', label: 'Which facility?', type: 'site', req: true },
    ] }]);
    expect(topicQuestionDefs('cameras', 'security')[0]).toMatchObject({ label: 'Which facility?', type: 'select', optionsFrom: 'sites' });
    expect(allTopicQuestionDefs().map((f) => f.key)).toEqual(['svc_facility']);
  });

  it('labels an answer whose question is gone from its key', () => {
    expect(labelFromKey('svc_whichDoor')).toBe('Which door');
  });
});
