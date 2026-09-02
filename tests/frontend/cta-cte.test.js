// tests/frontend/cta-cte.test.js
//
// Regresión — tabla "Saldos por cliente" (Cuenta corriente): renderTabla()
// interpola `c.nombre_fantasia`/`c.razon_social` en el innerHTML de cada
// fila. Ambos campos los carga el usuario vía el ABM de Clientes, así que
// son el mismo vector de escalamiento que #16/#19. A diferencia de esos
// dos casos, acá ya vienen envueltos en sanitize() en el código actual —
// este test es de regresión preventiva (no corresponde a un hallazgo
// abierto en AUDITORIA_BUGS_v954.md), para que una futura edición de
// renderTabla() no reintroduzca el bug.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { cargarScripts, crearDocumentoFake, crearElementoFake } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_UTILS = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');
const CTA_CTE  = path.resolve(__dirname, '../../frontend/admin/js/cta-cte.js');

const PAYLOAD = '<img src=x onerror=alert(1)>';

function cargar() {
  const tbody = crearElementoFake();
  const documento = crearDocumentoFake({ 'tbody-clientes': tbody });
  const { sandbox } = cargarScripts([UI_UTILS, CTA_CTE], { documento });
  return { sandbox, tbody };
}

describe('cta-cte.js — renderTabla (Saldos por cliente)', () => {
  it('escapa nombre_fantasia malicioso', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderTabla([
      { cliente_id: '1', nombre_fantasia: PAYLOAD, razon_social: 'Razón Social OK', deuda_total: 1000, deuda_vencida: 0, ultimo_pago: null },
    ]);
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });

  it('escapa razon_social malicioso cuando difiere de nombre_fantasia', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderTabla([
      { cliente_id: '1', nombre_fantasia: 'Fantasía OK', razon_social: PAYLOAD, deuda_total: 1000, deuda_vencida: 0, ultimo_pago: null },
    ]);
    expect(tbody.innerHTML).not.toContain(PAYLOAD);
    expect(tbody.innerHTML).toContain('&lt;img');
  });

  it('datos limpios se muestran sin alterar', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderTabla([
      { cliente_id: '1', nombre_fantasia: null, razon_social: 'Tuercas & Bulones S.A.', deuda_total: 1000, deuda_vencida: 500, ultimo_pago: '2026-08-01' },
    ]);
    expect(tbody.innerHTML).toContain('Tuercas &amp; Bulones S.A.');
  });

  it('lista vacía muestra el empty-state', () => {
    const { sandbox, tbody } = cargar();
    sandbox.renderTabla([]);
    expect(tbody.innerHTML).toContain('No hay clientes con saldo pendiente');
  });
});
