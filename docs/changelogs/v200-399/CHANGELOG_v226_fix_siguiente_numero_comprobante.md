# CHANGELOG v226 — Fix ownership check en siguiente_numero_comprobante

## Hallazgo (Auditoría de seguridad multi-tenant, Fase 18)

`siguiente_numero_comprobante(p_empresa_id, p_tipo)` — función `SECURITY
DEFINER` usada para asignar el próximo número de comprobante — tenía un
bypass en el chequeo de ownership.

### Verificado en la base antes de tocar nada

- **Grants actuales**: `anon` **no** tiene `EXECUTE` sobre esta función (solo
  `postgres`, `authenticated`, `service_role`). El vector de "callable por
  anon" descripto en el hallazgo original ya no aplica al grant en sí — pero
  el bug de lógica de abajo sí seguía presente y es más grave porque afecta
  a cualquier caller no autorizado, no solo a `anon`.
- **El bug real**: la condición de guardia era
  ```sql
  IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM public.get_empresa_id() THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;
  ```
  Si se llama con `p_empresa_id = NULL` y el caller no tiene sesión válida
  (`get_empresa_id()` devuelve `NULL` cuando `auth.uid()` es `NULL`), la
  comparación `NULL IS DISTINCT FROM NULL` da `FALSE` → la excepción nunca
  se disparaba. La función seguía de largo con `p_empresa_id = NULL`.
- **Impacto real acotado**: no había leak de datos de otra empresa —
  `contadores_empresa.empresa_id` es `NOT NULL`, así que el `INSERT`
  hubiera fallado con un error de constraint. Pero el chequeo de
  autorización en sí era conceptualmente incorrecto: no exigía que el
  caller tuviera una sesión válida asociada a una empresa, solo que los
  valores "no fueran distintos" (lo cual es trivialmente cierto si ambos
  son `NULL`).
- Confirmado también: no hay triggers `UPDATE` conflictivos y no hay
  overloads adicionales de la función que pudieran quedar con el bug viejo.

## Fix aplicado (migración `fix_siguiente_numero_comprobante_ownership_check`)

- Reescrita la validación para exigir explícitamente que
  `get_empresa_id()` no sea `NULL` (sesión válida asociada a una empresa) y
  que `p_empresa_id` tampoco sea `NULL`, antes de comparar igualdad:
  ```sql
  IF auth.role() <> 'service_role' THEN
    v_empresa_actual := public.get_empresa_id();
    IF v_empresa_actual IS NULL OR p_empresa_id IS NULL OR p_empresa_id IS DISTINCT FROM v_empresa_actual THEN
      RAISE EXCEPTION 'No autorizado';
    END IF;
  END IF;
  ```
- Defensa en profundidad: `REVOKE ALL ... FROM PUBLIC, anon` explícito +
  `GRANT EXECUTE ... TO authenticated, service_role` explícito, para no
  depender de que el grant "por omisión" se mantenga así en el futuro.

## No probado en vivo

No se ejecutó la función contra una empresa real para no incrementar un
contador de numeración de comprobantes en producción. La corrección se
validó por revisión de lógica + aplicación exitosa de la migración
(sintaxis y grants confirmados post-deploy).

## Pendiente (Fase 18, hallazgo 2)

Sigue abierto el conjunto más amplio de funciones `SECURITY DEFINER` que
aceptan `p_empresa_id` y podrían compartir el mismo patrón de chequeo
débil — es el próximo paso.
