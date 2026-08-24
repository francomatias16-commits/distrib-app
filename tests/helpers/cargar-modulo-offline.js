// tests/helpers/cargar-modulo-offline.js
//
// Los módulos frontend/**/*-offline.js son IIFE de navegador (sin exports,
// 'use strict', dependen de `window`, `OfflineCore`, `crypto`, `fetch`
// globales). Para testear su lógica de negocio (validarTipo, procesarAccion,
// badge.formatoConflicto, hooks) sin un DOM real, los cargamos en un
// sandbox `vm` con un `OfflineCore.crearOutbox` mockeado que simplemente
// CAPTURA el objeto de configuración (`opts`) que cada módulo le pasa —
// ese objeto es, en los hechos, la superficie pública que queremos probar.
//
// No se testea offline-core.js en sí acá (Dexie/IndexedDB real) — eso
// queda para un test de integración aparte si hace falta.

import fs from 'node:fs';
import vm from 'node:vm';
import { vi } from 'vitest';

/**
 * @param {string} rutaAbsoluta - ruta al archivo *-offline.js a cargar
 * @param {object} [opciones]
 * @param {object} [opciones.windowExtra] - propiedades extra a mezclar en window
 *   ANTES de ejecutar el módulo (ej. window.authCtx, window.mostrarToast)
 * @returns {{ outboxOpts: object, window: object, api: object, contexto: vm.Context }}
 */
export function cargarModuloOffline(rutaAbsoluta, opciones = {}) {
  const { windowExtra = {} } = opciones;

  const codigo = fs.readFileSync(rutaAbsoluta, 'utf8');

  let outboxOpts = null;
  let outboxFake = null;
  let cacheFake = null;

  const fakeOfflineCore = {
    crearOutbox(opts) {
      outboxOpts = opts;
      // Devuelve un outbox "de mentira" con la forma mínima que cada
      // módulo espera para armar su API pública (window.XxxOffline = {...}).
      // vi.fn() para poder inspeccionar llamadas (ej. encolarAccion durante
      // una migración one-shot).
      outboxFake = {
        init: vi.fn(async () => {}),
        encolarAccion: vi.fn(async () => 'local-id-fake'),
        encolarLegacySinTenant: vi.fn(async () => 'legacy-id-fake'),
        sincronizarPendientes: vi.fn(async () => {}),
        getPendientes: vi.fn(async () => []),
        getContadorPendientes: vi.fn(async () => 0),
        getConflictos: vi.fn(async () => []),
        getContadorConflictos: vi.fn(async () => 0),
        resolverConflicto: vi.fn(async () => {}),
        getCuarentena: vi.fn(async () => []),
        getContadorCuarentena: vi.fn(async () => 0),
        confirmarCuarentena: vi.fn(async () => {}),
        descartarCuarentena: vi.fn(async () => {}),
        estaOnline: vi.fn(() => true),
      };
      return outboxFake;
    },
    crearCache() {
      cacheFake = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        invalidar: vi.fn(async () => {}),
        cachear: vi.fn(async () => {}),
        frescura: vi.fn(async () => null),
        todosVigentes: vi.fn(async () => []),
      };
      return cacheFake;
    },
  };

  const fakeWindow = {
    OfflineCore: fakeOfflineCore,
    fetch: vi.fn(async () => {
      throw new Error('fetch no mockeado en este test — pasá windowExtra.fetch');
    }),
    alert: vi.fn(),
    console,
    navigator: { onLine: true },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, addEventListener: () => {} }),
      querySelector: () => null,
      head: { appendChild: () => {} },
    },
    crypto: globalThis.crypto,
    addEventListener: () => {},
    removeEventListener: () => {},
    authCtx: undefined,
    ...windowExtra,
  };
  // Los mocks de vi.fn() para alert deben poder verificarse con expect().
  fakeWindow.window = fakeWindow;

  const sandbox = {
    window: fakeWindow,
    OfflineCore: fakeOfflineCore,
    fetch: fakeWindow.fetch,
    alert: fakeWindow.alert,
    console,
    navigator: fakeWindow.navigator,
    document: fakeWindow.document,
    crypto: globalThis.crypto,
    indexedDB: windowExtra.indexedDB,
    globalThis: undefined, // se completa abajo
  };
  sandbox.globalThis = sandbox;

  const contexto = vm.createContext(sandbox);
  const script = new vm.Script(codigo, { filename: rutaAbsoluta });
  script.runInContext(contexto);

  if (!outboxOpts) {
    throw new Error(
      `[cargar-modulo-offline] ${rutaAbsoluta} no llamó a OfflineCore.crearOutbox — ` +
        `¿cambió el nombre de la función, o el IIFE se cortó antes por un throw?`
    );
  }

  return { outboxOpts, outboxFake, cacheFake, window: fakeWindow, contexto };
}
