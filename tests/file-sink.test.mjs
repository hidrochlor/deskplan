import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const { FileSink } = createRequire(import.meta.url)('../main/receiver/FileSink.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-sink-'));

test('cleanName removes path parts, "..", forbidden characters and reserved names', () => {
  assert.equal(FileSink.cleanName('..\\..\\Windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(FileSink.cleanName('../../etc/passwd'), 'passwd');
  assert.equal(FileSink.cleanName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
  assert.equal(FileSink.cleanName('CON.txt'), '_CON.txt');
  assert.equal(FileSink.cleanName('nul'), '_nul');
  assert.equal(FileSink.cleanName('report...pdf'), 'report.pdf');
  assert.equal(FileSink.cleanName('name. . '), 'name');
  assert.equal(FileSink.cleanName(''), 'file');
  assert.equal(FileSink.cleanName('..'), 'file');
  assert.equal(FileSink.cleanName(null), 'file');
});

test('cleanName limits the length but keeps the extension', () => {
  const out = FileSink.cleanName(`${'x'.repeat(400)}.pdf`);
  assert.ok(out.length <= 150);
  assert.ok(out.endsWith('.pdf'));
});

test('write stores the file once the checksum matches', async () => {
  const dir = tmpDir();
  const bytes = Buffer.from('hello received files');
  const res = await new FileSink(dir).write(Readable.from([bytes]), { name: 'a.txt', sha256: sha(bytes) });
  assert.deepEqual(res, { storedAs: 'a.txt', size: bytes.length, sha256: sha(bytes) });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello received files');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), []); // no temp file left
});

test('a taken name becomes "name (1).ext", then "(2)"', async () => {
  const dir = tmpDir();
  const sink = new FileSink(dir);
  const names = [];
  for (const text of ['one', 'two', 'three']) {
    const bytes = Buffer.from(text);
    names.push((await sink.write(Readable.from([bytes]), { name: 'a.txt', sha256: sha(bytes) })).storedAs);
  }
  assert.deepEqual(names, ['a.txt', 'a (1).txt', 'a (2).txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one'); // never overwritten
});

test('a checksum mismatch is rejected and nothing is kept', async () => {
  const dir = tmpDir();
  await assert.rejects(
    new FileSink(dir).write(Readable.from([Buffer.from('data')]), { name: 'a.txt', sha256: 'deadbeef' }),
    { code: 'CHECKSUM' });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.partial'), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), []);
});

test('a file over the limit is rejected and nothing is kept', async () => {
  const dir = tmpDir();
  const bytes = Buffer.alloc(2048, 1);
  await assert.rejects(
    new FileSink(dir, { maxBytes: 1024 }).write(Readable.from([bytes]), { name: 'big.bin', sha256: sha(bytes) }),
    { code: 'TOO_LARGE' });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.partial'), []);
});

test('a path-trick name is stored inside the Received files folder only', async () => {
  const dir = tmpDir();
  const bytes = Buffer.from('x');
  const res = await new FileSink(dir).write(Readable.from([bytes]), { name: '..\\..\\evil.txt', sha256: sha(bytes) });
  assert.equal(res.storedAs, 'evil.txt');
  assert.ok(fs.existsSync(path.join(dir, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')));
});
