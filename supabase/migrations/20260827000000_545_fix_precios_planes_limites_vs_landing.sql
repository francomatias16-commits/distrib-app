-- 545: precios de planes_limites desactualizados vs. la landing pública
--
-- Reportado: la página "Suscripciones SaaS" (self-serve, saas-billing.html
-- → cargarPlanesTenant()) muestra precios distintos a los publicados en la
-- landing (frontend/landing, sección #precios):
--
--   Básico:     landing $30.000/mes  vs.  planes_limites.precio_mes = 25.000
--   Premium/pro: landing $55.000/mes  vs.  planes_limites.precio_mes = 55.000  (OK, sin cambios)
--   Platinum/enterprise: landing "Desde $95.000/mes" vs. planes_limites.precio_mes = NULL
--
-- El precio de Básico quedó en 25.000 desde la semilla original (migración
-- 137) y nunca se actualizó cuando el plan comercial subió a 30.000 en la
-- landing. El de Enterprise nunca tuvo valor: la landing lo agregó como
-- "desde $95.000" más adelante, pero nadie cargó ese precio de referencia acá.
-- El frontend (fmtPrecioPlan() en saas-billing.html) ya sabe mostrar el
-- prefijo "Desde " para el tier enterprise — el problema es solo el dato
-- NULL en la tabla, que hacía caer siempre en la rama "A medida".
--
-- No se toca 'trial' (precio_mes = 0, correcto — no se vende, es el período
-- de prueba) ni los límites de uso (max_usuarios/clientes/pedidos, ver 499).

UPDATE public.planes_limites
SET precio_mes = 30000, updated_at = now()
WHERE tier = 'basico';

UPDATE public.planes_limites
SET precio_mes = 95000, updated_at = now()
WHERE tier = 'enterprise';
