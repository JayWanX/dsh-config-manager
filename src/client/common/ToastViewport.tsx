/**
 * ToastViewport —— 全局通知的渲染宿主（右下角堆叠）。
 *
 * 挂载在 `ConfigManagerSection` 根部（与 `.taskPanel` 同级），而不是 Portal 到 body：
 * 宿主设置弹窗 overlay 为 `position: fixed; z-index: 1000`（见 Modal.tsx 的
 * MODAL_ROOT_ID 说明），任何挂到 body 的固定层都会被它盖住而"隐形"。
 * 因此本组件用 `position: absolute` 贴合插件根节点（`.section` 已 position: relative），
 * 天然落在宿主弹窗自己的层叠上下文内。
 *
 * 交互：
 *   - 每条可点 × 手动关闭；悬停整条时**暂停**自动消失（正在读的内容不会跑掉），
 *     移开后按原时长重新计时。
 *   - 容器 `pointer-events: none`，仅卡片自身 `pointer-events: auto`：
 *     通知不遮挡下方页面的点击（右下角常压着状态栏 / 列表）。
 *   - aria-live="polite" + role="status"：屏幕阅读器播报但不打断。
 *
 * 视觉：走 Workbench Design System 既有 t​o​k​en（`--dsw-*`）+ Badge/Banner 的四态语义色，
 * 不引入第二套配色。
 */
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { CheckIcon, CloseIcon, ErrorIcon, InfoIcon, WarnIcon } from './Icon.tsx'
import { IconButton } from './ui.tsx'
import { toastStore } from './toast-store.ts'
import type { ToastKind } from './toast-types.ts'
import css from '../config-manager.module.css'

export interface ToastViewportProps {
  /** 关闭按钮的无障碍文案（由 S​h​e​l​l 注​入的 i18n）。 */
  t: TranslateNS<'config-manager'>
}

/** kind → 图标（与 Badge / Banner 四态同源语义）。 */
function ToastGlyph({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case 'ok': return <CheckIcon size={14} />
    case 'warn': return <WarnIcon size={14} />
    case 'error': return <ErrorIcon size={14} />
    case 'info': return <InfoIcon size={14} />
  }
}

/**
 * 右下角通知视口。无通知时渲染 null（不进 DOM）。
 */
export function ToastViewport({ t }: ToastViewportProps) {
  const snapshot = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot)

  if (snapshot.items.length === 0) return null

  return (
    <div className={css.toastViewport} role="status" aria-live="polite">
      {snapshot.items.map((item) => (
        <div
          key={item.id}
          className={css.toast}
          data-kind={item.kind}
          // 悬停暂停自动消失（读完再走）；移开按原时长重新计时
          onMouseEnter={() => { toastStore.pauseTimer(item.id) }}
          onMouseLeave={() => { toastStore.resetTimer(item.id) }}
        >
          <span className={css.toastGlyph} aria-hidden="true"><ToastGlyph kind={item.kind} /></span>
          <span className={css.toastText}>{item.text}</span>
          <IconButton
            icon={<CloseIcon size={12} />}
            label={t('common.close')}
            onClick={() => { toastStore.dismiss(item.id) }}
          />
        </div>
      ))}
    </div>
  )
}
