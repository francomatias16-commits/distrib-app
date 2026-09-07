// tests/asistente/lote7-formato-error.test.js
//
// Fase 3 (continuacion) -- septimo lote: automatizacion.js y precios.js.
//
// A diferencia de los lotes anteriores, en estos dos archivos las tools
// en si mismas (crear_regla_automatizacion_asistente, editar_regla_...,
// crear_regla_precio_asistente, editar_regla_precio_asistente) no tenian
// ningun candidato limpio -- sus unicos throw new Error() son "No
// especificaste ningun dato para cambiar" (mismo patron ya excluido en
// crear_producto/editar_producto, lote de stock.js) y wrappers de
// error.message de los repos (no son de autoria de este archivo).
//
// Los candidatos reales estaban un nivel mas abajo, en las funciones
// compartidas de _helpers.js que solo usan estos dos archivos:
//
//   - armarAccionRegla (usada por crear/editar regla de automatizacion):
//       "Falta indicar que debe hacer la regla..." -> faltaDato() sobre
//       accion_tipo. "La notificacion necesita un titulo/mensaje" y "La
//       tarea necesita un titulo" -> faltaDato() por cada campo.
//   - armarCondicionRegla (idem): "Falta el valor de la condicion." ->
//       faltaDato() -- se da condicion_campo pero no condicion_valor.
//   - armarCamposReglaAutomatizacion / buscarReglaAutomatizacionPorTexto:
//       "Falta el nombre de la regla de automatizacion" (dos call sites
//       distintos, uno para crear y otro para buscar por referencia al
//       editar) -> faltaDato().
//   - armarCamposReglaPrecio / buscarReglaPrecioPorTexto: mismo patron,
//       "Falta el nombre de la regla de precio" (crear y buscar por
//       referencia) -> faltaDato().
//
// Qué NO se migró (mismo criterio restrictivo de siempre):
//   - "No especificaste ningún dato para cambiar de la(s) regla(s)"
//     (automatizacion.js, precios.js): ya excluido en el lote de stock.js.
//   - Validaciones de valor ya dado pero inválido: "El evento disparador
//     debe ser uno de...", "El operador de la condición debe ser uno
//     de...", "Motor inválido: X" (automatizacion.js); "El tipo de
//     descuento debe ser...", "El valor del descuento es inválido.",
//     "Un descuento porcentual no puede superar el 100%.", "La fecha
//     'desde' no puede ser posterior a 'hasta'" (precios.js) — mismo
//     criterio que excluyó "cantidad debe ser mayor a cero" en lotes
//     anteriores.
//   - "Template de WhatsApp inválido (debe ser uno de: ...)"
//     (armarAccionRegla): a diferencia de los casos de arriba, el
//     mensaje se autodescribe como "inválido" (no "falta"), igual que
//     los casos de enum excluidos — se lo trata igual aunque el check
//     también dispare cuando el campo viene vacío.
//   - "Elegí producto o categoría para la regla, no las dos a la vez."
//     (dos call sites en precios.js): combinación de argumentos
//     inválida, no "nunca lo dio" ni "acción bloqueada".
//   - "No se pudo leer la regla de precio/automatización actual.":
//     chequeo de consistencia interna (la fila desapareció entre el
//     resolve y el re-read), mismo criterio que en facturacion.js.
//   - liquidacion.js y logistica.js: revisados en este lote, sin
//     candidatos — liquidacion.js solo tiene reenvíos de RPC y
//     validación de rango (0-100); logistica.js solo reenvía
//     resultado.error de lib/handlers/chofer_invitacion.js.
//
// Ninguno de estos call sites pega contra la DB antes del throw (todos
// son validación de args en memoria), así que los tests no necesitan
// mockear lib/repos/_db.js para los casos de creación; sí se mockea
// para los dos casos de "editar" que resuelven la referencia primero.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const { TOOLS_AUTOMATIZACION } = await import('../../lib/asistente-tools/automatizacion.js');
const { TOOLS_PRECIOS } = await import('../../lib/asistente-tools/precios.js');

