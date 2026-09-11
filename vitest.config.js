import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Fase 3.2 del plan: arrancamos por lo crítico, no cobertura total.
    // No usar variables de entorno reales ni tocar Supabase de producción.
  },
});
