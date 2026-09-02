# Fase 3 — Sincronización de datos entre páginas (mismo rol)

**Fecha:** 2026-08-07
**Estado:** 🟡 Flujo 1, 2 y 3 cerrados en código. Falta el pase manual en
navegador real.

---

## Objetivo

Seguir un dato de punta a punta a través de las páginas del panel admin
para detectar desincronizaciones: una página escribe, otra lee, y el
estado que muestra la segunda no refleja lo que la primera guardó.

---

## Flujo 1 — Lotes / Vencimientos ✅ Cerrado (F3-03)

**Páginas involucradas:** `admin/vencimientos.html` → `admin/stock.html`
(detalle de lote)

### Hallazgo F3-03

| Campo | Problema | Impacto |
|-------|----------|---------|
| `lotes.estado` | `actualizar_estado_lotes()` nunca se invocaba al listar y estaba rota por cambio de constraint | Badge mostraba "Activo" para lotes vencidos o agotados |
| Banner "por vencer" | `lotes.js` filtraba `l.estado === 'por_vencer'` — estado inexistente en el constraint actual `('activo','agotado','vencido')` | Banner siempre contaba 0, alertas de vencimiento silenciadas |

### Corrección F3-03

- `lib/repos/stock.js` (`listarLotes`): cablea llamada a RPC
  autocorrectora de estados antes de devolver la lista.
- `lib/repos/automatizacion.js` (`listarLotesPorVencer`): ídem.
- `frontend/admin/js/lotes.js` (`mostrarAlertas()`): rehecha para
  calcular "por vencer" desde `fecha_vencimiento` comparando contra
  `hoy + 7 días`, sin depender del campo `estado`.

---

## Flujo 2 — Pedido → Rutas → Facturación → Cta-cte → Cobranzas ✅ Cerrado (F3-04)

**Páginas involucradas:**
`admin/pedidos.html` → `admin/rutas.html` → `admin/facturacion.html` →
`admin/cta-cte.html` → `admin/cobranzas.html`

### Análisis completo del flujo

| Segmento | Mecanismo actual | Estado de sync |
|----------|-----------------|----------------|
| Pedidos → Facturación | Páginas separadas, cada una carga fresco al navegar | ✅ OK |
| Rutas → Pedidos (cancelación) | `cancelarRuta()` ya resetea pedidos asignados a `'confirmado'` (líneas 485-497 de `rutas.js`) | ✅ OK |
| Facturación → Cta-cte | Carga fresca en cada navegación a `facturacion.html` | ✅ OK |
| Cta-cte → Cobranzas (KPIs) | **Bug F3-04** — KPIs de cobranzas quedan stale (ver abajo) | ✅ Corregido |
| Cta-cte → Cobranzas (lista priorizada) | `invalidarCobranzaPriorizada()` existía pero solo se llamaba cuando `facturaVinculadaCobro != null` | ✅ Corregido |

### Hallazgo F3-04

**Síntoma:** el usuario registra un cobro desde `cta-cte.html`; vuelve a
`cobranzas.html` y los KPIs del panel "¿A quién llamo hoy?" siguen
mostrando los valores anteriores al cobro: "Cobrado hoy", "Vence hoy",
"Total vencido" y el desglose de medios de pago no se actualizan hasta
que el usuario recarga la página manualmente.

**Causa raíz:** `guardarCobro()` en `cta-cte.js`:
1. Recargaba la vista Saldos (`cargarCtaCte()`) — correcto.
2. Llamaba a `window.invalidarCobranzaPriorizada()` solo cuando
   `facturaVinculadaCobro != null` — los cobros genéricos dejaban el
   caché de priorizada sucio.
3. No llamaba a ninguna función de refresco de KPIs en `cobranzas.js` —
   los cuatro KPIs y el grid de medios de pago se calculan localmente
   sobre `cobrosHoy` y `ultimosKpisCob` (cacheados en memoria desde la
   última navegación a la pantalla de cobranzas).

### Corrección F3-04

**`frontend/admin/js/cta-cte.js`** — en `guardarCobro()`, bloque
post-éxito:

```diff
-    if (facturaVinculadaCobro && typeof window.invalidarCobranzaPriorizada === 'function') {
-      window.invalidarCobranzaPriorizada();
-    }
+    // FIX F3-04: invalidar siempre, no solo cuando hay factura vinculada
+    if (typeof window.invalidarCobranzaPriorizada === 'function') {
+      window.invalidarCobranzaPriorizada();
+    }
+    if (typeof window.refrescarKPIsCobranzas === 'function') {
+      window.refrescarKPIsCobranzas();
+    }
```

**`frontend/admin/js/cobranzas.js`** — nueva función pública
`refrescarKPIsCobranzas()`:

```js
// Re-fetches cobrosHoy + fn_cobranzas_kpis y actualiza el DOM
// sin rerenderizar las tabs. La llama cta-cte.js después de guardar
// un cobro.
async function refrescarKPIsCobranzas() { ... }
window.refrescarKPIsCobranzas = refrescarKPIsCobranzas;
```

