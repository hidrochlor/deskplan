// The note editor's shortcuts, for the list in Settings › About (RichEditor.js handles the keys).
// Chosen to match common apps: Google Docs for lists and headings, Word / Docs for links, Notion for "/".
export const EDITOR_SHORTCUTS = [
  ['Ctrl + B / I', 'Bold / italic'],
  ['Ctrl + Shift + X', 'Strikethrough'],
  ['Ctrl + K', 'Link the selected words'],
  ['Ctrl + click', 'Open a link'],
  ['Ctrl + Alt + 1 / 2', 'Heading 1 / Heading 2'],
  ['Ctrl + Alt + 0', 'Normal text'],
  ['Ctrl + Shift + 8', 'Bulleted list'],
  ['Ctrl + Shift + 9', 'Checklist'],
  ['Ctrl + Enter', 'Tick / untick a checklist item'],
  ['Tab / Shift + Tab', 'Indent / outdent a list item'],
  ['/', 'On an empty line: choose what to add'],
  ['- ', 'Start a bulleted list'],
  ['[] ', 'Start a checklist ([x] for ticked)'],
  ['# / ## ', 'Heading 1 / Heading 2'],
];
