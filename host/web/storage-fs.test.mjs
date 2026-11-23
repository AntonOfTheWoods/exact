import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suiteBrowser } from '../../scripts/agent-launch.mjs';

// `fn(arg)` in a browser page that serves this directory's modules.
async function inPage(fn, arg) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('.js')) return new Response(readFileSync(resolve(import.meta.dirname, path.slice(1))),
      { headers: { 'content-type': 'text/javascript' } });
    return new Response('<!doctype html>');
  } });
  const browser = await suiteBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    return await page.evaluate(fn, arg);
  } finally { await browser.close(); server.stop(true); }
}

for (const backing of ['Blob', 'File', 'ArrayBuffer']) {
  for (const empty of [false, true]) {
    test(`${empty ? 'an empty append preserves' : 'an append extends'} a ${backing}-backed app file`, async () => {
      const result = await inPage(async ({ backing, empty }) => {
        const { createFileStore } = await import('/storage-fs.js');
        const store = createFileStore('append');
        const original = new Uint8Array([0, 128, 255, 65]);
        const source = 'app:/tmp/source', path = 'app:/data/kept', copy = 'app:/data/copy';
        try {
          if (backing === 'ArrayBuffer') await store.writeFile(source, original);
          else await store.putBlob(source, backing === 'File'
            ? new File([original], 'picked.mp3', { type: 'audio/mpeg' })
            : new Blob([original], { type: 'audio/mpeg' }));
          await store.rename(source, path);
          await store.copyFile(path, copy);
          // A view's surrounding bytes do not belong to the append, nor do later caller edits.
          const data = new Uint8Array([99, 66, 0, 254, 99]);
          const append = store.appendFile(path, empty ? data.subarray(1, 1) : data.subarray(1, 4));
          data.fill(88);
          await append;
          const typeAfterAppend = (await store.blob(path, 'application/octet-stream')).blob.type;
          await store.appendFile(path, new Uint8Array());
          const { blob } = await store.blob(path, 'application/octet-stream');
          // A copy keeps a picked file's type: one asked for with none shows the stored type itself.
          const copyType = (await store.blob(copy, '')).blob.type;
          return {
            bytes: Array.from(new Uint8Array(await store.readFile(path))),
            size: (await store.stat(path)).size,
            copy: Array.from(new Uint8Array(await store.readFile(copy))),
            blob: Array.from(new Uint8Array(await blob.arrayBuffer())),
            typeAfterAppend,
            typeAfterEmptyAppend: blob.type,
            copyType,
          };
        } finally { store.close(); }
      }, { backing, empty });
      const bytes = empty ? [0, 128, 255, 65] : [0, 128, 255, 65, 66, 0, 254];
      const type = backing === 'ArrayBuffer' ? 'application/octet-stream' : 'audio/mpeg';
      expect(result).toEqual({ bytes, size: bytes.length, copy: [0, 128, 255, 65], blob: bytes,
        typeAfterAppend: type, typeAfterEmptyAppend: type, copyType: backing === 'ArrayBuffer' ? '' : 'audio/mpeg' });
    }, 60_000);
  }
}

test('a stored Blob with no type is shown with the type asked for, as bytes are', async () => {
  // `exactBodyTo` stores the reply as such a Blob (storage-fs.js `bodyTarget`); a typed one keeps its own type.
  const types = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const store = createFileStore('untyped');
    const pdf = new TextEncoder().encode('%PDF-1.4 tiny');
    try {
      await store.writeFile('app:/data/written.pdf', pdf);
      await store.putBlob('app:/data/fetched.pdf', new Blob([pdf]));
      await store.putBlob('app:/data/picked.pdf', new File([pdf], 'picked.pdf', { type: 'application/x-picked' }));
      const shown = async (path) => (await store.blob(path, 'application/pdf')).blob.type;
      return [await shown('app:/data/written.pdf'), await shown('app:/data/fetched.pdf'), await shown('app:/data/picked.pdf')];
    } finally { store.close(); }
  });
  expect(types).toEqual(['application/pdf', 'application/pdf', 'application/x-picked']);
}, 60_000);

