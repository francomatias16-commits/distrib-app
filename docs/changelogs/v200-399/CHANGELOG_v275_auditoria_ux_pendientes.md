# v275 — Cierre de los 3 pendientes reales de la auditoría UX

Verificación hecha contra el código real (no de memoria) sobre el paquete
v274. Los 3 hallazgos de la auditoría que habían quedado como diagnóstico
sin aplicar en versiones anteriores (v271) no llegaron a este paquete —
se reaplican acá.

## 1. Pulso Media/Baja en 3 elementos

El pulso (`urgente--pulso`, `tokens.css`) solo estaba conectado a
prioridad Alta (stock en cero, tarjeta "fuego"). Se conecta ahora en los
3 candidatos Media/Baja identificados en la auditoría:

- **Badge "Recordatorios"** (`#badge-alertas`, dashboard) — pulsa cuando
  `cantidad > 0`. (`dashboard-optimizado.js`, `renderBadgeAlertas`)
- **Badge "Pendientes del día"** (`#todo-badge`, dashboard) — pulsa
  cuando hay pendientes sin hacer. (`dashboard.html`, `guardarItems`)
- **Tab "¿A quién llamo hoy?"** (`#vptab-cobranza`, Cobranzas) — pulsa
  solo si hay al menos una factura con `prioridad === 'accion_urgente'`
  (score de riesgo alto). (`cobranzas.js`, `renderFacturas`)
- **Botón "Confirmar entrega"** (chofer) — pulsa mientras no haya firma
  cargada; se apaga con el primer trazo; se reactiva si el chofer borra
  la firma para volver a firmar. (`remito.html`)

## 2. setup-wizard.html sin título ni descripción

Verificado: la pantalla sí tenía título/descripción por paso
(`.panel-title` / `.panel-subtitle` dentro de cada uno de los 4 pasos),
pero el auditor buscó específicamente el patrón `page-intro`/`<h1>` del
panel admin estándar y no lo encontró — falso positivo, mismo caso que
`setup.html` con `.setup-title`/`.setup-subtitle`.

De todas formas se agregó un título general arriba del stepper para dar
contexto global antes de entrar al paso 1 ("Configuración inicial" +
descripción de los 4 pasos), ya que antes el primer texto que veía el
usuario era directamente el título del paso 1.

## 3. Filtro por canal en /admin/pedidos

No existía. Se verificaron contra Supabase los valores reales de
`pedidos.canal` en producción:

```sql
select canal, count(*) from pedidos group by canal order by count(*) desc;
-- telefono 750, whatsapp 750, vendedor 750, app 750,
-- web 16, portal_cliente 2, pos 1
```

Cambios:
- `pedidos.js`: se agregó `canal` a las dos queries de listado
  (principal y fallback sin columnas opcionales).
- `pedidos.html`: nuevo `<select id="filtro-canal">` en `filtros-der`,
  mismo patrón visual que zona/vendedor, con las 7 etiquetas en español.
## 4. Resto de la auditoría — verificado, ya resuelto

Se revisó el resto del informe (matriz completa + tabla de pulso) contra
el código actual. Todo lo demás que la auditoría marcaba como pendiente
ya está resuelto en versiones anteriores del código, aunque el propio
informe no lo reflejaba:

- `Repartos` y `Cajas` ya tienen `diario:true` en `nav-data.js` (con
  comentario `FIX auditoría UX`).
- `Compras` ya tiene entrada propia de menú en Depósito.
- `Descuentos automáticos` (reglas de precio) ya está duplicado también
  en Ventas, no solo en Facturación.
- El cobro en el reparto (única brecha funcional real del informe) ya
  se resolvió en v270 (`registrar_cobro_completo` desde `remito.html`).
- `dashboard-v2` / "Torre de Control" ya no existe — se borró en v273.

**Aclaración, no una duplicación real:** la auditoría pide decidir "qué
hacer con setup.html y setup-wizard.html" por duplicación. Revisando el
flujo real en `login.html`, no son duplicados: `/setup` es el alta
inicial del sistema (sin empresa creada todavía) y `/admin/setup-wizard`
es el onboarding post-login de una empresa que ya existe pero no
completó su configuración. Son dos etapas distintas del mismo proceso,
no una decisión pendiente.

## 5. Aclaración POS vs Pedidos y presupuestos

Único punto de la sección 6 (confusiones por duplicación) que sí
requería un cambio real: no había ninguna aclaración de cuándo usar
Punto de venta vs Pedidos, y el texto de Pedidos incluso podía sumar
confusión al mencionar que ahí también aparecen las ventas de POS.

Se agregó una frase a cada `page-intro`:
- **POS**: "Usalo para ventas en el mostrador que el cliente se lleva
  en el momento; si hay que preparar y entregar después, cargalo como
  pedido."
- **Pedidos**: "Usalo para todo lo que se prepara y se entrega después;
  la venta inmediata en el mostrador se carga directo desde Punto de
  venta."

