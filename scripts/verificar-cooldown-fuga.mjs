// scripts/verificar-cooldown-fuga.mjs
//
// Pase manual del fix v1062 (cooldown de cliente_en_riesgo_fuga).
// SOLO LECTURA: no emite eventos, no crea tareas, no manda WhatsApp — es
// exactamente la misma lógica que corre `handleFugaCron` en el paso de
// decidir "emitir o saltear", pero sin la parte que emite. Seguro de
// correr contra datos reales o demo.
//
// Necesario porque el cron real excluye el tenant demo
// (`listarEmpresasActivas({ excluirDemo: true })` en lib/handlers/notif.js
// filtra `es_demo = false`), así que "Distribuidora del Litoral" nunca
// pasa por handleFugaCron en producción. Este script simula ese mismo
// chequeo apuntando directo al tenant que le pases.
//
// Uso:
//   node --env-file=.env.local scripts/verificar-cooldown-fuga.mjs "Distribuidora del Litoral"
//   node --env-file=.env.local scripts/verificar-cooldown-fuga.mjs <empresa_id-uuid>
//
// Requiere las mismas env vars que ya usa el proyecto (.env.local):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import { clientesEnFugaRpc, ultimoAvisoFuga } from '../lib/repos/clientes-fuga.js';

const DIAS_COOLDOWN_FUGA = 15;

async function resolverEmpresaId(db, argumento) {
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(argumento);
  if (esUuid) return argumento;

  const { data, error } = await db
    .from('empresas')
    .select('id, nombre')
    .ilike('nombre', `%${argumento}%`)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`No encontré una empresa que matchee "${argumento}": ${error?.message || 'sin resultados'}`);
  }
  console.log(`Empresa resuelta: ${data.nombre} (${data.id})\n`);
  return data.id;
}

async function main() {
  const argumento = process.argv[2];
  if (!argumento) {
    console.error('Uso: node scripts/verificar-cooldown-fuga.mjs "<nombre o empresa_id>"');
    process.exit(1);
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const empresaId = await resolverEmpresaId(db, argumento);

  const { data, error } = await clientesEnFugaRpc(empresaId, 100);
  if (error) throw new Error(`fn_clientes_en_fuga: ${error.message}`);

  const clientes = data?.clientes || [];
  console.log(`Total en fuga: ${data?.total_clientes_en_fuga ?? 0}`);
  console.log(`Valor anual total en riesgo: $${Math.round(data?.valor_anual_total_en_riesgo ?? 0).toLocaleString('es-AR')}\n`);

  if (!clientes.length) {
    console.log('No hay clientes en fuga para esta empresa ahora mismo.');
    return;
  }

  for (const c of clientes) {
    const ultimoAviso = await ultimoAvisoFuga(c.cliente_id);
    let estado = 'EMITIRÍA evento (sin aviso previo)';
    if (ultimoAviso) {
      const haceHoras = (Date.now() - new Date(ultimoAviso)) / 1000 / 3600;
      const diasDesde = (haceHoras / 24).toFixed(1);
      estado = haceHoras < DIAS_COOLDOWN_FUGA * 24
        ? `OMITIRÍA (último aviso hace ${diasDesde} días, cooldown ${DIAS_COOLDOWN_FUGA}d)`
        : `EMITIRÍA evento (último aviso hace ${diasDesde} días, ya pasó el cooldown)`;
    }

    console.log(
      `- ${c.razon_social.padEnd(35)} $${String(Math.round(c.valor_anual_estimado)).padStart(9)}/año  ` +
      `${c.dias_atraso}d atraso  [${c.motivo_probable}]  →  ${estado}`
    );
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
