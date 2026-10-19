import { describe, expect, it } from 'vitest';
import { can, pickColor, type Action, type Role } from '../src';

const ALL: Action[] = ['view', 'export', 'edit', 'share', 'manageMembers', 'approveRequests', 'rename', 'delete', 'transfer', 'requestAccess', 'manageCanvases', 'changeSettings'];

describe('can()', () => {
  it('segue a tabela de papéis do plano', () => {
    const allowed = (role: Role, s = { editorsCanShare: false }) => ALL.filter((a) => can(role, a, s));
    expect(allowed('owner')).toEqual(ALL.filter((a) => a !== 'requestAccess'));
    expect(allowed('editor')).toEqual(['view', 'export', 'edit', 'rename', 'manageCanvases']);
    expect(allowed('editor', { editorsCanShare: true })).toEqual(['view', 'export', 'edit', 'share', 'manageMembers', 'approveRequests', 'rename', 'manageCanvases']);
    expect(allowed('viewer')).toEqual(['view', 'export', 'requestAccess']);
    expect(can(null, 'view')).toBe(false);
  });

  it('a cor de cada membro evita as já usadas', () => {
    expect(pickColor([])).toBe(0);
    expect(pickColor([0, 1, 3])).toBe(2);
  });
});
