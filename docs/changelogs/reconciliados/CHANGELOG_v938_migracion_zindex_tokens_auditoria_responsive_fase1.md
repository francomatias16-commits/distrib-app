# CHANGELOG v938 — Migración de z-index hardcodeados a variables (P2, auditoría responsive Fase 1)

**Fecha:** 2026-08-22
**Contexto:** Punto P2 pendiente de `AUDITORIA_RESPONSIVE_MOBILE.md` (hallazgo 1.9), después
de cerrar P1 (fix de breakpoints faltantes en 5 páginas).

## Qué se hizo

### 1) Extensión de la escala de z-index en `frontend/shared/tokens.css`

Se agregaron 19 variables nuevas (`--z-panel`, `--z-panel-2`, `--z-popover`,
`--z-modal-backdrop`, `--z-nav-panel`, `--z-flyout`, `--z-chat-widget`,
`--z-mnav-overlay`, `--z-mnav-panel`, `--z-mnav-toggle`, `--z-cobranzas-overlay`,
`--z-modal-stack-1/2/3`, `--z-rutas-toggle`, `--z-super-overlay`,
`--z-super-overlay-content`).

Cada variable nueva vale **exactamente** el número que ya estaba hardcodeado en el
código — no se renumeró nada. El objetivo fue solo centralizar los números mágicos
en variables con nombre, sin tocar el orden de stacking real: riesgo visual cero.

### 2) Migración de 26 archivos CSS

Reemplazado `z-index: NNN` por `z-index: var(--z-...)` en:

- **admin/css:** clientes, compras, finanzas, stock, productos, pedidos,
  facturacion, gastos-generales-gentelella, reglas-precio-gentelella, login,
  rutas, nav, automatizacion, devoluciones-gentelella, cobranzas-gentelella,
  productos-modal-fix, rutas-professional, stock-overview
- **cliente/css:** carrito, catalogo, login, pedidos
- **chofer/css:** remito
- **shared:** chat-widget, skeletons, tienda-nav

Los `9999`/`10000`/`10001`/`10002` de `productos-modal-fix.css` (panel de producto +
overlay de vincular-celular + modal de Receta/BOM + toast) se mapearon a las
variables `--z-overlay-critical` / `--z-modal-anidado-1/2/3` que ya existían en
`tokens.css` desde P1 pero todavía no se habían aplicado — encajaban exacto con la
escalada de 4 niveles que ese archivo ya documentaba.

### 3) Antes de migrar: descarte de falsos positivos

El grep inicial de `z-index\s*:\s*[0-9]` marcaba ~90 coincidencias en 47 archivos,
pero muchas eran **menciones dentro de comentarios** (`clientes-gentelella.css`,
`notas-gentelella.css`, `vencimientos-gentelella.css`, `cheques-gentelella.css`,
`riesgo-cheques-gentelella.css` no tenían ninguna declaración real de z-index, solo
comentarios que explican bugs de otras páginas). Se filtró con un parser que
descarta el contenido de `/* ... */` antes de buscar, dejando la lista real en
26 archivos.

### 4) Excluido a propósito (fuera de alcance de este punto)

- **`landing/styles.css`** y **`landing/modulos/styles.css`**: son bundles con
  Tailwind minificado que NO cargan `tokens.css` — un `var(--z-...)` ahí resolvería
  a `unset` y rompería el layout. Conservan sus números hardcodeados (`z-index:1000`,
  `1100`, etc. del botón/modal de instalación PWA).
- **`shared/whatsapp-widget.css`** (`z-index:589`): confirmado que no lo referencia
  ningún `.html`/`.js` del proyecto — código muerto. Queda para limpieza en P3, no
  vale el riesgo de tocar un archivo sin uso real.
- **`mobile-hero-v935.css`** (88 `!important`): NO se tocó. El archivo mismo
  documenta por qué vive separado de `styles.css` (v934 intentó consolidar ahí y
  perdió la guerra de especificidad de forma impredecible). Reducir/consolidar sus
  `!important` sigue marcado como riesgoso sin QA visual — queda pendiente,
  deliberadamente fuera de este punto.

### 5) Cache-busting

Se incrementó en +1 el `?v=NNN` de cada archivo modificado en las páginas `.html`
que lo referencian (310 bumps en total). Se detectó y corrigió un bug propio del
script de bump: coincidencias de substring (`nav.css` dentro de
`gentelella-nav.css`, `tokens.css` dentro de `gentelella-tokens.css`, y
`pedidos.css` duplicado en la lista de archivos a bumpear) que habían alterado
versiones de archivos no tocados o duplicado el incremento. Se verificó
sistemáticamente contra el ZIP original que el delta de cada `?v=` es exactamente
+1 para los 26 archivos modificados y 0 para el resto, y que no quedó ningún otro
cambio fuera de esos parámetros de versión.

## Verificación

- Balance de llaves `{`/`}` OK en los 26 archivos.
- `tokens.css` carga antes que cada archivo modificado en todas las páginas que
  lo referencian (orden de cascada correcto).
- Ningún `z-index` numérico ≥40 real (fuera de comentarios) sin migrar, salvo
  `whatsapp-widget.css` (código muerto, ver arriba).
- Diff sistemático original-vs-actual de los 143 `.html`: 0 diferencias fuera de
  los `?v=` esperados.

## Pendiente

- P2 (resto): reducir `!important` de `mobile-hero-v935.css` — requiere QA visual,
  explícitamente no abordado acá.
- P3: código muerto en `pos.css` + `shared/whatsapp-widget.css` sin referenciar.
