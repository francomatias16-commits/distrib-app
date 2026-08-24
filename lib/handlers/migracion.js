// lib/handlers/migracion.js
// Wizard de migración asistida de clientes/productos (CSV/Excel -> mapeo -> validación -> confirmar).
// El parseo del archivo es 100% client-side; este handler recibe las filas ya parseadas como JSON.
//
// GET    /api/migracion                          → historial de sesiones de la empresa
// GET    /api/migracion?sesion_id=X&limit=N       → filas de staging de una sesión (+resumen)
// POST   /api/migracion?accion=crear              → crea sesión + sube filas crudas a staging
// POST   /api/migracion?accion=mapear             → aplica mapeo de columnas, valida y dedupea
// PATCH  /api/migracion?accion=fila                → cambia la acción (crear/actualizar/omitir) de una fila
// POST   /api/migracion?accion=confirmar          → escribe las filas válidas en clientes/productos
// POST   /api/migracion?accion=reintentar         → reintenta solo las filas que fallaron al confirmar
// POST   /api/migracion?accion=deshacer           → revierte una sesión "completado" (ver migración 161)
//
// Alcance de "deshacer" (migración 161): solo revierte filas creadas nuevas
// (accion='crear' → DELETE). Las filas que ACTUALIZARON un registro existente
// no se revierten automáticamente (no hay snapshot confiable del "antes" en
// todos los casos) y quedan marcadas para revisión manual. El frontend debe
// invocar accion=deshacer en loop mientras hay_mas=true, igual que confirmar.
//
// Nota de escala: "mapear" aplica el mapeo/validación en bloque (1 RPC por
// cada 1000 filas) y "confirmar" procesa lotes acotados de 500 filas por
// llamada HTTP, server-side dentro de Postgres y de forma idempotente
// (migración 152). El frontend debe invocar accion=confirmar repetidas veces
// mientras la respuesta traiga hay_mas=true; cada llamada es resumible sin
// riesgo de duplicar filas ya procesadas.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { notifAuto } from './_auto-push.js';
import { errorSeguro } from '../error-response.js';
import { listarCodigosProductosPorEmpresa } from '../repos/productos.js';
import { listarCuitClientesPorEmpresa } from '../repos/clientes.js';
import { listarProveedoresParaDedupePorEmpresa } from '../repos/proveedores.js';
import { AuditRepo } from '../repos/index.js';
import { obtenerDepositoPorId, obtenerDepositoPrincipal } from '../repos/pedidos.js';
import {
  obtenerListaPrecioPorId, obtenerListaPrecioDefault,
  listarDepositosParaSelector, listarListasPrecioParaSelector,
} from '../repos/pos.js';
import * as MigracionRepo from '../repos/migracion.js';

const sb = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY]);

const ROLES_MIGRACION = ['dueno', 'admin'];
export { ROLES_MIGRACION };
// P0 item 3 del plan: el techo original de 50.000 existía por el riesgo de
// timeout de una función serverless procesando TODO el archivo en un solo
// request. Ese riesgo ya no aplica — crearSesion, mapearSesion y
// confirmarSesion procesan por lotes resumibles (ver migración 167 y los
// loops `hay_mas` del frontend), así que subir el techo acá no reintroduce
// el problema original. El límite real hoy pasó a ser otro (no resuelto
// todavía, ver plan puntos 3-4): el parseo del Excel/CSV es 100% client-side,
// así que un archivo de cientos de miles de filas puede ahogar el navegador
// de la persona antes de que llegue a subirse. 500.000 es un techo generoso
// para historiales de varios años de cta_cte/pedidos sin acercarse a ese
// límite práctico del lado del cliente.
const MAX_FILAS = 500_000;
const LOTE_INSERT = 1000;

const CAMPOS = {
  clientes: {
    disponibles: [
      'razon_social', 'cuit', 'telefono', 'email', 'domicilio', 'localidad', 'limite_credito', 'saldo_inicial',
      // Migración 154: zona/lista/condición de IVA se resuelven (y crean si hace falta) por nombre;
      // vendedor solo matchea contra usuarios rol=vendedor existentes, nunca se autocrea.
      'zona', 'condicion_iva', 'lista_precios', 'vendedor',
    ],
    requeridos:  ['razon_social', 'cuit'],
    claveDedupe: 'cuit',
  },
  productos: {
    disponibles: [
      'nombre', 'codigo', 'precio', 'stock',
      // Migración 154: categoria/proveedor se resuelven (y crean si hace falta) por nombre.
      'categoria', 'proveedor', 'codigo_barras', 'iva', 'unidad',
      // Migración 157: depósito por fila. Si el archivo trae stock repartido
      // por sucursal (columna "depósito" por fila), se resuelve por nombre
      // (y se crea si no existe) y pisa al depósito de la sesión SOLO para
      // esa fila. Si la fila no trae depósito, cae al de la sesión.
      'deposito',
      // Migración 158: lista de precios por fila (mismo patrón que depósito).
      // Sirve para cargar precio mayorista Y minorista en una sola corrida.
      'lista_precio',
    ],
    requeridos:  ['nombre', 'codigo'],
    claveDedupe: 'codigo',
  },
  // Migración 159: pedidos abiertos. A diferencia de clientes/productos
  // (1 fila = 1 entidad), acá 1 fila = 1 línea de pedido (producto+cantidad)
  // y se agrupan por numero_pedido en mapearSesionPedidos/confirmarSesion.
  // Cliente y producto deben existir ya en el sistema: se resuelven por
  // CUIT/código contra las tablas reales, nunca se autocrean (a diferencia
  // de categoría/proveedor/depósito/lista).
  pedidos: {
    disponibles: ['numero_pedido', 'cliente_cuit', 'producto_codigo', 'cantidad', 'precio_unitario', 'estado'],
    requeridos:  ['numero_pedido', 'cliente_cuit', 'producto_codigo', 'cantidad'],
    claveDedupe: null,
  },
  // Migración 160: histórico de cuenta corriente. 1 fila = 1 movimiento, sin
  // agrupación (a diferencia de pedidos). Acepta 3 formatos de monto/tipo
  // (ver resolverMovimientoCtaCte): monto con signo, monto+tipo, o debe/haber
  // separados — por eso 'monto', 'tipo', 'debe' y 'haber' son todos opcionales
  // a nivel CAMPOS, y la obligatoriedad real de "algún monto" se valida en
  // validarFilaCtaCte. Cliente debe existir ya (se resuelve por CUIT, no se autocrea).
  cta_cte: {
    disponibles: ['cliente_cuit', 'fecha', 'monto', 'tipo', 'debe', 'haber', 'numero_comprobante', 'descripcion'],
    requeridos:  ['cliente_cuit', 'fecha'],
    claveDedupe: null,
  },
  // Migración 162: precios especiales por cliente (override puntual cliente+
  // producto sobre la lista de precios). 1 fila = 1 override, sin agrupación
  // (igual que cta_cte). Cliente y producto deben existir ya — se resuelven
  // por CUIT/código contra las tablas reales, nunca se autocrean (mismo
  // criterio que pedidos/cta_cte).
  precios_clientes: {
    disponibles: ['cliente_cuit', 'producto_codigo', 'precio', 'notas'],
    requeridos:  ['cliente_cuit', 'producto_codigo', 'precio'],
    claveDedupe: null,
  },
  // Migración 164: proveedores como maestro propio. Hoy se autocrean SOLO
  // con nombre como efecto colateral de migrar productos (sin CUIT, contacto
  // ni condiciones de pago). Acá se importan completos. Dedupe dual (CUIT si
  // está, si no razón social/nombre de fantasía — mismo criterio que usa el
  // autocreate de productos) así una fila completa actualiza el stub
  // existente en vez de duplicarlo. claveDedupe queda null porque el dedupe
  // real vive en mapearSesionProveedores (necesita los dos criterios).
  proveedores: {
    disponibles: ['razon_social', 'cuit', 'nombre_fantasia', 'condicion_iva', 'contacto', 'telefono', 'email', 'dias_pago', 'domicilio', 'localidad', 'notas'],
    requeridos:  ['razon_social'],
    claveDedupe: null,
  },
  // Punto 5 del plan de migraciones (P1): órdenes de compra históricas.
  // Mismo patrón que pedidos (cabecera+items agrupados por numero_orden),
  // pero agrupando por proveedor en vez de cliente. El proveedor se
  // resuelve por CUIT o razón social (dedupe dual, igual que la entidad
  // proveedores) y debe existir ya — nunca se autocrea acá.
  ordenes_compra: {
    disponibles: ['numero_orden', 'proveedor_cuit', 'proveedor_razon_social', 'producto_codigo', 'cantidad', 'precio_unitario', 'iva_pct', 'estado', 'fecha_pedido', 'fecha_recepcion', 'notas'],
    requeridos:  ['numero_orden', 'producto_codigo', 'cantidad'],
    claveDedupe: null,
  },
  // Punto 5 del plan de migraciones (P1): pagos a proveedores históricos.
  // 1 fila = 1 pago, sin agrupación (mismo patrón que cta_cte). No lleva
  // saldo corrido porque pagos_proveedor es un registro plano de pagos, no
  // un libro mayor — el saldo pendiente por proveedor se calcula aparte
  // (ver v_cc_proveedor) a partir de OC/facturas/pagos.
  pagos_proveedores: {
    disponibles: ['proveedor_cuit', 'proveedor_razon_social', 'fecha_pago', 'monto', 'medio_pago', 'referencia', 'notas'],
    requeridos:  ['fecha_pago', 'monto'],
    claveDedupe: null,
  },
  // Punto 7 del plan de migraciones (P1) / Gap crítico 3: categorías, depósitos,
  // listas de precios y zonas como entidades propias (migración 173), en vez
  // de autocrearse solo con nombre como efecto colateral de migrar
  // clientes/productos. Dedupe simple por nombre normalizado dentro de la
  // empresa (mismo criterio que ya usan los resolvers migracion_resolver_*).
  categorias: {
    disponibles: ['nombre', 'descripcion', 'orden'],
    requeridos:  ['nombre'],
    claveDedupe: 'nombre',
  },
  // depositos.direccion/responsable son columnas nuevas de la migración 173
  // (antes no existían — el depósito se autocreaba solo con nombre).
  // es_principal solo se aplica si la fila lo pide Y la empresa todavía no
  // tiene un depósito principal (lo resuelve migracion_confirmar_maestro_lote).
  depositos: {
    disponibles: ['nombre', 'direccion', 'responsable', 'es_principal'],
    requeridos:  ['nombre'],
    claveDedupe: 'nombre',
  },
  // Mismo criterio que depositos para es_default: no pisa el default
  // existente de la empresa salvo que no haya ninguno todavía.
  listas_precios: {
    disponibles: ['nombre', 'es_default'],
    requeridos:  ['nombre'],
    claveDedupe: 'nombre',
  },
  // dias_reparto acepta texto libre ("lunes, miércoles y viernes") — se
  // normaliza a los 7 valores canónicos del lado de la RPC de confirmación
  // (migracion_parsear_dias_reparto), no acá.
  zonas: {
    disponibles: ['nombre', 'dias_reparto'],
    requeridos:  ['nombre'],
    claveDedupe: 'nombre',
  },
  // Migración 172 (plan P2, punto 10): lotes / FEFO históricos. 1 fila = 1
  // lote, sin agrupación ni dedupe (dos lotes del mismo producto con el
  // mismo número de lote son válidos — reposiciones separadas). El producto
  // debe existir ya (se resuelve por código, nunca se autocrea — mismo
  // criterio que precios_clientes/pedidos). El depósito sigue el criterio de
  // productos: por fila si viene (se resuelve/autocrea por nombre), si no
  // cae al elegido para la sesión o al principal de la empresa. Esta entidad
  // SOLO inserta en `lotes` (trazabilidad/FEFO) — no toca el stock agregado,
  // que ya se carga vía la migración de productos.
  lotes: {
    disponibles: ['producto_codigo', 'deposito', 'numero_lote', 'cantidad', 'costo_unitario', 'fecha_fabricacion', 'fecha_vencimiento', 'estado_lote'],
    requeridos:  ['producto_codigo', 'cantidad'],
    claveDedupe: null,
  },
  // Migración 174 (plan P2, puntos 10-14): cheques históricos. 1 fila = 1
  // cheque, sin agrupación (mismo patrón que cta_cte/pagos_proveedores).
  // Cliente es OPCIONAL (puede ser un cheque de terceros sin cliente
  // asociado) pero si se informa debe existir ya (nunca se autocrea).
  cheques: {
    disponibles: ['cliente_cuit', 'banco', 'numero', 'monto', 'fecha_vto', 'estado', 'notas'],
    requeridos:  ['monto', 'fecha_vto'],
    claveDedupe: null,
  },
  // Migración 174: puntos de fidelización históricos. 1 fila = 1 movimiento,
  // sin agrupación. Cliente DEBE existir ya (se resuelve por CUIT, nunca se
  // autocrea, mismo criterio que cta_cte/precios_clientes). No reutiliza la
  // función en vivo registrar_movimiento_puntos() porque esa siempre usa
  // NOW() y acá hace falta respetar la fecha histórica real del archivo.
  puntos_fidelizacion: {
    disponibles: ['cliente_cuit', 'tipo', 'cantidad', 'motivo', 'fecha'],
    requeridos:  ['cliente_cuit', 'tipo', 'cantidad'],
    claveDedupe: null,
  },
  // Migración 174: ventas POS históricas. Mismo patrón cabecera+items que
  // ordenes_compra/pedidos, agrupando por numero_venta (+ cliente, que puede
  // ser NULL). Son ventas ya cerradas: no tocan caja/turno en vivo ni
  // generan factura real — son registros de solo lectura para reportes de
  // rentabilidad histórica (punto 14 del plan).
  ventas_pos: {
    disponibles: ['numero_venta', 'cliente_cuit', 'producto_codigo', 'cantidad', 'precio_unitario', 'descuento_pct', 'estado', 'fecha'],
    requeridos:  ['numero_venta', 'producto_codigo', 'cantidad', 'precio_unitario'],
    claveDedupe: null,
  },
  // Migración 177 (cierre gap crítico 1): comprobantes fiscales históricos
  // (facturas y notas de crédito/débito anteriores a la migración). 1 fila =
  // 1 comprobante, sin agrupación (mismo patrón que cheques/puntos). Cliente
  // DEBE existir ya (se resuelve por CUIT, nunca se autocrea — comprobantes_historicos.cliente_id
  // es NOT NULL en la tabla real). Es puramente informativo: no genera CAE
  // ni movimientos de cta_cte, solo se muestra de solo lectura en la ficha
  // de cliente. Dedupe real vive en la constraint UNIQUE(empresa_id,
  // cliente_id, tipo, numero_original) — el RPC hace ON CONFLICT DO NOTHING
  // y cuenta esas filas como "omitidas", no como error.
  comprobantes_historicos: {
    disponibles: ['cliente_cuit', 'tipo', 'numero_original', 'fecha', 'monto', 'moneda', 'observaciones'],
    requeridos:  ['cliente_cuit', 'tipo', 'numero_original', 'fecha', 'monto'],
    claveDedupe: null,
  },
  // Migración 179 (cierre punto 18 del plan): direcciones de entrega como
  // entidad propia del wizard (bulk import), no solo CRUD manual uno por uno
  // (eso ya existía desde la migración 178 vía lib/repos/cliente-direcciones.js).
  // Mismo patrón que comprobantes_historicos: 1 fila = 1 registro, sin
  // agrupación. Cliente DEBE existir ya (se resuelve por CUIT, nunca se
  // autocrea). Dedupe real vive en UNIQUE(empresa_id, cliente_id, domicilio)
  // del lado de la RPC de confirmación (ON CONFLICT DO NOTHING).
  direcciones: {
    disponibles: ['cliente_cuit', 'etiqueta', 'domicilio', 'localidad', 'provincia', 'lat', 'lng', 'notas'],
    requeridos:  ['cliente_cuit', 'domicilio'],
    claveDedupe: null,
  },
};

// Migración 384: cuando el archivo de origen no trae una columna para un
// campo requerido con dedupe propio (hoy: código de producto), el frontend
// puede ofrecer generarlo automáticamente en vez de bloquear la migración.
// El frontend manda este valor sentinel como si fuera el nombre de columna
// elegido en el <select> de mapeo; acá se detecta ANTES de intentar leer
// fila.datos_originales[colOrigen] (esa columna no existe de verdad) y se
// genera un valor único determinístico por fila en su lugar.
const SENTINEL_AUTOGENERAR = '__AUTOGENERAR__';
const CAMPOS_AUTOGENERABLES = {
  productos: new Set(['codigo']),
};

