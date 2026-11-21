import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakePhone, makeTestCert, sha256 } from './helpers/FakePhone.mjs';

const require = createRequire(import.meta.url);
const { FileRules } = require('../main/receiver/FileRules.js');
const { ReceiverServer } = require('../main/receiver/ReceiverServer.js');
const { PairingManager } = require('../main/receiver/PairingManager.js');
const { FileSink } = require('../main/receiver/FileSink.js');
const { UploadLedger } = require('../main/receiver/UploadLedger.js');

const rules = new FileRules();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-rules-'));

let cert;
before(async () => { cert = await makeTestCert(); });

test('documents, images and links are accepted, whatever the letter case', () => {
  for (const name of [
    'notes.pdf', 'Essay.DOCX', 'slides.pptx', 'data.xlsx', 'read me.txt', 'a.md', 'sheet.csv', 'book.epub',
    'photo.jpg', 'PHOTO.JPEG', 'screenshot.png', 'scan.TIFF', 'IMG_2031.HEIC', 'pic.webp', 'wall.avif',
    'Course page.url', 'name with spaces and (1).pdf',
  ]) assert.equal(rules.allows(name), true, name);
});

test('programs, scripts, installers, archives, web pages and files with no type are refused', () => {
  for (const name of [
    'setup.exe', 'app.apk', 'tool.msi', 'run.bat', 'run.cmd', 'x.ps1', 'x.vbs', 'x.js', 'x.jar', 'x.scr', 'x.com', 'x.dll', 'x.lnk',
    'x.sh', 'x.py', 'x.apks', 'x.aab', 'x.dmg', 'x.zip', 'x.rar', '7z.7z', 'x.iso', 'page.html', 'page.htm', 'x.hta',
    'drawing.svg', 'x.docm', 'x.xlsm', 'x.pptm', 'README', '.hidden', '', 'x.', 'noextension',
  ]) assert.equal(rules.allows(name), false, JSON.stringify(name));
});

test('the usual disguises do not work: the name is judged as it will really be stored', () => {
  for (const name of [
    'invoice.pdf.exe',        // double extension: the real one is last
    'a.exe.',                 // Windows ignores a trailing dot
    'a.exe   ',               // ...and trailing spaces
    'a.pdf:evil.exe',         // "alternate data stream" style name
    '..\\..\\Windows\\evil.exe', '../../evil.exe',
    'photo.png\u202Eexe',     // right-to-left override characters
    'a.pdf\u0000.exe',        // a hidden null before the real type
    'a.PDF.Bat',
  ]) assert.equal(rules.allows(name), false, JSON.stringify(name));
  // ...and a safe type that merely contains a risky word is fine.
  assert.equal(rules.allows('exe notes.pdf'), true);
  assert.equal(rules.allows('apk.docx'), true);
});

test('extensions lists every accepted type once, sorted, without dots', () => {
  const list = rules.extensions;
  assert.deepEqual(list, [...new Set(list)].sort());
  assert.ok(list.every((e) => /^[a-z0-9]+$/.test(e)));
  assert.equal(new FileRules({ groups: { only: ['PDF'] } }).allows('a.pdf'), true);
  assert.equal(new FileRules({ groups: { only: ['PDF'] } }).allows('a.png'), false);
});

test('link files: only web addresses; anything that could start a local program is refused', () => {
  const dir = tmpDir();
  const put = (text) => { const f = path.join(dir, `l${Math.random()}.url`); fs.writeFileSync(f, text); return f; };
  const ok = (text) => rules.contentOk(put(text), 'l.url');

  assert.equal(ok('[InternetShortcut]\r\nURL=https://example.com/lesson?id=3\r\n'), true);
  assert.equal(ok('[InternetShortcut]\nURL=http://example.com\nIconIndex=0\n'), true);
  assert.equal(ok('[InternetShortcut]\nurl = HTTPS://example.com'), true);
  for (const bad of [
    '[InternetShortcut]\nURL=file:///C:/Windows/System32/calc.exe\n',
    '[InternetShortcut]\nURL=C:\\Windows\\System32\\calc.exe\n',
    '[InternetShortcut]\nURL=\\\\server\\share\\x.exe\n',
    '[InternetShortcut]\nURL=ms-msdt:/id PCWDiagnostic\n',
    '[InternetShortcut]\nURL=javascript:alert(1)\n',
    '[InternetShortcut]\nURL=https://example.com\nURL=file:///C:/x.exe\n', // a second, hidden address
    '[InternetShortcut]\n', '', 'just some text',
    `[InternetShortcut]\nURL=https://example.com/${'a'.repeat(20000)}\n`,   // far too long to be a real link
  ]) assert.equal(ok(bad), false, bad.slice(0, 50));
  assert.equal(rules.contentOk(path.join(dir, 'missing.url'), 'missing.url'), false);
  assert.equal(rules.contentOk(put('anything'), 'photo.png'), true);          // other types are not read
});

