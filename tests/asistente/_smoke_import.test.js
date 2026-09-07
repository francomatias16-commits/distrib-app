import { vi, describe, it, expect } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

describe('smoke: import del motor de tools', () => {
  it('importa lib/asistente-tools/index.js sin reventar', async () => {
    const mod = await import('../../lib/asistente-tools/index.js');
    expect(typeof mod.ejecutarTool).toBe('function');
    expect(typeof mod.resolverAccionPendiente).toBe('function');
    expect(Array.isArray(mod.TOOLS)).toBe(true);
  });
});
