// frontend/admin/js/migracion.js
// Wizard de migración asistida de clientes/productos.
// Pasos: elegir entidad -> subir archivo -> mapear columnas -> revisar -> confirmar.
// El parseo del archivo es 100% client-side (SheetJS/PapaParse); todo el resto
// vive en staging server-side hasta el paso final (POST /api/migracion?accion=confirmar).

'use strict';

const ETIQUETAS_CAMPO = {
  razon_social:   'Razón social',
  cuit:           'CUIT',
  telefono:       'Teléfono',
  email:          'Email',
  domicilio:      'Domicilio',
  localidad:      'Localidad',
  limite_credito: 'Límite de crédito',
  saldo_inicial:  'Saldo inicial (cta. cte.)',
  zona:           'Zona / ruta',
  condicion_iva:  'Condición de IVA',
  lista_precios:  'Lista de precios',
  vendedor:       'Vendedor asignado',
  nombre:         'Nombre',
  codigo:         'Código',
  precio:         'Precio',
  stock:          'Stock',
  categoria:      'Categoría',
  proveedor:      'Proveedor',
  codigo_barras:  'Es código de barras',
  iva:            'IVA (%)',
  unidad:         'Unidad de medida',
  deposito:       'Depósito (por fila)',
  lista_precio:   'Lista de precios (por fila)',
  numero_pedido:  'Número de pedido',
  cliente_cuit:   'CUIT del cliente',
  producto_codigo:'Código de producto',
  cantidad:       'Cantidad',
  precio_unitario:'Precio unitario',
  estado:         'Estado del pedido',
  // Migración 160/161: cta_cte (histórico de cuenta corriente).
  fecha:              'Fecha del movimiento',
  monto:              'Monto (con signo o sin signo)',
  tipo:               'Tipo de movimiento',
  debe:               'Debe',
  haber:              'Haber',
  numero_comprobante: 'N° de comprobante',
  descripcion:        'Descripción / notas',
  // Migración 162: precios especiales por cliente.
  notas:              'Notas (opcional)',
  // Migración 164: proveedores como maestro propio.
  nombre_fantasia:    'Nombre de fantasía',
  contacto:           'Persona de contacto',
  dias_pago:          'Días de pago',
  // Punto 5 del plan (P1): órdenes de compra y pagos a proveedores históricos.
  numero_orden:        'Número de orden',
  proveedor_cuit:      'CUIT del proveedor',
  proveedor_razon_social: 'Razón social del proveedor',
  fecha_pedido:        'Fecha del pedido',
  fecha_recepcion:     'Fecha de recepción',
  fecha_pago:          'Fecha de pago',
  medio_pago:          'Medio de pago',
  referencia:          'Referencia / comprobante',
  // Migración 172: lotes / FEFO históricos.
  numero_lote:         'Número de lote',
  costo_unitario:      'Costo unitario',
  fecha_fabricacion:   'Fecha de fabricación',
  fecha_vencimiento:   'Fecha de vencimiento',
  estado_lote:         'Estado del lote',
  // Migración 173 (punto 7 del plan): categorías/depósitos/listas/zonas
  // como entidades propias. 'nombre', 'descripcion' y 'notas' ya están
  // definidos arriba y se reutilizan tal cual.
  orden:               'Orden de visualización',
  direccion:           'Dirección',
  responsable:         'Responsable',
  es_principal:        '¿Es el depósito principal?',
  es_default:          '¿Es la lista de precios por defecto?',
  dias_reparto:        'Días de reparto (ej: lunes, miércoles y viernes)',
  // Migración 174 (plan P2, puntos 10-14): cheques, puntos de fidelización
  // y ventas POS históricas. cliente_cuit/cantidad/estado/fecha/notas ya
  // están definidos arriba y se reutilizan tal cual.
  banco:               'Banco',
  numero:              'Número de cheque',
  fecha_vto:           'Fecha de vencimiento',
  motivo:              'Motivo del movimiento',
  numero_venta:        'Número de venta',
  descuento_pct:       'Descuento (%)',
  // Migración 177 (cierre gap crítico 1): comprobantes fiscales históricos.
  // fecha/monto/cliente_cuit/tipo ya están definidos arriba y se reutilizan.
  numero_original:    'Número del comprobante original',
  moneda:              'Moneda (ARS/USD/etc, default ARS)',
  observaciones:        'Observaciones',
  // Migración 179 (cierre punto 18 del plan): direcciones de entrega bulk.
  // domicilio/localidad/notas/cliente_cuit ya están definidos arriba.
  etiqueta:            'Etiqueta (ej: Depósito, Sucursal — default "Principal")',
  provincia:           'Provincia',
  lat:                 'Latitud (opcional)',
  lng:                 'Longitud (opcional)',
};

// Campos opcionales que se resuelven (y crean si hace falta) por nombre
// dentro de la empresa, igual que cuando se cargan a mano desde el admin.
// Sirve para mostrar una aclaración en la UI de mapeo (migración 154).
// Migración 157/158: "deposito" y "lista_precio" se suman acá — si la fila
// trae un valor que no existe, se crea, igual que categoría/proveedor/zona.
const CAMPOS_AUTOCREABLES = new Set(['zona', 'lista_precios', 'categoria', 'proveedor', 'deposito', 'lista_precio']);
// El vendedor nunca se autocrea (es una cuenta de usuario con login): si no
// matchea, la fila igual se importa pero queda sin vendedor asignado.
// Migración 159: cliente_cuit/producto_codigo (pedidos) tampoco se autocrean
// — si no matchean, la fila queda inválida (a diferencia de vendedor).
// Punto 5 del plan (P1): proveedor_cuit/proveedor_razon_social (órdenes de
// compra y pagos a proveedores) tampoco se autocrean — el proveedor tiene
// que existir ya (migrado como entidad propia primero).
const CAMPOS_SOLO_MATCH = new Set(['vendedor', 'cliente_cuit', 'producto_codigo', 'proveedor_cuit', 'proveedor_razon_social']);

// Migración 384: campos requeridos con dedupe propio que el backend puede
// autogenerar cuando el archivo de origen no trae esa columna (hoy: código
// de producto). Debe coincidir con CAMPOS_AUTOGENERABLES del backend
// (lib/handlers/migracion.js) — mismo sentinel, misma lista de campos.
const CAMPOS_AUTOGENERABLES = {
  productos: new Set(['codigo']),
};
const SENTINEL_AUTOGENERAR = '__AUTOGENERAR__';

let estado = {
  entidad: null,
  sesionId: null,
  columnasDetectadas: [],
  camposDisponibles: [],
  camposRequeridos: [],
  filas: [],          // filas crudas parseadas del archivo (para preview local)
  resumen: null,
  filasRevision: [],   // filas devueltas por el server tras mapear
  filtroActual: 'todas',
  depositos: [],        // solo productos (migración 156)
  listasPrecios: [],    // solo productos (migración 156)
  ultimoErrores: 0,     // errores del último confirmar, para mostrar "Reintentar fallidas"
  plantillasMapeo: [],  // punto 9 del plan: plantillas de mapeo guardadas para esta entidad
  ultimoResultado: null,       // punto 11 del plan: {creados, actualizados, errores} para el informe descargable
  ultimasAdvertencias: [],     // punto 11 del plan: advertencias de la última confirmación, para el informe
  mapeoConfirmado: null,       // corrección punto 1 (sincronización): mapeo field→columna que se confirmó, para calcular qué columnas del archivo quedaron sin destino
};

