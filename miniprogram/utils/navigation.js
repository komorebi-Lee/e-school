/**
 * 统一页面跳转。
 *
 * 背景：`wx.navigateTo` 无法跳转到 tabBar 页面，失败时若用空函数吞掉错误，
 * 用户点击后毫无反应。站内通知链接、宽带提交后的「查看订单」等就属于这种情况。
 *
 * 约定：
 * - tabBar 页面一律走 `wx.switchTab`
 * - `switchTab` 不支持 query，因此焦点参数改为经 Storage 传递
 * - 失败不再静默，统一给出提示，便于定位问题
 *
 * 注意：`TABBAR_PAGES` 与 `app.json` 的 `tabBar.list` 必须保持一致，
 * 由 `test/miniapp.test.js` 断言守护，新增 tabBar 项时请同步修改此处。
 */
const TABBAR_PAGES = [
  '/pages/home/home',
  '/pages/map/map',
  '/pages/orders/orders',
  '/pages/profile/profile'
];

const FOCUS_STORAGE_KEY = 'campusGoOrderFocusId';
const FOCUS_RECORD_TYPE_KEY = 'campusGoOrderFocusRecordType';

function splitTarget(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const separatorIndex = raw.indexOf('?');
  if (separatorIndex === -1) return { path: raw, query: '' };
  return { path: raw.slice(0, separatorIndex), query: raw.slice(separatorIndex + 1) };
}

function parseQuery(query) {
  const result = {};
  if (!query) return result;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equalIndex = pair.indexOf('=');
    const key = equalIndex === -1 ? pair : pair.slice(0, equalIndex);
    const rawValue = equalIndex === -1 ? '' : pair.slice(equalIndex + 1);
    try {
      result[key] = decodeURIComponent(rawValue);
    } catch (error) {
      result[key] = rawValue;
    }
  }
  return result;
}

function isTabBarPath(path) {
  return TABBAR_PAGES.indexOf(path) !== -1;
}

function defaultFail(error) {
  wx.showToast({ title: '页面打开失败，请重试', icon: 'none' });
  console.error('[navigation] 跳转失败', error);
}

function openLink(url, options = {}) {
  const target = splitTarget(url);
  if (!target) return;
  const fail = typeof options.fail === 'function' ? options.fail : defaultFail;

  if (isTabBarPath(target.path)) {
    const params = parseQuery(target.query);
    try {
      if (params.focusId) wx.setStorageSync(FOCUS_STORAGE_KEY, params.focusId);
      if (params.recordType) wx.setStorageSync(FOCUS_RECORD_TYPE_KEY, params.recordType);
    } catch (error) {
      console.error('[navigation] 写入焦点参数失败', error);
    }
    wx.switchTab({ url: target.path, fail });
    return;
  }

  const suffix = target.query ? `?${target.query}` : '';
  wx.navigateTo({ url: `${target.path}${suffix}`, fail });
}

module.exports = {
  TABBAR_PAGES,
  FOCUS_STORAGE_KEY,
  FOCUS_RECORD_TYPE_KEY,
  isTabBarPath,
  openLink
};
