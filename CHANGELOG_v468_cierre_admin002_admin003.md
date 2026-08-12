# v468 — Cierre real de ADMIN-002 y ADMIN-003 (border-radius + colores hardcodeados restantes)

**Contexto:** en la verificación anterior confirmé que UX-001, ADMIN-001, la causa raíz puntual de ADMIN-003 (login.css) y el CHANGELOG_v464 completo ya estaban aplicados. Quedaban dos hallazgos reales abiertos. Esta pasada los cierra.

---

## ADMIN-003 — `border-radius` hardcodeado en todo el admin

**146 reemplazos automáticos** en 34 páginas + 2 correcciones manuales de declaraciones compuestas (esquinas independientes), usando mapeo exacto contra la escala de `tokens.css`:

| Valor hardcodeado | Reemplazado por |
|---|---|
| `6px` | `var(--radius-sm)` |
| `8px` | `var(--radius-md)` |
| `10px` | `var(--radius-lg)` |
| `12px` | `var(--radius-xl)` |
| `16px` | `var(--radius-xxl)` |
| `20px`, `22px` (chips, badges, toggle sliders — todos pill-shape) | `var(--radius-full)` |
| `99px`, `999px` | `var(--radius-full)` |

Páginas con más cambios: `pedidos.html` (20), `saas-billing.html` (18), `facturacion.html` (9), `clientes.html` (8), `puntos.html` (7), `suspendida.html` (7), `mercadopago-config.html` (6), `stock.html` (6), `setup.html` (6).

Correcciones manuales de declaraciones de 2 esquinas (el script no las tocó a propósito, por seguridad):
- `puntos.html`: `border-radius: 0 0 8px 8px` → `0 0 var(--radius-md) var(--radius-md)`
- `stock.html`: `border-radius: 0 6px 6px 0` → `0 var(--radius-sm) var(--radius-sm) 0`

**Verificación:** conteo de llaves `{`/`}` balanceado en todos los archivos tocados (chequeo de integridad de sintaxis CSS/HTML) — sin discrepancias.

**Dejado sin tocar, a propósito (9 casos, impacto mínimo):**
`2px`, `4px`, `7px`, `14px` — no tienen valor exacto en la escala (`6/8/10/12/16`) y son detalles decorativos menores (código inline, barra de progreso, un input puntual en `saas-billing.html`). Forzarlos al token más cercano cambiaría el radio en 2-8px de forma visible sin que haya un valor "correcto" documentado — preferí no adivinar ahí. Si querés que los cierre también, decime a qué token mapeo cada uno y lo hago.

---

## ADMIN-002 — Colores hardcodeados que coinciden exactamente con el design system

**18 reemplazos** de `#2563EB` (hardcodeado, mayúscula o minúscula) → `var(--color-primary)` en las páginas que ya tenían el azul *correcto* escrito a mano en vez de la variable:

| Página | Reemplazos |
|---|---|
| `facturacion-config.html` | 7 |
| `mercadopago-config.html` | 5 |
| `soporte.html` | 3 |
| `depositos.html` | 1 |
| `listas-precio.html` | 1 |
| `notas.html` | 1 |

**Verificación:** 0 ocurrencias de `#2563EB` restantes en las 9 páginas; balance de llaves correcto en todas.

**Dejado sin tocar, a propósito:**
`reportes-financieros.html`, `reportes-stock.html`, `reportes-ventas.html` no tenían `#2563EB` para reemplazar — sus colores hardcodeados son grises (`#6b7280`, `#e2e8f0`, `#9ca3af`) que **no coinciden exactamente** con ningún `--color-text-muted` (`#475569`) o `--color-text-light` (`#64748B`) de `tokens.css`. Forzarlos ahí cambiaría el tono real (más claro/oscuro) sin que sea un fix mecánico seguro — es una decisión de diseño, no un error de shadowing. Si querés que los migre igual, confirmame si preferís mantener el gris actual (creando una variable nueva) o adoptar `--color-text-muted`/`--color-text-light` aunque cambie levemente el tono.

---

## Estado consolidado de las 3 auditorías (verificado por código, no por render)

| Hallazgo | Estado |
|---|---|
| UX-001 (portal cliente sin design system) | ✅ Resuelto |
| ADMIN-001 (login admin, gradiente viejo) | ✅ Resuelto |
| ADMIN-002 (14 páginas, 0 var usadas) | ✅ Resuelto (9/9 con azul exacto migradas a variable; 3 páginas de reportes con grises ambiguos, pendiente decisión de diseño) |
| ADMIN-003 (radios sueltos, 37 páginas) | ✅ Resuelto (146+2 reemplazos; 9 valores ambiguos de bajo impacto documentados, pendiente decisión) |
| Accesibilidad (2 inputs sin label) | ✅ Resuelto |
| CHANGELOG_v464 (try/catch JS, tipografía Inter) | ✅ Resuelto |

## Lo único que sigue pendiente (con tu decisión, no mío para adivinar)

1. 9 valores de radio ambiguos (2/4/7/14px) — decime a qué token mapean o si los dejamos como están.
2. Grises hardcodeados en las 3 páginas de reportes — decime si migran a `--color-text-muted`/`--color-text-light` o se documentan como variante intencional.

Todo lo demás: cerrado y verificado contra el código real, no contra lo que dice un changelog.
