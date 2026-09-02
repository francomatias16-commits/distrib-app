// frontend/admin/js/clientes/guardar-cliente.js
// Parte del split de frontend/admin/js/clientes.js (25/08/2026).
// Ver docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

import { estadoModulo } from './_estado.js';
import { cargarClientes } from './carga-listado.js';
import { cerrarModal } from './modal-cliente.js';
import { getFreshToken } from './nucleo.js';

export function resetForm() {
  ['f-razon_social','f-nombre_fantasia','f-cuit','f-telefono','f-email','f-domicilio','f-localidad','f-notas'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-condicion_iva').value  = 'consumidor_final';
  document.getElementById('f-zona_id').value        = '';
  document.getElementById('f-deposito_id').value     = '';
  document.getElementById('f-lista_precio_id').value = '';
  document.getElementById('f-dias_credito').value   = 0;
  document.getElementById('f-limite_credito').value = 0;
  document.getElementById('f-activo').value         = 'true';
  document.getElementById('f-lat').value            = '';
  document.getElementById('f-lng').value            = '';
  document.getElementById('f-vendedor_id_default').value = '';
  const scoreExactoElReset = document.getElementById('score-exacto-dato');
  if (scoreExactoElReset) scoreExactoElReset.innerHTML = '';
}

// ── Normaliza el CUIT al formato XX-XXXXXXXX-X que exige el constraint
// clientes_cuit_formato en DB (db/077_critical_rls_y_politicas.sql).
// Acepta que el usuario lo tipee con o sin guiones/espacios.
export function normalizarCuit(valor) {
  const digitos = (valor || '').replace(/\D/g, '');
  if (!digitos) return { ok: true, valor: null };
  if (digitos.length !== 11) return { ok: false, valor: null };
  return { ok: true, valor: `${digitos.slice(0,2)}-${digitos.slice(2,10)}-${digitos.slice(10)}` };
}

// ── Guardar ────────────────────────────────────────────────────────────────
export async function guardarCliente() {
  const razon = document.getElementById('f-razon_social').value.trim();
  if (!razon) { window.toast('La razón social es obligatoria'); return; }

  const cuitInput = document.getElementById('f-cuit').value.trim();
  const cuitNorm  = normalizarCuit(cuitInput);
  if (!cuitNorm.ok) {
    window.toast('El CUIT debe tener 11 dígitos (ej: 20-12345678-9)');
    return;
  }

  const payload = {
    razon_social:    razon,
    nombre_fantasia: document.getElementById('f-nombre_fantasia').value.trim() || null,
    cuit:            cuitNorm.valor,
    condicion_iva:   document.getElementById('f-condicion_iva').value,
    telefono:        document.getElementById('f-telefono').value.trim() || null,
    email:           document.getElementById('f-email').value.trim() || null,
    domicilio:       document.getElementById('f-domicilio').value.trim() || null,
    localidad:       document.getElementById('f-localidad').value.trim() || null,
    zona_id:         document.getElementById('f-zona_id').value || null,
    deposito_id:     document.getElementById('f-deposito_id').value || null,
    notas:           document.getElementById('f-notas').value.trim() || null,
    lista_precio_id: document.getElementById('f-lista_precio_id').value || null,
    dias_credito:    parseInt(document.getElementById('f-dias_credito').value) || 0,
    limite_credito:  parseFloat(document.getElementById('f-limite_credito').value) || 0,
    activo:          document.getElementById('f-activo').value === 'true',
    lat:             parseFloat(document.getElementById('f-lat').value) || null,
    lng:             parseFloat(document.getElementById('f-lng').value) || null,
    vendedor_id_default: document.getElementById('f-vendedor_id_default').value || null,
  };

  const esEdicion = !!estadoModulo.modalClienteId;
  const ok = await window.confirmar(
    esEdicion
      ? `¿Guardar los cambios de "${razon}"?`
      : `¿Confirmás crear el cliente "${razon}"?`,
    { labelOk: esEdicion ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  const btn = document.getElementById('btn-guardar');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  // FIX (auditoría UX etapa 17, Hallazgo 2): antes insertaba directo contra
  // Supabase (sb.from('clientes').insert()), lo que bypaseaba por completo
  // exigirLimitePlan() -- el enforcement del cupo de clientes del plan
  // contratado solo corre del lado del handler HTTP, nunca en un trigger de
  // base. Ahora pasa por POST/PATCH /api/clientes como el resto de las
  // pantallas de este mismo archivo (precios, direcciones).
  try {
    const token = await getFreshToken();
    let resp, data;
    if (estadoModulo.modalClienteId) {
      resp = await fetch('/api/clientes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: estadoModulo.modalClienteId, ...payload }),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw Object.assign(new Error(data.error || 'Error al actualizar'), { code: data.code });
      window.toast('Cliente actualizado');
    } else {
      resp = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw Object.assign(new Error(data.error || 'Error al crear'), { code: data.code });
      window.toast('Cliente creado');
    }
    cerrarModal();
    await cargarClientes();
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMITE_PLAN_ALCANZADO') {
      window.toast('Se alcanzó el límite de clientes de tu plan actual. Contactanos para ampliarlo.');
    } else {
      window.toast('No se pudo guardar el cliente');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar cambios';
  }
}
