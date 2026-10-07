import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createServer,request as forward} from 'node:http';
import {WebSocketServer} from 'ws';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';
let browser;
const openPanel=async(page,panel)=>{if(!await page.locator(`#tab-${panel}`).isVisible())await page.locator('#panel-menu > summary').click();await page.locator(`#tab-${panel}`).click();};
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CONSOLE_CHROMIUM_PATH?{executablePath:process.env.CONSOLE_CHROMIUM_PATH}:{}),...(process.env.CONSOLE_CHROMIUM_ARGS?{args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)}:{})});});
after(async()=>{await browser?.close();});

// Small real RFB 3.8 peer: no mock noVNC classes. The production client must
// negotiate a framebuffer and decode an actual raw rectangle through WebSocket.
function rfbPeer(socket, record) {
 let stage='version',pending=Buffer.alloc(0),frame=false;
 const send=bytes=>socket.send(bytes);
 const init=()=>{const name=Buffer.from('Timber fixture desktop'),data=Buffer.alloc(24+name.length);data.writeUInt16BE(1280,0);data.writeUInt16BE(800,2);data[4]=32;data[5]=24;data[6]=0;data[7]=1;data.writeUInt16BE(255,8);data.writeUInt16BE(255,10);data.writeUInt16BE(255,12);data[14]=16;data[15]=8;data[16]=0;data.writeUInt32BE(name.length,20);name.copy(data,24);send(data);};
 const update=()=>{const data=Buffer.alloc(16+16*16*4);data.writeUInt16BE(1,2);data.writeUInt16BE(16,8);data.writeUInt16BE(16,10);data.writeInt32BE(0,12);for(let offset=16;offset<data.length;offset+=4){data[offset]=40;data[offset+1]=80;data[offset+2]=210;data[offset+3]=255;}send(data);};
 socket.onMessage(message=>{
  pending=Buffer.concat([pending,Buffer.from(message)]);
  while(pending.length){
   if(stage==='version'){if(pending.length<12)return;record.version=pending.subarray(0,12).toString();pending=pending.subarray(12);stage='security';send(Buffer.from([1,1]));continue;}
   if(stage==='security'){if(pending.length<1)return;assert.equal(pending[0],1);pending=pending.subarray(1);stage='shared';send(Buffer.alloc(4));continue;}
   if(stage==='shared'){pending=pending.subarray(1);stage='connected';record.connected=true;init();continue;}
   const type=pending[0];let length;
   if(type===0)length=20;
   else if(type===2){if(pending.length<4)return;length=4+pending.readUInt16BE(2)*4;}
   else if(type===3)length=10;
   else if(type===4)length=8;
   else if(type===5)length=6;
   else if(type===6){if(pending.length<8)return;length=8+pending.readUInt32BE(4);}
   else {record.unrecognized.push(type);pending=Buffer.alloc(0);return;}
   if(pending.length<length)return;
   const data=pending.subarray(0,length);pending=pending.subarray(length);
   if(type===4||type===5)record.inputs.push({type,data:Array.from(data)});
   if(type===3&&!frame){frame=true;record.frame=true;update();}
  }
 });
 socket.onClose(()=>{record.closed=true;});
 send(Buffer.from('RFB 003.008\n'));
}
async function withDesktop(work,{width=1440,height=1050}={}) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();
 const state={calls:[],sockets:[],gates:[],gate:null,renewReplies:[]},errors=[],violations=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
 await page.exposeFunction('__desktopCsp',v=>violations.push(v));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>globalThis.__desktopCsp({directive:e.effectiveDirective,resource:e.blockedURI})));
 await page.route('**/v1/bots/*/computer/live-session**',async route=>{
  const req=route.request(),url=new URL(req.url()),headers=await req.allHeaders();assert.equal(headers.authorization,undefined);assert.equal(headers['x-timber-client'],'console');assert.match(headers.cookie||'',/timber_fixture_session=/);
  const call={method:req.method(),path:url.pathname,body:req.method()==='POST'?req.postDataJSON():null};state.calls.push(call);
  if(req.method()==='POST'&&url.pathname.endsWith('/live-session')){
   const id=`session-${state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/live-session')).length}`;
   if(state.gate){const gate=state.gate;state.gate=null;await gate;}
   return route.fulfill({json:{sessionId:id,protocols:['binary',`timber-fixture-ticket-${id}`],expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
  if(url.pathname.endsWith('/renew')) {
   const reply=state.renewReplies.shift();
   if(reply)return route.fulfill(reply);
   return route.fulfill({json:{expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
  return route.fulfill({json:{ok:true}});
 });
 const proxy=createServer((req,res)=>{const upstream=forward(new URL(req.url,fixture.url),{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>res.end());req.pipe(upstream);res.on('close',()=>upstream.destroy());});
 const websocket=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('binary')?'binary':false});
 proxy.on('upgrade',(req,socket,head)=>{assert.match(req.url,/^\/v1\/bots\/[a-f0-9-]+\/computer\/live$/);assert.match(req.headers['sec-websocket-protocol'],/timber-fixture-ticket/);websocket.handleUpgrade(req,socket,head,client=>websocket.emit('connection',client,req));});
 websocket.on('connection',(client,req)=>{const record={url:req.url,inputs:[],unrecognized:[],connected:false,closed:false,drop:()=>client.terminate()};state.sockets.push(record);rfbPeer({send:bytes=>client.send(bytes),onMessage:callback=>client.on('message',callback),onClose:callback=>client.on('close',callback)},record);});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const consoleURL=`http://127.0.0.1:${proxy.address().port}/console/`;
 const login=async()=>{await page.goto(consoleURL);await page.locator('#login').waitFor({state:'visible'});await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#app').waitFor({state:'visible'});if(width<=760)await page.locator('.bot-item').first().click();await page.locator('#bot-workspace').waitFor({state:'visible'});};
 const open=async mode=>{await openPanel(page,'computer');await page.locator(`[data-desktop="${mode==='control'?'control':'observe'}"]`).click();await page.locator('#desktop-root').filter({has:page.locator(`.desktop-status:text-is("${mode==='control'?'Live · you have control':'Live · watching'}")`)}).waitFor();};
 try{await work({page,login,open,state,context,fixture:fixture.state});assert.deepEqual(errors,[],'real noVNC has no uncaught browser errors');assert.deepEqual(violations,[],'live desktop conforms to production strict CSP');}
 catch(error){console.error('Desktop diagnostic',JSON.stringify({status:await page.locator('.desktop-status').textContent(),state,errors,violations}));throw error;}
 finally{for(const release of state.gates)release();await context.close();for(const client of websocket.clients)client.terminate();await new Promise(resolve=>websocket.close(resolve));proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));await fixture.close();}
}
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected desktop fixture state was not reached');};
const deletes=state=>state.calls.filter(call=>call.method==='DELETE');
const creates=state=>state.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/live-session'));
const watching=page=>page.locator('.desktop-status').filter({hasText:'Live · watching'}).waitFor();
const visibility=(page,hidden)=>page.evaluate(value=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>value});document.dispatchEvent(new Event('visibilitychange'));},hidden);

test('live desktop negotiates a real framebuffer under strict CSP; Watch is read-only and Take control sends input',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();assert.equal(state.calls.length,0,'opening a bot must not create a live session');
  await openPanel(page,'computer');assert.equal(state.calls.length,0,'opening Computer alone must not start streaming');
  await open('view');assert.equal(state.calls[0].body.mode,'view');
  await page.waitForFunction(()=>{const canvas=document.querySelector('.desktop-screen canvas');return canvas?.width===1280&&canvas?.height===800&&canvas.getContext('2d').getImageData(1,1,1,1).data[0]===40;});
  const canvas=page.locator('.desktop-screen canvas');await canvas.click({position:{x:100,y:100}});await page.keyboard.press('a');await page.mouse.wheel(0,100);
  assert.equal(state.sockets[0].inputs.length,0,'watching cannot send pointer or key input');
  await page.locator('[data-desktop="control"]').click();await page.locator('.desktop-status').filter({hasText:'you have control'}).waitFor();
  assert.equal(state.calls.find(c=>c.body?.mode==='control')?.method,'POST');
  await until(()=>deletes(state).some(c=>c.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  await page.locator('.desktop-screen canvas').click({position:{x:110,y:110}});await page.keyboard.press('b');await page.locator('[data-key="Escape"]').click();
  await until(()=>state.sockets[1].inputs.some(input=>input.type===4)&&state.sockets[1].inputs.some(input=>input.type===5));
  await page.locator('[data-desktop="disconnect"]').click();await page.locator('.desktop-status').filter({hasText:'Disconnected'}).waitFor();
  await until(()=>deletes(state).some(c=>c.path.endsWith('/session-2')));
  assert.equal(state.sockets.length,2);
 });
});
test('brief panel switches preserve Watch while changing bots releases its originating session',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('view');await openPanel(page,'conversation');
  await openPanel(page,'computer');await watching(page);
  assert.equal(state.sockets.length,1,'a quick panel switch reuses the original socket');
  assert.equal(deletes(state).length,0);
  await page.locator('#settings-button').click();await page.keyboard.press('Escape');
  assert.equal(state.sockets.length,1,'a dialog does not reset Watch');
  await page.locator(`[data-bot-id="${BOT_B}"]`).click();await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();
  await until(()=>deletes(state).some(c=>c.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  assert.equal(deletes(state).some(c=>c.path.includes(BOT_B)),false,'a session created by Ada is never released against Linus');
  assert.equal(state.sockets.length,1);
 });
});
test('late session creation after navigation is released and never opens a hidden socket',async()=>{
 await withDesktop(async({page,login,state})=>{
  await login();let release;state.gate=new Promise(r=>release=r);state.gates.push(release);
  await openPanel(page,'computer');await page.locator('[data-desktop="observe"]').click();
  await until(()=>state.calls.some(c=>c.method==='POST'));
  await openPanel(page,'conversation');release();
  await until(()=>deletes(state).some(c=>c.path.endsWith('/session-1')));
  assert.equal(state.sockets.length,0);
  await openPanel(page,'computer');await watching(page);
  assert.equal(state.sockets.length,1,'returning resumes with a fresh grant, not the stale connect');
  assert.equal(creates(state).length,2);
 });
});
test('disconnecting the console closes the active desktop socket and releases the originating session',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('control');await page.locator('#settings-button').click();await page.locator('#disconnect').click();
  await until(()=>state.sockets[0].closed);
  await until(()=>deletes(state).some(call=>call.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  assert.equal(state.sockets.length,1);
 });
});