## 6. Columna Acciones vacía en pedidos Entregado/Cancelado

Reporte del usuario: en `/admin/pedidos`, las filas en estado
`entregado` o `cancelado` mostraban la columna Acciones completamente
vacía, dando sensación de UI rota.

No era un bug de datos: `TRANSICIONES` no tiene próximos estados para
`entregado`/`cancelado` (son estados finales), y la columna solo
renderiza botones de cambio de estado. La fila entera ya era clickeable
(abre el detalle del pedido), pero nada lo indicaba visualmente.

Fix: cuando no hay transición de estado disponible (`sigEstados.length
=== 0`), se agrega un botón ícono "Ver detalle" (ojo) en la columna
Acciones que abre el mismo modal de detalle que el click en la fila.
Mismo estilo neutro que el botón de cancelar (`btn-ver-detalle`,
`pedidos.css`).

## 7. Optimización visual — Batch 1 (POS, Cajas, Repartos, Pedidos)

Pedido del usuario: llevar el resto del panel al mismo nivel visual que
ya tiene el dashboard ("fireart"), pantalla por pantalla, empezando por
las de uso diario.

**Auditoría previa (importante):** antes de tocar nada se comparó el
sistema de diseño real. Conclusión: la base ya es sólida y consistente
en las 49 pantallas (`.card`, `.btn-primary`/`.btn--primary`,
`.topbar-title`, `.page-intro`, compartidos vía `reskin-patch.css` /
`adminlte-components.css` / `tokens.css`). El dashboard no es una base
distinta, es una pieza "hero" con acento propio. Paleta unificada:
se mantiene el azul (`--color-primary: #2563EB`) ya establecido en 45
pantallas — no se adoptó el verde del dashboard (decisión del usuario).

Con la base ya unificada, el trabajo real de este batch fue encontrar
inconsistencias puntuales dentro de cada pantalla, no reescribirlas:

