import { ItemTree } from '../../renderer/modules/workspace/ItemTree.js';
import { fromPlainText, toPlainText } from '../../renderer/modules/workspace/editor/NoteFormat.js';

// What the workspace module offers the phone sync through the registry ('itemRules'): the rules for an items collection.
export const rulesFor = (items) => new ItemTree(items).rules;

// ...and 'noteFormat': a note's formatted text as plain text and back.
export const noteText = { toPlainText, fromPlainText };
