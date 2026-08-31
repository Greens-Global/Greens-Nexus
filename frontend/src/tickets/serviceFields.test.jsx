// Ticket intake, Aug 2026: the application picked at step 1 decides the service
// area, and the service area decides which extra questions step 2 asks. These
// cover the config layer and the two behaviours that are easy to get wrong -
// group-headers in the app picker, and a required field whose option list is
// empty (an inescapable form).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchSelect } from '../tasks/components';
import {
  SERVICE_AREAS, SERVICE_FIELDS, serviceAreaLabel, serviceFields, withDynamicOptions,
  intakeFields, TYPE_FIELDS, TICKET_TYPE_ORDER, TICKET_TYPE_META, NO_RECORDING_TYPES,
  serviceFieldApplies,
} from './ticketMeta';

describe('service areas', () => {
  it('keeps General as the fallback every unmapped app resolves to', () => {
    expect(SERVICE_AREAS.some((a) => a.key === 'general')).toBe(true);
  });

  it('has a unique key per area', () => {
    const keys = SERVICE_AREAS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names an area, and says nothing for one it does not know', () => {
    expect(serviceAreaLabel('security')).toBe('Security & Cameras');
    expect(serviceAreaLabel('')).toBe('');
    expect(serviceAreaLabel(undefined)).toBe('');
    expect(serviceAreaLabel('not-an-area')).toBe('');
  });

  it('only defines fields for areas that exist', () => {
    const known = new Set(SERVICE_AREAS.map((a) => a.key));
    Object.keys(SERVICE_FIELDS).forEach((k) => expect(known.has(k)).toBe(true));
  });

  it('prefixes every service field key, so it can never collide with a type field', () => {
    const typeKeys = new Set(Object.values(TYPE_FIELDS).flat().map((f) => f.key));
    Object.values(SERVICE_FIELDS).flat().forEach((f) => {
      expect(f.key.startsWith('svc_')).toBe(true);
      expect(typeKeys.has(f.key)).toBe(false);
    });
  });

  it('asks at most two questions in any one area', () => {
    Object.values(SERVICE_FIELDS).forEach((fields) => expect(fields.length).toBeLessThanOrEqual(2));
  });

  it('asks nothing at all for the areas the app name already answers', () => {
    ['collab', 'tasks', 'knowledge', 'finance', 'hr', 'assets', 'general'].forEach((area) => {
      expect(serviceFields(area, 'incident')).toEqual([]);
    });
  });

  it('returns nothing for an unknown or missing area rather than throwing', () => {
    expect(serviceFields('nope', 'incident')).toEqual([]);
    expect(serviceFields('', 'incident')).toEqual([]);
    expect(serviceFields(undefined, 'incident')).toEqual([]);
  });

  it('returns nothing until a type is chosen - the type is half the decision', () => {
    expect(serviceFields('security')).toEqual([]);
    expect(serviceFields('security', '')).toEqual([]);
  });
});

// The bug this fixes: a required "Facility" sat on EVERY type, so someone
// asking for a report to be reworded was made to name a storage site.
describe('service questions depend on the type, not just the app', () => {
  const keys = (area, type) => serviceFields(area, type).map((f) => f.key);

  it('asks which facility when something is broken there', () => {
    expect(keys('security', 'incident')).toEqual(['svc_facility', 'svc_deviceOrGate']);
    expect(keys('storageops', 'incident')).toEqual(['svc_facility', 'svc_unit']);
    expect(keys('network', 'incident')).toEqual(['svc_facility', 'svc_connection']);
  });

  it('never asks a place question on a software-shaped ticket', () => {
    ['bug', 'service_request', 'access_request', 'change_request', 'other'].forEach((type) => {
      ['security', 'storageops', 'network'].forEach((area) => {
        expect(keys(area, type), `${area}/${type}`).not.toContain('svc_facility');
      });
    });
  });

  it('leaves a change request with no service questions in any physical area', () => {
    ['security', 'storageops', 'network'].forEach((area) => {
      expect(keys(area, 'change_request')).toEqual([]);
    });
  });

  it('still asks which device on a request for one - a device is a thing, not a place', () => {
    expect(keys('hardware', 'service_request')).toEqual(['svc_device']);
    expect(keys('hardware', 'incident')).toEqual(['svc_device', 'svc_assetTag']);
    // You only have an asset tag for kit you already hold.
    expect(keys('hardware', 'service_request')).not.toContain('svc_assetTag');
  });

  it('does not ask whose account on the types that already ask who it is for', () => {
    expect(keys('email', 'incident')).toEqual(['svc_account']);
    expect(keys('email', 'service_request')).toEqual([]);
    expect(keys('email', 'access_request')).toEqual([]);
  });

  it('asks the area-wide questions on every type except Other', () => {
    ['incident', 'bug', 'service_request', 'access_request', 'change_request']
      .forEach((type) => expect(keys('files', type), type).toEqual(['svc_folderPath']));
    expect(keys('files', 'other')).toEqual([]);
    expect(keys('web', 'other')).toEqual([]);
  });

  it('asks Other nothing at all, in every area', () => {
    Object.keys(SERVICE_FIELDS).forEach((area) => expect(keys(area, 'other'), area).toEqual([]));
  });

  it('never asks more than two service questions for any pairing', () => {
    Object.keys(SERVICE_FIELDS).forEach((area) => {
      TICKET_TYPE_ORDER.forEach((type) => {
        expect(serviceFields(area, type).length, `${area}/${type}`).toBeLessThanOrEqual(2);
      });
    });
  });

  it('only ever names types that are actually on offer', () => {
    Object.values(SERVICE_FIELDS).flat().forEach((f) => {
      (f.types || []).forEach((t) => expect(TICKET_TYPE_ORDER, `${f.key} -> ${t}`).toContain(t));
    });
  });

  it('agrees with serviceFieldApplies, which is what the drawer reads back with', () => {
    const facility = SERVICE_FIELDS.security[0];
    expect(serviceFieldApplies(facility, 'incident')).toBe(true);
    expect(serviceFieldApplies(facility, 'change_request')).toBe(false);
    const folder = SERVICE_FIELDS.files[0];
    expect(serviceFieldApplies(folder, 'change_request')).toBe(true);
    expect(serviceFieldApplies(folder, 'other')).toBe(false);
  });
});

