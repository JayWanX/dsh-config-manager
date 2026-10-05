/**
 * Cline 来源的翻译层（wiring + draftOf）。
 *
 * evidence 与 truth-table.ts 的 cline 行一致（fixture：单测按同一份布局建夹具端到端跑；真机无 ~/.cline）。
 * 五个环境变量覆盖**只报键名**（source-location-overridden），值绝不进产物。
 */
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { clineProbePaths, readCline } from './read-cline.ts';
import type { ClineSessionFile } from './read-cline.ts';
import type { ForeignSource } from './registry.ts';

export const clineWiring: SessionSourceWiring<ClineSessionFile> = {
  id: 'cline',
  evidence: 'fixture',
  probePaths: (opts) => clineProbePaths(opts),
  probeEnvKeys: [
    'CLINE_SESSION_DATA_DIR',
    'CLINE_DATA_DIR',
    'CLINE_DIR',
    'CLINE_LEGACY_GLOBAL_STORAGE_DIR',
    'CLINE_VSCODE_GLOBAL_STORAGE_DIR',
  ],
  read: (opts) => readCline(opts),
  draftOf: (file) => draftFromTranscript(file.id, file, 'cline'),
};

export function createClineSource(): ForeignSource {
  return sessionSourceOf(clineWiring);
}

export const clineSource: ForeignSource = createClineSource();