test('Computer docks beside the conversation on desktop, expands explicitly and closes its live session',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await openPanel(page,'computer');
  assert.equal(await page.locator('#workspace-panels').getAttribute('data-computer-docked'),'true');
  assert.equal(await page.locator('#panel-conversation').isVisible(),true,'chat stays beside the live workspace');
  assert.equal(await page.locator('#panel-computer').isVisible(),true);
  assert.equal(state.calls.length,0,'opening the workspace does not start streaming');
  const chat=await page.locator('#panel-conversation').boundingBox(),computer=await page.locator('#panel-computer').boundingBox();
  assert.ok(chat.width>=300 && computer.width>=360 && chat.x+chat.width<=computer.x+1,'both panes have usable widths');
  await page.locator('#message').fill('Keep my next instruction in the composer');
  await open('view');
  await page.locator('#expand-computer').click();
  assert.equal(await page.locator('#panel-conversation').isVisible(),false);
  assert.equal(await page.locator('#expand-computer').getAttribute('aria-label'),'Dock computer');
  assert.equal(state.sockets.length,1,'expanding does not create a new desktop connection');
  await page.locator('#expand-computer').click();
  assert.equal(await page.locator('#panel-conversation').isVisible(),true);
  assert.equal(await page.locator('#message').inputValue(),'Keep my next instruction in the composer');
  await page.locator('#close-computer').click();
  await page.locator('#panel-computer').waitFor({state:'hidden'});
  assert.equal(await page.locator('#panel-conversation').isVisible(),true);
  await until(()=>state.sockets[0].closed);
  await until(()=>deletes(state).some(call=>call.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  assert.equal(state.sockets.length,1);
 });
});

