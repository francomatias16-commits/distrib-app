// tests/handlers/whatsapp-pedido-tools.test.js
//
// Cobertura para lib/whatsapp-pedido-tools.js — hasta ahora sin ningún test
// (a diferencia de whatsapp-pedido-borrador.test.js, que solo cubre
// crearPedidoDesdeItemsWhatsapp en notif.js). Se agrega junto con el fix de
// derivar_humano: la tool marcaba la conversación como derivada pero nunca
// avisaba a nadie por push, a diferencia de marcarDerivada() en notif.js
// (usada para mensajes no soportados y corte por exceso de turnos). El foco
// principal acá es ese caso — "Derivación manual pedida por el cliente" del
// checklist de Etapa 6 — pero se cubren también las otras cuatro tools para
// no dejar el archivo sin ningún test.
//
// Mock de `db` (lib/repos/_db.js) enrutado por tabla, mismo espíritu que el
// mock de crearClienteSupabaseLazy en whatsapp-pedido-borrador.test.js, pero
// acá el objeto encadenado necesita distinguir select() de update() porque
// ambos se usan sobre la misma tabla (whatsapp_conversaciones) dentro de un
// mismo archivo.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  fromResponses: {}, // tabla -> { data, error } | fn() -> { data, error }
}));

const pushMock = vi.hoisted(() => ({
  llamadas: [],
  fallar: false,
}));

vi.mock('../../lib/repos/_db.js', () => ({
  db: {
    from: (tabla) => {
      const config = dbMock.fromResponses[tabla];
      if (!config) throw new Error(`tests: no hay respuesta configurada para from('${tabla}')`);
      const result = typeof config === 'function' ? config() : config;
      const obj = {
        select: () => obj,
        update: () => obj,
        eq: () => obj,
        in: () => obj,
        limit: () => obj,
        ilike: () => obj,
        single: () => Promise.resolve(result),
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return obj;
    },
  },
}));

vi.mock('../../lib/handlers/_push.js', () => ({
  enviarPush: (usuarioId, titulo, cuerpo, datos) => {
    pushMock.llamadas.push({ usuarioId, titulo, cuerpo, datos });
    return pushMock.fallar ? Promise.reject(new Error('push caído')) : Promise.resolve();
  },
}));

const { ejecutarToolPedidoWhatsApp } = await import('../../lib/whatsapp-pedido-tools.js');

const EMPRESA_ID = 'empresa-1';
const CONVERSACION_ID = 'conv-1';

beforeEach(() => {
  pushMock.llamadas = [];
  pushMock.fallar = false;
  dbMock.fromResponses = {
    whatsapp_conversaciones: { data: { pedido_borrador: { items: [] } }, error: null },
    usuarios: { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null },
  };
});

describe('derivar_humano', () => {
  it('marca la conversación como derivada y avisa por push a dueño/admin/vendedor', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        // 1ra invocación desde execute(): el update() de estado.
        // 2da invocación: el select() de empresa_id/telefono para el push.
        if (llamada === 1) return { error: null };
        return { data: { empresa_id: EMPRESA_ID, telefono: '+5493400000000' }, error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('derivar_humano', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { motivo: 'El cliente pidió hablar con una persona' },
    });

    expect(r).toEqual({ ok: true });
    expect(pushMock.llamadas).toHaveLength(2); // admin-1 y admin-2
    expect(pushMock.llamadas.map((l) => l.usuarioId)).toEqual(['admin-1', 'admin-2']);
    expect(pushMock.llamadas[0].titulo).toBe('WhatsApp derivado');
    expect(pushMock.llamadas[0].cuerpo).toBe('El cliente pidió hablar con una persona (+5493400000000)');
    expect(pushMock.llamadas[0].datos).toEqual({ tipo: 'whatsapp_derivado', link: '/admin/whatsapp-conversaciones' });
  });

  it('no rompe la derivación si el push falla (best-effort)', async () => {
    pushMock.fallar = true;
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) return { error: null };
        return { data: { empresa_id: EMPRESA_ID, telefono: '+5493400000000' }, error: null };
      };
    })();

    await expect(
      ejecutarToolPedidoWhatsApp('derivar_humano', {
        empresaId: EMPRESA_ID,
        conversacionId: CONVERSACION_ID,
        args: { motivo: 'no importa' },
      })
    ).resolves.toEqual({ ok: true });
  });

  it('no rompe la derivación si la conversación no se encuentra para el aviso (sin destinatario)', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) return { error: null };
        return { data: null, error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('derivar_humano', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { motivo: 'no importa' },
    });

    expect(r).toEqual({ ok: true });
    expect(pushMock.llamadas).toHaveLength(0);
  });

  it('rechaza si falta el update principal de estado', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = { error: { message: 'timeout' } };

    await expect(
      ejecutarToolPedidoWhatsApp('derivar_humano', {
        empresaId: EMPRESA_ID,
        conversacionId: CONVERSACION_ID,
        args: { motivo: 'no importa' },
      })
    ).rejects.toThrow(/derivar_humano/);
  });
});

