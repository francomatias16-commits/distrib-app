-- CORRECCIÓN de análisis previo: cta_cte_empresa y cuenta_corriente NO son
-- tablas con datos duplicados/huérfanos — son VISTAS de solo lectura sobre
-- cta_cte (la fuente única de verdad), siempre en sincro automática.
-- Verificado: 0 referencias en código, sin triggers/vistas/funciones dependientes.
DROP VIEW public.cta_cte_empresa;
DROP VIEW public.cuenta_corriente;
