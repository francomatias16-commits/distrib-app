/**
 * nav-data.js — Estructura de los 8 espacios de trabajo.
 * Fuente única de verdad para la navegación de toda la app admin.
 * Usado por nav.js (desktop) y nav-mobile.js (mobile) para renderizar.
 *
 * Campo `roles`: qué roles pueden ver este espacio.
 *   null / ausente → todos los roles admin tienen acceso.
 *   ['dueno','admin'] → solo esos roles ven el ícono en el riel.
 *
 * Campo `color` vs `textColor` (WCAG fix v249-contraste):
 *   `color`     → fondo sólido del ícono activo en el riel oscuro/blanco
 *                 y color de acento del drawer mobile (fondo oscuro fijo).
 *                 Ahí alcanza con 3:1 (ícono blanco sobre color sólido).
 *   `textColor` → color de TEXTO plano sobre el panel blanco (título del
 *                 panel y link de sección activo). Varios de los acentos
 *                 de `color` (ventas, depósito, cobros, reportes) no
 *                 llegan a 4.5:1 usados como texto sobre blanco, así que
 *                 `textColor` apunta a una variante más oscura del mismo
 *                 tono (ver --nav-*-text en nav.css / --color-box-* en
 *                 tokens.css). Usar siempre `textColor` para texto y
 *                 `color` para fondos sólidos.
 */