describe('proponer_confirmacion', () => {
  it('rechaza si el borrador está vacío', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = { data: { pedido_borrador: { items: [] } }, error: null };

    await expect(
      ejecutarToolPedidoWhatsApp('proponer_confirmacion', { empresaId: EMPRESA_ID, conversacionId: CONVERSACION_ID, args: {} })
    ).rejects.toThrow(/borrador vacío/);
  });

  it('pasa a estado esperando_confirmacion si hay items y devuelve el total calculado server-side', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', cantidad: 2, precio: 100 }] } }, error: null };
        }
        return { error: null }; // el update
      };
    })();
    // FIX (2026-08-03): proponer_confirmacion ahora consulta el IVA real del
    // producto (obtenerProductosParaCotizarPedido -> tabla productos) para
    // calcular subtotal/iva_total/total con la misma función pura que usa
    // crearPedidoDesdeItemsWhatsapp al confirmar — el modelo ya no inventa
    // ni suma el total a mano.
    dbMock.fromResponses.productos = { data: [{ id: 'p1', precio_base: 100, iva: 21 }], error: null };

    const r = await ejecutarToolPedidoWhatsApp('proponer_confirmacion', { empresaId: EMPRESA_ID, conversacionId: CONVERSACION_ID, args: {} });

    expect(r.items).toEqual([{ producto_id: 'p1', cantidad: 2, precio: 100 }]);
    // 2 x $100 x 1.21 (IVA 21%) = $242
    expect(r.subtotal).toBe(200);
    expect(r.iva_total).toBe(42);
    expect(r.total).toBe(242);
  });
});

describe('agregar_item / quitar_item', () => {
  it('agrega un producto nuevo al borrador vacío', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) return { data: { pedido_borrador: { items: [] } }, error: null };
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('agregar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }] },
    });

    expect(r.items).toEqual([{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }]);
  });

  it('suma cantidad si el producto ya estaba en el borrador', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 2, precio: 100 }] } }, error: null };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('agregar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 1, precio: 100 }] },
    });

    expect(r.items).toEqual([{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }]);
  });

  // FIX (2026-08-30, batch): antes se necesitaba una tool call por
  // producto — ver comentario de cabecera de agregar_item en
  // whatsapp-pedido-tools.js. Este test es el caso que motivó el cambio:
  // "2 aceites y 3 harinas" en un solo mensaje del cliente, resuelto en
  // UN solo llamado a la tool con dos elementos en `items`.
  it('agrega varios productos en un solo llamado (batch), incluyendo uno que ya estaba en el borrador', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 2, precio: 100 }] } }, error: null };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('agregar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: {
        items: [
          { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 1, precio: 100 }, // suma sobre lo existente
          { producto_id: 'p2', nombre: 'Harina 1kg', cantidad: 3, precio: 50 }, // nuevo
        ],
      },
    });

    expect(r.items).toEqual([
      { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 },
      { producto_id: 'p2', nombre: 'Harina 1kg', cantidad: 3, precio: 50 },
    ]);
  });

  it('suma correctamente si el batch trae dos veces el mismo producto_id', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) return { data: { pedido_borrador: { items: [] } }, error: null };
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('agregar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: {
        items: [
          { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 2, precio: 100 },
          { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 1, precio: 100 },
        ],
      },
    });

    expect(r.items).toEqual([{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }]);
  });

  // Red de seguridad: un modelo (sobre todo los gratuitos de Groq/
  // OpenRouter) puede no seguir el schema nuevo al pie de la letra y
  // seguir mandando el shape viejo (producto_id suelto, sin envolver en
  // items). No debería romper la tool call entera.
  it('acepta el shape viejo (producto_id suelto, sin items) como fallback defensivo', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) return { data: { pedido_borrador: { items: [] } }, error: null };
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('agregar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 },
    });

    expect(r.items).toEqual([{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }]);
  });

  it('rechaza si no viene ningún producto (ni items ni el shape viejo)', async () => {
    await expect(
      ejecutarToolPedidoWhatsApp('agregar_item', { empresaId: EMPRESA_ID, conversacionId: CONVERSACION_ID, args: {} })
    ).rejects.toThrow('agregar_item: no se recibió ningún producto en items');
  });

  it('quita un producto del borrador', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 2, precio: 100 }] } }, error: null };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('quitar_item', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { producto_id: 'p1' },
    });

    expect(r.items).toEqual([]);
  });
});

