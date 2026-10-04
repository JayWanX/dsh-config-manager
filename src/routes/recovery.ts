/**
 * 路由组：Phase 5 recovery 编排（prefix 路由，内部按 path 分发）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isValidOperationId } from '../core/journal.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import { scanSessionHealth } from '../utils/session-health-scan.ts'
import {
  applySessionRepair,
  listSessionRepairs,
  previewSessionRepair,
  rollbackSessionRepair,
} from '../utils/session-repair-service.ts'
import { sessionHealthNextSteps } from '../index.ts'

/** 预览回传的指纹（大小 + mtime）；形状不对一律 undefined（应用期就不会做 TOCTOU 判定）。 */
function readRepairExpect(value: unknown): { size: number; mtimeMs: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const size = record['size']
  const mtimeMs = record['mtimeMs']
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return undefined
  return { size, mtimeMs }
}

export function recoveryRoutes(env: RoutesEnv): WebRoute[] {
  const {
    dataDir,
    host,
    makeRecoveryExecutors,
    recoveryOrchestrator,
    sessionHealth,
    tryAppendHistory,
  } = env
  return [
    // ------------------------------------------------------------ recovery
    // Phase 5：recovery 编排（prefix 路由，内部按 path 分发）。
    // 禁用 withMutationGate（避免 double-journal）；mutation 路由经 withMutationLock + loopback fence。
    endpoint({ kind: 'prefix', path: '/api/dsh-config-manager/recovery', methods: ['GET', 'POST'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rel = url.pathname.slice('/api/dsh-config-manager/recovery'.length).replace(/^\/+/, '')
      const segments = rel.split('/').filter(Boolean)
      if (segments.length === 0) { writeJson(res, 404, { error: 'not found' }); return }
      if (segments[0] === 'status') {
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const r = await recoveryOrchestrator.status()
        writeJson(res, r.status, r.body)
        return
      }
      // T4：会话体检（**只读**）。GET /recovery/sessions?limit=N
      //
      // 为什么挂在 recovery 前缀下而不是新开一条 exact 路由：它与「事故恢复」是同一件事
      // （「我的对话去哪了」），且本族已经是 prefix 路由，加一条子路径不新增路由条目。
      // 只读保证：整条链路（选择器 → 计划项）不写任何字节；写操作只允许在离线 CLI。
      if (segments[0] === 'sessions') {
        // T8：应用内**直接修复**（写路径）。子路径 POST /recovery/sessions/repair 与 /rollback。
        //
        // 为什么现在敢在应用内写会话字节（此前是硬约束「零写入」）：
        // 执行器照抄离线 CLI 的安全序列（写前自校验 → 时间戳备份 → 临时文件原子换入 → 写后复验）；
        // 服务层再加三道可证明的写入门（路径必须落在会话根内 / 无 session.lock / 不在静止期内）、
        // 预览与应用之间的指纹一致性（TOCTOU 拒绝），且回滚只认台账里的 repairId（客户端不能传路径）。
        // 写操作仍过 withMutationLock（与导入/恢复互斥）+ SAFE MODE 闸门 —— 与其它写路由同一口径。
        if (segments.length === 2 && (segments[1] === 'repair' || segments[1] === 'rollback')) {
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          try {
            const body = await readJsonBody(req)
            if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
            const homeDir = sessionHealth.homeDir
            await runWithMutationLock(
              host.mutationLock,
              { op: 'session-repair', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
              async () => {
                if (segments[1] === 'rollback') {
                  const repairId = typeof body['repairId'] === 'string' ? body['repairId'] : ''
                  if (repairId === '') { writeJson(res, 400, { error: 'repairId required' }); return }
                  const result = await rollbackSessionRepair({ homeDir, dataDir, repairId })
                  await tryAppendHistory({ kind: 'recovery', result: result.ok ? 'success' : 'skipped', sections: [], source: 'recovery', summary: '会话修复回滚' })
                  writeJson(res, 200, result)
                  return
                }
                const unitId = typeof body['unitId'] === 'string' ? body['unitId'] : ''
                if (unitId === '') { writeJson(res, 400, { error: 'unitId required' }); return }
                if (body['apply'] !== true) {
                  writeJson(res, 200, await previewSessionRepair({ homeDir, unitId }))
                  return
                }
                const expect = readRepairExpect(body['expect'])
                // 有损动作（截断）必须由请求体显式放行；缺省拒绝（服务层与执行器各判一次）
                const result = await applySessionRepair({
                  homeDir,
                  dataDir,
                  unitId,
                  ...(expect !== undefined ? { expect } : {}),
                  allowLossy: body['allowLossy'] === true,
                })
                await tryAppendHistory({
                  kind: 'recovery',
                  result: result.ok ? 'success' : 'skipped',
                  sections: [],
                  source: 'recovery',
                  summary: result.ok
                    ? '会话修复（丢弃重放重复行 ' + String(result.droppedRows ?? 0) + ' 行）'
                    : '会话修复被拒绝：' + String(result.reason),
                })
                writeJson(res, 200, result)
              },
            )
          } catch (error) {
            if (error instanceof EnvironmentLockUnavailableError) {
              host.log.warn(`mutation lock blocked: op=session-repair reason=${error.reason}`)
              writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
              return
            }
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        // 支持 /recovery/sessions/<unitId> 单条查询（unitId 用 / 分隔，故取剩余全部段）。
        const unitFilter = segments.length > 1 ? segments.slice(1).join('/') : undefined
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw)
        try {
          const result = await scanSessionHealth({
            homeDir: sessionHealth.homeDir,
            ...(sessionHealth.targetFormatVersion() !== undefined
              ? { targetFormatVersion: sessionHealth.targetFormatVersion() }
              : {}),
            workspaceKeys: await sessionHealth.workspaceKeys(),
            knownSessionIds: await sessionHealth.knownSessionIds(),
          })
          const rows = unitFilter === undefined ? result.rows : result.rows.filter((row) => row.unitId === unitFilter)
          const sliced = limit !== undefined && Number.isFinite(limit) && limit >= 0 ? rows.slice(0, limit) : rows
          writeJson(res, 200, {
            ok: true,
            // 本次**扫描**只读（修复是另一条写路由 POST /sessions/repair，需显式确认）
            readOnly: true,
            sessionsDir: result.sessionsDir,
            sessionsDirExists: result.sessionsDirExists,
            targetFormatVersion: sessionHealth.targetFormatVersion() ?? null,
            summary: { ...result.summary, untested: result.untested, unreadableEntries: result.unreadableEntries },
            rows: sliced,
            /** 本次响应被 limit 截断掉的条数（0 = 未截断；界面必须能说清「还有 N 条没显示」） */
            truncated: rows.length - sliced.length,
            /** 给用户的下一步（可复制；其它损坏类别仍走离线 CLI） */
            nextSteps: sessionHealthNextSteps(sliced.length, result.summary),
            /** T8：本机可回滚的修复（台账；**不含任何绝对路径**） */
            repairs: await listSessionRepairs(dataDir).then((r) => r.repairs),
            ...(await listSessionRepairs(dataDir).then((r) => (r.error !== undefined ? { repairsError: r.error } : {}))),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // issue #31：残留锁的显式回收路由（POST /recovery/lock/recover）。
      // 必须放在 :operationId 解析**之前**——'lock' 不是 UUID，落到下面会被
      // 400 invalid operationId 挡掉（那正是「文案指向空面板」的同一类错位）。
      if (segments[0] === 'lock') {
        if (segments.length !== 2 || segments[1] !== 'recover') { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          // ⚠️ 故意**不**经 runWithMutationLock/withMutationGate：要回收的正是那把挡住
          // acquire 的残留锁——先取锁必然拿到 STALE_LOCK_DETECTED 并抛 423，回收将永远
          // 无法执行（与 CLI recover-stale-lock 同策略：只 inspect + prove stale + 原子回收，
          // 判定在 EnvironmentLockManager.recoverStaleLock 内部重做，本路由不做删除决策）。
          const body = await readJsonBody(req)
          const r = await recoveryOrchestrator.recoverStaleLock(body?.['userConfirmed'] === true)
          // Phase 6：审计史（成功与拒绝都记，便于事后追查「谁在什么时候回收了锁」）
          await tryAppendHistory({
            kind: 'recovery',
            result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
            sections: [],
            source: 'recovery',
            summary: '恢复操作 recover-stale-lock',
          })
          writeJson(res, r.status, r.body)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // issue #56：显式解除 SAFE MODE（POST /recovery/safe-mode/clear）。
      // 与 `lock/recover` 同一处置：**故意不经 withMutationGate** —— gate 是「写配置」的闸门，
      // 要解开的正是挡住一切写操作的保护，走 gate 必然 423（等于死锁）；锁定仍走
      // withMutationLock + loopback 围栏。编排器内部用与 verify/dismiss 同一份判据：
      // 还有未解决 incident → 拒绝，故这不是绕过恢复的后门。
      if (segments[0] === 'safe-mode') {
        if (segments.length !== 2 || segments[1] !== 'clear') { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          const body = await readJsonBody(req)
          const r = await recoveryOrchestrator.clearSafeModeBlock(body?.['userConfirmed'] === true)
          await tryAppendHistory({
            kind: 'recovery',
            result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
            sections: [],
            source: 'recovery',
            summary: '恢复操作 clear-safe-mode',
          })
          writeJson(res, r.status, r.body)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (segments.length !== 2) { writeJson(res, 404, { error: 'not found' }); return }
      const operationId = segments[0]!
      const action = segments[1]!
      if (!isValidOperationId(operationId)) { writeJson(res, 400, { error: 'invalid operationId' }); return }
      const methodFor: Record<string, 'GET' | 'POST'> = { preview: 'GET', confirm: 'POST', execute: 'POST', verify: 'POST', retry: 'POST', dismiss: 'POST' }
      const expected = methodFor[action]
      if (expected === undefined) { writeJson(res, 404, { error: 'not found' }); return }
      if (req.method !== expected) { writeJson(res, 405, { error: 'method not allowed' }); return }
      try {
        if (action === 'preview') {
          const r = await recoveryOrchestrator.preview(operationId)
          writeJson(res, r.status, r.body)
          return
        }
        // mutation 路由：withMutationLock（Phase 2 GLOBAL 锁）+ loopback fence；不 double-journal。
        // 不传 isBlocked：recovery 是解决 SAFE MODE 的机制，若被 SAFE MODE 阻断会死锁。
        await runWithMutationLock(host.mutationLock, { op: `recovery-${action}`, target: operationId }, async () => {
          const body = await readJsonBody(req)
          const userConfirmed = body?.['userConfirmed'] === true
          let r
          if (action === 'confirm') r = await recoveryOrchestrator.confirm(operationId, userConfirmed)
          else if (action === 'execute') r = await recoveryOrchestrator.execute(operationId, userConfirmed, makeRecoveryExecutors)
          else if (action === 'verify') r = await recoveryOrchestrator.verify(operationId)
          else if (action === 'retry') r = await recoveryOrchestrator.retry(operationId, userConfirmed, makeRecoveryExecutors)
          else if (action === 'dismiss') r = await recoveryOrchestrator.dismiss(operationId, userConfirmed)
          else r = { status: 404, body: { error: 'not found' } } as const
          // Phase 6：recovery 迁移历史（best-effort）。在 mutation 结果（execute/retry/verify/dismiss）后记。
          if (action === 'execute' || action === 'retry' || action === 'verify' || action === 'dismiss') {
            await tryAppendHistory({
              kind: 'recovery',
              result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
              sections: [],
              operationId,
              source: 'recovery',
              summary: `恢复操作 ${action}`,
              error: r.status >= 400 && typeof r.body?.['error'] === 'string' ? String(r.body['error']) : undefined,
            })
          }
          writeJson(res, r.status, r.body)
        })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          host.log.warn(`mutation lock blocked: op=${error.op} reason=${error.reason}${error.detail !== undefined ? ` detail=${error.detail}` : ''}`)
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          return
        }
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
