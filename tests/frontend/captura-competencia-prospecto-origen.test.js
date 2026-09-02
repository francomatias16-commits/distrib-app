// tests/frontend/captura-competencia-prospecto-origen.test.js
//
// PLAN_CAPTURA_COMPETENCIA.md, Fase 3 — cierre del loop prospección→captura
// (changelog v1018, sección "Pendiente"). Cubre el vínculo programático
// prospecto↔captura en frontend/admin/js/captura-competencia.js:
//   1. El deep-link ?proveedor=X prellena el modal de nueva captura.
//   2. Ese prospecto de origen viaja colgado de la captura recién creada
//      (no como estado global), y al convertir se dispara un
//      accion=marcar_estado sobre prospectos-competencia con estado
//      'convertido' y el captura_id resultante.
//   3. Una captura que NO vino de un deep-link no dispara ese POST extra.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { cargarScripts, crearElementoFake, crearDocumentoFake, asignarVariableDeModulo } from '../helpers/cargar-script-frontend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC = path.resolve(__dirname, '../../frontend/admin/js/captura-competencia.js');

function elementosBase() {
  return {
    'cc-th-vendedor': crearElementoFake(),
    'cc-tbody': crearElementoFake(),
    'cc-kpis': crearElementoFake(),
    'cc-ahorro-wrap': null,
    'cc-nueva-proveedor': crearElementoFake(),
    'cc-preview-foto': crearElementoFake(),
    'cc-nueva-alerta': crearElementoFake(),
    'cc-input-foto': crearElementoFake(),
    'cc-backdrop-nueva': crearElementoFake(),
    'cc-modal-nueva': crearElementoFake(),
    'cc-btn-tomar-foto': crearElementoFake(),
    'cc-btn-crear-captura': crearElementoFake(),
    'panel-captura': crearElementoFake(),
    'cc-panel-body': crearElementoFake(),
    'cc-panel-titulo': crearElementoFake(),
  };
}

function cargar(fetchMock) {
  const documento = crearDocumentoFake(elementosBase());
  const { sandbox, contexto } = cargarScripts([CC], {
    documento,
    extra: {
      fetch: fetchMock,
      authCtx: { perfil: { rol: 'vendedor', empresa_id: 'e1' }, session: { access_token: 'tok' } },
      toast: vi.fn(),
      formatARS: (n) => `$ ${n}`,
    },
  });
  return { sandbox, contexto, documento };
}

describe('captura-competencia.js — vínculo prospecto↔captura al convertir (Fase 3)', () => {
  it('ccAbrirModalNueva prellena el proveedor cuando viene del deep-link', () => {
    const { sandbox, documento } = cargar(vi.fn());
    sandbox.ccAbrirModalNueva('Almacén Don José');
    expect(documento._cache['cc-nueva-proveedor'].value).toBe('Almacén Don José');
  });

  it('ccAbrirModalNueva sin argumento deja el campo vacío (alta manual normal, sin deep-link)', () => {
    const { sandbox, documento } = cargar(vi.fn());
    documento._cache['cc-nueva-proveedor'].value = 'lo que hubiera antes';
    sandbox.ccAbrirModalNueva();
    expect(documento._cache['cc-nueva-proveedor'].value).toBe('');
  });

  it('al convertir una captura creada con prospecto de origen, vincula el prospecto (estado=convertido, captura_id)', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/captura-competencia?accion=crear')) {
        return { ok: true, json: async () => ({ captura: { id: 'c1' } }) };
      }
      if (u.includes('/api/captura-competencia?accion=detalle')) {
        return { ok: true, json: async () => ({ captura: { id: 'c1', estado: 'revisado', captura_competencia_items: [] } }) };
      }
      if (u.includes('/api/captura-competencia?accion=listar')) {
        return { ok: true, json: async () => ({ capturas: [] }) };
      }
      if (u.includes('/api/captura-competencia?accion=metricas')) {
        return { ok: true, json: async () => ({ total_capturas: 0, total_convertidas: 0, tasa_conversion_pct: 0, tiempo_promedio_foto_cierre_horas: null }) };
      }
      if (u.includes('/api/captura-competencia?accion=convertir')) {
        return { ok: true, json: async () => ({ pedido: { pedido_id: 'ped1' } }) };
      }
      if (u.includes('/api/prospectos-competencia?accion=marcar_estado')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error(`fetch no esperado en el test: ${u}`);
    });
    const { sandbox, contexto } = cargar(fetchMock);

    // Simula lo que hace el init al llegar por el deep-link de
    // prospectos-competencia.js: guarda el prospecto de origen ANTES de
    // que el vendedor saque la foto y confirme.
    asignarVariableDeModulo(contexto, sandbox, 'ccProspectoIdDesdeQuery', 'p1');
    asignarVariableDeModulo(contexto, sandbox, 'ccFotoBase64', 'ZmFrZQ==');
    asignarVariableDeModulo(contexto, sandbox, 'ccFotoMimeType', 'image/jpeg');

    await sandbox.ccCrearCaptura();

    // El prospecto de origen ya se consumió de la variable global — no
    // debe quedar pisando la próxima captura que se cree en la sesión.
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('marcar_estado'), expect.anything());

    // Convertir la captura (cliente existente) dispara el vínculo.
    asignarVariableDeModulo(contexto, sandbox, 'ccClienteSeleccionado', { id: 'cli1', razon_social: 'Cliente Test' });
    asignarVariableDeModulo(contexto, sandbox, 'ccTabCliente', 'existente');

    await sandbox.ccConvertir();

    const llamadaVinculo = fetchMock.mock.calls.find(([u]) => String(u).includes('marcar_estado'));
    expect(llamadaVinculo).toBeTruthy();
    const bodyEnviado = JSON.parse(llamadaVinculo[1].body);
    expect(bodyEnviado).toEqual({ id: 'p1', estado: 'convertido', captura_id: 'c1' });
  });

  it('convertir una captura SIN prospecto de origen no dispara el POST de vínculo', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/captura-competencia?accion=convertir')) {
        return { ok: true, json: async () => ({ pedido: { pedido_id: 'ped2' } }) };
      }
      if (u.includes('/api/captura-competencia?accion=listar')) {
        return { ok: true, json: async () => ({ capturas: [] }) };
      }
      if (u.includes('/api/captura-competencia?accion=metricas')) {
        return { ok: true, json: async () => ({ total_capturas: 0, total_convertidas: 0, tasa_conversion_pct: 0, tiempo_promedio_foto_cierre_horas: null }) };
      }
      throw new Error(`fetch no esperado en el test: ${u}`);
    });
    const { sandbox, contexto } = cargar(fetchMock);

    // Captura cargada directamente (ej. desde la bandeja), sin pasar por
    // ccCrearCaptura ni por un deep-link — no tiene prospecto_id_origen.
    asignarVariableDeModulo(contexto, sandbox, 'ccPanelCapturaActual', { id: 'c2', estado: 'revisado', captura_competencia_items: [] });
    asignarVariableDeModulo(contexto, sandbox, 'ccClienteSeleccionado', { id: 'cli1', razon_social: 'Cliente Test' });
    asignarVariableDeModulo(contexto, sandbox, 'ccTabCliente', 'existente');

    await sandbox.ccConvertir();

    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('marcar_estado'), expect.anything());
  });
});
