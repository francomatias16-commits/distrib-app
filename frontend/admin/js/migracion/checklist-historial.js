// frontend/admin/js/migracion/checklist-historial.js
// Parte del split de frontend/admin/js/migracion.js (25/08/2026) — Checklist guiado de migración + historial de sesiones recientes.
// Se carga como <script> clásico (no ES module, 'use strict' repetido acá
// porque el pragma es por-script) en migracion.html, en el mismo orden que
// ocupaba en el archivo original, para preservar el scope global compartido
// (variables de estado, funciones). Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

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

