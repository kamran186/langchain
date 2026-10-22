from pathlib import Path
from xml.sax.saxutils import escape
import json

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from pypdf import PdfReader, PdfWriter


ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[2]
OUTPUT = PROJECT / 'output' / 'pdf' / 'chat-mermaid-flowcharts.pdf'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

for name, file in [('Arial', 'Arial.ttf'), ('Arial-Bold', 'Arial Bold.ttf'), ('Arial-Italic', 'Arial Italic.ttf')]:
    pdfmetrics.registerFont(TTFont(name, '/System/Library/Fonts/Supplemental/' + file))
pdfmetrics.registerFontFamily('Arial', normal='Arial', bold='Arial-Bold', italic='Arial-Italic')

NAVY = colors.HexColor('#172B48')
TEAL = colors.HexColor('#087E82')
INK = colors.HexColor('#253448')
MUTED = colors.HexColor('#536780')
PALE = colors.HexColor('#F1F5F9')
LINE = colors.HexColor('#DCE3EC')
AMBER = colors.HexColor('#FFF3BF')
ORANGE = colors.HexColor('#FFDFBA')

STYLES = {
    'body': ParagraphStyle('body', fontName='Arial', fontSize=9.6, leading=13.3, textColor=INK, spaceAfter=5),
    'small': ParagraphStyle('small', fontName='Arial', fontSize=8.5, leading=11.4, textColor=MUTED, spaceAfter=4),
    'table': ParagraphStyle('table', fontName='Arial', fontSize=9, leading=12.2, textColor=INK),
    'tableSmall': ParagraphStyle('tableSmall', fontName='Arial', fontSize=8.3, leading=11, textColor=INK),
    'label': ParagraphStyle('label', fontName='Arial-Bold', fontSize=8.1, leading=11.5, textColor=TEAL, spaceAfter=7),
    'title': ParagraphStyle('title', fontName='Arial-Bold', fontSize=24, leading=28, textColor=NAVY, spaceAfter=10),
    'subtitle': ParagraphStyle('subtitle', fontName='Arial', fontSize=11.3, leading=15.5, textColor=MUTED, spaceAfter=12),
    'section': ParagraphStyle('section', fontName='Arial-Bold', fontSize=11.1, leading=14.5, textColor=NAVY, spaceBefore=11, spaceAfter=6),
    'prompt': ParagraphStyle('prompt', fontName='Arial-Bold', fontSize=12, leading=16, textColor=NAVY),
    'white': ParagraphStyle('white', fontName='Arial-Bold', fontSize=8, leading=11, textColor=colors.white),
}


def p(text, style='body'):
    return Paragraph(text, STYLES[style])


def section(text):
    return p(text, 'section')


def table(rows, widths, header=False, font_style='table'):
    data = [[p(cell, 'white' if header and i == 0 else font_style) for cell in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=widths, hAlign='LEFT')
    commands = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 9),
        ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, LINE),
    ]
    if header:
        commands += [('BACKGROUND', (0, 0), (-1, 0), NAVY)]
    for i in range(1 if header else 0, len(rows)):
        if i % 2 == (1 if header else 0):
            commands += [('BACKGROUND', (0, i), (-1, i), PALE)]
    t.setStyle(TableStyle(commands))
    return t


