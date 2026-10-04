/**
 * 产物行的展开态：完整元数据（§6.5）。
 *
 * **不含变更摘要**：`RestoreResponse.changeSummary` 只有跑过 dry-run 才有，
 * 而展开必须是**零请求**的本地渲染 —— 不能为列表里每一行触发一次 dry-run（§6.8 ③）。
 * 变更摘要只在点「恢复」时随计划出现。
 *
 * 时间是模型给的 ISO（`pair.iso`），本地化在这里做：`src/ui/` 不掺 locale。
 */
import type { ArtifactRow as ArtifactRowModel } from '../../ui/artifact-view.ts'
import css from '../config-manager.module.css'

export interface ArtifactDetailProps {
  row: ArtifactRowModel
  /** ISO → 展示时间 */
  formatTime: (iso: string) => string
}

export function ArtifactDetail({ row, formatTime }: ArtifactDetailProps) {
  return (
    <div className={css.artifactDetail}>
      {row.detail.map((pair) => {
        const text = pair.iso === undefined ? pair.value : formatTime(pair.iso)
        return (
          // 同一行里 label 可能重复吗？不会（每个 builder 的 detail 都是固定键集合），故用 label 作 key 是安全的
          <div className={css.kvRow} key={pair.label}>
            <span className={css.kvKey}>{pair.label}</span>
            <span className={css.kvValue} title={text}>{text}</span>
          </div>
        )
      })}
    </div>
  )
}
