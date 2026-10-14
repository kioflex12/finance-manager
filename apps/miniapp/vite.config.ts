import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Номер сборки: зашивается в код приложения и кладётся рядом в version.json — по нему сервер сообщает о новой версии. */
const BUILD_ID = Date.now().toString(36);

function versionFile(): Plugin {
  return {
    name: 'version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
