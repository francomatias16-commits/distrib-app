// lib/asistente-tools/_respuestas.js
//
// Fase 3 del plan de robustez conversacional (formato único de error para
// las tools del asistente + botones tappable — ver
// PLAN_MAESTRO_ROBUSTEZ_CONVERSACIONAL_ASISTENTE_2026.md).
//
// Antes cada tool tiraba su propio `throw new Error(texto)` con el estilo
// que le pareció a quien la escribió ese día. Acá se centralizan las 3
// formas reales que toma un error de tool en este asistente — no todo
// error es "faltó un dato" ni todo error es "elegí entre estas opciones":
//
//   1. faltaDato(campo, ejemplo)      — el usuario nunca dio ese dato.
//   2. ambiguo({...})                 — hay varios candidatos y ninguno
//                                        se destaca con claridad (ver
//                                        elegirMejorCandidato en
//                                        _helpers.js). Es el único tipo
//                                        que cuelga `opciones` en el
//                                        Error, para que el frontend
//                                        pinte botones (ver chat-widget.js
//                                        y extraerOpcionesAmbiguas en
//                                        lib/handlers/asistente.js).
//   3. bloqueado(motivo, salida)      — la acción es válida pero no se
//                                        puede ejecutar ahora (stock
//                                        insuficiente, crédito excedido,
//                                        factura ya anulada, etc.):
//                                        explica la causa Y da la salida.
//
// `armarErrorDesambiguacion` en _helpers.js es un alias directo de
// `ambiguo` (se mantiene el nombre viejo para no tocar los ~13 call sites
// que ya lo usaban). `faltaDato`/`bloqueado` se re-exportan tal cual desde
// _helpers.js para que los 16 archivos de tools por dominio puedan
// empezar a usarlos sin agregar un segundo import.
//
// Migración del resto de las tools: no hace falta migrar los ~90
// `throw new Error(...)` sueltos el mismo día — el contrato queda escrito
// acá una sola vez, y cada tool que se toque de acá en más se migra al
// pasar (ver Fase 3, orden de implementación, en el plan maestro).

// ---------------------------------------------------------------------
// Tipo 1: falta un dato — el usuario nunca lo dio.
// ---------------------------------------------------------------------
export function faltaDato(campo, ejemplo) {
  const base = `Me falta ${campo} para seguir.`;
  return new Error(ejemplo ? `${base} Por ejemplo: "${ejemplo}".` : base);
}

// ---------------------------------------------------------------------
// Tipo 2: ambiguo — varios candidatos, ninguno claro.
//
// Firma real usada en los ~15 call sites de _helpers.js:
//   ambiguo({ tipo, texto, candidatos, campoNombre = 'nombre', sugerenciaExtra })
//
// - tipo: qué se estaba buscando ('cliente', 'producto', 'depósito', ...),
//   se usa tal cual en el texto ("Hay más de un <tipo> parecido a...").
// - texto: lo que dijo/dictó el usuario.
// - candidatos: filas devueltas por el RPC de búsqueda aproximada; cada
//   una debe tener `id` y el campo indicado en `campoNombre`.
// - campoNombre: qué campo de cada candidato mostrar como label
//   ('nombre', 'razon_social', 'nombre_mostrado', 'numero', etc.)
// - sugerenciaExtra: línea opcional al final ("También podés darle el
//   CUIT.", "Pedile el número exacto.") — no todos los call sites la usan.
// ---------------------------------------------------------------------
export function ambiguo({ tipo, texto, candidatos, campoNombre = 'nombre', sugerenciaExtra }) {
  const opciones = (candidatos || []).slice(0, 5).map((c) => ({ id: c.id, label: c[campoNombre] }));
  const lista = opciones.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
  const cierre = [
    'Mostrale esta lista tal cual, no la reformules.',
    sugerenciaExtra || null,
  ].filter(Boolean).join(' ');

  const err = new Error(
    `Hay más de un ${tipo} parecido a "${texto}":\n${lista}\n${cierre}`
  );
  // El handler (extraerOpcionesAmbiguas en lib/handlers/asistente.js) y
  // los adaptadores de proveedor (lib/asistente-providers.js) leen esto
  // para mandarle al frontend los botones tappable — cero margen para que
  // el usuario transcriba mal lo que ya eligió (ver chat-widget.js).
  err.opciones = opciones;
  return err;
}

// ---------------------------------------------------------------------
// Tipo 3: la acción es válida pero no se puede ejecutar ahora — a
// diferencia de los otros dos, EXPLICA la causa Y da la salida.
// ---------------------------------------------------------------------
export function bloqueado(motivo, salida) {
  return new Error(salida ? `${motivo} ${salida}` : motivo);
}
