import {createHandler} from '../../../server/handler';
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
const url=Deno.env.get('SUPABASE_URL'),serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!serviceKey)throw Error('Missing server configuration');
Deno.serve(createHandler({url,serviceKey,origins:['https://acofitness.github.io']}));
