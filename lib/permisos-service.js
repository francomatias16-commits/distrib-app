// lib/permisos-service.js
// Fase 7, sección 2 de FASE7_PLAN_ARRANQUE.md.
//
// Hoy cada handler resuelve permisos a mano con su propio array
// `ROLES_*` (`ROLES_LECTURA`, `ROLES_ESCRITURA`, `ROLES_TAREAS`, etc. —
// un nombre distinto por archivo, ver el relevamiento en la sección 0
// del plan: hay ~35 constantes `ROLES_*` repartidas en 20+ handlers).
// Este servicio centraliza esa tabla en un solo lugar: `{ recurso: {
// accion: [roles] } }`, para que un cambio de política de permisos no
// obligue a tocar N archivos.
//
// Piloto: `reglas-automatizacion.js` (candidato que la propia sección 2
// del plan señala) — mismo criterio que `clientes` fue el piloto de la
// capa de repos en el paso 1: empezar por el módulo más chico, validar
// el patrón, recién después expandir. Segundo módulo migrado:
// `export-contable.js` (2 arrays, autocontenido — nadie más los
// importaba). El resto de los `ROLES_*` existentes (pedidos, pos,
// facturas, etc.) se migran de a uno en entregas futuras, no en este
// mismo paso — mismo espíritu del punto 4 de la sección "Qué NO hacer"
// (nada de migraciones grandes de una). Tercer y cuarto módulo:
// `importar.js` y `bcra.js` — cada uno con un único array/gate para todo
// el handler, los dos más chicos posibles. `usuarios.js` y `migracion.js`
// quedan afuera a propósito: `ROLES_GESTION`/`ROLES_MIGRACION` se
// reexportan e importan desde `asistente-tools.js` (mayor blast radius) y
// `ROLES_ASIGNABLES`/`ROLES_PRIVILEGIADOS` de `usuarios.js` no son gates
// de acción simples — son lógica jerárquica (rol del actor vs. rol del
// objetivo), no encajan en el modelo `puede(perfil, accion, recurso)`
// sin forzarlo.
//
// `verificarToken(req, db)` (lib/auth-helpers.js) sigue siendo quien
// resuelve `perfil` (id/empresa_id/rol) — este servicio no reemplaza
// eso, solo la segunda mitad: decidir si ESE perfil puede hacer ESA
// acción sobre ESE recurso.

