const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/Users/kamran186/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const sharp = require('/Users/kamran186/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = '/Users/kamran186/Documents/dev/learning/langGraph';
const destination = path.join(root, 'output/mermaid/session-customer-preference');
const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));

function labelsForRendering(source) {
  return source.replace(/"([^\"]*)"/g, (_full, label) => '"' + label.split('\n').map(line => line.trim()).join('<br/>') + '"');
}

async function main() {
  const browser = await chromium.launch({headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({path: '/private/tmp/langgraph-mermaid-10.9.3.min.js'});
    await page.evaluate(() => mermaid.initialize({
      startOnLoad: false, securityLevel: 'loose', maxTextSize: 100000,
      theme: 'base', fontFamily: 'Arial, sans-serif',
      themeVariables: {darkMode: true, fontSize: '17px', primaryColor: '#0d2d50', primaryTextColor: '#aad2fc', primaryBorderColor: '#35536d', secondaryColor: '#0d2d50', tertiaryColor: '#292929', lineColor: '#a6a6a6', textColor: '#e6edf6', clusterBkg: '#292929', clusterBorder: '#515151', edgeLabelBackground: '#292929'},
      flowchart: {htmlLabels: false, useMaxWidth: false, nodeSpacing: 36, rankSpacing: 46, curve: 'linear', padding: 16},
    }));
    const results = [];
    for (const [index, flow] of flows.entries()) {
      const source = fs.readFileSync(path.join(destination, flow.file), 'utf8');
      const baseline = source.replace(/\s*%% Active path[\s\S]*$/, '');
      const rendered = await page.evaluate(async ({source, baseline, index}) => {
        const original = await mermaid.mermaidAPI.getDiagramFromText(baseline);
        const candidate = await mermaid.mermaidAPI.getDiagramFromText(source);
        const edgeData = diagram => diagram.db.getEdges().map(edge => ({start: edge.start, end: edge.end, text: edge.text, type: edge.type}));
        if (JSON.stringify(edgeData(original)) !== JSON.stringify(edgeData(candidate))) throw new Error('Chart edges changed');
        const {svg} = await mermaid.render('sessionPreference' + index, source);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const element = doc.documentElement;
        const viewBox = element.getAttribute('viewBox').split(/[ ,]+/).map(Number);
        element.setAttribute('width', Math.ceil(viewBox[2]));
        element.setAttribute('height', Math.ceil(viewBox[3]));
        const nodes = [...doc.querySelectorAll('g.node')];
        return {svg: new XMLSerializer().serializeToString(element), nodes: nodes.length, edges: doc.querySelectorAll('path.flowchart-link').length, highlighted: nodes.filter(node => node.classList.contains('highlighted')).length, execution: nodes.filter(node => node.classList.contains('execution')).length};
      }, {source: labelsForRendering(source), baseline: labelsForRendering(baseline), index});
      if (rendered.nodes !== 60 || rendered.edges !== 78) throw new Error('Incomplete flowchart');
      if (rendered.highlighted !== flow.active.length || rendered.execution !== flow.execution.length) throw new Error('Missing node highlights');
      const svgPath = path.join(destination, flow.file.replace('.mmd', '.svg'));
      fs.writeFileSync(svgPath, rendered.svg);
      await sharp(Buffer.from(rendered.svg)).flatten({background: '#2d2d2d'}).resize({width: 1400}).png().toFile(path.join(__dirname, 'overview-' + (index + 1) + '.png'));
      const {svg, ...counts} = rendered;
      results.push({file: flow.file, ...counts});
    }
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
