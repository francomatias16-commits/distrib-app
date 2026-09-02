// tests/frontend/checkout.test.js
//
// Regresión hallazgo #24 (AUDITORIA_BUGS_v954.md) — portal cliente,
// checkout.html (confirmación de pedido sugerido vía link de WhatsApp,
// sin login): cargar() arma cada fila de `lista-items` con innerHTML;
// `item.productos?.nombre` y `.unidad` ya pasan por el `esc()` local del
// archivo (mismo criterio que `sanitize()` en el resto del proyecto,
// definido acá aparte porque este script es standalone sin ui-utils.js).
// El nombre del cliente usa `textContent` (seguro por diseño, no
// interpolado). Este test cubre el vector de mayor riesgo real: un
// producto cargado por CUALQUIER usuario interno con ABM de Productos
// termina renderizado sin login en un link público que circula por
// WhatsApp — escalamiento interno → público. Fix ya aplicado (esc() en
// nombre/unidad); test de regresión preventiva.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake, extraerScriptDeHtml } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_HTML = path.resolve(__dirname, '../../frontend/cliente/checkout.html');

const PAYLOAD = '<img src=x onerror=alert(1)>';

function cargar({ pedido }) {
  const script = extraerScriptDeHtml(CHECKOUT_HTML, 'function cargar()');
  const scriptPath = path.join(__dirname, '__checkout-inline__.js');
  require('node:fs').writeFileSync(scriptPath, script);

  const lista = crearElementoFake();
  const documento = crearDocumentoFake({ 'lista-items': lista });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, pedido, mp_disponible: false }),
  }));

  const { sandbox } = cargarScripts([scriptPath], {
    documento,
    extra: {
      location: { search: '?pedido=abc123' },
      fetch: fetchMock,
    },
  });

  require('node:fs').unlinkSync(scriptPath);
  return { sandbox, lista };
}

const pedidoBase = {
  estado: 'sugerido',
  numero_pedido: 'P-0001',
  fecha_pedido: '2026-08-20T12:00:00Z',
  total: 1000,
  clientes: { nombre_fantasia: 'Cliente OK', razon_social: 'Cliente OK S.A.' },
  pedido_items: [
    { cantidad: 2, precio_unitario: 500, productos: { nombre: 'Producto OK', unidad: 'u' } },
  ],
};

describe('checkout.html — cargar() (#24, listado de items del pedido sugerido, portal público sin login)', () => {
  it('escapa productos.nombre malicioso', async () => {
    const pedido = {
      ...pedidoBase,
      pedido_items: [{ cantidad: 1, precio_unitario: 100, productos: { nombre: PAYLOAD, unidad: 'u' } }],
    };
    const { sandbox, lista } = cargar({ pedido });
    await sandbox.cargar();
    expect(lista.innerHTML).not.toContain(PAYLOAD);
    expect(lista.innerHTML).toContain('&lt;img');
  });

  it('escapa productos.unidad maliciosa', async () => {
    const pedido = {
      ...pedidoBase,
      pedido_items: [{ cantidad: 1, precio_unitario: 100, productos: { nombre: 'Producto OK', unidad: PAYLOAD } }],
    };
    const { sandbox, lista } = cargar({ pedido });
    await sandbox.cargar();
    expect(lista.innerHTML).not.toContain(PAYLOAD);
    expect(lista.innerHTML).toContain('&lt;img');
  });

  it('datos limpios se muestran sin alterar', async () => {
    const { sandbox, lista } = cargar({ pedido: pedidoBase });
    await sandbox.cargar();
    expect(lista.innerHTML).toContain('Producto OK');
    expect(lista.children.length).toBe(1);
  });
});