/**
 * Tabla de reglas: recurso -> acción -> roles permitidos.
 *
 * `reglas_automatizacion` replica exacto ROLES_LECTURA/ROLES_ESCRITURA
 * de reglas-automatizacion.js (ambos eran ['dueno','admin'] — el mismo
 * gate restrictivo que las preferencias de push del panel, no se abre
 * a vendedor/contador).
 *
 * `tareas_automatizacion` replica ROLES_TAREAS del mismo handler — se
 * resuelve ANTES que el gate de arriba y es más permisivo a propósito
 * (cualquier rol interno de la empresa puede tener una tarea asignada).
 * `leer` y `completar` comparten el mismo set de roles porque el
 * original usaba un único ROLES_TAREAS para los dos endpoints
 * (_svc=tareas y _svc=tareas-completar) — se preserva tal cual
 * (expand-contract, sin "mejorarlo" de paso).
 *
 * `export_contable` replica ROLES_EXPORT_CONTABLE/ROLES_CONFIG de
 * export-contable.js. `acceder` es el gate de nivel superior (cualquier
 * método/recurso del handler — generar export, ver historial, leer
 * config); `configurar` es el más restrictivo de los dos, solo para
 * escribir la config de plan de cuentas (POST /config).
 *
 * `importar` replica ROLES_IMPORTAR de importar.js — un único gate
 * ('cargar') para el handler entero (CSV vía RPC y OCR/Vision por igual,
 * el original no distinguía entre los dos modos).
 *
 * `bcra` replica ROLES_PERMITIDOS de bcra.js — un único gate ('consultar')
 * para todo el handler (cheques denunciados/rechazados, central de
 * deudores, listado de entidades).
 *
 * `busqueda` replica ROLES_ADMIN de busqueda.js — un único gate
 * ('buscar') para el handler entero (búsqueda global de clientes,
 * productos, pedidos, presupuestos, facturas y cheques).
 *
 * `ciclos` replica ROLES_ADMIN de ciclos.js — un único gate ('acceder')
 * para todo el handler (GET de ciclos + sugerido pendiente, envío y
 * descarte de sugerencia por WhatsApp).
 *
 * `admin_dashboard` replica ROLES_ADMIN de admin.js — un único gate
 * ('acceder') resuelto en `autenticar()`, compartido por los 9 _svc del
 * dashboard admin (kpis, pedidos, stock-bajo, ventas-diarias, alertas,
 * onboarding, dashboard-ejecutivo, comparativa-mensual, resumen-arranque).
 * Nombre distinto de `admin` a secas para no chocar con el uso genérico
 * de "admin" como concepto en el resto del sistema.
 *
 * `auto_imagenes` replica ROLES_PERMITIDOS de auto-imagenes.js — un
 * único gate ('ejecutar') para todo el handler (GET de contador de uso
 * y POST de búsqueda automática de imágenes vía Serper).
 *
 * `clientes` replica ROLES_ADMIN de clientes.js — un único gate
 * ('acceder') para todo el handler de gestión de acceso portal
 * (crear/revocar acceso, no confundir con el repo `lib/repos/clientes.js`
 * que ya está migrado a capa de datos desde el paso 1 de la Fase 7).
 *
 * `empresa_config` replica ROLES_ADMIN de empresa.js — un único gate
 * ('acceder') resuelto en `requerirPerfilAdmin()`, compartido por logo,
 * icon, datos editables y toggle de catálogo público.
 *
 * Los siguientes tres son los "de 2 arrays" (leer/escribir separados,
 * `esEscritor` derivado de `escribir`), migrados sin cambiar comportamiento:
 *
 * `reglas_precio` replica ROLES_LECTURA/ROLES_ESCRITURA de
 * reglas-precio.js — lectura abierta a vendedor, escritura reservada a
 * dueño/admin/contador (crear/editar/activar/eliminar reglas de precio).
 *
 * `maestros` replica ROLES_LECTURA/ROLES_ESCRITURA de maestros.js — un
 * único gate para las 4 sub-tablas del handler (zonas, depósitos, listas
 * de precio, categorías); lectura abierta a depositero además de
 * vendedor/contador, escritura solo dueño/admin.
 *
 * `conciliacion_bancaria` replica ROLES_LECTURA/ROLES_ESCRITURA de
 * conciliacion-bancaria.js — mismo set que reglas_precio (lectura con
 * vendedor, escritura dueño/admin/contador); cubre import de lotes,
 * auto-match y confirmar/deshacer/descartar matches manuales.
 *
 * `cc_proveedores` replica ROLES_LECTURA/ROLES_ESCRITURA/ROLES_PAGO de
 * cc_proveedores.js (handleCCProveedores, montado bajo
 * /api/proveedores?_svc=cc-proveedores) — 3 gates: `leer` (balance,
 * facturas, pagos), `escribir` (alta/edición de factura de proveedor,
 * mismo set que reglas_precio/conciliacion_bancaria) y `pagar`
 * (registrar_pago_proveedor). `escribir` y `pagar` comparten
 * exactamente el mismo set de roles en el original (ambos
 * ['dueno','admin','contador']) pero se preservan como acciones
 * separadas — eran dos constantes distintas (ROLES_ESCRITURA vs
 * ROLES_PAGO) protegiendo endpoints distintos, no una redundancia a
 * "simplificar" de paso. Nota: `accion=conciliar` (conciliar_oc_factura)
 * en el original no tiene gate propio más allá del `leer` de entrada —
 * se preserva tal cual, sin agregarle un gate nuevo que no existía.
 *
 * `stock` replica ROLES_PERMITIDOS de stock.js — un único gate
 * ('acceder') compartido por 3 de las 6 sub-rutas del archivo (el
 * handler principal de stock/ajustes/movimientos, `_svc=lotes-fefo` y
 * `_svc=liquidacion`), las tres usaban idéntico array suelto. Las otras
 * 3 sub-rutas (`_svc=sugerencias`, `_svc=cliente-categorias`,
 * `_svc=cliente-productos`) no tenían gate de rol — se autentican
 * distinto (portal de cliente vía `resolverEmpresaCliente`, o sin
 * restricción de rol más allá de pertenecer a la empresa) y quedan
 * fuera de esta tabla, sin tocar.
 *
 * `stock_lotes` replica ROLES_LECTURA/ROLES_ESCRITURA de la sección
 * "Lotes" de stock.js (`_svc=lotes`, absorbida desde el extinto
 * api/lotes/index.js) — recurso separado de `stock` porque es un
 * sub-módulo con su propio par lectura/escritura y su propio set de
 * roles (lectura suma contador, escritura no incluye vendedor).
 *
 * `facturas` replica ROLES_FACTURAS de facturas.js — un único gate
 * ('acceder') para el handler principal, usado tanto para ver el
 * listado/detalle admin (`esAdmin`) como para emitir una factura nueva
 * (POST). El handler también admite acceso de solo-lectura a rol
 * `cliente` (`esCliente`, ve únicamente sus propias facturas) — eso es
 * una comparación literal de un único rol especial, no un array de
 * roles configurable, así que se deja tal cual fuera de esta tabla.
 * NOTA: `anularFacturaHandler` y `reintentarFacturaHandler` (mismo
 * archivo) repiten en línea el array `['dueno','admin','contador']`
 * (mismo valor que `ROLES_FACTURAS`) pero como literal suelto, nunca
 * fueron una constante `ROLES_*` con nombre — quedan fuera de esta
 * migración (el relevamiento original solo contó constantes con
 * nombre); es un candidato para una futura pasada, no de éste.
 *
 * `notas_credito` replica ROLES_LECTURA/ROLES_ESCRITURA de la sección
 * "Notas de crédito" de facturas.js (`_svc=notas-credito`) — lectura
 * abierta a vendedor, escritura reservada a dueño/admin (no incluye
 * contador, a diferencia de `facturas`/`reglas_precio`).
 *
 * `comprobantes_historicos` replica ROLES_COMPROBANTES_HIST de la
 * sección de igual nombre en facturas.js (`_svc=comprobantes-
 * historicos`) — un único gate ('acceder') de solo lectura para la
 * vista de comprobantes importados por el wizard de migración (sin
 * alta/baja/edición). Mismo set de roles que `facturas`, pero
 * constante propia en el original — se preserva como recurso separado.
 *
 * `proveedores` replica ROLES_LECTURA/ROLES_ESCRITURA del handler
 * principal de proveedores.js — ABM de proveedores propiamente dicho
 * (alta/edición/baja); escritura reservada a dueño/admin (no incluye
 * depositero, a diferencia de `compras`/`stock_lotes`).
 *
 * `compras` replica ROLES_LECTURA_COMPRAS/ROLES_ESCRITURA_COMPRAS de la
 * sección "Compras / Órdenes de Compra" de proveedores.js (`_svc=compras`,
 * absorbida desde el extinto api/compras/index.js) — mismo set de
 * lectura que `proveedores`, pero escritura además abierta a depositero
 * (quien recibe mercadería contra una OC).
 *
 * `comparador_precios` replica ROLES_LECTURA_COMPARADOR de la sección
 * "Comparador de precios" de proveedores.js (`_svc=comparador-precios`)
 * — un único gate ('leer', no hay escritura: es una vista de solo
 * lectura sobre datos ya cargados por Compras); no incluye vendedor, a
 * diferencia de `proveedores`/`compras`.
 *
 * `whatsapp_panel` replica ROLES_WHATSAPP_PANEL de notif.js
 * (whatsappConversacionAccionHandler) — un único gate ('gestionar')
 * para tomar/liberar una conversación de WhatsApp derivada a un humano.
 *
 * `whatsapp_onboarding` replica ROLES_WHATSAPP_ONBOARDING de notif.js
 * (whatsappEmbeddedSignupHandler/whatsappDesconectarHandler) — dos gates
 * ('conectar'/'desconectar'), ambos más restrictivos que `whatsapp_panel`
 * (no incluyen vendedor): conectar o desconectar el WhatsApp Business
 * propio de la empresa es una acción de alta/config, no de uso diario del
 * panel de conversaciones.
 *
 * `notif_estado_cuenta` replica el ROLES_PERMITIDOS local (declarado
 * dentro de la función, no a nivel de módulo) de handleEstadoCuenta en
 * notif.js — un único gate ('enviar') para reenviar el estado de
 * cuenta de un cliente por email.
 *
 * NOTA — `ROLES_POR_TIPO` de notif.js (pushInternoHandler) NO se migra
 * y queda tal cual: no es un gate de permisos (no decide si el usuario
 * que llama puede hacer algo — ese endpoint se protege con
 * INTERNAL_PUSH_SECRET, no con rol de usuario), sino una tabla que
 * decide QUIÉNES DENTRO DE LA EMPRESA reciben un push según el tipo de
 * evento (`nuevo_pedido` → dueño/admin/vendedor, `stock_critico` →
 * dueño/admin/depositero). Es un problema distinto (selección de
 * destinatarios) al que resuelve `puede(perfil, accion, recurso)`
 * (autorizar al que llama) — forzarlo en este modelo sería forzar la
 * abstracción, tal como se señaló en el relevamiento original. Por el
 * mismo motivo tampoco se tocan los otros `.in('rol', ['dueno','admin', ...])`
 * sueltos de notif.js (alertarTokenWhatsAppVencido, marcarDerivada,
 * enviarAvisoChequesPorVencer): son la misma clase de consulta
 * "a quién le aviso", no gates.
 *
 * NOTA — dos gates de notif.js quedan sin migrar en este pase por ser
 * arrays literales en línea sin nombre (nunca fueron una constante
 * `ROLES_*`, mismo criterio que las de `anular`/`reintentar` de
 * facturas.js): pushChoferHandler y handleReintentarEmail, ambos
 * `['dueno','admin']` inline. Candidatos para una futura pasada.
 *
 * `pedidos` replica ROLES_ADMIN de pedidos.js (handler principal,
 * crearPedidoAdminHandler y handleDevolucionesAdmin — las 3 usaban la
 * misma constante) — un único gate ('acceder'). Caso especial: en el
 * original `ROLES_ADMIN` era `export const` y `lib/asistente-tools.js`
 * la reimportaba (`ROLES_ADMIN as ROLES_PEDIDO`) para restringir por rol
 * la tool `crear_pedido` del asistente — mayor blast radius que un gate
 * interno. Para no romper ese import ni duplicar la lista de roles en
 * dos lugares, pedidos.js sigue exportando `ROLES_ADMIN`, pero ahora
 * como `rolesDe('pedidos', 'acceder')` (ver más abajo) — la tabla acá
 * sigue siendo la única fuente de verdad, pedidos.js solo la reexporta.
 * El propio handler de pedidos.js, en cambio, usa `puede()` directo
 * (no el array reexportado) para los 3 gates internos.
 *
 * `presupuestos` replica ROLES_ADMIN_PRES de pedidos.js
 * (handlePresupuestos) — mismo caso que `pedidos`: era `export const`
 * y `asistente-tools.js` la reimporta (`ROLES_ADMIN_PRES as
 * ROLES_PRESUPUESTO`) para la tool `crear_presupuesto`. También sigue
 * reexportada desde pedidos.js vía `rolesDe('presupuestos', 'acceder')`.
 * El handler también admite acceso de solo-lectura a rol `cliente`
 * (`esCliente`, literal, mismo criterio que `facturas`).
 *
 * `remitos` replica ROLES_PERMITIDOS de la sección "Remito NRO" de
 * pedidos.js (`_svc=remito-nro`) — constante local (no exportada), un
 * único gate ('acceder') para reservar el próximo número de remito.
 *
 * `pedidos_chofer` replica ROLES_CHOFER de la sección "Portal del
 * chofer" de pedidos.js (`_svc=chofer`) — constante local (no
 * exportada), un único gate ('acceder') para todo el portal PWA de
 * entrega. Dentro de esa misma función hay un segundo chequeo,
 * `['dueno','admin'].includes(perfil.rol)` (variable local `esAdmin`,
 * inline sin nombre) que decide si el admin puede operar sobre pedidos
 * de CUALQUIER chofer o solo los propios — no es un gate de acceso al
 * endpoint sino una regla de "dueño del dato", igual que `esCliente` en
 * `facturas`/`presupuestos`: se deja tal cual, fuera de esta tabla.
 *
 * `pos` replica las 5 constantes de pos.js — el último módulo con
 * `ROLES_*` sueltos, cierra la sección 2 completa. Ninguna se
 * reexporta ni se importa desde otro archivo (autocontenido, a
 * diferencia de `pedidos`/`presupuestos`), así que no hizo falta
 * `rolesDe()` acá. 5 acciones, cada una replica una constante:
 *   - `vender` ← ROLES_VENTA (abrir/cerrar turno, buscar productos,
 *     registrar venta, favoritos de lectura, movimiento de caja,
 *     reporte Z, cliente rápido, promociones de lectura, alerta de
 *     stock — el gate más amplio, 10 sitios).
 *   - `transferir` ← ROLES_TRANSFERIR (listar depósitos, transferir
 *     stock entre depósitos).
 *   - `anular` ← ROLES_ANULAR (anular venta, listado de ventas para
 *     anular, historial de transferencias, alta/baja de favorito,
 *     promociones de escritura/devoluciones, filtro `soloActivas` de
 *     promociones — mismo valor que `facturar`/`administrar_cajas`
 *     mas se preserva como acción separada porque en el original eran
 *     3 constantes con nombre distinto, protegiendo endpoints
 *     distintos, no una redundancia a simplificar de paso, mismo
 *     criterio que `escribir`/`pagar` en `cc_proveedores`).
 *   - `facturar` ← ROLES_FACTURAR (emitir comprobante AFIP desde POS,
 *     config de hardware fiscal, config de PIN de supervisor).
 *   - `administrar_cajas` ← ROLES_ADMIN_CAJAS (forzar cierre de turno
 *     ajeno, historial de turnos, ABM de cajas, log de movimientos de
 *     caja, umbral de cajero) — incluye el flag informativo
 *     `puede_forzar_cierre` devuelto en `/caja-estado` (antes
 *     `ROLES_ADMIN_CAJAS.includes(...)` suelto en la respuesta, ahora
 *     `puede(perfil, 'administrar_cajas', 'pos')`, mismo valor).
 */
