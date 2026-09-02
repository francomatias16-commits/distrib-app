# CHANGELOG v315 — Auditoría de módulos, etapa 10 (Fidelización)

Este zip es un delta chico: solo lo que cambió respecto al
`distrib_v314_etapa7` de la sesión anterior. Ver detalle completo de los
6 hallazgos en `AUDITORIA_2026/etapas_modulos/10_fidelizacion_puntos_recompensas.md`.

## Resumen

| # | Hallazgo | Severidad | Estado |
|---|---|---|---|
| 1 | RLS de puntos/recompensas sin aislar por cliente ni por rol — cualquier cliente podía leer y **escribir** puntos de otros clientes | 🔴 Crítica | ✅ DB (producción) |
| 2 | Cancelar un pedido no revertía los puntos ya acreditados | 🟡 Media | ✅ DB + código |
| 3 | Botón "Aplicar"/"Expirar" canje fallaba en silencio (sin policy UPDATE) | 🔴 Alta-media | ✅ DB (parte del fix #1) |
| 4 | `puntos_minimos_canje` configurado pero nunca usado en el canje | 🟢 Baja | ✅ DB |
| 5 | KPI "Puntos bonus este mes" mostraba siempre 0 | 🟢 Baja | ✅ Código |
| 6 | POS no acredita puntos de fidelización | 🟢 Informativo | ⚪ Requiere decisión de producto |

## Archivos modificados
- `lib/handlers/pedidos.js` — al cancelar un pedido (`DELETE`), ahora
  llama a la RPC `revertir_puntos_pedido_cancelado()` para devolver los
  puntos ganados por ese pedido (Hallazgo 2).
- `frontend/admin/js/fidelizacion.js` — el KPI "Puntos bonus este mes"
  (siempre 0, `tipo='bonus'` nunca se inserta) se reemplazó por "Puntos
  ganados este mes" (`tipo='ganancia'`, dato real) (Hallazgo 5).
- `AUDITORIA_2026/etapas_modulos/00_INDICE.md` (actualizado),
  `10_fidelizacion_puntos_recompensas.md` (nuevo).
- `supabase/migrations/296_fix_etapa10_h1_rls_fidelizacion_aislamiento_cliente.sql` (nuevo)
- `supabase/migrations/297_fix_etapa10_h4_canjear_recompensa_puntos_minimos.sql` (nuevo)
- `supabase/migrations/298_fix_etapa10_h2_revertir_puntos_pedido_cancelado.sql` (nuevo)

## Base de datos (Supabase)
Ya aplicado directo en producción, sin acción pendiente (migraciones 296,
297, 298 — registradas en `schema_migrations_registry`):
- Políticas RLS de `saldo_puntos`, `movimientos_puntos`, `recompensas`,
  `programas_fidelizacion` y `canjes_recompensas` corregidas para aislar
  por cliente (SELECT) y restringir escritura a `es_admin()` (Hallazgo 1,
  incluye el fix del Hallazgo 3).
- `canjear_recompensa()` ahora valida `puntos_minimos_canje` (Hallazgo 4).
- Nueva RPC `revertir_puntos_pedido_cancelado()` (Hallazgo 2).

## Pendiente
- `git push` / deploy a Vercel para que los fixes de código (Hallazgos 2
  y 5) tengan efecto (la parte de base de datos ya está viva).
- Definir con el usuario si conviene desplegar ya todo lo acumulado
  (etapas 1-5, 8 y 10) antes de seguir sumando más etapas sin deployar.
- Etapas 6 (Rutas y entregas), 7 (POS), 9 (Notas de crédito/devoluciones),
  11 (Usuarios y roles) y 12 (Notificaciones fuera de pedidos) siguen
  pendientes — ver `AUDITORIA_2026/etapas_modulos/00_INDICE.md`.
