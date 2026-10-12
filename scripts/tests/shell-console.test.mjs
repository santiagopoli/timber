import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {chromium,webkit} from 'playwright';
import {createServer,request as forward} from 'node:http';
import {WebSocketServer} from 'ws';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';
let browser;
before(async()=>{browser=await (process.env.CONSOLE_BROWSER==='webkit'?webkit:chromium).launch({headless:true,...(process.env.CONSOLE_BROWSER!=='webkit'&&process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});});
after(async()=>{await browser?.close();});
const until=async(fn)=>{for(let i=0;i<750;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Shell fixture condition not reached');};
const panel=async(page,name)=>{if(!await page.locator(`#tab-${name}`).isVisible())await page.locator('#panel-menu > summary').click();await page.locator(`#tab-${name}`).click();};
const creates=state=>state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/shell-session'));
const deletes=state=>state.calls.filter(c=>c.method==='DELETE');
async function withShell(work,{width=1440,height=900}={}) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height},colorScheme:'dark'}),page=await context.newPage();
 const errors=[],violations=[],state={calls:[],sockets:[],gate:null,releases:[],lifetime:60000,createError:false,renewError:false,renewGate:null,releaseError:false};
 page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__shellCsp',v=>violations.push(v));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>globalThis.__shellCsp({directive:e.effectiveDirective,resource:e.blockedURI})));
 const proxy=createServer((req,res)=>{const upstream=forward(new URL(req.url,fixture.url),{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>res.end());req.pipe(upstream);res.on('close',()=>upstream.destroy());});
 const ws=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('timber-shell.v1')?'timber-shell.v1':false});
 proxy.on('upgrade',(req,socket,head)=>{assert.match(req.url,/^\/v1\/bots\/[a-f0-9-]+\/computer\/shell$/);assert.match(req.headers['sec-websocket-protocol'],/timber-shell-ticket\./);assert.equal(new URL(req.url,'http://fixture').search,'');ws.handleUpgrade(req,socket,head,client=>ws.emit('connection',client,req));});
 ws.on('connection',(client,req)=>{const record={url:req.url,inputs:[],controls:[],closed:false,drop:()=>client.close(),send:data=>client.send(data)};state.sockets.push(record);client.on('close',()=>record.closed=true);client.on('message',(data,binary)=>{assert.equal(binary,false);const message=JSON.parse(data.toString());if(message.type==='input')record.inputs.push(Buffer.from(message.data));else record.controls.push(message);});client.send(JSON.stringify({type:'output',data:'\x1b[32mfixture ready\x1b[0m\r\n/workspace $ ',seq:1}));});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${proxy.address().port}`;
 await page.route('**/v1/bots/*/computer/shell-session**',async route=>{
  const req=route.request(),headers=await req.allHeaders(),path=new URL(req.url()).pathname;
  assert.equal(headers.authorization,undefined);assert.equal(headers['x-timber-client'],'console');assert.match(headers.cookie||'',/timber_fixture_session=/);
  state.calls.push({method:req.method(),path,body:req.method()==='POST'?req.postDataJSON():null});
  if(req.method()==='POST'&&path.endsWith('/shell-session')){
   const id=`shell-${creates(state).length}`;
   if(state.gate){const gate=state.gate;state.gate=null;await gate;}
   if(state.createError)return route.fulfill({status:503,json:{error:{code:'shell_unavailable',message:'unavailable'}}});
   const bot=path.split('/')[3];return route.fulfill({json:{sessionId:id,url:`${origin.replace('http:','ws:')}/v1/bots/${bot}/computer/shell`,protocols:['timber-shell.v1',`timber-shell-ticket.${'a'.repeat(71)}${creates(state).length%10}`],expiresAt:new Date(Date.now()+state.lifetime).toISOString()}});
  }
  if(path.endsWith('/renew')){
   if(state.renewGate){const gate=state.renewGate;state.renewGate=null;await gate;}
   return state.renewError?route.fulfill({status:401,json:{error:{code:'shell_session_expired',message:'expired'}}}):route.fulfill({json:{expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
  return state.releaseError?route.fulfill({status:503,json:{error:{code:'shell_cleanup_pending',message:'pending'}}}):route.fulfill({json:{ok:true}});
 });
 const login=async()=>{await page.goto(`${origin}/console/`);await page.locator('#login').waitFor({state:'visible'});await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});if(width<=760)await page.locator('.bot-item').first().click();await page.locator('#bot-workspace').waitFor({state:'visible'});};
 const open=async()=>{await panel(page,'computer');await page.locator('[data-computer-view="shell"]').click();};
 const connect=async()=>{await page.locator('[data-shell="connect"]').click();await page.locator('#shell-root[data-state="connected"]').waitFor();await page.locator('.xterm-rows').filter({hasText:'fixture ready'}).waitFor();};
 try{await work({page,context,state,fixture:fixture.state,login,open,connect});assert.deepEqual(errors,[],'shell has no uncaught browser errors');assert.deepEqual(violations,[],'shell preserves strict console CSP');}
 finally{for(const release of state.releases)release();await context.close();for(const client of ws.clients)client.terminate();await new Promise(r=>ws.close(r));proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await fixture.close();}
}
for(const width of [320,390,1024,1440])test(`shell ${width}px: explicit connection, one surface, real terminal input and resize`,async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  await login();await open();assert.equal(state.calls.length,0,'entering Computer/Shell never wakes the computer');
  assert.equal(await page.locator('#desktop-root').isVisible(),false);assert.equal(await page.locator('#computer-tools').isVisible(),false);
  await connect();assert.deepEqual(creates(state)[0].body,{});
  await until(()=>state.sockets[0].controls.some(message=>message.type==='resize'));const first=state.sockets[0].controls.find(message=>message.type==='resize');assert.ok(first.cols>=10&&first.rows>=2);assert.ok(state.sockets[0].controls.some(message=>message.type==='ack'&&message.seq===1));
  await page.locator('[data-shell-key="keyboard"]').click();await page.keyboard.type('printf hello');await page.keyboard.press('Enter');await page.keyboard.press('Control+c');
  await page.locator('[data-shell-key="ctrl-c"]').click();await page.locator('[data-shell-key="tab"]').click();
  await until(()=>Buffer.concat(state.sockets[0].inputs).includes(Buffer.from('printf hello\r\x03\x03\t')));
  const layout=await page.evaluate(()=>{const root=document.querySelector('#shell-root'),terminal=document.querySelector('.shell-terminal');return {overflow:document.documentElement.scrollWidth>innerWidth,root:root.getBoundingClientRect().toJSON(),terminal:terminal.getBoundingClientRect().toJSON(),targets:[...document.querySelectorAll('[data-shell],[data-shell-key],[data-computer-view]')].map(b=>b.getBoundingClientRect().height)};});
  assert.equal(layout.overflow,false);assert.ok(layout.terminal.width>=150);assert.ok(layout.terminal.height>=80);assert.ok(layout.root.right<=width+1);assert.ok(layout.targets.every(h=>h>=44));
  // Simulate mobile OS keyboard visualViewport; toolbar + helper keys remain reachable.
  await page.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:460});window.visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(150);assert.ok((await page.locator('.shell-keys').boundingBox()).y+(await page.locator('.shell-keys').boundingBox()).height<=Math.max(460,layout.root.y+160)+2);
  await page.locator('[data-shell="disconnect"]').click();await until(()=>state.sockets[0].closed&&deletes(state).length===1);
  assert.equal(await page.locator('.xterm').count(),0,'disconnect discards display transcript');
  await panel(page,'conversation');await open();await page.waitForTimeout(150);assert.equal(creates(state).length,1,'no silent reconnect');
  await connect();assert.equal(creates(state).length,2);assert.equal(state.sockets.length,2,'reconnect gets fresh ticket');
 },{width});
});
test('shell releases originating session on bot switch and logout; no cross-bot session reuse',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  await login();await open();await connect();await page.locator(`[data-bot-id="${BOT_B}"]`).click();await until(()=>deletes(state).some(c=>c.path===`/v1/bots/${BOT_A}/computer/shell-session/shell-1`));
  assert.equal(await page.locator('.xterm').count(),0);assert.equal(creates(state).length,1);await connect();
  await page.locator('#settings-button').click();await page.locator('#disconnect').click();await page.locator('#login').waitFor({state:'visible'});
  await until(()=>state.sockets[1].closed&&deletes(state).some(c=>c.path===`/v1/bots/${BOT_B}/computer/shell-session/shell-2`));assert.equal(state.sockets.length,2);
 });
});
test('shell rejects late create after closing Computer and releases ticket without opening a socket',async()=>{
 await withShell(async({page,state,login,open})=>{
  await login();await open();let release;state.gate=new Promise(r=>release=r);state.releases.push(release);
  await page.locator('[data-shell="connect"]').click();await until(()=>creates(state).length===1);assert.equal(await page.locator('#shell-root').getAttribute('data-state'),'connecting');
  await panel(page,'conversation');release();await until(()=>deletes(state).length===1);assert.equal(state.sockets.length,0);
  await open();await page.waitForTimeout(150);assert.equal(creates(state).length,1);
 });
});
test('shell disconnect while connecting fences late success and repeated Connect is single flight',async()=>{
 await withShell(async({page,state,login,open})=>{
  await login();await open();let release;state.gate=new Promise(r=>release=r);state.releases.push(release);
  await page.locator('[data-shell="connect"]').click();await until(()=>creates(state).length===1);assert.equal(await page.locator('[data-shell="connect"]').isDisabled(),true);
  await page.locator('[data-shell="disconnect"]').click();release();await until(()=>deletes(state).length===1);assert.equal(state.sockets.length,0);
 });
});
test('shell renews lease then handles transport close without reconnection',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  state.lifetime=5000;await login();await open();await connect();await until(()=>state.calls.some(c=>c.path.endsWith('/renew')));
  assert.equal(state.calls.find(c=>c.path.endsWith('/renew')).path,`/v1/bots/${BOT_A}/computer/shell-session/shell-1/renew`);
  state.sockets[0].drop();await page.locator('#shell-root[data-state="disconnected"]').waitFor();await until(()=>deletes(state).length===1);await page.waitForTimeout(200);assert.equal(creates(state).length,1);
 });
});
test('an unconfirmed cleanup is visible and does not silently reconnect',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  await login();await open();await connect();state.releaseError=true;await page.locator('[data-shell="disconnect"]').click();
  await until(()=>state.sockets[0].closed&&deletes(state).length===1);await page.locator('.shell-hint').filter({hasText:'server cleanup is not confirmed'}).waitFor();
  assert.equal(creates(state).length,1);assert.equal(await page.locator('.xterm').count(),0);
 });
});
test('PTY output remains terminal text and renderer sheets are removed on disconnect',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  await login();await open();const baseline=await page.evaluate(()=>document.adoptedStyleSheets.length);await connect();
  const count=await page.evaluate(()=>document.adoptedStyleSheets.length);assert.ok(count>baseline);
  state.sockets[0].send(JSON.stringify({type:'output',seq:2,data:'<style>body{display:none}</style><img src=x onerror="window.shellInjected=true"><script>window.shellInjected=true</script>\r\n'}));
  await until(()=>state.sockets[0].controls.some(frame=>frame.type==='ack'&&frame.seq===2));
  assert.equal(await page.evaluate(()=>window.shellInjected),undefined);assert.equal(await page.locator('.shell-terminal img,.shell-terminal script,.shell-terminal style').count(),0);
  assert.equal(await page.locator('#app').isVisible(),true);await page.locator('[data-shell="disconnect"]').click();
  assert.equal(await page.evaluate(()=>document.adoptedStyleSheets.length),baseline);
 });
});
test('shell rejects an oversized paste locally without closing or truncating it',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  await login();await open();await connect();
  await page.evaluate(()=>{const transfer=new DataTransfer();transfer.setData('text/plain','x'.repeat(20000));document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));});
  await page.waitForTimeout(100);assert.equal(state.sockets[0].inputs.length,0);assert.equal(await page.locator('#shell-root').getAttribute('data-state'),'connected');
  assert.match(await page.locator('.shell-hint').textContent(),/too large/);await page.locator('[data-shell-key="enter"]').click();await until(()=>state.sockets[0].inputs.length===1);
 });
});
test('shell exit releases the reservation, stops renewal, and preserves the transcript',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  state.lifetime=5000;await login();await open();await connect();state.sockets[0].send(JSON.stringify({type:'exit',exitCode:7}));
  await page.locator('#shell-root[data-state="disconnected"]').waitFor();await until(()=>state.sockets[0].closed&&deletes(state).length===1);
  assert.equal(state.calls.some(c=>c.path.endsWith('/renew')),false);assert.equal(await page.locator('.xterm-rows').filter({hasText:'Shell exited with code 7'}).count(),1);
  await connect();assert.equal(creates(state).length,2);
 });
});
test('shell renewal error is local, closes transport and requires fresh explicit connection',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  state.lifetime=5000;state.renewError=true;await login();await open();await connect();await page.locator('#shell-root[data-state="error"]').waitFor();assert.equal(await page.locator('#app').isVisible(),true,'expired shell lease is not console logout');
  await until(()=>state.sockets[0].closed);assert.equal(creates(state).length,1);state.renewError=false;await connect();assert.equal(creates(state).length,2);
 });
});
test('shell creation error does not claim connected or retry silently',async()=>{
 await withShell(async({page,state,login,open,connect})=>{
  state.createError=true;await login();await open();await page.locator('[data-shell="connect"]').click();await page.locator('#shell-root[data-state="error"]').waitFor();assert.equal(state.sockets.length,0);assert.equal(creates(state).length,1);
  state.createError=false;await connect();assert.equal(creates(state).length,2);
 });
});
test('switch Desktop / Shell, suspend, and background each clean up without reconnect',async()=>{
 await withShell(async({page,state,fixture,login,open,connect})=>{
  await login();await open();await connect();await page.locator('[data-computer-view="desktop"]').click();await until(()=>state.sockets[0].closed);assert.equal(await page.locator('#shell-root').isVisible(),false);
  await open();await connect();await page.locator('#suspend-computer').click();await until(()=>state.sockets[1].closed);await until(()=>fixture.calls.some(c=>c.path?.endsWith('/computer/suspend')||c.url?.endsWith('/computer/suspend')));assert.equal(creates(state).length,2);
  await connect();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});await until(()=>state.sockets[2].closed);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(200);assert.equal(creates(state).length,3);
 });
});