// ─── Llamadas a la API ───────────────────────────────────────────────────────
async function migApi(url, options = {}) {
  await window.authReady;
  const token = window.authCtx?.session?.access_token;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `Error HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ─── Navegación entre pasos ──────────────────────────────────────────────────
function mostrarPaso(id) {
  document.querySelectorAll('.mig-paso').forEach(s => s.style.display = 'none');
  document.getElementById(id).style.display = '';
}

function volverAInicio() {
  estado = {
    entidad: null, sesionId: null, columnasDetectadas: [], camposDisponibles: [], camposRequeridos: [],
    filas: [], resumen: null, filasRevision: [], filtroActual: 'todas',
    depositos: [], listasPrecios: [], ultimoErrores: 0, plantillasMapeo: [],
    ultimoResultado: null, ultimasAdvertencias: [], mapeoConfirmado: null,
  };
  document.getElementById('input-archivo').value = '';
  mostrarPaso('paso-inicio');
  cargarSesionesRecientes();
}

function elegirEntidad(entidad) {
  estado.entidad = entidad;
  const titulos = {
    clientes: 'Subir archivo de clientes',
    productos: 'Subir archivo de productos',
    pedidos: 'Subir archivo de pedidos abiertos',
    cta_cte: 'Subir archivo de histórico de cuenta corriente',
    precios_clientes: 'Subir archivo de precios especiales por cliente',
    proveedores: 'Subir archivo de proveedores',
    ordenes_compra: 'Subir archivo de órdenes de compra históricas',
    pagos_proveedores: 'Subir archivo de pagos a proveedores históricos',
    lotes: 'Subir archivo de lotes / vencimientos (FEFO)',
    categorias: 'Subir archivo de categorías',
    depositos: 'Subir archivo de depósitos',
    listas_precios: 'Subir archivo de listas de precios',
    zonas: 'Subir archivo de zonas / rutas de reparto',
    cheques: 'Subir archivo de cheques históricos',
    puntos_fidelizacion: 'Subir archivo de puntos de fidelización históricos',
    ventas_pos: 'Subir archivo de ventas POS históricas',
    comprobantes_historicos: 'Subir archivo de comprobantes fiscales históricos',
    direcciones: 'Subir archivo de direcciones de entrega',
  };
  document.getElementById('titulo-subir').textContent = titulos[entidad] || 'Subir archivo';
  mostrarPaso('paso-subir');
}

// Punto 9 del plan de migraciones: plantilla de columnas descargable ANTES
// de subir ningún archivo — usa GET ?accion=campos, que no depende de que
// exista una sesión (a diferencia de camposDisponibles/camposRequeridos en
// `estado`, que solo se llenan después de crear la sesión en el paso 2).
async function descargarPlantillaColumnas() {
  const btn = document.getElementById('btn-descargar-plantilla');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generando...';

  try {
    if (!window.XLSX) throw new Error('SheetJS no disponible');
    if (!estado.entidad) throw new Error('Elegí primero qué vas a migrar');

    const data = await migApi(`/api/migracion?accion=campos&entidad=${estado.entidad}`);
    const campos = data.campos_disponibles || [];
    const requeridos = new Set(data.campos_requeridos || []);

    // Fila de encabezados con los campos marcados como obligatorios (*), más
    // una fila de ejemplo comentada para que quede claro el formato esperado
    // sin que la persona tenga que borrarla antes de pegar sus datos reales.
    const encabezados = campos.map(c => (ETIQUETAS_CAMPO[c] || c) + (requeridos.has(c) ? ' *' : ''));
    const hoja = window.XLSX.utils.aoa_to_sheet([encabezados]);
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, 'Plantilla');

    window.XLSX.writeFile(libro, `plantilla_${estado.entidad}.xlsx`);
  } catch (err) {
    console.error('[migracion] generar plantilla:', err);
    window.toast?.('No se pudo generar la plantilla', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

// Punto 11 del plan (P2): informe de migración descargable al terminar.
// Arma un Excel con 2 hojas a partir de datos que ya están en `estado`
// (ultimoResultado/ultimasAdvertencias, cargados por mostrarResultado) — no
// hace ningún request nuevo, es una exportación local de lo ya mostrado.
async function descargarInformeMigracion() {
  try {
    if (!window.XLSX) throw new Error('SheetJS no disponible');
    if (!estado.entidad || !estado.ultimoResultado) throw new Error('No hay un resultado de migración para exportar todavía');

    const r = estado.ultimoResultado;
    const advertencias = estado.ultimasAdvertencias || [];

    const hojaResumen = window.XLSX.utils.aoa_to_sheet([
      ['Informe de migración'],
      ['Entidad', estado.entidad],
      ['Fecha', new Date().toLocaleString('es-AR')],
      [],
      ['Creados', r.creados ?? 0],
      ['Actualizados', r.actualizados ?? 0],
      ['Con error', r.errores ?? 0],
      ['Advertencias', advertencias.length],
    ]);

    const filasAdvertencias = advertencias.length
      ? [['Fila', 'Mensaje'], ...filasSeguras(advertencias.map(a => [a.fila_numero ?? '', a.mensaje ?? '']))]
      : [['Fila', 'Mensaje'], ['—', 'Sin advertencias']];
    const hojaDetalle = window.XLSX.utils.aoa_to_sheet(filasAdvertencias);

    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hojaResumen, 'Resumen');
    window.XLSX.utils.book_append_sheet(libro, hojaDetalle, 'Advertencias');

    window.XLSX.writeFile(libro, `informe_migracion_${estado.entidad}_${Date.now()}.xlsx`);
  } catch (err) {
    console.error('[migracion] generar informe:', err);
    window.toast?.('No se pudo generar el informe', 'error');
  }
}

// ─── Item 4: checklist guiado de migración ───────────────────────────────────
// Orden recomendado: clientes/productos primero porque pedidos, cta_cte y
// precios_clientes resuelven cliente/producto contra tablas reales al mapear
// (mapearSesionPedidos/CtaCte/PreciosClientes) — si todavía no existen, esas
// filas quedan con error "cliente/producto no encontrado". No es una regla
// dura (por eso "requiere" solo se usa para mostrar un aviso, nunca bloquea).
// REQ-MIG-MAPEO (v194): cada entrada ahora incluye `url_admin` (pantalla
// exacta donde ver los datos tras la migración) y `nota_pantalla` (texto
// aclaratorio cuando no hay página dedicada 1:1).
// Este es el mapeo verificado de las 18 entidades migrables.
const ORDEN_GUIADO = [
  // ── Entidades de configuración (prerequisitos para clientes/productos) ───
  // Migración 173 (punto 7 del plan) / Gap crítico 3: van primero porque
  // clientes/productos las referencian por nombre (zona, lista de precios,
  // categoría, depósito). No es obligatorio migrarlas antes — si no existen
  // se autocrean igual con solo el nombre — pero si el sistema origen tiene
  // atributos reales (dirección de depósito, días de reparto de zona, etc.)
  // conviene cargarlos acá para no perderlos.
  {
    entidad: 'categorias',
    titulo: 'Categorías',
    desc: 'Categorías de productos, con orden y descripción.',
    requiere: [],
    url_admin: '/admin/productos',
    nota_pantalla: 'Visibles en el catálogo de productos: selector "Categoría" al crear/editar un producto.',
  },
  {
    entidad: 'depositos',
    titulo: 'Depósitos',
    desc: 'Depósitos/sucursales con dirección y responsable.',
    requiere: [],
    url_admin: '/admin/stock',
    nota_pantalla: 'Visibles en Stock → selector de depósito y en Cajas al asociar una caja.',
  },
  {
    entidad: 'listas_precios',
    titulo: 'Listas de precios',
    desc: 'Listas de precios que después se asignan a clientes/productos.',
    requiere: [],
    url_admin: '/admin/clientes',
    nota_pantalla: 'Visibles en la ficha de cada Cliente (campo "Lista de precios") y en productos.',
  },
  {
    entidad: 'zonas',
    titulo: 'Zonas / rutas de reparto',
    desc: 'Zonas con sus días de reparto.',
    requiere: [],
    url_admin: '/admin/rutas',
    nota_pantalla: 'Visibles en Repartos y en la ficha de cada Cliente (campo "Zona").',
  },
  // ── Entidades principales ────────────────────────────────────────────────
  {
    entidad: 'clientes',
    titulo: 'Clientes',
    desc: 'Base de clientes: CUIT, contacto, condición de IVA, límite de crédito.',
    requiere: [],
    url_admin: '/admin/clientes',
    nota_pantalla: 'Pantalla dedicada: Ventas → Clientes. Lista completa con filtros.',
  },
  {
    entidad: 'productos',
    titulo: 'Productos',
    desc: 'Catálogo con precios, stock y depósito.',
    requiere: [],
    url_admin: '/admin/productos',
    nota_pantalla: 'Pantalla dedicada: Depósito → Productos. Catálogo con precios y stock.',
  },
  // Migración 172 (plan P2, punto 10): va después de productos porque
  // resuelve el producto por código al mapear (mapearSesionLotes) — no
  // toca el stock agregado, solo trazabilidad de vencimientos (FEFO).
  {
    entidad: 'lotes',
    titulo: 'Lotes / vencimientos (FEFO)',
    desc: 'Lotes con fecha de vencimiento para trazabilidad, no da de alta stock.',
    requiere: ['productos'],
    url_admin: '/admin/stock',
    nota_pantalla: 'Visibles en Stock → sección Lotes/FEFO por producto. No modifica el stock total.',
  },
  {
    entidad: 'precios_clientes',
    titulo: 'Precios especiales por cliente',
    desc: 'Precios puntuales que reemplazan a la lista general.',
    requiere: ['clientes', 'productos'],
    url_admin: '/admin/clientes',
    nota_pantalla: 'Visibles en la ficha de cada Cliente → pestaña/sección "Precios especiales". Sin página global propia.',
  },
  {
    entidad: 'pedidos',
    titulo: 'Pedidos abiertos',
    desc: 'Pedidos que todavía no se entregaron o facturaron.',
    requiere: ['clientes', 'productos'],
    url_admin: '/admin/pedidos',
    nota_pantalla: 'Pantalla dedicada: Ventas → Pedidos y presupuestos.',
  },
  {
    entidad: 'cta_cte',
    titulo: 'Histórico de cuenta corriente',
    desc: 'Movimientos previos de cuenta corriente por cliente.',
    requiere: ['clientes'],
    url_admin: '/admin/cta-cte',
    nota_pantalla: 'Pantalla dedicada: Finanzas → Cuenta Corriente. Filtrable por cliente.',
  },
  {
    entidad: 'proveedores',
    titulo: 'Proveedores',
    desc: 'Maestro de proveedores para compras y depósitos.',
    requiere: [],
    url_admin: '/admin/compras',
    nota_pantalla: 'Visibles en Compras → sección Proveedores. También referenciados en CC-Proveedores.',
  },
  // Punto 5 del plan (P1): van después de proveedores/productos porque
  // resuelven ambos al mapear (mapearSesionOrdenesCompra/PagosProveedores).
  {
    entidad: 'ordenes_compra',
    titulo: 'Órdenes de compra históricas',
    desc: 'Órdenes de compra pasadas, con sus líneas de producto.',
    requiere: ['proveedores', 'productos'],
    url_admin: '/admin/compras',
    nota_pantalla: 'Visibles en Compras → tabla de órdenes. Acceso global desde Depósito → Compras.',
  },
  {
    entidad: 'pagos_proveedores',
    titulo: 'Pagos a proveedores históricos',
    desc: 'Pagos ya realizados a proveedores.',
    requiere: ['proveedores'],
    url_admin: '/admin/cc-proveedores',
    nota_pantalla: 'Visibles en Finanzas → CC-Proveedores, filtrados por proveedor.',
  },
  // Migración 174 (plan P2, puntos 10-14): cierre del wizard. cheques y
  // puntos_fidelizacion sugieren clientes primero (cliente es opcional en
  // cheques, pero obligatorio en puntos); ventas_pos sugiere productos
  // (obligatorio) y clientes (opcional, venta de mostrador).
  {
    entidad: 'cheques',
    titulo: 'Cheques históricos',
    desc: 'Cheques recibidos, en cartera o ya aplicados.',
    requiere: ['clientes'],
    url_admin: '/admin/cheques',
    nota_pantalla: 'Pantalla dedicada: Finanzas → Cheques. Filtrable por estado y fecha.',
  },
  {
    entidad: 'puntos_fidelizacion',
    titulo: 'Puntos de fidelización históricos',
    desc: 'Movimientos de puntos ganados/canjeados por cliente.',
    requiere: ['clientes'],
    url_admin: '/admin/fidelizacion',
    nota_pantalla: 'Pantalla dedicada: Ventas → Fidelización. Historial por cliente.',
  },
  {
    entidad: 'ventas_pos',
    titulo: 'Ventas POS históricas',
    desc: 'Ventas de mostrador ya cerradas, para reportes de rentabilidad.',
    requiere: ['productos'],
    url_admin: '/admin/pos',
    nota_pantalla: 'Sin pantalla de historial global dedicada. Visibles en reportes de rentabilidad. Para consultar ventas históricas individuales, ir al historial de cierres de caja.',
    es_gap: true,
  },
  // Migración 177 (cierre gap crítico 1): comprobantes fiscales históricos
  // (facturas y notas de crédito/débito previas a la migración). Puramente
  // informativo — no genera CAE ni movimientos de cta_cte, solo queda de
  // solo lectura en la ficha de cliente. Cliente es obligatorio (se resuelve
  // por CUIT, nunca se autocrea), por eso va después de clientes.
  {
    entidad: 'comprobantes_historicos',
    titulo: 'Comprobantes fiscales históricos',
    desc: 'Facturas y notas de crédito/débito previas a la migración (solo lectura).',
    requiere: ['clientes'],
    url_admin: '/admin/facturacion',
    nota_pantalla: 'Sin pantalla global dedicada. Visibles solo en la ficha de cada Cliente (pestaña "Comprobantes históricos"). Para consultar, buscar el cliente en Clientes y entrar a su ficha.',
    es_gap: true,
  },
  // Migración 179 (cierre punto 18 del plan): direcciones de entrega como
  // entidad bulk. Cliente obligatorio (se resuelve por CUIT, nunca se
  // autocrea), por eso va después de clientes, igual que comprobantes.
  {
    entidad: 'direcciones',
    titulo: 'Direcciones de entrega',
    desc: 'Direcciones adicionales de reparto por cliente (más allá del domicilio principal).',
    requiere: ['clientes'],
    url_admin: '/admin/clientes',
    nota_pantalla: 'Sin pantalla global dedicada. Visibles en la ficha de cada Cliente (sección "Direcciones de entrega"). Para verificar, buscar el cliente en Clientes y revisar sus direcciones.',
    es_gap: true,
  },
];

const CLASE_ESTADO_CK = { pendiente: 'ck-pendiente', en_progreso: 'ck-en-progreso', completado: 'ck-completado', error: 'ck-error' };
const ETIQUETA_ESTADO_CK = { pendiente: 'Pendiente', en_progreso: 'En progreso', completado: 'Completado', error: 'Con error' };
const BOTON_ESTADO_CK = {
  pendiente:   { texto: 'Empezar',          clase: 'btn--primary' },
  en_progreso: { texto: 'Seguir migrando',  clase: 'btn--primary' },
  completado:  { texto: 'Migrar de nuevo',  clase: 'btn--secondary' },
  error:       { texto: 'Reintentar',       clase: 'btn--primary' },
};

// La sesión más reciente de una entidad manda el estado del ítem del
// checklist. 'cancelado'/'deshecho' no dejaron nada aplicado de verdad, así
// que se tratan como pendiente (no como un intento fallido a resolver).
function estadoChecklist(sesion) {
  if (!sesion) return 'pendiente';
  if (sesion.estado === 'completado') return 'completado';
  if (sesion.estado === 'error') return 'error';
  if (['cancelado', 'deshecho'].includes(sesion.estado)) return 'pendiente';
  return 'en_progreso'; // subido, mapeando, validado, confirmando, deshaciendo
}

// `sesiones` viene ordenado por created_at desc (ver listarSesiones en el
// backend) — la primera sesión de cada entidad que aparece en el array es,
// por construcción, la más reciente.
function renderChecklist(sesiones) {
  const cont = document.getElementById('mig-checklist');
  const progCont = document.getElementById('mig-progreso-general');
  if (!cont) return;

  const ultimaPorEntidad = {};
  for (const s of sesiones) {
    if (!ultimaPorEntidad[s.entidad]) ultimaPorEntidad[s.entidad] = s;
  }

  const completadas = ORDEN_GUIADO.filter(e => ultimaPorEntidad[e.entidad]?.estado === 'completado').length;
  if (progCont) {
    const pct = Math.round((completadas / ORDEN_GUIADO.length) * 100);
    progCont.innerHTML = `
      <div class="mig-progreso-barra"><div class="mig-progreso-fill" style="width:${pct}%"></div></div>
      <span class="mig-progreso-texto">${completadas}/${ORDEN_GUIADO.length} migraciones completadas</span>
    `;
  }

  cont.innerHTML = ORDEN_GUIADO.map((item, idx) => {
    const sesion = ultimaPorEntidad[item.entidad];
    const st = estadoChecklist(sesion);
    const prereqsFaltantes = item.requiere.filter(r => ultimaPorEntidad[r]?.estado !== 'completado');
    // REQ-MIG-MAPEO: link a la pantalla admin correspondiente (solo al completar)
    const linkAdmin = (st === 'completado' && item.url_admin)
      ? `<a href="${item.url_admin}" class="mig-ck-link-admin" target="_blank" title="${escapeHtml(item.nota_pantalla || '')}">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
           Ver en admin
         </a>`
      : '';
    // Nota de pantalla (para gaps sin página dedicada)
    const notaPanel = (st === 'completado' && item.nota_pantalla && item.es_gap)
      ? `<span class="mig-ck-nota-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${escapeHtml(item.nota_pantalla)}</span>`
      : (st === 'completado' && item.nota_pantalla
          ? `<span class="mig-ck-nota-ok">${escapeHtml(item.nota_pantalla)}</span>`
          : '');
    const boton = BOTON_ESTADO_CK[st];

    return `
      <div class="mig-ck-item ${st === 'completado' ? 'ck-completo' : ''}">
        <div class="mig-ck-orden">${idx + 1}</div>
        <div class="mig-ck-info">
          <div class="mig-ck-titulo-row">
            <strong>${escapeHtml(item.titulo)}</strong>
            <span class="mig-estado-pill ${CLASE_ESTADO_CK[st]}">${ETIQUETA_ESTADO_CK[st]}</span>
          </div>
          <span class="mig-ck-desc">${escapeHtml(item.desc)}</span>
          ${prereqsFaltantes.length ? `<span class="mig-ck-prereq">Sugerido: migrar primero ${prereqsFaltantes.map(r => ORDEN_GUIADO.find(x => x.entidad === r)?.titulo || r).join(' y ')}</span>` : ''}
          ${notaPanel}
        </div>
        <div class="mig-ck-accion">
          <button type="button" class="btn ${boton.clase}" onclick="elegirEntidad('${item.entidad}')">${boton.texto}</button>
          ${linkAdmin}
        </div>
      </div>
    `;
  }).join('');
}

// ─── Paso 0: historial de sesiones ───────────────────────────────────────────
const HISTORIAL_SESIONES_POR_PAGINA = 7;
let paginaHistorialSesiones = 1;

async function cargarSesionesRecientes(pagina = paginaHistorialSesiones) {
  const cont = document.getElementById('lista-sesiones');
  paginaHistorialSesiones = Math.max(1, Number.parseInt(pagina, 10) || 1);

  try {
    const [data, resumen] = await Promise.all([
      migApi(`/api/migracion?page=${paginaHistorialSesiones}&limit=${HISTORIAL_SESIONES_POR_PAGINA}`),
      // El checklist necesita conocer la última sesión de cada entidad y no
      // debe quedar limitado a la página que el usuario está mirando.
      migApi('/api/migracion?limit=20'),
    ]);

    renderChecklist(resumen.sesiones || []);
    const sesiones = data.sesiones || [];
    const paginacion = data.paginacion || {};

    // Si se eliminó la última fila de la última página, volvemos a la página
    // anterior en lugar de dejar un estado vacío que parezca un error.
    if (!sesiones.length && paginaHistorialSesiones > 1 && paginacion.total_paginas < paginaHistorialSesiones) {
      paginaHistorialSesiones = paginacion.total_paginas;
      return cargarSesionesRecientes(paginaHistorialSesiones);
    }

    if (sesiones.length === 0) {
      cont.innerHTML = '<p class="mig-vacio">Todavía no hiciste ninguna migración.</p>';
      renderPaginacionSesiones(null);
      return;
    }

    cont.innerHTML = sesiones.map(s => `
      <div class="mig-sesion-row" data-sesion-id="${s.id}">
        <div class="mig-sesion-info">
          <strong>${escapeHtml(s.nombre_archivo_original || '(sin nombre)')}</strong>
          <span class="mig-sesion-meta">${s.entidad} · ${new Date(s.created_at).toLocaleString('es-AR')}</span>
        </div>
        <div class="mig-sesion-acciones">
          <span class="mig-estado-pill mig-estado-${s.estado}">${etiquetaEstado(s.estado)}</span>
          ${['completado', 'validado', 'confirmando', 'error'].includes(s.estado) ? `
            <button type="button" class="btn btn--ghost btn--sm"
                    onclick="verColumnasSinMapearHistorial('${s.id}', this)">
              Ver columnas sin usar
            </button>
          ` : ''}
          ${['completado', 'deshaciendo'].includes(s.estado) ? `
            <button type="button" class="btn btn--ghost btn--sm" data-sesion-id="${s.id}"
                    onclick="deshacerSesionHistorial('${s.id}', this)">
              ${s.estado === 'deshaciendo' ? 'Continuar deshaciendo' : 'Deshacer'}
            </button>
          ` : ''}
        </div>
      </div>
    `).join('');
    renderPaginacionSesiones(paginacion);
  } catch (err) {
    console.error('[migracion] cargar historial:', err);
    cont.innerHTML = `<p class="mig-vacio">No se pudo cargar el historial.</p>`;
    renderPaginacionSesiones(null);
  }
}

function renderPaginacionSesiones(paginacion) {
  const cont = document.getElementById('historial-sesiones-paginacion');
  if (!cont) return;

  const total = Number(paginacion?.total) || 0;
  const pagina = Number(paginacion?.pagina) || paginaHistorialSesiones;
  const porPagina = Number(paginacion?.por_pagina) || HISTORIAL_SESIONES_POR_PAGINA;
  const totalPaginas = Number(paginacion?.total_paginas) || 1;

  if (!total || totalPaginas <= 1) {
    cont.style.display = 'none';
    cont.innerHTML = '';
    return;
  }

  const inicio = (pagina - 1) * porPagina + 1;
  const fin = Math.min(pagina * porPagina, total);
  const numeros = [];
  for (let p = 1; p <= totalPaginas; p++) {
    if (p === 1 || p === totalPaginas || (p >= pagina - 1 && p <= pagina + 1)) {
      numeros.push(p);
    } else if (numeros[numeros.length - 1] !== '…') {
      numeros.push('…');
    }
  }

  cont.style.display = 'flex';
  cont.innerHTML = `
    <span class="mig-paginacion-info">${inicio.toLocaleString('es-AR')}–${fin.toLocaleString('es-AR')} de ${total.toLocaleString('es-AR')} sesiones</span>
    <div class="mig-paginacion-botones">
      <button type="button" class="btn btn--secondary btn--sm"
              ${pagina === 1 ? 'disabled' : ''}
              onclick="cambiarPaginaHistorial(${pagina - 1})">Anterior</button>
      ${numeros.map(p => p === '…'
        ? `<span class="mig-paginacion-elipsis">…</span>`
        : `<button type="button" class="mig-paginacion-num ${p === pagina ? 'activa' : ''}" aria-current="${p === pagina ? 'page' : 'false'}" onclick="cambiarPaginaHistorial(${p})">${p}</button>`
      ).join('')}
      <button type="button" class="btn btn--secondary btn--sm"
              ${pagina === totalPaginas ? 'disabled' : ''}
              onclick="cambiarPaginaHistorial(${pagina + 1})">Siguiente</button>
    </div>`;
}

