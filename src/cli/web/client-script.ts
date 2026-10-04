/**
 * 离线救急台的客户端脚本（**唯一一份**）。
 *
 * 为什么单独放一个模块：① 页面（page.ts）要把原文内联进 <script>；② HTTP 响应头（http.ts）要用
 * 同一份原文算 sha256，把 CSP 收紧到「只放行这一段内联脚本」而不是 script-src 'unsafe-inline'。
 * 两处必须同源，否则 CSP 会静默拦掉脚本（页面看起来「没坏」，只是状态不再恢复）。
 *
 * 硬约束（与救急台定位一致）：**零依赖、零构建、零外链**，只用浏览器原生能力
 * （sessionStorage / dialog.showModal / details / history）。禁用 JS 时整段不执行，
 * 页面回落到服务端直出的纯 HTML（确认表单在 <details open> 里原样可见可提交）。
 */
import { createHash } from 'node:crypto'

/** 客户端脚本原文（page.ts 内联进 <script>；不得含字面量 </script 或 <!--）。 */
export const CONSOLE_SCRIPT = `(function () {
  'use strict';

  // ---- 三态主题：自动 / 浅色 / 深色 ----
  // 为什么放在最前面：它要在**首帧之前**把 data-theme 落到 <html> 上，否则强制主题会先闪一下。
  // 为什么用 cookie 而不是 storage：cookie 不区分端口，而救急台每次启动换随机端口 —— 只有 cookie 能跨次记住。
  var THEME_KEY = 'dcm-theme';
  var THEME_MODES = ['auto', 'light', 'dark'];
  function readTheme() {
    var parts = ('; ' + document.cookie).split('; ' + THEME_KEY + '=');
    if (parts.length < 2) return 'auto';
    var value = String(parts[1]).split(';')[0];
    return THEME_MODES.indexOf(value) === -1 ? 'auto' : value;
  }
  function applyTheme(mode, persist) {
    var next = THEME_MODES.indexOf(mode) === -1 ? 'auto' : mode;
    document.documentElement.setAttribute('data-theme', next);
    var list = document.querySelectorAll('[data-dcm-theme]');
    for (var i = 0; i < list.length; i++) {
      list[i].setAttribute('aria-pressed', list[i].getAttribute('data-dcm-theme') === next ? 'true' : 'false');
    }
    if (persist === true) {
      // 非敏感偏好（不含任何密钥/路径）；cookie 被禁用时静默降级为「本次有效」
      document.cookie = THEME_KEY + '=' + next + '; path=/; max-age=31536000; SameSite=Lax';
    }
  }
  // 有脚本 = 开关可用；无脚本时它被 CSS 隐藏，页面回落到 prefers-color-scheme 的自动模式
  document.documentElement.setAttribute('data-dcm-js', '1');
  applyTheme(readTheme(), false);
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node !== null && node !== document) {
      if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-dcm-theme')) {
        applyTheme(String(node.getAttribute('data-dcm-theme')), true);
        return;
      }
      node = node.parentNode;
    }
  });
  // 离线救急台的**唯一**客户端脚本：只做两件事 —— ① 会话内状态恢复（sessionStorage，dcm: 前缀）
  // ② 把确认表单从 details 升级成原生 dialog 元素。禁用 JS 时两者都不参与，页面回落到纯 HTML。
  var PREFIX = 'dcm:';
  // 显式黑名单（不是「靠没写进去」）：这些 type 一律不落 storage
  var BLOCKED_TYPES = { password: 1, hidden: 1, file: 1, submit: 1, button: 1, reset: 1, image: 1 };
  // 显式黑名单（按字段名）：token / 密码 / 机密 / 凭据 / 重装确认码 / cookie 一律不落 storage
  var BLOCKED_NAMES = /(token|password|passwd|secret|credential|phrase|cookie|apikey|authorization)/i;
  var store = null;
  try {
    store = window.sessionStorage;
    store.setItem(PREFIX + 'probe', '1');
    store.removeItem(PREFIX + 'probe');
  } catch (error) {
    store = null;
  }
  function readJson(key) {
    if (store === null) return null;
    try {
      var raw = store.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }
  function writeJson(key, value) {
    if (store === null) return;
    try {
      store.setItem(key, JSON.stringify(value));
    } catch (error) {
      // 配额已满 / 隐私模式：静默降级，页面照常可用
    }
  }
  function pageKey() {
    return location.pathname + location.search;
  }
  function persistable(el) {
    if (!el || typeof el.name !== 'string' || el.name === '') return false;
    var type = (el.type || '').toLowerCase();
    if (BLOCKED_TYPES[type] === 1) return false;
    if (BLOCKED_NAMES.test(el.name)) return false;
    if (typeof el.id === 'string' && el.id !== '' && BLOCKED_NAMES.test(el.id)) return false;
    return true;
  }
  function fieldKey(el) {
    var scope = el.form ? String(el.form.getAttribute('action') || '') : '';
    return PREFIX + 'field:' + pageKey() + ':' + scope + ':' + el.name + (el.type === 'radio' ? '=' + String(el.value) : '');
  }
  function restoreFields() {
    var list = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!persistable(el)) continue;
      var saved = readJson(fieldKey(el));
      if (saved === null) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (typeof saved.checked === 'boolean') el.checked = saved.checked;
      } else if (typeof saved.value === 'string') {
        el.value = saved.value;
      }
    }
  }
  function onField(event) {
    var el = event.target;
    if (!persistable(el)) return;
    if (el.type === 'checkbox' || el.type === 'radio') writeJson(fieldKey(el), { checked: el.checked === true });
    else writeJson(fieldKey(el), { value: String(el.value) });
  }
  document.addEventListener('change', onField, true);
  document.addEventListener('input', onField, true);
  function detailsState() {
    var list = document.querySelectorAll('details[data-dcm-persist]');
    for (var i = 0; i < list.length; i++) {
      var details = list[i];
      var id = details.getAttribute('data-dcm-persist') || String(i);
      var saved = readJson(PREFIX + 'open:' + pageKey() + ':' + id);
      if (typeof saved === 'boolean') details.open = saved;
    }
  }
  document.addEventListener('toggle', function (event) {
    var details = event.target;
    if (!details || details.tagName !== 'DETAILS') return;
    var id = details.getAttribute('data-dcm-persist');
    if (id === null) return;
    writeJson(PREFIX + 'open:' + pageKey() + ':' + id, details.open === true);
  }, true);
  function scrollKey() {
    return PREFIX + 'scroll:' + pageKey();
  }
  var navType = '';
  try {
    var entries = performance.getEntriesByType('navigation');
    if (entries.length > 0) navType = String(entries[0].type || '');
  } catch (error) {
    navType = '';
  }
  function currentScroll() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  var scrollTimer = null;
  function saveScroll() {
    writeJson(scrollKey(), { y: Math.round(currentScroll()), t: Date.now() });
  }
  window.addEventListener('scroll', function () {
    if (scrollTimer !== null) return;
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      saveScroll();
    }, 150);
  }, { passive: true });
  window.addEventListener('pagehide', saveScroll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveScroll();
  });
  function restoreScroll() {
    var saved = readJson(scrollKey());
    if (saved === null || typeof saved.y !== 'number' || saved.y <= 0) return;
    window.scrollTo(0, saved.y);
  }
  // 只在「刷新」与「后退/前进」恢复：普通新导航（type=navigate）从顶部开始
  if (navType === '' || navType === 'reload' || navType === 'back_forward') {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(restoreScroll);
    });
  }
  function enhanceOne(details) {
    var form = details.querySelector('form');
    if (form === null) return;
    var summary = details.querySelector('summary');
    var dialog = document.createElement('dialog');
    dialog.className = 'dcmDialog';
    var body = details.querySelector('.confirmBody');
    if (body !== null) {
      while (body.firstChild !== null) dialog.appendChild(body.firstChild);
    } else {
      dialog.appendChild(form);
    }
    var footer = document.createElement('div');
    footer.className = 'dialogFooter';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btnPlain';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () { dialog.close(); });
    footer.appendChild(cancel);
    dialog.appendChild(footer);
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('data-dcm-trigger', '');
    trigger.className = summary === null ? 'btnPrimary' : summary.className;
    trigger.textContent = summary === null ? '确认执行' : String(summary.textContent || '确认执行');
    trigger.addEventListener('click', function () {
      if (dialog.open) dialog.close();
      else dialog.showModal();
    });
    if (details.parentNode !== null) details.parentNode.replaceChild(trigger, details);
  }
  function enhanceDialogs() {
    if (typeof document.createElement('dialog').showModal !== 'function') return;
    var list = document.querySelectorAll('details[data-dcm-confirm]');
    for (var i = 0; i < list.length; i++) enhanceOne(list[i]);
  }
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node !== null && node !== document) {
      if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-dcm-back')) {
        if (window.history.length > 1) {
          event.preventDefault();
          window.history.back();
        }
        return;
      }
      node = node.parentNode;
    }
  });
  function boot() {
    applyTheme(readTheme(), false); // DOM 到位后把开关的选中态对齐（首帧那条已经设过 data-theme）
    detailsState();
    enhanceDialogs();
    restoreFields();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`

const SCRIPT_HASH = "'sha256-" + createHash('sha256').update(CONSOLE_SCRIPT, 'utf8').digest('base64') + "'"

/** 该脚本的 CSP hash-source（含引号，可直接拼进 script-src）。 */
export function consoleScriptCspHash(): string {
  return SCRIPT_HASH
}
