import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        server: 'server/cli.ts',
        'server-api': 'server/index.ts',
        pi: 'integrations/pi/index.ts',
        vite: 'src/vite.ts',
      },
      external: [
        /^node:/,
        /^effect(\/|$)/,
        /^foldkit(\/|$)/,
        /^@effect\//,
        /^@modelcontextprotocol\//,
        /^@babel\//,
        /^@jridgewell\//,
        /^magic-string$/,
        /^zod(\/|$)/,
        /^vite$/,
      ],
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
})
