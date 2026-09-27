/**
 * 同步历史视图（方案 A）：列出本地祖先快照目录（kind=apply）+ 自动同步执行记录
 * （kind=autosync）。自动同步行显示时间/方向/状态/跳过冲突/应用分区，点开可看被跳过
 * 冲突分区明细。
 *
 * 数据获取：GET /sync/history → { entries: SyncHistoryEntry[] }（按 createdAt 倒序合并）。
 * 纯函数投影在 ./history-model.ts（node --test 可测），本组件只做装配。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Badge, Card, SectionTitle } from '../common/ui.tsx'
import { SkeletonTable } from '../common/Skeleton.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import type { SyncApi, SyncHistoryEntry, AutosyncHistoryEntry } from './sync-api.ts'
import {
  formatDateTime, formatDateTimeFull, midEllipsis, projectAutosyncEntry,
  projectSyncHistoryEntries, summarizeSyncHistory,
} from './history-model.ts'
import type { SnapshotHistoryEntry } from './history-model.ts'
import type { TranslateNS } from '../client-types.ts'
import css from '../config-manager.module.css'

/** 通道徽章：git → GitHub，webdav → WebDAV；未知/缺失不渲染。 */
function ChannelBadge({ transport, t }: { transport?: string; t: TranslateNS<'config-manager-sync'> }): ReactNode {
  if (transport === 'git') return <Badge kind="info">{t('history.channelGit')}</Badge>
  if (transport === 'webdav') return <Badge kind="info">{t('history.channelWebdav')}</Badge>
  return null
}

export interface SyncHistoryViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

