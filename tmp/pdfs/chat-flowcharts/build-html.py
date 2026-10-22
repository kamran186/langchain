from pathlib import Path
import html
import importlib.util
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[2]
OUTPUT = PROJECT / 'output' / 'html' / 'chat-mermaid-flowcharts.html'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

spec = importlib.util.spec_from_file_location('pdf_content', ROOT / 'build-document.py')
content = importlib.util.module_from_spec(spec)
spec.loader.exec_module(content)


def paragraph(text, style='body'):
    if text.startswith('NEXT PAGE'):
        return ''
    if style == 'title':
        return f'<h2>{text}</h2>'
    css = {'label': 'eyebrow', 'small': 'small'}.get(style, '')
    return f'<p class="{css}">{text}</p>'


def table(rows, widths=None, header=False, font_style=None):
    out = ['<div class="table-wrap"><table>']
    if header:
        out.append('<thead><tr>' + ''.join(f'<th scope="col">{v}</th>' for v in rows[0]) + '</tr></thead>')
    out.append('<tbody>')
    for row in rows[1:] if header else rows:
        out.append('<tr>' + ''.join(f'<td>{v}</td>' for v in row) + '</tr>')
    out.append('</tbody></table></div>')
    return ''.join(out)


content.p = paragraph
content.section = lambda text: f'<h3>{text}</h3>'
content.table = table
content.callout = lambda title, body, **kw: f'<div class="prompt"><span>{title}</span><p>{body}</p></div>'
content.Spacer = lambda *args: ''
content.build_page = lambda filename, flowables, number, label: ''.join(flowables)

summaries = [content.flow_one(), content.flow_two(), content.flow_three()]
metadata = json.loads((ROOT / 'chart-metadata.json').read_text())
source_names = ['01-revive-orders.mmd', '02-usa-customers.mmd', '03-customers-and-orders.mmd']


def unique_svg(source, number, title):
    tree = ET.fromstring(source)
    mapping = {n.attrib['id']: f'flow{number}__{n.attrib["id"]}' for n in tree.iter() if 'id' in n.attrib}
    source = re.sub(r'(\sid=")([^"]+)(")', lambda m: m[1] + mapping[m[2]] + m[3], source)
    source = re.sub(r'#([A-Za-z_][A-Za-z0-9_-]*)', lambda m: '#' + mapping.get(m[1], m[1]), source)
    source = re.sub(r'(aria-labelledby|aria-describedby)="([^"]*)"',
                    lambda m: m[1] + '="' + ' '.join(mapping.get(v, v) for v in m[2].split()) + '"', source)
    source = source.replace('<svg ', '<svg aria-label="' + html.escape(title, quote=True) + '" ', 1)
    parsed = ET.fromstring(source)
    nodes = [n for n in parsed.iter() if 'node' in n.attrib.get('class', '').split()]
    edges = [n for n in parsed.iter() if 'flowchart-link' in n.attrib.get('class', '').split()]
    assert len(nodes) == 60 and len(edges) == 78
    return source


legend = '''<div class="legend" aria-label="Chart highlight legend">
<span><i class="swatch yellow" aria-hidden="true"></i>Prompt path</span>
<span><i class="swatch orange" aria-hidden="true"></i>Business tool execution</span>
<span><i class="swatch green" aria-hidden="true"></i>Start / Resume</span>
<span><i class="swatch red" aria-hidden="true"></i>Interrupt / End</span>
</div>'''

sections = []
for i, meta in enumerate(metadata, 1):
    source = (PROJECT / 'output' / 'mermaid' / source_names[i - 1]).read_text()
    svg = unique_svg((ROOT / f'flow-{i}.svg').read_text(), i, meta['title'] + ' - complete highlighted flowchart')
    title = html.escape(meta['title'])
    summary = summaries[i - 1].replace('<h2>', f'<h2 id="flow-title-{i}">', 1)
    sections.append(f'''<section id="flow-{i}" class="scenario" aria-labelledby="flow-title-{i}">
<div class="summary">{summary}</div>
<div class="chart-block" data-chart="{i}" data-width="{meta['width']}" data-height="{meta['height']}">
<div class="chart-heading"><div><p class="eyebrow">COMPLETE MERMAID FLOWCHART {i:02d}</p><h3>{title}</h3></div>
<div class="chart-controls" aria-label="Zoom controls for {title}">
<button type="button" data-action="out" aria-label="Zoom out: {title}" disabled>-</button>
<button type="button" data-action="fit" disabled>Fit</button>
<button type="button" data-action="actual" aria-label="Show {title} at original size" disabled>100%</button>
<button type="button" data-action="in" aria-label="Zoom in: {title}" disabled>+</button>
<output aria-live="polite" aria-label="Current zoom">Overview</output>
</div></div>
{legend}
<p class="chart-help">Use Fit for the full chart, or 100% to read the labels. Scroll or drag to move around.</p>
<div class="chart-view" tabindex="0" role="region" aria-label="Scrollable complete flowchart: {title}">
<div class="chart-stage">{svg}</div></div>
<noscript><p class="chart-help">The full chart is included below. Enable JavaScript for zoom controls, or use your browser zoom.</p></noscript>
<details class="source"><summary>Mermaid source</summary>
<button type="button" class="download" data-download="{i}" disabled>Download .mmd</button>
<pre><code id="source-{i}">{html.escape(source)}</code></pre></details>
</div></section>''')

