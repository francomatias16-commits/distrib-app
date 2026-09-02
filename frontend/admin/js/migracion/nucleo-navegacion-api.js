// frontend/admin/js/migracion/nucleo-navegacion-api.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Constantes, llamadas a la API, navegación entre pasos del wizard.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

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