test('mobile Computer uses the full screen and returns to the preserved conversation',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await page.locator('#message').fill('Mobile draft stays with Ada');
  await openPanel(page,'computer');
  assert.equal(await page.locator('#workspace-panels').getAttribute('data-computer-docked'),'false');
  assert.equal(await page.locator('#panel-conversation').isVisible(),false);
  assert.equal(await page.locator('#panel-computer').isVisible(),true);
  assert.equal(await page.locator('#expand-computer').isVisible(),false);
  await open('view');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.locator('#close-computer').click();
  await until(()=>state.sockets[0].closed);
  assert.equal(await page.locator('#panel-conversation').isVisible(),true);
  assert.equal(await page.locator('#message').inputValue(),'Mobile draft stays with Ada');
 },{width:390,height:844});
});

test('Watch survives short browser tab switches, pauses a long absence and resumes automatically on mobile',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await page.clock.install();await open('view');
  await visibility(page,true);await page.clock.runFor(5000);await visibility(page,false);await watching(page);
  assert.equal(state.sockets.length,1);assert.equal(deletes(state).length,0);
  await visibility(page,true);await page.clock.runFor(31000);
  await page.locator('.desktop-status').filter({hasText:'Paused'}).waitFor();
  await until(()=>state.sockets[0].closed&&deletes(state).length===1);
  await visibility(page,false);await watching(page);
  assert.equal(creates(state).length,2);assert.equal(creates(state)[1].body.mode,'view');
  assert.equal(await page.locator('#app').isVisible(),true);
 },{width:390,height:844});
});