describe('dynamic options', () => {
  const sites = [{ id: '1', name: 'Escondido (GSE)' }, { id: '2', name: 'Murrieta (GSM)' }];

  it('fills a site-backed select from the work-site list', () => {
    const [facility] = withDynamicOptions(serviceFields('storageops', 'incident'), { sites });
    expect(facility.options).toEqual(['Escondido (GSE)', 'Murrieta (GSM)']);
    expect(facility.req).toBe(true);
  });

  it('drops the requirement when there are no sites - a required field with nothing to pick is an inescapable form', () => {
    const [facility] = withDynamicOptions(serviceFields('security', 'incident'), { sites: [] });
    expect(facility.options).toEqual([]);
    expect(facility.req).toBe(false);
  });

  it('survives being called with no sites argument at all', () => {
    const [facility] = withDynamicOptions(serviceFields('network', 'incident'));
    expect(facility.options).toEqual([]);
    expect(facility.req).toBe(false);
  });

  it('leaves fields that carry their own options alone', () => {
    const [device] = withDynamicOptions(serviceFields('hardware', 'incident'), { sites });
    expect(device.options).toContain('Printer');
    expect(device.req).toBe(true);
  });

  it('does not mutate the definitions it was given', () => {
    const before = serviceFields('storageops', 'incident');
    withDynamicOptions(before, { sites });
    expect(before[0].options).toBeUndefined();
  });
});