test('a request body bounds only a file the app wrote, which IndexedDB reads whole', async () => {
  // `requestBody` passes `bytesOnly`: a picked file, a recorded video or an `exactBodyTo` reply is a Blob
  // the browser streams as it sends (LLP 1133.008.000 D4). Eight bytes stands in for 64 MiB.
  const result = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const store = createFileStore('body-bound');
    const nine = new Uint8Array(9).fill(7);
    try {
      await store.writeFile('app:/data/written', nine);
      await store.putBlob('app:/data/recorded.mp4', new File([nine], 'clip.mp4', { type: 'video/mp4' }));
      const written = await store.blob('app:/data/written', '', 8, 'exactBodyFrom', true).catch(e => e.code);
      const recorded = (await store.blob('app:/data/recorded.mp4', '', 8, 'exactBodyFrom', true)).blob.size;
      const image = await store.blob('app:/data/recorded.mp4', '', 8).catch(e => e.code);
      return { written, recorded, image };
    } finally { store.close(); }
  });
  expect(result).toEqual({ written: 'too-large', recorded: 9, image: 'too-large' });
}, 60_000);

test('a rename onto the other kind of entry is EISDIR or ENOTDIR, as rename(2) answers natively', async () => {
  const codes = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const store = createFileStore('rename-kinds');
    const code = (promise) => promise.then(() => 'renamed', (error) => error.code);
    try {
      await store.mkdir('app:/data/folder');
      await store.writeFile('app:/data/file', new Uint8Array([1]));
      return [await code(store.rename('app:/data/file', 'app:/data/folder')),
        await code(store.rename('app:/data/folder', 'app:/data/file'))];
    } finally { store.close(); }
  });
  expect(codes).toEqual(['EISDIR', 'ENOTDIR']);
}, 60_000);

test('known-folder paths refuse with NotSupportedError before browser app storage', async () => {
  const result = await inPage(async () => {
    const { normalizePath } = await import('/storage-fs.js');
    return ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'screenshots'].map(name => {
      try { normalizePath(`${name}:/shot.png`); return 'allowed'; }
      catch (error) { return [error.name, error.code, error.message]; }
    });
  });
  expect(result).toEqual(Array(7).fill(['NotSupportedError', 'failed', 'NotSupportedError: well-known folders are unavailable on this host']));
});

test('OPFS SQLite reservations survive reopen and refuse file access or replacement', async () => {
  const result = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const path = 'app:/data/notes/notebook.db', parent = 'app:/data/notes';
    let store = createFileStore('opfs-reserved');
    try {
      await store.mkdir(parent);
      await Promise.all([store.claimOpfsDatabase(path), store.claimOpfsDatabase(path)]);
      store.close();
      store = createFileStore('opfs-reserved');
      await store.claimOpfsDatabase(path);
      await store.writeFile('app:/data/ordinary', new Uint8Array([7]));
      await store.mkdir('app:/data/empty');
      const blob = new Blob(['replacement']);
      const replacements = [
        ['readFile', () => store.readFile(path)],
        ['blob', () => store.blob(path, '')],
        ['stat', () => store.stat(path)],
        ['realpath', () => store.realpath(path)],
        ['writeFile', () => store.writeFile(path, new Uint8Array([1]))],
        ['atomicWriteFile', () => store.atomicWriteFile(path, new Uint8Array([1]))],
        ['atomicWriteOwnedFile', () => store.atomicWriteOwnedFile(path, new Uint8Array([1]).buffer)],
        ['appendFile', () => store.appendFile(path, new Uint8Array([1]))],
        ['putBlob', () => store.putBlob(path, blob)],
        ['putBlobs', () => store.putBlobs([{ path: 'app:/data/partial', blob }, { path, blob }])],
        ['mkdir', () => store.mkdir(path)],
        ['mkdir-below', () => store.mkdir(path + '/child')],
        ['rm', () => store.rm(path)],
        ['rm-parent', () => store.rm(parent)],
        ['rename-source', () => store.rename(path, 'app:/data/moved.db')],
        ['rename-destination', () => store.rename('app:/data/ordinary', path)],
        ['rename-parent', () => store.rename(parent, 'app:/data/moved')],
        ['rename-onto-parent', () => store.rename('app:/data/empty', parent)],
        ['copy-source', () => store.copyFile(path, 'app:/data/copy.db')],
        ['copy-destination', () => store.copyFile('app:/data/ordinary', path)],
      ];
      const refused = [];
      for (const [name, operation] of replacements) {
        try { await operation(); refused.push([name, 'allowed']); }
        catch (error) { refused.push([name, error.code, error.message.includes('OPFS SQLite database')]); }
      }
      const partial = await store.stat('app:/data/partial').then(() => 'exists', error => error.code);
      await store.claimOpfsDatabase(path);
      return { refused, partial, names: await store.readdir(parent),
        ordinary: Array.from(new Uint8Array(await store.readFile('app:/data/ordinary'))) };
    } finally { store.close(); }
  });
  expect(result.refused).toEqual([
    'readFile', 'blob', 'stat', 'realpath', 'writeFile', 'atomicWriteFile', 'atomicWriteOwnedFile',
    'appendFile', 'putBlob', 'putBlobs', 'mkdir', 'mkdir-below', 'rm', 'rm-parent',
    'rename-source', 'rename-destination', 'rename-parent', 'rename-onto-parent', 'copy-source', 'copy-destination',
  ].map(name => [name, 'unsupported', true]));
  expect(result.partial).toBe('ENOENT');
  expect(result.names).toEqual(['notebook.db']);
  expect(result.ordinary).toEqual([7]);
}, 60_000);

