// tests/handlers/whatsapp-pedido-borrador.test.js
//
// Plan 3.2, punto 2: "el flujo de creación de pedido (crear_pedido_cliente
// y el borrador de WhatsApp) — es el corazón del negocio". Esto es la
// tercera réplica del motor de precios/stock (portal cliente, admin, y
// ahora WhatsApp) — la más sensible porque la dispara un asistente
// automático sin que un humano revise el pedido antes de confirmarlo.
//
// Se mockea `crearClienteSupabaseLazy` (lib/supabase-lazy.js) para no
// depender de env vars ni de una base real — mismo patrón que
// tests/repos/scores.test.js pero acá el cliente atiende varias tablas
// distintas dentro de una sola función, así que el mock enruta por nombre
// de tabla.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  fromResponses: {},   // tabla -> { data, error } (o función que recibe el builder y lo devuelve)
  rpcResponses: {},    // nombre de rpc -> { data, error } | fn(params) -> { data, error }
}));

vi.mock('../../lib/supabase-lazy.js', () => ({
  crearClienteSupabaseLazy: () => ({
    from: (tabla) => {
      const config = dbMock.fromResponses[tabla];
      if (!config) throw new Error(`tests: no hay respuesta configurada para from('${tabla}')`);
      const result = typeof config === 'function' ? config() : config;
      const obj = {
        select: () => obj,
        in: () => obj,
        eq: () => obj,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return obj;
    },
    rpc: (nombre, params) => {
      const config = dbMock.rpcResponses[nombre];
      if (!config) throw new Error(`tests: no hay respuesta configurada para rpc('${nombre}')`);
      return Promise.resolve(typeof config === 'function' ? config(params) : config);
    },
  }),
}));

// Fase 7: crearPedidoDesdeItemsWhatsapp ya no consulta `productos` con el
// cliente de `crearClienteSupabaseLazy` (mockeado arriba) sino vía
// lib/repos/productos.js → lib/repos/_db.js. Se mockea acá también,
// reutilizando el mismo router `dbMock.fromResponses` por nombre de tabla
// para no duplicar la config de cada test (mismo patrón que el mock de
// arriba, no se puede compartir la función por las reglas de hoisting de
// vi.mock).
//
// Lote 4: el resto de `crearPedidoDesdeItemsWhatsapp` (clientes, stock,
// pedidos, resolver_precios_cliente, crear_pedido_cliente) se migró de
// `supabase` (crearClienteSupabaseLazy) a `lib/repos/whatsapp-bot.js`,
// que también usa `db` de `_db.js` — se suma acá el mismo router de
// `rpc()` que ya tenía el mock de `crearClienteSupabaseLazy` de arriba,
// para no tener que reconfigurar cada test.
vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => {
      const config = dbMock.fromResponses[tabla];
      if (!config) throw new Error(`tests: no hay respuesta configurada para from('${tabla}')`);
      const result = typeof config === 'function' ? config() : config;
      const obj = {
        select: () => obj,
        in: () => obj,
        eq: () => obj,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return obj;
    },
    rpc: (nombre, params) => {
      const config = dbMock.rpcResponses[nombre];
      if (!config) throw new Error(`tests: no hay respuesta configurada para rpc('${nombre}')`);
      return Promise.resolve(typeof config === 'function' ? config(params) : config);
    },
  },
}));

const { crearPedidoDesdeItemsWhatsapp } = await import('../../lib/handlers/notif.js');

const CLIENTE_OK = { id: 'cliente-1', activo: true, limite_credito: 0, saldo_deuda: 0 };
const ITEM = { producto_id: 'prod-1', cantidad: 2, nombre: 'Aceite 1L' };

function stockSuficiente(cantidad = 100) {
  return {
    data: [{ producto_id: 'prod-1', cantidad, cantidad_reservada: 0, depositos: { es_principal: true } }],
    error: null,
  };
}

beforeEach(() => {
  dbMock.fromResponses = {
    clientes: { data: CLIENTE_OK, error: null },
    stock: stockSuficiente(),
    productos: { data: [{ id: 'prod-1', precio_base: 100, iva: 21 }], error: null },
    pedidos: { data: { numero_pedido: 'PED-0001' }, error: null },
  };
  dbMock.rpcResponses = {
    resolver_precios_cliente: { data: [{ producto_id: 'prod-1', precio: 100 }], error: null },
    crear_pedido_cliente: { data: { ok: true, pedido_id: 'pedido-1' }, error: null },
  };
});