// Aug 31 2026: six types, and every question rewritten for someone who does not
// work in IT. The rules that must not regress are (a) the six are all offered,
// (b) nothing asks for developer-speak any more, and (c) no definition was
// DELETED - a retired one still has to render the answer an old ticket holds.
describe('intake types', () => {
  const INTAKE = ['incident', 'bug', 'service_request', 'access_request', 'change_request', 'other'];

  it('offers all six, in the order a requester scans them', () => {
    expect(TICKET_TYPE_ORDER).toEqual(INTAKE);
  });

  it('gives every offered type a label and a plain-English hint', () => {
    TICKET_TYPE_ORDER.forEach((t) => {
      expect(TICKET_TYPE_META[t].label).toBeTruthy();
      expect(TICKET_TYPE_META[t].hint).toBeTruthy();
    });
  });

  it('asks at most four questions per type, and at most two required', () => {
    TICKET_TYPE_ORDER.forEach((t) => {
      const f = intakeFields(t);
      expect(f.length, `${t} question count`).toBeLessThanOrEqual(t === 'access_request' ? 5 : 4);
      expect(f.filter((x) => x.req).length, `${t} required count`).toBeLessThanOrEqual(2);
    });
  });

  it('no longer asks anyone for developer-speak', () => {
    const asked = TICKET_TYPE_ORDER.flatMap((t) => intakeFields(t).map((f) => f.key));
    ['severity', 'browser', 'os', 'actualResult', 'environment', 'riskAssessment',
      'rollbackPlan', 'downtimeRequired', 'affectedSystem', 'affectedService',
      'affectedUsers', 'workaroundAvailable', 'workaroundDetail', 'estimatedCost',
      'location', 'approver', 'managerApproval', 'startDate',
    ].forEach((k) => expect(asked, `still asks ${k}`).not.toContain(k));
  });

  it('never shows a raw "Business Justification" style label', () => {
    const labels = TICKET_TYPE_ORDER.flatMap((t) => intakeFields(t).map((f) => f.label));
    expect(labels).not.toContain('Business Justification');
    expect(labels).not.toContain('Steps to Reproduce');
    expect(labels).not.toContain('Delivery Location');
  });

  it('stops asking for the app in a text box, on every type that did', () => {
    expect(intakeFields('bug').map((f) => f.key)).not.toContain('module');
    expect(intakeFields('access_request').map((f) => f.key)).not.toContain('application');
    expect(intakeFields('incident').map((f) => f.key)).not.toContain('affectedService');
    expect(intakeFields('change_request').map((f) => f.key)).not.toContain('affectedSystem');
  });

  it('retires definitions rather than deleting them, so old answers still render', () => {
    const retired = (t, k) => TYPE_FIELDS[t].find((f) => f.key === k)?.retired;
    expect(retired('bug', 'module')).toBe(true);
    expect(retired('bug', 'severity')).toBe(true);
    expect(retired('bug', 'actualResult')).toBe(true);
    expect(retired('access_request', 'application')).toBe(true);
    expect(retired('access_request', 'environment')).toBe(true);
    expect(retired('change_request', 'rollbackPlan')).toBe(true);
    expect(retired('incident', 'workaroundAvailable')).toBe(true);
    expect(retired('service_request', 'location')).toBe(true);
  });

  it('keeps a retired radio on its original options, so stored values still match', () => {
    expect(TYPE_FIELDS.bug.find((f) => f.key === 'severity').options)
      .toEqual(['Minor', 'Major', 'Critical', 'Blocker']);
    expect(TYPE_FIELDS.access_request.find((f) => f.key === 'accessType').options)
      .toEqual(['Read', 'Write', 'Admin']);
  });

  it('asks each type the question that defines it', () => {
    expect(intakeFields('incident').map((f) => f.key)).toEqual(
      ['impact', 'occurredAt', 'workedBefore', 'errorMessage']);
    expect(intakeFields('bug').map((f) => f.key)).toEqual(
      ['stepsToReproduce', 'expectedResult', 'reproducibility', 'errorMessage']);
    expect(intakeFields('service_request').map((f) => f.key)).toEqual(
      ['requestedService', 'requestedFor', 'businessJustification', 'requiredBy']);
    expect(intakeFields('access_request').map((f) => f.key)).toEqual(
      ['requestKind', 'user', 'accessType', 'reason', 'endDate']);
    expect(intakeFields('change_request').map((f) => f.key)).toEqual(
      ['currentConfiguration', 'requestedChange', 'reason', 'implementationDate']);
    expect(intakeFields('other')).toEqual([]);
  });

  it('offers screen recording only for the two types you can demonstrate', () => {
    const canRecord = TICKET_TYPE_ORDER.filter((t) => !NO_RECORDING_TYPES.includes(t));
    expect(canRecord).toEqual(['incident', 'bug']);
  });
});

// The app picker is a SearchSelect with group captions. Headers must not be
// pickable - clicking "All applications" would file a ticket against a
// heading - and must not survive a search, which would leave a caption
// stranded over a group that matched nothing.
describe('grouped picker', () => {
  const OPTIONS = [
    { id: '__h1', label: 'Used by IT', header: true },
    { id: 'Egnyte', label: 'Egnyte' },
    { id: '__h2', label: 'All applications', header: true },
    { id: 'Ramp', label: 'Ramp' },
  ];
  const setup = (onPick = vi.fn()) => {
    render(<SearchSelect options={OPTIONS} value="" onPick={onPick}
      placeholder="Select application" searchPlaceholder="Search applications…" />);
    fireEvent.click(screen.getByText('Select application'));
    return onPick;
  };

  it('shows the captions above their groups', () => {
    setup();
    expect(screen.getByText('Used by IT')).toBeTruthy();
    expect(screen.getByText('All applications')).toBeTruthy();
  });

  it('does not report a caption as a pick', () => {
    const onPick = setup();
    fireEvent.click(screen.getByText('All applications'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('still picks a real application', () => {
    const onPick = setup();
    fireEvent.click(screen.getByText('Egnyte'));
    expect(onPick).toHaveBeenCalledWith('Egnyte');
  });

  it('drops the captions once you search', () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText('Search applications…'), { target: { value: 'ramp' } });
    expect(screen.getByText('Ramp')).toBeTruthy();
    expect(screen.queryByText('Used by IT')).toBeNull();
    expect(screen.queryByText('All applications')).toBeNull();
  });
});
