import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('./',import.meta.url),args=process.argv.slice(2),value=name=>args.find(v=>v.startsWith(`${name}=`))?.slice(name.length+1);
function origin(raw){const url=new URL(raw);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('Use HTTPS or a localhost origin');if(url.username||url.password)throw new Error('Credentials are not allowed');return url.origin;}
let constants=await readFile(new URL('constants.js',root),'utf8');const api=origin(value('--api-origin')??/API_BASE:\s*"([^"]+)"/.exec(constants)[1]),site=origin(value('--site-origin')??api),sample=args.includes('--sample');
constants=constants.replace(/API_BASE:\s*"[^"]+"/,`API_BASE: ${JSON.stringify(api)}`).replace(/SITE_BASE:\s*"[^"]+"/,`SITE_BASE: ${JSON.stringify(site)}`).replace(/USE_MOCK:\s*(?:true|false)/,`USE_MOCK: ${sample}`);
const target=new URL('dist/',root);await mkdir(target,{recursive:true});const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));manifest.version='0.2.0';manifest.host_permissions=[`${api}/*`];
await writeFile(new URL('manifest.json',target),JSON.stringify(manifest,null,2)+'\n');await writeFile(new URL('constants.js',target),constants);for(const file of ['background.js','content.js','card.js','match.js','mock.js'])await copyFile(new URL(file,root),new URL(file,target));console.log(JSON.stringify({directory:fileURLToPath(target),sample,api,site}));
