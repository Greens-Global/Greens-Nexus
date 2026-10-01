import { describe, it, expect, afterEach } from 'vitest';
import {
  HELP_TOPICS, topicFields, topicQuestionDefs, defaultTopicQuestions, askOnOf, labelFromKey,
} from './ticketMeta';

// A help topic's extra questions (Oct 1): an admin's own list once edited,
// the topic's area's questions until then.

afterEach(() => { HELP_TOPICS.length = 0; });

const withTopics = (topics) => HELP_TOPICS.push({ label: 'IT', departments: ['it'], topics });

describe('topic questions', () => {
  it('asks the area questions for a topic nobody edited', () => {
    withTopics([{ name: 'Cameras', area: 'security' }]);
    expect(topicFields('Cameras', 'security', 'incident').map((f) => f.key)).toEqual(['svc_facility', 'svc_deviceOrGate']);
    // Those two are incident-only.
    expect(topicFields('Cameras', 'security', 'feature_request')).toEqual([]);
  });

  it("asks the topic's own list once an admin edited it, sites as a site dropdown", () => {
    withTopics([{ name: 'Cameras', area: 'security', questions: [
      { key: 'svc_facility', label: 'Which facility?', type: 'site', req: true },
      { key: 'svc_whichCamera', label: 'Which camera?', type: 'select', options: ['Front', 'Back'], types: ['incident'] },
    ] }]);
    const asked = topicFields('cameras', 'security', 'incident');
    expect(asked.map((f) => f.label)).toEqual(['Which facility?', 'Which camera?']);
    expect(asked[0]).toMatchObject({ type: 'select', optionsFrom: 'sites', req: true });
    // "Every Type" (no types) includes Other; the camera question is incidents only.
    expect(topicFields('Cameras', 'security', 'feature_request').map((f) => f.key)).toEqual(['svc_facility']);
    expect(topicFields('Cameras', 'security', 'other').map((f) => f.key)).toEqual(['svc_facility']);
  });

  it('an empty edited list asks nothing', () => {
    withTopics([{ name: 'Cameras', area: 'security', questions: [] }]);
    expect(topicQuestionDefs('Cameras', 'security')).toEqual([]);
  });

  it('turns area questions into the stored shape for the editor', () => {
    const qs = defaultTopicQuestions('security');
    expect(qs[0]).toMatchObject({ key: 'svc_facility', type: 'site', types: ['incident'] });
    expect(qs[0].optionsFrom).toBeUndefined();
    expect(askOnOf(qs[0].types)).toBe('incident');
    expect(askOnOf(undefined)).toBe('all');
  });

  it('labels an answer whose question was removed from its key', () => {
    expect(labelFromKey('svc_whichDoor')).toBe('Which door');
  });
});
