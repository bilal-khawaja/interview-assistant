import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            output: {
                codeSplitting: false,
            },
            external: ['pdf-parse', 'pdf-parse/node', 'pdfjs-dist', 'mammoth', 'xlsx'],
        },
    },
});
