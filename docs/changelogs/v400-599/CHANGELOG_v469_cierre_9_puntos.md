# v469 — Cierre de los 9 puntos ambiguos (radio + grises)

## Radios (9 ocurrencias en 6 archivos) — todos tokenizados con criterio de contexto

| Archivo | Antes | Contexto | Ahora |
|---|---|---|---|
| `conciliacion-bancaria.html` | `2px` (barra de 4px alto) | barra de progreso fina | `var(--radius-full)` (esquinas totalmente redondeadas de una barra fina) |
| `cc-proveedores.html` | `4px` | input de tabla | `var(--radius-sm)` |
| `facturacion-config.html` | `4px` | `<code>` inline | `var(--radius-sm)` |
| `mercadopago-config.html` | `4px` | `<code>` inline | `var(--radius-sm)` |
| `puntos.html` (línea 202) | `4px` | badge/tag chico | `var(--radius-sm)` |
| `saas-billing.html` (línea 63) | `4px` | `<code>` inline | `var(--radius-sm)` |
| `saas-billing.html` (línea 140) | `7px` | input de formulario | `var(--radius-md)` |
| `puntos.html` (línea 136) | `14px` | modal/caja grande | `var(--radius-xxl)` |
| `saas-billing.html` (línea 131) | `14px` | modal/caja grande | `var(--radius-xxl)` |

**Verificación:** 0 valores de `border-radius` numéricos hardcodeados en todo `frontend/admin/*.html` (fuera de `border-radius: 0` legítimo en un modal fullscreen, y los `50%` de círculos/avatares, que no corresponden a la escala).

## Grises hardcodeados en páginas de reportes

- **`reportes-stock.html`** → `#6b7280` → `var(--color-text-light)`, `#e2e8f0` → `var(--color-border)` (mismo patrón que usa `.input-base` en `tokens.css` para selects/inputs).
- **`reportes-financieros.html`** y **`reportes-ventas.html`** → no tenían ningún color hardcodeado — no había nada que migrar ahí. La métrica de "0 var(--color-*) usados" en la auditoría original no era un bug en estos dos casos puntuales, simplemente no tienen estilos de color propios.

## Hallazgo nuevo, fuera del alcance de "los 9 puntos" — reporto, no toqué

Al verificar encontré que `#6b7280` (el mismo gris que acabo de tokenizar en `reportes-stock.html`) también aparece hardcodeado, con el mismo patrón (`.cfg-card .sub`, textos "Cargando…", links de vuelta), en **11 páginas más**: `cajas.html`, `cc-proveedores.html`, `empresa-config.html`, `facturacion-config.html`, `mercadopago-config.html`, `migracion.html`, `proveedores.html`, `saas-billing.html`, `soporte.html`, `superadmin.html`, `usuarios.html`.

Es un patrón sistémico (parece un componente `cfg-card` compartido, copiado y pegado con el color a mano en vez de la variable), pero es una decisión más grande que "cerrar 9 puntos puntuales" — implica declarar que `#6b7280` = `var(--color-text-light)` como estándar en todo el proyecto. No lo toqué sin que lo confirmes, para no exceder lo que me pediste. Si querés que lo cierre también, lo hago en la próxima pasada.

## Verificación de integridad

Balance de llaves `{`/`}` correcto en los 7 archivos tocados en esta ronda (`conciliacion-bancaria`, `cc-proveedores`, `facturacion-config`, `mercadopago-config`, `puntos`, `saas-billing`, `reportes-stock`) — sin discrepancias.

---

## Estado final de las 3 auditorías

Todo lo documentado en `AUDITORIA_UX_ADMIN.md`, `AUDITORIA_UX_PORTAL_CLIENTE.md` y `CHANGELOG_auditoria_admin_v464.md` está aplicado y verificado contra el código real. El único punto abierto es el hallazgo nuevo de arriba (11 páginas con el mismo gris hardcodeado), que descubrí en el camino y no estaba en ninguna de las tres auditorías originales.
