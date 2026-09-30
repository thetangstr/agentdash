import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const resolve=createRequire(new URL('../../server/package.json',import.meta.url)).resolve;
const source=(path:string)=>fileURLToPath(new URL(path,import.meta.url));
export default defineConfig({
  root:source('../..'),cacheDir:process.env.ROSS_AUTH_CACHE_DIR,
  esbuild:{tsconfigRaw:'{"compilerOptions":{"target":"ES2023"}}'},
  resolve:{alias:[
    {find:/^@agentdash\/mcp-server$/,replacement:source('../../packages/mcp-server/src/index.ts')},
    {find:/^@paperclipai\/db$/,replacement:source('../../packages/db/src/index.ts')},
    {find:/^@paperclipai\/shared$/,replacement:source('../../packages/shared/src/index.ts')},
    {find:/^express$/,replacement:resolve('express')},
    {find:/^drizzle-orm$/,replacement:resolve('drizzle-orm')},
    {find:/^@modelcontextprotocol\/sdk\/(.*)$/,replacement:join(dirname(resolve('@modelcontextprotocol/sdk/client/index.js')),'..','$1')},
  ]},
  test:{include:['scripts/ross/assistant-auth.e2e.ts'],environment:'node',maxWorkers:1,minWorkers:1,fileParallelism:false,testTimeout:60000,hookTimeout:180000},
});