function cambiarPaginaHistorial(pagina) {
  paginaHistorialSesiones = Math.max(1, pagina);
  cargarSesionesRecientes(paginaHistorialSesiones);
  document.getElementById('lista-sesiones')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function etiquetaEstado(estado) {
  const mapa = {
    subido: 'Subido', mapeado: 'Mapeado', validado: 'Listo para confirmar',
    confirmando: 'Confirmando...', completado: 'Completado', error: 'Error', cancelado: 'Cancelado',
    deshaciendo: 'Deshaciendo...', deshecho: 'Deshecho',
  };
  return mapa[estado] || estado;
}

// Sube el archivo completo (ya parseado client-side) en chunks de
// CHUNK_SUBIDA filas por request HTTP (migración 167, plan P0 item 3): antes
// se mandaba todo en un solo POST, y con archivos grandes eso corría el
// riesgo de superar el timeout de la función serverless en el backend
// (que a su vez insertaba en sub-lotes de a 1000, pero todo dentro de UN
// request). El primer request crea la sesión (sin sesion_id, manda
// total_filas para que el backend sepa cuánto falta); los siguientes solo
// agregan su chunk (con sesion_id + offset = filas ya mandadas antes).
// Devuelve la respuesta del último request (hay_mas=false, con columnas
// detectadas, campos disponibles, etc.) para que el wizard pase a mapear.
const CHUNK_SUBIDA = 5000;
async function subirArchivoEnChunks(entidad, nombreArchivo, filas, forzar, estadoDiv, hashContenido) {
  let sesionId = null;
  let offset = 0;

  while (offset < filas.length) {
    const chunk = filas.slice(offset, offset + CHUNK_SUBIDA);
    const body = sesionId
      ? { sesion_id: sesionId, filas: chunk, offset }
      : { entidad, nombre_archivo: nombreArchivo, filas: chunk, total_filas: filas.length, forzar, hash_contenido: hashContenido };

    const data = await migApi('/api/migracion?accion=crear', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    sesionId = data.sesion_id;
    offset += chunk.length;
    if (estadoDiv) {
      estadoDiv.textContent = `Subiendo… ${Math.min(offset, filas.length).toLocaleString('es-AR')} / ${filas.length.toLocaleString('es-AR')} filas`;
    }
    if (!data.hay_mas) return data;
  }
}

// ─── Paso 1: subir + parsear archivo ─────────────────────────────────────────
// Punto 8 del audit: hash SHA-256 del contenido crudo del archivo (antes de
// parsear), para que el backend pueda dedupear por contenido real y no solo
// por nombre+cantidad de filas (dos archivos con el mismo nombre pero
// distinto contenido, o el mismo contenido con otro nombre, se detectan
// igual). Se calcula client-side con Web Crypto, no hace falta subir nada
// extra para esto.
async function calcularHashArchivo(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function onArchivoElegido(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;

  const estadoDiv = document.getElementById('estado-carga');
  const avisoPdf = document.getElementById('aviso-pdf-ocr');
  if (avisoPdf) avisoPdf.style.display = 'none';

  // FIX (auditoría UX etapa 18, Hallazgo 3): el parseo de Excel/CSV es
  // síncrono y bloquea el hilo principal -- con archivos grandes (varios
  // cientos de miles de filas) el navegador puede quedar "congelado"
  // varios segundos sin ningún indicio de que sigue vivo. No resuelve el
  // freeze en sí (movería el parseo a un Web Worker, pendiente aparte),
  // pero al menos avisa antes de arrancar para que no se perciba como
  // que la pantalla se colgó.
  const MB = file.size / (1024 * 1024);
  estadoDiv.textContent = MB > 15
    ? `Leyendo archivo (${MB.toFixed(1)} MB)... puede tardar varios segundos, no cierres esta pestaña.`
    : 'Leyendo archivo...';
  // Deja pintar el mensaje antes de arrancar el parseo síncrono.
  await new Promise(resolve => setTimeout(resolve, 0));

  try {
    const ext = file.name.split('.').pop().toLowerCase();
    // Migración 384: antes acá se llamaba directo a un parser que ya asumía
    // "fila 0 = encabezados" (sheet_to_json/Papa.parse con header:true), sin
    // ninguna validación. Si el archivo no traía fila de encabezados (o la
    // tenía en otra posición), la primera fila de datos reales se perdía
    // silenciosamente como si fueran nombres de columna. Ahora se parsea
    // como matriz cruda primero, se corre una heurística, y SIEMPRE se
    // muestra una vista previa para que la persona confirme (o corrija)
    // antes de seguir al mapeo.
    let matriz;
    if (ext === 'csv') matriz = await parsearCSVCrudo(file);
    else if (ext === 'txt') matriz = await parsearTXTCrudo(file);
    else if (ext === 'pdf') matriz = await parsearPDFCrudo(file, estadoDiv);
    else if (ext === 'json') matriz = await parsearJSONCrudo(file);
    else if (ext === 'xml') matriz = await parsearXMLCrudo(file);
    else if (ext === 'dbf') matriz = await parsearDBFCrudo(file);
    else if (['png', 'jpg', 'jpeg'].includes(ext)) matriz = await parsearImagenCrudo(file, estadoDiv);
    // .xlsm (Excel con macros) usa el mismo contenedor OOXML que .xlsx —
    // SheetJS ya lo lee sin código adicional, cae acá igual que xls/xlsb/ods.
    else matriz = await parsearExcelCrudo(file);

    if (!matriz.length) throw new Error('El archivo no tiene filas de datos.');

    document.getElementById('estado-carga').textContent = '';
    const { tieneEncabezado, encabezados } = await mostrarPreviewEncabezado(matriz);
    document.getElementById('estado-carga').textContent = 'Leyendo archivo...';

    const filas = filasDesdeMatriz(matriz, tieneEncabezado, encabezados);
    if (!filas.length) throw new Error('El archivo no tiene filas de datos.');

    let hashContenido = null;
    try {
      hashContenido = await calcularHashArchivo(file);
    } catch {
      // Si Web Crypto no está disponible (contexto no seguro, navegador
      // viejo), seguimos sin hash: el backend cae al chequeo por
      // nombre+total_filas como antes.
    }

    let data;
    try {
      data = await subirArchivoEnChunks(estado.entidad, file.name, filas, false, estadoDiv, hashContenido);
    } catch (err) {
      // Item 1 del plan P0: si el backend detecta que este mismo archivo ya
      // se subió antes (mismo nombre + cantidad de filas, sesión no
      // descartada), avisa con 409 en vez de bloquear directo — dejamos que
      // la persona decida si igual quiere subirlo de nuevo (forzar: true).
      // Esto solo puede pasar en el primer request de la subida (donde se
      // crea la sesión), así que reintentamos el loop entero desde offset 0.
      if (err.status === 409 && err.data?.duplicado) {
        const detalle = (err.data.sesiones_previas || [])
          .map(s => `• ${new Date(s.created_at).toLocaleDateString('es-AR')} — estado: ${etiquetaEstado(s.estado)}`)
          .join('\n');
        // Si alguna de las sesiones previas quedó en 'error', puede tener
        // datos reales ya confirmados de lotes anteriores al que falló. Hoy
        // no hay forma de retomar esa sesión puntual desde la UI entre
        // recargas de página (el botón "Reintentar" del checklist solo abre
        // el asistente de subida desde cero) — así que la única opción real
        // es avisar del riesgo y dejar que la persona decida, no prometer un
        // "reintentar" que en los hechos no reanuda nada.
        const hayConError = (err.data.sesiones_previas || []).some(s => s.estado === 'error');
        const sugerencia = hayConError
          ? '\n\nAl menos una de esas sesiones quedó en estado "Error" a mitad de camino, lo que significa que puede tener datos ya creados (por ejemplo, algunos movimientos de cuenta corriente ya cargados). Si subís este archivo de nuevo y lo confirmás completo, esos datos podrían quedar duplicados. Si no estás segurx de qué se llegó a crear, revisá primero con el equipo antes de continuar.'
          : '';
        const confirmar = await window.confirmar(
          `${err.data.error}<br><br>${detalle}${sugerencia.replace(/\n\n/g, '<br><br>')}<br><br>¿Confirmás que igual querés subirlo como una migración nueva?`,
          { labelOk: 'Subir igual', labelCancel: 'Cancelar', tipo: 'danger' }
        );
        if (!confirmar) {
          estadoDiv.textContent = '';
          ev.target.value = '';
          return;
        }
        data = await subirArchivoEnChunks(estado.entidad, file.name, filas, true, estadoDiv, hashContenido);
      } else {
        throw err;
      }
    }

    estado.sesionId = data.sesion_id;
    estado.totalFilasArchivo = filas.length;
    estado.columnasDetectadas = data.columnas_detectadas;
    estado.camposDisponibles = data.campos_disponibles;
    estado.camposRequeridos = data.campos_requeridos;
    estado.depositos = data.depositos || [];
    estado.listasPrecios = data.listas_precios || [];

    estadoDiv.textContent = '';
    renderMapeo();
    renderDestinos();
    renderAyudaCtaCte();
    await renderPlantillasMapeo();
    mostrarPaso('paso-mapear');
  } catch (err) {
    estadoDiv.textContent = '';
    console.error('[migracion] leer archivo:', err);
    window.toast?.('No se pudo leer el archivo', 'error');
  }
}

// ─── Migración: carga perezosa de librerías pesadas (PDF/OCR) ────────────────
// pdf.js (~1MB) y Tesseract.js (~2-3MB + modelo de idioma) solo se necesitan
// si la persona efectivamente elige un .pdf — la gran mayoría sube CSV/Excel,
// así que iny ectarlas siempre en el <head> sería peso muerto para el caso
// común. Se cargan on-demand y se cachean en window para no reinyectar el
// <script> si se sube un segundo PDF en la misma sesión de navegación.
function cargarScriptUnaVez(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`No se pudo cargar ${src} (revisá la conexión)`));
    document.head.appendChild(s);
  });
}

async function cargarPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await cargarScriptUnaVez('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  return window.pdfjsLib;
}

async function cargarTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await cargarScriptUnaVez('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  return window.Tesseract;
}


let _resolverHojaElegida = null;

// Migración 384: devuelve la hoja como matriz cruda (array de arrays), SIN
// asumir que la fila 0 es encabezado — eso se decide después, con
// mostrarPreviewEncabezado(). blankrows:false descarta filas 100% vacías
// (separadores visuales que a veces deja Excel), igual que skipEmptyLines
// hacía antes en el flujo con header:true.
async function parsearExcelCrudo(file) {
  if (!window.XLSX) throw new Error('SheetJS no disponible');
  const data = await file.arrayBuffer();
  const wb = window.XLSX.read(data, { type: 'array' });

  if (wb.SheetNames.length <= 1) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  }

  // Varias hojas: mostramos el picker y esperamos a que la persona elija
  // antes de seguir (confirmarHojaElegida resuelve esta promesa).
  const select = document.getElementById('select-hoja');
  select.innerHTML = wb.SheetNames.map(nombre => `<option value="${escapeHtml(nombre)}">${escapeHtml(nombre)}</option>`).join('');
  document.getElementById('selector-hoja').style.display = '';
  document.getElementById('estado-carga').textContent = '';

  const nombreElegido = await new Promise(resolve => { _resolverHojaElegida = resolve; });

  document.getElementById('selector-hoja').style.display = 'none';
  const ws = wb.Sheets[nombreElegido];
  return window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
}

function confirmarHojaElegida() {
  const select = document.getElementById('select-hoja');
  if (_resolverHojaElegida) {
    document.getElementById('estado-carga').textContent = 'Leyendo archivo...';
    _resolverHojaElegida(select.value);
    _resolverHojaElegida = null;
  }
}

// Migración 384: mismo criterio que parsearExcelCrudo — matriz cruda, sin
// asumir encabezado. Papa.parse con header:false ya devuelve array de
// arrays directo.
async function parsearCSVCrudo(file) {
  if (!window.Papa) throw new Error('PapaParse no disponible');
  const texto = await leerTextoConFallbackEncoding(file);
  const result = window.Papa.parse(texto, { header: false, skipEmptyLines: true });
  return result.data;
}

// ─── Soporte .txt (texto plano, delimitado o de columnas fijas) ──────────────
// Los sistemas viejos (facturación DOS, exports de Tango) suelen tirar un
// .txt sin extensión CSV real: a veces delimitado (tab/; más común que coma,
// porque coma choca con decimales AR) y a veces "de columnas fijas" — texto
// alineado por posición de caracter, sin ningún separador, típico de
// reportes de impresora de sistemas de los 90s/2000s.
async function parsearTXTCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  const lineas = texto.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if (!lineas.length) return [];

  // 1) Delimitador consistente: se prueba en orden de probabilidad real en
  // estos archivos (tab y ; antes que coma, que puede ser parte de un
  // número "1.234,56" y daría falso positivo de "columna").
  const muestraDelim = lineas.slice(0, 20);
  for (const delim of ['\t', ';', '|', ',']) {
    const conteos = muestraDelim.map(l => l.split(delim).length);
    if (conteos[0] > 1 && conteos.every(c => c === conteos[0])) {
      return lineas.map(l => l.split(delim).map(c => c.trim()));
    }
  }

  // 2) Sin delimitador: columnas fijas por posición de caracter. Una
  // posición es "borde de columna" si es espacio en blanco en TODAS las
  // líneas de la muestra (una franja vertical de espacio que atraviesa el
  // archivo entero) — la técnica estándar para parsear texto alineado con
  // espacios en vez de un separador explícito.
  const muestra = lineas.slice(0, Math.min(50, lineas.length));
  const anchoMax = Math.max(...muestra.map(l => l.length));
  const espacioEnTodas = Array.from({ length: anchoMax }, (_, c) =>
    muestra.every(l => l[c] === undefined || l[c] === ' '));

  const cortes = [];
  let dentroDeEspacio = false;
  for (let c = 0; c < anchoMax; c++) {
    if (espacioEnTodas[c] && !dentroDeEspacio) { cortes.push(c); dentroDeEspacio = true; }
    if (!espacioEnTodas[c]) dentroDeEspacio = false;
  }

  if (cortes.length < 2) {
    // No se detectó ninguna estructura de columnas reconocible: mejor
    // devolver cada línea entera como una sola columna (para que la persona
    // la vea en la vista previa y decida) que perder el archivo.
    return lineas.map(l => [l]);
  }

  const bordes = [0, ...cortes, anchoMax];
  return lineas.map(l =>
    bordes.slice(0, -1).map((inicio, i) => l.slice(inicio, bordes[i + 1]).trim()));
}

