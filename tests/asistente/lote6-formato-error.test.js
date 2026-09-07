// tests/asistente/lote6-formato-error.test.js
//
// Fase 3 (continuacion) -- sexto lote: seis archivos de tools por dominio
// que solo tenían 1-2 call sites migrables cada uno (a diferencia de los
// lotes anteriores, de un archivo por vez, acá se agrupan en un solo test
// por eficiencia — el criterio de migración es exactamente el mismo).
//
// pos.js — anular_venta_pos:
//   - "Falta el motivo de la anulación" → faltaDato() (mismo patrón que
//     anular_factura en el lote de facturacion.js).
//   - De paso, en buscarVentaPosPropia (_helpers.js, usada SOLO por esta
//     tool, mismo criterio "se migra al pasar" de siempre): "Falta la
//     referencia de la venta" → faltaDato(); "ya está anulada" y "ya
//     tiene una factura generada" → bloqueado(). Esta función devuelve
//     `{ error: <string> }` en vez de tirar (igual que
//     buscarPedidoSugeridoPropio en el lote de pedidos.js), así que se
//     migró extrayendo `.message` de faltaDato()/bloqueado().
//
// cheques-bcra.js — consultar_cheque_denunciado_bcra:
//   - "Faltan codigo_entidad y numero_cheque..." → faltaDato() (un solo
//     campo compuesto, cubre ambos casos: falta uno o falta el otro).
//
// admin.js — actualizar_datos_empresa:
//   - El CUIT duplicado (constraint 23505 de Postgres) → bloqueado(), en
//     vez del mensaje crudo de la constraint.
//
// conciliacion-bancaria.js — conciliar_lote_automatico:
//   - "El lote X no tiene movimientos pendientes de conciliar" (en
//     resumen(), no se re-chequea en execute() — preexistente, fuera de
//     alcance) → bloqueado().
//
// export-contable.js — generar_export_contable:
//   - "Falta configurar el plan de cuentas..." → bloqueado() sin salida.
//   - "El formato X todavía no está implementado..." → bloqueado(motivo,
//     salida), partido en el punto para reproducir el string original.
//
// notificaciones.js — consultar_preferencias_notificaciones:
//   - "Esta empresa todavía no tiene preferencias configuradas" →
//     bloqueado() (no es "falta un dato del usuario": es un estado de la
//     empresa que bloquea poder responder la consulta).
//
// Qué NO se migró en este lote (mismo criterio restrictivo de siempre):
//   - Los wrappers de error de DB/RPC (`${error.message}`) en los seis
//     archivos: no son de autoría de este código.
//   - "'desde' no puede ser posterior a 'hasta'" (export-contable.js) y
//     "Motor inválido: X" (automatizacion.js, no tocado en este lote):
//     validación de un valor inválido dado por el usuario, no "nunca lo
//     dio" ni "acción bloqueada" — mismo criterio que excluyó "el monto
//     debe ser mayor a cero" en clientes.js/cobranzas.js y "cantidad
//     recibida debe ser mayor a cero" en proveedores.js.
//   - "No especificaste ningún dato para cambiar" (automatizacion.js,
//     precios.js, liquidacion.js): mismo patrón ya excluido a propósito
//     en crear_producto/editar_producto (lote de stock.js).
//   - "Esa referencia coincide con más de un/a X" (conciliacion-bancaria.js
//     y buscarVentaPosPropia): mismo patrón repetido en ~9 lugares de
//     _helpers.js, ninguno migrado nunca — no encaja limpio en ambiguo().
//   - cobranzas.js NO se tocó en este lote: sus únicos 2 call sites
//     ("el monto del cobro tiene que ser mayor a cero") son exactamente
//     el patrón de validación de valor excluido arriba — no hay nada
//     más en ese archivo que encaje en faltaDato/bloqueado.