describe('crearPedidoDesdeItemsWhatsapp — camino feliz', () => {
  it('confirma el pedido y devuelve pedidoId + numeroPedido', async () => {
    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    // 2 unidades x $100 x 1.21 (IVA 21%) = $242 — ver total agregado al
    // resultado (2026-08-03) para que el mensaje final de WhatsApp pueda
    // mostrarle el monto al cliente, no solo el número de pedido.
    expect(r).toEqual({ ok: true, pedidoId: 'pedido-1', numeroPedido: 'PED-0001', total: 242 });
  });

  it('manda descuento_pct 0 en todos los items (WhatsApp no soporta descuentos)', async () => {
    let itemsEnviados;
    dbMock.rpcResponses.crear_pedido_cliente = (params) => {
      itemsEnviados = params.p_items;
      return { data: { ok: true, pedido_id: 'pedido-1' }, error: null };
    };

    await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(itemsEnviados).toEqual([
      { producto_id: 'prod-1', cantidad: 2, precio_unitario: 100, descuento_pct: 0, subtotal: 200 },
    ]);
  });

  it('manda canal "whatsapp" y sin vendedor asignado a la RPC', async () => {
    let paramsEnviados;
    dbMock.rpcResponses.crear_pedido_cliente = (params) => {
      paramsEnviados = params;
      return { data: { ok: true, pedido_id: 'pedido-1' }, error: null };
    };

    await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(paramsEnviados.p_canal).toBe('whatsapp');
    expect(paramsEnviados.p_vendedor_id).toBeNull();
  });
});

describe('crearPedidoDesdeItemsWhatsapp — validaciones que deben cortar el flujo', () => {
  it('rechaza si el cliente no existe', async () => {
    dbMock.fromResponses.clientes = { data: null, error: { message: 'no encontrado' } };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-x', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'cliente no encontrado' });
  });

  it('rechaza si el cliente está inactivo', async () => {
    dbMock.fromResponses.clientes = { data: { ...CLIENTE_OK, activo: false }, error: null };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'cliente inactivo' });
  });

  it('rechaza si no hay stock suficiente y nombra el producto en el error', async () => {
    dbMock.fromResponses.stock = stockSuficiente(1); // pide 2, hay 1

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'stock insuficiente para "Aceite 1L"' });
  });

  it('descuenta cantidad_reservada al calcular el stock disponible', async () => {
    dbMock.fromResponses.stock = {
      data: [{ producto_id: 'prod-1', cantidad: 10, cantidad_reservada: 9, depositos: { es_principal: true } }],
      error: null,
    };
    // disponible = 10 - 9 = 1, se pide 2 → debe rechazar

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stock insuficiente/);
  });

  it('rechaza si falla la resolución de precios', async () => {
    dbMock.rpcResponses.resolver_precios_cliente = { data: null, error: { message: 'timeout' } };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'no se pudieron resolver los precios' });
  });

  it('rechaza si algún producto no pertenece a la empresa', async () => {
    dbMock.fromResponses.productos = { data: [], error: null }; // ningún producto matcheó

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'uno o más productos no pertenecen a esta empresa' });
  });

  it('rechaza si el pedido supera el límite de crédito del cliente', async () => {
    dbMock.fromResponses.clientes = { data: { ...CLIENTE_OK, limite_credito: 100, saldo_deuda: 50 }, error: null };
    // total del pedido: 2 * 100 * 1.21 = 242 → 50 + 242 > 100

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'supera el límite de crédito del cliente' });
  });

  it('no valida límite de crédito si limite_credito es 0 (sin límite configurado)', async () => {
    dbMock.fromResponses.clientes = { data: { ...CLIENTE_OK, limite_credito: 0, saldo_deuda: 999999 }, error: null };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r.ok).toBe(true);
  });

  it('rechaza si la RPC crear_pedido_cliente devuelve error de conexión', async () => {
    dbMock.rpcResponses.crear_pedido_cliente = { data: null, error: { message: 'connection reset' } };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r).toEqual({ ok: false, error: 'error interno creando el pedido' });
  });

  it('propaga el motivo cuando la RPC responde ok:false (ej. stock cambió justo antes de confirmar)', async () => {
    dbMock.rpcResponses.crear_pedido_cliente = { data: { ok: false, tipo: 'stock_insuficiente' }, error: null };

    const r = await crearPedidoDesdeItemsWhatsapp({ empresaId: 'empresa-1', clienteId: 'cliente-1', items: [ITEM] });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('stock insuficiente'); // fallback cuando la RPC no manda rpcResult.error
  });
});
