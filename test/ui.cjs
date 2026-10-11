const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts');
fs.mkdirSync(output, {recursive:true});
const state = { accounts: [
  {number:1,alias:'Personal',email:'hello@example.test',active:true,usageStatus:'ok',fiveHour:{pct:24},sevenDay:{pct:58,resetsAt:new Date(Date.now()+180000000).toISOString()}},
  {number:2,alias:'Studio',email:'studio@example.test',active:false,usageStatus:'ok',fiveHour:{pct:8},sevenDay:{pct:32,resetsAt:new Date(Date.now()+260000000).toISOString()}},
  {number:3,alias:'Weekend builds',email:'builds@example.test',active:false,disabled:true,usageStatus:'ok',fiveHour:{pct:92},sevenDay:{pct:86,resetsAt:new Date(Date.now()+90000000).toISOString()}}
], busy:false,auto:false,threshold:90,updatedAt:new Date().toISOString() };
(async()=>{
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1080,height:720},deviceScaleFactor:1});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.addInitScript(()=>{window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m),getState:()=>({}),setState:()=>{}});});
    const html = fs.readFileSync(path.join(root,'media/index.html'),'utf8').replaceAll('{{csp}}',"'self'").replaceAll('{{nonce}}','testing').replaceAll('{{css}}','/style.css').replaceAll('{{js}}','/main.js');
    await page.route('http://island.test/**',route=>{const name=new URL(route.request().url()).pathname;route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'application/javascript':'text/html',body:name==='/'?html:fs.readFileSync(path.join(root,'media',name.slice(1)),'utf8')});});
    await page.goto('http://island.test/');
    const apply=async s=>{await page.evaluate(s=>window.postMessage({type:'state',state:s},'*'),s);await page.waitForTimeout(80);};
    await apply(state); assert.equal(await page.locator('.account').count(),3);
    await page.evaluate(() => { window.savedCard = document.querySelectorAll('.account')[1]; window.savedMeter = window.savedCard.querySelector('.meter'); window.savedCard.querySelector('.switch-button').focus(); });
    for (let i = 0; i < 5; i++) await apply({...state,updatedAt:new Date(Date.now()+i*60000).toISOString()});
    assert.equal(await page.evaluate(() => window.savedCard === document.querySelectorAll('.account')[1] && window.savedCard.contains(document.activeElement)), true, 'Background updates preserve card and keyboard focus');
    await apply({...state,accounts:state.accounts.map(a=>a.number===2?{...a,fiveHour:{pct:42}}:a)});
    assert.equal(await page.evaluate(() => window.savedMeter === document.querySelectorAll('.account')[1].querySelector('.meter')), true, 'Usage ring is updated in place');
    assert.equal(await page.locator('.account').nth(1).locator('.usage-copy strong').first().textContent(), '42%');
    assert.equal(await page.locator('.account').first().evaluate(el=>getComputedStyle(el).animationName), 'none');
    assert.ok((await page.locator('.account').first().boundingBox()).height < 190, 'Cards remain compact');
    await apply(state);
    await page.waitForTimeout(400);
    await page.screenshot({animations:'disabled',path:path.join(output,'island-dashboard.png'),fullPage:true});
    await page.getByRole('button',{name:'Switch to account'}).first().click();
    assert.deepEqual(await page.evaluate(()=>window.sent.at(-1)),{type:'switch',number:2});
    await page.getByRole('switch').click(); assert.deepEqual(await page.evaluate(()=>window.sent.at(-1)),{type:'auto',enabled:true});
    await page.getByRole('button',{name:'Save current login'}).click(); assert.equal(await page.evaluate(()=>window.sent.at(-1).type),'add');
    await page.getByRole('button',{name:'Pause for auto-switching: Studio',exact:true}).click(); assert.deepEqual(await page.evaluate(()=>window.sent.at(-1)),{type:'disable',number:2});
    await apply({...state,busy:true}); assert.equal(await page.locator('#add').isDisabled(),true); assert.equal(await page.getByRole('switch').isDisabled(),true);
    await apply({...state,accounts:state.accounts.map(a=>({...a,active:a.number===2})),notice:'Account switched. Continue in Claude Code.'}); assert.equal(await page.locator('#active-name').textContent(),'Studio');
    await page.screenshot({animations:'disabled',path:path.join(output,'island-switched.png'),fullPage:true});
    const toastState = {...state,notice:'Account switched. Continue in Claude Code.'};
    await apply(state);
    const beforeToast = await page.locator('.account').first().boundingBox();
    await apply(toastState);
    assert.deepEqual(await page.locator('.account').first().boundingBox(), beforeToast, 'Toast must not shift cards');
    assert.equal(await page.locator('#feedback').evaluate(el=>getComputedStyle(el).position),'fixed');
    await page.waitForTimeout(3000);
    await apply(toastState);
    assert.equal(await page.locator('#feedback').isVisible(),true);
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('#feedback').isVisible(),false, 'Toast hides after five seconds despite repeat state');
    await apply(toastState);
    assert.equal(await page.locator('#feedback').isVisible(),false, 'Old notice must not reappear on refresh');
    assert.deepEqual(await page.locator('.account').first().boundingBox(), beforeToast);
    await apply({...state,notice:'Account paused for auto-switching.'});
    assert.equal(await page.locator('#feedback').isVisible(),true, 'A new notification appears');
    await page.getByRole('button',{name:'Collapse account list'}).click(); assert.equal(await page.locator('#details').isVisible(),false); await page.screenshot({animations:'disabled',path:path.join(output,'island-collapsed.png'),fullPage:true});
    await page.getByRole('button',{name:'Expand account list'}).click();
    for(const width of [320,560,1080]){await page.setViewportSize({width,height:width===1080?320:800});await apply(state);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({animations:'disabled',path:path.join(output,`island-${width}.png`),fullPage:true});}
    await apply({...state,accounts:[],error:'Could not reach Anthropic. Check your connection.'}); assert.equal(await page.locator('#feedback.error').isVisible(),true); await page.screenshot({animations:'disabled',path:path.join(output,'island-error.png'),fullPage:true});
    await apply({...state,accounts:[]}); assert.equal(await page.locator('#empty').isVisible(),true); await page.screenshot({animations:'disabled',path:path.join(output,'island-empty.png'),fullPage:true});
    await apply({...state,accounts:[{...state.accounts[0],alias:'<img src=x onerror="alert(1)">',usageStatus:'token_expired',fiveHour:undefined,sevenDay:undefined}]});assert.equal(await page.locator('img').count(),0);assert.equal(await page.locator('.usage-copy strong').first().textContent(),'—'); assert.equal(await page.locator('.status-warning').isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log('UI checks passed: actions, busy, switching, collapse, 320/560/1080 layouts, errors, empty, expired, safe text.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