import { vi, describe, it, expect, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../../lib/repos/_db.js', () => ({ db: dbMock }));

const generarExportMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/export-contable/index.js', () => ({ generarExport: generarExportMock }));

const { TOOLS_POS } = await import('../../lib/asistente-tools/pos.js');
const { TOOLS_CHEQUES_BCRA } = await import('../../lib/asistente-tools/cheques-bcra.js');
const { TOOLS_ADMIN } = await import('../../lib/asistente-tools/admin.js');
const { TOOLS_CONCILIACION_BANCARIA } = await import('../../lib/asistente-tools/conciliacion-bancaria.js');
const { TOOLS_EXPORT_CONTABLE } = await import('../../lib/asistente-tools/export-contable.js');
const { TOOLS_NOTIFICACIONES } = await import('../../lib/asistente-tools/notificaciones.js');

const anularVentaPos = TOOLS_POS.find((t) => t.name === 'anular_venta_pos');
const consultarChequeDenunciado = TOOLS_CHEQUES_BCRA.find((t) => t.name === 'consultar_cheque_denunciado_bcra');
const actualizarDatosEmpresa = TOOLS_ADMIN.find((t) => t.name === 'actualizar_datos_empresa');
const conciliarLoteAutomatico = TOOLS_CONCILIACION_BANCARIA.find((t) => t.name === 'conciliar_lote_automatico');
const generarExportContable = TOOLS_EXPORT_CONTABLE.find((t) => t.name === 'generar_export_contable');
const consultarPreferenciasNotif = TOOLS_NOTIFICACIONES.find((t) => t.name === 'consultar_preferencias_notificaciones');

const EMPRESA_ID = 'e1';

beforeEach(() => {
  dbMock.from.mockReset();
  dbMock.rpc.mockReset();
  generarExportMock.mockReset();
});

function fakeQuery(result) {
  const obj = {
    select: vi.fn(() => obj),
    eq: vi.fn(() => obj),
    gte: vi.fn(() => obj),
    lte: vi.fn(() => obj),
    order: vi.fn(() => obj),
    update: vi.fn(() => obj),
    insert: vi.fn(() => Promise.resolve(result)),
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

describe('anular_venta_pos — faltaDato y bloqueado migrados', () => {
  it('sin motivo: tira faltaDato (venta válida resuelta primero)', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { encontrado: true, estado_venta: 'confirmada', tiene_factura: false, venta_id: 'v1', referencia_corta: 'ABC123', cliente: 'Cliente X', total: 100 },
      error: null,
    });
    const err = await anularVentaPos.execute({
      empresaId: EMPRESA_ID, usuarioId: 'u1', args: { referencia: 'ABC123' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta el motivo de la anulación para seguir.');
    expect(err.opciones).toBeUndefined();
  });

  it('venta ya anulada (vía buscarVentaPosPropia): bloqueado', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { encontrado: true, estado_venta: 'anulada' },
      error: null,
    });
    const err = await anularVentaPos.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'ABC123', motivo: 'x' },
    }).catch((e) => e);
    expect(err.message).toBe('Esa venta ya está anulada.');
    expect(err.opciones).toBeUndefined();
  });

  it('venta ya facturada (vía buscarVentaPosPropia): bloqueado con salida', async () => {
    dbMock.rpc.mockResolvedValue({
      data: { encontrado: true, estado_venta: 'confirmada', tiene_factura: true },
      error: null,
    });
    const err = await anularVentaPos.resumen({
      empresaId: EMPRESA_ID, args: { referencia: 'ABC123', motivo: 'x' },
    }).catch((e) => e);
    expect(err.message).toBe(
      'Esa venta ya tiene una factura generada; para anularla hay que emitir una Nota de Crédito, no se puede usar esta herramienta.',
    );
    expect(err.opciones).toBeUndefined();
  });

  it('sin referencia: faltaDato desde buscarVentaPosPropia', async () => {
    const err = await anularVentaPos.resumen({
      empresaId: EMPRESA_ID, args: { motivo: 'x' },
    }).catch((e) => e);
    expect(err.message).toBe('Me falta la referencia de la venta para seguir.');
    expect(dbMock.rpc).not.toHaveBeenCalled();
  });
});

describe('consultar_cheque_denunciado_bcra — faltaDato migrado', () => {
  it('sin codigo_entidad ni numero_cheque: tira faltaDato, sin llamar al BCRA', async () => {
    const err = await consultarChequeDenunciado.execute({ args: {} }).catch((e) => e);
    expect(err.message).toBe('Me falta el código de entidad y el número de cheque para seguir.');
    expect(err.opciones).toBeUndefined();
  });
});

