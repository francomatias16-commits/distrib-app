-- ─────────────────────────────────────────────────────────────────────────
-- 395_contador_uso_serper.sql
--
-- v394 reemplazó Google CSE por Serper.dev para la Capa 2 de auto-imagenes
-- (foto real por nombre). Serper da 2.500 consultas gratis y después es
-- pago por créditos prepagos — pero no hay forma de ver desde el admin
-- cuánto se lleva gastado sin entrar a serper.dev. Esta migración agrega
-- un contador interno simple, GLOBAL (no por empresa): la SERPER_API_KEY
-- es una sola env var compartida por todos los tenants de distrib, así que
-- el gasto también es compartido — cada consulta cuenta contra el mismo
-- saldo sin importar de qué empresa sea el producto.
--
-- Es un conteo aproximado propio, no el saldo real de Serper (no hay forma
-- de leer el saldo exacto sin pegarle a su dashboard/API de cuenta) — sirve
-- para tener una referencia rápida sin salir del admin, no para facturación.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contador_uso_apis (
  servicio      text PRIMARY KEY,
  usados        bigint NOT NULL DEFAULT 0,
  actualizado_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.contador_uso_apis (servicio, usados)
VALUES ('serper', 0)
ON CONFLICT (servicio) DO NOTHING;

-- Incremento atómico (evita condiciones de carrera cuando varios productos
-- del mismo lote llaman a Serper en paralelo vía Promise.all). SECURITY
-- DEFINER porque lo llama el backend con el service role, no hace falta
-- exponerlo a RLS de usuarios finales.
CREATE OR REPLACE FUNCTION public.fn_incrementar_contador_api(p_servicio text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_usados bigint;
BEGIN
  INSERT INTO public.contador_uso_apis (servicio, usados, actualizado_at)
  VALUES (p_servicio, 1, now())
  ON CONFLICT (servicio) DO UPDATE
    SET usados = public.contador_uso_apis.usados + 1,
        actualizado_at = now()
  RETURNING usados INTO v_usados;

  RETURN v_usados;
END;
$function$;

COMMENT ON FUNCTION public.fn_incrementar_contador_api(text) IS
  'v395: incrementa en 1 el contador interno de uso de una API externa '
  '(hoy solo "serper"). Incremento atómico vía UPSERT, seguro para llamadas '
  'concurrentes.';

INSERT INTO public.schema_migrations_registry (carpeta, archivo, numero, aplicada_por, notas)
VALUES ('db', '395_contador_uso_serper.sql', '395', 'claude-session',
  'Agrega contador_uso_apis (global, no por empresa) y fn_incrementar_contador_api '
  'para trackear consultas a Serper.dev desde auto-imagenes.js — referencia '
  'aproximada del gasto, visible ahora en el admin de productos.')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
