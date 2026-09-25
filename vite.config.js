import { copyFile } from 'node:fs/promises';
import path from 'node:path';

export default {
  base: process.env.ACO_BASE_PATH || '/',
  build: { assetsInlineLimit: 2000000 },
  plugins: [{
    name: 'aco-panel-entry',
    async writeBundle(options) {
      const output = options.dir || 'dist';
      await copyFile(path.join(output, 'index.html'), path.join(output, 'panel.html'));
    }
  }]
};
