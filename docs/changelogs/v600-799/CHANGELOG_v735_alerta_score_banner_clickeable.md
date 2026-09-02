# v735 — Banner "caída reciente de score" ahora clickeable → filtra la tabla

## Problema
En `/admin/riesgo-cheques`, el banner naranja ("N clientes con cheques en
cartera tuvieron una caída reciente de score — revisá antes de depositar")
era texto estático sin destino: no quedaba claro a qué clientes se refería
ni dónde verlos.

## Dónde apunta
La misma pantalla ya tenía, más abajo, la tabla "Clientes con cheques en
cartera" con un checkbox **"Solo con rechazos o alertas"** que filtra
exactamente con el mismo criterio que arma el banner
(`c.ultimaAlerta && c.carteraCantidad > 0`, ver `renderAlertasPanel` en
`riesgo-cheques.js`). No hacía falta crear una sección nueva ni pegarle a
`/admin/clientes` (que tiene su propio filtro `?filter=riesgo`, pero basado
en `score_categoria`, no en alertas recientes — no es el mismo conjunto de
clientes que el banner anuncia).

## Cambio
- `frontend/admin/js/riesgo-cheques.js`:
  - `renderAlertasPanel()` ahora renderiza el aviso como `<button>`
    (`alerta-inline--clickable`) en vez de `<div>`, con `onclick="irAClientesConAlerta()"`.
  - Nueva función `irAClientesConAlerta()`: tilda el checkbox
    `filtro-solo-alerta` si no estaba tildado (reusa `filtrarRiesgoCheques()`,
    sin duplicar lógica de filtrado), hace `scrollIntoView` hacia
    `#tabla-riesgo-wrap` y agrega una clase `tabla-wrap--flash` por 1.6s
    para que quede visualmente claro adónde saltó.
- `frontend/admin/riesgo-cheques.html`:
  - Se agregó `id="tabla-riesgo-wrap"` al contenedor de la tabla (antes no
    tenía id, no se podía referenciar desde JS).
  - Bump de cache-busting del `<script>` de `riesgo-cheques.js`.
- `frontend/admin/css/finanzas.css`:
  - Estilos `.alerta-inline--clickable` (reset de `<button>`, hover/focus,
    chevron animado) y keyframe `tablaRiesgoFlash` / `.tabla-wrap--flash`.
  - Bump `?v=279` → `?v=280` en los 13 HTML que cargan `finanzas.css`.

## Por qué no `/admin/clientes`
`clientes.js` ya soporta deep-link `?filter=riesgo` y `?id=<uuid>` (ver
comentario en línea ~93), pero ese filtro usa `score_categoria IN
('riesgo','bloqueado')` — una definición distinta ("estado actual del
score") a la del banner ("tuvo una caída reciente", vía `alertas_score`).
Redirigir ahí hubiera mostrado un conjunto de clientes que no coincide con
el número que anuncia el banner, generando confusión. Si en el futuro se
quiere un filtro "con alerta reciente sin resolver" también en la pantalla
de Clientes, es un cambio aparte (agregar ese criterio a `clientes.js` +
un pill nuevo), no alcanza con reusar el existente.

## Testing manual
1. Entrar a `/admin/riesgo-cheques` con datos que generen el banner.
2. Click en el banner → debe scrollear a la tabla, tildar "Solo con
   rechazos o alertas" y aplicar el filtro (mismos clientes que cuenta
   el banner, o superset si además tienen rechazados históricos).
3. Click de nuevo → repite el scroll + destello sin romper si el checkbox
   ya estaba tildado.
4. Verificar hover/focus visual del botón y que el layout no se rompe
   (antes era `<div>`, ahora `<button>`).
