const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {chromium} = require('/Users/kamran186/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

async function main() {
  const browser = await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const context = await browser.newContext({offline:true,acceptDownloads:true,viewport:{width:1440,height:1000}});
    const page = await context.newPage();
    const errors=[], network=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if (/^https?:/.test(request.url())) network.push(request.url());});
    const file=path.resolve(__dirname,'../../../output/html/chat-mermaid-flowcharts.html');
    await page.goto(pathToFileURL(file).href);
    assert.equal(await page.locator('.chart-stage svg').count(),3);
    assert.equal(await page.locator('.chart-stage .node').count(),180);
    assert.equal(await page.locator('.chart-stage .flowchart-link').count(),234);
    const uniqueIds=await page.evaluate(()=>{
      const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);
      return ids.length===new Set(ids).size;
    });
    assert(uniqueIds);
    await page.screenshot({path:path.join(__dirname,'html-desktop.png')});
    const results=[];
    for (let i=1;i<=3;i++) {
      const block=page.locator(`[data-chart="${i}"]`);
      const viewport=block.locator('.chart-view');
      const svg=viewport.locator('svg');
      assert.equal(await block.locator('.node').count(),60);
      assert.equal(await block.locator('.flowchart-link').count(),78);
      await block.locator('[data-action="fit"]').click();
      const fit=await viewport.evaluate(el=>({w:el.clientWidth,h:el.clientHeight,sw:el.scrollWidth,sh:el.scrollHeight}));
      assert(fit.sw<=fit.w+2 && fit.sh<=fit.h+2,JSON.stringify(fit));
      await block.locator('[data-action="actual"]').click();
      const actual=await svg.evaluate(el=>el.getBoundingClientRect().width);
      assert.equal(Math.round(actual),5568);
      const startVisible=await viewport.evaluate(el=>{
        const a=el.getBoundingClientRect(),b=el.querySelector('.node[id*="startPoint-"]').getBoundingClientRect();
        return b.left>=a.left && b.right<=a.right && b.top>=a.top && b.bottom<=a.bottom;
      });
      assert(startVisible,'Original-size view must reveal Start');
      await block.locator('[data-action="in"]').click();
      const zoomed=await svg.evaluate(el=>el.getBoundingClientRect().width);
      assert.equal(Math.round(zoomed),8352);
      await block.locator('[data-action="out"]').click();
      assert.equal(Math.round(await svg.evaluate(el=>el.getBoundingClientRect().width)),5568);
      await block.locator('[data-action="fit"]').click();
      await block.screenshot({path:path.join(__dirname,`html-chart-${i}.png`)});
      results.push({chart:i,nodes:60,edges:78,fit:true,originalSize:true,zoom:true});
    }
    const sourceNames=['01-revive-orders.mmd','02-usa-customers.mmd','03-customers-and-orders.mmd'];
    for(let i=1;i<=3;i++) {
      const source=await page.locator(`#source-${i}`).textContent();
      const expected=fs.readFileSync(path.resolve(__dirname,'../../../output/mermaid',sourceNames[i-1]),'utf8');
      assert.equal(source,expected);
    }
    const sourceDetails=page.locator('[data-chart="1"] .source');
    await sourceDetails.locator('summary').click();
    const [download]=await Promise.all([
      page.waitForEvent('download'),
      sourceDetails.locator('[data-download]').click(),
    ]);
    assert.equal(fs.readFileSync(await download.path(),'utf8'),await page.locator('#source-1').textContent());
    await sourceDetails.locator('summary').click();
    await page.setViewportSize({width:390,height:844});
    await page.locator('h1').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    await page.screenshot({path:path.join(__dirname,'html-mobile.png')});
    const mobileBlock=page.locator('[data-chart="2"]');
    await mobileBlock.locator('[data-action="fit"]').click();
    await mobileBlock.screenshot({path:path.join(__dirname,'html-mobile-chart.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    assert.deepEqual(errors,[]);
    assert.deepEqual(network,[]);
    console.log(JSON.stringify({offline:true,charts:results,uniqueIds:true,sourceMatches:true,sourceDownload:true,mobileWidth:390,errors,externalRequests:network.length},null,2));
    await context.close();
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
