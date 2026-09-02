# Auditoría funcional de páginas y sincronización — tablero de seguimiento

**Inicio:** 2026-08-06
**Alcance:** las 75 páginas HTML reales de `frontend/` (admin, cliente,
chofer, proveedor, scan-pos y páginas públicas), buscando bugs de
*comportamiento/UI* (no seguridad, no lógica de negocio backend) que
impiden el uso normal de una página o rompen la sincronización de datos
entre páginas.

**Distinta de las otras dos auditorías de esta carpeta:**
- `AUDITORIA_2026/etapas/` = seguridad e infraestructura (RLS, backend,
  integraciones). 🟢 Cerrada.
- `AUDITORIA_2026/etapas_modulos/` = lógica de negocio por módulo
  (pedidos, stock, facturación, etc.). 🟢 Cerrada.
- **Esta carpeta (`etapas_paginas/`)** = funcionalidad real de UI y
  consistencia de datos entre pantallas. Nace del bug real encontrado el
  2026-08-06: el modal "Nuevo lote" en `vencimientos.html` se abría solo
  al cargar la página, por un conflicto entre dos hojas de estilo
  compartidas.

## Plan en 5 fases
| # | Fase | Estado | Archivo |
|---|------|--------|---------|
| 0 | Barrido automático (scripts sobre las 75 páginas) | 🟢 Completa | — |
| 1 | Inventario y priorización | 🟢 Completa | — |
| 2 | Pase funcional por página (checklist manual) | 🟢 Análisis estático completo (Nivel 1, 2 y 3 — 75/75 páginas). Falta el pase manual en navegador real | `03_fase2_nivel2_nivel3.md` |
| 3 | Sincronización de datos entre páginas | 🟢 Completa en código y en cobertura — Flujo 1 (F3-03), Flujo 2 (F3-04) y Flujo 3 (F3-05) corregidos; Flujo 4 (`clientes.html`, `auditoria.html`) revisado sin hallazgos. Falta pase manual en navegador real | `06_fase3_sincronizacion.md` |
| 4 | Sincronización entre roles (admin/cliente/chofer/proveedor) | 🟢 Completa en código — F4-01/02/03/04 corregidos, F4-05 sin hallazgos. Falta pase manual en navegador real | — |
| 5 | Cierre y checklist de regresión | 🟡 Ver `05_fase5_cierre.md` | `05_fase5_cierre.md` |

Leyenda: 🟢 completa · 🟡 en progreso · 🔴 con hallazgos críticos sin resolver · ⚪ no iniciada

## Resumen de hallazgos corregidos hasta ahora
| ID | Hallazgo | Fase | Estado |
|----|----------|------|--------|
| UI-001 | Modal "Nuevo lote" en `vencimientos.html` se abría solo al cargar (conflicto CSS `compras.css` vs `finanzas.css` sobre `.modal-overlay`, sin scope) | Reportado por el usuario, previo a Fase 0 | ✅ Corregido — `style="display:none"` agregado al modal en el HTML |
| UI-002 | 11 modales en 5 páginas de Nivel 1 dependían 100% del JS para ocultarse al cargar, sin red de seguridad en el HTML | Fase 0 | ✅ Corregido preventivamente — `style="display:none"` agregado a los 11 |
| **UI-003** | **`modal-zona` en `admin/rutas.html` (pestaña "Zonas", controlado por `zonas.js`) es exactamente el mismo patrón que causó UI-001: `rutas.css` define `.modal-overlay { display:flex }` por defecto pero `compras.css` (cargada después en el `<head>`) redefine `.modal-overlay { display:none }` sin relación de scope — hoy el orden de carga hace que "gane" `display:none` por casualidad, pero es tan frágil como el bug original y no tiene red de seguridad en el HTML** | **Fase 2 (Nivel 2)** | **✅ Corregido — `style="display:none"` agregado al modal en el HTML** |
| F4-01 a F4-04 | Ver detalle en auditoría de módulos/roles | Fase 4 | ✅ Corregidos |
| **F3-03** | **`lotes.estado` no se autocorregía al listar: `actualizar_estado_lotes()` nunca se invocaba y estaba rota por cambio de constraint. Badge mostraba "Activo" para lotes vencidos/agotados. Además, el banner "por vencer" en `lotes.js` filtraba por `l.estado === 'por_vencer'` — estado que no existe en el constraint actual `('activo','agotado','vencido')` — siempre contaba 0.** | **Fase 3, Flujo 1** | **✅ Corregido — RPC autocorrectora cablea en `lib/repos/stock.js` (`listarLotes`) y `lib/repos/automatizacion.js` (`listarLotesPorVencer`). Banner `mostrarAlertas()` en `frontend/admin/js/lotes.js` rehecho para calcular "por vencer" desde `fecha_vencimiento`.** |
| **F3-04** | **`guardarCobro()` en `cta-cte.js` no refrescaba los KPIs de cobranzas ("Cobrado hoy", "Vence hoy", "Total vencido", medios de pago) tras registrar un cobro — quedaban stale hasta que el usuario recargaba `cobranzas.html`. Además, `invalidarCobranzaPriorizada()` solo se llamaba cuando había `facturaVinculadaCobro`, dejando el caché sucio en cobros genéricos.** | **Fase 3, Flujo 2** | **✅ Corregido — `cta-cte.js` ahora llama siempre a `invalidarCobranzaPriorizada()` y a la nueva `window.refrescarKPIsCobranzas()`. `cobranzas.js` expone `refrescarKPIsCobranzas()`: re-fetches cobrosHoy + fn_cobranzas_kpis en Promise.all y actualiza el DOM sin rerenderizar las tabs.** |
| **F3-05** | **Emitir una Nota de Crédito vinculada a una factura la marca `'anulada'` en la BD, pero el tab "Facturas" de `facturacion.html` no se refrescaba — grilla y modal de detalle seguían mostrando el estado viejo (con botón "Anular" disponible) hasta recargar la página.** | **Fase 3, Flujo 3** | **✅ Corregido — `emitirNC()` en `notas-credito.js` ahora llama a `window.cargarFacturas()` y `window.cargarContadoresFacturas()` (compartidas por scope global con `facturacion.js`) tras emitir con éxito.** |

## Próximo paso
Ver `05_fase5_cierre.md`. Queda el pase manual en navegador real (todos
los flujos de Fase 3 corregidos/revisados: F3-03, F3-04, F3-05, Flujo 4
sin hallazgos). Fase 3 se considera cubierta salvo que aparezca un bug
nuevo reportado por el usuario.
