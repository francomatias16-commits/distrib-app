# Plan de refinamiento — `frontend/admin/dashboard.html`

Objetivo: pasar el panel principal de un estado "básico/precario" a uno con terminación profesional, sin tocar el backend ni la arquitectura de datos — solo presentación, jerarquía visual y corrección de bugs de UI que aparecieron en el camino.

Regla transversal fija desde el arranque: **cero emojis en todo el proyecto**, con foco inicial en el dashboard.

---

## Estado general

| # | Frente | Estado |
|---|--------|--------|
| 0 | Cero emojis en `dashboard.html` | ✅ Hecho |
| 1 | Jerarquía de urgencia (ARCA / deuda vencida / cheques rechazados) | ✅ Hecho |
| 2A | Recuadro A — Hoy en tu negocio | ✅ Hecho |
| 2B | Recuadro B — WhatsApp Business | ✅ Hecho |
| 2C | Recuadro C — Catálogo para clientes | ✅ Hecho |
| 2D | Recuadro D — POS · Caja | ✅ Hecho |
| 2E | Recuadro E — Comprobantes ARCA (resto, fuera de jerarquía de urgencia) | ✅ Hecho |
| 2F | Recuadro F — Score · Cheques | ✅ Hecho |
| 2G | Recuadro G — Automatización | ✅ Hecho |
| 2H | Recuadro H — Reportes críticos | ✅ Hecho |
| 3 | Pase transversal final (espaciado, alineación numérica) | ✅ Hecho |

---

## 0. Cero emojis — ✅ Hecho

Catalogados y reemplazados **21 pictogramas** (accesos rápidos mobile, los 8 `card-icon` de cada recuadro, los 4 `flow-dot` del diagrama de automatización, la lista de automatismos, el tag de errores ARCA, el mensaje "sin deuda vencida", las alertas de stock bajo, las medallas del ranking, y el glifo de cierre del modal de zoom) por el mismo sistema de íconos SVG (`stroke="currentColor"`, sin relleno) que ya usan el resto de páginas del admin (`automatizacion.html`, `auditoria.html`, etc.) — cero dependencias nuevas.

Se conservaron los glifos tipográficos neutros que no son emoji: `→ ✓ ✕ ↑ ↓ ● ↻` (luego se reemplazó también `✕` del botón cerrar por consistencia con el resto del panel).

Ajuste de acompañamiento: la regla CSS `.dash-qn-btn span:first-child { font-size:18px }` asumía un glifo de texto; se cambió por `.dash-qn-btn .qn-ico { display:flex;align-items:center;justify-content:center }` para centrar el SVG correctamente.

---

## 1. Jerarquía de urgencia — ✅ Hecho

Bug real encontrado: el pill de AFIP en la topbar se pintaba en **ámbar** (`sp-amber`) incluso con errores — el mismo color que "POS abierta", un estado neutro. Con 32 errores, competía en igual peso visual que datos informativos.

- **Topbar AFIP**: pasa a `sp-danger` (rojo) cuando `errores > 0`; verde solo si de verdad no hay errores.
- **Tarjeta Comprobantes ARCA**: "Errores AFIP" salió de la lista plana de datos (mismo peso que "CAE obtenidos") y subió a una caja roja tipo hero junto al conteo de emitidas — mismo tratamiento que ya tenía "RECHAZADOS" en Score/Cheques. Se oculta sola si no hay errores.
- **Deuda vencida** (topbar): el monto ahora con `font-weight:800` para más peso dentro del pill.
- **Tarjeta Reportes críticos**: `.card-alert` (activa cuando hay deuda vencida o cheques rechazados) suma `box-shadow` además del borde superior rojo, para que se note sin depender solo del top-border.

Score/Cheques ("RECHAZADOS") ya estaba bien resuelto de origen — no se tocó.

---

## 2A. Recuadro "Hoy en tu negocio" — ✅ Hecho