// Determinístico y sin estado: mapearSesion procesa la sesión en lotes
// resumibles (ver LOTE_MAPEO/obtenerLoteSinMapear) a través de múltiples
// requests HTTP, así que no hay forma segura de mantener un contador en
// memoria. En vez de eso, combinamos los últimos caracteres del id de
// sesión (UUID) con el número de fila dentro de esa sesión — ambos ya son
// únicos por diseño, así que la combinación es única sin tener que
// consultar máximos existentes ni coordinar entre lotes.
function generarValorAuto(campo, sesionId, filaNumero) {
  if (campo === 'codigo') {
    const sufijoSesion = String(sesionId).replace(/-/g, '').slice(-6).toUpperCase();
    return `AUTO-${sufijoSesion}-${String(filaNumero).padStart(6, '0')}`;
  }
  return null;
}

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, sb);
  if (!perfil || !ROLES_MIGRACION.includes(perfil.rol)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const accion = req.query.accion;

  try {
    // Punto 9 del plan de migraciones: plantilla de columnas descargable
    // (pre-sesión, no requiere haber subido ningún archivo todavía) y CRUD
    // de plantillas de mapeo guardables/reutilizables.
    if (req.method === 'GET' && accion === 'campos')      return await obtenerCampos(req, res);
    if (req.method === 'GET' && accion === 'plantillas')  return await listarPlantillasMapeo(req, res, perfil);
    if (req.method === 'POST' && accion === 'guardar_plantilla') return await guardarPlantillaMapeo(req, res, perfil);
    if (req.method === 'DELETE' && accion === 'plantilla') return await borrarPlantillaMapeo(req, res, perfil);

    // Punto 2 del machete de auditoría: trazabilidad de origen. Cualquier
    // pantalla del admin (clientes, productos, proveedores, etc.) puede
    // preguntar "¿este registro vino de una migración?" pasando su entidad
    // + id, sin tener que conocer el sesion_id de antemano.
    if (req.method === 'GET' && accion === 'origen')      return await obtenerOrigenMigracion(req, res, perfil);

    if (req.method === 'GET' && !req.query.sesion_id) return await listarSesiones(req, res, perfil);
    if (req.method === 'GET' && req.query.sesion_id)  return await obtenerSesion(req, res, perfil);
    if (req.method === 'POST' && accion === 'crear')      return await crearSesion(req, res, perfil);
    if (req.method === 'POST' && accion === 'mapear')     return await mapearSesion(req, res, perfil);
    if (req.method === 'POST' && accion === 'precheck')   return await precheckSesion(req, res, perfil);
    if (req.method === 'POST' && accion === 'confirmar')  return await confirmarSesion(req, res, perfil);
    if (req.method === 'POST' && accion === 'reintentar') return await reintentarFallidas(req, res, perfil);
    if (req.method === 'POST' && accion === 'deshacer')   return await deshacerSesion(req, res, perfil);
    if (req.method === 'PATCH' && accion === 'fila')      return await cambiarAccionFila(req, res, perfil);

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    console.error('[migracion] error:', err);
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.', { error: 'Error interno: ' + err.message });
  }
}

// ─── Helpers de validación ────────────────────────────────────────────────────
function esEmailValido(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function normalizarCuit(s) {
  return (s ?? '').toString().replace(/[^0-9]/g, '');
}

// Punto 22 del plan de migraciones / P1 item 8: hasta ahora solo se validaba
// que el CUIT tuviera 11 dígitos, no que fuera matemáticamente válido. Un
// CUIT de 11 dígitos inventado o mal tipeado (transposición de dos números,
// por ejemplo) pasaba sin aviso y quedaba cargado tal cual. Esto agrega el
// algoritmo de dígito verificador módulo 11 que usa AFIP para CUIT/CUIL.
const MULTIPLICADORES_CUIT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function cuitDigitoVerificadorValido(cuitNormalizado) {
  if (!/^\d{11}$/.test(cuitNormalizado)) return false;
  const digitos = cuitNormalizado.split('').map(Number);
  const suma = MULTIPLICADORES_CUIT.reduce((acc, mult, i) => acc + mult * digitos[i], 0);
  const resto = suma % 11;
  let verificador = 11 - resto;
  if (verificador === 11) verificador = 0;
  if (verificador === 10) return false; // AFIP: ese resto no tiene CUIT válido posible
  return verificador === digitos[10];
}

// Helper compartido por las 5 validaciones de fila que chequean CUIT (antes
// cada una repetía el chequeo de longitud a mano). `etiqueta` es para que el
// mensaje de error diga "CUIT" o "CUIT de cliente" según corresponda.
function errorDeCuit(cuitNormalizado, etiqueta) {
  if (cuitNormalizado.length !== 11) return `${etiqueta} inválido (debe tener 11 dígitos)`;
  if (!cuitDigitoVerificadorValido(cuitNormalizado)) {
    return `${etiqueta} inválido (no pasa la validación de dígito verificador de AFIP — revisá que esté bien tipeado)`;
  }
  return null;
}

// Migración 165 (gap de QA pre-venta): aNumero original asumía SIEMPRE formato
// argentino (coma decimal), así que un archivo viejo exportado con punto
// decimal estilo US ("1234.56") se leía mal y daba 123456 sin error visible
// — corrupción silenciosa de datos. Ahora: si hay coma Y punto, el que
// aparece último es el decimal (cubre AR "1.234,56" y US "1,234.56"); si
// hay un solo tipo de separador, coma siempre es decimal (AR), y un punto
// solo se trata como separador de miles si es un único punto seguido de
// grupos de exactamente 3 dígitos (p.ej. "1.234" o "100.000.000" = miles
// AR) — en cualquier otro caso (1-2 dígitos después del punto) se asume
// decimal. Ambigüedad residual que no se puede resolver sin contexto: un
// precio real "1.234" con tres decimales (rarísimo) se leería como mil
// doscientos treinta y cuatro en vez de uno coma dos tres cuatro.
function aNumero(s) {
  if (s === null || s === undefined || s === '') return null;
  let str = String(s).trim();
  if (str === '') return null;

  // Migración de optimización de sistema (root cause): el wizard lee el Excel
  // con SheetJS en modo raw:false (necesario para que fechas y textos se vean
  // bien en el resto del wizard), lo que hace que celdas con formato moneda
  // (ej. columna PRECIO con formato "$ #,##0.00" en Crystal Reports/Excel AR)
  // lleguen como string ya formateado, ej. "$ 1,390.00" en vez de 1390. Antes
  // de interpretar separadores de miles/decimales, se despoja todo lo que no
  // sea dígito, coma, punto o signo menos (símbolos de moneda, códigos de
  // moneda como "ARS"/"USD", espacios, NBSP, etc.). Si tras limpiar no queda
  // ningún dígito pero el string original sí tenía contenido (ej. "N/A"),
  // NO se trata como vacío: cae a NaN más abajo, error real de validación.
  const original = str;
  str = str.replace(/[^\d,.\-]/g, '');
  if (str === '') {
    // Tenía contenido pero no era numérico en absoluto (ej. "N/A", "-").
    return original.trim() === '' ? null : NaN;
  }

  const tieneComa = str.includes(',');
  const tienePunto = str.includes('.');
  let normalizado;

  if (tieneComa && tienePunto) {
    const ultimaComa = str.lastIndexOf(',');
    const ultimoPunto = str.lastIndexOf('.');
    normalizado = ultimaComa > ultimoPunto
      ? str.replace(/\./g, '').replace(',', '.')   // AR/EU: 1.234.567,89
      : str.replace(/,/g, '');                       // US/UK: 1,234,567.89
  } else if (tieneComa) {
    normalizado = str.replace(',', '.');             // solo coma: siempre decimal AR
  } else if (tienePunto) {
    const partes = str.split('.');
    const ultimaParte = partes[partes.length - 1];
    const esGrupoDeMiles = ultimaParte.length === 3 && partes.length > 1
      && partes.slice(1).every(p => p.length === 3);
    normalizado = esGrupoDeMiles ? str.replace(/\./g, '') : str;
  } else {
    normalizado = str;
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : NaN;
}

// Migración 165 (gap de QA pre-venta): los campos numéricos llegaban a
// datos_mapeados tal cual venían del archivo (ej. "1.234,56", formato
// argentino real) y las funciones SQL de confirmación los castean directo
// con ::NUMERIC / ::INT, que NO entienden coma decimal. La fila pasaba la
// validación del wizard como "válida" y recién explotaba al confirmar, con
// un error crudo de Postgres ("invalid input syntax for type numeric") —
// confirmado con una fila real contra la base. Se normaliza acá, mismo
// lugar/momento que ya hacía cta_cte con monto_resuelto, así lo que llega
// a la base es siempre un número limpio. Si el campo no vino o no es válido
// se deja como estaba: la validación de arriba ya marcó la fila con error
// en ese caso, así que nunca llega a confirmarse (los RPC solo procesan
// es_valida = true).
function normalizarCamposNumericos(datosMapeados, campos) {
  for (const campo of campos) {
    if (datosMapeados[campo] === undefined || datosMapeados[campo] === '') continue;
    const n = aNumero(datosMapeados[campo]);
    if (n !== null && !Number.isNaN(n)) datosMapeados[campo] = n;
  }
}

// ─── Resumen agregado post-mapeo (migración 166, plan de optimización P0 #2) ──
// Antes del mapeo, la única forma de saber "qué va a pasar" con un archivo de
// 20.000 filas era scrollear la tabla de revisión fila por fila. Estas 3
// funciones acumulan, durante el mismo loop que ya recorre las filas para
// validar/mapear, un resumen ejecutivo: cuántas se van a crear vs actualizar,
// y cuáles son los errores más frecuentes (para poder arreglar el archivo
// origen en vez de corregir fila por fila desde la UI).
function crearResumenMapeo() {
  return { porAccion: { crear: 0, actualizar: 0 }, erroresConteo: new Map() };
}

function registrarEnResumen(resumen, accion, esValida, errores) {
  if (esValida) {
    resumen.porAccion[accion] = (resumen.porAccion[accion] || 0) + 1;
  } else {
    for (const msg of errores) {
      resumen.erroresConteo.set(msg, (resumen.erroresConteo.get(msg) || 0) + 1);
    }
  }
}

// Top 5 errores más frecuentes — más que eso deja de ser "resumen ejecutivo"
// y empieza a ser la misma lista fila por fila que esto viene a evitar.
function cerrarResumen(resumen, totalValidas, totalError) {
  const topErrores = [...resumen.erroresConteo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mensaje, cantidad]) => ({ mensaje, cantidad }));

  return {
    por_accion: resumen.porAccion,
    total_validas: totalValidas,
    total_error: totalError,
    top_errores: topErrores,
  };
}