window.NAV_WORKSPACES = [
/*
 * NOTA DE DISEÑO — /admin/compras:
 * (Actualizado — auditoría UX) Esta nota quedó desactualizada: FIX 092 ya
 * agregó 'Compras' como sección propia del workspace 'deposito' (ver más
 * abajo), con vista global de todas las OC sin filtrar por proveedor.
 * El atajo directo desde la ficha de cada proveedor (botón "Compras",
 * /admin/compras?proveedor=...) se mantiene además, sin conflicto.
 */
  {
    id:    'hoy',
    label: 'Panel principal',
    href:  '/admin/dashboard',
    color: 'var(--nav-hoy)',
    textColor: 'var(--nav-hoy-text)',
    roles: null,   /* todos */
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>`,
    secciones: [],   /* pantalla única — sin sub-secciones */
  },
  {
    id:    'ventas',
    label: 'Ventas',
    color: 'var(--nav-ventas)',
    textColor: 'var(--nav-ventas-text)',
    // 'contador' agregado (pedido del dueño): solo va a ver "Descuentos
    // automáticos" acá adentro (única sección de Ventas con ese rol) —
    // reemplaza el acceso que tenía desde Facturación.
    roles: ['dueno', 'admin', 'vendedor', 'contador'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
              <rect x="9" y="3" width="6" height="4" rx="1"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>`,
    secciones: [
      { label: 'Punto de venta', href: '/admin/pos',          seccion: 'pos',          diario: true,
        roles: ['dueno', 'admin', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M16 10a4 4 0 0 1-8 0"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
      { label: 'Cajas',            href: '/admin/cajas',   seccion: 'cajas',        diario: true,
        // FIX auditoría UX: cierre de caja con arqueo es tarea de todos los
        // días (flujo "conciliación de caja al final del día"), no ocasional.
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M16 10a4 4 0 0 1-8 0"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
      { label: 'Pedidos y presupuestos', href: '/admin/pedidos', seccion: 'pedidos',
        roles: ['dueno', 'admin', 'vendedor', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 12 2 2 4-4"/></svg>` },
      { label: 'Conversaciones WhatsApp', href: '/admin/whatsapp-conversaciones', seccion: 'whatsapp-conversaciones', diario: true,
        roles: ['dueno', 'admin', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>` },
      { label: 'Repartos',      href: '/admin/rutas',         seccion: 'rutas',
        roles: ['dueno', 'admin', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>` },
      { label: 'Clientes',      href: '/admin/clientes',      seccion: 'clientes',
        roles: ['dueno', 'admin', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` },
      // FIX auditoría UX: las reglas de precio (descuentos automáticos por
      // volumen/zona/temporada) son una validación del pedido y conceptualmente
      // pertenecen a Ventas, aunque la pantalla vive físicamente en Facturación
      // (mismo href/seccion — se duplica el acceso, no la pantalla).
      { label: 'Descuentos automáticos', href: '/admin/reglas-precio', seccion: 'reglas-precio',
        roles: ['dueno', 'admin', 'vendedor', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>` },
      // v1013/v1014 — Fase 1 (Capa 2, MVP) de PLAN_CAPTURA_COMPETENCIA.md:
      // el vendedor de campo saca la foto en el mostrador, así que necesita
      // el mismo acceso que a Punto de venta / Clientes.
      // (Antes vivía detrás de `flag: 'captura_competencia_habilitada'` para
      // activación gradual por empresa (piloto de vendedores). Pedido
      // directo: ahora visible siempre, para todas las empresas, sin
      // depender de esa clave en empresas.config.)
      // Fusión UX (mismo criterio que 'Cobros y saldos pendientes'): "Captura
      // de competencia" y "Prospección de competencia" (Fase 3, Capa 1 de
      // PLAN_CAPTURA_COMPETENCIA.md) dejaron de ser dos secciones de menú
      // separadas — son dos pestañas de la misma puerta de entrada
      // (/admin/captura-competencia, ver cambiarVistaPrincipal). El link de
      // menú entra siempre por la pestaña "Captura"; /admin/prospectos-competencia
      // quedó como redirect a ?vista=prospeccion para no romper bookmarks.
      { label: 'Captura de competencia', href: '/admin/captura-competencia', seccion: 'captura-competencia',
        roles: ['dueno', 'admin', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>` },
      // FIX (pedido del dueño): "Zonas de reparto" dejó de ser una sección
      // aparte del menú — es un ABM chico (nombre + días) que ahora vive
      // como pestaña "Zonas" dentro de Repartos (/admin/rutas), al lado de
      // Resumen/Armar ruta/Seguimiento/Historial. /admin/zonas se mantiene
      // como redirect a /admin/rutas?tab=zonas (ver vercel.json) para no
      // romper accesos guardados.
      // FIX (pedido del dueño): "Listas de precio" dejó de ser una sección
      // aparte del menú — es un ABM chico (nombre + predeterminada) que
      // ahora vive como pestaña "Listas de precio" dentro de Clientes
      // (/admin/clientes?tab=listas), al lado de Clientes/Precios
      // especiales/Direcciones — mismo criterio que Zonas dentro de
      // Repartos. /admin/listas-precio se mantiene como redirect (ver
      // vercel.json) para no romper accesos guardados.
    ],
  },
  {
    id:    'deposito',
    label: 'Depósito',
    color: 'var(--nav-deposito)',
    textColor: 'var(--nav-deposito-text)',
    roles: ['dueno', 'admin', 'depositero'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.91 8.84 8.56 2.23a1.93 1.93 0 0 0-1.81 0L3.1 4.13a2.12 2.12 0 0 0-.05 3.69l12.22 6.93a2 2 0 0 0 1.94 0L21 12.51a2.12 2.12 0 0 0-.09-3.67Z"/>
              <path d="m3.09 8.84 12.35-6.61a1.93 1.93 0 0 1 1.81 0l3.65 1.9a2.12 2.12 0 0 1 .05 3.69L8.74 14.75a2 2 0 0 1-1.94 0L3 12.51a2.12 2.12 0 0 1 .09-3.67Z"/>
              <line x1="12" y1="22" x2="12" y2="11.5"/>
            </svg>`,
    secciones: [
      // FIX (pedido del dueño): "Depósitos" dejó de ser una sección aparte
      // del menú — es un ABM chico (nombre/dirección/responsable/principal)
      // que ahora vive como modal "Depósitos" dentro de Stock (/admin/stock),
      // que es donde realmente se eligen/consumen los depósitos. Mismo
      // criterio que Zonas dentro de Repartos y Listas de precio dentro de
      // Clientes. /admin/depositos se mantiene como redirect (ver
      // vercel.json) para no romper accesos guardados.
      { label: 'Productos',     href: '/admin/productos',     seccion: 'productos',
        roles: ['dueno', 'admin', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>` },
      // FIX (pedido del dueño, 2026-08-23): "Combos" dejó de ser una sección
      // aparte del menú — es una vista chica (mismo patrón visual que la
      // tabla de Productos) que ahora vive como pestaña "Combos" dentro de
      // Productos (/admin/productos?tab=combos), al lado de Productos.
      // Mismo criterio que Zonas dentro de Repartos y Listas de precio
      // dentro de Clientes. /admin/combos se mantiene como redirect (ver
      // vercel.json) para no romper accesos guardados.
      { label: 'Stock',         href: '/admin/stock',         seccion: 'stock',        diario: true,
        roles: ['dueno', 'admin', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>` },
      { label: 'Lotes: por vencer y en oferta', href: '/admin/vencimientos', seccion: 'vencimientos',
        roles: ['dueno', 'admin', 'depositero', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>` },
      { label: 'Devoluciones',  href: '/admin/devoluciones',  seccion: 'devoluciones', diario: true,
        roles: ['dueno', 'admin', 'contador', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h10a4 4 0 0 1 0 8H7"/><polyline points="7 4 3 10 7 16"/></svg>` },
      { label: 'Proveedores', href: '/admin/proveedores',   seccion: 'proveedores',
        roles: ['dueno', 'admin', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2"/></svg>` },
      // FIX 092: PENDIENTES #3 marcado [hecho] pero entrada faltaba del nav (nav-data.js no fue actualizado)
      { label: 'Compras',       href: '/admin/compras',       seccion: 'compras',
        roles: ['dueno', 'admin', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>` },
      { label: 'Lo que le debo a mis proveedores', href: '/admin/cc-proveedores', seccion: 'cc-proveedores',
        roles: ['dueno', 'admin', 'contador', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>` },
      { label: 'Quién me conviene más', href: '/admin/comparador-precios', seccion: 'comparador-precios',
        roles: ['dueno', 'admin', 'contador', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>` },
    ],
  },
  {
    id:    'cobros',
    label: 'Cobros y Pagos',
    color: 'var(--nav-cobros)',
    textColor: 'var(--nav-cobros-text)',
    roles: ['dueno', 'admin', 'contador'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="1" y="4" width="22" height="16" rx="2"/>
              <line x1="1" y1="10" x2="23" y2="10"/>
            </svg>`,
    secciones: [
      { label: 'Cobros y saldos pendientes', href: '/admin/cobranzas', seccion: 'cobranzas',  diario: true,
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>` },
      { label: 'Cruzar con el banco', href: '/admin/conciliacion-bancaria', seccion: 'conciliacion-bancaria',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/><polyline points="9 11 12 14 16 9"/></svg>` },
      { label: 'Cheques',          href: '/admin/cheques',   seccion: 'cheques',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
      { label: 'Cheques a vigilar', href: '/admin/riesgo-cheques', seccion: 'riesgo-cheques',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` },
      { label: 'Notas de crédito y débito', href: '/admin/notas',     seccion: 'notas',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>` },
    ],
  },
  {
    id:    'facturacion',
    label: 'Facturación',
    color: 'var(--nav-facturacion)',
    textColor: 'var(--nav-facturacion-text)',
    roles: ['dueno', 'admin', 'contador'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="2" width="14" height="20" rx="2"/>
              <line x1="9" y1="7" x2="15" y2="7"/>
              <line x1="9" y1="11" x2="15" y2="11"/>
              <line x1="9" y1="15" x2="13" y2="15"/>
            </svg>`,
    secciones: [
      { label: 'Facturas',       href: '/admin/facturacion',        seccion: 'facturacion', diario: true,
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/></svg>` },
      { label: 'Configuración',  href: '/admin/facturacion-config', seccion: 'facturacion-config',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>` },
      { label: 'Enviar a mi contador', href: '/admin/export-contable', seccion: 'export-contable',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>` },
      // FIX (pedido del dueño): se sacó el acceso duplicado a "Descuentos
      // automáticos" desde acá — la pantalla (/admin/reglas-precio) se
      // mantiene solo con acceso desde Ventas (donde vive conceptualmente,
      // ver comentario en esa sección). Sigue siendo la misma pantalla de
      // siempre, no se tocó nada de reglas-precio.html/.js.
    ],
  },
  {
    id:    'fidelizacion',
    label: 'Fidelización',
    color: 'var(--nav-fidelizacion)',
    textColor: 'var(--nav-fidelizacion-text)',
    roles: ['dueno', 'admin'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>`,
    secciones: [
      { label: 'Programa',         href: '/admin/fidelizacion', seccion: 'fidelizacion',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>` },
      { label: 'Puntos clientes',  href: '/admin/puntos',       seccion: 'puntos',      diario: true,
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>` },
    ],
  },
  {
    id:    'reportes',
    label: 'Reportes',
    color: 'var(--nav-reportes)',
    textColor: 'var(--nav-reportes-text)',
    roles: ['dueno', 'admin', 'contador', 'vendedor', 'depositero'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>`,
    secciones: [
      { label: 'Ventas',    href: '/admin/reportes-ventas',      seccion: 'reportes-ventas',  diario: true,
        roles: ['dueno', 'admin', 'contador', 'vendedor'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>` },
      { label: 'Finanzas',  href: '/admin/reportes-financieros', seccion: 'reportes-financieros',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>` },
      { label: 'Estado financiero integral', href: '/admin/estado-financiero', seccion: 'estado-financiero',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>` },
      { label: 'Gastos generales', href: '/admin/gastos-generales', seccion: 'gastos-generales',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>` },
      { label: 'Stock',     href: '/admin/reportes-stock',       seccion: 'reportes-stock',
        roles: ['dueno', 'admin', 'contador', 'depositero'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>` },
      { label: 'Qué zona rinde más', href: '/admin/rentabilidad-zona', seccion: 'rentabilidad-zona',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>` },
      { label: 'Qué producto y vendedor rinden más', href: '/admin/rentabilidad-producto-vendedor', seccion: 'rentabilidad-producto-vendedor',
        roles: ['dueno', 'admin', 'contador'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>` },
    ],
  },
  {
    id:    'config',
    label: 'Configuración',
    color: 'var(--nav-config)',
    textColor: 'var(--nav-config-text)',
    roles: ['dueno', 'admin'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
            </svg>`,
    secciones: [
      { label: 'Datos de la empresa', href: '/admin/empresa-config', seccion: 'empresa-config',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M9 9h1M9 13h1M14 9h1M14 13h1"/></svg>` },
      { label: 'Usuarios', href: '/admin/usuarios', seccion: 'usuarios',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` },
      { label: 'Conectar WhatsApp', href: '/admin/whatsapp-onboarding', seccion: 'whatsapp-onboarding',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>` },
      { label: 'Qué pasó en mi negocio', href: '/admin/auditoria',  seccion: 'auditoria',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><path d="M11 8v3l2 2"/></svg>` },
      { label: 'Importar mis datos', href: '/admin/migracion',  seccion: 'migracion',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>` },
      { label: 'Mercado Pago',   href: '/admin/mercadopago-config', seccion: 'mercadopago-config',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
      { label: 'Etiquetas de precio', href: '/admin/etiquetas-config', seccion: 'etiquetas-config',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 6v12M17 6v12"/></svg>` },
      { label: 'Canales de venta', href: '/admin/canales-venta', seccion: 'canales-venta',
        roles: ['dueno', 'admin'], badge: 'Platinum',
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M21 3l-7.5 7.5"/><path d="M3 21l7.5-7.5"/><circle cx="12" cy="12" r="3"/></svg>` },
      { label: 'Suscripciones SaaS', href: '/admin/saas-billing', seccion: 'saas-billing',
        roles: ['dueno'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
      { label: 'Soporte técnico', href: '/admin/soporte', seccion: 'soporte',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>` },
    ],
  },
  {
    id:    'automatizacion',
    label: 'Alertas automáticas',
    href:  '/admin/automatizacion',
    color: 'var(--nav-hoy)',
    textColor: 'var(--nav-hoy-text)',
    roles: ['dueno', 'admin'],
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.07 4.93A10 10 0 0 0 12 2v10"/>
              <path d="M2 12C2 6.48 6.48 2 12 2"/>
              <path d="M22 12c0 5.52-4.48 10-10 10"/>
              <path d="M12 22v-10"/>
            </svg>`,
    secciones: [
      { label: 'Movimientos raros', href: '/admin/anomalias', seccion: 'anomalias', diario: true,
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` },
      { label: 'Avisos operativos', href: '/admin/avisos', seccion: 'avisos', diario: true,
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>` },
      { label: 'Historial de envíos', href: '/admin/notif-log',  seccion: 'notif-log',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>` },
      { label: 'Salud del sistema', href: '/admin/observabilidad', seccion: 'observabilidad',
        roles: ['dueno', 'admin'],
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>` },
    ],
  },
  // v961 — Grupo propio para el asistente de IA (antes vivía adentro de
  // "Configuración"). Un solo ítem adentro con `accion` (no `href`): no
  // navega, abre el panel de chat-widget.js vía window.abrirAsistenteIA()
  // (ver el listener de clicks en nav.js/dashboard.html). Sin roles: mismo
  // criterio que tenía el botón flotante que reemplaza (visible para
  // cualquier rol con sesión — el propio panel se auto-oculta si no hay
  // sesión). Se renderiza igual que cualquier otro grupo del menú (mismo
  // criterio de `color`/`textColor` que ya usan Alertas/Ventas/etc. — ver
  // renderMenuNavegacion() en nav.js); el único plus es el link un poco
  // más grande, ver `[data-menu-accion="asistente-ia"]` en nav.css.
  {
    id:    'asistente-ia',
    label: 'Asistente',
    color: 'var(--nav-ia)',
    textColor: 'var(--nav-ia-text)',
    roles: null,
    icon:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2 14.09 8.26 20.5 8.27 15.34 12.14 17.18 18.4 12 14.77 6.82 18.4 8.66 12.14 3.5 8.27 9.91 8.26 12 2z"/>
            </svg>`,
    secciones: [
      { label: 'Trabajar con IA', accion: 'asistente-ia', seccion: 'asistente-ia',
        roles: null,
        icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>` },
    ],
  },
];