Bug real encontrado: 2 de las 4 columnas (**Facturas ARCA y Cobranzas**) tenían un `<div class="minibar">` de 26px reservado que el JS **nunca llenaba** — solo había una llamada a `miniBarDosValores()`, para ventas, y encima comparaba mal (primer día vs último día de la serie, con tooltip que decía "período anterior/actual", que era otra cosa).

- **Ventas y Pedidos**: la barra de 2 segmentos ahora compara correctamente actual vs anterior, derivado del mismo `delta%` real que ya mostraba el texto (antes Pedidos no tenía barra en absoluto).
- **Facturas ARCA**: barra apilada real (CAE ok en violeta / con error en rojo) sobre el total emitido, en vez de espacio vacío.
- **Cobranzas**: no hay `delta%` de este KPI en el backend — se dejó una línea base tenue con tooltip explicando que no hay comparación disponible, en vez de simular un dato falso.
- **Flecha de tendencia + color semántico dinámico** en los deltas de Ventas y Pedidos: antes el color era fijo (ámbar y verde siempre, sin importar el signo) — una caída de -10% igual se pintaba en verde "éxito". Ahora sube = verde con flecha arriba, baja = rojo con flecha abajo.

---

## 2B. Recuadro "WhatsApp Business" — ✅ Hecho

Corrección al punto anterior del plan: no existía ninguna "barra de progreso superior" en el código — se revisó el HTML y CSS completos del recuadro B y `4 conv. activas` es y era solo texto plano (`<span id="wa-activas">`), sin ningún elemento de barra asociado. Nota descartada, no había nada que arreglar ahí.

- **Bug real encontrado y corregido — "Pedido borrador" cortado**: la causa no era el texto en sí, sino que la `.card` contenedora tiene `overflow:hidden` fijo (línea 213). Con un nombre de producto largo, el `textContent` de una sola línea envolvía a una 2da línea que quedaba tapada por ese overflow — se veía "10x" y nada más. Se reemplazó por chips individuales por ítem (`10× Yerba Cruz`), cada uno de una sola línea con `text-overflow:ellipsis` propio (máx. 130px), así ningún chip se corta a mitad de palabra sin importar el largo del nombre. `title` con el texto completo para hover.
- **Ícono de WhatsApp**: revisado `whatsapp-conversaciones.html` — no tiene ningún ícono propio de WhatsApp en su header para reusar; el SVG de chat que ya usa el dashboard es el único existente en el proyecto para este contexto. Nada que unificar.

---

## 2C. Recuadro "Catálogo para clientes" — ✅ Hecho

- **QR real en vez de placeholder falso**: el `<div class="qr">` era un tablero de ajedrez puramente decorativo vía CSS (`repeating-conic-gradient`), sin relación con el link real. El proyecto ya usa `qrcodejs` (cdnjs) en `pos.html`, `productos.html`, `stock.html` y `frontend/shared/vincular-celular.js` con el mismo patrón (`new QRCode(el, {text, width, height, correctLevel})`) — se agregó el mismo script a `dashboard.html` y ahora el QR codifica la URL real del catálogo (`/cliente/catalogo?empresa_id=...`).
  - Si el catálogo público está desactivado (no hay URL válida para codificar), se muestra un ícono SVG de "QR inactivo" (mismo estilo stroke del resto del panel) en vez de fingir un QR que no lleva a ningún lado.
  - Se agregó CSS (`.qr canvas,.qr img{width:100%;height:100%}`) para que el canvas generado por la librería escale correctamente con el contenedor en el breakpoint mobile (que fuerza `.qr` a 40px).
- **"Últimos productos actualizados" sin jerarquía**: cada fila ahora es de dos líneas — nombre de producto arriba, categoría + tiempo relativo ("hace 2 h", vía la misma `tiempoRelativo()` que ya usa WhatsApp) abajo en tipografía chica muted — con el precio en mono alineado a la derecha. Se sumó `categorias(nombre)` al select de Supabase (FK existente `productos.categoria_id → categorias.id`, confirmada en `001_schema.sql`).

---

## 2D. Recuadro "POS · Caja" — ✅ Hecho

