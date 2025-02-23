import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config({ override: true });

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    alias: {
      'lodash': 'lodash',  // Use the full lodash package
      'lodash-es': 'lodash'  // Map lodash-es to full lodash
    }
  },
  optimizeDeps: {
    exclude: [
      '@neo4j-nvl/base',
      '@neo4j-nvl/react'
    ],
    include: [
      'cytoscape-cose-bilkent',
      'graphlib',
      'dagre',
      '@neo4j-bloom/dagre',
      'bin-pack',
      '@segment/facade',
      'lodash',
      'concaveman',
      'lodash.constant',
      'lodash.defaults',
      'lodash.has'
    ],
    esbuildOptions: {
      preserveSymlinks: true
    }
  },
  worker: {
    format: 'es'
  },
  build: {
    commonjsOptions: {
      include: [
        /cytoscape-cose-bilkent/,
        /graphlib/,
        /dagre/,
        /@neo4j-bloom\/dagre/,
        /bin-pack/,
        /@segment\/facade/,
        /lodash/,
        /concaveman/,
        /node_modules/
      ],
      transformMixedEsModules: true
    }
  },
  define: {
    'process.env': Object.keys(process.env).reduce((obj, key) => {
      obj[key] = process.env[key];
      return obj;
    }, {})
  }
}); 