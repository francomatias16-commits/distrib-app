// lib/asistente-tools.js
//
// Punto de entrada público del catálogo de tools del asistente — MISMA API
// que antes del split (25/08/2026). El contenido real (98 tools, agrupadas
// por dominio) vive en lib/asistente-tools/. Se mantiene este archivo con
// el mismo path para que los 9 imports existentes en el resto del código
// (lib/handlers/asistente.js, lib/permisos-service.js, etc.) no necesiten
// tocarse. Ver docs/tecnico/ARQUITECTURA_ACTUAL.md para el detalle del
// split y por qué se hizo así.

export {
  TOOLS,
  esquemaParaGemini,
  esquemaParaOpenAI,
  seleccionarToolsRelevantes,
  ejecutarTool,
  resolverAccionPendiente,
} from './asistente-tools/index.js';
