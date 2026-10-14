import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountPool, claims } from '../pool.mjs';
import { createAdapter, parseAiSdkStream } from '../server.mjs';

const jwt = (sid, suffix='initial', exp=Math.floor(Date.now()/1000)+120) => `${Buffer.from('{"alg":"test"}').toString('base64url')}.${Buffer.from(JSON.stringify({sid,exp})).toString('base64url')}.${suffix}`;
const listen = async server => {server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const close = server => new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
async function harness(t,extra={}) {
  const folder=mkdtempSync(join(tmpdir(),'logicc-test-'));
  const hits=[], tokenCalls=[];
  const mock=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const sid=claims((req.headers.authorization||'').slice(7)).sid;
    const body=text?JSON.parse(text):{};
    hits.push({url:req.url,body,sid});
    const respond=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url.includes('/tokens')){
      tokenCalls.push(req.headers.cookie);
      const session=req.url.split('/')[4];
      if(session==='sess_bad')return respond(401,{error:'invalid'});
      res.setHeader('Set-Cookie','__client=rotated_cookie; HttpOnly; Path=/');
      return respond(200,{jwt:jwt(session,'refreshed')});
    }
    if(req.url.startsWith('/api/models')){
      if(sid==='sess_old' && !req.headers.authorization.endsWith('refreshed'))return respond(401,{error:'revoked'});
      if(sid==='sess_limited')return respond(429,{error:'limited'});
      return respond(200,[{id:'test-fast',name:'Test Fast',provider:'test',isDefault:true},{id:'test-slow',provider:'test'}]);
    }
    if(req.url==='/api/chats')return respond(200,'a-mock-chat-id');
    if(req.url.startsWith('/api/chats/')){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      if(body.prompt==='ERROR'){res.end('data: {"type":"error","errorText":"mock failure"}\n\n');return;}
      res.write('data: {"type":"text-delta","delta":"你好"}\r\n\r\n');
      if(body.prompt==='TRUNCATED'){res.end();return;}
      if(body.forcedTool)res.write(`data: ${JSON.stringify({type:'tool-input-start',toolName:body.forcedTool})}\n\n`);
      res.end('data: {"type":"text-delta","delta":"，测试通过。"}\r\n\r\ndata: {"type":"finish","usage":{"inputTokens":5,"outputTokens":8}}\r\n\r\ndata: [DONE]\r\n\r\n');
      return;
    }
    respond(404,{});
  });
  const upstream=await listen(mock);
  const file=join(folder,'state.json');
  const {server,pool}=createAdapter({dataFile:file,env:{LOGICC_ADMIN_PASSWORD:'test-admin-password',LOGICC_API_BASE:`${upstream}/api`,LOGICC_CLERK_BASE:upstream,...extra}});
  const base=await listen(server);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'X-Logicc-Admin':'1','Content-Type':'application/json'},body:JSON.stringify({password:extra.LOGICC_ADMIN_PASSWORD || 'test-admin-password'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  t.after(async()=>{await close(server);await close(mock);rmSync(folder,{recursive:true,force:true});});
  const api=async(path,method='GET',body,headers={})=>{
    const response=await fetch(base+path,{method,headers:{Cookie:cookie,'X-Logicc-Admin':'1',...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const add=async(name,sid,extra={})=>(await api('/api/accounts','POST',{name,token:jwt(sid),...extra})).data.account;
  return {base,api,pool,file,hits,tokenCalls,add};
}

test('account CRUD, atomic import, credential masking, persistence, validation',async t=>{
  const {api,add,file}=await harness(t);
  const a=await add('工作账户','sess_one',{clientCookie:'secret_cookie'});
  assert.ok(a.id);assert.equal(a.hasClientCookie,true);assert.equal(a.token,undefined);
  assert.equal((await api(`/api/accounts/${a.id}`,'PATCH',{name:'新名称',clientCookie:'',enabled:false})).data.account.enabled,false);
  assert.equal(JSON.parse(readFileSync(file)).accounts[0].clientCookie,'secret_cookie');
  await api(`/api/accounts/${a.id}`,'PATCH',{clientCookie:'replacement_cookie',sessionId:'sess_replaced'});
  assert.equal(JSON.parse(readFileSync(file)).accounts[0].token,'');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777,0o600);
  const imported=await api('/api/accounts/import','POST',[{name:'第二个',token:jwt('sess_two')},{name:'重复项',token:jwt('sess_replaced')}]);
  assert.equal(imported.status,409);assert.equal((await api('/api/state')).data.accounts.length,1);
  assert.equal((await api('/api/accounts/import','POST',[{name:'第二个',token:jwt('sess_two')}])).status,201);
  const state=(await api('/api/state')).data;
  assert.equal(state.accounts.length,2);assert.ok(!JSON.stringify(state).includes('secret_cookie'));assert.ok(!JSON.stringify(state).includes(jwt('sess_one')));
  assert.equal((await api('/api/accounts','POST',{name:'Bad',token:'a.b.c'})).status,400);
  assert.equal((await api('/api/accounts','POST',{name:'Bad',token:`a.${Buffer.from('null').toString('base64url')}.c`})).status,400);
  assert.equal((await api('/api/accounts','POST',{name:'Bad',clientCookie:'x',sessionId:'../etc'})).status,400);
  assert.equal((await api(`/api/accounts/${a.id}`,'DELETE')).status,200);
  const reloaded=new AccountPool(file,{});assert.equal(reloaded.data.accounts.length,1);
});

test('round-robin uses enabled accounts and 429 cools only the affected account',async t=>{
  const {api,add,hits}=await harness(t);
  await add('第一','sess_first');const second=await add('第二','sess_second');
  await api('/v1/models');await api('/v1/models');await api('/v1/models');
  assert.deepEqual(hits.filter(h=>h.url.startsWith('/api/models')).map(h=>h.sid),['sess_first','sess_second','sess_first']);
  await api(`/api/accounts/${second.id}`,'PATCH',{enabled:false});
  await api('/v1/models');assert.equal(hits.at(-1).sid,'sess_first');
  const limited=await add('限流','sess_limited');
  assert.equal((await api(`/api/accounts/${limited.id}/check`,'POST',{})).status,429);
  assert.equal((await api('/api/state')).data.accounts.find(a=>a.id===limited.id).status,'cooling');
  for(let i=0;i<3;i++)assert.equal((await api('/v1/models')).status,200);
  assert.equal(hits.at(-1).sid,'sess_first');
});

test('401 forces a different JWT, persists rotated cookie and joins concurrent refreshes',async t=>{
  const {api,add,pool,file,tokenCalls}=await harness(t);
  const a=await add('过期认证','sess_old',{clientCookie:'original_cookie'});
  assert.equal((await api('/v1/models')).status,200);
  assert.equal(tokenCalls.length,1);
  const persisted=JSON.parse(readFileSync(file)).accounts[0];
  assert.equal(persisted.clientCookie,'rotated_cookie');assert.ok(persisted.token.endsWith('refreshed'));
  const account=pool.account(a.id);account.token=jwt('sess_old','expired',1);
  await Promise.all([pool.tokenFor(account),pool.tokenFor(account),pool.tokenFor(account)]);
  assert.equal(tokenCalls.length,2);
  assert.equal(tokenCalls.at(-1),'__client=rotated_cookie');
});

test('OpenAI JSON + SSE, UTF-8/CRLF, tools, usage and actual request statistics',async t=>{
  const {api,add,base,hits}=await harness(t);await add('测试','sess_chat');
  const completion=await api('/v1/chat/completions','POST',{messages:[{role:'user',content:'你好'}]});
  assert.equal(completion.status,200);assert.equal(completion.data.choices[0].message.content,'你好，测试通过。');
  assert.equal(completion.data.usage.total_tokens,13);
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',body:JSON.stringify({model:'test-fast',stream:true,stream_options:{include_usage:true},messages:[{role:'user',content:'工具测试'}],tools:[{type:'function',function:{name:'web_search'}}]})});
  assert.equal(response.status,200);const text=await response.text();assert.ok(text.endsWith('data: [DONE]\n\n'));
  const frames=text.split('\n\n').filter(f=>f.startsWith('data: {')).map(f=>JSON.parse(f.slice(6)));
  assert.equal(frames[0].choices[0].delta.role,'assistant');assert.ok(frames.some(f=>f.choices[0]?.delta.content?.includes('[tool:web-search]')));
  assert.equal(frames.at(-1).usage.total_tokens,13);assert.equal(hits.at(-1).body.forcedTool,'web-search');
  const state=(await api('/api/state')).data;assert.equal(state.stats.requests,2);assert.equal(state.stats.successRate,100);assert.equal(state.modelStats[0].requests,2);assert.ok(state.stats.avgTtft>=0);
});

test('upstream stream errors and truncation are failures, including after response headers',async t=>{
  const {api,add,base,pool}=await harness(t);const account=await add('错误测试','sess_error');
  const bad=await api('/v1/chat/completions','POST',{model:'test-fast',messages:[{role:'user',content:'ERROR'}]});
  assert.equal(bad.status,502);assert.match(bad.data.error.message,/mock failure/);
  pool.runtimeFor(account.id).cooldownUntil=0;
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',body:JSON.stringify({model:'test-fast',stream:true,messages:[{role:'user',content:'TRUNCATED'}]})});
  const text=await response.text();assert.ok(text.includes('"error"'));assert.ok(text.includes('[DONE]'));
  const state=(await api('/api/state')).data;assert.equal(state.stats.requests,2);assert.equal(state.stats.failures,2);assert.equal(state.stats.successRate,0);
});

test('local-origin boundary, API key, malformed JSON, oversized body, and empty pool',async t=>{
  const {api,base}=await harness(t,{LOGICC_API_KEY:'only-test-key'});
  assert.equal((await api('/v1/models')).status,401);
  assert.equal((await api('/v1/models','GET',undefined,{Authorization:'Bearer only-test-key'})).status,503);
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await api('/api/state','GET',undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await api('/api/state','GET',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await api('/api/accounts','POST',{})).status,400);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'X-Logicc-Admin':'1','Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'X-Logicc-Admin':'1','Content-Type':'application/json'},body:'x'.repeat(1048577)})).status,413);
  assert.equal((await api('/api/accounts','POST',null)).status,400);
  assert.equal((await fetch(base+'/__set_token',{method:'POST',headers:{Origin:'https://evil.example'},body:jwt('sess_test')})).status,403);
  const bridge=await fetch(base+'/__set_token',{method:'POST',headers:{Origin:'https://app.logicc.com','X-Logicc-Password':'test-admin-password'},body:jwt('sess_bridge')});
  assert.equal(bridge.status,200);assert.equal(bridge.headers.get('Access-Control-Allow-Origin'),'https://app.logicc.com');
});

test('admin login, logout, remote Host, protected bridge and persisted custom API keys',async t=>{
  const {api,base,add,file}=await harness(t,{LOGICC_API_KEY:'environment-key'});
  const headers={'X-Logicc-Admin':'1','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/state',{headers})).status,401);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:'wrong'})})).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({password:'test-admin-password'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const session=cookie.split(';')[0];
  const remoteStatus=await new Promise((resolve,reject)=>{
    const req=request(base+'/api/state',{headers:{...headers,Cookie:session,Host:'192.168.1.10:18789',Origin:'http://192.168.1.10:18789'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(remoteStatus,200);
  assert.equal((await fetch(base+'/__set_token',{method:'POST',headers:{Origin:'https://app.logicc.com'},body:jwt('sess_untrusted')})).status,401);
  await add('认证测试','sess_auth');
  assert.equal((await api('/v1/models','GET',undefined,{Authorization:'Bearer environment-key'})).status,200);
  assert.equal((await api('/api/settings/api-key','PUT',{apiKey:'custom-key'})).status,200);
  assert.equal((await api('/v1/models','GET',undefined,{Authorization:'Bearer environment-key'})).status,401);
  assert.equal((await api('/v1/models','GET',undefined,{Authorization:'Bearer custom-key'})).status,200);
  assert.equal((await api('/api/settings/api-key','PUT',{apiKey:'bad key'})).status,400);
  assert.equal((await api('/api/settings/api-key','PUT',{apiKey:''})).status,400);
  assert.ok(!JSON.stringify((await api('/api/state')).data).includes('custom-key'));
  assert.ok(!readFileSync(file,'utf8').includes('custom-key'));
  const restarted=createAdapter({dataFile:file,env:{LOGICC_ADMIN_PASSWORD:'test-admin-password',LOGICC_API_KEY:'environment-key'}});
  const restartedBase=await listen(restarted.server);t.after(()=>close(restarted.server));
  assert.equal((await fetch(restartedBase+'/v1/models',{headers:{Authorization:'Bearer environment-key'}})).status,401);
  assert.equal((await fetch(restartedBase+'/v1/unknown',{headers:{Authorization:'Bearer custom-key'}})).status,404);
  assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{...headers,Cookie:session},body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers,Cookie:session}})).status,401);
});