const REGLAS = {
  reglas_automatizacion: {
    leer: ['dueno', 'admin'],
    escribir: ['dueno', 'admin'],
  },
  tareas_automatizacion: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    completar: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
  },
  export_contable: {
    acceder: ['dueno', 'admin', 'contador'],
    configurar: ['dueno', 'admin'],
  },
  importar: {
    cargar: ['dueno', 'admin'],
  },
  bcra: {
    consultar: ['dueno', 'admin', 'contador'],
  },
  busqueda: {
    buscar: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
  },
  ciclos: {
    acceder: ['dueno', 'admin', 'vendedor'],
  },
  admin_dashboard: {
    acceder: ['dueno', 'admin', 'vendedor', 'contador'],
  },
  auto_imagenes: {
    ejecutar: ['dueno', 'admin'],
  },
  clientes: {
    acceder: ['dueno', 'admin', 'vendedor'],
  },
  clientes_fuga: {
    // Fase 3 de PLAN_CLIENTES_EN_FUGA.md: mismo criterio de acceso que
    // 'clientes' — el vendedor ve la pantalla (filtrada a lo suyo con
    // "solo lo mío"), dueño/admin auditan la de toda la empresa.
    leer: ['dueno', 'admin', 'vendedor'],
  },
  captura_competencia: {
    // Fase 1 (PLAN_CAPTURA_COMPETENCIA.md): captura y cierre en el mostrador
    // los hace el vendedor de campo; dueno/admin pueden auditar/revisar
    // cualquier captura de la empresa.
    crear: ['dueno', 'admin', 'vendedor'],
    leer: ['dueno', 'admin', 'vendedor'],
    confirmar: ['dueno', 'admin', 'vendedor'],
    convertir: ['dueno', 'admin', 'vendedor'],
  },
  prospectos_competencia: {
    // Fase 3 (PLAN_CAPTURA_COMPETENCIA.md, Capa 1 — prospección
    // geográfica): mismos roles que captura_competencia — es la misma
    // iniciativa, el vendedor carga y gestiona sus propios prospectos,
    // dueno/admin auditan la bandeja completa de la empresa.
    crear: ['dueno', 'admin', 'vendedor'],
    leer: ['dueno', 'admin', 'vendedor'],
    confirmar: ['dueno', 'admin', 'vendedor'],
  },
  empresa_config: {
    acceder: ['dueno', 'admin'],
  },
  reglas_precio: {
    leer: ['dueno', 'admin', 'contador', 'vendedor'],
    escribir: ['dueno', 'admin', 'contador'],
  },
  maestros: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin'],
  },
  // Banco de códigos de barras compartido entre empresas (440) — mismos
  // roles que pueden dar de alta/editar productos (ver nav-data.js,
  // sección "Depósito" → Productos), porque es ahí donde se consulta y
  // se aporta este dato.
  banco_codigos_producto: {
    leer:     ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin', 'depositero'],
  },
  conciliacion_bancaria: {
    leer: ['dueno', 'admin', 'contador', 'vendedor'],
    escribir: ['dueno', 'admin', 'contador'],
  },
  cc_proveedores: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin', 'contador'],
    pagar: ['dueno', 'admin', 'contador'],
  },
  stock: {
    acceder: ['dueno', 'admin', 'vendedor', 'depositero'],
  },
  // Generador de etiquetas de precio/código de barras, Etapa 2 (543) —
  // POST /api/etiquetas/productos (armar la vista previa/impresión sobre
  // la selección real del listado). Mismo criterio que `stock`: cualquier
  // rol que puede ver existencias/depósito puede imprimir etiquetas para
  // ir a pegarlas en góndola. La config del formato de etiqueta (Admin →
  // Hardware) sigue gateada aparte por `empresa_config` (solo dueño/admin,
  // ver lib/handlers/etiquetas.js) — este gate es solo para operar el
  // listado, no para tocar la configuración.
  etiquetas_productos: {
    acceder: ['dueno', 'admin', 'vendedor', 'depositero'],
  },
  stock_lotes: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin', 'depositero'],
  },
  facturas: {
    acceder: ['dueno', 'admin', 'contador'],
  },
  gastos_generales: {
    leer: ['dueno', 'admin', 'contador'],
    escribir: ['dueno', 'admin', 'contador'],
  },
  notas_credito: {
    leer: ['dueno', 'admin', 'vendedor', 'contador'],
    escribir: ['dueno', 'admin'],
  },
  comprobantes_historicos: {
    acceder: ['dueno', 'admin', 'contador'],
  },
  proveedores: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin'],
  },
  compras: {
    leer: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
    escribir: ['dueno', 'admin', 'depositero'],
  },
  comparador_precios: {
    leer: ['dueno', 'admin', 'depositero', 'contador'],
  },
  // `whatsapp_template` — gate nuevo (auditoría v960): whatsappHandler
  // (_svc=whatsapp, envío de templates aprobados desde pedidos.js/
  // rutas.js) no tenía ningún control de acceso. Mismo set de roles que
  // `whatsapp_panel` porque son los mismos que hoy disparan estos envíos
  // desde el admin (confirmación/despacho/entrega de pedidos, aviso de
  // ruta al chofer).
  whatsapp_template: {
    enviar: ['dueno', 'admin', 'vendedor'],
  },
  whatsapp_panel: {
    gestionar: ['dueno', 'admin', 'vendedor'],
  },
  whatsapp_onboarding: {
    conectar: ['dueno', 'admin'],
    desconectar: ['dueno', 'admin'],
  },
  notif_estado_cuenta: {
    enviar: ['dueno', 'admin', 'contador', 'vendedor'],
  },
  pedidos: {
    acceder: ['dueno', 'admin', 'vendedor', 'depositero', 'contador'],
  },
  devoluciones: {
    leer:     ['dueno', 'admin', 'contador'],
    crear:    ['dueno', 'admin', 'contador'],
    editar:   ['dueno', 'admin', 'contador'],
    eliminar: ['dueno', 'admin'],
    revisar:  ['dueno', 'admin', 'contador'],
  },
  presupuestos: {
    acceder: ['dueno', 'admin', 'vendedor', 'contador'],
  },
  remitos: {
    acceder: ['dueno', 'admin', 'vendedor', 'depositero', 'chofer', 'contador'],
  },
  pedidos_chofer: {
    acceder: ['chofer', 'dueno', 'admin'],
  },
  pos: {
    vender: ['dueno', 'admin', 'vendedor'],
    transferir: ['dueno', 'admin', 'depositero'],
    anular: ['dueno', 'admin'],
    facturar: ['dueno', 'admin'],
    administrar_cajas: ['dueno', 'admin'],
  },
};