Decisión de scope: la RPC `resumen_turno_caja` (migración 075) no devuelve desglose por hora del turno — solo `por_medio`, `monto_inicial`, `monto_calculado`, `cantidad_ventas` y `movimientos_caja`. Sin tocar backend no hay datos reales para un mini-gráfico de ventas por hora, así que se descartó esa opción en vez de simular datos falsos (mismo criterio que ya se aplicó en 2A con Cobranzas).

- **"Sangrías y refuerzos del turno" ahora siempre visible** cuando hay turno abierto, con estado vacío explícito ("Sin sangrías ni refuerzos en este turno") en vez de colapsar la sección entera (`display:none`) cuando no había movimientos — que es justamente lo que dejaba el bloque central vacío al no haber ventas tampoco. Usa datos que ya se traían del backend y no se mostraban.
- **`cantidad_ventas`** (ya venía en la respuesta de la RPC, nunca se mostraba) ahora aparece en el subtítulo junto al total — da contexto real ("0 ventas", "3 ventas") incluso apenas abierto el turno, en vez de depender solo del texto "Sin ventas todavía en este turno".

---

## 2E. Recuadro "Comprobantes ARCA" — ✅ Hecho

La jerarquía de urgencia de este recuadro ya se resolvió en el punto 1.

- **Bug real encontrado y corregido — "Pendientes de emitir" siempre en 0**: la query usaba `head: true` (Supabase no devuelve `data` en ese modo, solo `count`), pero se destructuraba `{ data: pendientes }` y se leía `pendientes?.length` — siempre `undefined` → `?? 0`. El dato nunca se veía, sin importar cuántas facturas pendientes hubiera. Se corrigió a `{ count: pendientes }`, mismo patrón correcto que ya usan las otras 3 queries `head:true` de este archivo (catálogo y POS).
- **Barras por tipo de comprobante**: el largo de cada barra era un `width:X%` compitiendo por espacio con la etiqueta de texto dentro de la misma fila flex, sin una base de tamaño fija — con nombres de tipo largos ("Nota crédito A") el ancho real de la barra se volvía impredecible. Se pasó a un largo fijo en píxeles (proporcional al máximo, tope 60px), y la etiqueta ahora trunca con ellipsis si no entra, en vez de descuadrar la barra.

---

## 2F. Recuadro "Score · Cheques" — ✅ Hecho

- **Tag "Escala 0–100"**: verificado contra `.card-tag` — usa la misma clase que el resto de los tags del dashboard (AFIP, Integrado, QR+Link), mismo tamaño y peso. No era una inconsistencia real, no se tocó.
- **Tag de categoría por cliente**: ahora `riesgo`/`bloqueado` (categorías urgentes) tienen más peso visual — fondo más opaco (`18`→`2e` de alpha) + borde de 1px — que `premium`/`bueno`/`normal`, siguiendo el mismo criterio de jerarquía de urgencia del punto 1. Colores por categoría ya eran correctos de origen.

---

## 2G. Recuadro "Automatización" — ✅ Hecho

El ciclo `animateFlow()` (decorativo, cada 2.2s, ya existía) prendía y apagaba nodos con un cambio de color plano — se notaba el estado pero no la sensación de "algo avanzando por el pipeline".

- **Pulso en el nodo activo**: al nodo que se acaba de encender en cada ciclo se le agrega la clase `pulse`, que dispara un anillo expansivo de una sola vuelta (`flowPulseRing`, 1.1s) y se asienta en el estilo `.active` estable — no se repite el anillo en los nodos ya prendidos, solo en el que recién se activó.
- **Conectores menos "wireframe"**: `.flow-line` pasó de 2px a 3px con `border-radius`, y la línea activa ahora tiene una animación continua de degradé en movimiento (`flowLineMove`, 2.6s) en vez de un gradiente estático — da sensación real de flujo pasando de un nodo al siguiente.
- **`prefers-reduced-motion`**: usuarios con esa preferencia del sistema activada ven el gradiente estático de siempre, sin animación.

---

## 2H. Recuadro "Reportes críticos" — ✅ Hecho

