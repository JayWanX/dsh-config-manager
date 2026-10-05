/**
 * ChatGPT 来源的翻译层（wiring + draftOf）。
 *
 * **无自动根**（刻意）：probePaths 恒空数组 + probeSkips 恒报 source-needs-explicit-path
 * —— 自动探测永远 0 命中，绝不假装「未安装」。
 *
 * evidence 与 truth-table.ts 的 chatgpt 行一致（documented：只有四份调研报告的落点，
 * 真机导出包未验证；导出包结构是公开格式，夹具由单测即时构造）。
 */
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { SessionSourceWiring } from './session-source.ts';
import { CHATGPT_NEEDS_PATH_CODE, readChatgpt } from './read-chatgpt.ts';
import type { ChatgptSessionFile } from './read-chatgpt.ts';
import type { ForeignSource } from './registry.ts';

export const chatgptWiring: SessionSourceWiring<ChatgptSessionFile> = {
  id: 'chatgpt',
  evidence: 'documented',
  // **无自动根**：静态探测位置恒为空（不是「先猜一个再回落」，是契约要求的空）
  probePaths: () => [],
  probeSkips: () => [{ code: CHATGPT_NEEDS_PATH_CODE }],
  read: (opts) => readChatgpt(opts),
  draftOf: (file) => draftFromTranscript(file.id, file, 'chatgpt'),
};

export function createChatgptSource(): ForeignSource {
  return sessionSourceOf(chatgptWiring);
}

export const chatgptSource: ForeignSource = createChatgptSource();
