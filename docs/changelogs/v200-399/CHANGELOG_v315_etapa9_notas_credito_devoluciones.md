# v315 — Auditoría por módulos, Etapa 9: Notas de crédito y débito / devoluciones

Ver detalle completo en `AUDITORIA_2026/etapas_modulos/09_notas_credito_debito_devoluciones.md`.

## Resumen

1. **🔴 Crítico — `aplicar_nota_credito_cta_cte` rota, ya corregida en Supabase.**
   El INSERT a `cta_cte` omitía `empresa_id` y `monto` (NOT NULL sin
   default) y usaba la columna legacy `importe` en su lugar. El RPC fallaba
   siempre, en silencio (nadie revisaba el error), dejando cualquier NC
   emitida en estado `pendiente` para siempre y sin aplicar nunca el
   crédito al cliente. Verificado en vivo antes y después del fix.
   Migración `315` ya aplicada en producción.

2. **🔴 Alta — Aprobar una devolución ahora repone stock y/o genera NC,**
   según lo que tilde el admin (antes no hacía ninguna de las dos cosas
   pese a que la página lo prometía). `handleDevolucionesAdmin` (`PATCH
   ?accion=revisar`) acepta `reponer_stock` y `generar_nc`.

3. **🟡 Media — Ambos caminos de emisión de NC (manual y ARCA) ahora
   revisan el error de `aplicar_nota_credito_cta_cte`** en vez de
   ignorarlo, para que un fallo futuro sea visible.

## Archivos modificados
- `supabase/migrations/315_etapa9_fix_aplicar_nota_credito_cta_cte.sql` (nuevo — ya aplicada en Supabase)
- `lib/handlers/facturas.js` (chequeo de error en ambos caminos de emisión de NC)
- `lib/handlers/pedidos.js` (`handleDevolucionesAdmin` — reponer stock / generar NC al aprobar)
- `frontend/admin/js/devoluciones.js` (checkboxes de reponer stock / generar NC, toast con resultado real)
- `AUDITORIA_2026/etapas_modulos/09_notas_credito_debito_devoluciones.md` (nuevo)
- `AUDITORIA_2026/etapas_modulos/00_INDICE.md` (actualizado)

## Pendiente
- `git push` / deploy a Vercel para que el fix de código (Hallazgos 2 y 3)
  tenga efecto — el de la DB (Hallazgo 1) ya está viviendo en Supabase.
- Etapas 6 (Rutas y entregas), 7 (POS), 10 (Fidelización), 11 (Usuarios y
  roles) y 12 (Notificaciones fuera de pedidos) siguen pendientes.