// ── On the wire ─────────────────────────────────────────────────────────────

async function setup(options = {}) {
  const dir = tmpDir();
  const pairing = new PairingManager();
  const server = new ReceiverServer({
    tls: cert, pairing, sink: new FileSink(path.join(dir, 'received')), ledger: new UploadLedger(),
    name: 'TEST-PC', version: '0.1.0', isReceiving: () => true, ...options,
  });
  const port = await server.listen(0, '127.0.0.1');
  const { id, token } = pairing.startPairing();
  pairing.authenticate(token); pairing.approve(id);
  const receivedDir = path.join(dir, 'received');
  return {
    phone: new FakePhone({ port, token, fp: cert.fp }), stop: () => server.close(), server,
    stored: () => (fs.existsSync(receivedDir) ? fs.readdirSync(receivedDir).filter((f) => f !== '.partial') : []),
  };
}

test('an upload of a refused type gets 422 unsupported-type and nothing is kept', async (t) => {
  const s = await setup(); t.after(s.stop);
  const received = [];
  s.server.on('received', (r) => received.push(r));
  const bytes = Buffer.from('MZ pretend program');
  for (const name of ['setup.exe', 'app.apk', 'invoice.pdf.exe', 'a.exe.', 'README', 'page.html', 'x.zip']) {
    const r = await s.phone.upload(bytes, { name });
    assert.deepEqual([r.status, r.json.error], [422, 'unsupported-type'], name);
  }
  assert.deepEqual(s.stored(), []);
  assert.deepEqual(received, []);
});

test('the type is refused before the file is read, so even a huge .exe costs nothing', async (t) => {
  const s = await setup({ maxBytes: 1024 * 1024 * 1024 }); t.after(s.stop);
  const r = await s.phone.upload(Buffer.alloc(300 * 1024, 1), { name: 'big.exe' });
  assert.deepEqual([r.status, r.json.error], [422, 'unsupported-type']);
});

test('accepted types are stored as before: a document, an image and a link', async (t) => {
  const s = await setup(); t.after(s.stop);
  const link = Buffer.from('[InternetShortcut]\r\nURL=https://example.com/lesson\r\n');
  for (const [name, bytes] of [['Essay.docx', Buffer.from('doc')], ['whiteboard.PNG', Buffer.from('img')], ['Lesson.url', link]]) {
    const r = await s.phone.upload(bytes, { name });
    assert.equal(r.status, 201, name);
    assert.equal(r.json.sha256, sha256(bytes));
  }
  assert.deepEqual(s.stored().sort(), ['Essay.docx', 'Lesson.url', 'whiteboard.PNG']);
});

test('a link file that points at a local program is refused after it arrives and is deleted', async (t) => {
  const s = await setup(); t.after(s.stop);
  const evil = Buffer.from('[InternetShortcut]\r\nURL=file:///C:/Windows/System32/calc.exe\r\n');
  const r = await s.phone.upload(evil, { name: 'Lesson.url' });
  assert.deepEqual([r.status, r.json.error], [422, 'unsupported-type']);
  assert.deepEqual(s.stored(), []);
  // and it is not remembered as received: the same id can be used again with a proper link
  const again = await s.phone.upload(Buffer.from('[InternetShortcut]\nURL=https://example.com\n'), { name: 'Lesson.url' });
  assert.equal(again.status, 201);
});

test('a retry of an upload that was accepted still gets 200, whatever the rules say now', async (t) => {
  const s = await setup(); t.after(s.stop);
  const bytes = Buffer.from('hello');
  const uploadId = '3f1c1e0e-8f6b-4c53-9d0a-2b1f6f7a9c11';
  const first = await s.phone.upload(bytes, { uploadId, name: 'a.pdf' });
  s.server.rules = new FileRules({ groups: { none: ['zzz'] } });             // rules tighten later
  const again = await s.phone.upload(bytes, { uploadId, name: 'a.pdf' });
  assert.deepEqual([first.status, again.status], [201, 200]);
});

test('the same rule covers files sent to a folder', async (t) => {
  const items = { request: async (op) => (op === 'destination-exists' ? { status: 200, body: { exists: true } } : { status: 200, body: {} }) };
  const s = await setup({ items }); t.after(s.stop);
  const bad = await s.phone.upload(Buffer.from('x'), { name: 'tool.exe', headers: { 'X-Dest-Id': 'folder:csc' } });
  assert.deepEqual([bad.status, bad.json.error], [422, 'unsupported-type']);
  const good = await s.phone.upload(Buffer.from('x'), { name: 'diagram.png', headers: { 'X-Dest-Id': 'folder:csc' } });
  assert.equal(good.status, 201);
});

test('a refused type is a plain 422 for the phone: not retried, with the reason in the body', async (t) => {
  const s = await setup(); t.after(s.stop);
  const r = await s.phone.upload(Buffer.from('x'), { name: 'a.apk' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'unsupported-type');
});