CSS = '''
:root{color-scheme:light;--navy:#172b48;--teal:#087e82;--ink:#253448;--muted:#536780;--line:#dce3ec;--paper:#fff;--canvas:#2d2d2d}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:#f0f3f7;color:var(--ink);font:16px/1.65 Arial,Helvetica,sans-serif}
a{color:var(--teal)}a:hover{text-decoration-thickness:2px}button,a,summary{touch-action:manipulation}button:focus-visible,a:focus-visible,summary:focus-visible,.chart-view:focus-visible{outline:3px solid #159ea3;outline-offset:4px}
.document{max-width:1280px;margin:36px auto;padding:0 28px}.hero,.scenario{background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin:0 0 30px}.hero{padding:34px 40px;border-top:5px solid var(--teal)}
.eyebrow{font-size:12px;letter-spacing:1.1px;font-weight:700;color:var(--teal);margin:0 0 10px}h1{color:var(--navy);font-size:clamp(30px,4vw,44px);line-height:1.18;letter-spacing:-.8px;margin:8px 0 14px}h2{color:var(--navy);font-size:30px;line-height:1.25;letter-spacing:-.4px;margin:0 0 22px}h3{color:var(--navy);font-size:19px;line-height:1.4;margin:25px 0 12px}p{margin:0 0 14px}.lead{color:var(--muted);max-width:850px;font-size:18px}.small{font-size:14px;color:var(--muted)}
.jump-links{display:flex;flex-wrap:wrap;gap:10px;margin:25px 0}.jump-links a{display:block;background:#edf6f6;border:1px solid #bedcde;border-radius:7px;padding:9px 14px;text-decoration:none;font-weight:700;font-size:14px}.jump-links a:hover{background:#dceff0}.shared{border-top:1px solid var(--line);padding-top:16px}.shared h3{margin-top:0}.design-note{margin-top:18px;padding:14px 18px;background:#f3f6fa;border-radius:7px}.design-note p:last-child{margin-bottom:0}.design-note summary{font-weight:700;color:var(--navy)}
.summary{padding:34px 40px 25px;max-width:1000px}.prompt{background:#f1f5f9;border-left:4px solid var(--teal);padding:14px 18px;margin-bottom:24px}.prompt span{display:block;color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px}.prompt p{font-size:18px;font-weight:700;color:var(--navy);margin:4px 0 0}.table-wrap{width:100%;overflow:auto;margin:12px 0 18px}table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:left;vertical-align:top;padding:13px 15px;border-bottom:1px solid var(--line)}th{background:var(--navy);color:#fff;font-size:12px;letter-spacing:.4px}td:first-child{width:25%;min-width:135px}tbody tr:nth-child(odd){background:#f1f5f9}
.chart-block{background:var(--canvas);color:#edf4ff;padding:22px 24px 0}.chart-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.chart-heading h3{color:#edf4ff;font-size:20px;margin:0 0 12px}.chart-heading .eyebrow{color:#aad2fc;margin-bottom:5px}.chart-controls{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding-bottom:10px}.chart-controls button,.download{font:600 14px Arial,sans-serif;border:1px solid #7892ad;background:#133651;color:#e4f1ff;border-radius:6px;min-height:40px;min-width:40px;padding:8px 12px;cursor:pointer}.chart-controls button:hover,.download:hover{background:#245474}.chart-controls button:disabled,.download:disabled{opacity:.45;cursor:default}.chart-controls output{font-size:12px;font-variant-numeric:tabular-nums;min-width:78px;text-align:right;color:#cad9e9}.legend{display:flex;flex-wrap:wrap;gap:9px 23px;font-size:12px;color:inherit;margin:8px 0}.legend span{display:inline-flex;gap:7px;align-items:center}.swatch{display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid currentColor}.yellow{background:#fff3bf;border-color:#d69e00}.orange{background:#ffdfba;border-color:#d97706}.green{background:#163e2b;border-color:#31c46c}.red{background:#512424;border-color:#ef5350}.chart-help{font-size:13px;color:#c8d8eb;margin:10px 0 16px}
.chart-view{width:100%;height:clamp(450px,75vh,800px);overflow:auto;border:1px solid #535961;border-radius:7px;background:var(--canvas);overscroll-behavior:contain;cursor:grab}.chart-view.dragging{cursor:grabbing}.chart-stage{min-width:100%;min-height:100%;padding:16px;user-select:none}.chart-stage>svg{display:block;width:100%;height:auto;max-width:none;margin:0 auto}.source{border-top:1px solid #535961;margin-top:20px;padding:16px 0 22px}.source summary{font-size:14px;font-weight:700;color:#d5e7fc;cursor:pointer}.source pre{padding:18px;background:#222;border:1px solid #535961;border-radius:6px;overflow:auto;max-height:440px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4;color:#e3edf9}.download{margin:15px 0 0}.footer{text-align:center;color:var(--muted);font-size:13px;padding:3px 0 20px}
@media(max-width:700px){.document{padding:0 12px;margin:12px auto}.hero,.summary{padding:24px 20px}.chart-block{padding:20px 12px 0}.hero{border-radius:10px}.scenario{border-radius:10px}h2{font-size:25px}th,td{padding:10px;font-size:14px}td:first-child{min-width:104px}.chart-heading{gap:8px}.chart-controls button{min-width:44px;min-height:44px}.chart-controls output{text-align:left}.legend{gap:8px 13px}.chart-view{height:560px;height:70vh;min-height:360px}.chart-stage{padding:8px}.jump-links a{flex:1 1 100%;text-align:center}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{@page{size:A4;margin:12mm}body{background:white;font-size:11pt}.document{max-width:none;margin:0;padding:0}.hero,.scenario{border:0;border-radius:0;margin-bottom:20px}.hero,.summary{padding:0}.jump-links,.chart-controls,.source,.chart-help,.footer{display:none}.chart-block{break-before:page;break-inside:avoid;print-color-adjust:exact;-webkit-print-color-adjust:exact;padding:15px}.chart-view{height:auto!important;max-height:none!important;overflow:visible!important;border:0}.chart-stage{width:100%!important;height:auto!important;min-height:0;padding:0}.chart-stage>svg{width:100%!important;height:auto!important;max-width:100%!important}.chart-heading h3{font-size:15pt}.legend{font-size:8pt}.scenario{break-before:page}h3{break-after:avoid}tr{break-inside:avoid}.design-note{background:white;padding:0}.design-note summary{display:none}}
'''

