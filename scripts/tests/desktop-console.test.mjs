import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createServer,request as forward} from 'node:http';
import {WebSocketServer} from 'ws';
import {createConsoleFixture,TEST_TOKEN,BOT_A,BOT_B} from './console-fixture.mjs';
let browser;
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
async function withDesktop(work) {
 const fixture=await createConsoleFixture(),context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();
 const state={calls:[],sockets:[],gates:[],gate:null},errors=[],violations=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
 await page.exposeFunction('__desktopCsp',v=>violations.push(v));
 await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>globalThis.__desktopCsp({directive:e.effectiveDirective,resource:e.blockedURI})));
 await page.route('**/v1/bots/*/computer/live-session**',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(req.headers().authorization,`Bearer ${TEST_TOKEN}`);
  const call={method:req.method(),path:url.pathname,body:req.method()==='POST'?req.postDataJSON():null};state.calls.push(call);
  if(req.method()==='POST'&&url.pathname.endsWith('/live-session')){
   const id=`session-${state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/live-session')).length}`;
   if(state.gate){const gate=state.gate;state.gate=null;await gate;}
   return route.fulfill({json:{sessionId:id,protocols:['binary',`timber-fixture-ticket-${id}`],expiresAt:new Date(Date.now()+60000).toISOString()}});
  }
  return route.fulfill({json:{ok:true}});
 });
 const proxy=createServer((req,res)=>{const upstream=forward(new URL(req.url,fixture.url),{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>res.end());req.pipe(upstream);res.on('close',()=>upstream.destroy());});
 const websocket=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('binary')?'binary':false});
 proxy.on('upgrade',(req,socket,head)=>{assert.match(req.url,/^\/v1\/bots\/[a-f0-9-]+\/computer\/live$/);assert.match(req.headers['sec-websocket-protocol'],/timber-fixture-ticket/);websocket.handleUpgrade(req,socket,head,client=>websocket.emit('connection',client,req));});
 websocket.on('connection',(client,req)=>{const record={url:req.url,inputs:[],unrecognized:[],connected:false,closed:false};state.sockets.push(record);rfbPeer({send:bytes=>client.send(bytes),onMessage:callback=>client.on('message',callback),onClose:callback=>client.on('close',callback)},record);});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const consoleURL=`http://127.0.0.1:${proxy.address().port}/console/`;
 const login=async()=>{await page.goto(consoleURL);await page.locator('#token').fill(TEST_TOKEN);await page.locator('#connect-form button').click();await page.locator('#bot-workspace').waitFor({state:'visible'});};
 const open=async mode=>{await page.locator('#tab-computer').click();await page.locator(`[data-desktop="${mode==='control'?'control':'observe'}"]`).click();await page.locator('#desktop-root').filter({has:page.locator(`.desktop-status:text-is("${mode==='control'?'Live · you have control':'Live · watching'}")`)}).waitFor();};
 try{await work({page,login,open,state,context});assert.deepEqual(errors,[],'real noVNC has no uncaught browser errors');assert.deepEqual(violations,[],'live desktop conforms to production strict CSP');}
 catch(error){console.error('Desktop diagnostic',JSON.stringify({status:await page.locator('.desktop-status').textContent(),state,errors,violations}));throw error;}
 finally{for(const release of state.gates)release();await context.close();for(const client of websocket.clients)client.terminate();await new Promise(resolve=>websocket.close(resolve));proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));await fixture.close();}
}
const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Expected desktop fixture state was not reached');};
const deletes=state=>state.calls.filter(call=>call.method==='DELETE');

test('live desktop negotiates a real framebuffer under strict CSP; Watch is read-only and Take control sends input',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();assert.equal(state.calls.length,0,'opening a bot must not create a live session');
  await page.locator('#tab-computer').click();assert.equal(state.calls.length,0,'opening Computer alone must not start streaming');
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
test('leaving Computer and switching bots release only the originating session without reconnecting',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('view');await page.locator('#tab-conversation').click();
  await until(()=>deletes(state).some(c=>c.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  await page.locator('#tab-computer').click();assert.equal(state.sockets.length,1,'returning does not silently restart');
  await open('view');await page.locator(`[data-bot-id="${BOT_B}"]`).click();await page.locator('#selected-name').filter({hasText:'Linus'}).waitFor();
  await until(()=>deletes(state).some(c=>c.path===`/v1/bots/${BOT_A}/computer/live-session/session-2`));
  assert.equal(deletes(state).some(c=>c.path.includes(BOT_B)),false,'a session created by Ada is never released against Linus');
  assert.equal(state.sockets.length,2);
 });
});
test('late session creation after navigation is released and never opens a hidden socket',async()=>{
 await withDesktop(async({page,login,state})=>{
  await login();let release;state.gate=new Promise(r=>release=r);state.gates.push(release);
  await page.locator('#tab-computer').click();await page.locator('[data-desktop="observe"]').click();
  await until(()=>state.calls.some(c=>c.method==='POST'));
  await page.locator('#tab-conversation').click();release();
  await until(()=>deletes(state).some(c=>c.path.endsWith('/session-1')));
  assert.equal(state.sockets.length,0);
  await page.locator('#tab-computer').click();assert.equal(await page.locator('.desktop-status').textContent(),'Disconnected');
 });
});
test('disconnecting the console closes the active desktop socket and releases the originating session',async()=>{
 await withDesktop(async({page,login,open,state})=>{
  await login();await open('control');await page.locator('#disconnect').click();
  await until(()=>state.sockets[0].closed);
  await until(()=>deletes(state).some(call=>call.path===`/v1/bots/${BOT_A}/computer/live-session/session-1`));
  assert.equal(state.sockets.length,1);
 });
});
