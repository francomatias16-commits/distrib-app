-- ============================================================
-- 590_fase5_vista_eventos_negocio_completo.sql
-- PLAN_ERP_SINCRONIZACION_2026.md — Fase 5: auditoría de negocio
-- centralizada. Cierre de un gap real encontrado en la verificación de
-- la fase (checklist §6 del plan): el panel "Eventos de negocio" de
-- auditoria.html (frontend/admin/js/auditoria.js, sección Fase 5) y su
-- export a CSV consultan directo `eventos_negocio`, pero desde la
-- migración 20260828213422 (Etapa 2 de PLAN_ROBUSTEZ_ESCALABILIDAD,
-- decidida con el usuario el 2026-08-28) el cron diario de retención
-- archiva a `eventos_negocio_historico` todo evento de más de 180 días.
-- Resultado: sin este fix, cualquier evento archivado dejaba de
-- aparecer en el panel y en el CSV — contradice el criterio de éxito
-- explícito de la Fase 5 ("los eventos de negocio quedan indefinidamente
-- ... ante la pregunta 'por qué este pedido no se facturó', la
-- respuesta se encuentra en la auditoría sin revisar logs de servidor").
-- El dato nunca se perdió (se archiva, no se borra), pero quedaba
-- inalcanzable desde la UI pasados los 180 días.
--
-- Fix: vista `eventos_negocio_completo` = UNION ALL de la tabla viva
-- + la histórica, con `security_invoker = true` (Postgres 15+, este
-- proyecto corre en 17) para que la vista NO tenga privilegios propios
-- y las RLS policies de cada tabla base se apliquen tal cual al usuario
-- que consulta — mismo resultado de seguridad que consultar cualquiera
-- de las dos tablas directo, sin duplicar policies acá.
--
-- Nota de numeración: el zip de origen traía esta migración como 589,
-- pero ese número ya estaba tomado en producción por
-- "589_fix_fn_stock_lista_agrupada_left_join" (aplicada el 2026-09-04,
-- posterior al export). Renumerada a 590, mismo contenido. Ya aplicada
-- en producción (proyecto jgiquzjwoedmzwqgzubr) el 2026-09-04.
-- ============================================================

CREATE OR REPLACE VIEW public.eventos_negocio_completo
WITH (security_invoker = true) AS
  SELECT ev.id, ev.empresa_id, ev.tipo_evento, ev.payload, ev.origen, ev.estado,
         ev.creado_en, ev.procesado_en, emp.nombre AS empresa_nombre
    FROM public.eventos_negocio ev
    LEFT JOIN public.empresas emp ON emp.id = ev.empresa_id
  UNION ALL
  SELECT ev.id, ev.empresa_id, ev.tipo_evento, ev.payload, ev.origen, ev.estado,
         ev.creado_en, ev.procesado_en, emp.nombre AS empresa_nombre
    FROM public.eventos_negocio_historico ev
    LEFT JOIN public.empresas emp ON emp.id = ev.empresa_id;

COMMENT ON VIEW public.eventos_negocio_completo IS
  'Fase 5 (PLAN_ERP_SINCRONIZACION_2026.md): union de eventos_negocio (vivos) + '
  'eventos_negocio_historico (archivados por retención, migración 20260828213422). '
  'Fuente real del panel "Eventos de negocio" de auditoria.html, su export CSV, y '
  'del endpoint superadmin GET /api/saas?_svc=eventos-negocio, para que el historial '
  'de auditoría de negocio no pierda alcance a los 180 días. empresa_nombre viene '
  'resuelto acá (LEFT JOIN plano) porque PostgREST no puede embeder empresas(nombre) '
  'sobre una vista sin FK real. security_invoker=true: no otorga acceso propio, '
  'hereda RLS de las tablas base (eventos_negocio / eventos_negocio_historico).';
