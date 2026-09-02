// tests/frontend/ui-utils-sanitize.test.js
//
// Cubre window.sanitize / window.s en frontend/admin/js/ui-utils.js.
//
// Hallazgo (auditoría de bugs, Etapa 4): la implementación anterior
// (`div.textContent = str; return div.innerHTML`) solo escapaba "&", "<",
// ">" — el escapado de nodo de TEXTO del HTML Living Standard no toca
// comillas. La función se usa en todo el admin para interpolar valores de
// usuario DENTRO de atributos HTML entre comillas dobles (ej.
// `data-nombre="${sanitize(nombre)}"`), así que un nombre de
// producto/depósito/cliente con una comilla doble literal rompía el
// atributo — XSS persistente. Este test fija el contrato correcto: además
// de "&"/"<"/">" ", también debe escapar comillas simples y dobles.
//
// El archivo real hace `document.addEventListener(...)` a nivel de módulo
// (dos veces), así que lo cargamos en un sandbox `vm` con un `document`
// mínimo — no hace falta un DOM real para probar `sanitize`, que ahora es
// puro string.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUTA = path.resolve(__dirname, '../../frontend/admin/js/ui-utils.js');

function cargarUiUtils() {
  const codigo = fs.readFileSync(RUTA, 'utf8');

  const documentFake = {
    addEventListener: vi.fn(),
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => ({ innerHTML: '', textContent: '', style: {} })),
  };
  const windowFake = { document: documentFake };
  windowFake.window = windowFake;

  const contexto = vm.createContext({
    window: windowFake,
    document: documentFake,
    console,
  });

  vm.runInContext(codigo, contexto, { filename: RUTA });

  return windowFake;
}

describe('ui-utils.js — window.sanitize (contexto atributo HTML)', () => {
  it('escapa comillas dobles (rompen atributos como data-x="...")', () => {
    const { sanitize } = cargarUiUtils();
    const resultado = sanitize('Producto" onmouseover="alert(1)');
    expect(resultado).not.toContain('"');
    expect(resultado).toBe('Producto&quot; onmouseover=&quot;alert(1)');
  });

  it('escapa comillas simples (rompen atributos como data-x=\'...\')', () => {
    const { sanitize } = cargarUiUtils();
    const resultado = sanitize("Producto' onmouseover='alert(1)");
    expect(resultado).not.toContain("'");
    expect(resultado).toBe('Producto&#39; onmouseover=&#39;alert(1)');
  });

  it('sigue escapando &, < y > (contexto de texto)', () => {
    const { sanitize } = cargarUiUtils();
    expect(sanitize('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(sanitize('Tuercas & Bulones S.A.')).toBe('Tuercas &amp; Bulones S.A.');
  });

  it('no doble-escapa el "&" que agregan las propias entidades', () => {
    const { sanitize } = cargarUiUtils();
    // Si escapara "&" DESPUÉS de agregar &quot;/&#39;, el resultado tendría
    // "&amp;quot;" en vez de "&quot;" — el orden de los .replace() importa.
    expect(sanitize('"')).toBe('&quot;');
    expect(sanitize("'")).toBe('&#39;');
  });

  it('null/undefined/number no rompen y dan el resultado esperado', () => {
    const { sanitize } = cargarUiUtils();
    expect(sanitize(null)).toBe('');
    expect(sanitize(undefined)).toBe('');
    expect(sanitize(42)).toBe('42');
  });

  it('window.s es alias de window.sanitize', () => {
    const w = cargarUiUtils();
    expect(w.s).toBe(w.sanitize);
  });
});