test('admin password changes verify current password, persist across restarts and invalidate all sessions', async t=>{
  const {api,base,file,pool}=await harness(t);
  const headers={'X-Logicc-Admin':'1','Content-Type':'application/json'};
  const login = (password, url=base) => fetch(url+'/api/login',{method:'POST',headers,body:JSON.stringify({password})});
  const otherSession=(await login('test-admin-password')).headers.get('set-cookie').split(';')[0];
  const body={currentPassword:'test-admin-password',newPassword:'updated-admin-password'};
  assert.equal((await fetch(base+'/api/settings/admin-password',{method:'PUT',headers,body:JSON.stringify(body)})).status,401);
  assert.equal((await api('/api/settings/admin-password','PUT',{...body,currentPassword:'wrong'})).status,403);
  assert.equal((await api('/api/state')).status,200);
  for (const newPassword of ['', 'short', '        ', 'a'.repeat(513), null]) {
    assert.equal((await api('/api/settings/admin-password','PUT',{...body,newPassword})).status,400);
  }
  const save=pool.save;
  pool.save=()=>{throw new Error('simulated disk failure');};
  assert.equal((await api('/api/settings/admin-password','PUT',body)).status,502);
  pool.save=save;
  assert.equal(pool.data.settings.adminPassword,undefined);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers,Cookie:otherSession}})).status,200);
  assert.equal((await api('/api/settings/admin-password','PUT',body)).status,200);
  assert.equal((await api('/api/state')).status,401);
  assert.equal((await fetch(base+'/api/state',{headers:{...headers,Cookie:otherSession}})).status,401);
  assert.equal((await login('test-admin-password')).status,401);
  const newLogin=await login(body.newPassword);assert.equal(newLogin.status,200);
  const cookie=newLogin.headers.get('set-cookie').split(';')[0];
  const snapshot=await (await fetch(base+'/api/state',{headers:{...headers,Cookie:cookie}})).json();
  assert.ok(!JSON.stringify(snapshot).includes('adminPassword'));
  const saved=JSON.parse(readFileSync(file,'utf8')).settings.adminPassword;
  assert.ok(saved.salt);assert.ok(saved.digest);
  assert.ok(!readFileSync(file,'utf8').includes(body.newPassword));
  const restarted=createAdapter({dataFile:file,env:{LOGICC_ADMIN_PASSWORD:'test-admin-password'}});
  const restartedBase=await listen(restarted.server);t.after(()=>close(restarted.server));
  assert.equal((await login('test-admin-password',restartedBase)).status,401);
  assert.equal((await login(body.newPassword,restartedBase)).status,200);
  const withoutEnvironment=createAdapter({dataFile:file,env:{}});
  const withoutBase=await listen(withoutEnvironment.server);t.after(()=>close(withoutEnvironment.server));
  assert.equal(withoutEnvironment.auth.generatedPassword,undefined);
  assert.equal((await login(body.newPassword,withoutBase)).status,200);
});

