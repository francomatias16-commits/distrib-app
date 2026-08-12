-- =============================================================================
-- 041_fix_categorias_activa.sql
-- Agrega columna activa a categorias
--
-- catalogo.js filtra .eq('activa', true) pero la columna no existe en schema.
-- Supabase ignora el filtro si la columna no existe → devuelve todas las
-- categorías incluyendo las que deberían estar ocultas. Solución: agregar
-- la columna con DEFAULT true para no romper registros existentes.
-- La columna orden ya existe en el schema → no se toca.
-- =============================================================================

ALTER TABLE public.categorias
    ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;

-- Índice para acelerar el filtro más común: empresa + activa
CREATE INDEX IF NOT EXISTS idx_categorias_empresa_activa
    ON public.categorias (empresa_id, activa);
