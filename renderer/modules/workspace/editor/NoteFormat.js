// How notes are saved. Pure functions, no DOM, so they are easy to test.
//
// Notes are stored as Tiptap / ProseMirror JSON:
//   { type: 'doc', content: [ paragraph | heading | bulletList | taskList | (anything else, kept as is) ] }
// so a later switch to the Tiptap editor needs no data conversion.
//
// The editor itself works with a flat list of "blocks", one per line:
//   { type: 'paragraph' | 'heading1' | 'heading2' | 'bullet' | 'task', indent, checked, inline }
//   inline = [{ text, marks: ['bold' | 'italic' | 'strike'], href? }]   ('\n' inside text = line break,
//            href = the text is a link; saved as Tiptap's `link` mark)
// Nested lists in the JSON become `indent` levels on flat blocks, and back.

export const MAX_INDENT = 6;
export const MARKS = ['bold', 'italic', 'strike'];
const LIST_KIND = { bullet: 'bulletList', task: 'taskList' };

export const isListBlock = (b) => b.type === 'bullet' || b.type === 'task';

export function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ── Inline text ─────────────────────────────────────────────────────────────

function runsFromNodes(nodes = []) {
  const runs = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      const marks = n.marks ?? [];
      const href = marks.find((m) => m.type === 'link')?.attrs?.href;
      runs.push({ text: n.text ?? '', marks: marks.map((m) => m.type).filter((m) => MARKS.includes(m)), ...(href ? { href } : {}) });
    } else if (n.type === 'hardBreak') runs.push({ text: '\n', marks: [] });
  }
  return mergeRuns(runs);
}

function nodesFromRuns(runs = []) {
  const nodes = [];
  for (const r of mergeRuns(runs)) {
    const list = r.marks.map((type) => ({ type }));
    if (r.href) list.push({ type: 'link', attrs: { href: r.href } });
    const marks = list.length ? list : undefined;
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) nodes.push({ type: 'hardBreak' });
      if (part) nodes.push(marks ? { type: 'text', text: part, marks } : { type: 'text', text: part });
    });
  }
  return nodes;
}

/** Join neighbouring runs with the same marks and link; drop empty ones. Marks are kept in a fixed order. */
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const marks = MARKS.filter((m) => r.marks?.includes(m));
    const last = out[out.length - 1];
    if (last && last.marks.join() === marks.join() && last.href === r.href) last.text += r.text;
    else out.push(r.href ? { text: r.text, marks, href: r.href } : { text: r.text, marks });
  }
  return out;
}

export const inlineText = (inline = []) => inline.map((r) => r.text).join('');

// ── Doc JSON → blocks ───────────────────────────────────────────────────────

const isTextNode = (n) => n && (n.type === 'paragraph' || n.type === 'heading');

export function toBlocks(doc) {
  const out = [];
  for (const node of doc?.content ?? []) addNode(node, out);
  return out.length ? out : [{ type: 'paragraph', indent: 0, checked: false, inline: [] }];
}

function addNode(node, out) {
  switch (node.type) {
    case 'paragraph':
      out.push(block('paragraph', 0, false, runsFromNodes(node.content)));
      break;
    case 'heading':
      out.push(block((node.attrs?.level ?? 1) <= 1 ? 'heading1' : 'heading2', 0, false, runsFromNodes(node.content)));
      break;
    case 'bulletList': case 'orderedList': case 'taskList':
      addList(node, 0, out);
      break;
    case 'blockquote':
      for (const child of node.content ?? []) addNode(child, out);
      break;
    default:
      out.push({ type: 'raw', node }); // e.g. a table made by a later editor: kept untouched
  }
}

function addList(list, depth, out) {
  const type = list.type === 'taskList' ? 'task' : 'bullet';
  for (const item of list.content ?? []) {
    const [first, ...rest] = item.content ?? [];
    const own = isTextNode(first) ? first : null;
    out.push(block(type, Math.min(depth, MAX_INDENT), !!item.attrs?.checked, runsFromNodes(own?.content)));
    for (const child of own ? rest : item.content ?? []) {
      if (/List$/.test(child.type)) addList(child, depth + 1, out);
      else if (isTextNode(child)) out.push(block(type, Math.min(depth + 1, MAX_INDENT), false, runsFromNodes(child.content)));
    }
  }
}

