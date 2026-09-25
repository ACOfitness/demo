import {build} from '../node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js';
await build({entryPoints:['supabase/functions/aco-api/entry.ts'],outfile:'supabase/functions/aco-api/index.ts',bundle:true,platform:'neutral',format:'esm',target:'es2022',minify:false,legalComments:'none'});