JS = '''
(() => {
  const charts = [];
  document.querySelectorAll('[data-chart]').forEach(block => {
    const viewport = block.querySelector('.chart-view');
    const stage = block.querySelector('.chart-stage');
    const svg = stage.querySelector('svg');
    const output = block.querySelector('output');
    const width = Number(block.dataset.width), height = Number(block.dataset.height);
    let scale = 1, mode = 'fit';
    function render(next, keepCenter) {
      const before = svg.getBoundingClientRect();
      const frame = viewport.getBoundingClientRect();
      const cx = (frame.left + viewport.clientWidth / 2 - before.left) / scale;
      const cy = (frame.top + viewport.clientHeight / 2 - before.top) / scale;
      scale = Math.min(3, Math.max(0.015, next));
      svg.style.width = width * scale + 'px';
      svg.style.height = height * scale + 'px';
      svg.style.maxWidth = 'none';
      const padding = window.innerWidth <= 700 ? 16 : 32;
      stage.style.width = Math.max(viewport.clientWidth, width * scale + padding) + 'px';
      stage.style.height = Math.max(viewport.clientHeight, height * scale + padding) + 'px';
      output.textContent = (mode === 'fit' ? 'Fit: ' : '') + Math.round(scale * 100) + '%';
      if (keepCenter) {
        const after = svg.getBoundingClientRect();
        viewport.scrollLeft += after.left + cx * scale - frame.left - viewport.clientWidth / 2;
        viewport.scrollTop += after.top + cy * scale - frame.top - viewport.clientHeight / 2;
      } else { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    }
    function fit() {
      mode = 'fit';
      render(Math.min((viewport.clientWidth - 36) / width, (viewport.clientHeight - 36) / height, 1), false);
    }
    block.querySelectorAll('[data-action]').forEach(button => {
      button.disabled = false;
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'fit') { fit(); return; }
        mode = 'zoom';
        if (action === 'actual') {
          render(1, false);
          const first = svg.querySelector('.node[id*="startPoint-"]');
          if (first) {
            const node = first.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
            viewport.scrollLeft += node.left + node.width / 2 - frame.left - viewport.clientWidth / 2;
          }
        }
        else render(scale * (action === 'in' ? 1.5 : 1 / 1.5), true);
      });
    });
    let drag = null;
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = {x:event.clientX, y:event.clientY, left:viewport.scrollLeft, top:viewport.scrollTop};
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('dragging');
      event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag) return;
      viewport.scrollLeft = drag.left - event.clientX + drag.x;
      viewport.scrollTop = drag.top - event.clientY + drag.y;
    });
    function endDrag() { drag = null; viewport.classList.remove('dragging'); }
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('lostpointercapture', endDrag);
    charts.push(() => mode === 'fit' ? fit() : render(scale, false));
    fit();
  });
  document.querySelectorAll('[data-download]').forEach(button => {
    button.disabled = false;
    button.addEventListener('click', () => {
      const n = button.dataset.download;
      const source = document.getElementById('source-' + n).textContent;
      const file = ['01-revive-orders.mmd','02-usa-customers.mmd','03-customers-and-orders.mmd'][Number(n)-1];
      const url = URL.createObjectURL(new Blob([source], {type:'text/plain;charset=utf-8'}));
      const a = document.createElement('a'); a.href = url; a.download = file;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });
  let resized;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resized);
    resized = requestAnimationFrame(() => charts.forEach(resize => resize()));
  });
})();
'''

