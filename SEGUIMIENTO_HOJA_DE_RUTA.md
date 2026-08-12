# Seguimiento — Migración al sistema de diseño "Hoja de Ruta"

**Este documento es de estado, no de dirección.** La dirección de diseño (paleta, tipografía, criterio del sello de estado) vive en `DESIGN_SYSTEM_HOJA_DE_RUTA.md`. Acá solo se registra qué está hecho, qué falta, y los próximos pasos concretos. Se actualiza en cada ZIP nuevo.

**Última actualización:** v489 — auditoría de los 28 HTML con `style=""` inline cerrada.

---

## 1. Resumen ejecutivo

| Frente | Hecho | Falta | Estado |
|---|---|---|---|
| CSS de pantalla (77 archivos, hex hardcodeado) | 77 archivos (24 Alta+Media + 53 Baja), ~1195 hex/rgba resueltos | 0 | **Cerrado** |
| Páginas sin ningún CSS con tokens | — | 0 reales (ver 3.1, hallazgo corregido) | Cerrado |
| HTML con `style=""` inline hardcodeado | 28 archivos | 0 | **Cerrado** |
| JS que genera markup con colores hardcodeados | — | 25 archivos | No iniciado |

Fundación (tokens.css, gentelella-tokens.css, el sello de estado como alias de `.badge`) — hecha en Fase 0 (v482), no requiere retrabajo salvo cambio de dirección.

## 2. Checklist general

- [x] Fase 0 — fundación de tokens (v482)
- [x] Prioridad Alta (14 archivos) — cerrada v483–v486
- [x] Prioridad Media (10 archivos, 16–31 hex c/u) — cerrada v487
- [x] Prioridad Baja (53 archivos, <16 hex c/u) — cerrada v488
- [x] Auditoría de `style=""` inline en 28 HTML — **cerrada v489**
- [ ] Auditoría de colores hardcodeados en 25 JS que generan markup

## 3.5 Auditoría HTML inline (v489) — resumen

Los 28 HTML tenían dos problemas mezclados, no solo hex crudo:

1. **`var(--token-falso, #hex)` — tokens que nunca existieron** (bug real, no solo cosmético: al no existir el custom property, el navegador siempre renderiza el fallback hex). Encontrados: `--color-bg-alt`, `--color-bg-alt2`, `--color-bg-card`, `--color-bg-muted`, `--color-hover`, `--color-neutral-bg`, `--color-surface2`, `--color-text-secondary`, `--texto-secundario` — todos remapeados a su token real equivalente (`--color-surface-2`, `--color-surface`, `--color-text-muted`, etc.), en 18 archivos.
2. **`var(--token-real, #hex)` con fallback inerte** — mismo patrón ya visto en `login.css`/`a11y-focus.css`: el token real ya existe y funciona, pero quedó un fallback hex (a veces de la paleta vieja, ej. `rgba(37,99,235,...)`) sin sentido. Se limpiaron todos (incluyendo dos casos de `--ge-teal-dark`/`--ge-teal-light` en `cajas.html`).
3. **Hex/rgba crudos fuera de `var()`** (~130 casos): mapeo mecánico por propiedad (`color`/`background`/`border`) a los tokens semánticos de `tokens.css` (texto, superficie, éxito/alerta/peligro/info) y a `--ge-*`/`--nav-*` donde el contexto era gentelella o un pill de sección. Overlays de modal `rgba(0,0,0,X)` → `rgba(22,24,29,X)` (mismo mapeo de tinta ya usado en `tienda-nav.css`). Se corrigió además un fallback roto con typo (`var(--color-primary,.#185FA5)` en `clientes.html`).

**Excepción intencional que queda con hex:** verde de marca WhatsApp (`#25D366`) en `clientes.html`, igual que en el CSS.

## 3. Prioridad Baja — resumen de lo cerrado en la pasada v488

Mismo patrón detectado y corregido en toda la Baja:

- **Reemplazo mecánico `#fff`/`#FFF`/`#ffffff` → `var(--ge-panel)`** en los 39 archivos `*-gentelella.css` del lote.
- **Casos especiales no-boilerplate** resueltos archivo por archivo: `stock-gentelella.css` (`--ge-text, #333` → `--ge-ink-soft`), `compras-gentelella.css` (badge morado → `--ge-purple` con `color-mix`), `cobranzas-gentelella.css` y `devoluciones-gentelella.css` (rojo oscuro → `color-mix(var(--ge-red), black)`), `soporte-gentelella.css` (azul hover → `color-mix(var(--ge-blue), white)`; verde WhatsApp hover queda intencional), `auditoria-gentelella.css` (fallback `--ge-teal, #2563EB` → `--ge-teal` limpio).
- **`rgba()` de paleta vieja en decimal** (invisibles al grep de hex): `rgba(38,185,154,X)` (turquesa viejo) y `rgba(37,99,235,X)` (azul viejo) → `rgba(184,122,0,X)`, encontrados y corregidos en 10 archivos, incluyendo dos que la tabla marcaba con "0 hex" (`gentelella-fkpi.css` y el chequeo confirmó `notif-log-gentelella.css`/`empresa-config-gentelella.css` limpios).
- **Archivos "otros" (tokens `--color-*`)**: `tema-claro-shipp.css` (reskin local de Pedidos — tokens propios en `:root` quedan intencionales; solo se corrigió el verde viejo suelto y una duplicación de navy), `tienda-nav.css`, `pagination.css`, `skeletons.css`, `whatsapp-widget.css` (verde WhatsApp de marca queda intencional), `a11y-focus.css` (`--ring` pisaba el token real, mismo patrón que `login.css`), `base-layout.css` (shared y admin, gradientes radiales con verde viejo), `portal.css`, `rutas-resumen.css`, `pedido-modal-fullscreen.css` (overlay `rgba(15,23,42,X)` → `rgba(22,24,29,X)`, mismo mapeo usado en `tienda-nav.css`).

**Excepciones documentadas que quedan con hex a propósito** (no son deuda pendiente):
- `stock-gentelella.css` líneas 157/161: mini-badges de contraste sobre card oscura lateral (`#fdb072`/`#6fe3b4`).
- `soporte-gentelella.css` / `whatsapp-widget.css`: verde de marca WhatsApp (`#25D366`/`#1ebe57`).
- `tema-claro-shipp.css`: paleta propia del reskin de Pedidos en su `:root`.

## 4. Próximos pasos sugeridos (en orden)

1. **Los 25 JS con colores hardcodeados** — único frente que queda. Es el más lento: a veces es un `style=""` armado en un template string (mismo tratamiento que se le dio a los HTML), a veces es config de gráfico (series de ECharts) donde el color no necesariamente debería tokenizarse 1:1. Conviene primero listar los 25 archivos reales (grep de `#[0-9a-fA-F]{3,6}` y `rgba(` sobre `frontend/**/*.js`) antes de arrancar, igual que se hizo con la tabla de CSS y la lista de HTML.

## 5. Para retomar en otra sesión

1. Leer este documento completo (estado) y `DESIGN_SYSTEM_HOJA_DE_RUTA.md` (dirección/criterio).
2. Seguir con la sección 4 de acá, en orden.
3. Al terminar cada archivo/frente: recontar y actualizar este documento antes de subir el ZIP nuevo.
