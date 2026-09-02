# v1014 — Captura de competencia: pantalla de revisión + cierre de pendientes de infraestructura (2026-08-30)

Continúa v1013 (backend de Fase 1 / Capa 2 del `PLAN_CAPTURA_COMPETENCIA.md`).
De los 3 pendientes que quedaban abiertos en ese changelog, este cierra los
primeros dos:

## 1. Migraciones aplicadas contra producción

- 551 y 552 ya estaban aplicadas en el proyecto Supabase real desde una
  sesión anterior (con nombres `551_captura_competencia_base` /
  `552_captura_competencia_matching_y_bucket`, ligeramente distintos a los
  del ZIP pero mismo contenido).
- Se verificó y corrigió un hallazgo de esa aplicación: `GRANT EXECUTE` de
  `fn_captura_matchear_producto` había quedado abierto a `anon`/`PUBLIC`,
  fuera de la convención de higiene del repo (revocar esos roles de RPCs
  internas, patrón de la migración 420). No era una fuga real — la función
  es `SECURITY INVOKER` y la policy de `productos` filtra por
  `get_empresa_id()` de la sesión real, así que un `anon` sin sesión
  siempre obtiene 0 filas — pero se corrigió igual (migración 553) para no
  dejar una excepción sin justificar en la base.

## 2. Pantalla de revisión (frontend)

Nueva sección **Captura de competencia** en el admin
(`/admin/captura-competencia`, dentro de "Ventas" en el menú — mismo
alcance de roles que Punto de venta: dueño/admin/vendedor).

- **`frontend/admin/captura-competencia.html`** + **`js/captura-competencia.js`**
  (nuevos): lista de capturas con filtro por estado → modal "Nueva
  captura" (foto → `accion=crear`) → panel lateral de revisión con:
  - Foto de la factura (con zoom) y metadatos (vendedor, proveedor, fecha).
  - Cada renglón con badge de confianza de color (verde ≥85%, amarillo
    ≥50%, rojo por debajo, gris sin match) y el texto crudo del OCR/visión
    siempre visible (plan 1.5) — nunca se oculta aunque el match sea de
    confianza alta.
  - Corrección manual de producto (buscador contra `/api/pos/productos`,
    ya existente — no se agregó ningún endpoint de búsqueda nuevo),
    cantidad y precio propio, con guardado automático por campo
    (`accion=confirmar_item`).
  - Botón "Cerrar cotización" (`accion=cerrar`): si el backend rechaza por
    piso de margen o renglones sin producto asignado (409), la pantalla
    resalta en rojo los renglones afectados con el motivo puntual en vez
    de un error genérico.
  - Una vez cerrada: totales/ahorro + conversión en cliente (existente,
    buscador contra `/api/clientes`, o alta nueva con razón social) +
    pedido, reutilizando `accion=convertir` tal cual la dejó v1013.
- **`nav-data.js`** / **`vercel.json`**: entrada de menú y rewrite de la
  ruta limpia, mismo patrón que el resto de las secciones de Ventas.

### Ajustes de backend necesarios para poder construir la pantalla

La pantalla de revisión expuso dos límites del backend de v1013 que no
alcanzaban para armar la UI — se corrigieron en
`lib/repos/captura-competencia.js` / `lib/handlers/captura-competencia.js`:

- `obtenerCapturaDetalle` no traía el nombre del producto matcheado (solo
  `producto_id`), así que no había forma de mostrar contra qué se estaba
  comparando cada renglón sin otra consulta. Ahora embebe
  `productos(id, nombre, precio_base, costo, unidad)` (patrón ya usado en
  el proyecto, ej. `pedido_items(*, productos(...))` en remitos).
- `listarCapturasPendientes` filtraba siempre por `vendedor_id`, incluso
  para dueño/admin — contradecía el propio comentario del código en
  `permisos-service.js` ("dueño/admin pueden auditar/revisar cualquier
  captura de la empresa"). Ahora el handler solo aplica ese filtro cuando
  `perfil.rol === 'vendedor'`; dueño/admin ven la bandeja completa de la
  empresa (con columna "Vendedor" agregada en la tabla para poder
  distinguir de quién es cada una).

## Pendiente para cerrar Fase 1

- Tests: fixtures con fotos reales de remitos de proveedores locales, E2E
  Playwright del flujo completo (foto → revisión → cierre → conversión), y
  test específico de que el piso de margen nunca se pisa — ni por cálculo
  ni por edición manual del vendedor en la pantalla de revisión (plan 1.6).
- Feature flag para el piloto (plan 1.7) — todavía no se agregó ninguno;
  la sección quedó visible directamente para dueño/admin/vendedor. Definir
  con el dueño si se quiere restringir a un grupo piloto antes de
  habilitarla para todos los vendedores.