- **`rutas.html`**: 3 títulos de sección ("Seguimiento de entrega",
  "Pedidos para despachar", "Entregas") no tenían ícono, mientras que
  otros 3 títulos de la misma pantalla ("Mapa de la ruta", "Detalle de
  entregas", "Historial de reportes") sí — mismo archivo, dos patrones
  mezclados. Se agregó ícono a los 3 que faltaban, mismo criterio
  visual (14×14, `stroke-width="2"`) que sus vecinos.
- **`cajas.html`**: "Puntos de cobro configurados" y "PIN de
  supervisor" tampoco tenían ícono. Se agregaron usando la clase
  `.card-title` ya existente en el sistema (que ya trae
  `display:flex;gap:8px`, sin necesidad de CSS nuevo).
- **`pos.html`** y **`pedidos.html`**: revisados a fondo — ya seguían
  el patrón correcto (los títulos de formulario/modal no llevan ícono
  en ningún lado del sitio, y eso ya es consistente). No requirieron
  cambios.

## 8. Optimización visual — Batch 2 (Cobranzas, Stock, Facturación)

Siguiendo el mismo criterio del batch 1 (auditar contra el sistema ya
unificado, tocar solo inconsistencias puntuales reales, no reescribir):

- **`cobranzas.html`**: revisado a fondo (KPIs, tabs, tabla de facturas,
  panel lateral de cliente, modal de cobro). Los `<h2>` dentro de
  `.tabla-header` no llevan ícono — se verificó que es el patrón
  establecido en las otras 16 pantallas del sitio que usan ese mismo
  bloque (`auditoria.html`, `cheques.html`, `devoluciones.html`,
  `vencimientos.html`, `reglas-precio.html`, etc.), no una
  inconsistencia de este archivo. Sin cambios.
- **`stock.html`**: encontrada una inconsistencia real — el modal
  "Ajustar stock" usa las clases estándar del sistema (`.modal`,
  `.modal-header`, `.modal-titulo`, `.modal-close` con ícono SVG),
  mientras que el modal "Proyección de Stock" (`#modal-proyeccion-stock`,
  más nuevo, `REQ-4`) está armado con estilos inline sueltos y usa un
  emoji (📊) en el título y el carácter `✕` como botón de cierre —
  dos convenciones distintas en el mismo archivo. Se quitó el emoji del
  título (los títulos de modal en todo el sitio nunca llevan ícono,
  solo texto) y se reemplazó el botón de cierre por el mismo ícono SVG
  de línea (14/16px, stroke-width 2) que usa el modal vecino, sin tocar
  la lógica de apertura/cierre (`stock.js` sigue manejando el modal por
  `id` y `style.display`, no se cambiaron clases de control).
- **`facturacion.html`**: revisado a fondo. El carácter `✕` como botón
  de cierre en los modales de nota de crédito no es una inconsistencia
  nueva de este archivo — es un patrón preexistente en 10 pantallas del
  sitio, incluidas `pos.html` y `pedidos.html` ya validadas en el batch
  1 sin cambios. No se tocó para no romper consistencia con esas
  pantallas ya revisadas. Sin cambios.

## 9. Optimización visual — Batch 3 (Devoluciones, Puntos, Reportes de ventas, Movimientos raros)

- **`devoluciones.html`** y **`puntos.html`**: revisados a fondo (KPIs,
  tabla, panel lateral, modal de cliente). Ya siguen el patrón
  establecido del sitio. Sin cambios.
- **`anomalias.html`**: 3 inconsistencias reales corregidas, todas
  del mismo tipo — emojis/glifos de texto en vez del sistema de íconos
  SVG de línea que usa el resto del archivo y del sitio:
  - Botón "▶ Analizar ahora" → ícono SVG de play + texto (se agregó
    `display:flex;gap:6px` a `.btn-analizar`, que no lo tenía).
  - Estado vacío "✅ Sin anomalías detectadas" → ícono SVG de check en
    círculo (32-40px, mismo trazo que `.empty-state` del resto del
    sitio). Se ajustó `.icono` en el `<style>` del archivo: pasó de
    `font-size` (pensado para el emoji) a dimensionar el `<svg>` hijo.
- **`reportes-ventas.html`**: revisado a fondo, **sin cambios por
  ahora** — encontré algo que conviene resolver junto con sus dos
  pantallas hermanas, no de forma aislada. Los KPIs y títulos de
  sección de esta pantalla están en Title Case ("Total de Ventas",
  "Ventas por Categoría", "Top 10 Vendedores", etc.) en vez del
  sentence case que usa el resto del sitio ("Facturas pendientes",
  "Clientes con saldo"), y el botón de exportar usa emoji (📥)
  en vez de ícono SVG. Verifiqué que **no es un descuido aislado**:
  `reportes-financieros.html` y `reportes-stock.html` (ambas
  pendientes, Etapa 9) comparten exactamente el mismo Title Case,
  la misma clase `.kpi-card` y el mismo botón "📥 Exportar" — las 3
  pantallas de Reportes fueron construidas juntas con su propia
  convención interna coherente, como pasó con el dashboard y su
  paleta verde en el batch 1. Prefiero decidir esto una sola vez para
  las 3 pantallas cuando lleguemos a la Etapa 9, en vez de normalizar
  solo esta y dejar a sus hermanas desalineadas mientras tanto.

## 10. Optimización visual — Batch 4 (Clientes, Descuentos automáticos)

- **`reglas-precio.html`**: revisado a fondo (KPIs, tabla, modal de
  alta/edición). Ya sigue el patrón estándar del sitio. Sin cambios.
- **`clientes.html`**: mismo hallazgo que en `stock.html` (batch 2) —
  dos modales "REQ" más nuevos (`modal-score-cliente` "Nivel de
  confianza del cliente" y el modal de Acceso Portal) armados con
  estilos inline y emoji (🏅, 🔑) en el título + `✕` de texto para
  cerrar, mientras los otros 3 modales del mismo archivo ("Nuevo
  cliente", "Precio especial", "Dirección de entrega") ya usan
  `.modal-titulo` / `.modal-close` con ícono SVG. Corregido con el
  mismo criterio: título en sentence case sin ícono (los títulos de
  modal del sitio nunca llevan ícono) y botón de cierre con el mismo
  SVG de línea. Dentro del modal de Acceso Portal también se corrigió
  el botón "🔑 Generar acceso..." (ícono de candado, reutilizando el
  mismo SVG agregado a "PIN de supervisor" en el batch 1) y el texto
  "✅ Acceso generado correctamente" (ícono de check, mismo criterio
  que el estado vacío de `anomalias.html` en el batch 3).

**Hallazgo pendiente de decisión — no corregido todavía:** el botón
"📋 Copiar" (mensaje de WhatsApp) de ese mismo modal de Acceso Portal
usa emoji, pero no es un simple detalle visual: la función
`copiarMensajeWA()` en `clientes.js` reescribe el botón con
`.textContent = '✅ Copiado'` / `'📋 Copiar mensaje'` — cualquier ícono
SVG que se agregue a ese botón se borraría en el primer click porque
`textContent` reemplaza todo el contenido. Además, el mismo patrón de
emoji en mensajes (`window.toast('✅ ...')` / `('❌ ...', 'error')`)
aparece en otras 7 llamadas más: 4 en `clientes.js` y 2 en `rutas.js`
(pantalla ya cerrada en el batch 1) — sobre un total de 224 llamadas a
`toast()` en todo el sitio, es decir, es un patrón minoritario (8/224),
no la convención. Corregirlo bien implica tocar la lógica del botón
(separar ícono fijo + label de texto) y decidir si también se
homogeneízan los toasts con emoji en `clientes.js` y `rutas.js`. Lo
dejo señalado para resolverlo como un ítem propio en vez de parchearlo
a medias.