La función:
- Hace ambas queries en `Promise.all` (1 RTT).
- Actualiza `cobrosHoy`, `ultimosKpisCob`, el DOM de KPIs y el grid de
  medios de pago.
- Falla silenciosamente (no interrumpe el flujo del cobro en cta-cte.js).
- Si `_sb` es `null` (la pestaña de cobranzas nunca fue visitada), retorna
  sin hacer nada — no hay DOM que actualizar.

---

## Flujo 3 — Notas de crédito → Facturas (mismo rol, mismo tab set) ✅ Cerrado (F3-05)

**Página involucrada:** `admin/facturacion.html` — tiene 3 tabs internos
(`switchTab()`: Facturas / Notas de crédito / Comprobantes hist.), mismo
patrón de riesgo que `cobranzas.html` (Flujo 2): varios módulos JS
conviven en una sola página y se togglean sin recargar todos al cambiar
de tab.

### Candidatos descartados antes de llegar a F3-05

Se investigaron primero varios candidatos sugeridos por un barrido
amplio de módulos con posible estado en memoria:

- `cheques.js` — cada cambio de estado (`cambiarEstado()`) recarga sus
  propios datos (`cargarCheques()` + `cargarContadoresCheques()`);
  página standalone, sin tabs compartidos con otro módulo. Sin hallazgo.
- `reglas-precio.js` / `comparador-precios.js` — páginas separadas
  (`reglas-precio.html` / `comparador-precios.html`), carga fresca por
  navegación. Sin hallazgo.