test('claiming an OPFS SQLite filename preserves existing IndexedDB files and directories', async () => {
  const result = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const store = createFileStore('opfs-existing');
    try {
      await store.writeFile('app:/data/existing.db', new Uint8Array([3, 4]));
      await store.mkdir('app:/data/directory.db');
      const refused = [];
      for (const path of ['app:/data/existing.db', 'app:/data/directory.db']) {
        try { await store.claimOpfsDatabase(path); refused.push('allowed'); }
        catch (error) { refused.push([error.code, error.message.includes('already exists in IndexedDB'),
          error.message.includes('choose a new path')]); }
      }
      const missingParent = await store.claimOpfsDatabase('app:/data/missing/new.db').then(() => 'allowed', error => error.code);
      const outsideData = await store.claimOpfsDatabase('app:/cache/new.db').then(() => 'allowed', error => error.code);
      return { refused, missingParent, outsideData,
        bytes: Array.from(new Uint8Array(await store.readFile('app:/data/existing.db'))),
        directory: (await store.stat('app:/data/directory.db')).isDirectory,
        names: await store.readdir('app:/data') };
    } finally { store.close(); }
  });
  expect(result).toEqual({ refused: [['failed', true, true], ['failed', true, true]],
    missingParent: 'ENOENT', outsideData: 'failed', bytes: [3, 4], directory: true,
    names: ['directory.db', 'existing.db'] });
}, 60_000);

test('directory removal checks OPFS reservations without reading descendant file payloads', async () => {
  const result = await inPage(async () => {
    const { createFileStore } = await import('/storage-fs.js');
    const store = createFileStore('remove-payloads');
    const prototype = IDBObjectStore.prototype;
    const get = prototype.get, getAll = prototype.getAll;
    const reads = [];
    try {
      await store.mkdir('app:/data/large/nested');
      await store.writeFile('app:/data/large/one', new Uint8Array(256 * 1024));
      await store.writeFile('app:/data/large/nested/two', new Uint8Array(256 * 1024));
      prototype.get = function (key) { reads.push(key); return get.call(this, key); };
      prototype.getAll = function (...args) { throw new Error('directory removal read descendant values'); };
      await store.rm('app:/data/large');
      prototype.get = get;
      prototype.getAll = getAll;
      return { reads, names: await store.readdir('app:/data') };
    } finally {
      prototype.get = get;
      prototype.getAll = getAll;
      store.close();
    }
  });
  expect(result).toEqual({ reads: ['app:/data'], names: [] });
}, 60_000);