const crearReglaAuto = TOOLS_AUTOMATIZACION.find((t) => t.name === 'crear_regla_automatizacion_asistente');
const editarReglaAuto = TOOLS_AUTOMATIZACION.find((t) => t.name === 'editar_regla_automatizacion_asistente');
const crearReglaPrecio = TOOLS_PRECIOS.find((t) => t.name === 'crear_regla_precio_asistente');
const editarReglaPrecio = TOOLS_PRECIOS.find((t) => t.name === 'editar_regla_precio_asistente');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    ilike: vi.fn(() => obj),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return obj;
}

function mockFromSecuencial(tabla, resultados) {
  let i = 0;
  dbMock.from.mockImplementation((t) => {
    if (t !== tabla) throw new Error(`tabla no mockeada en este test: ${t}`);
    const r = resultados[Math.min(i, resultados.length - 1)];
    i += 1;
    return fakeQuery(r);
  });
}

describe('crear_regla_automatizacion_asistente — faltaDato migrado', () => {
  const base = { nombre: 'Avisar cheques por vencer', evento_disparador: 'cheques_por_vencer' };

  it('sin nombre: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({
      args: { evento_disparador: 'cheques_por_vencer', accion_tipo: 'notificar_push', accion_titulo: 't', accion_mensaje: 'm' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el nombre de la regla de automatización para seguir.');
  });

  it('sin accion_tipo: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({ args: base }).catch((e) => e);
    expect(err.message).toBe(
      'Me falta la acción que debe hacer la regla cuando se dispare (notificar_push, enviar_whatsapp o crear_tarea) para seguir.',
    );
  });

  it('notificar_push sin título: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({
      args: { ...base, accion_tipo: 'notificar_push', accion_mensaje: 'Ojo, vence pronto' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el título de la notificación para seguir.');
  });

  it('notificar_push sin mensaje: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({
      args: { ...base, accion_tipo: 'notificar_push', accion_titulo: 'Cheque por vencer' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el mensaje de la notificación para seguir.');
  });

  it('crear_tarea sin título: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({
      args: { ...base, accion_tipo: 'crear_tarea' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el título de la tarea para seguir.');
  });

  it('con condicion_campo pero sin condicion_valor: faltaDato', async () => {
    const err = await crearReglaAuto.resumen({
      args: {
        ...base, accion_tipo: 'notificar_push', accion_titulo: 't', accion_mensaje: 'm',
        condicion_campo: 'dias_mora', condicion_operador: '>',
      },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el valor de la condición para seguir.');
  });

  it('camino feliz: no tira nada, arma los campos', async () => {
    const resumen = await crearReglaAuto.resumen({
      args: { ...base, accion_tipo: 'notificar_push', accion_titulo: 'Cheque por vencer', accion_mensaje: 'Ojo, vence pronto' },
    });
    expect(resumen).toContain('Avisar cheques por vencer');
  });
});

describe('editar_regla_automatizacion_asistente — faltaDato migrado (buscarReglaAutomatizacionPorTexto)', () => {
  it('sin referencia: faltaDato antes de tocar la DB', async () => {
    const err = await editarReglaAuto.resumen({
      empresaId: EMPRESA_ID, args: {},
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el nombre de la regla de automatización para seguir.');
    expect(dbMock.from).not.toHaveBeenCalled();
  });
});

describe('crear_regla_precio_asistente — faltaDato migrado', () => {
  it('sin nombre: faltaDato', async () => {
    const err = await crearReglaPrecio.resumen({
      empresaId: EMPRESA_ID, args: { tipo_descuento: 'porcentaje', valor: 10 },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el nombre de la regla de precio para seguir.');
    expect(dbMock.from).not.toHaveBeenCalled();
  });
});

describe('editar_regla_precio_asistente — faltaDato migrado (buscarReglaPrecioPorTexto)', () => {
  it('sin referencia: faltaDato antes de tocar la DB', async () => {
    const err = await editarReglaPrecio.resumen({
      empresaId: EMPRESA_ID, args: {},
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el nombre de la regla de precio para seguir.');
    expect(dbMock.from).not.toHaveBeenCalled();
  });

  it('con referencia real pero regla ya no existe: no interfiere con faltaDato (regresión de ruta)', async () => {
    mockFromSecuencial('reglas_precio', [{ data: [], error: null }]);
    const err = await editarReglaPrecio.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'inexistente' },
    }).catch((e) => e);
    expect(err.message).toBe('No encontré ninguna regla de precio parecida a "inexistente".');
  });
});
