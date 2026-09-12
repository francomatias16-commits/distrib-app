-- 20260912180000_621_revoke_anon_facturas_proveedor_pagos.sql
--
-- Etapa 1 del plan de auditoría de dinero (2026-09) — "Confirmar SECURITY
-- DEFINER + empresa_id seguro" en el módulo de facturas (incluye
-- facturas_proveedor/pagos_proveedor). Revisión módulo por módulo vía
-- Supabase MCP contra la base real, no solo el heurístico genérico de
-- `audit_security_definer_grants()` (que da 0 riesgo_potencial acá
-- porque las 3 funciones SÍ validan `empresa_id`/rol adentro — el
-- heurístico no distingue "anon puede intentar pero es rechazado" de
-- "no debería ni poder intentarlo").
--
-- Encontrado: `alta_factura_proveedor`, `editar_factura_proveedor` y
-- `registrar_pago_proveedor` son SECURITY DEFINER, mutan datos
-- financieros, y tenían EXECUTE otorgado a `anon` (default de Postgres
-- al crearlas) además de `authenticated`. A diferencia del hallazgo ya
-- cerrado de `conciliar_cta_cte`/`conciliar_stock_por_producto`
-- (migración 608 — esas no validaban nada), estas 3 SÍ tienen el guard
-- correcto al principio del cuerpo:
--   IF auth.role() <> 'service_role' AND p_empresa_id IS DISTINCT FROM
--   public.get_empresa_id() THEN RETURN ... 'No autorizado' END IF;
--   IF auth.role() <> 'service_role' AND public.get_rol_usuario() NOT IN
--   ('dueno','admin','contador') THEN RETURN ... 'No autorizado' END IF;
-- Para una key `anon` real, `get_empresa_id()` resuelve a NULL (sin
-- sesión), así que el primer IF ya corta cualquier llamada — no hay
-- vector de explotación real confirmado.
--
-- Aun así, el resto de las RPCs de escritura financiera del proyecto
-- (`registrar_venta_pos`, `registrar_cobro_completo`, `crear_nota_credito`,
-- `anular_venta_pos`, etc.) NO tienen EXECUTE para `anon` — solo para
-- `authenticated`. Que estas 3 sí lo tengan es una inconsistencia con el
-- resto del proyecto, no una decisión de diseño documentada en ningún
-- lado. Se cierra por el mismo criterio de defensa en profundidad ya
-- aplicado en 493/514/608: que el guard interno hoy sea correcto no es
-- motivo para dejarle a `anon` la posibilidad de invocar la función —
-- un cambio futuro en `get_empresa_id()`/`get_rol_usuario()` (o un typo
-- en el guard) sería inmediatamente explotable por cualquiera con la
-- anon key pública si el grant sigue abierto.
--
-- No rompe nada: los llamadores reales pasan por `authenticated` (el
-- frontend admin autenticado) o por `service_role` (que ignora estos
-- GRANTs) — ninguno depende de que `anon` pueda ejecutarlas.

-- alta_factura_proveedor y editar_factura_proveedor tenían el EXECUTE
-- otorgado a nivel PUBLIC (no como grant directo a `anon`) — un REVOKE
-- ... FROM anon solo no alcanza, porque `anon` sigue heredando el
-- permiso vía PUBLIC. Se revoca de PUBLIC y se re-otorga explícito a
-- `authenticated` para no perder el acceso real (verificado después
-- contra la base: antes de este ajuste el REVOKE FROM anon por sí solo
-- no había bajado el `has_function_privilege('anon', ..., 'EXECUTE')`
-- real, quedó registrado acá para que el historial de este archivo
-- refleje el fix efectivo, no el primer intento incompleto).
REVOKE EXECUTE ON FUNCTION public.alta_factura_proveedor(
  uuid, uuid, text, date, uuid, text, date, numeric, text, jsonb, numeric, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alta_factura_proveedor(
  uuid, uuid, text, date, uuid, text, date, numeric, text, jsonb, numeric, uuid
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.editar_factura_proveedor(
  uuid, uuid, timestamptz, text, text, boolean, date, text, text, date, numeric,
  boolean, uuid, boolean, jsonb, numeric, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.editar_factura_proveedor(
  uuid, uuid, timestamptz, text, text, boolean, date, text, text, date, numeric,
  boolean, uuid, boolean, jsonb, numeric, uuid
) TO authenticated;

-- registrar_pago_proveedor no tenía el grant a nivel PUBLIC (solo un
-- grant directo a `anon` explícito) — acá el REVOKE FROM anon solo sí
-- alcanzó, verificado contra la base.
REVOKE EXECUTE ON FUNCTION public.registrar_pago_proveedor(
  uuid, uuid, uuid, numeric, text, date, text, text, uuid, uuid, text
) FROM anon;

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '20260912180000_621_revoke_anon_facturas_proveedor_pagos.sql', '621', 'claude-session',
  'Etapa 1 auditoria de dinero: alta_factura_proveedor/editar_factura_proveedor/'
  'registrar_pago_proveedor tenian EXECUTE para anon ademas de authenticated, '
  'inconsistente con el resto de RPCs financieras del proyecto. Validan '
  'empresa_id/rol correctamente adentro (no explotable hoy), se revoca anon '
  'igual por defensa en profundidad, mismo criterio que 493/514/608.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
