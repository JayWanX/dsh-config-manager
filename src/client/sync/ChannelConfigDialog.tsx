/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺；v2 第 5 步主文件改名 SyncPanel.tsx）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncPanel 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Banner, Button, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Modal } from '../common/Modal.tsx'
import { Select } from '../common/Select.tsx'
import { SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF } from './sync-api.ts'
import type { SyncStatusResponse } from './sync-api.ts'
import { presetById, presetIdForUrl, privateRepoHint, WEBDAV_PRESETS } from './sync-view.ts'
import type { GithubLoginView, SyncChannel } from './sync-view.ts'
import css from '../config-manager.module.css'

/** 通道配置弹窗的表单字段补丁（onFormChange 入参）。 */
export type ChannelFormPatch = {
  repoUrl?: string
  token?: string
  webdavUrl?: string
  webdavUsername?: string
  webdavPassword?: string
}

/**
 * 通道配置弹窗（**按打开它的通道**渲染 Git 或 WebDAV 表单 + GitHub device flow 登录 + 保存按钮）。
 * 弹窗内不再提供通道切换（子 tab 已移除）：换通道 = 回页面上点另一张通道卡的「配置」。
 * 拆出的职责单元只接收「渲染所需数据 + 回调」：`onFormChange` 由父组件实现为
 * 「patch 表单 + 防抖自动保存」—— 防抖定时器与卸载 flush 仍归父组件（单一状态源）。
 */
export function ChannelConfigDialog({ open, onClose, t, uiT, channel, busy, savingConfig, remoteReady, repoUrl, token, webdavUrl, webdavUsername, webdavPassword, statusInfo, githubSignedIn, githubView, onFormChange, onGithubStart, onGithubCancel, onSave }: {
  open: boolean
  onClose: () => void
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
  channel: SyncChannel
  busy: boolean
  savingConfig: boolean
  remoteReady: boolean
  repoUrl: string
  token: string
  webdavUrl: string
  webdavUsername: string
  webdavPassword: string
  statusInfo: SyncStatusResponse | null
  githubSignedIn: boolean | null
  githubView: GithubLoginView
  onFormChange: (patch: ChannelFormPatch) => void
  onGithubStart: () => void
  onGithubCancel: () => void
  onSave: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('channel.title')}
      wide
      busy={savingConfig}
    >
      <Modal.Header
        title={t('channel.title')}
        closeLabel={t('common.close')}
        onClose={onClose}
        closeDisabled={savingConfig}
        // 通道身份徽章 + 弹窗级说明：贴在标题右边，不单独成行
        // （子 tab 已移除，弹窗只配置**打开它的那条通道** —— 通道切换在页面的两张通道卡上做）
        trailing={<><Badge kind="info">{channel === 'webdav' ? t('channel.webdav') : t('channel.git')}</Badge> <InfoHint text={t('channel.perChannelHint')} label={t('common.infoHint')} /></>}
      />
      <Modal.Body scroll>

    {/* 私有仓库强制提示：仅 git 通道适用 */}
    {channel === 'git' && <Banner kind="warn">{privateRepoHint(uiT)}</Banner>}

      {/* git 通道分支 */}
      {channel === 'git' && (
        <>
          <span className={css.groupLabel}>{t('config.title')}</span>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('config.repoUrl')} <InfoHint text={t('config.repoUrlHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={repoUrl}
              placeholder="https://github.com/user/private-repo.git"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ repoUrl: e.target.value }) // 改动自动保存（防抖；关闭设置页不丢输入）
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('config.token')}
              {' '}
              {statusInfo?.credentialConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
            </span>
            <input
              type="password"
              className={css.input}
              value={token}
              autoComplete="off"
              placeholder={t('config.tokenPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ token: e.target.value })
              }}
            />
            <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
          </label>

          {/* GitHub OAuth 登录（device flow）：弹窗内仅 git 通道显示；已登录（token 有效）时整块隐藏 */}
          {githubSignedIn === false && (
            <>
              {statusInfo?.credentialConfigured === true && (
                <Banner kind="warn">{t('github.tokenInvalid')}</Banner>
              )}
              <span className={css.groupLabel}>{t('github.title')} <InfoHint text={t('github.description')} label={t('common.infoHint')} /></span>
              {githubView.showCode && (
                <div className={css.statRow}>
                  <Badge kind="info">{t('github.userCode')}：<strong>{githubView.userCode}</strong></Badge>
                  <a
                    className={css.ghostButton}
                    href={githubView.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: 'none' }}
                  >
                    {t('github.openAuth')}
                  </a>
                </div>
              )}
              <div className={css.actionRow}>
                <Button
                  variant="primary"
                  disabled={!githubView.canStart || busy}
                  onClick={() => { void onGithubStart() }}
                >
                  {githubView.startLabel}
                </Button>
                {githubView.canCancel && (
                  <Button disabled={busy} onClick={() => { void onGithubCancel() }}>
                    {t('github.cancel')}
                  </Button>
                )}
              </div>
              <div className={css.statRow}>
                <Badge kind={githubView.phase === 'success' ? 'ok' : githubView.phase === 'error' ? 'error' : 'warn'}>
                  {githubView.statusText}
                </Badge>
              </div>
              {githubView.phase === 'error' && (
                <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
              )}
            </>
          )}
        </>
      )}

      {/* webdav 通道分支 */}
      {channel === 'webdav' && (
        <>
          <span className={css.groupLabel}>{t('webdav.title')}</span>
          {/* 常见 WebDAV 服务器预设：选择后填充 url 模板（含占位符待替换）。
              ⓘ 与控件**同一行**（.controlRow：控件按自身宽度，ⓘ 保持自身尺寸）。 */}
          <div className={css.controlRow}>
            <Select
              value={presetIdForUrl(webdavUrl)}
              disabled={busy}
              ariaLabel={t('webdav.presetHint')}
              onChange={(next) => {
                const preset = presetById(next)
                onFormChange({ webdavUrl: preset.url })
              }}
              options={WEBDAV_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            />
            <InfoHint text={t('webdav.presetHint')} label={t('common.infoHint')} />
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('webdav.url')} <InfoHint text={t('webdav.urlHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={webdavUrl}
              placeholder="https://dav.example.com/dav/config"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavUrl: e.target.value })
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('webdav.username')}
              {' '}
              {statusInfo?.webdav?.usernameConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
              {' '}
              <InfoHint text={t('webdav.usernameHint')} label={t('common.infoHint')} />
            </span>
            <input
              type="text"
              className={css.input}
              value={webdavUsername}
              autoComplete="off"
              placeholder="alice"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavUsername: e.target.value })
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('webdav.password')}
              {' '}
              {statusInfo?.webdav?.passwordConfigured === true && <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>}
            </span>
            <input
              type="password"
              className={css.input}
              value={webdavPassword}
              autoComplete="off"
              placeholder={t('webdav.passwordPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavPassword: e.target.value })
              }}
            />
            <span className={css.hint}>{t('webdav.passwordHint', { ref: SYNC_WEBDAV_CREDENTIAL_REF })}</span>
          </label>
        </>
      )}

      {/* 配置保存：改动自动保存（防抖，静默）；按钮立即保存并给出 Toast 回执（announce=true） */}
      <div className={css.actionRow}>
        <Button
          variant="primary"
          disabled={busy || savingConfig || !remoteReady}
          onClick={() => { onSave() }}
        >
          {savingConfig ? <Spinner label={t('config.saving')} /> : t('config.save')}
        </Button>
        <InfoHint text={t('config.saveHint')} label={t('common.infoHint')} />
      </div>
      </Modal.Body>
    </Modal>
  )
}