document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Three complete highlighted /chat Mermaid flowcharts with tools and Semantic, Procedural and Episodic Memory explanations.">
<title>/chat - Three complete Mermaid flowcharts</title><style>{CSS}</style></head>
<body><main class="document">
<header class="hero"><p class="eyebrow">ARCHITECTURE REFERENCE / 21 OCTOBER 2026</p>
<h1>/chat workflows<br>Three highlighted scenarios</h1>
<p class="lead">The same complete Mermaid charts from the PDF, with applied tools, memory context and expected outcomes.</p>
<p>Every diagram retains all 60 boxes and 78 connections. Highlights identify the path for each prompt.</p>
<nav class="jump-links" aria-label="Choose a scenario"><a href="#flow-1">01 - Procedure guidance</a><a href="#flow-2">02 - USA customers</a><a href="#flow-3">03 - Customers and orders</a></nav>
{legend}
<p class="small">Other branches remain visible. A highlighted memory search does not mean every type has a match. Initial, result and decline agent boxes represent the same logical agentModel at different points.</p>
<div class="shared"><h3>Memory scope and shared services</h3>
<p><b>Semantic:</b> organizationId + sessionId. A new session excludes old Semantic context; it does not require physical deletion. <b>Procedural and Episodic:</b> organizationId. <b>threadId:</b> checkpoint/resume state. <b>employeeId / userId:</b> request metadata; business data remains organization-scoped.</p>
<p class="small">All scenarios use the /chat API, graph state, PostgreSQL memory search and the checkpointer. recordEpisode summarizes and saves the outcome. These internal operations are separate from business tools.</p></div>
<details class="design-note"><summary>Design and implementation notes</summary>
<p>These charts describe the agreed target design. At the time of the PDF review, the branch had get_customers, create_customer and server_time. Session scope, the merged prompt/intent call, batch Semantic review, an active/status customer filter and an orders tool were still required. The existing eight-planning-turn cap could also limit large paginated fetches.</p>
<p>Memory examples are illustrative, not confirmed stored records. None of these three prompts requests a business write; write-review, Semantic-save and resume branches remain visible but inactive.</p></details>
</header>
{''.join(sections)}
<footer class="footer">Complete original Mermaid workflows. All charts and source text are included in this file; no internet connection is required.</footer>
</main><script>{JS}</script></body></html>'''

OUTPUT.write_text(document)
ids = re.findall(r'\bid="([^"]+)"', document)
# Only real id attributes are counted, not the SVG data-id metadata.
ids = re.findall(r'(?<![-\w])id="([^"]+)"', document)
assert len(ids) == len(set(ids)), 'Duplicate HTML/SVG IDs'
assert document.count('class="chart-block"') == 3
assert not re.search(r'<(?:script|link|img)[^>]+(?:src|href)="https?://', document)
print(json.dumps({'output':str(OUTPUT),'bytes':OUTPUT.stat().st_size,'uniqueIds':len(ids),'charts':3}))
