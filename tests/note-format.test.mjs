import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toBlocks, fromBlocks, toPlainText, fromPlainText, checklistStats, mergeRuns, emptyDoc,
} from '../renderer/modules/workspace/editor/NoteFormat.js';

const p = (text, marks = []) => [{ text, marks }];

test('blocks -> Tiptap JSON: nested bullets and checklists become nested lists', () => {
  const doc = fromBlocks([
    { type: 'heading1', indent: 0, inline: p('Groceries') },
    { type: 'task', indent: 0, checked: true, inline: p('Milk') },
    { type: 'task', indent: 1, checked: false, inline: p('Oat milk') },
    { type: 'task', indent: 0, checked: false, inline: p('Bread') },
    { type: 'paragraph', indent: 0, inline: [{ text: 'Bold', marks: ['bold'] }, { text: ' text', marks: [] }] },
  ]);
  assert.deepEqual(doc.content[0], { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Groceries' }] });
  const list = doc.content[1];
  assert.equal(list.type, 'taskList');
  assert.equal(list.content.length, 2);
  assert.equal(list.content[0].attrs.checked, true);
  assert.equal(list.content[0].content[1].type, 'taskList');           // Oat milk nested under Milk
  assert.equal(list.content[0].content[1].content[0].content[0].content[0].text, 'Oat milk');
  assert.deepEqual(doc.content[2].content[0], { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] });
});

test('round trip blocks -> JSON -> blocks keeps types, indents, ticks and marks', () => {
  const blocks = [
    { type: 'bullet', indent: 0, checked: false, inline: p('Week 1') },
    { type: 'bullet', indent: 1, checked: false, inline: p('Loops') },
    { type: 'bullet', indent: 2, checked: false, inline: [{ text: 'for', marks: ['bold', 'italic'] }] },
    { type: 'task', indent: 1, checked: true, inline: p('Exercise 1') },
    { type: 'bullet', indent: 0, checked: false, inline: p('Week 2') },
    { type: 'heading2', indent: 0, checked: false, inline: p('Notes') },
    { type: 'paragraph', indent: 0, checked: false, inline: p('line one\nline two') },
  ];
  assert.deepEqual(toBlocks(fromBlocks(blocks)), blocks);
});

test('links are saved as Tiptap link marks and read back', () => {
  const inline = [{ text: 'See ', marks: [] }, { text: 'the syllabus', marks: ['bold'], href: 'https://uni.example/csc101' }];
  const doc = fromBlocks([{ type: 'paragraph', indent: 0, checked: false, inline }]);
  assert.deepEqual(doc.content[0].content[1].marks, [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://uni.example/csc101' } }]);
  assert.deepEqual(toBlocks(doc)[0].inline, inline);
});

test('indents are tidied: no jumping more than one level, plain lines have none', () => {
  const doc = fromBlocks([
    { type: 'bullet', indent: 3, inline: p('a') },
    { type: 'bullet', indent: 5, inline: p('b') },
    { type: 'paragraph', indent: 2, inline: p('c') },
  ]);
  assert.deepEqual(toBlocks(doc).map((b) => b.indent), [0, 1, 0]);
});

test('unknown nodes (e.g. a future table) are kept untouched', () => {
  const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A1' }] }] }] }] };
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }, table] };
  assert.deepEqual(fromBlocks(toBlocks(doc)), doc);
  assert.match(toPlainText(doc), /A1/);
});

test('old plain-text notes convert: bullets, checklists, headings, indents', () => {
  const doc = fromPlainText('# Shopping\n- fruit\n  - apples\n[x] milk\n[ ] eggs\nremember the bags');
  const blocks = toBlocks(doc);
  assert.deepEqual(blocks.map((b) => [b.type, b.indent]), [
    ['heading1', 0], ['bullet', 0], ['bullet', 1], ['task', 0], ['task', 0], ['paragraph', 0],
  ]);
  assert.equal(blocks[3].checked, true);
  assert.deepEqual(checklistStats(doc), { done: 1, total: 2 });
});

test('plain text keeps list markers and reads back the same', () => {
  const text = 'Groceries\n- fruit\n  - apples\n[x] milk\n[ ] eggs';
  assert.equal(toPlainText(fromPlainText(text)), text);
});

test('empty notes and merging of runs', () => {
  assert.deepEqual(toBlocks(emptyDoc()), [{ type: 'paragraph', indent: 0, checked: false, inline: [] }]);
  assert.deepEqual(fromPlainText(''), emptyDoc());
  assert.deepEqual(mergeRuns([{ text: 'a', marks: ['bold'] }, { text: 'b', marks: ['bold'] }, { text: '', marks: [] }]),
    [{ text: 'ab', marks: ['bold'] }]);
  assert.deepEqual(checklistStats(null), { done: 0, total: 0 });
});
