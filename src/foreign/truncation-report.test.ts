/**
 * audit-foreign F4 的回归护栏（t17）：条数 / 节点数上限触顶必须**可见**。
 *
 * 口径（与 read-cline / read-vibe / read-grokbuild / read-dsh 既有实现一致）：
 *  - 会话条数触顶 → source-unreadable + detail=max-sessions-reached（count=上限）
 *  - 技能条数触顶 → source-unreadable + detail=max-skills-reached（count=上限）
 *  - trae 节点触顶 → source-unreadable + detail=max-nodes-reached
 *  - chatgpt 节点触顶 → ignored['chatgpt:max-nodes']（下游 unsupported-session-record 可见）
 *
 * base 3f42a8b 上的红：这些来源在触顶处直接 break/return，skipped 为空（导入全绿但条目缺失）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readChatgpt } from './read-chatgpt.ts';
import { readContinueSessions } from './read-continue.ts';
import { readCopilot } from './read-copilot.ts';
import { readCursor } from './read-cursor.ts';
import { readCodex } from './read-codex.ts';
import { readGeminiSessions } from './read-gemini.ts';
import { readHermes } from './read-hermes.ts';
import { readKimiSessions } from './read-kimi.ts';
import { readOpenclawSessions } from './read-openclaw.ts';
import { readPiSessions } from './read-pi.ts';
import { readQoderSessions } from './read-qoder.ts';
import { readQwenSessions } from './read-qwen.ts';
import { readReasonix } from './read-reasonix.ts';
import { traeSessionsOfValue } from './read-trae.ts';
import { readWorkbuddySessions } from './read-workbuddy.ts';
import type { ForeignSkip } from './types.ts';

const NL = String.fromCharCode(10);
const PLATFORM = 'linux';

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-f4-fix-'));
}
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function jsonl(cwd: string): string {
  return JSON.stringify({ role: 'user', content: 'hi', cwd }) + NL;
}
const SKILL = '# skill' + NL;
function hasDetail(skips: readonly ForeignSkip[], detail: string): boolean {
  return skips.some((s) => s.code === 'source-unreadable' && s.detail === detail);
}
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await tmpHome();
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

interface SessionCase {
  readonly id: string;
  readonly layout: (home: string) => Promise<void>;
  readonly run: (home: string) => Promise<readonly ForeignSkip[]>;
}

const SESSION_CASES: readonly SessionCase[] = [
  {
    id: 'qwen',
    layout: async (home) => {
      await write(path.join(home, '.qwenworkcn', 'projects', 'slug', 'a.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(home, '.qwenworkcn', 'projects', 'slug', 'b.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readQwenSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'workbuddy',
    layout: async (home) => {
      await write(path.join(home, '.workbuddy', 'projects', 'hash', 'a.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(home, '.workbuddy', 'projects', 'hash', 'b.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readWorkbuddySessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'qoder',
    layout: async (home) => {
      await write(path.join(home, '.qoder', 'projects', 'proj', 'a.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(home, '.qoder', 'projects', 'proj', 'b.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readQoderSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'pi',
    layout: async (home) => {
      const dir = path.join(home, '.pi', 'agent', 'sessions', '--home-probe-proj--');
      await write(path.join(dir, 'a.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(dir, 'b.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readPiSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'gemini',
    layout: async (home) => {
      const dir = path.join(home, '.gemini', 'history', 'slot', 'chats');
      const body = JSON.stringify({ sessionId: 's1', directories: ['/home/probe/proj'], messages: [{ type: 'user', content: 'hi' }] });
      await write(path.join(dir, 'session-a.json'), body);
      await write(path.join(dir, 'session-b.json'), body);
    },
    run: async (home) => (await readGeminiSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'continue',
    layout: async (home) => {
      const body = JSON.stringify({ sessionId: 's1', workspaceDirectory: '/home/probe/proj', history: [{ message: { role: 'user', content: 'hi' } }] });
      await write(path.join(home, '.continue', 'sessions', 'a.json'), body);
      await write(path.join(home, '.continue', 'sessions', 'b.json'), body);
    },
    run: async (home) => (await readContinueSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'kimi',
    layout: async (home) => {
      const base = path.join(home, '.kimi', 'sessions', 'workdir');
      await write(path.join(base, 'sid-1', 'wire.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(base, 'sid-2', 'wire.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readKimiSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'openclaw',
    layout: async (home) => {
      const dir = path.join(home, '.openclaw', 'agents', 'a', 'sessions');
      await write(path.join(dir, 's1.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(dir, 's2.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readOpenclawSessions({ homeDir: home, env: {}, platform: PLATFORM, maxSessionFiles: 1 })).readFindings ?? [],
  },
  {
    id: 'reasonix',
    layout: async (home) => {
      await write(path.join(home, '.reasonix', 'sessions', 'a.jsonl'), jsonl('/home/probe/proj'));
      await write(path.join(home, '.reasonix', 'sessions', 'b.jsonl'), jsonl('/home/probe/proj'));
    },
    run: async (home) => (await readReasonix({ homeDir: home, env: {}, platform: PLATFORM, maxFiles: 1 })).readFindings ?? [],
  },
];

for (const c of SESSION_CASES) {
  test('F4-a ' + c.id + '：会话条数触顶必须报 max-sessions-reached', async () => {
    await withHome(async (home) => {
      await c.layout(home);
      const skips = await c.run(home);
      assert.ok(hasDetail(skips, 'max-sessions-reached'), c.id + ' 触顶必须可见：' + JSON.stringify(skips));
    });
  });
}

test('F4-b chatgpt：节点触顶逐类计数（chatgpt:max-nodes）', async () => {
  await withHome(async (home) => {
    await write(path.join(home, 'export', 'conversations.json'), JSON.stringify([{
      id: 'c1',
      title: 't',
      current_node: 'n3',
      mapping: {
        n1: { id: 'n1', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['a'] }, create_time: 1 } },
        n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['b'] }, create_time: 2 } },
        n3: { id: 'n3', parent: 'n2', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['c'] }, create_time: 3 } },
      },
    }]));
    const res = await readChatgpt({ homeDir: home, env: {}, platform: PLATFORM, projectDir: path.join(home, 'export'), maxNodes: 2 });
    assert.equal(res.files.length, 1);
    const ignored = res.files[0]?.ignored ?? {};
    assert.equal(ignored['chatgpt:max-nodes'], 1, '节点触顶必须逐类计数：' + JSON.stringify(ignored));
  });
});

test('F4-c trae：节点触顶推 max-nodes-reached', () => {
  const findings: ForeignSkip[] = [];
  const value = {
    sessions: [
      { messages: [{ role: 'user', content: 'a' }] },
      { messages: [{ role: 'user', content: 'b' }] },
    ],
  };
  traeSessionsOfValue(value, 'memento/icube-ai-agent-storage', PLATFORM, findings, 1);
  assert.ok(hasDetail(findings, 'max-nodes-reached'), '节点触顶必须可见：' + JSON.stringify(findings));
});

interface SkillCase {
  readonly id: string;
  readonly layout: (home: string) => Promise<void>;
  readonly run: (home: string) => Promise<readonly ForeignSkip[]>;
}

const SKILL_CASES: readonly SkillCase[] = [
  {
    id: 'cursor',
    layout: async (home) => {
      await write(path.join(home, '.cursor', 'skills', 's1', 'SKILL.md'), SKILL);
      await write(path.join(home, '.cursor', 'skills', 's2', 'SKILL.md'), SKILL);
    },
    run: async (home) => (await readCursor({ homeDir: home, maxSkills: 1 })).input.readFindings ?? [],
  },
  {
    id: 'codex',
    layout: async (home) => {
      await write(path.join(home, '.agents', 'skills', 's1', 'SKILL.md'), SKILL);
      await write(path.join(home, '.agents', 'skills', 's2', 'SKILL.md'), SKILL);
    },
    run: async (home) => (await readCodex({ homeDir: home, env: {}, maxSkills: 1 })).input.readFindings ?? [],
  },
  {
    id: 'copilot',
    layout: async (home) => {
      await write(path.join(home, '.copilot', 'skills', 's1', 'SKILL.md'), SKILL);
      await write(path.join(home, '.copilot', 'skills', 's2', 'SKILL.md'), SKILL);
    },
    run: async (home) => (await readCopilot({ homeDir: home, env: {}, maxSkills: 1 })).input.readFindings ?? [],
  },
  {
    id: 'hermes',
    layout: async (home) => {
      await write(path.join(home, '.hermes', 'skills', 'cat', 's1', 'SKILL.md'), SKILL);
      await write(path.join(home, '.hermes', 'skills', 'cat', 's2', 'SKILL.md'), SKILL);
    },
    run: async (home) => (await readHermes({ homeDir: home, env: {}, platform: PLATFORM, maxSkills: 1 })).input.readFindings ?? [],
  },
];

for (const c of SKILL_CASES) {
  test('F4-d ' + c.id + '：技能数触顶必须报 max-skills-reached', async () => {
    await withHome(async (home) => {
      await c.layout(home);
      const skips = await c.run(home);
      assert.ok(hasDetail(skips, 'max-skills-reached'), c.id + ' 触顶必须可见：' + JSON.stringify(skips));
    });
  });
}
