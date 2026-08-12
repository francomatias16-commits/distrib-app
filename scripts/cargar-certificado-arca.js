#!/usr/bin/env node
/**
 * scripts/cargar-certificado-arca.js
 *
 * Lee privada.key y el .crt descargado de ARCA, y los carga en
 * facturacion_config para la empresa indicada por CUIT. Evita tener
 * que pegar el cert/key a mano en el SQL Editor de Supabase.
 *
 * Uso (PowerShell o Git Bash, parado en la raíz del proyecto):
 *
 *   node scripts/cargar-certificado-arca.js \
 *     --cuit 20348211421 \
 *     --key "C:\Users\benil\certificado-arca\privada.key" \
 *     --cert "C:\Users\benil\certificado-arca\distrib-wsfe-test_6764268f7b49dbf7.crt" \
 *     --punto-venta 1 \
 *     --homologacion true
 *
 * Requiere las variables de entorno (las mismas que usa el resto del
 * proyecto, ej. scripts/check-schema.js):
 *
 *   SUPABASE_URL=https://jgiquzjwoedmzwqgzubr.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=...   (la "service_role", NUNCA la anon key)
 *
 * En PowerShell, antes de correr el script:
 *   $env:SUPABASE_URL = "https://jgiquzjwoedmzwqgzubr.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "ey..."
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'fs';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();

  const cuit = args.cuit;
  const keyPath = args.key;
  const certPath = args.cert;
  const puntoVenta = args['punto-venta'] ? parseInt(args['punto-venta'], 10) : 1;
  const homologacion = args.homologacion !== 'false'; // default true

  if (!cuit || !keyPath || !certPath) {
    console.error('Faltan argumentos. Uso:');
    console.error(
      '  node scripts/cargar-certificado-arca.js --cuit <CUIT> --key <ruta privada.key> --cert <ruta .crt> [--punto-venta 1] [--homologacion true]'
    );
    process.exit(1);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    console.error('Ejemplo en PowerShell:');
    console.error('  $env:SUPABASE_URL = "https://tuproyecto.supabase.co"');
    console.error('  $env:SUPABASE_SERVICE_ROLE_KEY = "ey..."');
    process.exit(1);
  }

  if (!existsSync(keyPath)) {
    console.error(`No se encontró el archivo de clave privada: ${keyPath}`);
    process.exit(1);
  }
  if (!existsSync(certPath)) {
    console.error(`No se encontró el archivo de certificado: ${certPath}`);
    process.exit(1);
  }

  const keyPem = readFileSync(keyPath, 'utf8').trim();
  const certPem = readFileSync(certPath, 'utf8').trim();

  if (!keyPem.includes('BEGIN') || !keyPem.includes('PRIVATE KEY')) {
    console.error('El archivo de clave privada no parece un PEM válido.');
    process.exit(1);
  }
  if (!certPem.includes('BEGIN CERTIFICATE')) {
    console.error('El archivo de certificado no parece un PEM válido.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Buscar la empresa por CUIT, así no hay que copiar UUIDs a mano.
  const { data: empresa, error: errEmpresa } = await supabase
    .from('empresas')
    .select('id, nombre, cuit')
    .eq('cuit', cuit)
    .maybeSingle();

  if (errEmpresa) {
    console.error('Error buscando la empresa:', errEmpresa.message);
    process.exit(1);
  }
  if (!empresa) {
    console.error(`No se encontró ninguna empresa con CUIT ${cuit} en la tabla empresas.`);
    console.error('Verificá el CUIT, o creá/actualizá la empresa antes de correr este script.');
    process.exit(1);
  }

  console.log(`Empresa encontrada: ${empresa.nombre} (id: ${empresa.id})`);

  const { error: errUpsert } = await supabase
    .from('facturacion_config')
    .upsert(
      {
        empresa_id: empresa.id,
        cuit,
        punto_venta: puntoVenta,
        cert_pem: certPem,
        key_pem: keyPem,
        homologacion,
        activo: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'empresa_id' }
    );

  if (errUpsert) {
    console.error('Error guardando facturacion_config:', errUpsert.message);
    process.exit(1);
  }

  console.log('[OK] Certificado y clave privada cargados correctamente en facturacion_config.');
  console.log(`  CUIT: ${cuit}`);
  console.log(`  Punto de venta: ${puntoVenta}`);
  console.log(`  Homologación: ${homologacion}`);
}

main();
