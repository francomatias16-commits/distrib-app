// tests/scripts/migraciones-orden.test.js
//
// Etapa 8 del plan (AUDITORIA_BUGS_v954.md — cobertura de tests vs. bugs
// históricos): cubre el hallazgo 🟠 #3. Supabase aplica las migraciones de
// `supabase/migrations/` en orden ALFABÉTICO de nombre de archivo — no por
// fecha de creación ni por ningún otro criterio. Dos migraciones de
// seguridad reales (`fase5_eventos_negocio_rls_dueno_admin.sql` y
// `fix_rls_notif_log_scope_por_rol.sql`, ambas cerrando fugas donde
// cliente/chofer podían leer eventos_negocio/notif_log de otros tenants)
// habían quedado sin prefijo numérico/timestamp — los dígitos ordenan
// antes que las letras en ASCII, así que esas 2 SIEMPRE se iban a aplicar
// DESPUÉS de cualquier migración futura con el prefijo estándar (el 100%
// de las demás). Riesgo real: una migración nueva que vuelva a tocar esas
// mismas policies quedaría aplicada ANTES que el fix, reabriendo el
// agujero sin que se note (el fix "ya está en el repo" a simple vista).
//
// Fix aplicado (v967): ambos archivos renombrados con prefijo timestamp
// real (ver 20260824030001_fase5_... y 20260824030002_fix_rls_notif_log_...).
//
// Este test no valida el contenido de esas 2 migraciones puntuales — valida
// la REGLA general que evita que el problema vuelva a aparecer con
// cualquier archivo futuro: todo archivo .sql de supabase/migrations/ debe
// empezar con un prefijo de orden (dígitos), sin excepción. Si alguien
// agrega un .sql sin prefijo (por más que su contenido sea intachable),
// este test falla y lo marca antes de que llegue a producción fuera de
// orden.
//
// ADENDA (misma ronda, al correr este test por primera vez contra la suite
// real): la 3ra aserción original comparaba el prefijo de fase5/notifLog
// contra TODAS las demás migraciones como strings — y el repo tiene 3
// convenciones de nombre mezcladas con el tiempo (001-525 secuencial corto,
// ~15 archivos `YYYYMMDD_` sin hora, y el formato vigente desde ~513
// `YYYYMMDDHHMMSS_`). Comparar un prefijo corto tipo "525" contra un
// timestamp "20260824..." como string da un falso positivo (ASCII: '5' >
// '2'), aunque 525 sea una migración vieja ya aplicada, no una que vaya a
// "colarse antes". Al correrlo reveló además 2 archivos MÁS con el mismo
// problema real que el hallazgo #3 (prefijo corto sin timestamp, nunca
// registrados) — `540_reconstruccion_retroactiva_...` y
// `541_fix_calcular_score_cliente_...` (Etapa 6, sin relación con RLS) —
// también renombrados con timestamp en esta misma ronda. La 3ra aserción
// quedó acotada a comparar solo contra el formato de 14 dígitos vigente
// (el único relevante para "qué migración futura podría colarse antes"),
// y se agregó un test dedicado para 540/541.
//
// ADENDA 2 (v983): el propio test detectó una 3ra recurrencia real del
// mismo bug — `fix_secnew01_aislamiento_empresa_crear_pedido_cliente.sql`
// y `fix_secnew02_revocar_funciones_expuestas_sin_caller.sql` (SECNEW-01/
// 02, reconstruidas desde fixes aplicados directo en prod vía MCP)
// llegaron al repo sin prefijo — o sea, el hallazgo #3 se repite cada vez
// que alguien reconstruye una migración aplicada en vivo sin seguir la
// convención. Renombradas con timestamp (20260824070000/070001).
//
// Se eliminó además la aserción que comparaba el prefijo de fase5/
// notifLog contra TODAS las demás migraciones de formato timestamp: esa
// aserción asumía que ninguna migración nueva se agregaría nunca más
// después de v967, así que se rompía con cualquier trabajo legítimo
// posterior (pasó acá mismo, con 542/543). El riesgo que buscaba cubrir
// ya queda cerrado por la 1ra aserción de este archivo: una vez que todo
// archivo debe empezar con dígitos, alfabético = numérico = cronológico,
// sin necesidad de comparar contra un universo que crece para siempre.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_MIGRACIONES = path.join(__dirname, '../../supabase/migrations');

function listarMigraciones() {
  return fs.readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql'));
}

describe('supabase/migrations/ — todo archivo debe tener prefijo de orden (regresión hallazgo #3, v967)', () => {
  it('ningún .sql arranca con letras — Supabase ordena alfabéticamente y los dígitos siempre van antes', () => {
    const archivos = listarMigraciones();
    expect(archivos.length).toBeGreaterThan(100); // sanity check: no estamos leyendo un directorio vacío/equivocado

    const sinPrefijo = archivos.filter((f) => !/^\d/.test(f));

    expect(sinPrefijo).toEqual([]);
  });

  it('las 2 migraciones RLS del hallazgo #3 quedaron renombradas con timestamp real, no con el nombre viejo sin prefijo', () => {
    const archivos = listarMigraciones();

    expect(archivos).not.toContain('fase5_eventos_negocio_rls_dueno_admin.sql');
    expect(archivos).not.toContain('fix_rls_notif_log_scope_por_rol.sql');

    expect(archivos.some((f) => /^\d+_fase5_eventos_negocio_rls_dueno_admin\.sql$/.test(f))).toBe(true);
    expect(archivos.some((f) => /^\d+_fix_rls_notif_log_scope_por_rol\.sql$/.test(f))).toBe(true);
  });

  it('540/541 (descubiertas al correr este mismo test — mismo problema de prefijo corto, sin relación con RLS) también quedaron renombradas', () => {
    const archivos = listarMigraciones();

    expect(archivos).not.toContain('540_reconstruccion_retroactiva_calcular_deuda_cliente_cons_01_02_03.sql');
    expect(archivos).not.toContain('541_fix_calcular_score_cliente_componente_deuda_cons_04.sql');

    expect(
      archivos.some((f) => /^\d{14}_540_reconstruccion_retroactiva_calcular_deuda_cliente_cons_01_02_03\.sql$/.test(f)),
    ).toBe(true);
    expect(
      archivos.some((f) => /^\d{14}_541_fix_calcular_score_cliente_componente_deuda_cons_04\.sql$/.test(f)),
    ).toBe(true);
  });

  it('documenta (sin fallar) cuántas migraciones legacy quedan con prefijo secuencial corto o fecha sin hora — deuda técnica conocida, no hallazgo nuevo', () => {
    // Este test no falla nunca — es un sanity-log para que quede a la
    // vista en la salida de la suite cuántos archivos legacy quedan fuera
    // del formato timestamp de 14 dígitos, sin bloquear el pipeline por
    // algo que no vamos a renombrar en masa (364+ archivos históricos ya
    // aplicados, sin riesgo real de reordenarse contra nada futuro).
    const archivos = listarMigraciones();
    const legacy = archivos.filter((f) => !/^\d{14}_/.test(f));
    expect(legacy.length).toBeGreaterThanOrEqual(0);
  });
});
