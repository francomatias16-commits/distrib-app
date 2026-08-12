// tests/handlers/reglas-automatizacion.test.js
//
// PLAN_ERP_SINCRONIZACION_2026.md — Fase 6: motor de automatización sobre
// el bus de eventos. Cubre el evaluador de condiciones (fail-closed ante
// condición mal armada) y ejecutarAccion (notificar_push, enviar_whatsapp,
// crear_tarea — los tres tipos soportados tras la migración 433_fase6b).

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  reglas: [],
  usuarios: [],
  clientes: [],
  tareas: [],
}));

const pushMock = vi.hoisted(() => ({
  enviarPush: vi.fn(async () => ({ enviadas: 1 })),
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      if (tabla === 'reglas_automatizacion') {
        return {
          select: () => ({
            eq: (_c1, empresaId) => ({
              eq: (_c2, tipoEvento) => ({
                eq: (_c3, activa) => ({
                  then: (resolve) => resolve({
                    data: dbMock.reglas.filter(
                      (r) => r.empresa_id === empresaId && r.evento_disparador === tipoEvento && r.activa === activa
                    ),
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (tabla === 'usuarios') {
        return {
          select: () => ({
            eq: (_c1, empresaId) => ({
              in: (_c2, roles) => ({
                then: (resolve) => resolve({
                  data: dbMock.usuarios.filter((u) => u.empresa_id === empresaId && roles.includes(u.rol)),
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabla === 'clientes') {
        return {
          select: () => ({
            eq: (_c1, clienteId) => ({
              eq: (_c2, empresaId) => ({
                maybeSingle: async () => ({
                  data: dbMock.clientes.find((c) => c.id === clienteId && c.empresa_id === empresaId) || null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabla === 'tareas_automatizacion') {
        return {
          insert: (fila) => ({
            select: () => ({
              single: async () => {
                const nueva = { id: `t${dbMock.tareas.length + 1}`, ...fila };
                dbMock.tareas.push(nueva);
                return { data: { id: nueva.id }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`tabla inesperada en el mock: ${tabla}`);
    },
  }),
}));

vi.mock('../../lib/handlers/_push.js', () => ({
  enviarPush: pushMock.enviarPush,
}));

const { obtenerReglasActivas, evaluarCondicion, ejecutarAccion } = await import('../../lib/reglas-automatizacion.js');

describe('evaluarCondicion', () => {
  it('condición vacía siempre matchea', () => {
    expect(evaluarCondicion({}, { cualquiera: 1 })).toBe(true);
    expect(evaluarCondicion(null, {})).toBe(true);
  });

  it('comparación simple de igualdad', () => {
    expect(evaluarCondicion({ campo: 'tipo', operador: '=', valor: 'urgente' }, { tipo: 'urgente' })).toBe(true);
    expect(evaluarCondicion({ campo: 'tipo', operador: '=', valor: 'urgente' }, { tipo: 'normal' })).toBe(false);
  });

  it('comparaciones numéricas', () => {
    expect(evaluarCondicion({ campo: 'monto', operador: '>', valor: 1000 }, { monto: 5000 })).toBe(true);
    expect(evaluarCondicion({ campo: 'monto', operador: '>', valor: 1000 }, { monto: 500 })).toBe(false);
    expect(evaluarCondicion({ campo: 'saldo', operador: '<=', valor: 0 }, { saldo: -10 })).toBe(true);
  });

  it('combinación "y" — todas deben cumplirse', () => {
    const condicion = {
      y: [
        { campo: 'monto', operador: '>', valor: 1000 },
        { campo: 'zona', operador: '=', valor: 'norte' },
      ],
    };
    expect(evaluarCondicion(condicion, { monto: 5000, zona: 'norte' })).toBe(true);
    expect(evaluarCondicion(condicion, { monto: 5000, zona: 'sur' })).toBe(false);
  });

  it('combinación "o" — alguna debe cumplirse', () => {
    const condicion = {
      o: [
        { campo: 'zona', operador: '=', valor: 'norte' },
        { campo: 'zona', operador: '=', valor: 'sur' },
      ],
    };
    expect(evaluarCondicion(condicion, { zona: 'sur' })).toBe(true);
    expect(evaluarCondicion(condicion, { zona: 'este' })).toBe(false);
  });

  it('fail-closed: operador desconocido o campo faltante no matchea', () => {
    expect(evaluarCondicion({ campo: 'monto', operador: 'entre', valor: 1 }, { monto: 5 })).toBe(false);
    expect(evaluarCondicion({ operador: '=', valor: 1 }, { monto: 1 })).toBe(false);
  });
});

describe('obtenerReglasActivas', () => {
  beforeEach(() => {
    dbMock.reglas = [
      { id: 'r1', empresa_id: 'e1', evento_disparador: 'pedido_creado', activa: true, condicion: {}, accion: { tipo: 'notificar_push' } },
      { id: 'r2', empresa_id: 'e1', evento_disparador: 'pedido_creado', activa: false, condicion: {}, accion: { tipo: 'notificar_push' } },
      { id: 'r3', empresa_id: 'e2', evento_disparador: 'pedido_creado', activa: true, condicion: {}, accion: { tipo: 'notificar_push' } },
    ];
  });

  it('trae solo las reglas activas de la empresa y el evento pedidos', async () => {
    const reglas = await obtenerReglasActivas('e1', 'pedido_creado');
    expect(reglas).toHaveLength(1);
    expect(reglas[0].id).toBe('r1');
  });
});

describe('ejecutarAccion — notificar_push', () => {
  beforeEach(() => {
    dbMock.usuarios = [
      { id: 'u1', empresa_id: 'e1', rol: 'dueno' },
      { id: 'u2', empresa_id: 'e1', rol: 'admin' },
      { id: 'u3', empresa_id: 'e1', rol: 'vendedor' },
    ];
    pushMock.enviarPush.mockClear();
  });

  it('notificar_push sin roles especificados avisa a dueno/admin por default', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await ejecutarAccion({ tipo: 'notificar_push', titulo: 'Alerta', mensaje: 'Pasó algo' }, {}, evento);

    expect(pushMock.enviarPush).toHaveBeenCalledTimes(2);
    const idsNotificados = pushMock.enviarPush.mock.calls.map((c) => c[0]).sort();
    expect(idsNotificados).toEqual(['u1', 'u2']);
  });

  it('notificar_push respeta la lista de roles de la regla', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await ejecutarAccion({ tipo: 'notificar_push', roles: ['vendedor'] }, {}, evento);

    expect(pushMock.enviarPush).toHaveBeenCalledTimes(1);
    expect(pushMock.enviarPush.mock.calls[0][0]).toBe('u3');
  });

  it('tipo de acción no soportado tira un error explícito', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await expect(ejecutarAccion({ tipo: 'crear_evento_calendario' }, {}, evento)).rejects.toThrow(/no soportado/);
  });

  it('acción sin tipo tira un error explícito', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await expect(ejecutarAccion({}, {}, evento)).rejects.toThrow(/no tiene "tipo"/);
  });
});

describe('ejecutarAccion — enviar_whatsapp', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    dbMock.clientes = [
      { id: 'c1', empresa_id: 'e1', razon_social: 'Cliente Uno', telefono: '5491122334455' },
      { id: 'c2', empresa_id: 'e1', razon_social: 'Cliente Sin Tel', telefono: null },
    ];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: 'wamid.123' }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resuelve teléfono y nombre desde cliente_id y manda el template', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'cliente_en_mora' };
    const resultado = await ejecutarAccion(
      { tipo: 'enviar_whatsapp', template: 'deuda_vencida', params: { monto_vencido: 15000 } },
      { cliente_id: 'c1' },
      evento
    );

    expect(resultado).toEqual({ ok: true, message_id: 'wamid.123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opciones] = fetchMock.mock.calls[0];
    const body = JSON.parse(opciones.body);
    expect(body).toMatchObject({
      template: 'deuda_vencida',
      telefono: '5491122334455',
      empresa_id: 'e1',
      params: { monto_vencido: 15000, nombre_cliente: 'Cliente Uno' },
    });
  });

  it('template desconocido: fail-closed sin llegar a pegarle a la red', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'cliente_en_mora' };
    await expect(
      ejecutarAccion({ tipo: 'enviar_whatsapp', template: 'promo_inventada' }, { cliente_id: 'c1' }, evento)
    ).rejects.toThrow(/no reconocido/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('evento sin cliente_id en el payload: fail-closed', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'cliente_en_mora' };
    await expect(
      ejecutarAccion({ tipo: 'enviar_whatsapp', template: 'deuda_vencida' }, {}, evento)
    ).rejects.toThrow(/cliente_id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cliente sin teléfono cargado: fail-closed', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'cliente_en_mora' };
    await expect(
      ejecutarAccion({ tipo: 'enviar_whatsapp', template: 'deuda_vencida' }, { cliente_id: 'c2' }, evento)
    ).rejects.toThrow(/sin teléfono/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error del endpoint de WhatsApp se propaga con mensaje explícito', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'template no aprobado en Meta' }) });
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'cliente_en_mora' };
    await expect(
      ejecutarAccion({ tipo: 'enviar_whatsapp', template: 'deuda_vencida' }, { cliente_id: 'c1' }, evento)
    ).rejects.toThrow(/template no aprobado en Meta/);
  });
});

describe('ejecutarAccion — crear_tarea', () => {
  beforeEach(() => {
    dbMock.tareas = [];
  });

  it('crea la tarea con los roles y el origen de la regla', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    const resultado = await ejecutarAccion(
      { tipo: 'crear_tarea', titulo: 'Confirmar stock', descripcion: 'Pedido grande', roles: ['depositero'], __regla_id: 'r9' },
      {},
      evento
    );

    expect(resultado.ok).toBe(true);
    expect(dbMock.tareas).toHaveLength(1);
    expect(dbMock.tareas[0]).toMatchObject({
      empresa_id: 'e1',
      titulo: 'Confirmar stock',
      descripcion: 'Pedido grande',
      roles: ['depositero'],
      regla_id: 'r9',
      evento_disparador: 'pedido_creado',
    });
  });

  it('sin roles especificados usa el default dueno/admin', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await ejecutarAccion({ tipo: 'crear_tarea', titulo: 'Revisar algo' }, {}, evento);
    expect(dbMock.tareas[0].roles).toEqual(['dueno', 'admin']);
  });

  it('tarea sin título: fail-closed', async () => {
    const evento = { id: 'ev1', empresa_id: 'e1', tipo_evento: 'pedido_creado' };
    await expect(ejecutarAccion({ tipo: 'crear_tarea' }, {}, evento)).rejects.toThrow(/titulo/);
    expect(dbMock.tareas).toHaveLength(0);
  });
});
