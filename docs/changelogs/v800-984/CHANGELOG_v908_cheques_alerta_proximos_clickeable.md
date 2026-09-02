# v908 — La alerta y el sello "Vencen en 3 días" ahora filtran la tabla de Cheques

## Contexto

Pedido directo: en la pantalla de Cheques, tanto la alerta amarilla
("N cheques vencen en los próximos 3 días — Total: $X") como el sello
"$X — Vencen en 3 días" eran puramente informativos. El propio HTML lo
documentaba: *"Vencen en 3 días... mostrado aparte, sin filtro propio en
la tabla → queda de solo lectura"*. No había forma de ver esos cheques
puntuales — no son un estado propio (subconjunto de "en_cartera" por
fecha) y el checkbox "Solo vencidos" es un criterio distinto (cheques que
YA vencieron, `fecha_vto < hoy`, no los que vencen pronto).

## Cambio

**Backend (`supabase/migrations/513_fn_cheques_lista_filtro_proximos.sql`)**
- Se agrega `p_solo_proximos` a `fn_cheques_lista(...)`, con el mismo
  criterio que ya usa `fn_cheques_contadores()` para `cant_proximos` /
  `monto_proximos` (migración 512): `estado = 'en_cartera' AND
  vencimiento BETWEEN hoy Y hoy+3`.
- Requirió `DROP FUNCTION` + `CREATE` (no `CREATE OR REPLACE`): agregar un
  parámetro nuevo cambia la firma de entrada, y dejar coexistir la firma
  vieja de 5 argumentos con la nueva de 6 hace que cualquier llamado con
  los 5 originales quede ambiguo entre las dos ("function is not
  unique") — mismo tipo de cuidado que ya documentó la migración 512,
  aunque ahí el motivo era el tipo de retorno.

**Frontend**
- `frontend/admin/js/cheques.js`:
  - `cargarCheques()` manda `p_solo_proximos` en cada llamado a
    `fn_cheques_lista`.
  - `mostrarAlertasVencimiento()`: la alerta pasa de `<div>` a `<button>`
    real, con el mismo patrón visual/de interacción que ya usa el banner
    de "caída de score" en `riesgo-cheques.js` (clase
    `.alerta-inline--clickable` + chevron, ya existente en
    `finanzas.css`).
  - `activarFiltroProximos()` (nueva, expuesta en `window`): activa el
    filtro, limpia los otros filtros que quedarían en conflicto (estado,
    "Solo vencidos", pestaña activa — todos vuelven a "Todos"/apagados),
    recarga la tabla y hace scroll + destello visual sobre ella (mismo
    patrón que `irAClientesConAlerta()` en riesgo-cheques.js,
    `.tabla-wrap--flash`).
  - `onFiltroVencidosChange()` (nueva): wrapper del checkbox "Solo
    vencidos" — al tildarlo se desactiva el filtro "próximos" (son
    mutuamente excluyentes, no tiene sentido combinarlos).
  - Las pestañas de estado (`initFiltroTabsCheques`) también desactivan
    "próximos" al cambiar de categoría.
  - Soporta `/admin/cheques.html?filtro=proximos` como prefiltro por URL,
    mismo patrón que el `?filtro=vencidos` ya existente.
- `frontend/admin/cheques.html`: el sello `$X — Vencen en 3 días` pasa de
  `<div>` a `<button id="sello-proximos">` con `onclick="activarFiltroProximos()"`;
  el checkbox "Solo vencidos" ahora llama a `onFiltroVencidosChange()` en
  vez de `filtrarCheques()` directo.
- `frontend/shared/filtro-tabs.css`: nuevas reglas `.dato-sello--clickeable`
  (reseteo de `<button>` + hover/focus/active) y `.sello-proximos-activo`
  (relleno sólido mientras el filtro está aplicado, mismo lenguaje visual
  que `.filtro-tab.activa`). Afecta a las 24 páginas que cargan este CSS
  compartido, pero la clase nueva solo se usa en cheques.html — no cambia
  nada visible en el resto.
- Cache-busting: `cheques.js?v280` → `?v908`, `filtro-tabs.css?v=1` → `?v=2`
  (en las 24 páginas que lo cargan).

## No afectado

- El checkbox "Solo vencidos" (cheques YA vencidos) sigue funcionando
  igual que antes, solo que ahora también apaga "próximos" al activarse.
- La alerta de la campanita del dashboard (`lib/handlers/admin.js`,
  `?filtro=vencidos`) es un criterio distinto y no se tocó.
