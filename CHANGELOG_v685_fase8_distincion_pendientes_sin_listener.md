# v685 — Fase 8: distinguir "pendiente sin listener" de cola atascada

**Contexto:** `PLAN_ERP_SINCRONIZACION_2026.md` marca Fase 8 (observabilidad continua) como cerrada desde
el 2026-08-03 (v599), con un único pendiente anotado: validar contra datos reales de producción si
`MINUTOS_ERROR_PROLONGADO = 120` genera ruido o tarda de más. Se consultó Supabase de producción para
esa validación.

## Hallazgo

- No hay ningún evento en estado `error` en producción — el umbral `MINUTOS_ERROR_PROLONGADO` sigue sin
  poder validarse con un caso real; falta que ocurra un fallo de verdad en algún listener.
- Se encontró en cambio algo más concreto: **3 eventos `pedido_facturado` con más de 4 días en estado
  `pendiente`**, `procesado_en` nulo. No es un bug: `pedido_facturado` y `factura_anulada` tienen, a
  propósito, cero listeners registrados en `lib/eventos-dispatcher.js` (sus efectos ya corren dentro de
  `emitirFactura`/`anularFactura` mismas, no como reacción al evento) — por diseño, estos tipos de evento
  quedan en `pendiente` para siempre.
- El problema real: el panel "Salud del sistema" (`frontend/admin/observabilidad.html`) mostraba estos
  eventos exactamente igual que una cola realmente atascada, sin ninguna aclaración. Es un agujero en la
  observabilidad que la propia Fase 8 recién había cerrado.

## Cambios

- **`lib/eventos-dispatcher.js`** — nuevo export `TIPOS_EVENTO_SIN_LISTENER`, derivado del propio
  `REGISTRO_LISTENERS` (no hardcodeado aparte, así no se puede desincronizar).
- **`lib/handlers/admin.js`** (`handleSaludEventos`) — importa `TIPOS_EVENTO_SIN_LISTENER` con `import()`
  dinámico (no estático arriba del archivo, para no arrastrar una cadena de imports pesada dentro de
  `admin-permisos.test.js`, que mockea `admin.js` con dependencias livianas). Suma `pendiente_sin_listener`
  al resumen y anota `sin_listener: true/false` en el desglose `por_tipo`.
- **`frontend/admin/js/observabilidad.js`** — nota aclaratoria en la card "Pendientes" del resumen
  (`X son de tipos sin listener asignado — trazabilidad, no requiere acción`) y badge "sin listener" junto
  al nombre del tipo en la tabla por-tipo.
- **`frontend/admin/css/observabilidad-gentelella.css`** — estilos para `.obs-card-nota` y
  `.badge-sin-listener`, siguiendo los tokens `--ge-*` ya usados en el resto del reskin.
- **`tests/handlers/eventos-dispatcher.test.js`** — nuevo `describe('TIPOS_EVENTO_SIN_LISTENER ...')`:
  confirma que incluye `pedido_facturado`/`factura_anulada` y excluye los tipos con listener migrado
  (`pedido_creado`, `cliente_en_mora`, `cheques_por_vencer`).

## Alcance y contrato

- No se toca ninguna tabla ni el contrato de `despacharEvento`/`despacharPendientes` — es puramente
  anotación y presentación sobre datos que ya existían.
- No afecta el estado (`procesado`/`error`) que `despacharEvento` deja en `eventos_negocio` — sigue
  reflejando solo los listeners fijos, igual que antes de este cambio.

## Testing

Suite completa: **966/966 OK** (los 964 de v684 + 2 nuevos de `TIPOS_EVENTO_SIN_LISTENER`; los 16 de
`tests/repos/pedidos-creacion.test.js` de v684 quedan intactos).

## Pendiente para adelante

`MINUTOS_ERROR_PROLONGADO = 120` sigue sin validar contra un caso real de `error` en producción — queda
abierto hasta que ocurra un fallo real en algún listener para poder medir si el umbral avisa a tiempo.