- `liquidacion.js` — pista descartada por error de nombre: no es
  liquidación a proveedores (no tiene relación con `cc-proveedores.js`),
  es el motor de **liquidación de stock por vencimiento** ("Innovación
  #1"), embebido en `vencimientos.html`. Módulo autocontenido. Sin
  hallazgo.
- `reportes-ventas.js` / `reportes-stock.js` — páginas standalone
  (`reportes-ventas.html` / `reportes-stock.html`), carga fresca por
  navegación, sin caché entre páginas. Sin hallazgo.
- `cambiarVistaPrincipal` en `cobranzas.js`/`cta-cte.js` — ya cubierto y
  corregido en Flujo 2 (F3-04); se confirmó que ambos módulos conviven
  en `cobranzas.html` (no en páginas separadas), consistente con la
  causa raíz ya documentada.

### Hallazgo F3-05

**Síntoma:** el usuario está en `facturacion.html`, tab "Facturas" (carga
inicial de la página). Cambia al tab "Notas de crédito", crea una NC
vinculada a una factura puntual y la emite contra ARCA. Vuelve al tab
"Facturas": la factura original sigue apareciendo con su estado viejo
(p. ej. "Emitida") en la grilla y en el modal de detalle — incluído el
botón "Anular", que no debería estar disponible para una factura ya
anulada — hasta que el usuario recarga la página a mano.

**Causa raíz:**
1. `emitirNotaCreditoARCA()` (vía `lib/facturas.js` / `lib/handlers/
   facturas.js`, sub-router `notas-credito?accion=emitir`) marca la
   factura original como `'anulada'` en la base cuando la NC está
   vinculada a una factura y hay config ARCA activa (mismo mecanismo que
   usa el botón "Anular" del propio tab Facturas).
2. `emitirNC()` en `frontend/admin/js/notas-credito.js`, tras el `POST`
   exitoso, solo llama a `cargarNotasCredito()` (recarga su propio tab).
   Nunca llama a `cargarFacturas()`/`cargarContadoresFacturas()` (las
   funciones que pueblan el tab "Facturas", definidas en
   `facturacion.js`, cargado en la misma página).
3. `switchTab('facturas')` en `facturacion.html` (línea ~493) solo
   alterna el `display` de los paneles — no recarga datos para el tab
   `'facturas'` (sí lo hace para `'nc'` y `'ch'`), así que el array en
   memoria `facturas` queda desactualizado hasta un reload manual de la
   página.

Contraste: la propia función `anular()` en `facturacion.js` (botón
"Anular" del tab Facturas) sí hace bien las cosas — recarga
`cargarFacturas()` + `cargarContadoresFacturas()` tras anular. El bug es
específico del camino NC → factura vinculada, no del camino directo.

### Corrección F3-05

**`frontend/admin/js/notas-credito.js`** — en `emitirNC()`, después de
`cargarNotasCredito()`:

```diff
     mostrarToast(`NC emitida. CAE: ${data.nc?.cae || '—'}`, 'exito');
     await cargarNotasCredito();
+    // FIX F3-05: si la NC estaba vinculada a una factura, emitirla la
+    // marca como 'anulada' en la BD. El tab "Facturas" no se recarga
+    // solo al volver a él, así que hay que refrescarlo a mano acá.
+    if (typeof window.cargarFacturas === 'function') await window.cargarFacturas();
+    if (typeof window.cargarContadoresFacturas === 'function') await window.cargarContadoresFacturas();
```

`facturacion.js` y `notas-credito.js` son ambos `<script>` clásicos (no
`type="module"`) cargados en `facturacion.html`, así que comparten scope
global — `cargarFacturas`/`cargarContadoresFacturas` (declaradas como
`function` de nivel superior en `facturacion.js`) ya son accesibles como
`window.cargarFacturas`/`window.cargarContadoresFacturas` sin necesidad
de exportarlas explícitamente. Se agrega el chequeo `typeof === 'function'`
por defensividad, mismo estilo que el fix de F3-04.

No se tocó `guardarNC()` (creación, sin emitir): crear una NC no anula
la factura, solo la deja `'pendiente'` — no hay nada que refrescar en el
tab Facturas hasta que se emite.

Verificado con `node --check` sobre `notas-credito.js`.

---

## Flujo 4 — Candidatos con tabs internos sin revisar (`clientes.html`, `auditoria.html`) ✅ Cerrado — sin hallazgos

**`admin/clientes.html`** (modal de detalle de cliente, tabs Datos /
Comercial / Historial / Cuenta cte. / Comprobantes hist. / Bloqueos):
`selTab()` (línea 817 de `clientes.js`) recarga los datos del tab
correspondiente **cada vez** que se selecciona (`cargarCtaCteCliente()`,
`cargarHistorialNotasCliente()`, `cargarComprobantesHistoricosCliente()`,
`cargarBloqueos()`), sin ninguna guarda de "ya cargado, no recargar".
Ninguno de los tabs depende de datos en memoria poblados por otro tab.
Sin hallazgo — este es, de hecho, el patrón correcto (a diferencia del
bug de F3-05, donde el tab "Facturas" de `facturacion.html` sí se
saltaba la recarga).

**`admin/auditoria.html`** (tabs Registro de cambios / Eventos de
negocio): el tab "Eventos" solo carga la primera vez que se abre
(`eventosCargadosAlMenosUnaVez`, comentario explícito en el código: "para
no pagar esa consulta si el usuario nunca la mira"). Es una decisión de
performance deliberada y correcta para este caso — ambos tabs son vistas
de solo lectura sobre logs históricos (`audit_log` / eventos de negocio)
y nada en esta página escribe datos nuevos durante la sesión que pudiera
dejarlos desincronizados entre sí. Sin hallazgo.

---

## Resumen de hallazgos de Fase 3

| ID | Flujo | Bug | Impacto | Estado |
|----|-------|-----|---------|--------|
| F3-03 | Lotes/Vencimientos | `lotes.estado` no se autocorregía; banner "por vencer" siempre 0 | Badges incorrectos; alertas de vencimiento silenciadas | ✅ Corregido |
| F3-04 | Cta-cte → Cobranzas | KPIs de cobranzas stale tras registrar cobro; `invalidarPriorizada` solo con factura vinculada | Dashboard de cobranzas muestra datos viejos hasta F5 manual | ✅ Corregido |
| F3-05 | Notas de crédito → Facturas | Emitir una NC vinculada anula la factura original en BD, pero el tab "Facturas" no se refresca | Grilla/modal muestran estado viejo; botón "Anular" queda disponible para una factura ya anulada | ✅ Corregido |

---

## Lo que ya estaba bien (no hubo hallazgos)

- El flujo Pedidos → Facturación usa páginas separadas con carga fresca.
- `cancelarRuta()` en `rutas.js` ya reseteaba pedidos a `'confirmado'`
  (líneas 485-497 de `rutas.js`, verificado en el análisis).
- La pantalla de `facturacion.html` carga fresca en cada navegación
  (a nivel página; el bug de F3-05 era intra-página, entre tabs).
- `anular()` (tab Facturas) ya refrescaba bien su propio tab tras anular.
- `cheques.js`, `reglas-precio.js`/`comparador-precios.js`,
  `liquidacion.js`, `reportes-ventas.js`/`reportes-stock.js` — sin
  hallazgos (ver detalle de descarte en Flujo 3).
- `clientes.html` (modal con 6 tabs) y `auditoria.html` (2 tabs) — sin
  hallazgos (ver detalle en Flujo 4). El caso de `clientes.html` es,
  además, el ejemplo de cómo *debería* hacerse: recarga en cada cambio
  de tab, sin depender de estado en memoria de otro tab.

---

## Próximo paso

Con Flujo 1, 2, 3 y 4 cerrados, Fase 3 da por cubierto el universo
razonable de sincronización intra-página del panel admin. Falta el pase
manual en navegador real (ver `05_fase5_cierre.md`) — no quedan más
candidatos de código evidentes para un Flujo 5 salvo que aparezca un bug
nuevo reportado por el usuario.