// ─── Soporte .pdf (tabla con texto real, o escaneado vía OCR) ────────────────
// A diferencia de CSV/Excel, un PDF no tiene celdas — es texto posicionado
// en una página. Dos casos completamente distintos:
//  a) Tabla real (exportada de un sistema, texto seleccionable): se extrae
//     la capa de texto de pdf.js y se reconstruye la grilla agrupando por
//     posición Y (fila) y detectando saltos grandes de X (columna).
//  b) Escaneado/foto (sin texto real, son píxeles): la extracción de texto
//     da prácticamente vacío. Se renderiza cada página a un canvas y se
//     corre OCR (Tesseract.js). Esto es sensiblemente más lento y bastante
//     menos preciso (un "8" leído como "3" en un precio no tira error, se
//     carga mal en silencio) — por eso SIEMPRE se avisa antes de mostrar la
//     vista previa, para que la revisión fila por fila sea más cuidadosa.
const OCR_MIN_CHARS_POR_PAGINA = 20; // debajo de esto, se asume que la página no tiene texto real
const OCR_MAX_PAGINAS = 15; // tope duro: OCR es pesado, evita que el navegador quede colgado con un PDF de 100 páginas

function agruparItemsEnFilas(items) {
  if (!items.length) return [];

  // Redondea Y para tolerar el jitter de sub-píxel entre caracteres de una
  // misma línea visual, y ordena filas de arriba a abajo, ítems de
  // izquierda a derecha dentro de cada fila.
  //
  // OJO (probado contra un PDF real): pdf.js NO garantiza que los ítems de
  // getTextContent() vengan en orden de lectura izquierda-a-derecha dentro
  // de una misma línea — en varios generadores de reportes, el texto de la
  // columna "nombre" sale ANTES que el de "código" en el stream aunque esté
  // más a la derecha en la página. Por eso acá SÍ hace falta reordenar por
  // X: es la única forma confiable de reconstruir el orden visual real.
  const porY = new Map();
  for (const it of items) {
    const y = Math.round(it.y / 3) * 3;
    if (!porY.has(y)) porY.set(y, []);
    porY.get(y).push(it);
  }
  const filas = [...porY.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) => its.sort((a, b) => a.x - b.x));

  // Detecta columnas por gaps de X: si el espacio entre el fin de un ítem y
  // el inicio del siguiente supera ~2.5x el ancho de caracter típico de la
  // página, se asume borde de columna en vez de un simple espacio dentro
  // del mismo campo de texto.
  const anchosChar = items.map(it => it.width / Math.max(it.str.length, 1)).filter(w => w > 0);
  const anchoCharTipico = anchosChar.length
    ? anchosChar.slice().sort((a, b) => a - b)[Math.floor(anchosChar.length / 2)]
    : 5;
  const umbralGap = anchoCharTipico * 2.5;

  return filas.map(its => {
    const celdas = [];
    let actual = its[0]?.str ?? '';
    for (let i = 1; i < its.length; i++) {
      const gap = its[i].x - (its[i - 1].x + its[i - 1].width);
      if (gap > umbralGap) {
        celdas.push(actual.trim());
        actual = its[i].str;
      } else {
        actual += its[i].str;
      }
    }
    if (its.length) celdas.push(actual.trim());
    return celdas;
  });
}

// PDFs de varias páginas casi siempre repiten membrete y/o pie de página
// (nombre de empresa, dirección, teléfono, fecha, "página X de Y") en cada
// página — eso queda mezclado como filas más entre los datos reales. Se
// descartan las filas cuyo texto aparece, idéntico, en la mitad o más de
// las páginas del documento: una fila de datos real es prácticamente
// imposible que se repita así (cada producto aparece una vez), mientras que
// texto de membrete/pie sí se repite exactamente igual página tras página.
// Genérico a propósito — no depende de reconocer ninguna palabra puntual.
function quitarFilasRepetidasEntrePaginas(filasPorPagina) {
  if (filasPorPagina.length < 3) return filasPorPagina.flat(); // muy pocas páginas para que el patrón sea confiable

  const paginasPorTexto = new Map();
  filasPorPagina.forEach(filas => {
    const vistasEnEstaPagina = new Set();
    for (const f of filas) {
      const texto = f.join(' | ').trim().toLowerCase();
      if (!texto || vistasEnEstaPagina.has(texto)) continue;
      vistasEnEstaPagina.add(texto);
      paginasPorTexto.set(texto, (paginasPorTexto.get(texto) || 0) + 1);
    }
  });
  const umbralPaginas = Math.ceil(filasPorPagina.length * 0.5);
  const esBoilerplate = f => {
    const texto = f.join(' | ').trim().toLowerCase();
    return texto && (paginasPorTexto.get(texto) || 0) >= umbralPaginas;
  };

  // De paso, una fila que quedó con una sola celda después de separar
  // columnas (sin comas de gap detectadas) casi nunca es un producto real
  // — suele ser un número de página suelto u otro resto de maquetación
  // que no calzó con el patrón de membrete repetido de arriba.
  return filasPorPagina.flat().filter(f => !esBoilerplate(f) && f.length > 1);
}

async function extraerMatrizPorTextoPdf(pdf) {
  const filasPorPagina = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pagina = await pdf.getPage(p);
    const contenido = await pagina.getTextContent();
    const items = contenido.items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width }));
    filasPorPagina.push(agruparItemsEnFilas(items));
  }
  const filas = quitarFilasRepetidasEntrePaginas(filasPorPagina);
  return { filas, totalCaracteres: filas.reduce((acc, f) => acc + f.join('').length, 0) };
}

async function extraerMatrizPorOcrPdf(pdf, estadoDiv) {
  const Tesseract = await cargarTesseract();
  const nPaginas = Math.min(pdf.numPages, OCR_MAX_PAGINAS);
  const filas = [];

  for (let p = 1; p <= nPaginas; p++) {
    if (estadoDiv) estadoDiv.textContent = `Reconociendo texto (OCR) — página ${p} de ${nPaginas}, puede tardar...`;
    const pagina = await pdf.getPage(p);
    const viewport = pagina.getViewport({ scale: 2 }); // 2x para mejorar precisión del OCR
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const { data } = await Tesseract.recognize(canvas, 'spa+eng');
    const lineasPagina = (data.text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    // Mismo criterio que parsearTXTCrudo: sin separador real en el output de
    // OCR, se parte por corridas de 2+ espacios (así suelen quedar alineadas
    // las columnas después del reconocimiento).
    for (const l of lineasPagina) {
      filas.push(l.split(/ {2,}/).map(c => c.trim()).filter(c => c !== ''));
    }
  }
  return filas;
}

async function parsearPDFCrudo(file, estadoDiv) {
  const pdfjsLib = await cargarPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const aviso = document.getElementById('aviso-pdf-ocr');

  const { filas: filasTexto, totalCaracteres } = await extraerMatrizPorTextoPdf(pdf);
  const promedioPorPagina = totalCaracteres / Math.max(pdf.numPages, 1);

  if (promedioPorPagina >= OCR_MIN_CHARS_POR_PAGINA) {
    if (aviso) aviso.style.display = 'none';
    return filasTexto;
  }

  // Texto casi vacío: es un PDF escaneado/imagen. Se avisa ANTES de mostrar
  // la vista previa (no después) para que la persona sepa, mientras revisa
  // fila por fila, que estos datos vienen de reconocimiento óptico y no de
  // texto real del archivo.
  if (aviso) {
    aviso.style.display = '';
    aviso.textContent =
      '⚠ Este PDF no tiene texto seleccionable (parece escaneado o una foto). Se está usando reconocimiento óptico (OCR), que es más lento y bastante menos preciso que un archivo con texto real — revisá cada fila con especial cuidado antes de confirmar, sobre todo números.';
  }
  if (pdf.numPages > OCR_MAX_PAGINAS && aviso) {
    aviso.textContent += ` Además, el archivo tiene ${pdf.numPages} páginas y solo se procesan las primeras ${OCR_MAX_PAGINAS} por OCR (subí el resto por separado si hace falta).`;
  }
  return await extraerMatrizPorOcrPdf(pdf, estadoDiv);
}

// ─── Soporte .json (export directo de otra app/API) ───────────────────────────
// Dos formas reales de que llegue esto: un array de objetos ([{...},{...}]),
// que es lo normal en un export de API/otro sistema; o ese array metido
// adentro de una key contenedora (p.ej. {"productos":[...]}, {"data":[...]},
// {"rows":[...]}) — muy común cuando el JSON viene de un endpoint tipo
// "GET /productos" que devuelve metadata + resultados. Se busca el primer
// array de objetos que aparezca (en la raíz o un nivel adentro) en vez de
// asumir una sola forma posible.
function encontrarArrayDeObjetos(valor, profundidad = 0) {
  if (Array.isArray(valor) && valor.length && valor.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    return valor;
  }
  if (profundidad < 2 && valor && typeof valor === 'object') {
    for (const v of Object.values(valor)) {
      const encontrado = encontrarArrayDeObjetos(v, profundidad + 1);
      if (encontrado) return encontrado;
    }
  }
  return null;
}

async function parsearJSONCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  let json;
  try {
    json = JSON.parse(texto);
  } catch (e) {
    throw new Error('El archivo .json no es válido: ' + e.message);
  }

  const filas = encontrarArrayDeObjetos(json);
  if (!filas) {
    throw new Error('No se encontró una lista de registros en el JSON (se esperaba un array de objetos, en la raíz o dentro de una key como "data"/"productos"/"rows").');
  }

  // Encabezados = unión de claves en el orden en que van apareciendo (no
  // todos los objetos tienen por qué traer exactamente las mismas keys —
  // p.ej. algunos productos con descuento y otros sin esa key).
  const columnas = [];
  const vistas = new Set();
  for (const obj of filas) {
    for (const k of Object.keys(obj)) {
      if (!vistas.has(k)) { vistas.add(k); columnas.push(k); }
    }
  }

  const matriz = [columnas];
  for (const obj of filas) {
    matriz.push(columnas.map(c => {
      const v = obj[c];
      if (v === null || v === undefined) return '';
      // Valores anidados (objeto/array dentro de un campo): se guardan como
      // JSON compacto en la celda en vez de perderlos — la persona ve el
      // valor real en la vista previa y decide si lo necesita.
      return typeof v === 'object' ? JSON.stringify(v) : v;
    }));
  }
  return matriz;
}

// ─── Soporte .xml (export de ERPs/sistemas viejos) ────────────────────────────
// No hay un único "formato XML de tabla" — la heurística busca, entre los
// elementos del documento, cuál tag se repite como hijo directo del mismo
// padre 2+ veces (eso es casi siempre "un registro por elemento", sea
// <item>, <producto>, <row>, <fila>, lo que sea que use el sistema de
// origen). Cada registro puede traer los datos como elementos hijos
// (<nombre>x</nombre>) o como atributos (<item nombre="x"/>) — se soportan
// ambos, y si un registro tiene las dos formas, los elementos hijos ganan.
function encontrarElementosFila(doc) {
  const porPadreYTag = new Map();
  const recorrer = nodo => {
    for (const hijo of nodo.children) {
      const clave = (hijo.parentElement === nodo ? nodo : null) ? `${nodo.tagName}>${hijo.tagName}` : hijo.tagName;
      if (!porPadreYTag.has(clave)) porPadreYTag.set(clave, []);
      porPadreYTag.get(clave).push(hijo);
      recorrer(hijo);
    }
  };
  recorrer(doc.documentElement);

  // El candidato ganador es el grupo con más elementos repetidos (asumiendo
  // que la tabla real tiene más filas que cualquier otra estructura
  // incidental del XML, como metadata o un único bloque de cabecera).
  let mejor = null;
  for (const grupo of porPadreYTag.values()) {
    if (grupo.length >= 2 && (!mejor || grupo.length > mejor.length)) mejor = grupo;
  }
  return mejor || [];
}

async function parsearXMLCrudo(file) {
  const texto = await leerTextoConFallbackEncoding(file);
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo .xml no es válido (no se pudo parsear).');

  const elementosFila = encontrarElementosFila(doc);
  if (!elementosFila.length) throw new Error('No se encontraron registros repetidos en el XML (se esperaba una lista de elementos iguales, p.ej. <item>...</item> repetido).');

  const columnas = [];
  const vistas = new Set();
  const datosPorFila = elementosFila.map(el => {
    const datos = {};
    for (const attr of el.attributes) { datos[attr.name] = attr.value; }
    for (const hijo of el.children) { datos[hijo.tagName] = hijo.textContent; }
    if (!el.children.length && !el.attributes.length) datos['valor'] = el.textContent;
    for (const k of Object.keys(datos)) { if (!vistas.has(k)) { vistas.add(k); columnas.push(k); } }
    return datos;
  });

  return [columnas, ...datosPorFila.map(d => columnas.map(c => d[c] ?? ''))];
}

// ─── Soporte .dbf (dBase III/IV — formato nativo de Tango y sistemas DOS) ─────
// Formato binario simple y bien documentado, no hace falta librería externa.
// Estructura: header de 32 bytes (cantidad de registros, tamaño de header,
// tamaño de registro), seguido de un descriptor de 32 bytes por columna
// (nombre, tipo, largo), terminado en 0x0D, y después los registros: 1 byte
// de flag de borrado + los campos en ancho fijo según el descriptor.
// Codificación: estos archivos son casi siempre de sistemas viejos con
// code page Windows-1252/DOS-850 — nunca UTF-8 — así que se decodifica con
// el mismo criterio que ya usa leerTextoConFallbackEncoding para .txt/.csv.
async function parsearDBFCrudo(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const cantidadRegistros = view.getUint32(4, true);
  const tamañoHeader = view.getUint16(8, true);
  const tamañoRegistro = view.getUint16(10, true);

  const campos = [];
  let offset = 32;
  while (bytes[offset] !== 0x0D && offset < tamañoHeader) {
    const nombreBytes = bytes.slice(offset, offset + 11);
    const finNombre = nombreBytes.indexOf(0);
    const nombre = new TextDecoder('windows-1252').decode(nombreBytes.slice(0, finNombre === -1 ? 11 : finNombre));
    const largo = bytes[offset + 16];
    campos.push({ nombre, largo });
    offset += 32;
  }
  if (!campos.length) throw new Error('El archivo .dbf no tiene columnas reconocibles (¿está corrupto o no es dBase III/IV?).');

  const decoder = new TextDecoder('windows-1252');
  const matriz = [campos.map(c => c.nombre)];
  let posRegistro = tamañoHeader;
  for (let r = 0; r < cantidadRegistros; r++) {
    const flagBorrado = bytes[posRegistro];
    let posCampo = posRegistro + 1;
    const fila = [];
    for (const campo of campos) {
      const valor = decoder.decode(bytes.slice(posCampo, posCampo + campo.largo)).trim();
      fila.push(valor);
      posCampo += campo.largo;
    }
    // Registros marcados como borrados (flag 0x2A, asterisco) en dBase no se
    // eliminan físicamente del archivo — se excluyen acá para no resucitar
    // datos que la persona ya había borrado en el sistema de origen.
    if (flagBorrado !== 0x2A) matriz.push(fila);
    posRegistro += tamañoRegistro;
  }
  return matriz;
}

// ─── Soporte .png/.jpg/.jpeg (foto o captura de una lista/factura) ────────────
// Mismo problema que un PDF escaneado, mismo mecanismo: OCR directo sobre la
// imagen, con el mismo aviso de precisión reducida. No hay "capa de texto"
// que probar primero porque una imagen nunca la tiene.
async function parsearImagenCrudo(file, estadoDiv) {
  const Tesseract = await cargarTesseract();
  const aviso = document.getElementById('aviso-pdf-ocr');
  if (aviso) {
    aviso.style.display = '';
    aviso.textContent =
      '⚠ Estás subiendo una imagen: se usa reconocimiento óptico (OCR), que es más lento y bastante menos preciso que un archivo con texto real — revisá cada fila con especial cuidado antes de confirmar, sobre todo números.';
  }
  if (estadoDiv) estadoDiv.textContent = 'Reconociendo texto (OCR)... puede tardar.';

  const { data } = await Tesseract.recognize(file, 'spa+eng');
  const lineas = (data.text || '').split(/\r?\n/).filter(l => l.trim() !== '');
  return lineas.map(l => l.split(/ {2,}/).map(c => c.trim()).filter(c => c !== ''));
}

