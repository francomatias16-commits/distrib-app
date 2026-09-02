> **Este documento reemplaza el alcance de `PLAN_E2E_COBERTURA_TOTAL.md` para
> la ejecución actual.** El original queda como referencia histórica y como
> "a dónde volver si algún día se justifica el resto". No se borra nada de
> lo ya escrito ni de lo ya corrido — este recorte solo redefine qué sigue.

# Plan de cobertura E2E (Playwright) — versión recortada

**Motivo del recorte:** el plan original (~360-400h) cubre las 75 páginas
del proyecto con el mismo nivel de profundidad, sin distinguir que P2/P3 ya
tienen una garantía barata y automática (`check-asset-wiring` +
`check-api-wiring` + `check-handler-dispatch`, corriendo hoy en cada
`predeploy`, **0 problemas detectados en las 75 páginas**). Duplicar ese
nivel de esfuerzo en páginas de configuración/reportes de bajo uso no se
justifica. Este documento corta el alcance a lo que realmente mueve la
aguja: P0 + P1 con comportamiento real verificado, y una red de seguridad
barata para el resto.

---

## 1. Qué queda adentro

| Fase | Alcance | Estado | Horas |
|---|---|---|---|
| Fase 0 — Cimientos | helpers reusables (auth, page-object-base, mocks genéricos) | ✅ Hecho | 12–16h (ya invertidas) |
| Fase 1 — P0 (9 páginas críticas) | `pedidos`, `pos`, `stock`, `facturacion`, `cobranzas`, `clientes`, `cta-cte`, `compras`, `productos` | ✅ Cerrado, 32/32 confirmado contra Chromium real | ~72h (ya invertidas) |
| Fase 2 — P1 (~20 páginas) | Operación diaria: rutas, compras, cta-cte, devoluciones/cheques/conciliación, usuarios/proveedores/notas/presupuestos, portal cliente (8/8), portal chofer (4/5) | 🔶 En curso — falta solo `chofer/remito.html` para cerrar | ~100h (mayoría ya invertida, resta ~1 página) |
| **Fase 0.5 — Smoke universal barato (NUEVA)** | Un único spec parametrizado que visita las 75 páginas, hace login, y confirma: sin 404 de assets (ya lo cubre el check estático), sin error de consola, el layout principal renderiza | 🔲 No arrancada | **~8h** |

**Total del recorte: lo ya invertido en Fases 0-2 + ~1 página pendiente de
Fase 2 + 8h de smoke universal.** Comparado con las 360-400h originales,
el recorte cierra en **muy por debajo de 200h en total**, con la mayor
parte ya hecha.

---

## 2. Qué queda afuera (por ahora, no cancelado)

| Fase original | Por qué se saca del alcance activo | Qué lo reemplaza mientras tanto |
|---|---|---|
| Fase 3 — P2 (~25 páginas, config/reportes) | Bajo uso, mayormente lectura, bajo riesgo de negocio | Check estático (ya en verde) + Fase 0.5 smoke |
| Fase 4 — P3 (~15 páginas, superadmin/auditoría/interno) | Uso interno/infrecuente, bajo riesgo de negocio | Check estático (ya en verde) + Fase 0.5 smoke |
| Fase 5 — Tier 2 (integración real backend) | Requiere infraestructura nueva (harness + tenant de test) que no existe hoy; valor real pero no bloqueante | Pase manual (`checklist_pase_manual.md`) + `TESTING_OPTIMIZACION.md` para los flujos cross-módulo más críticos |
| Fase 6 — CI + gate de cobertura | No tiene sentido armar un gate de cobertura sobre una suite que todavía no corrió completa contra Chromium real | Se retoma cuando Fase 2 esté 100% cerrada y corrida |

**Disparador de reapertura:** si en algún momento aparece un bug real en
producción en una página P2/P3 que un test de comportamiento hubiese
atrapado, se promueve esa página puntual a cobertura profunda — no hace
falta reabrir la fase entera.

---

## 3. Próximos pasos concretos, en orden

1. **Cerrar `chofer/remito.html`** (firma + geolocalización) — última pieza
   de Fase 2. Cierra P1 al 100%.
2. **Correr toda la Fase 2 contra Chromium real** — hoy varios specs están
   escritos pero no corridos (ver estado de sección 29 del plan original).
   Sin esto, P1 "cerrado" es teórico, no confirmado.
3. **Fase 0.5 — smoke universal (8h)** — cobertura básica del 100% de las
   75 páginas. Es la pieza de mejor relación costo/beneficio de todo el
   plan recortado.
4. **Stop.** Evaluar de nuevo solo si cambia el contexto (equipo más
   grande, incidentes reales en P2/P3, o necesidad real de Tier 2 por un
   flujo cross-módulo que rompió en producción).

---

## 4. Qué NO cambia respecto al plan original

- Los checks estáticos (`check-asset-wiring`, `check-api-wiring`,
  `check-handler-dispatch`) siguen corriendo en `predeploy`, sin tocar.
- Todo lo ya escrito y cerrado de Fases 0-2 queda tal cual, no se re-hace.
- El pase manual (`checklist_pase_manual.md`) y las sesiones de
  `TESTING_OPTIMIZACION.md` siguen siendo la red de seguridad real para
  todo lo que este recorte no cubre.