describe('actualizar_datos_empresa — bloqueado migrado', () => {
  it('CUIT duplicado (constraint 23505): bloqueado en vez del error crudo de Postgres', async () => {
    mockFromSecuencial('empresas', [
      { data: { nombre: 'Mi Empresa', cuit: '20304050607', domicilio: null, telefono: null, email: null, logo_url: null, config: {} }, error: null },
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ]);
    const err = await actualizarDatosEmpresa.execute({
      empresaId: EMPRESA_ID, args: {},
    }).catch((e) => e);
    expect(err.message).toBe('Ese CUIT ya está registrado por otra empresa.');
    expect(err.opciones).toBeUndefined();
  });
});

describe('conciliar_lote_automatico — bloqueado migrado', () => {
  it('lote sin movimientos pendientes: bloqueado', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'conciliacion_bancaria_lotes') {
        return fakeQuery({ data: [{ id: 'LOTE01', nombre_archivo: 'extracto_agosto.csv', cantidad_movimientos: 10, cantidad_conciliados: 10 }], error: null });
      }
      if (tabla === 'conciliacion_bancaria_movimientos') {
        return fakeQuery({ data: [], error: null }); // 0 pendientes
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const err = await conciliarLoteAutomatico.resumen({
      empresaId: EMPRESA_ID, args: { lote: 'LOTE01' },
    }).catch((e) => e);
    expect(err.message).toBe('El lote "extracto_agosto.csv" no tiene movimientos pendientes de conciliar.');
    expect(err.opciones).toBeUndefined();
    expect(dbMock.rpc).not.toHaveBeenCalled(); // 0 pendientes: nunca entra al loop de candidatos
  });
});

describe('generar_export_contable — bloqueado migrado', () => {
  it('plan de cuentas sin configurar (proveedor distinto de generico_csv): bloqueado', async () => {
    mockFromSecuencial('export_contable_config', [
      { data: { proveedor: 'tango', plan_cuentas: {}, separador_decimal: ',', formato_fecha: 'DD/MM/YYYY' }, error: null },
    ]);
    const err = await generarExportContable.execute({
      empresaId: EMPRESA_ID,
      args: { tipo: 'ventas', desde: '2026-08-01', hasta: '2026-08-31' },
    }).catch((e) => e);
    expect(err.message).toBe('Falta configurar el plan de cuentas antes de exportar ventas a tango.');
    expect(err.opciones).toBeUndefined();
    expect(generarExportMock).not.toHaveBeenCalled();
  });

  it('formato no implementado: bloqueado con motivo + salida, generarExport mockeado', async () => {
    dbMock.from.mockImplementation((tabla) => {
      if (tabla === 'export_contable_config') {
        return fakeQuery({ data: { proveedor: 'generico_csv', plan_cuentas: { 1010: 'Caja' }, separador_decimal: ',', formato_fecha: 'DD/MM/YYYY' }, error: null });
      }
      if (tabla === 'v_comprobantes_contables_venta') {
        return fakeQuery({ data: [], error: null });
      }
      throw new Error(`tabla no mockeada en este test: ${tabla}`);
    });
    const errNoImplementado = Object.assign(new Error('no implementado'), { code: 'FORMATO_NO_IMPLEMENTADO' });
    generarExportMock.mockRejectedValue(errNoImplementado);
    const err = await generarExportContable.execute({
      empresaId: EMPRESA_ID,
      args: { tipo: 'ventas', desde: '2026-08-01', hasta: '2026-08-31', proveedor: 'bejerman' },
    }).catch((e) => e);
    expect(err.message).toBe(
      'El formato "bejerman" todavía no está implementado (falta confirmar el layout exacto contra un caso real). '
      + 'Por ahora solo funciona "generico_csv".',
    );
    expect(err.opciones).toBeUndefined();
  });
});

describe('consultar_preferencias_notificaciones — bloqueado migrado', () => {
  it('empresa sin preferencias configuradas todavía: bloqueado', async () => {
    mockFromSecuencial('notif_prefs_auto', [{ data: null, error: null }]);
    const err = await consultarPreferenciasNotif.execute({ empresaId: EMPRESA_ID }).catch((e) => e);
    expect(err.message).toBe('Esta empresa todavía no tiene preferencias de notificaciones configuradas.');
    expect(err.opciones).toBeUndefined();
  });
});