// ─── Migración 384: detección de fila de encabezados ─────────────────────────
// El bug real que motivó esto: sheet_to_json/Papa.parse con header:true
// asumían ciegamente que la fila 0 tenía nombres de columna. Si el archivo
// no traía encabezados (exportado directo de un sistema viejo, por
// ejemplo), esa primera fila de DATOS se perdía silenciosamente, tratada
// como si fueran nombres de columna — y de paso el mapeo se rompía porque
// ninguna columna matcheaba nada conocido.
//
// La heurística no decide sola y en silencio: solo arma un valor por
// defecto razonable para el checkbox de la vista previa, que la persona
// siempre puede corregir a mano antes de seguir.
function detectarFilaEncabezado(matriz) {
  const header = matriz[0] || [];
  const muestra = matriz.slice(1, 21); // hasta 20 filas de datos como muestra
  if (!header.length || !muestra.length) return { probable: true, confianza: 'baja' };

  // 0) Un encabezado real tiene la MISMA cantidad de columnas que las filas
  // que encabeza. Si la fila 0 tiene bastantes menos celdas que lo típico
  // en la muestra, no es un encabezado — probablemente es ruido (p.ej. un
  // fragmento de membrete/pie de página que quedó aislado como primera
  // fila al extraer texto de un PDF). Esto pesa más que las señales de
  // abajo porque es una condición estructural, no una corazonada de texto.
  const largos = muestra.map(f => f.length);
  const conteoLargos = new Map();
  for (const l of largos) conteoLargos.set(l, (conteoLargos.get(l) || 0) + 1);
  const largoModal = [...conteoLargos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? header.length;
  if (largoModal > 1 && header.length < largoModal) {
    return { probable: false, confianza: 'alta' };
  }

  let señales = 0, puntos = 0;

  // 1) ¿Los valores de la fila 0 matchean nombres/etiquetas de campos conocidos?
  const vocabulario = new Set([
    ...Object.keys(ETIQUETAS_CAMPO).map(normalizarTexto),
    ...Object.values(ETIQUETAS_CAMPO).map(normalizarTexto),
  ]);
  señales++;
  if (header.some(h => vocabulario.has(normalizarTexto(h)))) puntos++;

  // 2) Los encabezados reales casi nunca son puramente numéricos.
  const pareceNumero = v => v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(String(v).replace(',', '.')));
  señales++;
  if (!header.every(pareceNumero)) puntos++;

  // 3) Los encabezados reales no se repiten entre sí.
  const normalizados = header.map(h => (h ?? '').toString().trim().toLowerCase());
  señales++;
  if (new Set(normalizados).size === normalizados.length) puntos++;

  // 4) Si una columna es 100% numérica en la muestra de datos pero la fila 0
  // en esa misma columna TAMBIÉN parece número, la fila 0 probablemente es
  // otra fila de datos, no un encabezado.
  let columnasNumericas = 0, headerNumericoAhi = 0;
  for (let c = 0; c < header.length; c++) {
    const valores = muestra.map(f => f[c]).filter(v => v !== undefined && v !== '');
    if (!valores.length) continue;
    if (valores.every(pareceNumero)) {
      columnasNumericas++;
      if (pareceNumero(header[c])) headerNumericoAhi++;
    }
  }
  señales++;
  if (columnasNumericas === 0 || headerNumericoAhi === 0) puntos++;

  const ratio = puntos / señales;
  return {
    probable: ratio >= 0.5,
    confianza: ratio >= 0.75 ? 'alta' : (ratio >= 0.5 ? 'media' : 'baja'),
  };
}

let _resolverPreviewEncabezado = null;