/**
 * true si `perfil.rol` puede hacer `accion` sobre `recurso`.
 *
 * Lanza (fail-closed, no devuelve `false` en silencio) si `recurso` o
 * `accion` no están dados de alta en la tabla — un typo en el nombre no
 * debe traducirse en "sin permiso" indistinguible de un 403 legítimo,
 * tiene que reventar en desarrollo/tests, no en producción con un 403
 * silencioso y difícil de diagnosticar.
 */
export function puede(perfil, accion, recurso) {
  const reglasRecurso = REGLAS[recurso];
  if (!reglasRecurso) {
    throw new Error(`[PermisosService] recurso desconocido: "${recurso}"`);
  }

  const rolesPermitidos = reglasRecurso[accion];
  if (!rolesPermitidos) {
    throw new Error(`[PermisosService] acción desconocida "${accion}" para el recurso "${recurso}"`);
  }

  return rolesPermitidos.includes(perfil?.rol);
}

/**
 * Devuelve el array de roles permitidos para `accion` sobre `recurso`,
 * tal cual está en la tabla — para los casos donde un handler necesita
 * reexportar la lista de roles como valor (no solo evaluar `puede()`),
 * típicamente porque otro archivo la reimporta (ver `pedidos` y
 * `presupuestos` más arriba: `asistente-tools.js` reimporta
 * `ROLES_ADMIN`/`ROLES_ADMIN_PRES` con alias). Mismo fail-closed que
 * `puede()`: revienta si el recurso/acción no existen, en vez de
 * devolver `undefined` en silencio. Devuelve el array de la tabla
 * directamente (no una copia): es de solo lectura por convención
 * (config estática), igual que el resto de REGLAS.
 */
export function rolesDe(recurso, accion) {
  const reglasRecurso = REGLAS[recurso];
  if (!reglasRecurso) {
    throw new Error(`[PermisosService] recurso desconocido: "${recurso}"`);
  }

  const rolesPermitidos = reglasRecurso[accion];
  if (!rolesPermitidos) {
    throw new Error(`[PermisosService] acción desconocida "${accion}" para el recurso "${recurso}"`);
  }

  return rolesPermitidos;
}
