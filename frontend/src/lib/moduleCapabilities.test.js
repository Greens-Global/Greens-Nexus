import { describe, it, expect } from 'vitest';
import { MODULES } from '../contexts/RoleContext';
import { MODULE_CAPABILITIES, capabilityText, tierText, SUPER_LINE } from './moduleCapabilities';

// Three grant levels (11/2026): every module a role can grant spells out
// Viewer / Editor / Full; a legacy 'owner' reads as Full; the tier lines end
// with the Super Administrator line.
const GRANTABLE = MODULES.filter(m => !['admin', 'roles-access', 'hr_comp'].includes(m.id));

describe('moduleCapabilities', () => {
  it('has viewer / editor / full text for every grantable module', () => {
    for (const m of GRANTABLE) {
      const caps = MODULE_CAPABILITIES[m.id];
      expect(caps, m.id).toBeTruthy();
      for (const level of ['viewer', 'editor', 'full']) {
        expect(typeof caps[level], `${m.id}.${level}`).toBe('string');
        expect(caps[level].length, `${m.id}.${level}`).toBeGreaterThan(0);
        expect(capabilityText(m.id, level, m.label)).toBe(caps[level]);
      }
      expect(caps.owner).toBeUndefined();
    }
  });

  it('reads a legacy owner level as Full', () => {
    for (const m of GRANTABLE) {
      expect(capabilityText(m.id, 'owner', m.label)).toBe(capabilityText(m.id, 'full', m.label));
    }
  });

  it('ends every tier list with the Super Administrator line, lowest tier first', () => {
    for (const m of GRANTABLE) {
      const lines = tierText(m.id);
      expect(lines.at(-1)).toBe(SUPER_LINE);
    }
    expect(tierText('operations').slice(0, 3).map(l => l.split(' - ')[0]))
      .toEqual(['Supervisor tier', 'Manager tier', 'Administrator tier']);
    expect(tierText('tickets')).toContain("Manager tier - desk departments, routing and notification settings");
    expect(MODULE_CAPABILITIES.tickets.note).toMatch(/Settings > Tickets/);
  });

  it('never uses an em dash in copy', () => {
    expect(JSON.stringify(MODULE_CAPABILITIES)).not.toMatch(/—/);
  });
});