// FIX (2026-08-30): antes, "dejar en N unidades" un producto ya agregado
// requería encadenar quitar_item + agregar_item (agregar_item SUMA, no
// reemplaza) — el modelo no siempre lo resolvía bien ante un pedido
// ambiguo del cliente (ej. tras un "Stock insuficiente", el cliente
// contesta "dejalo en 3" y el modelo no tiene forma directa de fijar la
// cantidad exacta). modificar_cantidad la fija en un solo llamado.
describe('modificar_cantidad', () => {
  it('cambia la cantidad a un valor exacto (no suma) para un producto existente', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 5, precio: 100 }] } }, error: null };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('modificar_cantidad', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { producto_id: 'p1', cantidad: 3 },
    });

    expect(r.items).toEqual([{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 }]);
  });

  it('quita el producto si la cantidad nueva es 0 o menor (mismo resultado que quitar_item)', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return { data: { pedido_borrador: { items: [{ producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 5, precio: 100 }] } }, error: null };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('modificar_cantidad', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { producto_id: 'p1', cantidad: 0 },
    });

    expect(r.items).toEqual([]);
  });

  it('no toca otros productos del borrador', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = (() => {
      let llamada = 0;
      return () => {
        llamada += 1;
        if (llamada === 1) {
          return {
            data: {
              pedido_borrador: {
                items: [
                  { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 5, precio: 100 },
                  { producto_id: 'p2', nombre: 'Harina 1kg', cantidad: 2, precio: 50 },
                ],
              },
            },
            error: null,
          };
        }
        return { error: null };
      };
    })();

    const r = await ejecutarToolPedidoWhatsApp('modificar_cantidad', {
      empresaId: EMPRESA_ID,
      conversacionId: CONVERSACION_ID,
      args: { producto_id: 'p1', cantidad: 3 },
    });

    expect(r.items).toEqual([
      { producto_id: 'p1', nombre: 'Aceite 1L', cantidad: 3, precio: 100 },
      { producto_id: 'p2', nombre: 'Harina 1kg', cantidad: 2, precio: 50 },
    ]);
  });

  it('rechaza si el producto no está en el borrador actual', async () => {
    dbMock.fromResponses.whatsapp_conversaciones = { data: { pedido_borrador: { items: [] } }, error: null };

    await expect(
      ejecutarToolPedidoWhatsApp('modificar_cantidad', {
        empresaId: EMPRESA_ID,
        conversacionId: CONVERSACION_ID,
        args: { producto_id: 'p1', cantidad: 3 },
      })
    ).rejects.toThrow('modificar_cantidad: ese producto no está en el borrador actual');
  });
});

describe('ejecutarToolPedidoWhatsApp — validaciones generales', () => {
  it('rechaza una tool desconocida', async () => {
    await expect(
      ejecutarToolPedidoWhatsApp('tool_inexistente', { empresaId: EMPRESA_ID, conversacionId: CONVERSACION_ID, args: {} })
    ).rejects.toThrow('Tool desconocida: tool_inexistente');
  });

  it('rechaza si falta empresaId o conversacionId', async () => {
    await expect(
      ejecutarToolPedidoWhatsApp('derivar_humano', { empresaId: null, conversacionId: CONVERSACION_ID, args: { motivo: 'x' } })
    ).rejects.toThrow(/Falta empresaId o conversacionId/);
  });
});
