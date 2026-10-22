const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/Users/kamran186/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sharp = require('/Users/kamran186/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');

const root = __dirname;
const sourceRoot = path.resolve(root, '../../../output/mermaid');
const common = [
  'requestBody','api','requestType','graphEntry','preparePrompt','intentRoute',
  'retrieve','memoryStore','semanticFound','proceduralFound','episodicFound','proceduralUse','memoryContext',
  'registryCatalog','selectTools','resolveSchemas','initialPayload','initialAgent','hasCalls',
  'composeResponse','episode','completed','apiResponse','checkpoints',
];
const readLoop = ['authorize','operationType','businessDatabase','appendResults','resultPayload','resultAgent'];
const flows = [
  {id:1,source:'01-revive-orders.mmd',title:'Procedure guidance',prompt:'How revive orders should be processed.',
    note:'Business tools: none. Procedural rules provide guidance; the agent returns calls = [].',
    highlighted:common,execution:[]},
  {id:2,source:'02-usa-customers.mmd',title:'USA customers with an active-only rule',prompt:'Fetch all customers from USA.',
    note:'get_customers reads every matching page. The active/status filter is a required addition.',
    highlighted:[...common,...readLoop],execution:['executeRead']},
  {id:3,source:'03-customers-and-orders.mmd',title:'Customers, order details and applicable rules',prompt:'Fetch customers and their order details; make sure to apply appropriate rules.',
    note:'Read loop: get_customers, then proposed get_orders using actual returned customer IDs; paginate as needed.',
    highlighted:[...common,...readLoop,'semanticUse','episodicUse'],execution:['executeRead']},
];

async function main() {
  const browser = await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1200}});
    await page.setContent('<html><head></head><body></body></html>');
    await page.addScriptTag({path:'/private/tmp/langgraph-mermaid-10.9.3.min.js'});
    await page.evaluate(() => mermaid.initialize({
      startOnLoad:false,securityLevel:'loose',maxTextSize:100000,
      theme:'base',fontFamily:'Arial, sans-serif',
      themeVariables:{darkMode:true,fontSize:'17px',primaryColor:'#0d2d50',primaryTextColor:'#aad2fc',primaryBorderColor:'#35536d',
        secondaryColor:'#0d2d50',tertiaryColor:'#292929',lineColor:'#a6a6a6',textColor:'#e6edf6',
        clusterBkg:'#292929',clusterBorder:'#515151',edgeLabelBackground:'#292929'},
      themeCSS:'.node rect {rx:18px;ry:18px;} .nodeLabel {font-weight:500;} .cluster-label text {fill:#f0f0f0!important;} .edgeLabel text {fill:#dce9f7!important;} .edgeLabel rect {fill:#292929!important;opacity:1!important;} .flowchart-link {stroke-width:1.5px;}',
      flowchart:{htmlLabels:false,useMaxWidth:false,nodeSpacing:36,rankSpacing:46,curve:'linear',padding:16},
    }));
    const metadata=[];
    for (const flow of flows) {
      const source = fs.readFileSync(path.join(sourceRoot,flow.source),'utf8');
      const renderSource = source.replace(/"([^\"]*)"/g, (_full,label) => '"'+label.split('\n').map(s=>s.trim()).join('<br/>')+'"');
      const rendered = await page.evaluate(async ({source,id}) => {
        const {svg}=await mermaid.render('chart'+id,source);
        const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
        const element=doc.documentElement;
        const viewBox=element.getAttribute('viewBox').split(/[ ,]+/).map(Number);
        element.setAttribute('width', String(Math.ceil(viewBox[2])));
        element.setAttribute('height', String(Math.ceil(viewBox[3])));
        return {svg:new XMLSerializer().serializeToString(element),width:Math.ceil(viewBox[2]),height:Math.ceil(viewBox[3]),
          nodeIds:[...doc.querySelectorAll('g.node')].map(n=>n.getAttribute('data-id') || n.id),
          edges:doc.querySelectorAll('path.flowchart-link').length};
      },{source:renderSource,id:flow.id});
      fs.writeFileSync(path.join(root,`flow-${flow.id}.svg`),rendered.svg);
      const width=rendered.width+96;
      const height=rendered.height+244;
      const html=`<html><head><style>
      @page { size: ${width}px ${height}px; margin:0; }
      * {box-sizing:border-box} body {margin:0;background:#2d2d2d;color:#edf4ff;font-family:Arial,sans-serif;}
      .page {width:${width}px;height:${height}px;padding:34px 48px 24px;}
      .head {height:178px;max-width:1500px;}
      .eyebrow {font-size:15px;letter-spacing:2px;color:#aad2fc;margin-bottom:10px;}
      h1 {font-size:30px;margin:0 0 10px;font-weight:700;}
      .prompt {font-size:19px;margin-bottom:9px;}
      .note {font-size:15px;color:#c8d8eb;margin-bottom:11px;}
      .legend {display:flex;gap:24px;font-size:14px;align-items:center;}
      .legend span {display:flex;gap:7px;align-items:center;}
      .swatch {width:15px;height:15px;display:inline-block;border:1px solid #d69e00;background:#fff3bf;}
      .orange{background:#ffdfba;border-color:#d97706}.green{background:#163e2b;border-color:#31c46c}.red{background:#512424;border-color:#ef5350}
      .chart {width:${rendered.width}px;height:${rendered.height}px;}
      .chart svg {display:block;}
      .footer {height:20px;margin-top:12px;font-size:13px;color:#c8d8eb;display:flex;justify-content:space-between;}
      </style></head><body><div class="page"><div class="head">
      <div class="eyebrow">/CHAT WORKFLOW | FULL DIAGRAM ${String(flow.id).padStart(2,'0')}</div>
      <h1>${flow.title}</h1><div class="prompt">Prompt: ${flow.prompt}</div><div class="note">${flow.note}</div>
      <div class="legend"><span><i class="swatch"></i>Prompt path</span><span><i class="swatch orange"></i>Actual business tool execution</span><span><i class="swatch green"></i>Start / Resume</span><span><i class="swatch red"></i>Interrupt / End</span></div>
      </div><div class="chart">${rendered.svg}</div><div class="footer"><span>Complete original workflow retained. Highlighted boxes identify this scenario. Oversized vector page - zoom to read.</span><span>${flow.id*2+1} / 7</span></div></div></body></html>`;
      await page.setContent(html,{waitUntil:'load'});
      await page.pdf({path:path.join(root,`flow-${flow.id}-chart.pdf`),width:width+'px',height:height+'px',printBackground:true,preferCSSPageSize:true});
      await sharp(Buffer.from(rendered.svg)).flatten({background:'#2d2d2d'}).resize({width:1500}).png().toFile(path.join(root,`flow-${flow.id}-overview.png`));
      metadata.push({...flow,width:rendered.width,height:rendered.height,nodeCount:rendered.nodeIds.length,edges:rendered.edges,
        pdfWidth:width*.75,pdfHeight:height*.75});
      console.log(JSON.stringify({flow:flow.id,width:rendered.width,height:rendered.height,nodes:rendered.nodeIds.length,edges:rendered.edges}));
    }
    fs.writeFileSync(path.join(root,'chart-metadata.json'),JSON.stringify(metadata,null,2));
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