def callout(title, body, fill=PALE):
    content = [p(title, 'prompt'), Spacer(1, 4), p(body)]
    t = Table([[content]], colWidths=[499])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), fill),
        ('BOX', (0, 0), (-1, -1), .6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return t


def footer(canvas, doc, page_num, label):
    w, h = A4
    canvas.saveState()
    canvas.setStrokeColor(TEAL)
    canvas.setLineWidth(2.5)
    canvas.line(48, h - 30, w - 48, h - 30)
    canvas.setFont('Arial', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(48, 28, '/CHAT WORKFLOWS  |  ' + label)
    canvas.drawRightString(w - 48, 28, f'{page_num} / 7')
    canvas.restoreState()


def build_page(filename, flowables, number, label):
    path = ROOT / filename
    doc = SimpleDocTemplate(str(path), pagesize=A4, rightMargin=48, leftMargin=48,
                            topMargin=48, bottomMargin=48, title='/chat workflows', author='Project architecture')
    doc.build(flowables, onFirstPage=lambda c, d: footer(c, d, number, label),
              onLaterPages=lambda c, d: footer(c, d, number, label))
    count = len(PdfReader(path).pages)
    if count != 1:
        raise RuntimeError(f'{filename} overflowed to {count} pages')
    return path


def overview():
    story = [
        p('ARCHITECTURE REFERENCE  /  21 OCTOBER 2026', 'label'),
        p('/chat workflows<br/>Three highlighted scenarios', 'title'),
        p('Complete flowcharts with applied tools, memory context and expected outcomes.', 'subtitle'),
        callout('How to read this document',
                'Each scenario has a one-page explanation followed by the <b>complete original workflow</b>. '
                'The diagrams are rendered directly from the same three Mermaid sources shared in chat. '
                'All nodes, labels, branches and scenario highlights are retained. '
                'Diagram pages use an oversized vector canvas. Zoom in to read the labels.'),
        section('Scenarios and page guide'),
        table([
            ['PROMPT', 'APPLIED BUSINESS TOOLS', 'PAGES'],
            ['<b>01 - Revive-order guidance</b><br/>How revive orders should be processed.', 'None; explain retrieved procedure.', '2-3'],
            ['<b>02 - USA customers</b><br/>Fetch all customers from USA.', 'get_customers<br/>Apply the illustrative active-only rule.', '4-5'],
            ['<b>03 - Customers and orders</b><br/>Fetch customers and their order details; apply appropriate rules.',
             'get_customers, then get_orders<br/>(orders tool is proposed).', '6-7'],
        ], [241, 207, 51], header=True),
        section('Highlight legend'),
        table([
            ['<b>Yellow</b> - boxes used by the prompt', '<b>Orange</b> - actual business tool execution'],
            ['<b>Green</b> - Start / Resume', '<b>Red</b> - Interrupt / End'],
        ], [249.5, 249.5]),
        p('Other boxes stay visible for context. A highlighted memory search does not mean every memory type has a match. '
          'Initial, result and decline agent boxes are views of the same logical agentModel, called when needed.', 'small'),
        section('Memory scope and shared services'),
        p('<b>Semantic:</b> organizationId + sessionId. A new session excludes old Semantic context; it does not require physical deletion. '
          '<b>Procedural and Episodic:</b> organizationId. <b>threadId:</b> identifies checkpoint/resume state. '
          '<b>employeeId / userId:</b> request metadata; business data remains organization-scoped.'),
        p('Every scenario uses the /chat API, graph state, PostgreSQL memory search and the checkpointer. '
          'recordEpisode summarizes and saves the outcome. These internal storage operations are separate from business tools.', 'small'),
        section('Design status'),
        p('These charts describe the agreed target design. The inspected branch currently has get_customers, '
          'create_customer and server_time. It still needs session scope, the merged prompt/intent call, batch Semantic review, '
          'an active/status customer filter, and an orders tool. The current eight-planning-turn cap can also limit large paginated fetches.', 'small'),
        p('Memory examples below are illustrative, not confirmed stored records. None of these three prompts requests a business write; '
          'the write-review, Semantic-save and resume branches remain visible but inactive.', 'small'),
    ]
    return build_page('overview.pdf', story, 1, 'READING GUIDE')


def flow_one():
    story = [
        p('SCENARIO 01  /  GUIDANCE FROM MEMORY', 'label'),
        p('Explain the stored procedure', 'title'),
        callout('User prompt', 'How revive orders should be processed.'),
        section('Intent and applied tools'),
        p('<b>Intent:</b> task / question. Explain the relevant stored procedure. This wording does not authorize creating, '
          'updating or reviving an order.'),
        table([
            ['COMPONENT', 'WHAT IS APPLIED'],
            ['<b>Business tools</b>', 'None. The agent returns calls = [] when the procedure can be explained from available context.'],
            ['<b>Internal services</b>', 'Memory search, registry/catalog lookup, LLM planning, Postgres checkpoints and recordEpisode. '
             'Tool selection can return an empty tool list.'],
        ], [121, 378], header=True),
        section('Applied memories'),
        table([
            ['TYPE', 'ROLE FOR THIS PROMPT'],
            ['<b>Procedural</b><br/>Primary', 'Organization-scoped instructions for revive-order eligibility, required checks, processing sequence '
             'and exceptions - only when those rules are actually retrieved.'],
            ['<b>Semantic</b><br/>Optional', 'Relevant facts or preferences from the current organization + session. If none match, use []. '
             'A fact cannot supply a missing operating procedure.'],
            ['<b>Episodic</b><br/>Optional', 'Past steps, resolved ambiguity and outcomes may help interpretation. Verify relevance; '
             'they do not replace current Procedural rules.'],
        ], [121, 378], header=True),
        section('Highlighted execution path'),
        p('<b>1.</b> Parse /chat context and load the matching checkpoint.<br/>'
          '<b>2.</b> Prepare the prompt and intent in one target-design LLM call.<br/>'
          '<b>3.</b> Search all three memory types independently; assemble available results.<br/>'
          '<b>4.</b> Select tools, resolve definitions and prepare the initial agent input.<br/>'
          '<b>5.</b> agentModel explains the procedure with calls = []; compose the response.<br/>'
          '<b>6.</b> Record the episode and return status: completed, sessionId, threadId and response.'),
        section('Expected result and missing-memory behavior'),
        p('Return an explanation grounded in the retrieved instructions. If the procedure is absent, incomplete or conflicting, '
          'state the limitation and ask for the missing rule instead of inventing processing steps.'),
        p('<b>No business write or approval interrupt.</b> Checkpoint persistence and episode storage still occur internally.', 'small'),
        Spacer(1, 6),
        p('NEXT PAGE  -  Complete original chart. Yellow follows the guidance route; no orange execution box is active.', 'label'),
    ]
    return build_page('flow-1-summary.pdf', story, 2, 'SCENARIO 01 - SUMMARY')


def flow_two():
    story = [
        p('SCENARIO 02  /  TOOL + MEMORY', 'label'),
        p('Fetch all USA customers', 'title'),
        callout('User prompt', 'Fetch all customers from USA.'),
        section('Intent and applied tools'),
        p('<b>Intent:</b> task / question. The prompt supplies country = USA. For this example, a retrieved Procedural rule '
          'adds the condition: <b>include only active customers</b>.'),
        table([
            ['TOOL / INPUT', 'EXECUTION'],
            ['<b>get_customers</b><br/>Read', 'Organization-scoped customer lookup with country plus the active-only condition. '
             'Use limit/offset pagination until every matching page has been retrieved.'],
            ['<b>Request context</b>', 'organizationId scopes the query; employeeId and userId remain metadata. '
             'The country value must match the database vocabulary or an explicit alias mapping.'],
        ], [121, 378], header=True),
        section('Applied memories'),
        table([
            ['TYPE', 'ROLE FOR THIS PROMPT'],
            ['<b>Procedural</b><br/>Applied example', 'Illustrative stored rule: "When fetching customers, include only active customers." '
             'This is a rule, so it belongs in Procedural Memory.'],
            ['<b>Semantic</b><br/>Optional', 'Relevant current-session facts/preferences, if present. No Semantic fact is required to infer USA; '
             'it is already in the prompt. Otherwise use [].'],
            ['<b>Episodic</b><br/>Optional', 'Prior successful query steps may advise execution. A past episode cannot establish whether a customer '
             'is active now; the business database must provide that value.'],
        ], [121, 378], header=True),
        section('Highlighted execution path'),
        p('Request/context -> prepare prompt + intent -> parallel memory search -> select get_customers -> resolve schema -> '
          'initial agent -> authorize read -> <b>executeRegisteredTools</b> -> PostgreSQL -> append actual rows -> '
          'agent reads results -> further pages when needed -> compose response -> recordEpisode -> completed.'),
        p('The return loop lets the agent use actual rows and decide whether more pages are required. Completed, unchanged reads '
          'must not be repeated. "All" is valid only after pagination is exhausted.', 'small'),
        section('Current prerequisites and response'),
        p('<b>Required addition:</b> the current Customer schema has no active/status field or filter. '
          'Until this is added, report the limitation; unfiltered customers do not satisfy the active-only rule. '
          'Country filtering also does not normalize USA / United States automatically.'),
        p('Return matching rows as structured results plus a readable summary. Zero matches is a successful result with customers: []. '
          'If retrieval stops early or fails, identify partial results instead of claiming completeness.', 'small'),
        Spacer(1, 5),
        p('NEXT PAGE  -  Complete original chart. Orange identifies actual get_customers execution; the read loop may repeat for pagination.', 'label'),
    ]
    return build_page('flow-2-summary.pdf', story, 4, 'SCENARIO 02 - SUMMARY')


def flow_three():
    story = [
        p('SCENARIO 03  /  MULTIPLE TOOLS + MULTIPLE MEMORIES', 'label'),
        p('Fetch customers and their orders', 'title'),
        callout('User prompt', 'Fetch customers and their order details; make sure to apply appropriate rules.'),
        section('Intent and applied tools'),
        table([
            ['TOOL', 'INPUT AND OUTPUT DEPENDENCY'],
            ['<b>1. get_customers</b><br/>Existing read tool', 'Apply the request and retrieved rules; scope to organizationId. '
             'Retrieve every matching customer page and collect actual customer IDs.'],
            ['<b>2. get_orders</b><br/>Proposed read tool', 'Receive the actual customer IDs plus organization scope and applicable order filters. '
             'Return associated order details; paginate when needed. Batch IDs where supported.'],
        ], [121, 378], header=True),
        p('get_orders must be registered with a schema, access/effect metadata and an organization-scoped handler. '
          'This capability is not present in the inspected branch.', 'small'),
        section('Applied memories'),
        table([
            ['TYPE', 'ROLE FOR THIS PROMPT'],
            ['<b>Semantic</b>', 'Relevant facts/preferences for this organization + session, such as a current-session customer focus '
             'or output preference. Never restore Semantic facts from an earlier session.'],
            ['<b>Procedural</b>', 'Organization-scoped customer and order handling rules. Apply only retrieved, relevant rules. '
             'For example, an active-only restriction requires the corresponding supported database field/filter.'],
            ['<b>Episodic</b>', 'Advisory prior steps and outcomes, such as fetching customer IDs before associated orders. '
             'Verify against the current request, schemas and live results.'],
        ], [121, 378], header=True),
        section('Highlighted execution path'),
        p('<b>1.</b> Prepare the request, retrieve memories, select both tools and resolve their definitions.<br/>'
          '<b>2.</b> Initial agent proposes get_customers; authorize and execute the read.<br/>'
          '<b>3.</b> Append actual customer results. The result agent uses returned IDs to propose get_orders.<br/>'
          '<b>4.</b> Authorize and execute order reads. Continue any required customer/order pagination.<br/>'
          '<b>5.</b> Combine customers with their orders; preserve structured results, record the episode and complete.'),
        p('The same orange executeRegisteredTools box handles both tool names on separate passes. '
          'The initial and result agent boxes represent the same logical agentModel at different times.', 'small'),
        section('Response and empty results'),
        p('<b>No customers:</b> return a successful empty customer result and skip get_orders. '
          '<b>Customer with no orders:</b> retain that customer with orders: []. '
          '<b>Tool failure:</b> distinguish missing data from retrieval failure and label partial results accurately.'),
        p('Illustrative response shape: customers: [{ id, name, orders: [...] }]. '
          'No customer IDs or business rules are fabricated. No business write approval is needed.', 'small'),
        Spacer(1, 5),
        p('NEXT PAGE  -  Complete original chart. All three memory-context branches and the dependent read loop are highlighted.', 'label'),
    ]
    return build_page('flow-3-summary.pdf', story, 6, 'SCENARIO 03 - SUMMARY')


def main():
    summaries = [overview(), flow_one(), flow_two(), flow_three()]
    ordered = [summaries[0], summaries[1], ROOT / 'flow-1-chart.pdf', summaries[2], ROOT / 'flow-2-chart.pdf',
               summaries[3], ROOT / 'flow-3-chart.pdf']
    labels = ['Overview', '01 - Procedure guidance', '01 - Complete highlighted flowchart',
              '02 - USA customers', '02 - Complete highlighted flowchart',
              '03 - Customers and orders', '03 - Complete highlighted flowchart']
    writer = PdfWriter()
    for i, path in enumerate(ordered):
        reader = PdfReader(path)
        if len(reader.pages) != 1:
            raise RuntimeError(f'Expected one page in {path}')
        writer.add_page(reader.pages[0])
        writer.add_outline_item(labels[i], i)
    writer.add_metadata({'/Title': '/chat - Three complete highlighted workflows', '/Author': 'Project architecture',
                         '/Subject': 'Applied tools, Semantic, Procedural and Episodic Memory for three prompts',
                         '/Keywords': 'LangGraph, chat, flowchart, tools, memory, customers, orders'})
    writer.page_mode = '/UseOutlines'
    with OUTPUT.open('wb') as f:
        writer.write(f)
    print(json.dumps({'output': str(OUTPUT), 'pages': len(writer.pages), 'bytes': OUTPUT.stat().st_size}, indent=2))


if __name__ == '__main__':
    main()
