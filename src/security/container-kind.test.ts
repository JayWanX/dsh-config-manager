/**
 * 备份容器形态探测的单元测试（issue #55 的单一事实源）。
 *
 * 为什么值得独立钉住：这个判定被四处复用（上传 / 备份文件列表 / analyze / plan / execute），
 * 判错一次的后果是「把 100 MB 密文当 ZIP 解析」或「把明文备份挡在解锁页后面」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONTAINER_MAGIC_BYTES,
  containerKindOfBytes,
  readContainerKind,
} from './container-kind.ts';
import { ARCHIVE_MAGIC } from './encryption.ts';

/** 造一个「前 4 字节是 DCA1」的最小容器（其余内容无关紧要：形态只看 magic）。 */
function dca1Bytes(payload = 64): Buffer {
  const buf = Buffer.alloc(CONTAINER_MAGIC_BYTES + payload, 0xab);
  buf.write(ARCHIVE_MAGIC, 0, 'ascii');
  return buf;
}

test('containerKindOfBytes：DCA1 magic → encrypted；其余 → zip', () => {
  assert.equal(containerKindOfBytes(dca1Bytes()), 'encrypted');
  // 真实 ZIP 的本地文件头 PK\x03\x04 / EOCD PK\x05\x06 都不是 DCA1
  assert.equal(containerKindOfBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip');
  assert.equal(containerKindOfBytes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'zip');
  // 短于 4 字节 / 空 → 一律按明文（下判决交给 ZIP 解析器，别在这里编造结论）
  assert.equal(containerKindOfBytes(Buffer.from([0x44, 0x43])), 'zip');
  assert.equal(containerKindOfBytes(new Uint8Array(0)), 'zip');
});

test('containerKindOfBytes 接受子视图片段（不依赖 Buffer 实例）', () => {
  const full = dca1Bytes();
  const head = new Uint8Array(full.buffer, full.byteOffset, CONTAINER_MAGIC_BYTES);
  assert.equal(containerKindOfBytes(head), 'encrypted');
});

test('readContainerKind：真实文件 → encrypted / zip', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-container-kind-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const enc = path.join(dir, 'enc.zip');
  const plain = path.join(dir, 'plain.zip');
  await fs.writeFile(enc, dca1Bytes(4096));
  await fs.writeFile(plain, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4096)]));
  assert.equal(await readContainerKind(enc), 'encrypted');
  assert.equal(await readContainerKind(plain), 'zip');
});

test('readContainerKind 读不到就回落 zip（不抛错、不猜成加密）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-container-kind-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // 不存在 / 是目录 / 空文件三种读不到或读不出 magic 的情形
  assert.equal(await readContainerKind(path.join(dir, 'missing.zip')), 'zip');
  assert.equal(await readContainerKind(dir), 'zip');
  const empty = path.join(dir, 'empty.zip');
  await fs.writeFile(empty, Buffer.alloc(0));
  assert.equal(await readContainerKind(empty), 'zip');
});

test('readContainerKind：只读前 4 字节，不把整份备份读进内存', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-container-kind-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const big = path.join(dir, 'big.zip');
  // 8 MiB 的明文「备份」：若实现退回 fs.readFile，这里会明显变慢且常驻内存暴涨；
  // 形态判定只需要前 4 字节，行为上表现为「读一个句柄的前 4 字节」。
  await fs.writeFile(big, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(8 * 1024 * 1024, 0x11)]));
  // 记录真实读取长度：包一层 fs.open，把返回句柄上的 read 换成「先记长度再转发」。
  // 用宽类型（any）承接 patch 形态 —— 只为在测试里观测读取字节数，不参与生产类型。
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const handleReads: number[] = [];
  const fsAny = fs as any;
  const realOpen = fsAny.open as (...args: any[]) => Promise<any>;
  fsAny.open = async (...args: any[]): Promise<any> => {
    const handle = await realOpen(...args);
    const realRead = handle.read.bind(handle) as (...rargs: any[]) => Promise<any>;
    handle.read = async (...rargs: any[]): Promise<any> => {
      handleReads.push(Number(rargs[2] ?? 0));
      return realRead(...rargs);
    };
    return handle;
  };
  t.after(() => { fsAny.open = realOpen; });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  assert.equal(await readContainerKind(big), 'zip');
  assert.deepEqual(handleReads, [CONTAINER_MAGIC_BYTES], '只允许读 magic 那 4 个字节');
});
