// lib/repos/catalogo-visitas.js
// Capa de acceso a datos para el tracking de origen del catálogo público
// (migración 605). La escritura (una fila por visita) la hace directo el
// frontend público vía el RPC SECURITY DEFINER `registrar_visita_catalogo`
// (ver frontend/cliente/catalogo.html) — este repo solo cubre la lectura
// agregada que usa el panel admin.

import { db } from './_db.js';

/**
 * Resumen de visitas al catálogo público por canal de origen, para los
 * últimos `dias` días (acotado 1–365 también del lado SQL, el handler ya
 * lo acota antes de llegar acá). Agregación hecha en el server
 * (RPC resumen_visitas_catalogo) en vez de traer las filas crudas a Node.
 */
export async function obtenerResumenVisitasCatalogo(empresa_id, dias = 30) {
  const { data, error } = await db.rpc('resumen_visitas_catalogo', {
    p_empresa_id: empresa_id,
    p_dias: dias,
  });

  if (error) {
    throw new Error(`[CatalogoVisitasRepo.obtenerResumenVisitasCatalogo] ${error.message}`);
  }

  return data || [];
}
