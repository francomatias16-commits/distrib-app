// scripts/seed-demo-loadtest.js
import { createClient } from '@supabase/supabase-js';

const EMPRESA_ID = process.env.LOAD_TEST_DEMO_EMPRESA_ID || '4462586e-e11a-4d34-a405-17103bb9cf9f';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  console.log(`Empresa demo: ${EMPRESA_ID}\n`);

  let { data: depositos, error: errDep } = await db
    .from('depositos').select('id, nombre, es_principal').eq('empresa_id', EMPRESA_ID);
  if (errDep) throw errDep;
  console.log(`Depositos existentes: ${depositos.length}`);

  let deposito = depositos.find((d) => d.es_principal) || depositos[0];
  if (!deposito) {
    console.log('  -> Creando deposito demo...');
    const { data, error } = await db.from('depositos')
      .insert({ empresa_id: EMPRESA_ID, nombre: 'Deposito Demo', es_principal: true }).select().single();
    if (error) throw error;
    deposito = data;
    console.log(`  -> Creado: ${deposito.id}`);
  } else {
    console.log(`  -> Uso el existente: ${deposito.nombre} (${deposito.id})`);
  }

  const { data: productos, error: errProd } = await db
    .from('productos').select('id, nombre, activo, stock:stock(cantidad, deposito_id)')
    .eq('empresa_id', EMPRESA_ID).eq('activo', true);
  if (errProd) throw errProd;

  const conStock = (productos || []).filter((p) => (p.stock || []).some((s) => Number(s.cantidad) > 0));
  console.log(`\nProductos activos: ${(productos || []).length} (con stock > 0: ${conStock.length})`);

  if (conStock.length === 0) {
    console.log('  -> Creando producto demo con stock...');
    const { data: producto, error: errIns } = await db.from('productos')
      .insert({ empresa_id: EMPRESA_ID, nombre: 'Producto Demo Loadtest', codigo: 'LOADTEST-001', precio_base: 1000, activo: true })
      .select().single();
    if (errIns) throw errIns;
    const { error: errStock } = await db.from('stock')
      .insert({ producto_id: producto.id, deposito_id: deposito.id, cantidad: 1000 });
    if (errStock) throw errStock;
    console.log(`  -> Creado producto ${producto.id} con 1000 unidades`);
  }

  const { data: cajas, error: errCaja } = await db
    .from('cajas_pos').select('id, nombre, activa').eq('empresa_id', EMPRESA_ID).eq('activa', true);
  if (errCaja) throw errCaja;
  console.log(`\nCajas activas: ${cajas.length}`);

  if (cajas.length === 0) {
    console.log('  -> Creando caja demo...');
    const { data: caja, error: errIns } = await db.from('cajas_pos')
      .insert({ empresa_id: EMPRESA_ID, deposito_id: deposito.id, nombre: 'Caja Demo Loadtest', activa: true })
      .select().single();
    if (errIns) throw errIns;
    console.log(`  -> Creada: ${caja.id}`);
  }

  console.log('\nListo.');
}

main().catch((err) => { console.error('\nError:', err.message || err); process.exit(1); });