- **Bug real encontrado — alineación numérica de stock**: la fila de cada producto bajo mínimo era un solo string (`${cantidad} u. (mín ${minimo})`) dentro de un `<span>` con fuente monoespaciada pero de ancho libre — con cantidades de distinto largo ("0" vs "120"), el bloque completo ("u.", "(mín", el número de mínimo) se corría de posición fila a fila, sin ninguna columna real para el ojo. Se separó en tres sub-spans de ancho fijo y alineados a la derecha (cantidad · "u." · "mín X"), así los números quedan en columnas consistentes sin importar la cantidad de dígitos.
- De paso, el nombre del producto ahora trunca con ellipsis en vez de empujar el layout si es muy largo (mismo patrón ya usado en otras tarjetas del panel).
- El resto de este recuadro (medallas del ranking, mensaje de deuda vencida en cero) ya estaba resuelto desde el punto 0 (cero emojis).

---

## 3. Pase transversal final — ✅ Hecho

- **Auditoría de iconografía**: confirmado que los 8 `card-icon` (15px, `stroke-width:1.75`), los 7 accesos rápidos `qn-ico` (18px, `stroke-width:1.75`) y los 4 `flow-dot` (13px, `stroke-width:2`) son consistentes puertas adentro de cada grupo — cada grupo tiene su propio tamaño de contenedor, así que el tamaño de ícono difiere entre grupos a propósito, no por descuido. No hizo falta tocar nada.
- **Estados vacíos con tratamiento liviano**: los ~13 mensajes "Sin X todavía" / "Cargando…" vivían como texto gris suelto centrado. Se agregó `display:flex` + `gap:5px` a `.data-row-empty` y un ícono SVG de 12px por categoría de estado, coherente con el resto del panel (`stroke=currentColor`, sin relleno):
  - Neutro/sin datos (bandeja vacía): catálogo sin productos, sin ventas en el período, sin caja abierta, sin sangrías/refuerzos, sin clientes con score, sin facturación, sin rentabilidad por zona.
  - Positivo (check): "Sin deuda vencida" y "Sin productos bajo mínimo" — antes solo el primero tenía ícono (agregado en el punto 1), ahora ambos casos "buenas noticias" son consistentes entre sí, incluido el placeholder estático inicial de deuda vencida que antes no lo tenía.
  - Error (alert-circle): los dos "No se pudo cargar" (cobranza priorizada, ranking de clientes) — antes indistinguibles de un estado vacío normal.
  - Los "Cargando…" (transitorios) se dejaron sin ícono a propósito — no son un estado vacío, son una carga en curso.
- **Tilt 3D**: no evaluado — `dashboard-tilt3d.js` no está incluido en este export del proyecto (solo `dashboard.html`, este plan y el zip de repartos), así que no hay archivo para auditar ni extender con seguridad. Queda pendiente hasta contar con ese archivo.
- **Alineación numérica**: bug real encontrado — la clase `.hero-num` no tiene ninguna regla base propia (solo existe para los overrides de zoom y mobile en breakpoints); cada número la usa junto con estilos inline sueltos, y varios quedaron sin `font-variant-numeric:tabular-nums`, lo que hace que el ancho del número "salte" al actualizarse en vivo con distinta cantidad de dígitos. Corregido en los 9 números que no lo tenían (Catálogo ×3, Score/Cheques ×3, Cobranza ×2, Stock). Además, `arca-err-hero` ("Con error" en Comprobantes ARCA) no tenía ninguna clase `hero-num*`, así que al hacer zoom en esa tarjeta todos los demás números crecían menos ese — se le agregó `class="hero-num-sm"` para que escale igual que el resto.

---

## Notas técnicas

- Todas las ediciones se validaron extrayendo el `<script>` inline y corriendo `node --check` antes de empaquetar.
- Ningún cambio tocó `dashboard-ejecutivo.js`, `dashboard-tilt3d.js`, backend, ni schema — todo el trabajo hasta ahora vive dentro de `frontend/admin/dashboard.html`.
- Cada entrega incluyó el `dashboard.html` actualizado y el `.zip` completo del proyecto con el cambio ya aplicado.