function block(type, indent, checked, inline) {
  return { type, indent, checked, inline };
}

// ── Blocks → doc JSON ───────────────────────────────────────────────────────

export function fromBlocks(blocks) {
  const norm = normalizeIndents(blocks);
  const content = [];
  let i = 0;
  while (i < norm.length) {
    const b = norm[i];
    if (isListBlock(b)) {
      const [list, next] = buildList(norm, i, 0);
      content.push(list);
      i = next;
      continue;
    }
    if (b.type === 'raw') content.push(b.node);
    else if (b.type === 'heading1' || b.type === 'heading2') content.push(textNode('heading', b.inline, { level: b.type === 'heading1' ? 1 : 2 }));
    else content.push(textNode('paragraph', b.inline));
    i += 1;
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** A list item can be at most one level deeper than the item above it; non-list lines reset to 0. */
function normalizeIndents(blocks) {
  let prev = -1;
  return blocks.map((b) => {
    if (!isListBlock(b)) { prev = -1; return { ...b, indent: 0 }; }
    const indent = Math.max(0, Math.min(b.indent ?? 0, prev + 1, MAX_INDENT));
    prev = indent;
    return { ...b, indent };
  });
}

function buildList(blocks, i, depth) {
  const kind = LIST_KIND[blocks[i].type];
  const items = [];
  while (i < blocks.length && isListBlock(blocks[i]) && blocks[i].indent >= depth) {
    const b = blocks[i];
    if (b.indent > depth) {
      const [sub, next] = buildList(blocks, i, depth + 1);
      items[items.length - 1].content.push(sub);
      i = next;
      continue;
    }
    if (LIST_KIND[b.type] !== kind) break; // a different kind of list starts here
    items.push(b.type === 'task'
      ? { type: 'taskItem', attrs: { checked: !!b.checked }, content: [textNode('paragraph', b.inline)] }
      : { type: 'listItem', content: [textNode('paragraph', b.inline)] });
    i += 1;
  }
  return [{ type: kind, content: items }, i];
}

function textNode(type, inline, attrs) {
  const node = { type };
  if (attrs) node.attrs = attrs;
  const content = nodesFromRuns(inline);
  if (content.length) node.content = content;
  return node;
}

// ── Plain text (search, previews, word count, old notes) ────────────────────

/** Readable plain text. Lists keep "- " / "[x] " markers so fromPlainText can read it back. */
export function toPlainText(doc) {
  return toBlocks(doc).map((b) => {
    if (b.type === 'raw') return rawText(b.node);
    const text = inlineText(b.inline);
    const pad = '  '.repeat(b.indent ?? 0);
    if (b.type === 'bullet') return `${pad}- ${text}`;
    if (b.type === 'task') return `${pad}[${b.checked ? 'x' : ' '}] ${text}`;
    return text;
  }).join('\n');
}

function rawText(node) {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(rawText).join(node.type === 'tableRow' ? ' | ' : node.content?.[0]?.type === 'text' ? '' : '\n');
}

/** Old plain-text notes, or pasted text: "- " bullets, "[ ]" / "[x]" checklists, "# " headings. */
export function fromPlainText(text = '') {
  const blocks = String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const indent = (spaces) => Math.min(Math.floor(spaces.replace(/\t/g, '  ').length / 2), MAX_INDENT);
    let m;
    if ((m = line.match(/^(\s*)\[( |x|X)?\]\s?(.*)$/))) return block('task', indent(m[1]), /x/i.test(m[2] ?? ''), plain(m[3]));
    if ((m = line.match(/^(\s*)[-*•]\s+(.*)$/))) return block('bullet', indent(m[1]), false, plain(m[2]));
    if ((m = line.match(/^##+\s+(.*)$/))) return block('heading2', 0, false, plain(m[1]));
    if ((m = line.match(/^#\s+(.*)$/))) return block('heading1', 0, false, plain(m[1]));
    return block('paragraph', 0, false, plain(line));
  });
  return fromBlocks(blocks);
}

const plain = (text) => (text ? [{ text, marks: [] }] : []);

/** Ticked / total checklist items in a note. */
export function checklistStats(doc) {
  if (!doc) return { done: 0, total: 0 };
  const tasks = toBlocks(doc).filter((b) => b.type === 'task');
  return { done: tasks.filter((b) => b.checked).length, total: tasks.length };
}