// Migración 160: validación de líneas de cta_cte. Solo forma de los datos
// crudos (CUIT con formato válido, fecha interpretable, algún monto
// utilizable). La existencia real del cliente y la resolución de
// tipo/monto/fecha definitivos se hacen en mapearSesionCtaCte, porque
// necesitan tocar la tabla clientes y los helpers de abajo.
function validarFilaCtaCte(datos) {
  const errores = [];

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.fecha || !String(datos.fecha).trim()) {
    errores.push('Falta fecha');
  } else if (!aFechaISO(datos.fecha)) {
    errores.push(`Fecha "${datos.fecha}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  const resuelto = resolverMovimientoCtaCte(datos);
  if (resuelto.error) errores.push(resuelto.error);

  return errores;
}

// Migración 162: validación de líneas de precio especial por cliente. Solo
// forma de los datos crudos; la existencia real de cliente/producto se
// chequea en mapearSesionPreciosClientes (necesita tocar otras tablas).
function validarFilaPreciosClientes(datos) {
  const errores = [];

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.producto_codigo || !String(datos.producto_codigo).trim()) errores.push('Falta código de producto');

  const precio = aNumero(datos.precio);
  if (datos.precio === undefined || datos.precio === '' || Number.isNaN(precio) || precio < 0) {
    errores.push('Precio inválido (debe ser un número mayor o igual a 0)');
  }

  return errores;
}

// Migración 164: validación de líneas de proveedor. razon_social es el único
// campo realmente obligatorio (igual que clientes con cuit) — el resto son
// datos de contacto/pago que hoy ni siquiera existen en el autocreate.
function validarFilaProveedores(datos) {
  const errores = [];

  if (!datos.razon_social || !String(datos.razon_social).trim()) {
    errores.push('Falta razón social');
  }

  if (datos.cuit !== undefined && datos.cuit !== null && String(datos.cuit).trim() !== '') {
    const cuit = normalizarCuit(datos.cuit);
    const err = errorDeCuit(cuit, 'CUIT');
    if (err) errores.push(err);
  }

  if (datos.email !== undefined && datos.email !== null && String(datos.email).trim() !== '' && !esEmailValido(String(datos.email).trim())) {
    errores.push('Email inválido');
  }

  if (datos.dias_pago !== undefined && datos.dias_pago !== null && String(datos.dias_pago).trim() !== '') {
    const dias = aNumero(datos.dias_pago);
    if (Number.isNaN(dias) || dias < 0) errores.push('Días de pago inválido (debe ser un número mayor o igual a 0)');
  }

  return errores;
}

// Migración 173 (punto 7 del plan): validación de las 4 entidades "maestro"
// (categorias/depositos/listas_precios/zonas). Todas comparten el mismo
// único requisito real: nombre no vacío. dias_reparto no se valida acá
// estrictamente (texto libre tolerante) porque la RPC descarta cualquier
// token que no matchee un día válido — preferible dejarlo pasar con un
// dato parcial a bloquear la fila por un error de tipeo en un día.
function validarFilaMaestro(datos) {
  const errores = [];
  if (!datos.nombre || !String(datos.nombre).trim()) {
    errores.push('Falta nombre');
  }
  if (datos.orden !== undefined && datos.orden !== null && String(datos.orden).trim() !== '') {
    const orden = aNumero(datos.orden);
    if (Number.isNaN(orden)) errores.push('Orden inválido (debe ser un número)');
  }
  return errores;
}

// ─── Punto 5 del plan de migraciones (P1): órdenes de compra y pagos a proveedores ──
const ESTADOS_OC_VALIDOS = new Set(['borrador', 'pendiente_aprobacion', 'enviada', 'confirmada', 'recibida_parcial', 'recibida', 'cancelada']);
const SINONIMOS_ESTADO_OC = {
  recibido: 'recibida', recibida: 'recibida', completo: 'recibida', completa: 'recibida', entregado: 'recibida', entregada: 'recibida',
  parcial: 'recibida_parcial', recibida_parcial: 'recibida_parcial', 'recibido parcial': 'recibida_parcial', 'recibida parcial': 'recibida_parcial',
  cancelado: 'cancelada', cancelada: 'cancelada', anulado: 'cancelada', anulada: 'cancelada',
  confirmado: 'confirmada', confirmada: 'confirmada',
  enviado: 'enviada', enviada: 'enviada',
  pendiente: 'pendiente_aprobacion', pendiente_aprobacion: 'pendiente_aprobacion',
  borrador: 'borrador',
};

// Una OC histórica se asume ya recibida si el archivo no dice lo contrario
// (es lo más común al migrar historial: pedirle al usuario el estado exacto
// de cada orden de hace años es fricción sin mucho valor). Devuelve null si
// el texto no matchea ningún estado conocido (error de validación).
function normalizarEstadoOC(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (!t) return 'recibida';
  return SINONIMOS_ESTADO_OC[t] || (ESTADOS_OC_VALIDOS.has(t) ? t : null);
}

function validarFilaOrdenesCompra(datos) {
  const errores = [];
  if (!datos.numero_orden || !String(datos.numero_orden).trim()) errores.push('Falta número de orden');

  const tieneCuit = datos.proveedor_cuit !== undefined && String(datos.proveedor_cuit ?? '').trim() !== '';
  const tieneRazonSocial = datos.proveedor_razon_social !== undefined && String(datos.proveedor_razon_social ?? '').trim() !== '';
  if (!tieneCuit && !tieneRazonSocial) errores.push('Falta CUIT o razón social del proveedor');
  if (tieneCuit) {
    const cuit = normalizarCuit(datos.proveedor_cuit);
    const err = errorDeCuit(cuit, 'CUIT de proveedor');
    if (err) errores.push(err);
  }

  if (!datos.producto_codigo || !String(datos.producto_codigo).trim()) errores.push('Falta código de producto');

  const cantidad = aNumero(datos.cantidad);
  if (datos.cantidad === undefined || datos.cantidad === '' || Number.isNaN(cantidad) || cantidad <= 0) {
    errores.push('Cantidad inválida (debe ser un número mayor a 0)');
  }

  if (datos.precio_unitario !== undefined && datos.precio_unitario !== '') {
    const n = aNumero(datos.precio_unitario);
    if (Number.isNaN(n) || n < 0) errores.push('Precio unitario no es un número válido');
  }
  if (datos.iva_pct !== undefined && datos.iva_pct !== '') {
    const n = aNumero(datos.iva_pct);
    if (Number.isNaN(n) || n < 0 || n > 100) errores.push('IVA no es un porcentaje válido (0-100)');
  }
  if (datos.estado !== undefined && String(datos.estado).trim() !== '' && !normalizarEstadoOC(datos.estado)) {
    errores.push(`Estado "${datos.estado}" no reconocido (usá borrador/enviada/confirmada/recibida parcial/recibida/cancelada)`);
  }
  if (datos.fecha_pedido && String(datos.fecha_pedido).trim() !== '' && !aFechaISO(datos.fecha_pedido)) {
    errores.push(`Fecha de pedido "${datos.fecha_pedido}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }
  if (datos.fecha_recepcion && String(datos.fecha_recepcion).trim() !== '' && !aFechaISO(datos.fecha_recepcion)) {
    errores.push(`Fecha de recepción "${datos.fecha_recepcion}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  return errores;
}

const MEDIOS_PAGO_VALIDOS = new Set(['efectivo', 'transferencia', 'cheque', 'otro']);
function normalizarMedioPago(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (!t) return 'transferencia';
  return MEDIOS_PAGO_VALIDOS.has(t) ? t : null;
}

function validarFilaPagosProveedores(datos) {
  const errores = [];

  const tieneCuit = datos.proveedor_cuit !== undefined && String(datos.proveedor_cuit ?? '').trim() !== '';
  const tieneRazonSocial = datos.proveedor_razon_social !== undefined && String(datos.proveedor_razon_social ?? '').trim() !== '';
  if (!tieneCuit && !tieneRazonSocial) errores.push('Falta CUIT o razón social del proveedor');
  if (tieneCuit) {
    const cuit = normalizarCuit(datos.proveedor_cuit);
    const err = errorDeCuit(cuit, 'CUIT de proveedor');
    if (err) errores.push(err);
  }

  if (!datos.fecha_pago || !String(datos.fecha_pago).trim()) {
    errores.push('Falta fecha de pago');
  } else if (!aFechaISO(datos.fecha_pago)) {
    errores.push(`Fecha "${datos.fecha_pago}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  const monto = aNumero(datos.monto);
  if (datos.monto === undefined || datos.monto === '' || Number.isNaN(monto) || monto <= 0) {
    errores.push('Monto inválido (debe ser un número mayor a 0)');
  }

  if (datos.medio_pago !== undefined && String(datos.medio_pago).trim() !== '' && !normalizarMedioPago(datos.medio_pago)) {
    errores.push(`Medio de pago "${datos.medio_pago}" no reconocido (usá efectivo/transferencia/cheque/otro)`);
  }

  return errores;
}

// Migración 172 (plan P2, punto 10): validación de líneas de lote/FEFO. Solo
// forma de los datos crudos; la existencia real del producto se chequea en
// mapearSesionLotes (necesita tocar la tabla productos). El depósito no se
// valida acá porque se resuelve/autocrea por nombre server-side, dentro de
// migracion_confirmar_lotes_lote (igual que en la migración de productos).
const ESTADOS_LOTE_VALIDOS = new Set(['activo', 'agotado', 'vencido']);
function normalizarEstadoLote(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (!t) return 'activo';
  return ESTADOS_LOTE_VALIDOS.has(t) ? t : null;
}

function validarFilaLotes(datos) {
  const errores = [];

  if (!datos.producto_codigo || !String(datos.producto_codigo).trim()) errores.push('Falta código de producto');

  const cantidad = aNumero(datos.cantidad);
  if (datos.cantidad === undefined || datos.cantidad === '' || Number.isNaN(cantidad) || cantidad < 0) {
    errores.push('Cantidad inválida (debe ser un número mayor o igual a 0)');
  }

  if (datos.costo_unitario !== undefined && datos.costo_unitario !== '') {
    const costo = aNumero(datos.costo_unitario);
    if (Number.isNaN(costo) || costo < 0) errores.push('Costo unitario no es un número válido');
  }

  if (datos.fecha_fabricacion && String(datos.fecha_fabricacion).trim() !== '' && !aFechaISO(datos.fecha_fabricacion)) {
    errores.push(`Fecha de fabricación "${datos.fecha_fabricacion}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }
  if (datos.fecha_vencimiento && String(datos.fecha_vencimiento).trim() !== '' && !aFechaISO(datos.fecha_vencimiento)) {
    errores.push(`Fecha de vencimiento "${datos.fecha_vencimiento}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }
  if (datos.estado_lote !== undefined && String(datos.estado_lote).trim() !== '' && !normalizarEstadoLote(datos.estado_lote)) {
    errores.push(`Estado de lote "${datos.estado_lote}" no reconocido (usá activo/agotado/vencido)`);
  }

  return errores;
}

// ─── Migración 174 (plan P2, puntos 10-14): cheques, puntos, ventas POS ──────
// FIX (auditoría post-v200c): el set anterior (en_cartera/depositado/rechazado/
// entregado) no coincidía con el constraint real de la tabla `cheques`
// (cheques_estado_check = pendiente/en_cartera/cobrado/depositado/rechazado/
// entregado_proveedor/anulado). Una fila con estado "entregado" pasaba la
// validación del wizard (es_valida=true) y recién fallaba al confirmar, con
// un error crudo de Postgres — se detectó corriendo el RPC de confirmación
// contra la base real con datos de prueba, no con la validación aislada en
// Node. El mapa de abajo usa los valores reales del constraint como claves
// canónicas, con sinónimos en español para lo que razonablemente escribiría
// una empresa en su Excel (incluye "endosado", que es como lo etiqueta el
// módulo de cheques en vivo para el mismo concepto de entregado_proveedor).
const MAPA_ESTADO_CHEQUE = {
  pendiente: 'pendiente',
  en_cartera: 'en_cartera', cartera: 'en_cartera',
  cobrado: 'cobrado',
  depositado: 'depositado',
  rechazado: 'rechazado',
  entregado_proveedor: 'entregado_proveedor', entregado: 'entregado_proveedor', endosado: 'entregado_proveedor',
  anulado: 'anulado',
};
function normalizarEstadoCheque(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (!t) return 'en_cartera';
  return MAPA_ESTADO_CHEQUE[t] || null;
}

// Cliente es OPCIONAL en cheques (puede ser de terceros), por eso no se
// valida acá como obligatorio — mapearSesionCheques solo lo resuelve/valida
// SI vino informado en la fila (mismo criterio de "opcional pero si está
// tiene que existir" que proveedor en pagos_proveedores).
function validarFilaCheques(datos) {
  const errores = [];

  const monto = aNumero(datos.monto);
  if (datos.monto === undefined || datos.monto === '' || Number.isNaN(monto) || monto <= 0) {
    errores.push('Monto inválido (debe ser un número mayor a 0)');
  }

  if (!datos.fecha_vto || !String(datos.fecha_vto).trim()) {
    errores.push('Falta fecha de vencimiento');
  } else if (!aFechaISO(datos.fecha_vto)) {
    errores.push(`Fecha "${datos.fecha_vto}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  if (datos.estado !== undefined && String(datos.estado).trim() !== '' && !normalizarEstadoCheque(datos.estado)) {
    errores.push(`Estado "${datos.estado}" no reconocido (usá en_cartera/depositado/cobrado/rechazado/entregado_proveedor/anulado/pendiente)`);
  }

  return errores;
}

const TIPOS_PUNTOS_VALIDOS = { ganancia: 'ganancia', ganado: 'ganancia', acumulado: 'ganancia', canje: 'canje', canjeado: 'canje', ajuste: 'ajuste' };
function normalizarTipoPuntos(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  return TIPOS_PUNTOS_VALIDOS[t] || null;
}

// Cliente DEBE existir ya (se resuelve por CUIT en mapearSesionPuntos, nunca
// se autocrea — mismo criterio que cta_cte/precios_clientes).
function validarFilaPuntos(datos) {
  const errores = [];

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.tipo || !normalizarTipoPuntos(datos.tipo)) {
    errores.push(`Tipo "${datos.tipo || ''}" no reconocido (usá ganancia/canje/ajuste)`);
  }

  const cantidad = aNumero(datos.cantidad);
  if (datos.cantidad === undefined || datos.cantidad === '' || Number.isNaN(cantidad) || cantidad <= 0) {
    errores.push('Cantidad inválida (debe ser un número mayor a 0)');
  }

  if (datos.fecha && String(datos.fecha).trim() !== '' && !aFechaISO(datos.fecha)) {
    errores.push(`Fecha "${datos.fecha}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  return errores;
}

// Ventas POS: cabecera+items agrupados por numero_venta (como pedidos/OC).
// Cliente es OPCIONAL (venta de mostrador sin cliente asociado); producto
// DEBE existir ya (se resuelve por código, nunca se autocrea).
// FIX (auditoría post-v200c): el campo `estado` no tenía NINGUNA validación
// acá (se lowercaseaba tal cual y se mandaba al RPC) pero el constraint real
// de la tabla `ventas_pos` (ventas_pos_estado_check) solo acepta
// completada/anulada. Un valor como "Cancelada" pasaba el wizard entero y
// recién fallaba al confirmar, con un error crudo de Postgres — mismo patrón
// de bug que se encontró y corrigió en cheques, detectado acá corriendo el
// RPC de confirmación contra la base real.
const MAPA_ESTADO_VENTA_POS = {
  completada: 'completada', completado: 'completada', cerrada: 'completada', cerrado: 'completada', pagada: 'completada', pagado: 'completada',
  anulada: 'anulada', anulado: 'anulada', cancelada: 'anulada', cancelado: 'anulada',
};
function normalizarEstadoVentaPos(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (!t) return 'completada';
  return MAPA_ESTADO_VENTA_POS[t] || null;
}

function validarFilaVentasPos(datos) {
  const errores = [];

  if (!datos.numero_venta || !String(datos.numero_venta).trim()) errores.push('Falta número de venta');
  if (!datos.producto_codigo || !String(datos.producto_codigo).trim()) errores.push('Falta código de producto');

  const cantidad = aNumero(datos.cantidad);
  if (datos.cantidad === undefined || datos.cantidad === '' || Number.isNaN(cantidad) || cantidad <= 0) {
    errores.push('Cantidad inválida (debe ser un número mayor a 0)');
  }

  const precio = aNumero(datos.precio_unitario);
  if (datos.precio_unitario === undefined || datos.precio_unitario === '' || Number.isNaN(precio) || precio < 0) {
    errores.push('Precio unitario inválido (debe ser un número mayor o igual a 0)');
  }

  if (datos.descuento_pct !== undefined && String(datos.descuento_pct).trim() !== '') {
    const d = aNumero(datos.descuento_pct);
    if (Number.isNaN(d) || d < 0 || d > 100) errores.push('Descuento no es un porcentaje válido (0-100)');
  }

  if (datos.estado !== undefined && String(datos.estado).trim() !== '' && !normalizarEstadoVentaPos(datos.estado)) {
    errores.push(`Estado "${datos.estado}" no reconocido (usá completada/anulada)`);
  }

  if (datos.fecha && String(datos.fecha).trim() !== '' && !aFechaISO(datos.fecha)) {
    errores.push(`Fecha "${datos.fecha}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  return errores;
}

// Migración 177 (cierre gap crítico 1): validación de comprobantes fiscales
// históricos. Cliente DEBE existir ya (se resuelve por CUIT, nunca se
// autocrea — comprobantes_historicos.cliente_id es NOT NULL en la tabla
// real). tipo está restringido por el CHECK real de la tabla
// (comprobantes_historicos_tipo_check: factura/nota_credito/nota_debito), y
// el dedupe real vive en la UNIQUE(empresa_id, cliente_id, tipo,
// numero_original) — por eso numero_original es obligatorio acá también.
const TIPOS_COMPROBANTE_VALIDOS = { factura: 'factura', nota_credito: 'nota_credito', 'nota de credito': 'nota_credito', 'nota de crédito': 'nota_credito', nc: 'nota_credito', nota_debito: 'nota_debito', 'nota de debito': 'nota_debito', 'nota de débito': 'nota_debito', nd: 'nota_debito' };
function normalizarTipoComprobante(texto) {
  const t = (texto || '').toString().trim().toLowerCase();
  return TIPOS_COMPROBANTE_VALIDOS[t] || null;
}

function validarFilaComprobantesHistoricos(datos) {
  const errores = [];

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.tipo || !normalizarTipoComprobante(datos.tipo)) {
    errores.push(`Tipo "${datos.tipo || ''}" no reconocido (usá factura/nota de crédito/nota de débito)`);
  }

  if (!datos.numero_original || !String(datos.numero_original).trim()) {
    errores.push('Falta número de comprobante original');
  }

  if (!datos.fecha || !String(datos.fecha).trim()) {
    errores.push('Falta fecha');
  } else if (!aFechaISO(datos.fecha)) {
    errores.push(`Fecha "${datos.fecha}" no se pudo interpretar (usá dd/mm/yyyy o yyyy-mm-dd)`);
  }

  const monto = aNumero(datos.monto);
  if (datos.monto === undefined || datos.monto === '' || Number.isNaN(monto) || monto <= 0) {
    errores.push('Monto inválido (debe ser un número mayor a 0)');
  }

  return errores;
}

// Migración 179 (cierre punto 18 del plan): validación de direcciones de
// entrega bulk. Cliente DEBE existir ya (se resuelve por CUIT, nunca se
// autocrea — mismo criterio que cheques/puntos/comprobantes_historicos).
// domicilio es el único campo de contenido obligatorio (etiqueta tiene
// default 'Principal' en la RPC de confirmación); lat/lng son opcionales
// pero si vienen tienen que ser numéricos y estar dentro de rango válido.
function validarFilaDirecciones(datos) {
  const errores = [];

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.domicilio || !String(datos.domicilio).trim()) {
    errores.push('Falta domicilio');
  }

  if (datos.lat !== undefined && datos.lat !== '') {
    const lat = aNumero(datos.lat);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) errores.push('Latitud inválida (debe estar entre -90 y 90)');
  }
  if (datos.lng !== undefined && datos.lng !== '') {
    const lng = aNumero(datos.lng);
    if (Number.isNaN(lng) || lng < -180 || lng > 180) errores.push('Longitud inválida (debe estar entre -180 y 180)');
  }

  return errores;
}

// Parser de fechas tolerante a los formatos más comunes en
// archivos argentinos (dd/mm/yyyy, dd-mm-yyyy, ISO) y a números de serie de
// Excel (cuando SheetJS no convierte la celda y llega como entero crudo).
// Devuelve 'YYYY-MM-DD' o null si no se pudo interpretar.
function aFechaISO(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const s = String(valor).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const conSeparador = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (conSeparador) {
    let [, d, m, a] = conSeparador;
    if (a.length === 2) a = (Number(a) > 50 ? '19' : '20') + a;
    d = d.padStart(2, '0'); m = m.padStart(2, '0');
    if (Number(m) > 12) return null; // formato ambiguo m/d en vez de d/m: no adivinar
    return `${a}-${m}-${d}`;
  }

  // Serial de Excel (días desde 1899-12-30), típico cuando una celda fecha
  // llega como número crudo en vez de string formateado.
  if (/^\d{4,6}$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const ms = (serial - 25569) * 86400 * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }

  return null;
}

const TIPOS_CARGO = new Set(['factura', 'debito', 'débito', 'cargo', 'debe']);
const TIPOS_PAGO  = new Set(['pago', 'cobro', 'credito', 'crédito', 'haber', 'abono']);
const TIPOS_NC    = new Set(['nota_credito', 'nota de credito', 'nota de crédito', 'nc']);

function normalizarTipoCtaCte(texto, signoNumero) {
  const t = (texto || '').toString().trim().toLowerCase();
  if (TIPOS_NC.has(t)) return 'nota_credito';
  if (TIPOS_CARGO.has(t)) return 'factura';
  if (TIPOS_PAGO.has(t)) return 'pago';
  if (t) return null; // texto no reconocido: no se adivina, se informa como error
  // Sin texto de tipo: se infiere del signo del monto (formato más simple).
  return signoNumero >= 0 ? 'factura' : 'pago';
}

// Migración 160: detecta cuál de los 3 formatos trae la fila (monto con
// signo, monto+tipo, o debe/haber separados) y devuelve {tipo, monto} ya
// normalizados, o null si la fila no trae ningún dato de monto utilizable.
function resolverMovimientoCtaCte(datos) {
  const tieneMonto = datos.monto !== undefined && datos.monto !== '';
  const tieneDebe   = datos.debe  !== undefined && datos.debe  !== '' && Number(aNumero(datos.debe))  !== 0;
  const tieneHaber  = datos.haber !== undefined && datos.haber !== '' && Number(aNumero(datos.haber)) !== 0;

  if (tieneMonto) {
    const n = aNumero(datos.monto);
    if (Number.isNaN(n)) return { error: 'Monto no es un número válido' };
    const tipo = normalizarTipoCtaCte(datos.tipo, n);
    if (!tipo) return { error: `Tipo "${datos.tipo}" no reconocido (usá factura/pago/cobro/nota de crédito, etc.)` };
    return { tipo, monto: Math.abs(n) };
  }
  if (tieneDebe) {
    const n = aNumero(datos.debe);
    if (Number.isNaN(n)) return { error: 'Columna "debe" no es un número válido' };
    return { tipo: 'factura', monto: Math.abs(n) };
  }
  if (tieneHaber) {
    const n = aNumero(datos.haber);
    if (Number.isNaN(n)) return { error: 'Columna "haber" no es un número válido' };
    const tipo = normalizarTipoCtaCte(datos.tipo, -1) || 'pago';
    return { tipo, monto: Math.abs(n) };
  }
  return { error: 'No se pudo determinar el monto (mapeá "monto", o "debe"/"haber")' };
}

function validarFilaClientes(datos) {
  const errores = [];
  if (!datos.razon_social || !String(datos.razon_social).trim()) errores.push('Falta razón social');

  const cuit = normalizarCuit(datos.cuit);
  if (!cuit) errores.push('Falta CUIT');
  else {
    const err = errorDeCuit(cuit, 'CUIT');
    if (err) errores.push(err);
  }

  if (datos.email && !esEmailValido(String(datos.email).trim())) errores.push('Email inválido');

  if (datos.limite_credito !== undefined && datos.limite_credito !== '') {
    const n = aNumero(datos.limite_credito);
    if (Number.isNaN(n)) errores.push('Límite de crédito no es un número válido');
  }
  if (datos.saldo_inicial !== undefined && datos.saldo_inicial !== '') {
    const n = aNumero(datos.saldo_inicial);
    if (Number.isNaN(n)) errores.push('Saldo inicial no es un número válido');
  }
  // condicion_iva, zona, lista_precios y vendedor son opcionales y se
  // resuelven/normalizan server-side (migración 154). No se bloquea la fila
  // si el texto no matchea nada conocido: zona/lista se crean por nombre,
  // condicion_iva cae a texto libre normalizado, y vendedor queda sin
  // asignar con una advertencia (no error) si no matchea ningún usuario.
  return errores;
}

function validarFilaProductos(datos) {
  const errores = [];
  if (!datos.nombre || !String(datos.nombre).trim()) errores.push('Falta nombre');
  if (!datos.codigo || !String(datos.codigo).trim()) errores.push('Falta código');

  if (datos.precio !== undefined && datos.precio !== '') {
    const n = aNumero(datos.precio);
    if (Number.isNaN(n) || n < 0) errores.push('Precio no es un número válido');
  }
  if (datos.stock !== undefined && datos.stock !== '') {
    const n = aNumero(datos.stock);
    if (Number.isNaN(n) || n < 0) errores.push('Stock no es un número válido');
  }
  if (datos.iva !== undefined && datos.iva !== '') {
    const n = aNumero(datos.iva);
    if (Number.isNaN(n) || n < 0 || n > 100) errores.push('IVA no es un porcentaje válido (0-100)');
  }
  // categoria, proveedor y unidad son texto libre: se resuelven/crean por
  // nombre server-side. codigo_barras es un flag laxo (si/sí/true/1/yes/x).
  return errores;
}

// Migración 159: validación de líneas de pedido. La existencia real de
// cliente/producto se chequea aparte en mapearSesionPedidos (ahí sí hace
// falta tocar otras tablas), esto solo valida forma/tipo de los datos crudos.
function validarFilaPedidos(datos) {
  const errores = [];
  if (!datos.numero_pedido || !String(datos.numero_pedido).trim()) errores.push('Falta número de pedido');

  const cuit = normalizarCuit(datos.cliente_cuit);
  if (!cuit) errores.push('Falta CUIT del cliente');
  else {
    const err = errorDeCuit(cuit, 'CUIT de cliente');
    if (err) errores.push(err);
  }

  if (!datos.producto_codigo || !String(datos.producto_codigo).trim()) errores.push('Falta código de producto');

  const cantidad = aNumero(datos.cantidad);
  if (datos.cantidad === undefined || datos.cantidad === '' || Number.isNaN(cantidad) || cantidad <= 0) {
    errores.push('Cantidad inválida (debe ser un número mayor a 0)');
  }

  if (datos.precio_unitario !== undefined && datos.precio_unitario !== '') {
    const n = aNumero(datos.precio_unitario);
    if (Number.isNaN(n) || n < 0) errores.push('Precio unitario no es un número válido');
  }
  return errores;
}

// ─── GET /api/migracion ───────────────────────────────────────────────────────
// ─── Punto 9 del plan de migraciones ──────────────────────────────────────────
// Dos features para reducir la fricción de migraciones del lado del cliente
// para usuarios no técnicos:
//  (a) plantilla de columnas descargable ANTES de subir ningún archivo, con
//      las columnas exactas que espera cada entidad (para armar el excel
//      propio a partir de eso en vez de ir a prueba y error);
//  (b) guardar el mapeo de columnas ya armado como plantilla reutilizable,
//      para no tener que rehacerlo a mano cada vez que se migra un archivo
//      con el mismo formato (ej. exportaciones periódicas del sistema viejo).

// GET /api/migracion?accion=campos&entidad=X — no requiere sesión creada,
// reusa la misma fuente de verdad (CAMPOS) que usa crearSesion/mapearSesion
// más adelante, así la plantilla nunca puede desincronizarse de lo que el
// backend realmente acepta.
async function obtenerCampos(req, res) {
  const entidad = req.query.entidad;

  // Migración maestra (un solo archivo, varias hojas → varias entidades):
  // sin `entidad` devuelve el registro completo de las 18 entidades, para
  // que el frontend pueda puntuar cada hoja contra todas sin duplicar acá
  // el registro CAMPOS a mano del lado del cliente (fuente única de verdad
  // — si mañana se agrega un campo nuevo a una entidad, el detector de la
  // migración maestra lo ve automáticamente sin tocar el frontend).
  if (!entidad) {
    const entidades = {};
    for (const [nombre, def] of Object.entries(CAMPOS)) {
      entidades[nombre] = { campos_disponibles: def.disponibles, campos_requeridos: def.requeridos };
    }
    return res.json({ entidades });
  }

  if (!CAMPOS[entidad]) return res.status(400).json({ error: 'Entidad inválida' });
  return res.json({
    campos_disponibles: CAMPOS[entidad].disponibles,
    campos_requeridos: CAMPOS[entidad].requeridos,
  });
}

// GET /api/migracion?accion=plantillas&entidad=X — lista las plantillas de
// mapeo guardadas por la empresa para esa entidad (o todas si no se pasa
// entidad), más recientes primero.
async function listarPlantillasMapeo(req, res, perfil) {
  const entidad = req.query.entidad;
  if (entidad && !CAMPOS[entidad]) return res.status(400).json({ error: 'Entidad inválida' });

  const { data, error } = await MigracionRepo.listarPlantillasMapeo(perfil.empresa_id, entidad);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ plantillas: data || [] });
}

// POST /api/migracion?accion=guardar_plantilla — guarda el mapeo de columnas
// actual (armado a mano en el paso 2) como plantilla reutilizable. Los
// campos de destino (depósito/lista de precios) son opcionales — solo
// aplican a productos, y si no se mandan quedan null.
async function guardarPlantillaMapeo(req, res, perfil) {
  const { entidad, nombre, mapeo_columnas, deposito_id, lista_precio_id } = req.body || {};

  if (!CAMPOS[entidad]) return res.status(400).json({ error: 'Entidad inválida' });
  const nombreLimpio = (nombre || '').toString().trim();
  if (!nombreLimpio) return res.status(400).json({ error: 'La plantilla necesita un nombre' });
  if (!mapeo_columnas || typeof mapeo_columnas !== 'object' || Array.isArray(mapeo_columnas) || !Object.keys(mapeo_columnas).length) {
    return res.status(400).json({ error: 'El mapeo de columnas está vacío' });
  }

  // Solo se guardan los campos que realmente existen para esa entidad —
  // evita que un mapeo viejo/corrupto arrastre claves inválidas.
  const mapeoFiltrado = {};
  for (const [campo, columna] of Object.entries(mapeo_columnas)) {
    if (CAMPOS[entidad].disponibles.includes(campo) && columna) mapeoFiltrado[campo] = columna;
  }
  if (!Object.keys(mapeoFiltrado).length) {
    return res.status(400).json({ error: 'El mapeo de columnas está vacío' });
  }

  const { data, error } = await MigracionRepo.crearPlantillaMapeo({
    empresa_id: perfil.empresa_id,
    creado_por: perfil.id,
    entidad,
    nombre: nombreLimpio,
    mapeo_columnas: mapeoFiltrado,
    deposito_id: deposito_id || null,
    lista_precio_id: lista_precio_id || null,
  });

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ plantilla: data });
}

// DELETE /api/migracion?accion=plantilla&plantilla_id=X — el filtro doble
// (id + empresa_id) hace de chequeo de pertenencia sin necesidad de un
// select previo: si la plantilla es de otra empresa, el delete no borra
// nada y count queda en 0.
async function borrarPlantillaMapeo(req, res, perfil) {
  const plantillaId = req.query.plantilla_id;
  if (!plantillaId) return res.status(400).json({ error: 'Falta plantilla_id' });

  const { error, count } = await MigracionRepo.borrarPlantillaMapeo(plantillaId, perfil.empresa_id);

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  if (!count) return res.status(404).json({ error: 'Plantilla no encontrada' });
  return res.json({ ok: true });
}

// Reusable: mismo query que usa el wizard admin y (via lib/asistente-tools.js)
// la tool consultar_historial_migraciones del asistente.
export async function listarSesionesMigracion({ empresa_id, page = 1, limit = 20 }) {
  const pagina = Math.max(1, Number.parseInt(page, 10) || 1);
  const porPagina = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
  const offset = (pagina - 1) * porPagina;
  const { data, error, count } = await MigracionRepo.listarSesionesPorEmpresa(empresa_id, {
    offset,
    limit: porPagina,
  });

  if (error) {
    console.error('[MIGRACION] Error listando sesiones:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }
  const total = Number.isFinite(count) ? count : (data || []).length;
  return {
    ok: true,
    sesiones: data || [],
    paginacion: {
      pagina,
      por_pagina: porPagina,
      total,
      total_paginas: Math.max(1, Math.ceil(total / porPagina)),
      tiene_anterior: pagina > 1,
      tiene_siguiente: offset + (data || []).length < total,
    },
  };
}

async function listarSesiones(req, res, perfil) {
  const resultado = await listarSesionesMigracion({
    empresa_id: perfil.empresa_id,
    page: req.query.page,
    limit: req.query.limit,
  });
  if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
  return res.json({ sesiones: resultado.sesiones, paginacion: resultado.paginacion });
}

// ─── GET /api/migracion?sesion_id=X ───────────────────────────────────────────
// `offset` + `limit` permiten paginar (el frontend los usa para "Descargar
// errores": la tabla de revisión solo muestra un preview acotado, pero el
// archivo a descargar tiene que traer TODAS las filas con error, que en un
// archivo de 50.000 filas pueden ser muchas más que el límite de preview).
// `solo_errores=true` filtra es_valida=false, para no traer de más.
async function obtenerSesion(req, res, perfil) {
  const sesionId = req.query.sesion_id;
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const soloErrores = req.query.solo_errores === 'true';

  const sesion = await cargarSesionPropia(sesionId, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  const { data: filas, error } = await MigracionRepo.obtenerFilasSesion(sesionId, { soloErrores, offset, limit });

  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
  return res.json({ sesion, filas: filas || [] });
}

// ─── GET /api/migracion?accion=origen&entidad=X&id=Y ──────────────────────────
// Punto 2 del machete: dado un registro final (cliente, producto, proveedor,
// etc.), determina si vino de una migración y de cuál sesión, sin requerir
// ninguna columna nueva en las tablas de cada entidad — se apoya en
// `migracion_staging_rows.entidad_resultado_id`, que ya guarda ese vínculo
// desde que la fila se confirma (ver 152_migracion_bulk_idempotente.sql).
async function obtenerOrigenMigracion(req, res, perfil) {
  const entidad = req.query.entidad;
  const id = req.query.id;
  if (!entidad || !id) return res.status(400).json({ error: 'Faltan parámetros entidad/id' });

  const { data: filas, error: errFilas } = await MigracionRepo.obtenerFilasPorEntidadResultado(id);
  if (errFilas) return errorSeguro(res, errFilas, 500, 'No se pudo completar la operación.');
  if (!filas || !filas.length) return res.json({ migrado: false });

  const sesionIds = [...new Set(filas.map(f => f.sesion_id))];
  const { data: sesiones, error: errSes } = await MigracionRepo.obtenerSesionOrigenEntreIds(sesionIds, entidad, perfil.empresa_id);
  if (errSes) return errorSeguro(res, errSes, 500, 'No se pudo completar la operación.');
  if (!sesiones || !sesiones.length) return res.json({ migrado: false });

  const s = sesiones[0];
  const response = {
    migrado: true,
    sesion_id: s.id,
    nombre_archivo_original: s.nombre_archivo_original,
    fecha: s.created_at,
  };

  // Punto 2 del CHANGELOG v194: columnas del archivo original que no se
  // mapearon a ningún campo del sistema — antes se descartaban en silencio.
  const filaDeEstaSesion = filas.find(f => f.sesion_id === s.id);
  if (filaDeEstaSesion?.datos_originales) {
    const colUsadas = new Set(Object.values(s.mapeo_columnas || {}));
    const extras = {};
    for (const [col, val] of Object.entries(filaDeEstaSesion.datos_originales)) {
      if (!colUsadas.has(col) && val !== '' && val != null) {
        extras[col] = val;
      }
    }
    if (Object.keys(extras).length > 0) {
      response.datos_extras = extras;
    }
  }

  return res.json(response);
}

async function cargarSesionPropia(sesionId, empresaId) {
  if (!sesionId) return null;
  const data = await MigracionRepo.obtenerSesionPorId(sesionId);
  if (!data || data.empresa_id !== empresaId) return null;
  return data;
}

// Reusable, para lib/asistente-tools.js — a diferencia de obtenerSesion()
// (que pagina hasta 2000 filas de staging para la tabla de revisión del
// wizard), esto devuelve solo el resumen de la sesión: no tiene sentido
// volcar cientos de filas crudas a un chat. Si no se pasa sesion_id, toma
// la más reciente de la empresa (comportamiento pensado para "cómo va la
// migración" sin que el usuario tenga que buscar el id).
export async function obtenerEstadoSesionMigracion({ empresa_id, sesion_id }) {
  let sesion;
  if (sesion_id) {
    sesion = await cargarSesionPropia(sesion_id, empresa_id);
    if (!sesion) return { ok: false, status: 404, error: 'Sesión no encontrada' };
  } else {
    const { data, error } = await MigracionRepo.obtenerUltimaSesion(empresa_id);
    if (error) {
      console.error('[MIGRACION] Error obteniendo última sesión:', error);
      return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
    }
    if (!data) return { ok: false, status: 404, error: 'Todavía no se corrió ninguna migración.' };
    sesion = data;
  }

  return {
    ok: true,
    sesion: {
      id: sesion.id,
      entidad: sesion.entidad,
      nombre_archivo_original: sesion.nombre_archivo_original,
      estado: sesion.estado,
      total_filas: sesion.total_filas,
      filas_validas: sesion.filas_validas,
      filas_con_error: sesion.filas_con_error,
      resumen_errores: sesion.resumen_errores,
      resumen_advertencias: sesion.resumen_advertencias,
      created_at: sesion.created_at,
      actualizado_at: sesion.actualizado_at,
    },
  };
}

// Cierre del gap "alertas de sesión en error": antes, cuando una sesión de
// migración pasaba a estado 'error' (falla al subir filas, al confirmar o
// al deshacer), quien no tuviera la pestaña del wizard abierta no se
// enteraba hasta volver a entrar. Centraliza el UPDATE + notifAuto (mismo
// patrón que auditoria.js/stock.js) para no repetir el boilerplate en los
// 4 call-sites. Fire-and-forget: si el push falla no debe tumbar la
// respuesta HTTP de por sí ya está yendo a devolver un 500 al frontend.
async function marcarSesionError(sesionId, empresaId, mensajeError, extra = {}) {
  await MigracionRepo.actualizarSesion(sesionId, { estado: 'error', ...extra });

  notifAuto(empresaId, {
    tipo: 'migracion_sesion_error',
    titulo: '⚠ Falló una migración',
    cuerpo: mensajeError ? `Una sesión de migración quedó en error: ${mensajeError}` : 'Una sesión de migración quedó en error.',
    link: '/admin/migracion.html',
  }).catch(() => {});
}

// ─── POST ?accion=crear ───────────────────────────────────────────────────────
// Migración 167 (plan P0, item 3): resumible por lotes. El frontend parsea el
// archivo entero client-side pero lo sube en chunks (CHUNK_SUBIDA filas por
// request); cada request HTTP inserta UN chunk y devuelve hay_mas mientras
// falten filas. Esto evita meter, en una sola invocación serverless, un loop
// de hasta 50 inserts (50.000 filas / 1000 por lote) que podía superar el
// timeout de la función — y si lo superaba, dejaba la sesión en un estado
// ambiguo (¿cuántas filas quedaron insertadas realmente?).
//
// Primer request (sin sesion_id): crea la sesión, corre el chequeo de
// duplicado (item 1) contra total_filas (la cantidad total declarada por el
// frontend, no el tamaño del primer chunk) e inserta el primer chunk.
// Requests siguientes (con sesion_id): insertan el próximo chunk nomás.
// Compatibilidad: si no viene total_filas (llamador viejo/simple), se asume
// que "filas" trae el archivo completo en un solo request, igual que antes.
async function crearSesion(req, res, perfil) {
  const { entidad, nombre_archivo, filas, forzar, sesion_id, offset, hash_contenido } = req.body || {};
  const totalFilas = Number.isFinite(req.body?.total_filas) ? req.body.total_filas : (Array.isArray(filas) ? filas.length : 0);
  const offsetActual = Number.isFinite(offset) ? offset : 0;

  if (!Array.isArray(filas) || filas.length === 0) return res.status(400).json({ error: 'El archivo no tiene filas de datos' });
  if (totalFilas > MAX_FILAS) return res.status(400).json({ error: `Máximo ${MAX_FILAS.toLocaleString('es-AR')} filas por archivo` });

  // ─── Continuación de una subida ya iniciada ───────────────────────────────
  if (sesion_id) {
    const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
    if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });
    if (sesion.estado !== 'subido') return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}" y ya no acepta más filas` });

    const errInsert = await insertarLoteStaging(sesion.id, filas, offsetActual);
    if (errInsert) {
      await marcarSesionError(sesion.id, perfil.empresa_id, errInsert);
      return res.status(500).json({ error: 'Error guardando filas: ' + errInsert });
    }

    const filasSubidas = await MigracionRepo.contarFilasStaging(sesion.id);

    const hayMas = filasSubidas < sesion.total_filas;
    const respuesta = { sesion_id: sesion.id, filas_subidas: filasSubidas || 0, hay_mas: hayMas };
    if (!hayMas) Object.assign(respuesta, await respuestaFinalCrearSesion(sesion, perfil));
    return res.json(respuesta);
  }

  // ─── Primer request: crea la sesión ───────────────────────────────────────
  if (!CAMPOS[entidad]) return res.status(400).json({ error: 'Entidad inválida (debe ser "clientes", "productos", "pedidos", "cta_cte", "precios_clientes", "proveedores", "ordenes_compra", "pagos_proveedores", "lotes", "categorias", "depositos", "listas_precios" o "zonas")' });

  const columnasDetectadas = Object.keys(filas[0] || {});
  if (!columnasDetectadas.length) return res.status(400).json({ error: 'No se pudieron detectar columnas en el archivo' });

  // Item 1 del plan P0: protección contra subir el mismo archivo dos veces.
  // El riesgo real es cta_cte (duplicar saldos), pero se chequea para todas
  // las entidades por consistencia. Contra sesiones de los últimos 90 días en
  // estados donde ya se procesó, se está por procesar, o pudo haber quedado a
  // mitad de camino algo real — 'subido' queda afuera porque todavía no tocó
  // ninguna tabla real y re-subir el mismo archivo en ese estado no tiene
  // ningún riesgo. 'error' SÍ se incluye a propósito: confirmarSesion procesa
  // en lotes resumibles, así que una sesión puede quedar en 'error' con datos
  // reales ya confirmados de lotes anteriores al que falló (ej. un timeout de
  // red a mitad de la importación) — si en ese estado el usuario sube el
  // mismo archivo de nuevo en vez de "reintentar", sin este chequeo
  // duplicaría lo que ya se había creado. 'cancelado', 'deshaciendo' y
  // 'deshecho' quedan afuera: la primera nunca llegó a tocar datos reales, y
  // las otras dos ya están revirtiendo o revirtieron lo que habían creado,
  // así que no hay riesgo de doble conteo.
  //
  // Punto 8 del audit: cuando el frontend manda hash_contenido (SHA-256 del
  // archivo, calculado client-side), se prioriza esa huella por sobre
  // nombre+total_filas — dos archivos con nombres distintos pero contenido
  // idéntico (ej. "clientes.csv" vs "clientes (1).csv") ahora se detectan
  // como duplicados, y un archivo renombrado deja de dar falsos negativos.
  // Si no viene hash_contenido (llamador viejo), cae al chequeo anterior por
  // compatibilidad.
  // No bloquea: si forzar=true en el body, se ignora el chequeo (el frontend
  // lo manda después de que el usuario confirma explícitamente en un diálogo).
  if (!forzar && (hash_contenido || nombre_archivo)) {
    const previas = await MigracionRepo.buscarSesionesDuplicadas(perfil.empresa_id, entidad, {
      hash_contenido,
      nombre_archivo,
      total_filas: totalFilas,
    });

    if (previas && previas.length > 0) {
      return res.status(409).json({
        error: `Ya se subió un archivo "${nombre_archivo || ''}" con ${totalFilas} filas para ${entidad}. Confirmá si querés subirlo de nuevo igual.`,
        duplicado: true,
        sesiones_previas: previas,
      });
    }
  }

  const { data: sesion, error: errSesion } = await MigracionRepo.crearSesion({
    empresa_id: perfil.empresa_id,
    creado_por: perfil.id,
    entidad,
    nombre_archivo_original: nombre_archivo || null,
    hash_contenido: hash_contenido || null,
    estado: 'subido',
    columnas_detectadas: columnasDetectadas,
    total_filas: totalFilas,
  });

  if (errSesion) return errorSeguro(res, errSesion, 500, 'No se pudo completar la operación.');

  const errInsert = await insertarLoteStaging(sesion.id, filas, offsetActual);
  if (errInsert) {
    await marcarSesionError(sesion.id, perfil.empresa_id, errInsert);
    return res.status(500).json({ error: 'Error guardando filas: ' + errInsert });
  }

  const hayMas = filas.length < totalFilas;
  const respuesta = { sesion_id: sesion.id, filas_subidas: filas.length, hay_mas: hayMas };
  if (!hayMas) Object.assign(respuesta, await respuestaFinalCrearSesion(sesion, perfil));
  return res.json(respuesta);
}

// Inserta un chunk de filas en staging, en sub-lotes de LOTE_INSERT para no
// exceder límites de tamaño de request a Postgres. Devuelve el mensaje de
// error si algo falló, o null si salió todo bien.
async function insertarLoteStaging(sesionId, filas, offsetBase) {
  for (let i = 0; i < filas.length; i += LOTE_INSERT) {
    const lote = filas.slice(i, i + LOTE_INSERT).map((fila, idx) => ({
      sesion_id: sesionId,
      fila_numero: offsetBase + i + idx + 1,
      datos_originales: fila,
    }));
    const error = await MigracionRepo.insertarFilasStaging(lote);
    if (error) return error.message;
  }
  return null;
}

// Se arma una sola vez, cuando termina de subirse la última fila (hay_mas
// pasa a false) — antes se armaba siempre porque todo pasaba en un request.
async function respuestaFinalCrearSesion(sesion, perfil) {
  const respuesta = {
    columnas_detectadas: sesion.columnas_detectadas,
    campos_disponibles: CAMPOS[sesion.entidad].disponibles,
    campos_requeridos: CAMPOS[sesion.entidad].requeridos,
  };

  // Migración 156: para productos, ofrecer elegir depósito y lista de
  // precios destino en vez de asumir siempre el principal/default.
  // Migración 172: lotes también necesita elegir depósito destino (mismo
  // criterio de fallback que productos), pero no tiene lista de precios.
  if (sesion.entidad === 'productos' || sesion.entidad === 'lotes') {
    respuesta.depositos = await listarDepositosParaSelector(perfil.empresa_id);

    if (sesion.entidad === 'productos') {
      respuesta.listas_precios = await listarListasPrecioParaSelector(perfil.empresa_id);
    }
  }

  return respuesta;
}

// ─── Mapeo resumible por lotes (migración 167, plan P0 item 3) ───────────────
// Mismo problema que crearSesion: mapearSesion procesaba TODAS las filas de
// la sesión en un solo request (loop interno de a 1000, 1 RPC por lote).
// Ahora cada request HTTP procesa UN lote (LOTE_MAPEO filas sin mapear) y
// devuelve hay_mas; el frontend reinvoca en loop, igual que ya hace con
// accion=confirmar. "Sin mapear" se rastrea con mapeado_en (columna nueva,
// migración 167), mismo patrón que procesado_en/deshecho_en.
const LOTE_MAPEO = LOTE_INSERT;

async function obtenerLoteSinMapear(sesionId, limit) {
  return MigracionRepo.obtenerLoteSinMapear(sesionId, limit);
}

// Reconstruye qué claves de dedupe (CUIT, código, o par cliente+producto,
// según `extractor`) ya aparecieron en filas de lotes ANTERIORES de esta
// misma sesión — necesario porque cada request HTTP ahora solo ve su propio
// lote y no puede acumular un Set en memoria entre requests como antes.
async function obtenerClavesYaMapeadas(sesionId, extractor) {
  const data = await MigracionRepo.obtenerDatosMapeadosDeSesion(sesionId);

  const claves = new Set();
  for (const fila of data || []) {
    const k = extractor(fila.datos_mapeados || {});
    if (k) claves.add(k);
  }
  return claves;
}

// Se llama una sola vez, cuando el último lote de mapeo termina (hay_mas
// pasa a false): recalcula el resumen agregado sobre TODA la sesión (no solo
// el último lote), igual criterio que ya usa confirmarSesion para sus totales.
async function recomputarResumenFinal(sesionId, { campoMonto = null } = {}) {
  const data = await MigracionRepo.obtenerFilasParaResumen(sesionId);

  const resumenAcum = crearResumenMapeo();
  let validas = 0, conError = 0, montoTotal = 0;
  for (const fila of data || []) {
    if (fila.es_valida) {
      validas++;
      if (campoMonto && typeof fila.datos_mapeados?.[campoMonto] === 'number') montoTotal += fila.datos_mapeados[campoMonto];
    } else {
      conError++;
    }
    registrarEnResumen(resumenAcum, fila.accion, fila.es_valida, Array.isArray(fila.errores) ? fila.errores : []);
  }

  const resumen = cerrarResumen(resumenAcum, validas, conError);
  if (campoMonto) resumen.monto_total_valido = Math.round(montoTotal * 100) / 100;
  return { validas, conError, resumen };
}

// Arranca o continúa una pasada de mapeo resumible. Si la sesión ya estaba
// 'validado' (se mapeó una vez y la persona volvió a llamar, típicamente
// porque cambió el mapeo de columnas), es un remapeo desde cero: se resetea
// mapeado_en de TODA la sesión para que obtenerLoteSinMapear vuelva a
// procesar todo. Si ya está 'mapeando' (llamada de continuación de una
// pasada en curso, mismo body reintentado por el frontend en loop), no se
// toca nada — evita resetear en cada llamada, lo que causaría un loop
// infinito de hay_mas=true. `extra` permite persistir campos propios de
// cada entidad (mapeo_columnas, deposito_id, lista_precio_id) al arrancar.
async function prepararPasadaDeMapeo(sesionId, sesion, extra = {}) {
  if (sesion.estado === 'validado') {
    const error = await MigracionRepo.resetearMapeoSesion(sesionId);
    if (error) throw new Error('Error reiniciando mapeo: ' + error.message);
  }
  if (sesion.estado !== 'mapeando') {
    await MigracionRepo.actualizarSesion(sesionId, { estado: 'mapeando', ...extra });
  }
}

// Cierra la respuesta de un lote de mapeo: si todavía quedan filas
// (hay_mas), devuelve solo el progreso del lote; si este era el último
// (lote.length < LOTE_MAPEO, mismo criterio que usan las RPC de confirmar:
// v_procesadas >= p_lote_size), recalcula el resumen agregado sobre TODA la
// sesión y cierra el estado en 'validado'.
async function finalizarLoteDeMapeo(res, sesionId, lote, opcionesResumen = {}) {
  const hayMas = lote.length >= LOTE_MAPEO;
  if (hayMas) return res.json({ hay_mas: true, filas_mapeadas_lote: lote.length });

  const { validas, conError, resumen } = await recomputarResumenFinal(sesionId, opcionesResumen);
  await MigracionRepo.actualizarSesion(sesionId, {
    estado: 'validado',
    filas_validas: validas,
    filas_con_error: conError,
    resumen_mapeo: resumen,
    actualizado_at: new Date().toISOString(),
  });

  // El frontend (cargarFilasRevision) necesita total_filas para el resumen;
  // en este punto TODAS las filas de la sesión ya están procesadas (o
  // válidas o con error), así que se puede calcular sin otra query.
  return res.json({ hay_mas: false, total_filas: validas + conError, filas_validas: validas, filas_con_error: conError, resumen_mapeo: resumen });
}

// ─── POST ?accion=mapear ──────────────────────────────────────────────────────
async function mapearSesion(req, res, perfil) {
  const { sesion_id, mapeo_columnas, deposito_id, lista_precio_id } = req.body || {};

  const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  // Migración 167: si la subida (accion=crear) todavía se está subiendo en
  // chunks, no dejamos mapear — mapearía un subconjunto parcial de filas sin
  // que la persona se entere. Estados válidos para (re)mapear: 'subido'
  // (primera vez), 'mapeando' (pasada resumible en curso, el frontend
  // reintenta con el mismo body mientras hay_mas=true) y 'validado' (ya se
  // mapeó antes; volver a llamar es un remapeo, p.ej. la persona cambió el
  // mapeo de columnas — ver prepararPasadaDeMapeo).
  if (!['subido', 'mapeando', 'validado'].includes(sesion.estado)) {
    return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}" y no se puede mapear` });
  }
  const filasSubidas = await MigracionRepo.contarFilasStaging(sesion_id);
  if (filasSubidas < sesion.total_filas) {
    return res.status(400).json({ error: 'La subida del archivo todavía no terminó. Esperá a que termine de subir antes de mapear.' });
  }

  // Migración 159: pedidos tiene un flujo de mapeo distinto (agrupa filas
  // por numero_pedido y resuelve cliente/producto contra tablas reales en
  // vez del dedupe genérico de clientes/productos), así que se delega.
  if (sesion.entidad === 'pedidos') return await mapearSesionPedidos(req, res, perfil, sesion);
  // Migración 160: cta_cte también tiene flujo dedicado, mismo motivo que
  // pedidos (resuelve cliente contra tabla real en vez del dedupe genérico),
  // más resolución de tipo/monto/fecha que solo tiene sentido para esta entidad.
  if (sesion.entidad === 'cta_cte') return await mapearSesionCtaCte(req, res, perfil, sesion);
  // Migración 162: precios_clientes también resuelve contra tablas reales
  // (cliente por CUIT y producto por código, como pedidos), así que se delega.
  if (sesion.entidad === 'precios_clientes') return await mapearSesionPreciosClientes(req, res, perfil, sesion);
  // Migración 164: proveedores tiene dedupe dual (CUIT si está, si no
  // razón social/nombre de fantasía) que el dedupe genérico de 1 sola
  // clave (clientes/productos) no soporta, así que se delega también.
  if (sesion.entidad === 'proveedores') return await mapearSesionProveedores(req, res, perfil, sesion);
  // Punto 5 del plan (P1): órdenes de compra (agrupa por numero_orden+proveedor,
  // resuelve proveedor por CUIT/razón social y producto por código) y pagos a
  // proveedores (flujo plano, resuelve solo proveedor) tienen flujo dedicado
  // por el mismo motivo que pedidos/cta_cte: resuelven contra tablas reales.
  if (sesion.entidad === 'ordenes_compra') return await mapearSesionOrdenesCompra(req, res, perfil, sesion);
  if (sesion.entidad === 'pagos_proveedores') return await mapearSesionPagosProveedores(req, res, perfil, sesion);
  // Migración 172: lotes también resuelve producto contra la tabla real
  // (por código, como precios_clientes) y acepta un depósito destino de
  // sesión (como productos), así que se delega igual que las demás.
  if (sesion.entidad === 'lotes') return await mapearSesionLotes(req, res, perfil, sesion);
  // Migración 174 (plan P2, puntos 10-14): cheques/puntos/ventas_pos también
  // resuelven contra tablas reales (cliente por CUIT, producto por código),
  // mismo motivo de delegación que pedidos/cta_cte/lotes.
  if (sesion.entidad === 'cheques') return await mapearSesionCheques(req, res, perfil, sesion);
  if (sesion.entidad === 'puntos_fidelizacion') return await mapearSesionPuntos(req, res, perfil, sesion);
  if (sesion.entidad === 'ventas_pos') return await mapearSesionVentasPos(req, res, perfil, sesion);
  if (sesion.entidad === 'comprobantes_historicos') return await mapearSesionComprobantesHistoricos(req, res, perfil, sesion);
  if (sesion.entidad === 'direcciones') return await mapearSesionDirecciones(req, res, perfil, sesion);
  if (['categorias', 'depositos', 'listas_precios', 'zonas'].includes(sesion.entidad)) {
    return await mapearSesionMaestro(req, res, perfil, sesion);
  }

  const config = CAMPOS[sesion.entidad];
  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  // Migración 156: depósito/lista destino son elegibles solo para productos.
  // Si no vienen, queda NULL y confirmarSesion cae al principal/default
  // (mismo comportamiento que antes de esta migración).
  let depositoId = null, listaPrecioId = null;
  if (sesion.entidad === 'productos') {
    if (deposito_id) {
      const dep = await obtenerDepositoPorId(perfil.empresa_id, deposito_id);
      if (!dep) return res.status(400).json({ error: 'Depósito inválido' });
      depositoId = dep.id;
    }
    if (lista_precio_id) {
      const lst = await obtenerListaPrecioPorId(perfil.empresa_id, lista_precio_id);
      if (!lst) return res.status(400).json({ error: 'Lista de precios inválida' });
      listaPrecioId = lst.id;
    }
  }

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas, deposito_id: depositoId, lista_precio_id: listaPrecioId });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  // Migración 167: un lote acotado por request (mapeado_en IS NULL), no
  // todas las filas de la sesión de una — eso era lo que causaba timeout
  // con archivos grandes en serverless.
  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  // Traer existentes de la empresa para dedupe (clave: cuit o codigo). Este
  // branch genérico solo se alcanza para 'clientes' o 'productos' (todas
  // las demás entidades ya delegaron a su mapearSesionX arriba), así que se
  // resuelve con los repos existentes en vez de un .from() dinámico.
  const claveDedupe = config.claveDedupe;
  const colClave = claveDedupe === 'cuit' ? 'cuit' : 'codigo';
  const existentes = claveDedupe === 'cuit'
    ? await listarCuitClientesPorEmpresa(perfil.empresa_id)
    : await listarCodigosProductosPorEmpresa(perfil.empresa_id);

  const mapaExistentes = new Map();
  for (const ex of existentes || []) {
    const k = claveDedupe === 'cuit' ? normalizarCuit(ex[colClave]) : (ex[colClave] || '').toString().trim().toLowerCase();
    if (k) mapaExistentes.set(k, ex.id);
  }

  const extractorClave = (dm) => {
    const raw = dm?.[claveDedupe];
    return claveDedupe === 'cuit' ? normalizarCuit(raw) : (raw || '').toString().trim().toLowerCase();
  };
  // Reconstruye qué claves ya aparecieron en lotes ANTERIORES de esta misma
  // pasada (este request solo ve su propio lote).
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (!colOrigen) continue;
      if (colOrigen === SENTINEL_AUTOGENERAR && CAMPOS_AUTOGENERABLES[sesion.entidad]?.has(campo)) {
        datosMapeados[campo] = generarValorAuto(campo, sesion_id, fila.fila_numero);
      } else {
        datosMapeados[campo] = fila.datos_originales[colOrigen];
      }
    }

    const errores = sesion.entidad === 'clientes'
      ? validarFilaClientes(datosMapeados)
      : validarFilaProductos(datosMapeados);

    normalizarCamposNumericos(datosMapeados, sesion.entidad === 'clientes'
      ? ['limite_credito', 'saldo_inicial']
      : ['precio', 'stock', 'iva']);

    const clave = extractorClave(datosMapeados);

    let entidadExistenteId = null;
    let accion = 'crear';

    if (clave) {
      if (clavesVistas.has(clave)) {
        errores.push(`${claveDedupe === 'cuit' ? 'CUIT' : 'Código'} duplicado dentro del archivo`);
      }
      clavesVistas.add(clave);

      if (mapaExistentes.has(clave)) {
        entidadExistenteId = mapaExistentes.get(clave);
        accion = 'actualizar';
      }
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion,
      entidad_existente_id: entidadExistenteId,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', {
      p_sesion_id: sesion_id,
      p_filas: updates,
    });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para pedidos (migración 159) ──────────────────────────────
// Cliente y producto deben existir ya en la empresa: se resuelven por
// CUIT/código y se guardan resueltos (cliente_id_resuelto/producto_id_resuelto)
// en datos_mapeados, así migracion_confirmar_pedidos_lote no vuelve a tocar
// otras tablas para resolverlos — solo agrupa y crea.
async function mapearSesionPedidos(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.pedidos;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const productosEmpresa = await listarCodigosProductosPorEmpresa(perfil.empresa_id);

  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }
  const productosPorCodigo = new Map();
  for (const p of productosEmpresa || []) {
    const k = (p.codigo || '').toString().trim().toLowerCase();
    if (k) productosPorCodigo.set(k, p.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaPedidos(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['cantidad', 'precio_unitario']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);

    const codigo = (datosMapeados.producto_codigo || '').toString().trim().toLowerCase();
    const productoId = codigo ? productosPorCodigo.get(codigo) : null;
    if (codigo && !productoId) errores.push(`Producto con código "${datosMapeados.producto_codigo}" no encontrado. Migrá los productos primero.`);

    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;
    if (productoId) datosMapeados.producto_id_resuelto = productoId;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para precios_clientes (migración 162) ─────────────────────
// Mismo patrón que pedidos: cliente y producto deben existir ya, se resuelven
// por CUIT/código y se guardan resueltos en datos_mapeados para que
// migracion_confirmar_precios_cliente_lote no tenga que parsear nada.
async function mapearSesionPreciosClientes(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.precios_clientes;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const productosEmpresa = await listarCodigosProductosPorEmpresa(perfil.empresa_id);

  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }
  const productosPorCodigo = new Map();
  for (const p of productosEmpresa || []) {
    const k = (p.codigo || '').toString().trim().toLowerCase();
    if (k) productosPorCodigo.set(k, p.id);
  }

  // Migración 165 (gap de QA pre-venta): antes no había dedupe intra-archivo
  // acá (sí lo tienen clientes/productos/proveedores). La DB lo resolvía sola
  // vía upsert (cliente_id, producto_id) — no se rompía nada — pero el
  // usuario nunca se enteraba de que dos filas pisaban el mismo precio. Se
  // avisa igual que en las demás entidades, consistente con el patrón. La
  // clave es el par cliente+producto YA RESUELTO, así que el extractor lee
  // los campos *_resuelto que esta misma función escribe en datos_mapeados.
  const extractorClave = (dm) => (dm?.cliente_id_resuelto && dm?.producto_id_resuelto)
    ? `${dm.cliente_id_resuelto}|${dm.producto_id_resuelto}`
    : null;
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaPreciosClientes(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['precio']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);

    const codigo = (datosMapeados.producto_codigo || '').toString().trim().toLowerCase();
    const productoId = codigo ? productosPorCodigo.get(codigo) : null;
    if (codigo && !productoId) errores.push(`Producto con código "${datosMapeados.producto_codigo}" no encontrado. Migrá los productos primero.`);

    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;
    if (productoId) datosMapeados.producto_id_resuelto = productoId;

    const claveEfectiva = extractorClave(datosMapeados);
    if (claveEfectiva) {
      if (clavesVistas.has(claveEfectiva)) {
        errores.push('Cliente + producto repetido dentro del archivo (mismo par ya migrado en otra fila)');
      }
      clavesVistas.add(claveEfectiva);
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para proveedores (migración 164) ──────────────────────────
// Dedupe dual: CUIT si la fila lo trae, si no por razón social/nombre de
// fantasía (mismo criterio que migracion_resolver_proveedor, que es lo que
// autocrea proveedores hoy como efecto colateral de migrar productos). Así
// una fila completa con CUIT real "completa" el stub existente en vez de
// duplicarlo — ese es justo el problema que esta entidad viene a resolver.
async function mapearSesionProveedores(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.proveedores;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const proveedoresEmpresa = await listarProveedoresParaDedupePorEmpresa(perfil.empresa_id);

  const porCuit = new Map();
  const porNombre = new Map();
  for (const p of proveedoresEmpresa || []) {
    const k = normalizarCuit(p.cuit);
    if (k) porCuit.set(k, p.id);
    const rs = (p.razon_social || '').toString().trim().toLowerCase();
    if (rs) porNombre.set(rs, p.id);
    const nf = (p.nombre_fantasia || '').toString().trim().toLowerCase();
    if (nf) porNombre.set(nf, p.id);
  }

  // Dedupe dual (CUIT si está, si no nombre): la clave "efectiva" se define
  // igual que dentro del map de abajo, por eso se repite acá el mismo
  // criterio de prioridad para reconstruir lo visto en lotes anteriores.
  const extractorClave = (dm) => {
    const cuit = normalizarCuit(dm?.cuit);
    const nombreNorm = (dm?.razon_social || '').toString().trim().toLowerCase();
    return cuit || nombreNorm || null;
  };
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaProveedores(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['dias_pago']);

    const cuit = normalizarCuit(datosMapeados.cuit);
    const nombreNorm = (datosMapeados.razon_social || '').toString().trim().toLowerCase();
    const claveEfectiva = cuit || nombreNorm; // prioridad: CUIT si está, si no nombre

    if (claveEfectiva) {
      if (clavesVistas.has(claveEfectiva)) {
        errores.push('Proveedor duplicado dentro del archivo (mismo CUIT o razón social)');
      }
      clavesVistas.add(claveEfectiva);
    }

    let entidadExistenteId = null;
    let accion = 'crear';
    if (cuit && porCuit.has(cuit)) {
      entidadExistenteId = porCuit.get(cuit);
      accion = 'actualizar';
    } else if (nombreNorm && porNombre.has(nombreNorm)) {
      entidadExistenteId = porNombre.get(nombreNorm);
      accion = 'actualizar';
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion,
      entidad_existente_id: entidadExistenteId,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo genérico para las 4 entidades "maestro" (migración 173, punto 7) ──
// categorias/depositos/listas_precios/zonas comparten el mismo patrón simple:
// 1 fila = 1 registro, dedupe único por nombre normalizado (sin CUIT ni otra
// clave secundaria como proveedores), y se autocrean si no existen — mismo
// criterio que los resolvers migracion_resolver_categoria/deposito/etc. que
// ya usan clientes/productos, pero ahora con TODOS los atributos de la fila,
// no solo el nombre.
async function mapearSesionMaestro(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS[sesion.entidad];
  const tabla = sesion.entidad; // 'categorias' | 'depositos' | 'listas_precios' | 'zonas'

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  // Genuinamente dinámico entre 4 tablas (categorias/depositos/listas_precios/
  // zonas) con el mismo shape (id, nombre) — categorias y zonas todavía no
  // tienen repo propio, así que no hay a dónde delegar esto sin perder la
  // genericidad del branch. Queda como acceso directo a propósito.
  const { data: existentes } = await sb
    .from(tabla)
    .select('id, nombre')
    .eq('empresa_id', perfil.empresa_id);

  const porNombre = new Map();
  for (const e of existentes || []) {
    const n = (e.nombre || '').toString().trim().toLowerCase();
    if (n) porNombre.set(n, e.id);
  }

  const extractorClave = (dm) => (dm?.nombre || '').toString().trim().toLowerCase() || null;
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaMaestro(datosMapeados);

    const nombreNorm = (datosMapeados.nombre || '').toString().trim().toLowerCase();
    if (nombreNorm) {
      if (clavesVistas.has(nombreNorm)) {
        errores.push('Nombre duplicado dentro del archivo');
      }
      clavesVistas.add(nombreNorm);
    }

    let entidadExistenteId = null;
    let accion = 'crear';
    if (nombreNorm && porNombre.has(nombreNorm)) {
      entidadExistenteId = porNombre.get(nombreNorm);
      accion = 'actualizar';
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion,
      entidad_existente_id: entidadExistenteId,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para cta_cte (migración 160) ──────────────────────────────
// Igual que pedidos: cliente debe existir ya, se resuelve por CUIT y se
// guarda resuelto en datos_mapeados (cliente_id_resuelto). A diferencia de
// pedidos, acá además se resuelven tipo/monto (3 formatos posibles, ver
// resolverMovimientoCtaCte) y la fecha (aFechaISO) en este paso, dejando
// todo listo en datos_mapeados como tipo_resuelto/monto_resuelto/fecha_iso
// para que migracion_confirmar_cta_cte_lote no tenga que parsear nada.
async function mapearSesionCtaCte(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.cta_cte;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaCtaCte(datosMapeados);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const fechaIso = aFechaISO(datosMapeados.fecha);
    if (fechaIso) datosMapeados.fecha_iso = fechaIso;

    // Solo intentar resolver tipo/monto si la fila ya viene bien formada;
    // si no, validarFilaCtaCte ya cargó el error correspondiente y acá
    // alcanzaría con repetir el cálculo (resolverMovimientoCtaCte es puro
    // y no tiene side effects, así que no hay drama en llamarlo de nuevo).
    const resuelto = resolverMovimientoCtaCte(datosMapeados);
    if (!resuelto.error) {
      datosMapeados.tipo_resuelto = resuelto.tipo;
      datosMapeados.monto_resuelto = resuelto.monto;
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  // Además del resumen genérico (por_accion/top_errores), cta_cte es la
  // única entidad de la migración donde el monto agregado importa: es el
  // dato que más ayuda a detectar "subí el archivo mal" ANTES de confirmar
  // (ej. una columna corrida que infla el total 100x). recomputarResumenFinal
  // ya soporta acumularlo vía campoMonto (agrega sobre TODA la sesión, no
  // solo el último lote).
  return await finalizarLoteDeMapeo(res, sesion_id, lote, { campoMonto: 'monto_resuelto' });
}

// ─── Mapeo dedicado para ordenes_compra (punto 5 del plan, P1) ────────────────
// Patrón agrupado como pedidos, pero agrupa por numero_orden + proveedor (la
// confirmación en SQL agrupa por esos dos campos, ver migracion_confirmar_
// ordenes_compra_lote). El proveedor se resuelve por CUIT o razón social
// (dedupe dual, igual criterio que mapearSesionProveedores) y DEBE existir
// ya — a diferencia de la entidad proveedores, acá nunca se autocrea nada;
// si no matchea contra ninguna de las dos claves, es error de validación.
// El producto se resuelve por código igual que en pedidos (SOLO_MATCH).
// Estado/fechas se resuelven acá y quedan en datos_mapeados (estado_resuelto,
// fecha_pedido_iso, fecha_recepcion_iso) para que el RPC de confirmación no
// tenga que parsear texto.
async function mapearSesionOrdenesCompra(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.ordenes_compra;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });
  // proveedor_cuit/proveedor_razon_social son un OR, no pueden ir en
  // "requeridos" (eso los exigiría a los dos), así que se valida acá aparte.
  if (!mapeo_columnas?.proveedor_cuit && !mapeo_columnas?.proveedor_razon_social) {
    return res.status(400).json({ error: 'Falta mapear: proveedor_cuit o proveedor_razon_social (al menos uno de los dos)' });
  }

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const proveedoresEmpresa = await listarProveedoresParaDedupePorEmpresa(perfil.empresa_id);
  const productosEmpresa = await listarCodigosProductosPorEmpresa(perfil.empresa_id);

  const proveedoresPorCuit = new Map();
  const proveedoresPorNombre = new Map();
  for (const p of proveedoresEmpresa || []) {
    const k = normalizarCuit(p.cuit);
    if (k) proveedoresPorCuit.set(k, p.id);
    const rs = (p.razon_social || '').toString().trim().toLowerCase();
    if (rs) proveedoresPorNombre.set(rs, p.id);
    const nf = (p.nombre_fantasia || '').toString().trim().toLowerCase();
    if (nf) proveedoresPorNombre.set(nf, p.id);
  }
  const productosPorCodigo = new Map();
  for (const p of productosEmpresa || []) {
    const k = (p.codigo || '').toString().trim().toLowerCase();
    if (k) productosPorCodigo.set(k, p.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaOrdenesCompra(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['cantidad', 'precio_unitario', 'iva_pct']);

    const cuit = normalizarCuit(datosMapeados.proveedor_cuit);
    const nombreNorm = (datosMapeados.proveedor_razon_social || '').toString().trim().toLowerCase();
    const proveedorId = (cuit && proveedoresPorCuit.get(cuit)) || (nombreNorm && proveedoresPorNombre.get(nombreNorm)) || null;
    if ((cuit || nombreNorm) && !proveedorId) {
      errores.push(`Proveedor "${datosMapeados.proveedor_cuit || datosMapeados.proveedor_razon_social}" no encontrado. Migrá los proveedores primero.`);
    }

    const codigo = (datosMapeados.producto_codigo || '').toString().trim().toLowerCase();
    const productoId = codigo ? productosPorCodigo.get(codigo) : null;
    if (codigo && !productoId) errores.push(`Producto con código "${datosMapeados.producto_codigo}" no encontrado. Migrá los productos primero.`);

    if (proveedorId) datosMapeados.proveedor_id_resuelto = proveedorId;
    if (productoId) datosMapeados.producto_id_resuelto = productoId;

    const estadoResuelto = normalizarEstadoOC(datosMapeados.estado);
    if (estadoResuelto) datosMapeados.estado_resuelto = estadoResuelto;

    const fechaPedidoIso = aFechaISO(datosMapeados.fecha_pedido);
    if (fechaPedidoIso) datosMapeados.fecha_pedido_iso = fechaPedidoIso;
    const fechaRecepcionIso = aFechaISO(datosMapeados.fecha_recepcion);
    if (fechaRecepcionIso) datosMapeados.fecha_recepcion_iso = fechaRecepcionIso;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para pagos_proveedores (punto 5 del plan, P1) ─────────────
// Patrón plano como cta_cte: 1 fila = 1 pago, sin agrupación. El proveedor se
// resuelve igual que en ordenes_compra (dual CUIT/razón social, SOLO_MATCH,
// nunca autocrea). Medio de pago y fecha se resuelven acá y quedan en
// datos_mapeados (medio_pago_resuelto, fecha_pago_iso) para que
// migracion_confirmar_pagos_proveedores_lote no tenga que parsear texto.
async function mapearSesionPagosProveedores(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.pagos_proveedores;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });
  if (!mapeo_columnas?.proveedor_cuit && !mapeo_columnas?.proveedor_razon_social) {
    return res.status(400).json({ error: 'Falta mapear: proveedor_cuit o proveedor_razon_social (al menos uno de los dos)' });
  }

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const proveedoresEmpresa = await listarProveedoresParaDedupePorEmpresa(perfil.empresa_id);

  const proveedoresPorCuit = new Map();
  const proveedoresPorNombre = new Map();
  for (const p of proveedoresEmpresa || []) {
    const k = normalizarCuit(p.cuit);
    if (k) proveedoresPorCuit.set(k, p.id);
    const rs = (p.razon_social || '').toString().trim().toLowerCase();
    if (rs) proveedoresPorNombre.set(rs, p.id);
    const nf = (p.nombre_fantasia || '').toString().trim().toLowerCase();
    if (nf) proveedoresPorNombre.set(nf, p.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaPagosProveedores(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['monto']);

    const cuit = normalizarCuit(datosMapeados.proveedor_cuit);
    const nombreNorm = (datosMapeados.proveedor_razon_social || '').toString().trim().toLowerCase();
    const proveedorId = (cuit && proveedoresPorCuit.get(cuit)) || (nombreNorm && proveedoresPorNombre.get(nombreNorm)) || null;
    if ((cuit || nombreNorm) && !proveedorId) {
      errores.push(`Proveedor "${datosMapeados.proveedor_cuit || datosMapeados.proveedor_razon_social}" no encontrado. Migrá los proveedores primero.`);
    }
    if (proveedorId) datosMapeados.proveedor_id_resuelto = proveedorId;

    const medioResuelto = normalizarMedioPago(datosMapeados.medio_pago);
    if (medioResuelto) datosMapeados.medio_pago_resuelto = medioResuelto;

    const fechaPagoIso = aFechaISO(datosMapeados.fecha_pago);
    if (fechaPagoIso) datosMapeados.fecha_pago_iso = fechaPagoIso;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote, { campoMonto: 'monto' });
}

// ─── Mapeo dedicado para lotes / FEFO históricos (migración 172, plan P2 punto 10) ──
// Producto debe existir ya (se resuelve por código, mismo criterio que
// precios_clientes/pedidos — nunca se autocrea). El depósito, en cambio,
// sigue el criterio de productos (migración 157): si la fila trae uno se
// resuelve/autocrea por nombre server-side (migracion_resolver_deposito,
// dentro de migracion_confirmar_lotes_lote); si no, cae al depósito elegido
// acá para toda la sesión (deposito_id) o al principal de la empresa (eso
// último lo resuelve confirmarSesion, no acá).
async function mapearSesionLotes(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas, deposito_id } = req.body || {};
  const config = CAMPOS.lotes;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  let depositoId = null;
  if (deposito_id) {
    const dep = await obtenerDepositoPorId(perfil.empresa_id, deposito_id);
    if (!dep) return res.status(400).json({ error: 'Depósito inválido' });
    depositoId = dep.id;
  }

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas, deposito_id: depositoId });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const productosEmpresa = await listarCodigosProductosPorEmpresa(perfil.empresa_id);
  const productosPorCodigo = new Map();
  for (const p of productosEmpresa || []) {
    const k = (p.codigo || '').toString().trim().toLowerCase();
    if (k) productosPorCodigo.set(k, p.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaLotes(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['cantidad', 'costo_unitario']);

    const codigo = (datosMapeados.producto_codigo || '').toString().trim().toLowerCase();
    const productoId = codigo ? productosPorCodigo.get(codigo) : null;
    if (codigo && !productoId) errores.push(`Producto con código "${datosMapeados.producto_codigo}" no encontrado. Migrá los productos primero.`);
    if (productoId) datosMapeados.producto_id_resuelto = productoId;

    // migracion_confirmar_lotes_lote castea fecha_fabricacion/fecha_vencimiento
    // directo a ::DATE (sin tolerancia de formato), así que acá se reemplaza
    // el valor crudo por el ISO ya resuelto en el mismo campo — a diferencia
    // de ordenes_compra/pagos_proveedores, no se agrega un campo "_iso" aparte
    // porque la función SQL de esta entidad lee el nombre de campo original.
    if (datosMapeados.fecha_fabricacion) {
      const iso = aFechaISO(datosMapeados.fecha_fabricacion);
      if (iso) datosMapeados.fecha_fabricacion = iso;
    }
    if (datosMapeados.fecha_vencimiento) {
      const iso = aFechaISO(datosMapeados.fecha_vencimiento);
      if (iso) datosMapeados.fecha_vencimiento = iso;
    }

    const estadoResuelto = normalizarEstadoLote(datosMapeados.estado_lote);
    if (estadoResuelto) datosMapeados.estado_lote = estadoResuelto;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para cheques históricos (migración 174, plan P2 punto 11) ──
// Cliente OPCIONAL: solo se resuelve/valida si la fila trae CUIT (mismo
// criterio de "opcional pero si está tiene que existir" que proveedor en
// pagos_proveedores). Sin agrupación, 1 fila = 1 cheque.
async function mapearSesionCheques(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.cheques;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaCheques(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['monto']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const fechaVtoIso = aFechaISO(datosMapeados.fecha_vto);
    if (fechaVtoIso) datosMapeados.fecha_vto_iso = fechaVtoIso;

    const estadoResuelto = normalizarEstadoCheque(datosMapeados.estado);
    if (estadoResuelto) datosMapeados.estado = estadoResuelto;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote, { campoMonto: 'monto' });
}

// ─── Mapeo dedicado para puntos de fidelización históricos (migración 174, plan P2 punto 11) ──
// Cliente DEBE existir ya (se resuelve por CUIT, nunca se autocrea, mismo
// criterio que cta_cte/precios_clientes). Sin agrupación, 1 fila = 1 movimiento.
async function mapearSesionPuntos(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.puntos_fidelizacion;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaPuntos(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['cantidad']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const tipoResuelto = normalizarTipoPuntos(datosMapeados.tipo);
    if (tipoResuelto) datosMapeados.tipo_resuelto = tipoResuelto;

    const fechaIso = aFechaISO(datosMapeados.fecha);
    if (fechaIso) datosMapeados.fecha_iso = fechaIso;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote, { campoMonto: 'cantidad' });
}

// ─── Mapeo dedicado para ventas POS históricas (migración 174, plan P2 punto 14) ──
// Mismo patrón cabecera+items que ordenes_compra, agrupando por numero_venta
// (+ cliente, que puede ser NULL a diferencia de proveedor en OC). Cliente es
// opcional, producto DEBE existir ya (se resuelve por código).
async function mapearSesionVentasPos(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.ventas_pos;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const productosEmpresa = await listarCodigosProductosPorEmpresa(perfil.empresa_id);

  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }
  const productosPorCodigo = new Map();
  for (const p of productosEmpresa || []) {
    const k = (p.codigo || '').toString().trim().toLowerCase();
    if (k) productosPorCodigo.set(k, p.id);
  }

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaVentasPos(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['cantidad', 'precio_unitario', 'descuento_pct']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const codigo = (datosMapeados.producto_codigo || '').toString().trim().toLowerCase();
    const productoId = codigo ? productosPorCodigo.get(codigo) : null;
    if (codigo && !productoId) errores.push(`Producto con código "${datosMapeados.producto_codigo}" no encontrado. Migrá los productos primero.`);
    if (productoId) datosMapeados.producto_id_resuelto = productoId;

    const estadoResuelto = normalizarEstadoVentaPos(datosMapeados.estado);
    if (estadoResuelto) datosMapeados.estado = estadoResuelto;

    const fechaIso = aFechaISO(datosMapeados.fecha);
    if (fechaIso) datosMapeados.fecha_iso = fechaIso;

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── Mapeo dedicado para comprobantes fiscales históricos (migración 177, cierre gap crítico 1) ──
// Cliente DEBE existir ya (se resuelve por CUIT, nunca se autocrea — mismo
// criterio que cta_cte/precios_clientes/puntos, y coherente con que
// comprobantes_historicos.cliente_id es NOT NULL). Sin agrupación, 1 fila =
// 1 comprobante. El dedupe real vive en la constraint UNIQUE(empresa_id,
// cliente_id, tipo, numero_original) del lado de la RPC de confirmación
// (ON CONFLICT DO NOTHING, cuenta como "omitido" — no error), así que acá
// solo se avisa de duplicados DENTRO del mismo archivo, igual criterio que
// las demás entidades con dedupe compuesto (precios_clientes).
async function mapearSesionComprobantesHistoricos(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.comprobantes_historicos;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }

  // Clave de dedupe intra-archivo: cliente + tipo + número (mismo criterio
  // que la constraint real de la tabla), leída sobre los campos ya
  // resueltos (cliente_id_resuelto/tipo_resuelto) que esta misma función
  // escribe en datos_mapeados.
  const extractorClave = (dm) => (dm?.cliente_id_resuelto && dm?.tipo_resuelto && dm?.numero_original)
    ? `${dm.cliente_id_resuelto}|${dm.tipo_resuelto}|${String(dm.numero_original).trim().toLowerCase()}`
    : null;
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaComprobantesHistoricos(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['monto']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const tipoResuelto = normalizarTipoComprobante(datosMapeados.tipo);
    if (tipoResuelto) datosMapeados.tipo_resuelto = tipoResuelto;

    const fechaIso = aFechaISO(datosMapeados.fecha);
    if (fechaIso) datosMapeados.fecha_iso = fechaIso;

    if (!datosMapeados.moneda || !String(datosMapeados.moneda).trim()) datosMapeados.moneda = 'ARS';

    const claveEfectiva = extractorClave(datosMapeados);
    if (claveEfectiva) {
      if (clavesVistas.has(claveEfectiva)) {
        errores.push('Comprobante duplicado dentro del archivo (mismo cliente + tipo + número)');
      }
      clavesVistas.add(claveEfectiva);
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote, { campoMonto: 'monto' });
}

// ─── Mapeo dedicado para direcciones de entrega (migración 179, cierre punto 18 del plan) ──
// Cliente DEBE existir ya (se resuelve por CUIT, nunca se autocrea — mismo
// criterio que comprobantes_historicos/cheques/puntos). Sin agrupación, 1
// fila = 1 dirección. El dedupe real vive en la constraint UNIQUE(empresa_id,
// cliente_id, domicilio) del lado de la RPC de confirmación (ON CONFLICT DO
// NOTHING, cuenta como "omitido" — no error), así que acá solo se avisa de
// duplicados DENTRO del mismo archivo, igual criterio que comprobantes.
async function mapearSesionDirecciones(req, res, perfil, sesion) {
  const { sesion_id, mapeo_columnas } = req.body || {};
  const config = CAMPOS.direcciones;

  const faltantes = config.requeridos.filter(c => !mapeo_columnas?.[c]);
  if (faltantes.length) return res.status(400).json({ error: `Falta mapear: ${faltantes.join(', ')}` });

  try {
    await prepararPasadaDeMapeo(sesion_id, sesion, { mapeo_columnas });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }

  const lote = await obtenerLoteSinMapear(sesion_id, LOTE_MAPEO);

  const clientesEmpresa = await listarCuitClientesPorEmpresa(perfil.empresa_id);
  const clientesPorCuit = new Map();
  for (const c of clientesEmpresa || []) {
    const k = normalizarCuit(c.cuit);
    if (k) clientesPorCuit.set(k, c.id);
  }

  // Clave de dedupe intra-archivo: cliente + domicilio (mismo criterio que
  // la constraint real de la tabla), sobre datos_originales trimeados igual
  // que hace la RPC de confirmación, leída sobre el campo ya resuelto
  // (cliente_id_resuelto) que esta misma función escribe en datos_mapeados.
  const extractorClave = (dm) => (dm?.cliente_id_resuelto && dm?.domicilio)
    ? `${dm.cliente_id_resuelto}|${String(dm.domicilio).trim().toLowerCase()}`
    : null;
  const clavesVistas = await obtenerClavesYaMapeadas(sesion_id, extractorClave);

  const updates = lote.map(fila => {
    const datosMapeados = {};
    for (const campo of config.disponibles) {
      const colOrigen = mapeo_columnas[campo];
      if (colOrigen) datosMapeados[campo] = fila.datos_originales[colOrigen];
    }

    const errores = validarFilaDirecciones(datosMapeados);
    normalizarCamposNumericos(datosMapeados, ['lat', 'lng']);

    const cuit = normalizarCuit(datosMapeados.cliente_cuit);
    const clienteId = cuit ? clientesPorCuit.get(cuit) : null;
    if (cuit && !clienteId) errores.push(`Cliente con CUIT ${cuit} no encontrado. Migrá los clientes primero.`);
    if (clienteId) datosMapeados.cliente_id_resuelto = clienteId;

    const claveEfectiva = extractorClave(datosMapeados);
    if (claveEfectiva) {
      if (clavesVistas.has(claveEfectiva)) {
        errores.push('Dirección duplicada dentro del archivo (mismo cliente + domicilio)');
      }
      clavesVistas.add(claveEfectiva);
    }

    const esValida = errores.length === 0;

    return {
      id: fila.id,
      datos_mapeados: datosMapeados,
      es_valida: esValida,
      errores,
      accion: 'crear',
      entidad_existente_id: null,
    };
  });

  if (updates.length) {
    const { error: errBulk } = await sb.rpc('migracion_mapear_bulk', { p_sesion_id: sesion_id, p_filas: updates });
    if (errBulk) return errorSeguro(res, errBulk, 500, 'Error actualizando filas.');
  }

  return await finalizarLoteDeMapeo(res, sesion_id, lote);
}

// ─── PATCH ?accion=fila ───────────────────────────────────────────────────────
async function cambiarAccionFila(req, res, perfil) {
  const { fila_id, accion } = req.body || {};
  if (!['crear', 'actualizar', 'omitir'].includes(accion)) {
    return res.status(400).json({ error: 'Acción de fila inválida' });
  }

  const { data: fila, error: errFila } = await MigracionRepo.obtenerFilaPorId(fila_id);
  if (errFila || !fila) return res.status(404).json({ error: 'Fila no encontrada' });

  const sesion = await cargarSesionPropia(fila.sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Fila no encontrada' });

  if (!fila.es_valida && accion !== 'omitir') {
    return res.status(400).json({ error: 'Solo se puede omitir una fila inválida' });
  }
  if (accion === 'actualizar' && !fila.entidad_existente_id) {
    return res.status(400).json({ error: 'Esta fila no tiene un registro existente para actualizar' });
  }

  const error = await MigracionRepo.actualizarAccionFila(fila_id, accion);
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  return res.json({ ok: true });
}

// ─── POST ?accion=confirmar ───────────────────────────────────────────────────
// ─── POST ?accion=precheck ────────────────────────────────────────────────
// Punto 11 del audit: chequeo de advertencias no bloqueantes antes de que el
// usuario confirme definitivamente. Corre server-side (RPC
// migracion_precheck_advertencias, migración 178) porque compara filas entre
// sí y contra la tabla real de clientes/productos — cosas que del lado del
// frontend serían caras o directamente inviables (similitud de texto vía
// pg_trgm). Por ahora cubre 'clientes' (razones sociales parecidas, entre sí
// o contra clientes ya existentes, y vendedores mencionados en el archivo que
// no se pudieron resolver a un vendedor real) y 'productos' (precio nuevo por
// debajo del costo actual). Para el resto de las entidades la RPC devuelve
// directamente []. Las advertencias quedan guardadas en
// migracion_sesiones.advertencias_precheck para que el informe final
// (mostrarResultado) las pueda listar también. No modifica ninguna fila de
// staging ni cambia el estado de la sesión — es puramente informativo, el
// usuario puede confirmar igual aunque haya advertencias.
async function precheckSesion(req, res, perfil) {
  const { sesion_id } = req.body || {};

  const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  if (!['validado', 'error'].includes(sesion.estado)) {
    return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}" y no admite precheck` });
  }

  try {
    const { data, error } = await sb.rpc('migracion_precheck_advertencias', {
      p_sesion_id: sesion_id,
      p_empresa_id: perfil.empresa_id,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ advertencias: data || [] });
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
  }
}

// Procesa UN lote acotado de filas por llamada (ver migración 152:
// migracion_confirmar_clientes_lote / migracion_confirmar_productos_lote).
// Esto resuelve dos problemas del enfoque anterior (insert/update fila por
// fila desde Node):
//   - Timeout: cada llamada HTTP hace 1 solo round-trip a Supabase; el loop
//     de filas corre server-side dentro de Postgres, sin latencia de red
//     entre filas.
//   - Idempotencia: cada fila se marca `procesado_en` apenas se confirma, en
//     su propia transacción. Si el cliente reintenta (por timeout, corte de
//     red, etc.), las filas ya procesadas se saltean automáticamente — no se
//     insertan de nuevo. El frontend debe llamar a este endpoint en loop
//     mientras la respuesta traiga `hay_mas: true`.
async function confirmarSesion(req, res, perfil) {
  const { sesion_id } = req.body || {};

  const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  // 'confirmando' también es válido acá: es el estado en el que queda una
  // sesión grande entre llamadas sucesivas mientras se van procesando lotes.
  if (!['validado', 'error', 'confirmando'].includes(sesion.estado)) {
    return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}" y no se puede confirmar` });
  }

  if (sesion.estado !== 'confirmando') {
    await MigracionRepo.actualizarSesion(sesion_id, { estado: 'confirmando' });
  }

  let resultadoLote;
  try {
    if (sesion.entidad === 'clientes') {
      const { data, error } = await sb.rpc('migracion_confirmar_clientes_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'pedidos') {
      // Migración 159: acá el lote es de PEDIDOS (cabecera+items agrupados),
      // no de filas sueltas, así que el tamaño de lote es más chico.
      const { data, error } = await sb.rpc('migracion_confirmar_pedidos_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 100,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'cta_cte') {
      // Migración 160: 1 fila = 1 movimiento (igual que clientes/productos en
      // tamaño de lote), pero el orden de procesamiento dentro del RPC es
      // cronológico por cliente (no por fila_numero) para que el saldo
      // corrido tenga sentido — eso lo hace la función SQL, no acá.
      const { data, error } = await sb.rpc('migracion_confirmar_cta_cte_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'precios_clientes') {
      // Migración 162: 1 fila = 1 override de precio (igual que cta_cte en
      // tamaño de lote), upsert por (cliente_id, producto_id).
      const { data, error } = await sb.rpc('migracion_confirmar_precios_cliente_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'proveedores') {
      // Migración 164: a diferencia de pedidos/cta_cte/precios_clientes,
      // acá SÍ hay 'actualizar' real (completar un stub autocreado), igual
      // que clientes/productos.
      const { data, error } = await sb.rpc('migracion_confirmar_proveedores_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'ordenes_compra') {
      // Punto 5 del plan (P1): igual que pedidos, el lote es de ÓRDENES
      // (cabecera+items agrupados por numero_orden+proveedor), no de filas
      // sueltas, así que el tamaño de lote es más chico.
      const { data, error } = await sb.rpc('migracion_confirmar_ordenes_compra_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 100,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'pagos_proveedores') {
      // Punto 5 del plan (P1): 1 fila = 1 pago (igual que cta_cte en tamaño
      // de lote), sin saldo corrido — es un registro plano.
      const { data, error } = await sb.rpc('migracion_confirmar_pagos_proveedores_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'lotes') {
      // Migración 172: mismo criterio de depósito de fallback que productos
      // — si la sesión tiene uno elegido en el mapeo se usa ese, si no cae
      // al principal de la empresa. El depósito POR FILA (si la fila trae
      // "deposito") lo resuelve la propia función SQL, no acá.
      let depositoId = sesion.deposito_id || null;
      if (!depositoId) {
        const deposito = await obtenerDepositoPrincipal(perfil.empresa_id);
        depositoId = deposito?.id || null;
      }

      const { data, error } = await sb.rpc('migracion_confirmar_lotes_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_deposito_id: depositoId,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'cheques') {
      // Migración 174: 1 fila = 1 cheque, sin agrupación (igual que cta_cte).
      const { data, error } = await sb.rpc('migracion_confirmar_cheques_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'puntos_fidelizacion') {
      // Migración 174: 1 fila = 1 movimiento, sin agrupación.
      const { data, error } = await sb.rpc('migracion_confirmar_puntos_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'ventas_pos') {
      // Migración 174: el lote es de VENTAS (cabecera+items agrupados por
      // numero_venta), no de filas sueltas, así que el tamaño es más chico
      // (mismo criterio que pedidos/ordenes_compra).
      const { data, error } = await sb.rpc('migracion_confirmar_ventas_pos_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 100,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'comprobantes_historicos') {
      // Migración 177 (cierre gap crítico 1): 1 fila = 1 comprobante, sin
      // agrupación (mismo criterio que cheques/puntos_fidelizacion). El
      // dedupe real (UNIQUE empresa_id+cliente_id+tipo+numero_original) lo
      // aplica la RPC vía ON CONFLICT DO NOTHING, contando como "omitido".
      const { data, error } = await sb.rpc('migracion_confirmar_comprobantes_historicos_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (sesion.entidad === 'direcciones') {
      // Migración 179 (cierre punto 18 del plan): 1 fila = 1 dirección, sin
      // agrupación (mismo criterio que comprobantes_historicos/cheques). El
      // dedupe real (UNIQUE empresa_id+cliente_id+domicilio) lo aplica la
      // RPC vía ON CONFLICT DO NOTHING, contando como "omitido".
      const { data, error } = await sb.rpc('migracion_confirmar_direcciones_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else if (['categorias', 'depositos', 'listas_precios', 'zonas'].includes(sesion.entidad)) {
      // Migración 173 (punto 7 del plan): RPC única parametrizada por
      // entidad para las 4 entidades "maestro" — evita 4 funciones SQL
      // casi idénticas (ver migracion_confirmar_maestro_lote).
      const { data, error } = await sb.rpc('migracion_confirmar_maestro_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_entidad: sesion.entidad,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    } else {
      // Migración 156: si la sesión tiene depósito/lista elegidos explícitamente
      // (paso de mapeo), se usan esos; si no, cae al comportamiento histórico
      // de tomar el principal/default de la empresa.
      let depositoId = sesion.deposito_id || null;
      let listaId = sesion.lista_precio_id || null;

      if (!depositoId) {
        const deposito = await obtenerDepositoPrincipal(perfil.empresa_id);
        depositoId = deposito?.id || null;
      }
      if (!listaId) {
        const lista = await obtenerListaPrecioDefault(perfil.empresa_id);
        listaId = lista?.id || null;
      }

      const { data, error } = await sb.rpc('migracion_confirmar_productos_lote', {
        p_sesion_id: sesion_id,
        p_empresa_id: perfil.empresa_id,
        p_deposito_id: depositoId,
        p_lista_id: listaId,
        p_usuario_id: perfil.id,
        p_lote_size: 500,
      });
      if (error) throw error;
      resultadoLote = data;
    }
  } catch (err) {
    await marcarSesionError(sesion_id, perfil.empresa_id, err.message, { resumen_errores: [err.message] });
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.', { error: 'Error durante la importación: ' + err.message });
  }

  const hayMas = !!resultadoLote?.hay_mas;
  const advertenciasLote = Array.isArray(resultadoLote?.advertencias) ? resultadoLote.advertencias : [];

  if (advertenciasLote.length) {
    const previas = Array.isArray(sesion.resumen_advertencias) ? sesion.resumen_advertencias : [];
    // Tope defensivo: con archivos masivos no queremos un jsonb sin límite.
    const acumuladas = [...previas, ...advertenciasLote].slice(0, 500);
    await MigracionRepo.actualizarSesion(sesion_id, { resumen_advertencias: acumuladas });
  }

  // Progreso acumulado real: se recalcula agregando sobre migracion_staging_rows
  // (no sobre el resultado del lote actual), así el frontend siempre ve el
  // total correcto sin importar en qué lote/reintento está.
  const agregado = await MigracionRepo.obtenerProgresoConfirmacion(sesion_id);

  let creados = 0, actualizados = 0, errores = 0;
  for (const f of agregado || []) {
    if (f.error_ejecucion) errores++;
    else if (f.accion === 'actualizar') actualizados++;
    else creados++;
  }

  let advertenciasTotales = [];
  if (!hayMas) {
    const sesionFinal = await MigracionRepo.obtenerResumenAdvertenciasSesion(sesion_id);
    advertenciasTotales = Array.isArray(sesionFinal?.resumen_advertencias) ? sesionFinal.resumen_advertencias : [];

    await MigracionRepo.actualizarSesion(sesion_id, {
      estado: 'completado',
      resumen_errores: errores ? [`${errores} fila(s) con error durante la importación`] : null,
      actualizado_at: new Date().toISOString(),
    });

    await AuditRepo.registrarAuditoria({
      empresa_id: perfil.empresa_id,
      usuario_id: perfil.id,
      tabla: sesion.entidad,
      accion: 'INSERT',
      registro_id: sesion_id,
      datos_despues: { sesion_id, entidad: sesion.entidad, creados, actualizados, errores },
    });
  }

  return res.json({
    resultado: { creados, actualizados, errores },
    hay_mas: hayMas,
    advertencias: hayMas ? undefined : advertenciasTotales,
  });
}

// ─── POST ?accion=reintentar ───────────────────────────────────────────────────
// Reabre una sesión "completado" y limpia el marcador de error de las filas
// que fallaron durante la última confirmación (error_ejecucion no nulo),
// para que el próximo accion=confirmar las vuelva a tomar. No toca filas
// que ya se importaron bien ni filas inválidas/omitidas — es un reintento
// puntual de lo que falló, no un reprocesamiento completo.
//
// Importante: reintenta con los MISMOS datos mapeados. Si el error fue por
// un dato malo en la fila (no por algo transitorio como un timeout), va a
// volver a fallar con el mismo mensaje; en ese caso hay que corregir la
// fila desde "Revisar" antes de reintentar, no alcanza con este botón.
async function reintentarFallidas(req, res, perfil) {
  const { sesion_id } = req.body || {};

  const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  if (sesion.estado !== 'completado') {
    return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}"; solo se puede reintentar una sesión completada` });
  }

  const { data: fallidas, error: errFallidas } = await MigracionRepo.reabrirFilasFallidas(sesion_id);
  if (errFallidas) return errorSeguro(res, errFallidas, 500, 'No se pudo completar la operación.');

  if (!fallidas || fallidas.length === 0) {
    return res.status(400).json({ error: 'No hay filas con error para reintentar' });
  }

  await MigracionRepo.actualizarSesion(sesion_id, { estado: 'confirmando', actualizado_at: new Date().toISOString() });

  return res.json({ ok: true, filas_reintentadas: fallidas.length });
}

// ─── POST ?accion=deshacer ─────────────────────────────────────────────────────
// Revierte una sesión "completado" (migración 161). Mismo patrón idempotente
// por lotes que confirmarSesion: cada llamada procesa un lote acotado server-side
// (migracion_deshacer_sesion) y el frontend reinvoca mientras hay_mas=true.
//
// IMPORTANTE — alcance real, no un "Ctrl+Z" perfecto:
//   - Filas creadas (accion='crear'): se eliminan. Es seguro porque las FK
//     protegen contra romper datos reales creados después (ver comentario en
//     la migración SQL); lo que no se puede borrar queda como "omitido" con
//     el motivo en deshecho_error, no falla la sesión entera.
//   - Filas que actualizaron un registro existente (accion='actualizar'): NO
//     se revierten, quedan marcadas "no_revertible". Avisamos esto explícitamente
//     en la respuesta para que no parezca que todo volvió al estado anterior.
async function deshacerSesion(req, res, perfil) {
  const { sesion_id } = req.body || {};

  const sesion = await cargarSesionPropia(sesion_id, perfil.empresa_id);
  if (!sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

  // 'deshaciendo' también es válido: es el estado entre llamadas sucesivas
  // de una sesión grande que se está deshaciendo en varios lotes.
  if (!['completado', 'deshaciendo'].includes(sesion.estado)) {
    return res.status(400).json({ error: `La sesión está en estado "${sesion.estado}" y no se puede deshacer (solo aplica a sesiones "completado")` });
  }

  if (sesion.estado !== 'deshaciendo') {
    await MigracionRepo.actualizarSesion(sesion_id, { estado: 'deshaciendo' });
  }

  let resultadoLote;
  try {
    const { data, error } = await sb.rpc('migracion_deshacer_sesion', {
      p_sesion_id: sesion_id,
      p_empresa_id: perfil.empresa_id,
      p_entidad: sesion.entidad,
      p_usuario_id: perfil.id,
      p_lote_size: 200,
    });
    if (error) throw error;
    resultadoLote = data;
  } catch (err) {
    await marcarSesionError(sesion_id, perfil.empresa_id, 'Error al deshacer: ' + err.message, { resumen_errores: ['Error al deshacer: ' + err.message] });
    return errorSeguro(res, err, 500, 'No se pudo completar la operación.', { error: 'Error al deshacer la importación: ' + err.message });
  }

  const hayMas = !!resultadoLote?.hay_mas;

  // Progreso acumulado real: igual que confirmarSesion, se recalcula sobre
  // migracion_staging_rows completo (no sobre el lote actual), así el
  // frontend siempre ve el total correcto sin importar en qué lote está.
  const agregado = await MigracionRepo.obtenerProgresoDeshacer(sesion_id);

  let eliminados = 0, noRevertibles = 0, omitidos = 0;
  for (const f of agregado || []) {
    if (!f.deshecho_error) eliminados++;
    else if (f.accion === 'actualizar') noRevertibles++;
    else omitidos++;
  }

  if (!hayMas) {
    await MigracionRepo.actualizarSesion(sesion_id, {
      estado: 'deshecho',
      actualizado_at: new Date().toISOString(),
    });

    // v200d fix: audit_log_accion_check solo permite INSERT/UPDATE/DELETE.
    // 'ROLLBACK_MIGRACION' violaba el constraint y tiraba una excepción no
    // capturada acá, devolviendo 500 aunque el rollback ya se hubiera
    // completado con éxito (el UPDATE de arriba ya había commiteado).
    // Se mapea a 'DELETE' (semánticamente correcto: revierte altas) y se
    // conserva el detalle legible en datos_despues.
    await AuditRepo.registrarAuditoria({
      empresa_id: perfil.empresa_id,
      usuario_id: perfil.id,
      tabla: sesion.entidad,
      accion: 'DELETE',
      registro_id: sesion_id,
      datos_despues: {
        evento: 'rollback_migracion',
        sesion_id, entidad: sesion.entidad,
        eliminados, no_revertibles: noRevertibles, omitidos,
      },
    });
  }

  return res.json({
    resultado: { eliminados, no_revertibles: noRevertibles, omitidos },
    hay_mas: hayMas,
    aviso: !hayMas && noRevertibles > 0
      ? `${noRevertibles} fila(s) habían actualizado registros existentes y no se pudieron revertir automáticamente — revisalas a mano.`
      : undefined,
  });
}

// La lógica de inserción/actualización de clientes y productos (antes acá,
// fila por fila) vive ahora en las funciones SQL migracion_confirmar_clientes_lote
// y migracion_confirmar_productos_lote (migración 152), para correr server-side
// en lote y soportar reintentos idempotentes. Ver confirmarSesion() más arriba.
