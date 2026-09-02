// lib/asistente-tools/_constantes.js
// Constantes compartidas por las tools del asistente. Extraídas tal cual
// de lib/asistente-tools.js en el split del 25/08/2026.

// liquidacion.html (Fase D — plan §2/§6, CHANGELOG_v716): a diferencia del
// resto de filas 🔴 del inventario original, esta SÍ tenía handler +
// repo + RPC completos desde antes (lib/handlers/stock.js →
// handleLiquidacion(), lib/repos/stock.js, RPC generar_ofertas_liquidacion)
// — el diagnóstico de "sin RPC server-side, hay que construir handler
// primero" en §2 estaba mal, mismo tipo de error que ya se había
// encontrado con facturación en v715. Roles de lectura calcados de
// `stock: { acceder: [...] }` en lib/permisos-service.js, que es el
// gate real que usa handleLiquidacion() para listar ofertas y reglas.
// Roles de escritura (generar ahora / guardar reglas) más restrictivos
// a propósito, calcados del chequeo explícito `['dueno','admin']` que
// hace el handler para esas dos acciones puntuales (vendedor/depositero
// pueden VER pero no tocar reglas ni disparar la generación manual).

// Cuánto tiempo queda vigente una acción propuesta esperando el click
// de Confirmar/Cancelar. Pasado esto, un click tardío no ejecuta nada
// (se le pide al usuario que repita el pedido para generar un resumen
// fresco, por si mientras tanto cambió algo — ej. el pedido que se
// iba a anular ya se facturó).
const TTL_CONFIRMACION_MS = 10 * 60_000;

// Eventos y templates de WhatsApp disponibles para armar una regla de
// automatización por voz — deben coincidir exacto con EVENTOS_DISPONIBLES
// y TEMPLATES_WHATSAPP_DISPONIBLES de lib/repos/reglas-automatizacion.js
// (son la fuente de verdad; acá se duplican como arrays porque el schema
// de la tool necesita el `enum` en JS plano, no importado del repo, mismo
// criterio que TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE ya usa el resto
// del archivo para otros catálogos chicos). Si se agrega un evento o
// template nuevo en el repo, hay que sumarlo acá también.
// NOTA (fix v455): estas 4 constantes se movieron acá arriba, antes del
// array TOOLS, porque varias tools referencian el `enum` directamente en
// el objeto `parameters` (no dentro de un `execute`), y ese objeto se
// evalúa apenas se importa el módulo. Declaradas más abajo en el archivo,
// TOOLS explotaba con "Cannot access before initialization" (TDZ) al
// cargar /api/index, tirando 500 en todos los endpoints — incluido
// /api/admin/kpis, por eso el dashboard cargaba con todo en 0.
const EVENTOS_DISPONIBLES_ASISTENTE = [
  'pedido_creado',
  'pedido_facturado',
  'factura_anulada',
  'cliente_en_mora',
  'cheques_por_vencer',
];

const EVENTOS_LABELS_ASISTENTE = {
  pedido_creado: 'se crea un pedido',
  pedido_facturado: 'se factura un pedido',
  factura_anulada: 'se anula una factura',
  cliente_en_mora: 'un cliente entra en mora',
  cheques_por_vencer: 'un cheque está por vencer',
};

const TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE = [
  'confirmacion_pedido',
  'pedido_despachado',
  'pedido_cancelado',
  'deuda_vencida',
  'pedido_entregado',
  'pedido_no_entregado',
  'pedido_por_llegar',
  'cheques_por_vencer',
  'oferta_plan_pago',
  'ruta_asignada',
];

// Roles internos válidos para accion.roles (notificar_push/crear_tarea) de
// una regla de automatización — mismos checkboxes que ra-roles-grid/
// ra-tarea-roles-grid en frontend/admin/js/automatizacion.js. 'cliente'
// queda afuera a propósito (no es un rol interno, ver usuarios.js).
const ROLES_NOTIFICACION_VALIDOS = ['dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador'];


export { TTL_CONFIRMACION_MS, EVENTOS_DISPONIBLES_ASISTENTE, EVENTOS_LABELS_ASISTENTE, TEMPLATES_WHATSAPP_DISPONIBLES_ASISTENTE, ROLES_NOTIFICACION_VALIDOS };