test('generated administrator password persists as a hash and login attempts are limited', async t=>{
  const folder=mkdtempSync(join(tmpdir(),'logicc-auth-')),file=join(folder,'state.json');
  const first=createAdapter({dataFile:file,env:{}}),base=await listen(first.server);
  t.after(async()=>{await close(first.server);rmSync(folder,{recursive:true,force:true});});
  assert.ok(first.auth.generatedPassword);
  assert.ok(!readFileSync(file,'utf8').includes(first.auth.generatedPassword));
  const restarted=createAdapter({dataFile:file,env:{}}),secondBase=await listen(restarted.server);
  t.after(()=>close(restarted.server));
  assert.equal(restarted.auth.generatedPassword,undefined);
  const headers={'X-Logicc-Admin':'1','Content-Type':'application/json'};
  assert.equal((await fetch(secondBase+'/api/login',{method:'POST',headers,body:JSON.stringify({password:first.auth.generatedPassword})})).status,200);
  for(let i=0;i<10;i++) assert.equal((await fetch(base+'/api/login',{method:'POST',headers,body:'{"password":"wrong"}'})).status,401);
  assert.equal((await fetch(base+'/api/login',{method:'POST',headers,body:'{"password":"wrong"}'})).status,429);
});

test('SSE parser supports split multibyte text and unterminated final frames',async()=>{
  const buffer=Buffer.from('data: {"type":"text-delta","delta":"中文"}\r\n\r\ndata: {"type":"finish"}');
  async function* bytes(){for(const byte of buffer)yield new Uint8Array([byte]);}
  const events=[];for await(const event of parseAiSdkStream(bytes()))events.push(event);
  assert.deepEqual(events,[{type:'text-delta',delta:'中文'},{type:'finish'}]);
});
