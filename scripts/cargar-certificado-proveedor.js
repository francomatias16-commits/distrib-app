#!/usr/bin/env node
/**
 * scripts/cargar-certificado-proveedor.js
 *
 * Carga EL ÚNICO certificado del proveedor (Fluxo) en
 * arca_proveedor_config — no confundir con cargar-certificado-arca.js,
 * que es el flujo legacy por-empresa (modo_certificado='propio').
 *
 * Se corre UNA vez por ambiente (homologación y, más adelante,
 * producción), no por cliente. Después de esto, cualquier empresa con
 * modo_certificado='delegado' (el default para clientes nuevos) puede
 * facturar en cuanto complete la delegación ARCA a tu CUIT.
 *
 * Uso:
 *   node scripts/cargar-certificado-proveedor.js \
 *     --cuit 20348211421 \
 *     --key "C:\ruta\privada.key" \
 *     --cert "C:\ruta\certificado.crt" \
 *     --homologacion true
 *
 * Requiere las mismas env vars que cargar-certificado-arca.js:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'fs';
import { cifrar } from '../lib/crypto-secrets.js';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const { cuit, key: keyPath, cert: certPath } = args;
  const homologacion = args.homologacion !== 'false'; // default true

  if (!cuit || !keyPath || !certPath) {
    console.error(
      'Uso: node scripts/cargar-certificado-proveedor.js --cuit <CUIT> --key <privada.key> --cert <cert.crt> [--homologacion true]'
    );
    process.exit(1);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    process.exit(1);
  }
  if (!process.env.ARCA_SECRETS_KEY) {
    console.error('Falta ARCA_SECRETS_KEY en el entorno (obligatoria para cifrar el certificado).');
    process.exit(1);
  }

  if (!existsSync(keyPath)) { console.error(`No se encontró: ${keyPath}`); process.exit(1); }
  if (!existsSync(certPath)) { console.error(`No se encontró: ${certPath}`); process.exit(1); }

  const keyPem = readFileSync(keyPath, 'utf8').trim();
  const certPem = readFileSync(certPath, 'utf8').trim();

  if (!keyPem.includes('BEGIN') || !keyPem.includes('PRIVATE KEY')) {
    console.error('La clave privada no parece un PEM válido.');
    process.exit(1);
  }
  if (!certPem.includes('BEGIN CERTIFICATE')) {
    console.error('El certificado no parece un PEM válido.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { error } = await supabase
    .from('arca_proveedor_config')
    .upsert(
      {
        homologacion,
        cuit,
        cert_pem: cifrar(certPem),
        key_pem: cifrar(keyPem),
        activo: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'homologacion' }
    );

  if (error) {
    console.error('Error guardando arca_proveedor_config:', error.message);
    process.exit(1);
  }

  console.log('[OK] Certificado del proveedor cargado.');
  console.log(`  CUIT: ${cuit}`);
  console.log(`  Homologación: ${homologacion}`);
  console.log('  Certificado y clave guardados cifrados (AES-256-GCM, misma clave ARCA_SECRETS_KEY).');
  console.log('');
  console.log(`No te olvides de setear ARCA_PROVEEDOR_CUIT=${cuit} en las env vars de Vercel`);
  console.log('(la usa lib/arca/delegacion.js para mostrarle el CUIT al usuario en el wizard).');
}

main();
