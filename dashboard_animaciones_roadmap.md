# Roadmap de "vida" para el Dashboard — Fluxo Pro

**Regla general (aplica a todo lo demás):** ninguna animación es decorativa porque sí. Cada movimiento debe representar un estado real (dato en vivo, proceso corriendo, error, algo que acaba de llegar). Si el dato no cambia o no hay estado real que comunicar, esa sección queda quieta.

Estado de implementación: `[ ]` pendiente · `[x]` hecho — **✅ ROADMAP COMPLETO (9/9)**

---

## 1. "Hoy en tu negocio" (Ventas) — ✅ IMPLEMENTADO
- [x] El número `$471.403` hace un conteo tipo odómetro (sube dígito por dígito) cada vez que se actualiza el dato — no solo al cargar la página.
- [x] Línea de pulso tipo monitor cardíaco, delgada, corriendo debajo del número, activa solo mientras el tag "EN VIVO" tiene datos frescos.
- [x] Cuando entra un pedido nuevo, un "flash" de luz recorre la barra de progreso naranja una sola vez (no loop constante).

Implementación: función reutilizable `animarOdometroMoney(id, valor)` (anima desde el último valor mostrado, respeta `prefers-reduced-motion`, usada también en item 8). `.kv-pulse-line` recibe la clase `live` en cada `cargarKPIs()` exitoso y se le saca en error. El flash usa la clase `.mb-flash.run` sobre `#mb-ventas-flash`, disparado por un flag `_kvFlashPendiente` que se enciende en el `onCambio` de Realtime (evento `INSERT` en `pedidos`) y se consume la próxima vez que `cargarKPIs()` corre con el dato ya actualizado.

## 2. WhatsApp Business — ✅ IMPLEMENTADO
- [x] El bloque "PEDIDO BORRADOR" entra con animación de burbuja deslizándose desde abajo, simulando que "acaba de llegar" el mensaje.
- [x] Mientras el asistente IA procesa un pedido: indicador de "escribiendo..." (tres puntitos) antes de que aparezca el contenido.

Implementación: `_waDraftIdVisto` guarda el id del último borrador ya animado — solo se dispara `.wa-draft-enter` cuando aparece un borrador con id nuevo (no en cada refresco). El indicador "escribiendo..." (`.wa-typing`) se muestra cuando no hay `pedido_borrador` todavía pero el último mensaje de la conversación es entrante y llegó hace menos de 40s.

## 3. Catálogo para clientes (QR) — ya estaba implementado
- [x] Línea de escaneo fina cruzando el QR de arriba a abajo, en loop lento.
- [x] Punto verde pulsante junto a "Catálogo público activo" (live indicator con propósito).

## 4. POS · Caja — ✅ IMPLEMENTADO
- [x] Ícono de caja registradora con animación idle sutil ("respirando") mientras no hay ventas en el turno.
- [x] Animación tipo "ca-ching" que corta el idle apenas entra la primera venta real del turno.

Implementación: se agregó `id="pos-icon-svg"` al ícono de la card POS. `_posCantVentasPrev` guarda `cantidad_ventas` del turno; con 0 ventas queda `.pos-idle`; en la transición 0 → >0 dispara `.pos-caching` una vez (reflow para poder re-disparar) y saca `.pos-idle`; sin turno abierto, ícono quieto.

## 5. Comprobantes ARCA — ✅ IMPLEMENTADO
- [x] El número de "CON ERROR" tiene glow rojo intermitente lento SOLO mientras haya errores pendientes; se apaga solo al llegar a 0.
- [x] Barra de progreso por tipo de comprobante se "dibuja" (width 0 → real) al cargar, en vez de aparecer ya completa.

Implementación: `#arca-err-hero` y `#arca-err-box` reciben `.err-glow` con `classList.toggle(..., errores > 0)`. `renderArcaBars()` ahora renderiza cada barra con `class="arca-bar-fill" width:0` y `data-w`, y en el siguiente frame (`requestAnimationFrame`) asigna el ancho real — la transición CSS ya existente (`.arca-bar-fill{transition:width .7s}`) hace el resto.

## 6. Score · Cheques — ✅ IMPLEMENTADO
- [x] El gauge circular por cliente (ya existía) ahora se dibuja en arco al cargar en vez de aparecer ya completo.

Implementación: el círculo de color recibe `class="score-gauge-arc"`, arranca con `stroke-dashoffset` = circunferencia completa (arco vacío) y `data-offset` con el valor real; en el siguiente frame se asigna `el.style.strokeDashoffset = el.dataset.offset`, animado por la transición CSS ya existente.

## 7. Automatización — ✅ IMPLEMENTADO (de una sesión anterior)
- [x] Punto de luz que viaja constantemente por la línea Pedido → Factura → WA aviso → Cobro.
- [x] Cada ícono hace un pulso breve cuando el punto de luz pasa por él.

## 8. Reportes críticos (deuda) — ✅ IMPLEMENTADO
- [x] Borde de la tarjeta con pulso rojo lento y sutil (ya estaba wireado vía `.card-critical.card-alert` + `actualizarAlertaCritica()`).
- [x] Número de deuda total (`#cob-total`) con el mismo conteo tipo odómetro cuando cambia.

Implementación: `cargarCobranzaTab()` ahora llama a `animarOdometroMoney('cob-total', total)` en vez de `setText` plano — reutiliza el helper del item 1.

## 9. Barra superior de alertas (pills) — ya estaba implementado
- [x] Solo los pills en estado activo/error tienen el punto de color pulsando (vía CSS `.sp-danger .dot::after` etc., ya se aplicaban las clases correctas desde JS).

---

**prefers-reduced-motion**: todas las animaciones nuevas (odómetro, pulse-line, flash, burbuja WA, typing dots, POS idle/ca-ching, glow ARCA, barra ARCA, gauge score) respetan la regla ya existente en el CSS o chequean `matchMedia('(prefers-reduced-motion: reduce)')` en JS (caso del odómetro).
