# Etapa 6 — Consistencia y robustez end-to-end

**Estado:** 🟢 Cerrada — CONS-01/02/03 corregidos y verificados contra producción.

> **Nota:** este archivo se reconstruyó a partir del historial de la sesión
> que cerró esta etapa — el ZIP de partida traía un stub sin contenido
> ("No iniciada"), desactualizado respecto al trabajo ya hecho.

## CONS-02 (el más grave) — 3 funciones desbloqueaban crédito indebido por una fórmula de deuda que no reconocía facturas como cargo

`registrar_cobro_completo`, `calcular_deuda_cliente` y `calcular_score_cliente`
recalculaban la deuda del cliente con una fórmula (`WHEN tipo = 'debito' ...
ELSE -monto`) que no reconocía `'factura'` como un tipo de cargo válido.
Efecto en cadena:
- Desbloqueo automático de crédito indebido para clientes que en realidad
  tenían deuda real.
- La oferta de plan de pago por WhatsApp nunca se disparaba (dependía de que
  `calcular_deuda_cliente` reportara deuda correctamente).
- El score de deuda de cualquier cliente quedaba siempre en el máximo.

**Fix:** las 3 funciones pasan a leer `clientes.saldo_deuda` directamente (ya
correcto vía trigger), en vez de recalcular con la fórmula rota.

## CONS-01 — Trigger de sincronización de deuda fallaba en silencio ante tipos no reconocidos

`sync_saldo_deuda_cliente` tenía un `ELSE 0` silencioso: cualquier fila con un
`tipo` no reconocido (se encontraron 2 filas demo con `tipo IN ('debe',
'haber')`, valores viejos que no correspondían a la taxonomía actual)
contribuía 0 al saldo en vez de fallar visiblemente.

**Fix:** el trigger ahora falla fuerte ante un tipo no reconocido (en vez de
absorberlo en silencio) y se corrigieron las 2 filas demo con la taxonomía
vieja.

## CONS-03 — `registrar_movimiento_cta_cte` escribía en la columna que nadie leía

La función escribía el monto solo en la columna `importe`, pero el trigger de
sincronización de deuda lee `monto` — las dos columnas coexistían con
significados solapados. El caller real de esta función tampoco tenía
autorización explícita (`EXECUTE` estaba otorgado a `authenticated` sin que
hubiera ningún caller legítimo real vía esa vía).

**Fix:** la función ahora escribe en ambas columnas, y se revocó `EXECUTE` de
`authenticated` (sin caller real confirmado).

## Verificación de cierre
- Migración `293_fix_cons_saldo_deuda_taxonomia_tipo_cta_cte.sql` aplicada
  directamente contra producción (Supabase, vía integración).
- Verificado post-aplicación: `calcular_deuda_cliente` ya no usa la fórmula
  rota; las 2 filas demo con taxonomía vieja quedaron corregidas.
- Documento de seguimiento del plan (`00_PLAN_MAESTRO.md`) actualizado a
  🟢 Cerrada.

## Relación con hallazgos de higiene de otras etapas
Los 2 ítems de higiene detectados en la Etapa 1 (BUG-01: fallback silencioso
de `sanitize`; BUG-02: mayoría de módulos admin bypasea `api-client.js` y
pega directo a PostgREST) encajan temáticamente en esta etapa
(consistencia/robustez), pero no se resolvieron acá — quedan como deuda
técnica de bajo riesgo, no explotable hoy porque Etapa 2 (RLS) y Etapa 5
(`sanitize` sí carga) ya acotan el impacto real.