export function SyncHistoryView(props: SyncHistoryViewProps): ReactNode {
  const { api, t } = props;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<SyncHistoryEntry[]>([]);
  /** 重试计数（错误态点「重试」递增 → 重新加载） */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await api.history();
        if (!cancelled) {
          setEntries(data.entries);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, reloadKey]);

  const rows = useMemo(() => projectSyncHistoryEntries(entries), [entries]);
  const stats = useMemo(() => summarizeSyncHistory(rows), [rows]);
  // 快照类条目（兼容旧投影；仅统计展示）
  const snapshotRows = useMemo<SnapshotHistoryEntry[]>(
    () => rows
      .filter((r) => r.kind === 'apply' || r.kind === 'push' || r.kind === 'pull' || r.kind === 'rollback')
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        sectionCount: r.sectionCount ?? 0,
        reviewCount: r.reviewCount ?? 0,
      })),
    [rows],
  );

  if (loading) return <SkeletonTable label={t('common.loading')} />;
  if (error) {
    return (
      <ErrorBanner
        error={error}
        onRetry={() => { setReloadKey((k) => k + 1) }}
        retrying={loading}
        t={api.t}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <strong>{t('history.empty')}</strong>
        <p>{t('history.emptyHint')}</p>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle title={`${t('history.title')}（${rows.length}）`} />
      {/* F：头部统计摘要（先扫结论）；失败/跳过仅在存在时出现，并给语义色 */}
      <div className={css.statRow} aria-label={t('history.stats.summary')}>
        <Badge kind="info">{t('history.stats.total', { count: String(stats.total) })}</Badge>
        <Badge kind="info">{t('history.stats.snapshots', { count: String(stats.snapshots) })}</Badge>
        <Badge kind="info">{t('history.stats.autosync', { count: String(stats.autosync) })}</Badge>
        {stats.failed > 0 && <Badge kind="error">{t('history.stats.failed', { count: String(stats.failed) })}</Badge>}
        {stats.skipped > 0 && <Badge kind="warn">{t('history.stats.skipped', { count: String(stats.skipped) })}</Badge>}
      </div>
      {/* A：改用设计系统数据表（.tableWrap > .tableScroll 限高内滚 + .dataTable/.tableFixed/.tableCompact） */}
      <div className={css.tableWrap}>
        <div className={css.tableScroll}>
          <table className={`${css.dataTable} ${css.tableFixed} ${css.tableCompact}`}>
            <thead>
              <tr>
                {/* 时间列 116px（非 92px）：11px 等宽下 "YYYY-MM-DD HH:mm" 实测 96.8px，
                    加 .tableCompact 的左右各 8px padding 需 112.8px；92px 会把时间截成
                    「2026-09-01…」（浏览器实测截图确认），反而比改前更不可读。 */}
                <th style={{ width: 116 }}>{t('history.colTime')}</th>
                <th style={{ width: 96 }}>{t('history.colKind')}</th>
                <th>{t('history.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                if (r.kind === 'autosync' && r.autosync !== undefined) {
                  return <AutosyncRow key={r.id} entry={r.autosync} t={t} />;
                }
                const snap = snapshotRows.find((s) => s.id === r.id);
                return (
                  <tr key={r.id}>
                    {/* B：等宽 11px + 固定列宽 → 单行不换行；title 给完整本地时间（含秒） */}
                    <td className={css.dim} title={formatDateTimeFull(r.createdAt)}>
                      <span className={`${css.mono}`} style={{ fontSize: '11px' }}>{formatDateTime(r.createdAt)}</span>
                    </td>
                    <td><Badge kind="info">{t('history.kindSnapshot')}</Badge></td>
                    <td>
                      <div className={css.cellMain}>
                        {/* C：UUID 中段省略（保留头尾，尾部才是区分信息），title 保留全文 */}
                        <span className={`${css.cellTitle} ${css.mono}`} title={r.id}>{midEllipsis(r.id)}</span>
                        <span className={css.cellMeta}>
                          <ChannelBadge transport={r.transport} t={t} />
                          {snap !== undefined && <>{snap.sectionCount} {t('history.sectionCount')}</>}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- 自动同步行 */

interface AutosyncRowProps {
  entry: AutosyncHistoryEntry
  t: TranslateNS<'config-manager-sync'>
}

function AutosyncRow({ entry, t }: AutosyncRowProps): ReactNode {
  const row = projectAutosyncEntry(entry);
  return (
    <tr>
      {/* B：与快照行一致的时间呈现（等宽 11px 单行 + title 完整本地时间） */}
      <td className={css.dim} title={formatDateTimeFull(row.createdAt)}>
        <span className={`${css.mono}`} style={{ fontSize: '11px' }}>{formatDateTime(row.createdAt)}</span>
      </td>
      {/* D：类型徽章按实况给语义色（success=ok / failed=error / skipped、partial=warn） */}
      <td><Badge kind={row.badgeKind}>{t('history.kindAutosync')}</Badge></td>
      <td>
        <div className={css.cellMain}>
          {/* E：主行「方向 + 状态」徽章（原摘要串里的跳过原因下沉到第二行小字） */}
          <span className={css.cellTitle}>
            <ChannelBadge transport={entry.transport} t={t} />
            {' '}
            <Badge kind="info">{row.direction}</Badge>
            {' '}
            <Badge kind={row.badgeKind}>{row.status}</Badge>
            {entry.pushedSnapshotId !== undefined && <>{' · '}{t('history.autosyncPush')} <span className={css.mono} title={entry.pushedSnapshotId}>{midEllipsis(entry.pushedSnapshotId)}</span></>}
            {entry.pulledSnapshotId !== undefined && <>{' · '}{t('history.autosyncPull')} <span className={css.mono} title={entry.pulledSnapshotId}>{midEllipsis(entry.pulledSnapshotId)}</span></>}
          </span>
          {/* E：第二行小字——跳过原因 / 错误（信息保留，但不再挤在主行里） */}
          {row.skipReasonText !== undefined && <span className={css.hint}>{row.skipReasonText}</span>}
          {row.error !== undefined && <span className={css.hint} title={row.error}>{t('history.autosyncError', { error: '' })}{row.error}</span>}
        </div>
        {row.hasDetail && (
          <details>
            <summary>{t('history.detail')}</summary>
            <div className={css.reportList}>
              {row.conflictedSections !== undefined && row.conflictedSections.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('history.autosyncConflicted', { sections: '' })}</span>
                  <div className={css.statRow}>
                    {row.conflictedSections.map((sid) => <Badge key={sid} kind="warn">{sid}</Badge>)}
                  </div>
                </div>
              )}
              {row.appliedSections !== undefined && row.appliedSections.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('history.autosyncApplied', { sections: '' })}</span>
                  <div className={css.statRow}>
                    {row.appliedSections.map((sid) => <Badge key={sid} kind="ok">{sid}</Badge>)}
                  </div>
                </div>
              )}
              {row.error !== undefined && (
                <div><span className={css.fieldLabel}>{t('history.autosyncError', { error: '' })}</span>{row.error}</div>
              )}
            </div>
          </details>
        )}
      </td>
    </tr>
  );
}
