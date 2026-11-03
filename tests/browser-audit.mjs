// Optional integration check; supply an installed Playwright Core module and Chrome.
// node tests/browser-audit.mjs /path/to/playwright-core/index.mjs /path/to/chrome
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {initialState,chooseAI,legalActions,applyAction} from '../src/engine.js';

if(!process.argv[2]||!process.argv[3])throw new Error('Usage: node tests/browser-audit.mjs <playwright-core/index.mjs> <Chrome executable>');
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const server=spawn(process.execPath,['scripts/server.mjs','--port','0'],{windowsHide:true,stdio:'pipe'});
let browser;
try {
  const url=await new Promise((resolve,reject)=>{
    let output='';server.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
    server.once('error',reject);server.once('exit',code=>reject(new Error('Server exited: '+code)));
  });
  browser=await chromium.launch({executablePath:process.argv[3],headless:true});
  async function waitForCount(page,n){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){if(await page.locator('.history-row').count()===n)return;await delay(25);}
    assert.equal(await page.locator('.history-row').count(),n);
  }
  async function withPage(name,options,run){
    const context=await browser.newContext({viewport:{width:1440,height:1100},locale:'ko-KR',reducedMotion:'reduce'});
    await context.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}));
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await context.addInitScript(({first,mode,stats,workerFailure})=>{
      localStorage.setItem('twelve-settings',JSON.stringify({mode,difficulty:'normal',rule:'expanded',seconds:1,clock:'total'}));
      localStorage.setItem('twelve-stats',JSON.stringify(stats));
      Crypto.prototype.getRandomValues=function(a){a.fill(first);return a;};
      if(workerFailure)window.Worker=class {constructor(){throw new Error('Worker unavailable');}};
    },{first:0,mode:'pvp',stats:[],...options});
    await page.clock.install({time:new Date('2026-10-31T00:00:00Z')});
    try{
      await page.goto(url);await page.evaluate(()=>document.fonts.ready);
      await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now()+1000)));
      await run(page);assert.deepEqual(errors,[],name);console.log('PASS '+name);
    }finally{await context.close();}
  }
  const click=async(page,selector)=>page.locator(selector).evaluate(el=>el.click());
  async function move(page,action,side){
    await click(page,action.drop?`[data-action=hand][data-side="${side}"][data-kind="${action.drop}"]`:`[data-action=cell][data-index="${action.from}"]`);
    await click(page,`[data-action=cell][data-index="${action.to}"]`);
  }
  async function offsetAndClick(page,selector){
    await page.evaluate(selector=>{const now=performance.now.bind(performance);performance.now=()=>now()+250;document.querySelector(selector).click();},selector);
  }
  for(const first of [0,1])await withPage('prisoner zone, color '+first,{first},async page=>{
    assert.equal(await page.locator('[name=first],[name=seconds],[data-group=rule],[data-group=clock]').count(),0);
    await click(page,'[type=submit]');
    assert.equal(await page.locator('[data-action=undo],[data-action=pause],.pause-overlay').count(),0);
    for(const action of first===0?[{from:5,to:6},{from:7,to:6}]:[{from:6,to:5},{from:4,to:5}])await move(page,action);
    await click(page,`[data-action=hand][data-side="${first}"][data-kind=pawn]`);
    const forbidden=first===0?7:4,allowed=first===0?5:6;
    const targets=await page.locator('.cell.legal').evaluateAll(cells=>cells.map(c=>Number(c.dataset.index)));
    assert.ok(targets.length>0);assert.ok(targets.every(i=>i%4!==(first===0?3:0)));assert.ok(targets.includes(allowed));
    await click(page,`[data-action=cell][data-index="${forbidden}"]`);assert.equal(await page.locator('.history-row').count(),2);
    assert.equal(await page.locator(`[data-action=hand][data-side="${first}"]`).count(),1);
    await click(page,`[data-action=cell][data-index="${allowed}"]`);assert.equal(await page.locator('.history-row').count(),3);
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      const points=await page.locator('.board .cell').evaluateAll(cells=>cells.map(c=>{const r=c.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y)];}));
      assert.equal(new Set(points.map(p=>p[0])).size,3);assert.equal(new Set(points.map(p=>p[1])).size,4);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
  });
  await withPage('timeout wins over opening a guide',{},async page=>{
    await click(page,'[type=submit]');await page.clock.fastForward(59900);
    await offsetAndClick(page,'.game-controls [data-action=guide]');
    assert.equal(await page.locator('dialog[open]').getAttribute('aria-label'),'대국 결과');
    assert.match(await page.locator('dialog').innerText(),/홍 플레이어의 승리/);
    assert.match(await page.locator('dialog').innerText(),/제한시간/);
  });
  await withPage('timeout wins over piece selection',{},async page=>{
    await click(page,'[type=submit]');await move(page,{from:5,to:6});await move(page,{from:7,to:6});await page.clock.fastForward(59900);
    await offsetAndClick(page,'[data-action=cell][data-index="4"]');
    assert.equal(await page.locator('dialog[open]').getAttribute('aria-label'),'대국 결과');assert.equal(await page.locator('.history-row').count(),2);
  });
  await withPage('dialogs preserve the remaining clock and closing resumes it',{},async page=>{
    await click(page,'[type=submit]');await page.clock.runFor(2000);const before=await page.locator('[data-clock="0"]').innerText();
    await click(page,'.game-controls [data-action=guide]');await page.clock.fastForward(70000);assert.equal(await page.locator('dialog').getAttribute('aria-label'),'십이장기 게임 방법');
    await click(page,'.modal-close');await delay(25);assert.equal(await page.locator('[data-clock="0"]').innerText(),before);
    await page.clock.runFor(1000);assert.notEqual(await page.locator('[data-clock="0"]').innerText(),before);
  });
  await withPage('invalid stored records do not break viewing or finishing',{stats:{invalid:true}},async page=>{
    await click(page,'nav [data-action=stats]');assert.match(await page.locator('dialog').innerText(),/아직 완료한 대국/);
    await click(page,'.modal-close');await click(page,'[type=submit]');await click(page,'[data-action=resign]');await click(page,'[data-action=confirm-resign]');
    const records=await page.evaluate(()=>JSON.parse(localStorage.getItem('twelve-stats')));assert.equal(records.length,1);assert.equal(records[0].winner,1);
  });
  await withPage('malformed entries are filtered from stored records',{stats:[null,{winner:0,mode:'pvp',moves:'<img>',date:'2026-10-31'},{winner:0,mode:'pvp',moves:2,date:'bad date'},{winner:0,mode:'pvp',moves:7,date:'2026-10-31T00:00:00Z'}]},async page=>{
    await click(page,'nav [data-action=stats]');assert.equal(await page.locator('.stats-list>div').count(),1);assert.match(await page.locator('.stats-list').innerText(),/7수/);assert.equal(await page.locator('.stats-list img').count(),0);
  });
  await withPage('AI opening and human reply advance without takebacks',{first:1,mode:'pvai'},async page=>{
    await click(page,'[type=submit]');await page.clock.runFor(700);await waitForCount(page,1);assert.equal(await page.locator('[data-action=undo],[data-action=pause]').count(),0);
    const opening=initialState(1),state=applyAction(opening,chooseAI(opening));
    const human=legalActions(state).find(action=>{const next=applyAction(state,action);return next.winner===null&&applyAction(next,chooseAI(next)).winner===null;});assert.ok(human);
    await move(page,human,0);await page.clock.runFor(700);await waitForCount(page,3);assert.equal(await page.locator('[data-action=undo],[data-action=pause]').count(),0);assert.match(await page.locator('.turn-banner').innerText(),/청 플레이어/);
  });
  await withPage('leaving the game cancels pending AI responses',{mode:'pvai'},async page=>{
    await click(page,'[type=submit]');await move(page,{from:5,to:6});await click(page,'.game-controls [data-action=home]');await click(page,'[data-action=leave]');await page.clock.runFor(2000);await delay(100);assert.equal(await page.locator('.history-row,.board').count(),0);assert.equal(await page.locator('#setup-form').count(),1);
  });
  await withPage('worker creation failure uses a legal fallback',{first:1,mode:'pvai',workerFailure:true},async page=>{
    await click(page,'[type=submit]');await page.clock.runFor(700);await waitForCount(page,1);assert.equal(await page.locator('.board .piece-letter').filter({hasText:'王'}).count(),2);
  });
  await withPage('AI observation advances with valid kings',{mode:'aivai'},async page=>{
    await click(page,'[type=submit]');
    for(let n=1;n<=4;n++){await page.clock.runFor(1100);await waitForCount(page,n);}
    assert.equal(await page.locator('.board .piece-letter').filter({hasText:'王'}).count(),2);assert.equal(await page.locator('[data-action=undo],[data-action=pause]').count(),0);
  });
  console.log('Browser audit passed.');
} finally {await browser?.close();server.kill();}
