// lib/handlers/clientes-fuga.js
// Fase 3 de PLAN_CLIENTES_EN_FUGA.md: expone fn_clientes_en_fuga (Fase 1)
// enriquecida con qué acción ya se disparó para cada cliente (Fase 2) a
// la pantalla nueva. fn_clientes_en_fuga es SECURITY DEFINER con EXECUTE
// revocado para authenticated/anon (mismo criterio que
// v_cobranza_priorizada, ver comentario en riesgo-cheques.js) — por eso
// esto va por un endpoint backend con service_role, no por RPC directo
// desde el cliente Supabase del frontend.

import { verificarToken } from '../auth-helpers.js';
import { aplicarHeaders } from '../security-headers.js';
import { rateLimit } from '../rate-limit.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import { db } from '../repos/_db.js';
import { listarClientesEnFuga } from '../repos/clientes-fuga.js';

const rateLimitApi = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  aplicarHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (await rateLimitApi(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil) return res.status(401).json({ error: 'No autorizado' });

  if (!puede(perfil, 'leer', 'clientes_fuga')) {
    return res.status(403).json({ error: 'Sin permiso para ver clientes en fuga' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  try {
    // "Solo lo mío": el vendedor puede pedirlo explícitamente (checkbox en
    // la pantalla); dueño/admin no tienen vendedor_id_default propio, así
    // que el filtro no aplica aunque lo manden — ven siempre la empresa
    // completa. Mismo criterio de scope que prospectos-competencia.js.
    const soloMio = req.query?.solo_mio === '1' && perfil.rol === 'vendedor';

    const resultado = await listarClientesEnFuga(perfil.empresa_id, {
      soloVendedorId: soloMio ? perfil.id : null,
    });

    return res.json(resultado);
  } catch (err) {
    return errorSeguro(res, err, 500, 'No se pudo cargar la lista de clientes en fuga.');
  }
}
