# Seguimiento de pendientes en changelogs sueltos (25/08/2026)

Barrido de los 421 changelogs sueltos (hoy organizados en
`docs/changelogs/`). Se buscaron marcadores explícitos de trabajo abierto
("queda pendiente", "no se pudo resolver", etc.) y se verificó cada uno
contra changelogs posteriores y contra el código actual.

| # | Changelog | Pendiente anotado | Estado verificado |
|---|---|---|---|
| 1 | `v559_fase6_reglas_automatizacion` | Cron de Vercel para `despacharPendientes()` | ✅ Resuelto en v599 |
| 2 | `v685_fase8_distincion_pendientes_sin_listener` | Validar `MINUTOS_ERROR_PROLONGADO=120` contra producción | ✅ Cerrado en el mismo changelog |
| 3 | `v572/v583_fase7_productos_pedidos` | 97 `.from()` sueltos en `pedidos.js`/`pos.js` | ✅ **Resuelto** — verificado 0 llamadas directas a tablas en `pedidos.js` (ver `docs/tecnico/ARQUITECTURA_ACTUAL.md`, incluye corrección de un falso positivo de la primera medición) |
| 4 | `v305_etapa1_hallazgo2_notif_log` | Punto 3: retry automático de emails | 🔴 **Sin changelog de cierre encontrado** — candidato real a revisar |
| 5 | `v220_fix_onclick_y_diagnostico_pedido` | Migrar `onclick` a `addEventListener` con delegación | 🔴 Sin fix posterior — deuda técnica menor, no funcional |
| 6 | `v368_fix_push_admin_404` | `inicializarPushAdmin` en `dashboard-optimizado.js` no tocado | 🔴 Nota aislada, bajo impacto |
| 7 | `v710_asistente_crud_productos_por_voz` | Reactivar producto inactivo no soportado por voz | 🟡 Limitación de alcance documentada, con workaround (se hace desde el panel) |

## Conclusión

Nada de seguridad ni bugs funcionales escondidos. Los dos ítems con algo de
sustancia real para una próxima ronda son el **#3** (ya cuantificado y
priorizado en el plan de arquitectura) y el **#4** (retry automático de
emails — no requiere análisis previo, solo confirmar si sigue sin
implementarse en `lib/handlers/notif.js` y decidir si se hace).