// Muestra las primeras filas de la matriz cruda y deja que la persona
// confirme (o corrija) si la fila 1 es encabezado o ya son datos, antes de
// armar los objetos que se suben al backend. Devuelve
// { tieneEncabezado, encabezados } — encabezados es la lista de nombres de
// columna a usar (los reales si hay encabezado, o "Columna 1, 2, ..." si no).
function mostrarPreviewEncabezado(matriz) {
  const { probable } = detectarFilaEncabezado(matriz);
  const cont = document.getElementById('preview-encabezado');
  const check = document.getElementById('check-tiene-encabezado');
  const tabla = document.getElementById('preview-encabezado-tabla');

  const nCols = Math.max(...matriz.slice(0, 6).map(f => f.length));
  const filasPreview = matriz.slice(0, 5);

  const renderTabla = tieneEncabezado => {
    const encabezadosPreview = tieneEncabezado
      ? matriz[0]
      : Array.from({ length: nCols }, (_, i) => `Columna ${i + 1}`);
    const filasDatosPreview = tieneEncabezado ? filasPreview.slice(1) : filasPreview;
    tabla.innerHTML = `
      <thead><tr>${encabezadosPreview.map(h => `<th>${escapeHtml((h ?? '').toString() || '—')}</th>`).join('')}</tr></thead>
      <tbody>${filasDatosPreview.map(f =>
        `<tr>${Array.from({ length: nCols }, (_, i) => `<td>${escapeHtml((f[i] ?? '').toString())}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;
  };

  check.checked = probable;
  renderTabla(check.checked);
  check.onchange = () => renderTabla(check.checked);

  cont.style.display = '';
  document.getElementById('estado-carga').textContent = '';

  return new Promise(resolve => {
    _resolverPreviewEncabezado = () => {
      cont.style.display = 'none';
      const tieneEncabezado = check.checked;
      const encabezados = tieneEncabezado
        ? matriz[0]
        : Array.from({ length: nCols }, (_, i) => `Columna ${i + 1}`);
      resolve({ tieneEncabezado, encabezados });
    };
  });
}

function confirmarPreviewEncabezado() {
  if (_resolverPreviewEncabezado) {
    _resolverPreviewEncabezado();
    _resolverPreviewEncabezado = null;
  }
}

// Convierte la matriz cruda en el array de objetos {columna: valor} que
// espera subirArchivoEnChunks — mismo formato que antes devolvían
// sheet_to_json/Papa.parse con header:true, pero ahora la decisión de qué
// fila es encabezado ya fue confirmada por la persona.
function filasDesdeMatriz(matriz, tieneEncabezado, encabezados) {
  // Dedup de nombres de columna repetidos o vacíos (p.ej. dos columnas
  // "Nombre" en el archivo) — si no, la segunda pisaría a la primera al
  // armar el objeto.
  const nombresUsados = new Map();
  const claves = encabezados.map((h, i) => {
    let base = (h ?? '').toString().trim() || `Columna ${i + 1}`;
    const veces = nombresUsados.get(base) || 0;
    nombresUsados.set(base, veces + 1);
    return veces === 0 ? base : `${base} (${veces + 1})`;
  });

  const filasDatos = tieneEncabezado ? matriz.slice(1) : matriz;
  return filasDatos.map(fila => {
    const obj = {};
    claves.forEach((clave, i) => { obj[clave] = fila[i] ?? ''; });
    return obj;
  });
}

// Migración 165 (gap de QA pre-venta): file.text() SIEMPRE decodifica como
// UTF-8, sin importar el encoding real del archivo. Un CSV viejo exportado
// en Windows-1252/Latin1 (típico de sistemas de facturación argentinos
// pre-2015) se leía con los acentos rotos ("Almac�n" en vez de "Almacén")
// sin ningún aviso — quedaba así guardado en la base. Ahora: se decodifica
// como UTF-8 sin "fatal" (no tira excepción, reemplaza bytes inválidos por
// el carácter U+FFFD) y si aparece ese carácter de reemplazo, es señal de
// que no era UTF-8 real — se reintenta como Windows-1252, que cubre tanto
// Latin1 como los caracteres especiales (comillas tipográficas, etc.) que
// exporta Excel viejo en Windows.
async function leerTextoConFallbackEncoding(file) {
  const buffer = await file.arrayBuffer();
  const comoUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (comoUtf8.includes('\uFFFD')) {
    return new TextDecoder('windows-1252').decode(buffer);
  }
  return comoUtf8;
}

// ─── Paso 2: mapeo de columnas ────────────────────────────────────────────────
function renderMapeo() {
  const grid = document.getElementById('mapeo-grid');
  const autogenerables = CAMPOS_AUTOGENERABLES[estado.entidad] || new Set();
  grid.innerHTML = estado.camposDisponibles.map(campo => {
    const req = estado.camposRequeridos.includes(campo);
    const opciones = estado.columnasDetectadas.map(col =>
      `<option value="${escapeHtml(col)}">${escapeHtml(col)}</option>`
    ).join('');
    // Migración 384: si el campo es autogenerable (hoy solo "código" en
    // productos), se ofrece como una opción más del propio <select> — así
    // confirmarMapeo() lo levanta igual que cualquier otro mapeo, sin
    // necesitar un checkbox aparte ni tocar la lógica de "faltantes".
    const opcionAutogenerar = autogenerables.has(campo)
      ? `<option value="${SENTINEL_AUTOGENERAR}">Generar automáticamente</option>`
      : '';
    let pista = '';
    if (autogenerables.has(campo)) {
      pista = '<span class="mig-pista">si tu archivo no trae esta columna, elegí "Generar automáticamente" para crear un código único por fila</span>';
    } else if (CAMPOS_AUTOCREABLES.has(campo)) {
      pista = '<span class="mig-pista">se crea automáticamente si no existe</span>';
    } else if (CAMPOS_SOLO_MATCH.has(campo)) {
      pista = '<span class="mig-pista">solo se asigna si ya existe un usuario vendedor con ese nombre/email</span>';
    } else if (campo === 'monto') {
      pista = '<span class="mig-pista">usalo solo o junto con "Tipo" — no lo combines con Debe/Haber</span>';
    } else if (campo === 'debe' || campo === 'haber') {
      pista = '<span class="mig-pista">formato alternativo a "Monto" — usá uno de los dos, no ambos</span>';
    } else if (campo === 'tipo' && estado.entidad === 'cta_cte') {
      pista = '<span class="mig-pista">opcional: si no lo mapeás, se infiere del signo del monto</span>';
    } else if (campo === 'tipo' && estado.entidad === 'comprobantes_historicos') {
      pista = '<span class="mig-pista">obligatorio: factura, nota de crédito o nota de débito</span>';
    }
    return `
      <div class="mig-mapeo-row">
        <label for="map-${campo}">${ETIQUETAS_CAMPO[campo] || campo}${req ? ' *' : ''}</label>
        <select id="map-${campo}" data-campo="${campo}">
          <option value="">— No mapear —</option>
          ${opcionAutogenerar}
          ${opciones}
        </select>
        ${pista}
      </div>`;
  }).join('');

  // Auto-match por nombre similar (sin acentos/case)
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    const campo = sel.dataset.campo;
    const match = estado.columnasDetectadas.find(c => normalizarTexto(c) === normalizarTexto(campo) || normalizarTexto(c).includes(normalizarTexto(campo)));
    if (match) sel.value = match;
  });
}

function normalizarTexto(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s]/g, '');
}

// Migración 161: cta_cte acepta 3 formatos de monto/tipo distintos (ver
// resolverMovimientoCtaCte en el backend). El mapeo de columnas en sí ya es
// genérico, pero conviene explicar las 3 combinaciones posibles ANTES de que
// la persona arme el mapeo, para que no intente mapear "monto" Y "debe"/"haber"
// a la vez sin necesidad, o se quede sin saber qué pasa si no tiene "tipo".
function renderAyudaCtaCte() {
  const cont = document.getElementById('mapeo-ayuda-ctacte');
  if (estado.entidad !== 'cta_cte') { cont.style.display = 'none'; return; }

  cont.style.display = '';
  cont.innerHTML = `
    <p class="mig-destinos-titulo">Tu archivo puede traer el monto de 3 formas distintas — mapeá solo la que tengas:</p>
    <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--color-text-secondary);">
      <li><strong>Monto con signo</strong>: una sola columna numérica (positivo = cargo/factura, negativo = pago).</li>
      <li><strong>Monto + Tipo</strong>: columna de monto (siempre positivo) más una columna de texto libre
          (factura, pago, cobro, nota de crédito, etc.).</li>
      <li><strong>Debe / Haber</strong>: el típico libro mayor de dos columnas separadas que exportan la mayoría
          de los sistemas viejos — no hace falta columna de tipo, se infiere sola.</li>
    </ul>
    <p class="mig-destinos-nota">No mapees "Monto" junto con "Debe"/"Haber" — son formatos alternativos, no se combinan.
      El cliente tiene que existir ya en el sistema (migralo primero si todavía no lo hiciste).</p>
  `;
}

// Migración 156: si la empresa tiene más de un depósito y/o más de una
// lista de precios, dejamos elegir destino en vez de asumir siempre el
// principal/default. Si solo hay una opción de cada uno, no molestamos
// con el selector — se usa esa sola opción igual que antes.
function renderDestinos() {
  const cont = document.getElementById('mapeo-destinos');
  // Migración 172: lotes también elige depósito destino (mismo criterio que
  // productos), pero no tiene lista de precios — no aplica a esta entidad.
  const aplicaEntidad = estado.entidad === 'productos' || estado.entidad === 'lotes';
  const aplicaLista = estado.entidad === 'productos';
  if (!aplicaEntidad || (estado.depositos.length <= 1 && (!aplicaLista || estado.listasPrecios.length <= 1))) {
    cont.innerHTML = '';
    cont.style.display = 'none';
    return;
  }

  const bloqueDeposito = estado.depositos.length > 1 ? `
    <div class="mig-mapeo-row">
      <label for="destino-deposito">Depósito destino</label>
      <select id="destino-deposito">
        ${estado.depositos.map(d => `<option value="${d.id}" ${d.es_principal ? 'selected' : ''}>${escapeHtml(d.nombre)}${d.es_principal ? ' (principal)' : ''}</option>`).join('')}
      </select>
    </div>` : '';

  const bloqueLista = (aplicaLista && estado.listasPrecios.length > 1) ? `
    <div class="mig-mapeo-row">
      <label for="destino-lista">Lista de precios destino</label>
      <select id="destino-lista">
        ${estado.listasPrecios.map(l => `<option value="${l.id}" ${l.es_default ? 'selected' : ''}>${escapeHtml(l.nombre)}${l.es_default ? ' (default)' : ''}</option>`).join('')}
      </select>
    </div>` : '';

  const titulo = estado.entidad === 'lotes' ? '¿En qué depósito cargamos los lotes?' : '¿Dónde cargamos el stock y los precios?';
  const nota = estado.entidad === 'lotes'
    ? 'Esto es el depósito por defecto. Si tu archivo tiene una columna de depósito por lote, mapeala como "Depósito (por fila)" más abajo — esa fila va a ese destino puntual en vez del elegido acá.'
    : 'Esto es el destino por defecto. Si tu archivo tiene una columna de depósito y/o lista de precios por producto, mapealas como "Depósito (por fila)" / "Lista de precios (por fila)" más abajo — esa fila va a ese destino puntual en vez del elegido acá.';

  cont.style.display = '';
  cont.innerHTML = `<h3 class="mig-destinos-titulo">${titulo}</h3>${bloqueDeposito}${bloqueLista}
    <p class="mig-destinos-nota">${nota}</p>`;
}

// ─── Punto 9 del plan de migraciones: plantillas de mapeo guardadas ─────────
// Permite guardar el mapeo de columnas ya armado a mano como plantilla
// reutilizable (útil para exportaciones periódicas del sistema viejo que
// siempre traen las mismas columnas) y volver a aplicarlo con un clic la
// próxima vez, en vez de rehacer el mapeo completo cada vez.
async function renderPlantillasMapeo() {
  const cont = document.getElementById('mapeo-plantillas');
  if (!cont) return;
  try {
    const data = await migApi(`/api/migracion?accion=plantillas&entidad=${estado.entidad}`);
    estado.plantillasMapeo = data.plantillas || [];
  } catch (err) {
    estado.plantillasMapeo = [];
  }
  pintarPlantillasMapeo();
}

function pintarPlantillasMapeo() {
  const cont = document.getElementById('mapeo-plantillas');
  if (!cont) return;

  const hayPlantillas = estado.plantillasMapeo.length > 0;
  const opciones = estado.plantillasMapeo
    .map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`)
    .join('');

  cont.style.display = '';
  cont.innerHTML = `
    <h3 class="mig-destinos-titulo">Plantillas de mapeo guardadas</h3>
    <div class="mig-mapeo-row">
      <select id="select-plantilla-mapeo" ${hayPlantillas ? '' : 'disabled'} style="flex: 1;">
        <option value="">${hayPlantillas ? '— Elegí una plantilla —' : 'No tenés plantillas guardadas para esta entidad'}</option>
        ${opciones}
      </select>
      <button type="button" class="btn btn--secondary btn--sm" onclick="aplicarPlantillaMapeo()" ${hayPlantillas ? '' : 'disabled'}>Usar</button>
      <button type="button" id="btn-borrar-plantilla" class="btn btn--secondary btn--sm" onclick="borrarPlantillaMapeoSeleccionada()" ${hayPlantillas ? '' : 'disabled'}>Borrar</button>
    </div>
    <p class="mig-destinos-nota">
      <button type="button" id="btn-guardar-plantilla" class="btn btn--secondary btn--sm" onclick="guardarPlantillaMapeoActual()">Guardar el mapeo de abajo como plantilla nueva</button>
    </p>
  `;
}

// Aplica el mapeo guardado a los <select> ya renderizados por renderMapeo().
// Si una columna guardada ya no existe en este archivo (encabezados
// distintos), esa entrada de la plantilla se ignora en silencio — el resto
// del mapeo se aplica igual y la persona completa a mano lo que falte.
function aplicarPlantillaMapeo() {
  const sel = document.getElementById('select-plantilla-mapeo');
  const plantilla = estado.plantillasMapeo.find(p => p.id === sel.value);
  if (!plantilla) return;

  for (const [campo, columna] of Object.entries(plantilla.mapeo_columnas || {})) {
    const selCampo = document.getElementById(`map-${campo}`);
    if (selCampo && estado.columnasDetectadas.includes(columna)) selCampo.value = columna;
  }
  const selDep = document.getElementById('destino-deposito');
  if (selDep && plantilla.deposito_id) selDep.value = plantilla.deposito_id;
  const selLista = document.getElementById('destino-lista');
  if (selLista && plantilla.lista_precio_id) selLista.value = plantilla.lista_precio_id;

  window.toast?.(`Plantilla "${plantilla.nombre}" aplicada`, 'success');
}

async function guardarPlantillaMapeoActual() {
  const nombre = window.prompt('Nombre para esta plantilla de mapeo:');
  if (!nombre || !nombre.trim()) return;

  const mapeo = {};
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    if (sel.value) mapeo[sel.dataset.campo] = sel.value;
  });
  if (!Object.keys(mapeo).length) {
    window.toast?.('Mapeá al menos una columna antes de guardar', 'error');
    return;
  }

  const selDep = document.getElementById('destino-deposito');
  const selLista = document.getElementById('destino-lista');

  const btn = document.getElementById('btn-guardar-plantilla');
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  try {
    await migApi('/api/migracion?accion=guardar_plantilla', {
      method: 'POST',
      body: JSON.stringify({
        entidad: estado.entidad,
        nombre: nombre.trim(),
        mapeo_columnas: mapeo,
        deposito_id: selDep ? selDep.value : null,
        lista_precio_id: selLista ? selLista.value : null,
      }),
    });
    window.toast?.('Plantilla guardada', 'success');
    await renderPlantillasMapeo();
  } catch (err) {
    console.error('[migracion] guardar plantilla:', err);
    window.toast?.('No se pudo guardar la plantilla', 'error');
  } finally {
    // Si el guardado salió bien, renderPlantillasMapeo() ya reemplazó este
    // botón por uno nuevo (habilitado) al reescribir el innerHTML del
    // contenedor. Si falló, el botón original sigue en pie y hay que
    // reactivarlo acá.
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

async function borrarPlantillaMapeoSeleccionada() {
  const sel = document.getElementById('select-plantilla-mapeo');
  const plantilla = estado.plantillasMapeo.find(p => p.id === sel?.value);
  if (!plantilla) return;
  const okBorrar = await window.confirmar(
    `¿Borrar la plantilla "${plantilla.nombre}"? Esta acción no se puede deshacer.`,
    { labelOk: 'Borrar', labelCancel: 'Cancelar', tipo: 'danger' }
  );
  if (!okBorrar) return;

  const btn = document.getElementById('btn-borrar-plantilla');
  const textoOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Borrando...'; }

  try {
    await migApi(`/api/migracion?accion=plantilla&plantilla_id=${plantilla.id}`, { method: 'DELETE' });
    window.toast?.('Plantilla borrada', 'success');
    await renderPlantillasMapeo();
  } catch (err) {
    console.error('[migracion] borrar plantilla:', err);
    window.toast?.('No se pudo borrar la plantilla', 'error');
  } finally {
    // Mismo caso que en guardarPlantillaMapeoActual: si borró bien, el
    // render ya reemplazó el botón; si falló, lo reactivamos acá.
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

async function confirmarMapeo() {
  const mapeo = {};
  document.querySelectorAll('#mapeo-grid select').forEach(sel => {
    if (sel.value) mapeo[sel.dataset.campo] = sel.value;
  });

  const faltantes = estado.camposRequeridos.filter(c => !mapeo[c]);
  if (faltantes.length) {
    window.toast?.(`Falta mapear: ${faltantes.map(c => ETIQUETAS_CAMPO[c] || c).join(', ')}`, 'error');
    return;
  }

  // Corrección punto 1: guardamos el mapeo que se va a confirmar para poder
  // calcular, en la pantalla de Resultado, qué columnas del archivo original
  // quedaron sin ningún campo de destino (no se pierden del todo — siguen en
  // migracion_staging_rows.datos_originales — pero antes no había ninguna
  // pantalla que avisara cuáles eran).
  estado.mapeoConfirmado = mapeo;

  const body = { sesion_id: estado.sesionId, mapeo_columnas: mapeo };
  const selDeposito = document.getElementById('destino-deposito');
  const selLista = document.getElementById('destino-lista');
  if (selDeposito) body.deposito_id = selDeposito.value;
  if (selLista) body.lista_precio_id = selLista.value;

  // Migración 167: el backend procesa un lote acotado por request (filas
  // mapeado_en IS NULL) y devuelve hay_mas=true mientras falten. Mismo
  // patrón de loop que ya usa ejecutarLoteConfirmacion — el body se manda
  // igual en cada vuelta (mapeo_columnas/destinos), el backend solo los usa
  // para arrancar la pasada (ver prepararPasadaDeMapeo) y los ignora en las
  // vueltas siguientes.
  const btn = document.getElementById('btn-mapear');
  const progreso = document.getElementById('mapeo-progreso');
  const progresoTexto = document.getElementById('mapeo-progreso-texto');
  const progresoBarra = document.getElementById('mapeo-progreso-barra-fill');
  const totalArchivo = estado.totalFilasArchivo || 0;
  btn.disabled = true;
  if (progreso) progreso.style.display = 'block';
  if (progresoBarra) progresoBarra.style.width = '0%';

  try {
    let data = {}, hayMas = true, vueltas = 0, procesadas = 0;
    while (hayMas) {
      vueltas++;
      data = await migApi('/api/migracion?accion=mapear', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      hayMas = !!data.hay_mas;
      // FIX: el backend no devuelve un contador acumulado en esta etapa
      // (solo filas_mapeadas_lote, del lote actual), así que sumamos lote a
      // lote contra el total ya conocido de la subida para estimar el %.
      procesadas = hayMas
        ? Math.min(procesadas + (data.filas_mapeadas_lote || 0), totalArchivo)
        : totalArchivo;
      if (progresoTexto) {
        progresoTexto.textContent = hayMas
          ? `Mapeando… ${procesadas.toLocaleString('es-AR')} de ${totalArchivo.toLocaleString('es-AR')} filas`
          : 'Mapeo terminado, armando la vista previa...';
      }
      if (progresoBarra) {
        const pct = totalArchivo ? Math.max(0, Math.min(100, (procesadas / totalArchivo) * 100)) : 0;
        progresoBarra.style.width = `${pct}%`;
      }
      // Salvaguarda: igual que en confirmar, no hacer loop infinito si algo
      // queda trabado sin avanzar nunca.
      if (vueltas > 500) throw new Error('El mapeo no terminó luego de muchos lotes; revisá la sesión.');
    }

    estado.resumen = data;
    await cargarFilasRevision();
    mostrarPaso('paso-revisar');
  } catch (err) {
    console.error('[migracion] validar mapeo:', err);
    window.toast?.('No se pudo validar el mapeo', 'error');
  } finally {
    btn.disabled = false;
    if (progreso) progreso.style.display = 'none';
  }
}

// ─── Paso 3: revisión ─────────────────────────────────────────────────────────
async function cargarFilasRevision() {
  const data = await migApi(`/api/migracion?sesion_id=${estado.sesionId}&limit=500`);
  estado.filasRevision = data.filas || [];
  estado.paginaFilas = 1;

  document.getElementById('resumen-validas').textContent = estado.resumen.filas_validas;
  document.getElementById('resumen-errores').textContent = estado.resumen.filas_con_error;
  document.getElementById('resumen-total').textContent = estado.resumen.total_filas;

  const aviso = document.getElementById('confirmar-aviso');
  const btnConfirmar = document.getElementById('btn-confirmar');
  const btnDescargarErrores = document.getElementById('btn-descargar-errores');
  if (btnDescargarErrores) btnDescargarErrores.style.display = estado.resumen.filas_con_error > 0 ? '' : 'none';
  if (estado.resumen.filas_validas === 0) {
    aviso.textContent = 'No hay filas válidas para importar.';
    btnConfirmar.disabled = true;
  } else if (estado.resumen.filas_con_error > 0) {
    aviso.textContent = `Se van a importar ${estado.resumen.filas_validas} filas. Las ${estado.resumen.filas_con_error} con error se omiten.`;
    btnConfirmar.disabled = false;
  } else {
    aviso.textContent = `Se van a importar las ${estado.resumen.filas_validas} filas.`;
    btnConfirmar.disabled = false;
  }

  renderResumenMapeo(estado.resumen.resumen_mapeo);
  renderTablaFilas();

  // Punto 11 del audit: precheck no bloqueante (razones sociales parecidas,
  // vendedores no resueltos, precios por debajo de costo, etc.). Si falla
  // por lo que sea, no interrumpe el flujo — el precheck es informativo,
  // nunca fue requisito para poder confirmar.
  await mostrarPrecheck();
}

async function mostrarPrecheck() {
  const cont = document.getElementById('precheck-advertencias');
  if (!cont) return;
  cont.innerHTML = '';
  try {
    const data = await migApi('/api/migracion?accion=precheck', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: estado.sesionId }),
    });
    const advertencias = data.advertencias || [];
    if (!advertencias.length) return;
    const lista = advertencias.slice(0, 20)
      .map(a => `${a.fila_numero ? `Fila ${a.fila_numero}: ` : ''}${escapeHtml(a.mensaje ?? '')}`)
      .join('<br>');
    const extra = advertencias.length > 20 ? `<br>… y ${advertencias.length - 20} más.` : '';
    cont.innerHTML = `<div class="mig-advertencias"><strong>${advertencias.length} advertencia(s) antes de confirmar:</strong><br>${lista}${extra}</div>`;
  } catch {
    // Silencioso: el precheck es una ayuda, no un requisito para confirmar.
  }
}

// Item 2 del plan P0: resumen ejecutivo del mapeo (cuántas se crean/actualizan
// + los errores más frecuentes), para no depender de scrollear la tabla fila
// por fila en archivos grandes. cta_cte además trae el monto total agregado,
// que es la señal más rápida para detectar "subí el archivo mal".
function renderResumenMapeo(resumen) {
  const cont = document.getElementById('resumen-mapeo-detalle');
  if (!cont) return;
  if (!resumen) { cont.innerHTML = ''; cont.style.display = 'none'; return; }

  const crear = resumen.por_accion?.crear || 0;
  const actualizar = resumen.por_accion?.actualizar || 0;

  const partesAccion = [];
  if (crear) partesAccion.push(`<strong>${crear}</strong> nueva${crear === 1 ? '' : 's'}`);
  if (actualizar) partesAccion.push(`<strong>${actualizar}</strong> actualiza${actualizar === 1 ? 'ción' : 'ciones'}`);

  const bloqueMonto = typeof resumen.monto_total_valido === 'number'
    ? `<p class="mig-destinos-nota">Monto total de las filas válidas: <strong>${resumen.monto_total_valido.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}</strong></p>`
    : '';

  const bloqueErrores = resumen.top_errores?.length ? `
    <p class="mig-destinos-titulo" style="margin-top:12px;">Errores más frecuentes</p>
    <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--color-text-secondary);">
      ${resumen.top_errores.map(e => `<li>${escapeHtml(e.mensaje)} <span style="opacity:.7;">(${e.cantidad} fila${e.cantidad === 1 ? '' : 's'})</span></li>`).join('')}
    </ul>` : '';

  cont.style.display = '';
  cont.innerHTML = `
    ${partesAccion.length ? `<p class="mig-destinos-nota">${partesAccion.join(' y ')}.</p>` : ''}
    ${bloqueMonto}
    ${bloqueErrores}
  `;
}

function filtrarFilas(filtro, btn) {
  estado.filtroActual = filtro;
  estado.paginaFilas = 1;
  document.querySelectorAll('.mig-filtro-filas .e-pill').forEach(b => b.classList.remove('activa'));
  btn.classList.add('activa');
  renderTablaFilas();
}

// Filas por página de la tabla de revisión (client-side: ya tenemos hasta
// 500 filas cargadas en memoria por cargarFilasRevision, así que paginar acá
// es solo una cuestión de no renderizar las 500 en el DOM de una — con
// archivos grandes eso hacía que la pantalla quedara con un scroll
// interminable y se sintiera pesada para tipear/scrollear).
const FILAS_POR_PAGINA = 50;

function renderTablaFilas() {
  const campos = estado.camposDisponibles;
  const thead = document.getElementById('filas-thead');
  thead.innerHTML = `<tr><th>#</th><th>Acción</th>${campos.map(c => `<th>${ETIQUETAS_CAMPO[c] || c}</th>`).join('')}<th>Errores</th></tr>`;

  let filas = estado.filasRevision;
  if (estado.filtroActual === 'error') filas = filas.filter(f => !f.es_valida);

  const tbody = document.getElementById('filas-tbody');
  if (!filas.length) {
    tbody.innerHTML = `<tr><td colspan="${campos.length + 3}" class="mig-vacio-celda">No hay filas para mostrar.</td></tr>`;
    document.getElementById('filas-paginacion').style.display = 'none';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(filas.length / FILAS_POR_PAGINA));
  if (!estado.paginaFilas || estado.paginaFilas > totalPaginas) estado.paginaFilas = 1;
  const inicio = (estado.paginaFilas - 1) * FILAS_POR_PAGINA;
  const filasPagina = filas.slice(inicio, inicio + FILAS_POR_PAGINA);

  tbody.innerHTML = filasPagina.map(f => `
    <tr class="${f.es_valida ? '' : 'fila-error'}">
      <td>${f.es_valida ? f.fila_numero : `<span class="mig-fila-num-error" title="Esta fila no se va a importar">⚠ ${f.fila_numero}</span>`}</td>
      <td>
        <select onchange="cambiarAccionFila('${f.id}', this.value)" ${!f.es_valida ? 'disabled' : ''}>
          <option value="crear" ${f.accion === 'crear' ? 'selected' : ''}>Crear</option>
          <option value="actualizar" ${f.accion === 'actualizar' ? 'selected' : ''} ${!f.entidad_existente_id ? 'disabled' : ''}>Actualizar existente</option>
          <option value="omitir" ${f.accion === 'omitir' ? 'selected' : ''}>Omitir</option>
        </select>
      </td>
      ${campos.map(c => `<td>${escapeHtml(f.datos_mapeados?.[c] ?? '')}</td>`).join('')}
      <td class="mig-celda-errores">${(f.errores || []).map(e => escapeHtml(e)).join('; ')}</td>
    </tr>
  `).join('');

  renderPaginacionFilas(filas.length, totalPaginas);
}

function renderPaginacionFilas(totalFilas, totalPaginas) {
  const cont = document.getElementById('filas-paginacion');
  if (!cont) return;
  if (totalPaginas <= 1) { cont.style.display = 'none'; return; }

  const pagina = estado.paginaFilas;
  const inicio = (pagina - 1) * FILAS_POR_PAGINA + 1;
  const fin = Math.min(pagina * FILAS_POR_PAGINA, totalFilas);

  // Ventana acotada de números de página (máx. 7) para no listar cientos de
  // botones con archivos grandes — igual criterio que cualquier paginador
  // clásico: siempre primera, última, la actual, y un par a cada lado.
  const numeros = [];
  const rango = 1;
  for (let p = 1; p <= totalPaginas; p++) {
    if (p === 1 || p === totalPaginas || (p >= pagina - rango && p <= pagina + rango)) numeros.push(p);
    else if (numeros[numeros.length - 1] !== '…') numeros.push('…');
  }

  cont.style.display = 'flex';
  cont.innerHTML = `
    <span class="mig-paginacion-info">${inicio.toLocaleString('es-AR')}–${fin.toLocaleString('es-AR')} de ${totalFilas.toLocaleString('es-AR')}</span>
    <div class="mig-paginacion-botones">
      <button type="button" class="btn btn--secondary btn--sm" ${pagina === 1 ? 'disabled' : ''} onclick="cambiarPaginaFilas(${pagina - 1})">Anterior</button>
      ${numeros.map(p => p === '…'
        ? `<span class="mig-paginacion-elipsis">…</span>`
        : `<button type="button" class="mig-paginacion-num ${p === pagina ? 'activa' : ''}" onclick="cambiarPaginaFilas(${p})">${p}</button>`
      ).join('')}
      <button type="button" class="btn btn--secondary btn--sm" ${pagina === totalPaginas ? 'disabled' : ''} onclick="cambiarPaginaFilas(${pagina + 1})">Siguiente</button>
    </div>`;
}

function cambiarPaginaFilas(pagina) {
  estado.paginaFilas = pagina;
  renderTablaFilas();
  document.querySelector('.mig-tabla-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Descargar filas con error (Excel) ───────────────────────────────────────
// La tabla de revisión solo muestra un preview acotado (limit=500), así que
// para armar el archivo de descarga hay que traer TODAS las filas con error
// de la sesión, paginando con offset (ver obtenerSesion en el backend,
// solo_errores=true). Objetivo: que la persona corrija estas filas afuera (en
// el mismo Excel del que salieron) y suba de nuevo solo esas, en vez de tener
// que revisarlas una por una en la tabla o resubir el archivo entero.
async function obtenerTodasLasFilasConError() {
  const LIMITE_PAGINA = 2000;
  let offset = 0;
  let todas = [];
  while (true) {
    const data = await migApi(`/api/migracion?sesion_id=${estado.sesionId}&limit=${LIMITE_PAGINA}&offset=${offset}&solo_errores=true`);
    const pagina = data.filas || [];
    todas = todas.concat(pagina);
    if (pagina.length < LIMITE_PAGINA) break;
    offset += LIMITE_PAGINA;
  }
  return todas;
}

async function descargarErrores() {
  const btn = document.getElementById('btn-descargar-errores');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparando archivo...';

  try {
    if (!window.XLSX) throw new Error('SheetJS no disponible');
    const filas = await obtenerTodasLasFilasConError();
    if (!filas.length) {
      window.toast?.('No hay filas con error para descargar', 'info');
      return;
    }

    // Mismas columnas que la tabla de revisión (campos mapeados), más el
    // número de fila original y el detalle del error — así la persona puede
    // ubicar la fila en su archivo original y ver exactamente qué corregir.
    const campos = estado.camposDisponibles;
    const encabezados = ['Fila', ...campos.map(c => ETIQUETAS_CAMPO[c] || c), 'Errores'];
    const filasHoja = filas.map(f => [
      f.fila_numero,
      ...campos.map(c => f.datos_mapeados?.[c] ?? ''),
      (f.errores || []).join('; '),
    ]);

    const hoja = window.XLSX.utils.aoa_to_sheet([encabezados, ...filasSeguras(filasHoja)]);
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, 'Errores');

    const nombreArchivo = `errores_${estado.entidad}_${estado.sesionId.slice(0, 8)}.xlsx`;
    window.XLSX.writeFile(libro, nombreArchivo);
  } catch (err) {
    console.error('[migracion] generar archivo de errores:', err);
    window.toast?.('No se pudo generar el archivo de errores', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

async function cambiarAccionFila(filaId, nuevaAccion) {
  try {
    await migApi('/api/migracion?accion=fila', {
      method: 'PATCH',
      body: JSON.stringify({ fila_id: filaId, accion: nuevaAccion }),
    });
    const fila = estado.filasRevision.find(f => f.id === filaId);
    if (fila) fila.accion = nuevaAccion;
  } catch (err) {
    console.error('[migracion] actualizar fila:', err);
    window.toast?.('No se pudo actualizar la fila', 'error');
    renderTablaFilas();
  }
}

// ─── Paso 4: confirmar ────────────────────────────────────────────────────────
// El backend procesa un lote acotado de filas por llamada (ver migración 152)
// y devuelve hay_mas=true mientras queden filas pendientes. Acá lo llamamos en
// loop hasta que termine, mostrando progreso. Si el proceso se interrumpe
// (recarga de página, error de red) y el usuario vuelve a confirmar, las filas
// ya procesadas se saltean solas — no hay riesgo de duplicados.
//
// ejecutarLoteConfirmacion() es compartido entre la primera confirmación y
// el reintento (migración 156/157): ambos llaman accion=confirmar en loop,
// la única diferencia es qué filas quedaron pendientes (procesado_en NULL)
// en el momento de empezar.
async function ejecutarLoteConfirmacion(onProgreso) {
  let r = {}, advertencias = [], hayMas = true, vueltas = 0;

  try {
    while (hayMas) {
      vueltas++;
      const data = await migApi('/api/migracion?accion=confirmar', {
        method: 'POST',
        body: JSON.stringify({ sesion_id: estado.sesionId }),
      });
      r = data.resultado || {};
      hayMas = !!data.hay_mas;
      if (!hayMas && Array.isArray(data.advertencias)) advertencias = data.advertencias;
      onProgreso?.(r, hayMas);

      // Salvaguarda: si por algún motivo no avanza nunca, no hacer loop infinito.
      if (vueltas > 500) throw new Error('La importación no terminó luego de muchos lotes; revisá la sesión.');
    }
  } catch (err) {
    // FIX (auditoría UX etapa 18, Hallazgo 2): si el corte pasa a mitad de
    // loop, r ya tiene el progreso del último lote que sí se guardó server-
    // side (migración 152, bulk idempotente) — antes se perdía al relanzar
    // la excepción y el catch de confirmarSesion() no tenía forma de saber
    // que ya se había importado una parte real.
    err.progresoParcial = r;
    throw err;
  }

  return { r, advertencias };
}

function mostrarResultado(r, advertencias) {
  estado.ultimoErrores = r.errores || 0;
  estado.ultimoResultado = r;
  estado.ultimasAdvertencias = advertencias || [];

  const detalle = document.getElementById('resultado-detalle');
  detalle.textContent =
    `Se crearon ${r.creados ?? 0} y se actualizaron ${r.actualizados ?? 0} registros.` +
    (r.errores ? ` (${r.errores} con error durante la importación)` : '');

  const advCont = document.getElementById('resultado-advertencias');
  if (advertencias.length) {
    const lista = advertencias.slice(0, 20)
      .map(a => `Fila ${a.fila_numero}: ${escapeHtml(a.mensaje)}`)
      .join('<br>');
    const extra = advertencias.length > 20 ? `<br>… y ${advertencias.length - 20} más.` : '';
    advCont.innerHTML = `<div class="mig-advertencias"><strong>${advertencias.length} advertencia(s):</strong><br>${lista}${extra}</div>`;
  } else {
    advCont.innerHTML = '';
  }

  // Corrección punto 1 (sincronización de migraciones): tras confirmar,
  // mostramos qué columnas del archivo original no tuvieron ningún campo de
  // destino en el sistema. Antes esto quedaba "guardado" en
  // migracion_staging_rows.datos_originales pero invisible para quien hizo
  // la migración — ahora queda plasmado en la propia pantalla de resultado.
  const columnasSinMapear = calcularColumnasSinMapear(estado.columnasDetectadas, estado.mapeoConfirmado);
  // REQ-MIG-EXTRAS: si hay columnas sin mapear, buscar muestras de valores
  // en las staging rows para mostrárselas al usuario junto con el nombre.
  if (columnasSinMapear.length && estado.sesionId) {
    _cargarMuestrasExtras(estado.sesionId, columnasSinMapear)
      .then(muestras => renderColumnasSinMapear(
        'resultado-columnas-sin-mapear', columnasSinMapear,
        `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`, muestras))
      .catch(() => renderColumnasSinMapear(
        'resultado-columnas-sin-mapear', columnasSinMapear,
        `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`));
  } else {
    renderColumnasSinMapear('resultado-columnas-sin-mapear', columnasSinMapear,
      `sin_mapear_${estado.entidad}_${estado.sesionId || 'sesion'}`);
  }

  actualizarBotonReintentar();
}

// REQ-MIG-EXTRAS: obtiene hasta 3 valores de muestra por columna sin mapear
// leyendo las staging rows de la sesión. Usa el endpoint existente de staging
// (GET /api/migracion?sesion_id=X&limit=N) que devuelve datos_originales.
async function _cargarMuestrasExtras(sesionId, columnasSinMapear) {
  if (!sesionId || !columnasSinMapear.length) return {};
  try {
    const data = await migApi(`/api/migracion?sesion_id=${encodeURIComponent(sesionId)}&limit=10`);
    const filas = data.filas || data.rows || [];
    // datos_originales es un objeto plano con todas las columnas del CSV
    const muestras = {};
    for (const col of columnasSinMapear) {
      muestras[col] = [];
    }
    for (const fila of filas) {
      const orig = fila.datos_originales || {};
      for (const col of columnasSinMapear) {
        if (muestras[col].length < 3 && orig[col] !== undefined && orig[col] !== '') {
          muestras[col].push(orig[col]);
        }
      }
    }
    return muestras;
  } catch {
    return {};
  }
}

// ─── Corrección punto 1: columnas del archivo sin destino en el sistema ──────
// El mapeo (paso 2) solo pide llenar los campos que el sistema entiende — una
// columna del archivo que nadie eligió como origen de ningún campo queda
// "suelta". Los datos en sí no se pierden (siguen en
// migracion_staging_rows.datos_originales), pero hasta ahora no había ninguna
// pantalla que lo mostrara. `columnasDetectadas` son todas las columnas que
// trajo el archivo; `mapeoColumnas` es field→columna elegida en el mapeo. Lo
// que no aparece como VALOR de ese mapeo es lo que quedó sin usar.
function calcularColumnasSinMapear(columnasDetectadas, mapeoColumnas) {
  if (!Array.isArray(columnasDetectadas) || !columnasDetectadas.length) return [];
  const usadas = new Set(Object.values(mapeoColumnas || {}));
  return columnasDetectadas.filter(col => !usadas.has(col));
}

// REQ-MIG-EXTRAS: renderColumnasSinMapear mejorado — muestra columnas sin
// destino con su muestra de datos (si `muestras` está disponible). La función
// acepta un tercer argumento opcional `muestras` que es un objeto
// { columna: [val1, val2, val3] } con hasta 3 valores de ejemplo por columna.
// Cuando `muestras` está presente las columnas se muestran en tabla; si no,
// vuelve al comportamiento original de lista plana (retrocompatible).
function renderColumnasSinMapear(contenedorId, columnas, nombreArchivoBase, muestras) {
  const cont = document.getElementById(contenedorId);
  if (!cont) return;

  if (!columnas.length) {
    cont.innerHTML = '<p class="mig-sin-mapear-ok">Todas las columnas del archivo se usaron en algún campo del sistema. No quedan datos extra sin destino.</p>';
    return;
  }

  const tieneMuestras = muestras && typeof muestras === 'object' && Object.keys(muestras).length > 0;

  let contenido;
  if (tieneMuestras) {
    // Con muestras: tabla con columna + ejemplos de valores
    const filas = columnas.map(c => {
      const vals = (muestras[c] || []).filter(v => v !== '' && v != null).slice(0, 3);
      const ejemplos = vals.length
        ? vals.map(v => `<code>${escapeHtml(String(v))}</code>`).join(', ')
        : '<em style="color:var(--color-text-muted)">sin datos</em>';
      return `<tr>
        <td style="padding:6px 10px;font-weight:600;">${escapeHtml(c)}</td>
        <td style="padding:6px 10px;">${ejemplos}</td>
      </tr>`;
    }).join('');

    contenido = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:10px 0;">
        <thead>
          <tr style="border-bottom:2px solid var(--color-border);">
            <th style="text-align:left;padding:6px 10px;font-size:12px;font-weight:700;color:var(--color-text-muted);">Columna del archivo</th>
            <th style="text-align:left;padding:6px 10px;font-size:12px;font-weight:700;color:var(--color-text-muted);">Ejemplos de valores</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    `;
  } else {
    // Sin muestras: lista plana (comportamiento original)
    const lista = columnas.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    contenido = `<ul>${lista}</ul>`;
  }

  const colN = columnas.length;
  // FIX XSS: NO usar inline onclick con datos dinámicos. El botón se crea con
  // createElement + addEventListener para evitar inyección si los nombres de
  // columna contienen comillas u otros caracteres especiales.
  const wrapper = document.createElement('div');
  wrapper.className = 'mig-sin-mapear';

  const titulo = document.createElement('strong');
  titulo.textContent = `${colN} columna${colN === 1 ? '' : 's'} del archivo no se usó${colN === 1 ? '' : 'aron'} en ningún campo del sistema (datos extra sin destino):`;
  wrapper.appendChild(titulo);

  // Insertar el contenido de columnas (HTML pre-escapado por escapeHtml arriba)
  const contenidoEl = document.createElement('div');
  contenidoEl.innerHTML = contenido;
  wrapper.appendChild(contenidoEl);

  const nota = document.createElement('p');
  nota.className = 'mig-sin-mapear-nota';
  nota.textContent = 'Esos datos quedan guardados en el sistema vinculados al registro migrado y son visibles en la ficha de cada registro (badge "Importado por migración"). No son operativos — no modifican cálculos ni aparecen en reportes. Podés exportarlos para revisarlos a mano si los necesitás.';
  wrapper.appendChild(nota);

  const btnExportar = document.createElement('button');
  btnExportar.type = 'button';
  btnExportar.className = 'btn btn--ghost btn--sm';
  btnExportar.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Exportar columnas sin usar (CSV)';
  // Captura de cierre: `columnas` y `nombreArchivoBase` en scope, sin interpolación de HTML.
  const _colsSnapshot = columnas.slice();
  const _baseSnapshot = nombreArchivoBase || 'sin_mapear';
  btnExportar.addEventListener('click', () => {
    descargarColumnasSinMapearCSV(_colsSnapshot, _baseSnapshot);
  });
  wrapper.appendChild(btnExportar);

  cont.innerHTML = '';
  cont.appendChild(wrapper);
}

function descargarColumnasSinMapearCSV(columnas, nombreBase) {
  const contenido = 'Columna del archivo original sin campo de destino\n' +
    columnas.map(c => `"${String(c).replace(/"/g, '""')}"`).join('\n');
  const blob = new Blob(['\uFEFF' + contenido], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nombreBase}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Versión para el historial: la sesión ya no está en `estado` (puede ser
// cualquier fila del historial, no la que está abierta en el wizard), así que
// se trae de nuevo del server. `migracion_sesiones` guarda columnas_detectadas
// y mapeo_columnas ya persistidos desde el paso de mapeo (ver
// prepararPasadaDeMapeo en el backend), así que no hace falta re-mapear nada.
async function verColumnasSinMapearHistorial(sesionId, btn) {
  const panelId = `sin-mapear-hist-${sesionId}`;
  const existente = document.getElementById(panelId);
  if (existente) {
    existente.remove();
    btn.textContent = 'Ver columnas sin usar';
    return;
  }

  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = 'Cargando...';

  try {
    const data = await migApi(`/api/migracion?sesion_id=${sesionId}&limit=1`);
    const sesion = data.sesion || {};
    const columnasSinMapear = calcularColumnasSinMapear(sesion.columnas_detectadas, sesion.mapeo_columnas);

    const fila = btn.closest('.mig-sesion-row');
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'mig-sin-mapear-panel';
    fila.insertAdjacentElement('afterend', panel);
    renderColumnasSinMapear(panelId, columnasSinMapear, `sin_mapear_${sesion.entidad || 'sesion'}_${sesionId}`);

    btn.textContent = 'Ocultar columnas sin usar';
  } catch (err) {
    console.error('[migracion] cargar detalle de columnas:', err);
    window.toast?.('No se pudo cargar el detalle de columnas', 'error');
    btn.textContent = textoOriginal;
  } finally {
    btn.disabled = false;
  }
}

// Punto 6: si quedaron filas con error tras confirmar, mostramos un botón
// para reintentar solo esas — sin tener que armar un archivo nuevo a mano.
function actualizarBotonReintentar() {
  const btn = document.getElementById('btn-reintentar');
  if (!btn) return;
  if (estado.ultimoErrores > 0) {
    btn.style.display = '';
    btn.disabled = false;
    btn.textContent = `Reintentar ${estado.ultimoErrores} fila${estado.ultimoErrores === 1 ? '' : 's'} con error`;
  } else {
    btn.style.display = 'none';
  }
}

async function confirmarSesion() {
  const btn = document.getElementById('btn-confirmar');
  const progreso = document.getElementById('confirmar-progreso');
  const progresoTexto = document.getElementById('confirmar-progreso-texto');
  const progresoBarra = document.getElementById('confirmar-progreso-barra-fill');
  const totalAImportar = estado.resumen?.filas_validas || 0;
  btn.disabled = true;
  progreso.style.display = 'block';
  if (progresoBarra) progresoBarra.style.width = '0%';

  try {
    const { r, advertencias } = await ejecutarLoteConfirmacion((r, hayMas) => {
      if (progresoTexto) {
        progresoTexto.textContent = `Importando… ${r.creados ?? 0} creados, ${r.actualizados ?? 0} actualizados` +
          (r.errores ? `, ${r.errores} con error` : '') + (hayMas ? ' (continúa)' : '');
      }
      if (progresoBarra) {
        // resultado.creados/actualizados/errores es acumulado real sobre
        // toda la sesión (no solo el lote), así que este % es exacto.
        const procesadas = (r.creados || 0) + (r.actualizados || 0) + (r.errores || 0);
        const pct = totalAImportar ? Math.max(0, Math.min(100, (procesadas / totalAImportar) * 100)) : (hayMas ? 0 : 100);
        progresoBarra.style.width = `${pct}%`;
      }
    });

    mostrarResultado(r, advertencias);
    mostrarPaso('paso-resultado');
  } catch (err) {
    console.error('[migracion] confirmar importación:', err);
    // FIX (auditoría UX etapa 18, Hallazgo 2): si ya se guardó algo antes
    // del corte, avisar que la importación es resumible en vez de sugerir
    // que no pasó nada.
    const parcial = err.progresoParcial;
    const msg = parcial && (parcial.creados || parcial.actualizados)
      ? `Se cortó la conexión, pero ya se guardaron ${parcial.creados ?? 0} creados y ${parcial.actualizados ?? 0} actualizados. Volvé a apretar "Confirmar" para continuar desde ahí.`
      : 'No se pudo confirmar la importación. Volvé a intentar.';
    window.toast?.(msg, 'warning');
    btn.disabled = false;
  } finally {
    progreso.style.display = 'none';
  }
}

// Reabre la sesión (vía accion=reintentar, que limpia error_ejecucion solo
// en las filas que fallaron) y vuelve a correr el mismo loop de confirmación.
// Si el error era por un dato malo en la fila, va a volver a fallar igual —
// para eso primero hay que corregir la fila desde "Revisar".
async function reintentarFallidas() {
  const btn = document.getElementById('btn-reintentar');
  const progreso = document.getElementById('reintentar-progreso');
  btn.disabled = true;
  if (progreso) {
    progreso.style.display = 'block';
    progreso.textContent = 'Reintentando filas con error...';
  }

  try {
    await migApi('/api/migracion?accion=reintentar', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: estado.sesionId }),
    });

    const { r, advertencias } = await ejecutarLoteConfirmacion((r, hayMas) => {
      if (progreso) {
        progreso.textContent = `Reintentando… ${r.creados ?? 0} creados, ${r.actualizados ?? 0} actualizados` +
          (r.errores ? `, ${r.errores} con error` : '') + (hayMas ? ' (continúa)' : '');
      }
    });

    mostrarResultado(r, advertencias);
  } catch (err) {
    console.error('[migracion] reintentar importación:', err);
    const parcial = err.progresoParcial;
    const msg = parcial && (parcial.creados || parcial.actualizados)
      ? `Se cortó la conexión, pero ya se guardaron ${parcial.creados ?? 0} creados y ${parcial.actualizados ?? 0} actualizados. Volvé a apretar "Reintentar" para continuar desde ahí.`
      : 'No se pudo reintentar la importación. Volvé a intentar.';
    window.toast?.(msg, 'warning');
    btn.disabled = false;
  } finally {
    if (progreso) progreso.style.display = 'none';
  }
}

// ─── Deshacer una sesión "completado" desde el historial (migración 161) ──────
// Mismo patrón de loop por lotes que ejecutarLoteConfirmacion, pero invocado
// directamente desde la fila del historial (no depende del `estado` global del
// wizard, porque la sesión a deshacer puede no ser la que está abierta).
// Alcance real (avisado explícitamente al usuario antes de confirmar): solo
// elimina lo que la importación CREÓ. Las filas que actualizaron un registro
// existente no se revierten — eso lo hace la función SQL, acá solo se informa.
async function deshacerSesionHistorial(sesionId, btn) {
  const ok = await window.confirmar(
    'Esto va a <strong>eliminar los registros que esta importación creó</strong>.<br><br>' +
    'Las filas que actualizaron un registro ya existente <strong>no se revierten' +
    ' automáticamente</strong> (quedan como estaban después de la importación) — si alguna ' +
    'te importa, revisala a mano antes de seguir.<br><br>Esta acción no se puede deshacer.',
    { labelOk: 'Sí, deshacer', tipo: 'danger' }
  );
  if (!ok) return;

  btn.disabled = true;
  const textoOriginal = btn.textContent;

  try {
    let r = {}, hayMas = true, vueltas = 0, aviso = null;

    while (hayMas) {
      vueltas++;
      const data = await migApi('/api/migracion?accion=deshacer', {
        method: 'POST',
        body: JSON.stringify({ sesion_id: sesionId }),
      });
      r = data.resultado || {};
      hayMas = !!data.hay_mas;
      if (data.aviso) aviso = data.aviso;
      btn.textContent = `Deshaciendo… ${r.eliminados ?? 0} eliminados` + (hayMas ? ' (continúa)' : '');

      // Salvaguarda: igual que en confirmar, no hacer loop infinito si algo
      // queda trabado sin avanzar nunca.
      if (vueltas > 500) throw new Error('No terminó luego de muchos lotes; revisá la sesión.');
    }

    const partes = [`${r.eliminados ?? 0} registro(s) eliminado(s)`];
    if (r.no_revertibles) partes.push(`${r.no_revertibles} actualización(es) sin revertir`);
    if (r.omitidos) partes.push(`${r.omitidos} omitido(s) (tenían datos relacionados)`);

    window.toast?.(
      `Migración deshecha: ${partes.join(', ')}.`,
      (r.omitidos || r.no_revertibles) ? 'warning' : 'success'
    );
    if (aviso) window.toast?.(aviso, 'warning');
  } catch (err) {
    console.error('[migracion] deshacer migración:', err);
    window.toast?.('No se pudo deshacer la migración', 'error');
    btn.disabled = false;
    btn.textContent = textoOriginal;
    return;
  }

  cargarSesionesRecientes(paginaHistorialSesiones);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  // Consolidado: delega a la única fuente de verdad (ui-utils.js).
  return window.sanitize(s);
}

// Vulnerabilidad de "auditoría de mil escenarios": los Excel que generamos
// (informe de migración, errores para corregir) reescriben valores que
// vienen del archivo ORIGINAL que subió la persona — nombre, notas, tipo,
// mensajes de error que citan esos valores, etc. Si una celda del archivo
// original arranca con =, +, -, @, TAB o CR, Excel/Sheets la interpreta como
// fórmula al abrir el .xlsx que nosotros generamos (CSV/XLSX Formula
// Injection, CWE-1236) — puede ejecutar =HYPERLINK(...), tirar de una URL
// externa, o encadenar con DDE. No es hipotético: el dato ya pasó por nuestro
// sistema como texto plano (nombre de cliente, notas, etc.), así que un
// archivo de origen hostil o simplemente mal tipeado (alguien escribe
// "-5% desc" en notas) alcanza para que el .xlsx de salida quede armado.
// Mitigación estándar (OWASP): si el valor empieza con uno de esos
// caracteres, se antepone un apóstrofo — Excel lo muestra tal cual, como
// texto, en vez de evaluarlo.
const PREFIJOS_FORMULA_PELIGROSOS = new Set(['=', '+', '-', '@', '\t', '\r']);
function celdaSegura(valor) {
  if (valor === null || valor === undefined) return valor;
  const s = String(valor);
  if (s.length && PREFIJOS_FORMULA_PELIGROSOS.has(s[0])) return `'${s}`;
  return valor;
}
// Aplica celdaSegura a cada valor de una matriz de filas (array de arrays),
// dejando encabezados/números intactos donde corresponda — se usa antes de
// aoa_to_sheet en cualquier exportación que incluya datos del archivo
// original o mensajes que los citen.
function filasSeguras(matriz) {
  return matriz.map(fila => fila.map(celdaSegura));
}

// ─── Superadmin: sesiones de todos los tenants ────────────────────────────────
const ESTADO_LBL_MIG = {
  error: 'Error', confirmando: 'Confirmando', mapeado: 'Mapeado', validado: 'Validado',
  subido: 'Subido', completado: 'Completado', cancelado: 'Cancelado',
  deshaciendo: 'Deshaciendo', deshecho: 'Deshecho',
};

async function cargarSuperadminMig() {
  const tbody = document.getElementById('tbody-superadmin-mig');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-light,#7A857E);">Cargando…</td></tr>';

  try {
    const sb = window.authCtx?.sb;
    const { data, error } = await sb.rpc('migracion_superadmin_resumen');
    if (error) throw error;

    const filas = data || [];
    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-text-light,#7A857E);">Todavía no importaste ningún archivo. Subí una planilla arriba para empezar.</td></tr>';
      return;
    }

    tbody.innerHTML = filas.map(f => {
      const esError = f.estado === 'error';
      const estadoStyle = esError ? 'color:var(--color-danger,#7A2820);font-weight:700;' : '';
      const fecha = f.created_at
        ? new Date(f.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '—';
      return `
        <tr style="border-bottom:1px solid var(--color-border-soft,#E7E9E4);">
          <td style="padding:8px 10px;">${escapeHtml(f.empresa_nombre || '—')}</td>
          <td style="padding:8px 10px;">${escapeHtml(f.entidad || '—')}</td>
          <td style="padding:8px 10px;${estadoStyle}">${escapeHtml(ESTADO_LBL_MIG[f.estado] || f.estado || '—')}</td>
          <td style="padding:8px 10px;text-align:left;">${f.total_filas ?? 0}</td>
          <td style="padding:8px 10px;text-align:left;color:var(--color-success,#487050);">${f.filas_validas ?? 0}</td>
          <td style="padding:8px 10px;text-align:left;${f.filas_con_error ? 'color:var(--color-danger,#7A2820);font-weight:700;' : ''}">${f.filas_con_error ?? 0}</td>
          <td style="padding:8px 10px;font-size:11px;color:var(--color-text-muted,#5B6660);">${fecha}</td>
        </tr>`;
    }).join('');
  } catch (e) {
    console.error('[migracion] render tabla:', e);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--color-danger,#7A2820);">No se pudo cargar la información.</td></tr>`;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  await window.authReady;
  document.getElementById('topbar-usuario').textContent = window.authCtx?.perfil?.nombre || '';
  await cargarSesionesRecientes();

  // Deep-link desde la alerta "Migración con filas pendientes de resolver"
  // de la campanita (handleAlertas, admin.js sección 3): antes el link
  // mandaba a la página genérica sin filtrar; ahora busca la fila puntual
  // en el historial recién cargado, la enfoca y la resalta un momento.
  const sesionIdParam = new URLSearchParams(location.search).get('sesion_id');
  if (sesionIdParam) {
    const fila = document.querySelector(`.mig-sesion-row[data-sesion-id="${sesionIdParam}"]`);
    if (fila) {
      fila.scrollIntoView({ behavior: 'smooth', block: 'center' });
      fila.style.outline = '2px solid var(--color-warning, #8A5F13)';
      fila.style.outlineOffset = '2px';
      fila.style.transition = 'outline-color 1.2s ease 1.5s';
      setTimeout(() => { fila.style.outlineColor = 'transparent'; }, 1600);
    }
  }

  // Si el usuario es superadmin, mostrar el panel de todos los tenants
  try {
    const sb = window.authCtx?.sb;
    const { data: esOwner } = await sb.rpc('is_saas_owner');
    if (esOwner === true) {
      const panel = document.getElementById('panel-superadmin-mig');
      if (panel) {
        panel.style.display = '';
        cargarSuperadminMig();
      }
    }
  } catch {
    // No es superadmin o la función no existe — ignorar silenciosamente
  }
})();
