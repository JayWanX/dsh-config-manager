/**
 * Trae 来源的翻译层（wiring + draftOf）。
 *
 * evidence 与 truth-table.ts 的 trae 行一致（fixture：单测用**真实 SQLite 库**做夹具端到端跑；
 * 真机无 Trae 安装）。
 */
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { readTrae, traeProbePaths } from './read-trae.ts';
import type { TraeSessionFile } from './read-trae.ts';
import type { ForeignSource } from './registry.ts';

export const traeWiring: SessionSourceWiring<TraeSessionFile> = {
  id: 'trae',
  evidence: 'fixture',
  probePaths: (opts) => traeProbePaths(opts),
  read: (opts) => readTrae(opts),
  draftOf: (file) => draftFromTranscript(file.id, file, 'trae'),
};

export function createTraeSource(): ForeignSource {
  return sessionSourceOf(traeWiring);
}

export const traeSource: ForeignSource = createTraeSource();