test('a broken control socket reconnects with a fresh view-only grant',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('control');state.sockets[0].drop();
  await until(()=>creates(state).length===2);await watching(page);
  assert.equal(creates(state)[1].body.mode,'view','recovery never takes control without a new user action');
  await page.locator('.desktop-screen canvas').click({position:{x:100,y:100}});await page.keyboard.press('x');
  assert.equal(state.sockets[1].inputs.length,0);
 });
});

test('a failed heartbeat is retried without discarding a live framebuffer',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await page.clock.install();await open('view');
  state.renewReplies.push({status:503,json:{error:{code:'unavailable',message:'Temporarily unavailable'}}});
  await page.clock.runFor(20000);await until(()=>state.calls.some(call=>call.path.endsWith('/renew')));
  await page.clock.runFor(3000);await until(()=>state.calls.filter(call=>call.path.endsWith('/renew')).length>=2);
  await watching(page);assert.equal(state.sockets.length,1);assert.equal(deletes(state).length,0);
 });
});

test('expired desktop grants recover without logging out; revoked account sessions do log out',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await page.clock.install();await open('view');
  state.renewReplies.push({status:401,json:{error:{code:'desktop_session_expired',message:'Desktop lease expired'}}});
  await page.clock.runFor(20000);await page.locator('.desktop-status').filter({hasText:'Reconnecting'}).waitFor();
  await page.clock.runFor(1000);await watching(page);
  assert.equal(creates(state).length,2);assert.equal(await page.locator('#app').isVisible(),true);
  state.renewReplies.push({status:401,json:{error:{code:'unauthorized',message:'Session revoked'}}});
  await page.clock.runFor(20000);await page.locator('#login').waitFor({state:'visible'});
  await until(()=>state.sockets[1].closed);
  assert.equal(creates(state).length,2);
 });
});

test('leaving manual control releases it immediately and browser return resumes only Watch',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('control');await visibility(page,true);
  await until(()=>state.sockets[0].closed&&deletes(state).length===1);
  await visibility(page,false);await watching(page);
  assert.equal(creates(state)[1].body.mode,'view');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await until(()=>state.sockets[1].closed);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await watching(page);assert.equal(creates(state)[2].body.mode,'view');
 });
});

test('network return resumes Watch, while explicit Stop cancels recovery',async()=>{
 await withDesktop(async({page,login,open,state,context})=>{
  await login();await open('view');await context.setOffline(true);
  await page.locator('.desktop-status').filter({hasText:'Waiting for connection'}).waitFor();
  await until(()=>state.sockets[0].closed);await context.setOffline(false);await watching(page);
  assert.equal(creates(state).length,2);
  await context.setOffline(true);await page.locator('[data-desktop="disconnect"]').click();
  await context.setOffline(false);await visibility(page,true);await visibility(page,false);
  await page.locator('.desktop-status').filter({hasText:'Disconnected'}).waitFor();
  assert.equal(creates(state).length,2);
 });
});

test('a Suspend event cancels Watch rather than waking the computer during recovery',async()=>{
 await withDesktop(async({page,login,open,state,fixture})=>{
  await login();await open('view');await until(()=>fixture.streams.size>0);
  fixture.emit(BOT_A,'computer.suspended',{});
  await page.locator('.desktop-status').filter({hasText:'Disconnected'}).waitFor();
  await until(()=>state.sockets[0].closed);
  await visibility(page,true);await visibility(page,false);
  assert.equal(creates(state).length,1);
 });
});
