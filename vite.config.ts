import { cloudflareDevProxyVitePlugin as remixCloudflareDevProxy, vitePlugin as remixVitePlugin } from '@remix-run/dev';
import UnoCSS from 'unocss/vite';
import { defineConfig, type ViteDevServer, type Plugin } from 'vite';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';
import nodePolyfills from 'rollup-plugin-node-polyfills';

// Custom plugin to handle module definition
function modulePolyfillPlugin(): Plugin {
  const moduleCode = `
    var module = {
      exports: {}
    };
    var exports = module.exports;
  `;

  return {
    name: 'module-polyfill',
    transform(code, id) {
      if (id.includes('node_modules/path-browserify')) {
        return {
          code: moduleCode + code,
          map: null,
        };
      }
    },
  };
}

export default defineConfig((config) => {
  return {
    build: {
      target: 'esnext',
      rollupOptions: {
        plugins: [nodePolyfills()],
      },
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    plugins: [
      modulePolyfillPlugin(),
      config.mode !== 'test' && remixCloudflareDevProxy(),
      remixVitePlugin({
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
        },
      }),
      UnoCSS(),
      tsconfigPaths(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    envPrefix: ['VITE_', 'OPENAI_LIKE_API_', 'OLLAMA_API_BASE_URL'],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    define: {
      'process.env': {},
      global: 'globalThis',
    },
    resolve: {
      alias: {
        path: 'path-browserify',
        buffer: 'rollup-plugin-node-polyfills/polyfills/buffer-es6',
        util: 'rollup-plugin-node-polyfills/polyfills/util',
        sys: 'util',
        events: 'rollup-plugin-node-polyfills/polyfills/events',
        stream: 'rollup-plugin-node-polyfills/polyfills/stream',
        process: 'rollup-plugin-node-polyfills/polyfills/process-es6',
      },
    },
    optimizeDeps: {
      include: [
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        'react-resizable-panels',
        '@radix-ui/react-dialog',
        'date-fns',
        '@webcontainer/api',
        'istextorbinary',
        'buffer',
        'path-browserify',
      ],
      exclude: ['@remix-run/dev', 'unocss', 'vite-plugin-optimize-css-modules', 'vite-tsconfig-paths'],
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    server: {
      fs: {
        strict: false,
      },
      watch: {
        usePolling: true,
      },
      hmr: {
        timeout: 10000,
      },
    },
  };
});

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}
