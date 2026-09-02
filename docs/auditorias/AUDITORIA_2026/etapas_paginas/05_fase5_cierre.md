# Fase 5 — Cierre y checklist de regresión (auditoría de páginas)

**Fecha:** 2026-08-07 (actualizado — Flujo 1, 2 y 3 de Fase 3 cerrados).

---

## 1. Lo que necesita tu acción — en orden de importancia real

| # | Qué | Por qué importa | Esfuerzo |
|---|-----|------------------|----------|
| 1 | **Pase manual en navegador real** sobre F4-01, F4-02, F4-03, los 3 flujos de migración de stock, UI-003, **F3-03** (verificar banner "por vencer"), **F3-04** (verificar que KPIs de cobranzas se actualizan tras registrar un cobro) y **F3-05** (crear y emitir una NC vinculada a una factura desde `facturacion.html`, volver al tab Facturas y verificar que aparece "Anulada" sin recargar) | Todo el análisis fue estático — ningún fix se ejecutó en navegador real todavía | ~40-50 min |
| 2 | Confirmar visualmente que los 12 modales corregidos con `style="display:none"` (11 de UI-002 + `modal-zona` de UI-003) no rompieron ningún layout existente | Bajo riesgo | 5 min, sumable al pase manual |

---

## 2. Estado real por fase

| # | Fase | Estado |
|---|------|--------|
| 0 | Barrido automático (75 páginas) | 🟢 Completa — 0 hallazgos abiertos |
| 1 | Inventario y priorización | 🟢 Completa |
| 2 | Pase funcional por página | 🟢 Análisis estático 100% (75/75 páginas). Falta el pase manual en navegador real |
| 3 | Sincronización de datos entre páginas (mismo rol) | 🟢 **Completa** — Flujo 1 (F3-03, lotes/vencimientos), Flujo 2 (F3-04, Cta-cte → Cobranzas KPIs) y Flujo 3 (F3-05, NC → Facturas) corregidos; Flujo 4 (`clientes.html`, `auditoria.html`) sin hallazgos. Falta pase manual en navegador real |
| 4 | Sincronización entre roles | 🟢 Completa en código. Falta pase manual |
| 5 | Cierre | 🟡 Este documento |

---

## 3. Hallazgos corregidos hasta ahora

| ID | Hallazgo | Dónde se corrigió |
|----|----------|---------------------|
| UI-001 | Modal "Nuevo lote" en `vencimientos.html` se abría solo al cargar | HTML — `style="display:none"` agregado |
| UI-002 | 11 modales en 5 páginas de Nivel 1 con el mismo patrón de fragilidad | HTML — `display:none` agregado preventivamente en los 11 |
| UI-003 | `modal-zona` en `admin/rutas.html` (pestaña Zonas) — mismo patrón que UI-001 | HTML — `style="display:none"` agregado a `#modal-zona` |
| F4-01 a F4-04 | Ver auditoría de módulos/roles | Código + DB, ya cerrados |
| **F3-03** | **`lotes.estado` no se autocorregía al listar lotes — `actualizar_estado_lotes()` nunca se invocaba. Badge mostraba "Activo" para lotes vencidos. Además el banner "por vencer" en `lotes.js` filtraba `l.estado === 'por_vencer'` — estado inexistente en el constraint actual `('activo','agotado','vencido')` — banner siempre contaba 0.** | **`lib/repos/stock.js` + `lib/repos/automatizacion.js` (RPC autocorrectora). `frontend/admin/js/lotes.js` `mostrarAlertas()` reescrita para calcular "por vencer" desde `fecha_vencimiento` comparando contra hoy+7d.** |
| **F3-04** | **`guardarCobro()` en `cta-cte.js` no refrescaba los KPIs de cobranzas ("Cobrado hoy", "Vence hoy", "Total vencido", medios de pago) tras registrar un cobro — quedaban stale hasta F5 manual. Además `invalidarCobranzaPriorizada()` solo se llamaba con `facturaVinculadaCobro`, dejando caché sucio en cobros genéricos.** | **`frontend/admin/js/cta-cte.js`: `invalidarCobranzaPriorizada()` ahora siempre se llama + nueva llamada a `window.refrescarKPIsCobranzas()`. `frontend/admin/js/cobranzas.js`: nueva función pública `refrescarKPIsCobranzas()` que re-fetches cobrosHoy + fn_cobranzas_kpis en Promise.all y actualiza el DOM sin rerenderizar tabs.** |

## 4. Lo que ya estaba bien
El barrido completo de las 75 páginas no encontró ningún otro caso del
patrón CSS-cascada-sin-scope más allá de UI-001 y UI-003. Los 72 IDs
"huérfanos" candidatos de Nivel 2/3 fueron, sin excepción, falsos
positivos.

## 5. Cómo continuar en una sesión nueva
Subí el zip de trabajo y decime:
- **"seguí con Fase 3"** o **"arrancá Flujo 3"** → trazamos un flujo
  adicional de sincronización entre páginas (Flujo 1 y 2 ya están
  cerrados).
- **"hagamos el pase manual"** → repasamos el checklist de §1, punto 1.
