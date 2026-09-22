import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/langchain': 'src/adapters/langchain.ts',
    'adapters/vercel-ai': 'src/adapters/vercel-ai.ts',
    'adapters/mcp': 'src/adapters/mcp.ts',
    'adapters/openai': 'src/adapters/openai.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  splitting: false,
  treeshake: true,
});
