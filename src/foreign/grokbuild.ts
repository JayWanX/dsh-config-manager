/**
 * Grok Build 来源的翻译层（wiring + draftOf）。
 *
 * evidence 与 truth-table.ts 的 grokbuild 行**逐字一致**（t6 交叉核对；不得在这里填更好看的一档）：
 * 路径取自 chat-import §3.1（双根）与 read-vault §10.2，本机无该来源安装 → `fixture`
 * （可复现取证方式 = 单测按同一份布局建夹具并端到端跑）。
 */
import { sessionSourceOf } from './session-source.ts';
import { draftFromTranscript } from './session-source.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { grokSessionRoots, readGrokbuild } from './read-grokbuild.ts';
import type { GrokSessionFile } from './read-grokbuild.ts';
import type { ForeignSource } from './registry.ts';

/** 一个来源的装配输入（probePaths 与读盘层**共用同一份**路径函数，杜绝两处真值分叉） */
export const grokbuildWiring: SessionSourceWiring<GrokSessionFile> = {
  id: 'grokbuild',
  evidence: 'fixture',
  probePaths: (opts) => grokSessionRoots(opts),
  probeEnvKeys: ['GROK_HOME'],
  read: (opts) => readGrokbuild(opts),
  draftOf: (file) => draftFromTranscript(file.id, file, 'grokbuild'),
};

export function createGrokbuildSource(): ForeignSource {
  return sessionSourceOf(grokbuildWiring);
}

/** 注册表装配点直接用这一个（与既有六来源同形：`<id>Source` 常量） */
export const grokbuildSource: ForeignSource = createGrokbuildSource();
