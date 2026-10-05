/**
 * Vibe 来源的翻译层（wiring + draftOf）。
 *
 * evidence 与 truth-table.ts 的 vibe 行一致（fixture：单测按同一份布局建夹具端到端跑；真机无 ~/.vibe）。
 * probeEnvKeys 只登记 **VIBE_HOME**（真正的来源位置覆盖）；report 期只回键名，绝不回值。
 */
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { readVibe, vibeSessionRoots } from './read-vibe.ts';
import type { VibeSessionFile } from './read-vibe.ts';
import type { ForeignSource } from './registry.ts';

export const vibeWiring: SessionSourceWiring<VibeSessionFile> = {
  id: 'vibe',
  evidence: 'fixture',
  probePaths: (opts) => vibeSessionRoots(opts),
  probeEnvKeys: ['VIBE_HOME'],
  read: (opts) => readVibe(opts),
  draftOf: (file) => draftFromTranscript(file.id, file, 'vibe'),
};

export function createVibeSource(): ForeignSource {
  return sessionSourceOf(vibeWiring);
}

export const vibeSource: ForeignSource = createVibeSource();
