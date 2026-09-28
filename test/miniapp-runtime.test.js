/**
 * 小程序运行时测试。
 *
 * 背景：`test/miniapp.test.js` 以源码文本/正则断言为主（大量 readFile + includes），
 * 交互逻辑没有任何运行时覆盖。站内通知「点了没反应」这类 bug 因此长期没被发现。
 *
 * 本文件用一个轻量 `wx` 全局桩，让 `miniprogram/utils/*.js`、`miniprogram/lib/*.js`
 * 这类不依赖页面生命周期的模块能在 Node 中真实加载、真实调用、真实断言。
 *
 * 约定：
 * - 只覆盖不依赖 `Page` / `Component` / `getApp` 的模块；
 *   页面脚本依赖微信运行时的生命周期注册，在 Node 里无法真实执行，故不覆盖。
 * - 桩必须能模拟「成功」与「失败」两种结果，失败路径同样要被断言。
 * - 本文件不涉及校园地图（campus-map）相关用例。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const miniprogramDirectory = path.join(__dirname, '..', 'miniprogram');
const appConfig = JSON.parse(fs.readFileSync(path.join(miniprogramDirectory, 'app.json'), 'utf8'));

// 这两个模块只在调用期访问 `wx`，因此可以在 Node 中安全加载，
// 之后按用例替换 `global.wx` 即可切换桩行为。
const navigation = require(path.join(miniprogramDirectory, 'utils', 'navigation.js'));
const cloudRequest = require(path.join(miniprogramDirectory, 'lib', 'cloud-request.js'));
// 商品展示层映射：纯函数模块，不访问 wx / Page，因此可以在 Node 中真实加载并断言。
const productView = require(path.join(miniprogramDirectory, 'utils', 'product-view.js'));
// 租赁订单展示层（进度条 / 应还倒计时 / 卡片文案）：同样是纯函数模块。
const rentalJourney = require(path.join(miniprogramDirectory, 'utils', 'rental-journey.js'));

const ORDER_FOCUS_KEY = 'campusGoOrderFocusId';
const ORDER_RECORD_TYPE_KEY = 'campusGoOrderFocusRecordType';

/** 异步型 wx API（带 success / fail 回调）。 */
const ASYNC_APIS = [
  'switchTab',
  'navigateTo',
  'navigateBack',
  'showToast',
  'showModal',
  'pageScrollTo',
  'setClipboardData'
];

/** 同步型 wx API（无回调，可能抛错）。 */
const SYNC_APIS = ['setStorageSync', 'getStorageSync', 'removeStorageSync'];

/**
 * 构造一个可断言、可注入失败的 `wx` 全局桩。
 *
 * @param {object} [config] 桩配置。
 * @param {string} [config.switchTabResult] `switchTab` 的结果，'success' | 'fail'。
 * @param {string} [config.navigateToResult] `navigateTo` 的结果，'success' | 'fail'。
 * @param {string} [config.navigateBackResult] `navigateBack` 的结果，'success' | 'fail'。
 * @param {string} [config.setStorageSyncResult] `setStorageSync` 的结果，'success' | 'fail'（fail 时抛错）。
 * @param {string} [config.removeStorageSyncResult] `removeStorageSync` 的结果，'success' | 'fail'（fail 时抛错）。
 * @param {string} [config.getStorageSyncResult] `getStorageSync` 的结果，'success' | 'fail'（fail 时抛错）。
 * @param {object} [config.initialStorage] 初始 Storage 内容。
 * @param {Function} [config.callContainerHandler] `wx.cloud.callContainer` 的应答函数，
 *   入参 `(params, index, allCalls)`，返回 `{ statusCode, data }` 或 `{ fail: errMsg }`。
 * @returns {{ wx: object, calls: object, storageGet: Function, storageSize: Function, storageKeys: Function }}
 */
function createWxStub(config = {}) {
  const results = {
    switchTab: config.switchTabResult || 'success',
    navigateTo: config.navigateToResult || 'success',
    navigateBack: config.navigateBackResult || 'success',
    showToast: 'success',
    showModal: 'success',
    pageScrollTo: 'success',
    setClipboardData: 'success'
  };
  const storageResults = {
    setStorageSync: config.setStorageSyncResult || 'success',
    getStorageSync: config.getStorageSyncResult || 'success',
    removeStorageSync: config.removeStorageSyncResult || 'success'
  };

  const calls = {};
  for (const api of [...ASYNC_APIS, ...SYNC_APIS, 'cloudCallContainer']) calls[api] = [];

  const storage = new Map(Object.entries(config.initialStorage || {}));

  function invokeAsync(name, params = {}) {
    calls[name].push({ ...params });
    const ok = results[name] === 'success';
    const errMsg = `${name}:${ok ? 'ok' : 'fail'}`;
    if (ok) {
      if (typeof params.success === 'function') params.success({ errMsg });
    } else if (typeof params.fail === 'function') {
      params.fail({ errMsg });
    }
    return { errMsg };
  }

  const wx = {
    switchTab: (params) => invokeAsync('switchTab', params),
    navigateTo: (params) => invokeAsync('navigateTo', params),
    navigateBack: (params) => invokeAsync('navigateBack', params),
    showToast: (params) => invokeAsync('showToast', params),
    showModal: (params) => invokeAsync('showModal', params),
    pageScrollTo: (params) => invokeAsync('pageScrollTo', params),
    setClipboardData: (params) => invokeAsync('setClipboardData', params),

    setStorageSync(key, value) {
      calls.setStorageSync.push({ key, value });
      if (storageResults.setStorageSync === 'fail') throw new Error(`setStorageSync:fail ${key}`);
      storage.set(key, value);
    },
    getStorageSync(key) {
      calls.getStorageSync.push({ key });
      if (storageResults.getStorageSync === 'fail') throw new Error(`getStorageSync:fail ${key}`);
      return storage.has(key) ? storage.get(key) : '';
    },
    removeStorageSync(key) {
      calls.removeStorageSync.push({ key });
      if (storageResults.removeStorageSync === 'fail') throw new Error(`removeStorageSync:fail ${key}`);
      storage.delete(key);
    },

    cloud: {
      callContainer(params = {}) {
        calls.cloudCallContainer.push({ ...params });
        const index = calls.cloudCallContainer.length;
        const response = typeof config.callContainerHandler === 'function'
          ? config.callContainerHandler(params, index, calls.cloudCallContainer)
          : { statusCode: 200, data: { data: {} } };
        if (response && response.fail) {
          if (typeof params.fail === 'function') params.fail({ errMsg: response.fail });
          return Promise.resolve({ statusCode: 0, data: {} });
        }
        if (typeof params.success === 'function') params.success(response);
        return Promise.resolve(response);
      }
    }
  };

  return {
    wx,
    calls,
    storageGet: (key) => (storage.has(key) ? storage.get(key) : ''),
    storageSize: () => storage.size,
    storageKeys: () => [...storage.keys()]
  };
}

/** 在指定桩下执行同步 fn，结束后恢复原 `global.wx`。 */
function withWx(stub, fn) {
  const previous = global.wx;
  global.wx = stub.wx;
  try {
    return fn();
  } finally {
    global.wx = previous;
  }
}

/**
 * 在指定桩下执行异步 fn，等待其完成后才恢复原 `global.wx`。
 *
 * 异步接口（如 cloud-request 的 request）会在 await 之后继续访问 `wx`，
 * 若同步恢复桩，后续调用会落到未定义的 `wx` 上。
 */
async function withWxAsync(stub, fn) {
  const previous = global.wx;
  global.wx = stub.wx;
  try {
    return await fn();
  } finally {
    global.wx = previous;
  }
}

/** 捕获 console.error 输出，避免失败路径的预期日志污染测试输出。 */
function captureConsoleError(fn) {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.map((item) => String(item)).join(' ')); };
  try {
    const value = fn(messages);
    return { value, messages };
  } finally {
    console.error = original;
  }
}

/** 统计某次桩调用中全部跳转类 API 的总次数。 */
function jumpCallCount(stub) {
  return stub.calls.switchTab.length + stub.calls.navigateTo.length + stub.calls.navigateBack.length;
}

// ===========================================================================
// 一、navigation.openLink —— tabBar 分流
// ===========================================================================

test('openLink 跳转 tabBar 页面时调用 switchTab 并把 focusId 经 Storage 传递', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1'));

  assert.equal(stub.calls.switchTab.length, 1, '应调用一次 wx.switchTab');
  assert.equal(stub.calls.navigateTo.length, 0, 'tabBar 页面不应调用 wx.navigateTo');
  assert.equal(stub.calls.switchTab[0].url, '/pages/orders/orders', 'switchTab 的 url 不能带 query');
  assert.deepEqual(
    stub.calls.setStorageSync,
    [{ key: ORDER_FOCUS_KEY, value: 'ord_1' }],
    'focusId 应写入 campusGoOrderFocusId'
  );
});

test('openLink 同时携带 focusId 与 recordType 时写入两个 Storage 键', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1&recordType=ORDER'));

  assert.equal(stub.calls.switchTab.length, 1);
  assert.deepEqual(stub.calls.setStorageSync, [
    { key: ORDER_FOCUS_KEY, value: 'ord_1' },
    { key: ORDER_RECORD_TYPE_KEY, value: 'ORDER' }
  ]);
  assert.equal(stub.storageGet(ORDER_FOCUS_KEY), 'ord_1');
  assert.equal(stub.storageGet(ORDER_RECORD_TYPE_KEY), 'ORDER');
});

test('openLink 对 TABBAR_PAGES 中每个页面都走 switchTab 且不带 query', () => {
  for (const pagePath of navigation.TABBAR_PAGES) {
    const stub = createWxStub();
    withWx(stub, () => navigation.openLink(pagePath));
    assert.equal(stub.calls.switchTab.length, 1, `${pagePath} 应走 switchTab`);
    assert.equal(stub.calls.navigateTo.length, 0, `${pagePath} 不应走 navigateTo`);
    assert.equal(stub.calls.switchTab[0].url, pagePath);
  }
});

// ===========================================================================
// 二、navigation.openLink —— 非 tabBar 分流与 query 保真
// ===========================================================================

test('openLink 跳转非 tabBar 页面时调用 navigateTo 且 query 原样保留', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/detail/detail?id=p1'));

  assert.equal(stub.calls.navigateTo.length, 1, '应调用一次 wx.navigateTo');
  assert.equal(stub.calls.navigateTo[0].url, '/pages/detail/detail?id=p1', 'query 必须原样保留');
  assert.equal(stub.calls.switchTab.length, 0, '非 tabBar 页面不应调用 switchTab');
  assert.equal(stub.calls.setStorageSync.length, 0, '非 tabBar 页面不应写焦点 Storage');
});

test('openLink 跳转市集（当前尚未是 tabBar 页）走 navigateTo', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/market/market'));

  assert.equal(stub.calls.navigateTo.length, 1);
  assert.equal(stub.calls.navigateTo[0].url, '/pages/market/market');
  assert.equal(stub.calls.switchTab.length, 0, '市集提为 tabBar 页前不应走 switchTab');
  assert.equal(navigation.isTabBarPath('/pages/market/market'), false);
});

test('openLink 对多参数 query 完整透传给 navigateTo', () => {
  const stub = createWxStub();
  const url = '/pages/merchant/orders?filter=LOW&focusId=ord_9&page=2';
  withWx(stub, () => navigation.openLink(url));

  assert.equal(stub.calls.navigateTo.length, 1);
  assert.equal(stub.calls.navigateTo[0].url, url);
});

// ===========================================================================
// 三、navigation.openLink —— 空输入与健壮性
// ===========================================================================

test('openLink 收到空 url 时不调用任何跳转 API 且不抛错', () => {
  for (const value of ['', null, undefined, '   ']) {
    const stub = createWxStub();
    assert.doesNotThrow(() => withWx(stub, () => navigation.openLink(value)));
    assert.equal(jumpCallCount(stub), 0, `url=${JSON.stringify(value)} 时不应发生任何跳转`);
  }
});

test('openLink 写入 Storage 抛错时不中断跳转', () => {
  const stub = createWxStub({ setStorageSyncResult: 'fail' });
  const { messages } = captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1'));
  });

  assert.equal(stub.calls.switchTab.length, 1, 'Storage 异常不应阻止 switchTab');
  assert.equal(stub.calls.switchTab[0].url, '/pages/orders/orders');
  assert.ok(messages.some((item) => item.includes('写入焦点参数失败')), '应记录 Storage 写入失败日志');
});

test('openLink 回滚 Storage 抛错时不吞掉失败回调', () => {
  const stub = createWxStub({ switchTabResult: 'fail', removeStorageSyncResult: 'fail' });
  let customFailArg = null;
  const { messages } = captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1', {
      fail: (error) => { customFailArg = error; }
    }));
  });

  assert.ok(customFailArg, '自定义 fail 仍应被调用');
  assert.equal(customFailArg.errMsg, 'switchTab:fail');
  assert.ok(messages.some((item) => item.includes('回滚焦点参数失败')), '应记录回滚失败日志');
});

// ===========================================================================
// 四、navigation.openLink —— 失败路径（失败不再静默）
// ===========================================================================

test('switchTab 失败时调用默认 showToast，不再静默失败', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1'));
  });

  assert.equal(stub.calls.showToast.length, 1, '失败时必须提示用户');
  assert.equal(stub.calls.showToast[0].title, '页面打开失败，请重试');
  assert.equal(stub.calls.showToast[0].icon, 'none');
});

test('navigateTo 失败时同样调用默认 showToast', () => {
  const stub = createWxStub({ navigateToResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/detail/detail?id=p1'));
  });

  assert.equal(stub.calls.showToast.length, 1);
  assert.equal(stub.calls.showToast[0].title, '页面打开失败，请重试');
});

test('默认失败回调同时写入 console.error 便于定位', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  const { messages } = captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders'));
  });

  assert.ok(messages.some((item) => item.includes('[navigation] 跳转失败')), '应输出跳转失败日志');
});

test('传入自定义 fail 时使用自定义回调，不触发默认 toast', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  const received = [];
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1', {
    fail: (error) => received.push(error)
  }));

  assert.equal(received.length, 1, '自定义 fail 应被调用一次');
  assert.equal(received[0].errMsg, 'switchTab:fail');
  assert.equal(stub.calls.showToast.length, 0, '自定义 fail 时不应再弹默认 toast');
});

test('自定义 fail 在 navigateTo 失败时同样生效', () => {
  const stub = createWxStub({ navigateToResult: 'fail' });
  const received = [];
  withWx(stub, () => navigation.openLink('/pages/detail/detail?id=p1', {
    fail: (error) => received.push(error)
  }));

  assert.equal(received.length, 1);
  assert.equal(received[0].errMsg, 'navigateTo:fail');
  assert.equal(stub.calls.showToast.length, 0);
});

test('传入非函数的 fail 时回退到默认 toast', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders', { fail: 'not-a-function' }));
  });

  assert.equal(stub.calls.showToast.length, 1, '非函数 fail 应回退到默认提示');
  assert.equal(stub.calls.showToast[0].title, '页面打开失败，请重试');
});

// ===========================================================================
// 五、navigation.openLink —— 失败时回滚焦点参数
// ===========================================================================

test('switchTab 失败时回滚已写入的 focusId 与 recordType', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1&recordType=ORDER'));
  });

  assert.deepEqual(
    stub.calls.removeStorageSync.map((item) => item.key),
    [ORDER_FOCUS_KEY, ORDER_RECORD_TYPE_KEY],
    '失败时应清理两个焦点键'
  );
  assert.equal(stub.storageSize(), 0, '失败后 Storage 不应残留焦点参数');
});

test('switchTab 失败时只回滚本次真正写入的键', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1'));
  });

  assert.deepEqual(stub.calls.removeStorageSync.map((item) => item.key), [ORDER_FOCUS_KEY]);
  assert.equal(stub.storageGet(ORDER_FOCUS_KEY), '', '残留 focusId 会被下一次进入订单页误消费');
});

test('switchTab 成功时不回滚焦点参数，交由订单页 onShow 消费', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=ord_1'));

  assert.equal(stub.calls.removeStorageSync.length, 0, '成功时不应清理');
  assert.equal(stub.storageGet(ORDER_FOCUS_KEY), 'ord_1');
});

test('switchTab 失败且未写入任何焦点参数时不调用 removeStorageSync', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  captureConsoleError(() => {
    withWx(stub, () => navigation.openLink('/pages/orders/orders'));
  });

  assert.equal(stub.calls.switchTab.length, 1);
  assert.equal(stub.calls.removeStorageSync.length, 0, '没有写入就无需回滚');
});

// ===========================================================================
// 六、navigation.isTabBarPath 与 TABBAR_PAGES 一致性
// ===========================================================================

test('isTabBarPath 对 4 个 tabBar 页面返回 true', () => {
  for (const pagePath of ['/pages/home/home', '/pages/map/map', '/pages/orders/orders', '/pages/profile/profile']) {
    assert.equal(navigation.isTabBarPath(pagePath), true, `${pagePath} 应被识别为 tabBar 页面`);
  }
});

test('isTabBarPath 对非 tabBar 页面与空值返回 false', () => {
  for (const pagePath of ['/pages/market/market', '/pages/detail/detail', '/pages/orders/orders-detail', '', null, undefined]) {
    assert.equal(navigation.isTabBarPath(pagePath), false, `${String(pagePath)} 不应被识别为 tabBar 页面`);
  }
});

test('TABBAR_PAGES 与 app.json 的 tabBar.list 双向完全一致', () => {
  const appTabBarPaths = (appConfig.tabBar?.list || []).map((item) => `/${item.pagePath}`);
  assert.ok(appTabBarPaths.length > 0, 'app.json 应配置 tabBar');

  assert.deepEqual(
    [...navigation.TABBAR_PAGES].sort(),
    [...new Set(appTabBarPaths)].sort(),
    'navigation.js 的 TABBAR_PAGES 必须与 app.json 的 tabBar.list 完全一致'
  );
});

test('navigation 导出的 Storage 键名与订单页消费的键名一致', () => {
  const ordersSource = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'orders', 'orders.js'), 'utf8');
  assert.equal(navigation.FOCUS_STORAGE_KEY, ORDER_FOCUS_KEY);
  assert.equal(navigation.FOCUS_RECORD_TYPE_KEY, ORDER_RECORD_TYPE_KEY);
  assert.ok(ordersSource.includes(`'${navigation.FOCUS_STORAGE_KEY}'`), '订单页应按同一键名读回焦点');
  assert.ok(ordersSource.includes(`'${navigation.FOCUS_RECORD_TYPE_KEY}'`), '订单页应按同一键名读回记录类型');
});

// ===========================================================================
// 七、navigation.openLink —— query 解析行为（经 Storage 间接验证）
// ===========================================================================

test('openLink 对 URL 编码的 focusId 做解码后再写入 Storage', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=a%20b'));

  assert.equal(stub.calls.setStorageSync.length, 1);
  assert.equal(stub.calls.setStorageSync[0].value, 'a b', '编码值应被解码为 a b');
});

test('openLink 对无等号的裸参数不写入 Storage，但仍完成跳转', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId'));

  assert.equal(stub.calls.setStorageSync.length, 0, '裸参数解析为空字符串，不应写入 Storage');
  assert.equal(stub.calls.switchTab.length, 1, '跳转仍应发生');
  assert.equal(stub.calls.switchTab[0].url, '/pages/orders/orders');
});

test('openLink 对非法百分号编码回退为原始值且不抛错', () => {
  const stub = createWxStub();
  assert.doesNotThrow(() => withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=%E0%A4%A')));

  assert.equal(stub.calls.setStorageSync.length, 1);
  assert.equal(stub.calls.setStorageSync[0].value, '%E0%A4%A', '解码失败应回退为原始值');
});

test('openLink 仅携带 recordType 时只写入 recordType 键', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?recordType=BROADBAND'));

  assert.deepEqual(stub.calls.setStorageSync, [{ key: ORDER_RECORD_TYPE_KEY, value: 'BROADBAND' }]);
  assert.equal(stub.storageGet(ORDER_FOCUS_KEY), '', '不应凭空写入 focusId');
});

test('openLink 对连续 & 与空段做容错解析', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?&focusId=ord_7&&recordType=SLA&'));

  assert.deepEqual(stub.calls.setStorageSync, [
    { key: ORDER_FOCUS_KEY, value: 'ord_7' },
    { key: ORDER_RECORD_TYPE_KEY, value: 'SLA' }
  ]);
  assert.equal(stub.calls.switchTab[0].url, '/pages/orders/orders');
});

// ===========================================================================
// 八、lib/cloud-request —— 会话与重试（真实调用，非文本断言）
// ===========================================================================

/** 构造一个按路径分发的 callContainer 应答器。 */
function routeHandler(routes) {
  return (params, index, allCalls) => {
    const matched = routes[params.path];
    if (typeof matched === 'function') return matched(params, index, allCalls);
    if (matched) return matched;
    return { statusCode: 404, data: { error: { message: `未配置的路由 ${params.path}` } } };
  };
}

test('request 在 token 有效时直接复用缓存，不重复登录', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'cached_token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/my/orders': { statusCode: 200, data: { data: { orders: [{ id: 'ord_1' }] } } }
    })
  });

  const result = await withWxAsync(stub, () => cloudRequest.request('/api/my/orders'));

  assert.equal(stub.calls.cloudCallContainer.length, 1, '有效 token 时不应触发登录');
  assert.equal(stub.calls.cloudCallContainer[0].path, '/api/my/orders');
  assert.equal(
    stub.calls.cloudCallContainer[0].header.authorization,
    'Bearer cached_token',
    '应带上缓存 token'
  );
  assert.deepEqual(result, { data: { orders: [{ id: 'ord_1' }] } });
});

test('request 在 token 过期时先登录再携带新 token 重试', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'expired_token',
      campusGoUserTokenExpiresAt: Date.now() - 1000
    },
    callContainerHandler: routeHandler({
      '/api/auth/login': {
        statusCode: 200,
        data: { data: { token: 'fresh_token', userId: 'user_1', expiresIn: 3600 } }
      },
      '/api/my/orders': { statusCode: 200, data: { data: { orders: [] } } }
    })
  });

  await withWxAsync(stub, () => cloudRequest.request('/api/my/orders'));

  assert.deepEqual(
    stub.calls.cloudCallContainer.map((item) => item.path),
    ['/api/auth/login', '/api/my/orders'],
    '过期后应先登录再请求业务接口'
  );
  assert.equal(stub.calls.cloudCallContainer[1].header.authorization, 'Bearer fresh_token');
  assert.equal(stub.storageGet('campusGoUserToken'), 'fresh_token', '新 token 应写入 Storage');
  assert.equal(stub.storageGet('campusGoUserId'), 'user_1', 'userId 应写入 Storage');
  assert.ok(stub.storageGet('campusGoUserTokenExpiresAt') > Date.now(), '过期时间应写入 Storage');
});

test('loginWeChat 在平台登录失败时回退到体验登录', async () => {
  const stub = createWxStub({
    callContainerHandler: routeHandler({
      '/api/auth/login': { fail: 'login:fail' },
      '/api/auth/demo-login': {
        statusCode: 200,
        data: { data: { token: 'demo_token', userId: 'demo_user', expiresIn: 3600 } }
      }
    })
  });

  const session = await withWxAsync(stub, () => cloudRequest.loginWeChat());

  assert.deepEqual(
    stub.calls.cloudCallContainer.map((item) => item.path),
    ['/api/auth/login', '/api/auth/demo-login'],
    '平台登录失败后应调用体验登录'
  );
  assert.equal(session.token, 'demo_token');
  assert.equal(session.userId, 'demo_user');
});

test('request 收到 401 时清空 token 并自动重试一次后成功', async () => {
  let businessCalls = 0;
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'stale_token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/auth/login': {
        statusCode: 200,
        data: { data: { token: 'renewed_token', userId: 'user_1', expiresIn: 3600 } }
      },
      '/api/my/orders': () => {
        businessCalls += 1;
        if (businessCalls === 1) {
          return { statusCode: 401, data: { error: { message: '登录已过期', code: 'UNAUTHORIZED' } } };
        }
        return { statusCode: 200, data: { data: { orders: [{ id: 'ord_2' }] } } };
      }
    })
  });

  const result = await withWxAsync(stub, () => cloudRequest.request('/api/my/orders'));

  assert.equal(businessCalls, 2, '401 后应重试一次业务接口');
  assert.ok(
    stub.calls.removeStorageSync.some((item) => item.key === 'campusGoUserToken'),
    '401 应清空失效 token'
  );
  assert.deepEqual(result, { data: { orders: [{ id: 'ord_2' }] } });
});

test('request 连续两次 401 时抛出带状态码的错误', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'stale_token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/auth/login': {
        statusCode: 200,
        data: { data: { token: 'still_bad', userId: 'user_1', expiresIn: 3600 } }
      },
      '/api/my/orders': {
        statusCode: 401,
        data: { error: { message: '登录已过期', code: 'UNAUTHORIZED' } }
      }
    })
  });

  await assert.rejects(
    () => withWxAsync(stub, () => cloudRequest.request('/api/my/orders')),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, '登录已过期');
      assert.equal(error.code, 'UNAUTHORIZED');
      return true;
    }
  );
});

test('request 对非 2xx 响应抛出服务端错误信息', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/orders': { statusCode: 422, data: { error: { message: '订单状态不允许此操作', code: 'INVALID_STATE' } } }
    })
  });

  await assert.rejects(
    () => withWxAsync(stub, () => cloudRequest.request('/api/orders', { method: 'POST' })),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.message, '订单状态不允许此操作');
      return true;
    }
  );
});

test('request 在响应缺少错误信息时给出通用提示', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/orders': { statusCode: 500, data: {} }
    })
  });

  await assert.rejects(
    () => withWxAsync(stub, () => cloudRequest.request('/api/orders')),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.message, '请求失败（500）');
      return true;
    }
  );
});

test('request 透传 method、data 与自定义 header 到云托管调用', async () => {
  const stub = createWxStub({
    initialStorage: {
      campusGoUserToken: 'token',
      campusGoUserTokenExpiresAt: Date.now() + 3600 * 1000
    },
    callContainerHandler: routeHandler({
      '/api/orders': { statusCode: 200, data: { data: { ok: true } } }
    })
  });

  await withWxAsync(stub, () => cloudRequest.request('/api/orders', {
    method: 'POST',
    data: { amount: 199 },
    header: { 'x-trace-id': 'trace_1' }
  }));

  const call = stub.calls.cloudCallContainer[0];
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.data, { amount: 199 });
  assert.equal(call.header['x-trace-id'], 'trace_1', '自定义 header 应被透传');
  assert.equal(call.header['content-type'], 'application/json');
  assert.ok(call.header['X-WX-SERVICE'], '应带上云托管服务名');
});

// ===========================================================================
// 九、utils/product-view —— 商品展示层映射（售卖 / 租赁）
// ===========================================================================
//
// 背景：租赁后端（下单 / 押金隔离 / 归还归位 / 押金结算）早已就绪并有用例覆盖，
// 但展示层此前只认识「售价」，租赁车在列表与详情页里被渲染成一台 3199 元的售卖车。
// 这些映射现在住在纯函数模块里，因此可以在这里真实调用、真实断言。
//
// 两个 fixture 直接对齐 `server/src/store.js` 的种子商品：种子改了字段，
// 这里的断言会立刻反映出来，避免「服务端加了字段、前端却读不到」的静默漂移。

/** 售卖车，对应种子 `prod_ebike_001`。 */
const SALE_PRODUCT = {
  id: 'prod_ebike_001',
  name: '轻风 通勤版',
  priceInCents: 239900,
  effectivePriceInCents: 239900,
  stock: 8,
  availableStock: 8,
  range: '45 km',
  salesCount: 0
};

/** 租赁车，对应种子 `prod_ebike_rent_002`（日租 1500 分、押金 29900 分、租期 1~30 天）。 */
const RENTAL_PRODUCT = {
  id: 'prod_ebike_rent_002',
  name: '远行 租赁版',
  priceInCents: 319900,
  effectivePriceInCents: 319900,
  stock: 5,
  availableStock: 5,
  range: '70 km',
  salesCount: 0,
  listingType: 'RENT',
  rentalPlan: {
    unit: 'DAY',
    unitPriceInCents: 1500,
    minUnits: 1,
    maxUnits: 30,
    depositInCents: 29900
  }
};

test('product-view 售卖车价格文案与改造前一致，且不出现押金与租期', () => {
  const card = productView.toProductCard(SALE_PRODUCT);

  assert.equal(card.listingType, 'SALE');
  assert.equal(card.isRental, false, '售卖车不得被识别为租赁');
  assert.equal(card.priceText, '¥2399', '售卖车价格应取 effectivePriceInCents');
  assert.equal(card.depositText, '', '售卖车不应出现押金');
  assert.equal(card.rentalRangeText, '', '售卖车不应出现租期');
  assert.equal(card.originalPriceText, '', '售卖车不额外透出「原价」（促销原价走 originalPrice）');
  assert.equal(card.range, '45 km', '续航应直接来自商品字段');
});

test('product-view 租赁车按日租金展示，并给出押金与租期', () => {
  const card = productView.toProductCard(RENTAL_PRODUCT);

  assert.equal(card.listingType, 'RENT');
  assert.equal(card.isRental, true);
  assert.equal(card.priceText, '¥15/天', '租赁车价格必须是单位租金而非买断价');
  assert.equal(card.depositText, '押金 ¥299.00', '押金是可退还金额，必须两位小数');
  assert.notEqual(card.depositText, '押金 ¥299', '押金不得去尾零（部分扣除后会对不上账）');
  assert.equal(card.rentalRangeText, '可租 1~30 天');
  assert.ok(card.rentalRangeText.includes('1~30'), '租期文案应含 1~30');
  assert.equal(card.range, '70 km');
});

test('product-view 租赁车的排序价是日租金而不是买断售价（护栏）', () => {
  const rental = productView.toProductCard(RENTAL_PRODUCT);
  const sale = productView.toProductCard(SALE_PRODUCT);

  assert.equal(rental.sortPriceInCents, 1500, '租赁车排序必须用 rentalPlan.unitPriceInCents');
  assert.notEqual(rental.sortPriceInCents, 319900, '排序价绝不能落到买断参考价 319900');
  assert.notEqual(rental.sortPriceInCents, rental.effectivePriceInCents);
  assert.equal(sale.sortPriceInCents, 239900, '售卖车排序仍用 effectivePriceInCents');
});

test('product-view 销量文案区分售卖（已售 N）与租赁（N 辆在租）', () => {
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, salesCount: 12 }).salesText, '已售 12');
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, salesCount: 0 }).salesText, '新品上架');
  assert.equal(productView.toProductCard({ ...RENTAL_PRODUCT, salesCount: 3 }).salesText, '3 辆在租');
  assert.equal(productView.toProductCard({ ...RENTAL_PRODUCT, salesCount: 0 }).salesText, '待租');
});

test('product-view 租赁卡片给「可租赁」角标并额外透出买断参考价', () => {
  const rental = productView.toProductCard(RENTAL_PRODUCT);
  const sale = productView.toProductCard(SALE_PRODUCT);

  assert.equal(rental.badgeText, '可租赁');
  assert.equal(rental.originalPriceText, '原价 ¥3199');
  assert.equal(rental.priceText.includes('3199'), false, '主价格位不得出现裸买断价 3199');
  assert.equal(sale.badgeText, '', '售卖车沿用服务端 badge，未下发时保持与改造前一致');
});

test('product-view 详情页主按钮文案：租赁「立即租赁」，售卖按库存切换', () => {
  assert.equal(productView.toDetailView(RENTAL_PRODUCT).actionText, '立即租赁');
  assert.equal(productView.toDetailView(SALE_PRODUCT).actionText, '立即购买');
  assert.equal(
    productView.toDetailView({ ...SALE_PRODUCT, availableStock: 0 }).actionText,
    '暂无可售'
  );
  assert.equal(
    productView.toDetailView({ ...SALE_PRODUCT, availableStock: undefined, stock: 0 }).actionText,
    '暂无可售',
    '缺少 availableStock 时应回退到 stock'
  );
});

test('product-view 缺省 listingType 一律视为售卖（存量商品向后兼容）', () => {
  const withoutField = { ...SALE_PRODUCT };
  delete withoutField.listingType;

  assert.equal(productView.toProductCard(withoutField).listingType, 'SALE');
  assert.equal(productView.toProductCard(withoutField).isRental, false);
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, listingType: undefined }).listingType, 'SALE');
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, listingType: null }).listingType, 'SALE');
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, listingType: '' }).listingType, 'SALE');
  assert.equal(productView.toProductCard({ ...SALE_PRODUCT, listingType: 'RENTAL' }).listingType, 'SALE');
  assert.equal(productView.toProductCard({ ...RENTAL_PRODUCT, listingType: 'rent' }).listingType, 'RENT');
  assert.equal(productView.toDetailView(withoutField).actionText, '立即购买');
});

test('product-view 计费单位为小时时展示「小时」', () => {
  const hourly = {
    ...RENTAL_PRODUCT,
    rentalPlan: { unit: 'HOUR', unitPriceInCents: 500, minUnits: 1, maxUnits: 8, depositInCents: 9900 }
  };

  assert.equal(productView.toProductCard(hourly).priceText, '¥5/小时');
  assert.equal(productView.toProductCard(hourly).depositText, '押金 ¥99.00', '按小时租的押金同样两位小数');
  assert.equal(productView.toProductCard(hourly).rentalRangeText, '可租 1~8 小时');
  assert.equal(productView.toDetailView(hourly).rentalUnitLabel, '小时');
  assert.equal(productView.toDetailView(hourly).headlineText, '校内取还 · 按小时计费');
  // 服务端只允许 DAY / HOUR，脏单位一律兜底为「天」，不允许出现空白单位。
  assert.equal(productView.rentalUnitLabel('WEEK'), '天');
});

test('product-view 展示精度口径：报价去尾零、押金固定两位小数（防精度用反）', () => {
  const rentalCard = productView.toProductCard(RENTAL_PRODUCT);
  const rentalDetail = productView.toDetailView(RENTAL_PRODUCT);
  const saleCard = productView.toProductCard(SALE_PRODUCT);

  // 报价（售价 / 单位租金 / 买断参考价）：整数元、去尾零
  assert.equal(rentalCard.priceText, '¥15/天');
  assert.notEqual(rentalCard.priceText, '¥15.00/天', '单位租金是报价，不得带两位小数');
  assert.equal(rentalDetail.priceText, '¥15/天');
  assert.notEqual(rentalDetail.priceText, '¥15.00/天', '详情页单位租金同样不得带两位小数');
  assert.equal(saleCard.priceText, '¥2399');
  assert.notEqual(saleCard.priceText, '¥2399.00', '售价是报价，不得带两位小数');
  assert.equal(rentalCard.originalPriceText, '原价 ¥3199');
  assert.notEqual(rentalCard.originalPriceText, '原价 ¥3199.00', '买断参考价是报价，不得带两位小数');

  // 押金（可退还、可被部分扣除）：固定两位小数
  assert.equal(rentalCard.depositText, '押金 ¥299.00');
  assert.equal(rentalDetail.depositText, '押金 ¥299.00');

  // 精度参数本身：默认去尾零，显式传两位则补零；用反了会被上面两条抓住
  assert.equal(productView.YUAN_QUOTE_DIGITS, 0);
  assert.equal(productView.YUAN_EXACT_DIGITS, 2);
  assert.equal(productView.formatYuan(29900), '299');
  assert.equal(productView.formatYuan(29900, productView.YUAN_EXACT_DIGITS), '299.00');
  assert.equal(productView.formatYuan(1500, productView.YUAN_EXACT_DIGITS), '15.00');
  assert.equal(productView.formatYuan(29949, productView.YUAN_EXACT_DIGITS), '299.49');
  assert.equal(productView.formatYuan(29949), '299.49');
});

test('product-view 「价格优先」排序按单位租金：日租 1500 排在日租 2000 之前（护栏）', () => {
  // 刻意让「日租便宜的那辆」买断价更贵：只要排序口径退回买断售价，顺序必然反转。
  const cheaperPerDaySource = {
    ...RENTAL_PRODUCT,
    id: 'rent_cheap',
    priceInCents: 319900,
    effectivePriceInCents: 319900,
    rentalPlan: { ...RENTAL_PRODUCT.rentalPlan, unitPriceInCents: 1500 }
  };
  const pricierPerDaySource = {
    ...RENTAL_PRODUCT,
    id: 'rent_pricey',
    priceInCents: 199900,
    effectivePriceInCents: 199900,
    rentalPlan: { ...RENTAL_PRODUCT.rentalPlan, unitPriceInCents: 2000 }
  };
  const cheaperPerDay = productView.toProductCard(cheaperPerDaySource);
  const pricierPerDay = productView.toProductCard(pricierPerDaySource);

  const byUnitRent = [pricierPerDay, cheaperPerDay].sort((a, b) => a.sortPriceInCents - b.sortPriceInCents);
  assert.deepEqual(byUnitRent.map((item) => item.sortPriceInCents), [1500, 2000]);
  assert.deepEqual(byUnitRent.map((item) => item.priceText), ['¥15/天', '¥20/天']);

  // 反证：若沿用改造前的 `item.price`（= effectivePriceInCents / 100）排序，顺序会反过来 ——
  // 说明这条护栏真的在起作用，而不是恰好两种口径同序。
  const bySalePrice = [cheaperPerDaySource, pricierPerDaySource]
    .sort((a, b) => a.effectivePriceInCents - b.effectivePriceInCents);
  assert.deepEqual(
    bySalePrice.map((item) => item.effectivePriceInCents),
    [199900, 319900],
    '按买断售价排序会得到相反顺序，因此排序口径必须显式区分'
  );
});

test('product-view 续航直接来自商品字段，缺省为空且不再按 ID 编造', () => {
  const withoutRange = { ...SALE_PRODUCT };
  delete withoutRange.range;

  assert.equal(productView.toProductCard(withoutRange).range, '');
  assert.equal(productView.toDetailView(withoutRange).range, '');
  assert.equal(productView.toProductCard({ ...RENTAL_PRODUCT, range: undefined }).range, '');
  assert.equal(productView.toDetailView({ ...SALE_PRODUCT, range: '60 km' }).range, '60 km');
});

test('product-view 租赁详情页服务承诺文案不含「购车」', () => {
  const rental = productView.toDetailView(RENTAL_PRODUCT);
  const sale = productView.toDetailView(SALE_PRODUCT);

  assert.equal(rental.service.some((item) => item.includes('购车')), false, '租赁服务承诺不得出现「购车」');
  assert.equal(rental.platePromiseDetail.includes('购车'), false, '租赁牌照承诺不得出现「购车」');
  assert.equal(rental.policy.includes('购车'), false, '租赁校区适配不得出现「购车」');
  assert.equal(rental.deliveryPromiseDetail.includes('配送'), false, '租赁车应说「取还」而不是「配送」');
  // 回归：售卖车的服务承诺保持改造前文案。
  assert.ok(sale.service.includes('平台购车牌照辅助'));
  assert.equal(sale.platePromiseDetail, '平台购车免费辅助上牌');
});

test('product-view 租赁详情页渲染押金、租期与计费单位', () => {
  const rental = productView.toDetailView(RENTAL_PRODUCT);
  const sale = productView.toDetailView(SALE_PRODUCT);

  assert.equal(rental.priceText, '¥15/天');
  assert.equal(rental.depositText, '押金 ¥299.00', '详情页押金固定两位小数');
  assert.equal(rental.rentalRangeText, '可租 1~30 天');
  assert.equal(rental.rentalUnitLabel, '天');
  assert.equal(rental.headlineText, '校内取还 · 按天计费');
  assert.equal(rental.badgeText, '可租赁');
  assert.equal(sale.headlineText, '校内配送 · 可协助上牌', '售卖车底部栏文案保持改造前一致');
  assert.equal(sale.badgeText, '校园专享');
});

// ===========================================================================
// 十、utils/product-view —— 结算页租期与费用拆分（T38）
// ===========================================================================
//
// 背景：结算页 `checkout.js` 顶层调用 `Page()`，Node 无法加载，因此「选 3 天要付多少」
// 这类**直接决定用户付多少钱**的逻辑被抽成纯函数，在这里真实调用、真实断言。
//
// 口径与 `server/src/app.js` 建单逻辑逐字对齐：
//   租金合计 = 单位租金 × 租期；押金每单固定一份；应付合计 = 租金 + 押金 + 配送费。
// ★ 押金**绝不**并入租金合计（服务端 L1 防线要求押金不进 `subtotalInCents`）。

test('computeRentalFees 租 3 天：租金 4500 + 押金 29900 + 免配送 = 34400（与服务端一致）', () => {
  const plan = RENTAL_PRODUCT.rentalPlan;
  const fees = productView.computeRentalFees({ rentalPlan: plan, rentalUnits: 3, deliveryFeeInCents: 0 });

  // ① 应付合计
  assert.equal(fees.totalInCents, 34400, '应付合计应为 租金4500 + 押金29900 + 配送0');
  // ② 三项拆分
  assert.equal(fees.rentInCents, 4500, '租金合计 = 单位租金1500 × 租期3');
  assert.equal(fees.depositInCents, 29900, '押金每单固定一份');
  assert.equal(fees.deliveryFeeInCents, 0, '免配送时配送费为 0');
  // ⑪ 反证：押金绝不并入租金（用原始方案单价，而非计算结果回代）
  assert.equal(fees.rentInCents, plan.unitPriceInCents * 3, '租金只由单位租金×租期构成');
  assert.notEqual(fees.rentInCents, fees.depositInCents, '押金不得被并入租金合计');
  assert.notEqual(fees.rentInCents, 34400, '租金合计不得包含押金');
  // ⑫ 反证：合计恒等式
  assert.equal(
    fees.totalInCents,
    plan.unitPriceInCents * 3 + plan.depositInCents + 0,
    '合计 = 单位租金×租期 + 押金 + 配送费'
  );
});

test('computeRentalFees 金额文案：租金/合计按报价去尾零，押金固定两位小数', () => {
  const fees = productView.computeRentalFees({ rentalPlan: RENTAL_PRODUCT.rentalPlan, rentalUnits: 3, deliveryFeeInCents: 0 });

  // ③ 押金两位小数 + 租金整数元（报价口径），并用反证钉住「精度不能用反」
  assert.equal(fees.depositText, '¥299.00', '押金是可退还金额，必须两位小数');
  assert.equal(fees.rentText, '¥45', '租金合计是报价，整数元去尾零');
  assert.notEqual(fees.rentText, '¥45.00', '租金不得带两位小数（精度用反了要能抓住）');
  assert.equal(fees.totalText, '¥344', '应付合计按报价口径展示');
  assert.equal(fees.deliveryFeeText, '免费', '免配送时展示「免费」而不是 ¥0');
});

test('computeRentalFees 押金说明必须显式告知「原路退回」与「不计入商家分账」', () => {
  const fees = productView.computeRentalFees({ rentalPlan: RENTAL_PRODUCT.rentalPlan, rentalUnits: 1, deliveryFeeInCents: 0 });

  // ④ 押金必须被显式说明，避免用户以为押金是消费
  assert.ok(fees.depositNoticeText.includes('原路退回'), '押金说明必须写明原路退回');
  assert.ok(fees.depositNoticeText.includes('不计入商家分账'), '押金说明必须写明不计入商家分账');
  assert.ok(fees.depositNoticeText.includes('¥299.00'), '押金说明中的金额与押金行同精度');
});

test('computeRentalFees 含配送费时合计 = 租金 + 押金 + 配送费', () => {
  const deliveryFeeInCents = 500;
  const fees = productView.computeRentalFees({ rentalPlan: RENTAL_PRODUCT.rentalPlan, rentalUnits: 3, deliveryFeeInCents });

  // ⑤ 配送费是「加项」，不能挤占租金或押金
  assert.equal(fees.totalInCents, 4500 + 29900 + deliveryFeeInCents, '合计必须叠加配送费');
  assert.equal(fees.deliveryFeeInCents, deliveryFeeInCents, '配送费原样透出');
  assert.equal(fees.deliveryFeeText, '¥5', '有配送费时展示金额');
});

test('computeRentalDueAt 按天/按小时计算到期时间，且不编造服务端不存在的免罚宽限', () => {
  const dayBase = new Date('2026-09-20T10:00:00');
  const dayDue = productView.computeRentalDueAt(3, 'DAY', dayBase);
  // ⑥ 租 3 天 = 精确 +72 小时
  assert.equal(new Date(dayDue.dueAt).getTime() - dayBase.getTime(), 3 * 24 * 60 * 60 * 1000, '租 3 天应精确 +72 小时');
  assert.ok(dayDue.dueAtText.includes('前归还'), '到期文案应说明归还时点');
  assert.equal(dayDue.dueAtText.includes('免罚'), false, '服务端没有宽限字段，前端不得编造免罚');

  const hourBase = new Date('2026-09-20T10:00:00');
  const hourDue = productView.computeRentalDueAt(2, 'HOUR', hourBase);
  // ⑦ 租 2 小时 = 精确 +2 小时
  assert.equal(new Date(hourDue.dueAt).getTime() - hourBase.getTime(), 2 * 60 * 60 * 1000, '租 2 小时应精确 +2 小时');
  assert.ok(hourDue.dueAtText.includes('前归还'), '按小时租同样展示归还时点');
});

test('stepRentalUnits 越界不增加/不减少，被拒时保持原值', () => {
  const plan = RENTAL_PRODUCT.rentalPlan;

  // ⑧ 超出上限
  const atMax = productView.stepRentalUnits({ rentalPlan: plan, rentalUnits: 30, action: 'increase' });
  assert.equal(atMax.accepted, false, '到达上限后不可再增加');
  assert.equal(atMax.rentalUnits, 30, '被拒绝时租期必须保持原值');
  assert.ok(atMax.message.includes('最多'), '应提示上限');

  // ⑧ 低于下限
  const atMin = productView.stepRentalUnits({ rentalPlan: plan, rentalUnits: 1, action: 'decrease' });
  assert.equal(atMin.accepted, false, '到达下限后不可再减少');
  assert.equal(atMin.rentalUnits, 1, '被拒绝时租期必须保持原值');
  assert.ok(atMin.message.includes('至少'), '应提示下限');

  // 正常步进
  const stepped = productView.stepRentalUnits({ rentalPlan: plan, rentalUnits: 3, action: 'increase' });
  assert.equal(stepped.accepted, true, '区间内应允许增加');
  assert.equal(stepped.rentalUnits, 4);
});

test('stepRentalUnits 在 minUnits === maxUnits 时选择器整体不可用', () => {
  const fixedPlan = { ...RENTAL_PRODUCT.rentalPlan, minUnits: 3, maxUnits: 3 };

  // ⑨ 固定租期：两个方向都不可改变
  for (const action of ['increase', 'decrease']) {
    const result = productView.stepRentalUnits({ rentalPlan: fixedPlan, rentalUnits: 3, action });
    assert.equal(result.accepted, false, `${action} 不应改变固定租期`);
    assert.equal(result.locked, true, '固定租期应标记为锁定（选择器整体不可用）');
    assert.equal(result.rentalUnits, 3, '固定租期必须保持原值');
  }
});

test('computeRentalFees 对售卖商品返回 null，调用方据此走售卖分支', () => {
  // ⑩ 非租赁一律返回 null（而不是算出一堆 0 误导调用方）
  assert.equal(productView.computeRentalFees({ rentalPlan: null, rentalUnits: 1, deliveryFeeInCents: 0 }), null);
  assert.equal(productView.computeRentalFees({}), null);
  assert.equal(productView.computeRentalFees(), null);
  assert.equal(productView.computeRentalFees({ rentalPlan: SALE_PRODUCT.rentalPlan, rentalUnits: 1, deliveryFeeInCents: 0 }), null);
  assert.equal(productView.stepRentalUnits({ rentalPlan: null, rentalUnits: 1, action: 'increase' }), null);
});

test('computeRentalFees 同时接受商品对象、原始方案与 readRentalPlan 的输出', () => {
  const fromProduct = productView.computeRentalFees({ rentalPlan: RENTAL_PRODUCT, rentalUnits: 3, deliveryFeeInCents: 0 });
  const fromPlan = productView.computeRentalFees({ rentalPlan: RENTAL_PRODUCT.rentalPlan, rentalUnits: 3, deliveryFeeInCents: 0 });
  const fromRead = productView.computeRentalFees({ rentalPlan: productView.readRentalPlan(RENTAL_PRODUCT), rentalUnits: 3, deliveryFeeInCents: 0 });

  assert.equal(fromProduct.totalInCents, 34400, '传整个商品对象时应自动取其 rentalPlan');
  assert.equal(fromPlan.totalInCents, 34400, '传原始 rentalPlan 时应直接使用');
  assert.equal(fromRead.totalInCents, 34400, '传 readRentalPlan 的输出时应可直接使用');
});

test('computeRentalFees 对越界租期做夹取，绝不会用非法租期算钱', () => {
  const plan = RENTAL_PRODUCT.rentalPlan;
  const tooMany = productView.computeRentalFees({ rentalPlan: plan, rentalUnits: 999, deliveryFeeInCents: 0 });
  const tooFew = productView.computeRentalFees({ rentalPlan: plan, rentalUnits: 0, deliveryFeeInCents: 0 });

  assert.equal(tooMany.rentalUnits, 30, '超上限应夹取到 maxUnits');
  assert.equal(tooMany.rentInCents, 1500 * 30, '夹取后的租金按上限计算');
  assert.equal(tooFew.rentalUnits, 1, '低于下限应夹取到 minUnits');
  assert.equal(tooFew.rentInCents, 1500, '夹取后的租金按下限计算');
});

test('computeRentalFees 按小时计费（单位与押金精度同时校验）', () => {
  const hourlyPlan = { unit: 'HOUR', unitPriceInCents: 500, minUnits: 1, maxUnits: 8, depositInCents: 9900 };
  const fees = productView.computeRentalFees({ rentalPlan: hourlyPlan, rentalUnits: 2, deliveryFeeInCents: 0 });

  assert.equal(fees.rentInCents, 1000, '按小时：500 × 2');
  assert.equal(fees.depositInCents, 9900);
  assert.equal(fees.totalInCents, 10900);
  assert.equal(fees.rentText, '¥10');
  assert.equal(fees.depositText, '¥99.00', '按小时租的押金同样两位小数');
});

// ===========================================================================
// 十一、utils/rental-journey —— 租赁订单页（进度条 / 应还倒计时 / 归还入口）
// ===========================================================================
//
// 背景：`orders.js` 把所有订单硬编码成 `type: 'E_BIKE'`，进度条因此走 `ebikeJourney`，
// 租赁单会显示「校内配送 / 凭交付码收车」这类售卖文案。这些分支现在住在纯函数里，
// 可以在这里真实调用、真实断言 —— 而不是对页面做源码文本断言。

/** 租赁订单（`/api/my/orders` 的 `ebikeOrders[]` 元素形态）。 */
const RENTAL_ORDER = {
  id: 'ord_rent_1',
  orderKind: 'RENTAL',
  type: 'E_BIKE',
  status: 'FULFILLING',
  rental: {
    status: 'RENTING',
    units: 3,
    unit: 'DAY',
    rentAmountInCents: 4500,
    depositInCents: 29900,
    dueAt: '2026-09-23T10:00:00'
  }
};

/** 售卖订单（无 `orderKind`，存量形态）。 */
const SALE_ORDER = { id: 'ord_sale_1', type: 'E_BIKE', status: 'FULFILLING' };

test('buildRentalJourney：RENTING → 第 2 步为当前步，第 1 步已完成', () => {
  const journey = rentalJourney.buildRentalJourney(RENTAL_ORDER);

  assert.equal(journey.length, 4, '租赁进度条固定 4 步');
  assert.deepEqual(
    journey.map((step) => step.title),
    ['已支付待取车', '租期中', '申请归还', '归还完成'],
    '文案必须是租赁语义，不得出现「校内配送 / 凭交付码收车」'
  );
  assert.deepEqual(journey.map((step) => step.done), [true, false, false, false], '仅第 1 步完成');
  assert.deepEqual(journey.map((step) => step.current), [false, true, false, false], '第 2 步为当前步');
});

test('buildRentalJourney：RETURN_REQUESTED → 第 3 步为当前步', () => {
  const journey = rentalJourney.buildRentalJourney({
    ...RENTAL_ORDER,
    rental: { ...RENTAL_ORDER.rental, status: 'RETURN_REQUESTED' }
  });

  assert.deepEqual(journey.map((step) => step.done), [true, true, false, false]);
  assert.deepEqual(journey.map((step) => step.current), [false, false, true, false]);
});

test('buildRentalJourney：RETURNED → 第 4 步为当前步，前 3 步均已完成', () => {
  const journey = rentalJourney.buildRentalJourney({
    ...RENTAL_ORDER,
    rental: { ...RENTAL_ORDER.rental, status: 'RETURNED' }
  });

  assert.deepEqual(journey.map((step) => step.done), [true, true, true, false], '前 3 步完成');
  assert.deepEqual(journey.map((step) => step.current), [false, false, false, true], '第 4 步为当前步');
});

test('rentalCountdownText：距应还 2 天 3 小时', () => {
  const now = new Date('2026-09-20T07:00:00');
  const text = rentalJourney.rentalCountdownText('2026-09-22T10:00:00', now);

  assert.ok(text.includes('2 天'), `应含「2 天」，实际：${text}`);
  assert.ok(text.includes('3 小时'), `应含「3 小时」，实际：${text}`);
  assert.ok(text.includes('还有'), '未逾期应说「还有」');
});

test('rentalCountdownText：已逾期时出现「逾期」且不出现「还有」', () => {
  const now = new Date('2026-09-20T07:00:00');
  const text = rentalJourney.rentalCountdownText('2026-09-19T10:00:00', now);

  assert.ok(text.includes('逾期'), `应含「逾期」，实际：${text}`);
  assert.equal(text.includes('还有'), false, '逾期不得说「还有」');
});

test('rentalCardText：押金两位小数、单位租金报价精度（精度不得用反）', () => {
  const card = rentalJourney.rentalCardText(RENTAL_ORDER);

  assert.equal(card.priceText, '¥15/天', '单位租金是报价，取整去尾零');
  assert.notEqual(card.priceText, '¥15.00/天', '单位租金不得带两位小数（精度用反要能抓住）');
  assert.equal(card.depositText, '¥299.00', '押金是可退还金额，固定两位小数');
  assert.notEqual(card.depositText, '¥299', '押金不得去尾零');
  assert.equal(card.termText, '共 3 天', '租期文案应含单位与数量');
  assert.ok(card.dueAtText.includes('前归还'), '应给出应还时点');

  // 已归还后不再展示「应还时间」：车已还、账已结，再显示「…前归还」会误导。
  const returned = rentalJourney.rentalCardText({ ...RENTAL_ORDER, rental: { ...RENTAL_ORDER.rental, status: 'RETURNED' } });
  assert.equal(returned.dueAtText, '', '已归还的订单不得再展示应还时间');
  assert.equal(returned.depositText, '¥299.00', '已归还后押金金额仍需展示（待退回）');
});

test('buildRentalJourney：售卖订单返回空数组（防误用）', () => {
  assert.deepEqual(rentalJourney.buildRentalJourney(SALE_ORDER), []);
  assert.deepEqual(
    rentalJourney.buildRentalJourney({ orderKind: 'SALE', rental: RENTAL_ORDER.rental }),
    [],
    '声明 SALE 的订单即使带 rental 也不得走租赁进度条'
  );
});

test('selectOrderJourney：售卖订单仍走 ebikeJourney（回归护栏）', () => {
  const ebikeJourney = { FULFILLING: [{ title: '校内配送中' }, { title: '交付核验' }] };
  const afterSaleJourney = { REVIEWING: [{ title: '售后处理中' }] };

  assert.deepEqual(
    rentalJourney.selectOrderJourney({
      order: SALE_ORDER, isEbike: true, status: 'FULFILLING', activeAfterSale: null, ebikeJourney, afterSaleJourney
    }),
    ebikeJourney.FULFILLING,
    '售卖单必须仍取 ebikeJourney'
  );
  assert.deepEqual(
    rentalJourney.selectOrderJourney({
      order: SALE_ORDER, isEbike: true, status: 'FULFILLING',
      activeAfterSale: { status: 'REVIEWING' }, ebikeJourney, afterSaleJourney
    }),
    afterSaleJourney.REVIEWING,
    '进行中的售后仍优先于订单进度条'
  );

  const rental = rentalJourney.selectOrderJourney({
    order: RENTAL_ORDER, isEbike: true, status: 'FULFILLING', activeAfterSale: null, ebikeJourney, afterSaleJourney
  });
  assert.equal(rental.length, 4, '租赁单必须走 4 步租赁进度条');
  assert.notEqual(rental[0].title, '校内配送中', '租赁单绝不能落到售卖进度条');

  assert.deepEqual(
    rentalJourney.selectOrderJourney({ order: { type: 'PLATE' }, isEbike: false, status: 'MATERIAL_PENDING', ebikeJourney, afterSaleJourney }),
    [],
    '非电瓶车服务单保持空进度条'
  );
});

test('buildRentalJourney：rental.status 未知时不抛错且降级为空数组', () => {
  assert.doesNotThrow(() => rentalJourney.buildRentalJourney({ orderKind: 'RENTAL', rental: { status: 'WEIRD' } }));
  assert.deepEqual(rentalJourney.buildRentalJourney({ orderKind: 'RENTAL', rental: { status: 'WEIRD' } }), [], '未知状态不得猜');
  assert.deepEqual(rentalJourney.buildRentalJourney({ orderKind: 'RENTAL' }), [], '缺 rental 时降级');
  assert.deepEqual(rentalJourney.buildRentalJourney({ orderKind: 'RENTAL', rental: null }), []);
  assert.deepEqual(rentalJourney.buildRentalJourney(null), []);
  assert.deepEqual(rentalJourney.buildRentalJourney(), []);
});

test('canRequestReturn：仅租赁单且 RENTING 才可申请归还', () => {
  assert.equal(rentalJourney.canRequestReturn(RENTAL_ORDER), true);
  assert.equal(
    rentalJourney.canRequestReturn({ ...RENTAL_ORDER, rental: { ...RENTAL_ORDER.rental, status: 'RETURN_REQUESTED' } }),
    false,
    '已申请归还不可重复申请'
  );
  assert.equal(
    rentalJourney.canRequestReturn({ ...RENTAL_ORDER, rental: { ...RENTAL_ORDER.rental, status: 'RETURNED' } }),
    false,
    '已归还不能申请'
  );
  assert.equal(rentalJourney.canRequestReturn(SALE_ORDER), false, '售卖单没有归还入口');
  assert.equal(rentalJourney.canRequestReturn({}), false);
  assert.equal(rentalJourney.canRequestReturn(null), false);
});

test('shouldRefreshCountdown：无待支付订单但有租赁单时仍须刷新', () => {
  assert.equal(rentalJourney.shouldRefreshCountdown([RENTAL_ORDER]), true, '租赁应还倒计时需要走秒');
  assert.equal(
    rentalJourney.shouldRefreshCountdown([{ status: 'PENDING_PAYMENT', paymentExpiresAt: '2026-09-20T08:00:00' }]),
    true,
    '待支付倒计时需要走秒'
  );
  assert.equal(
    rentalJourney.shouldRefreshCountdown([RENTAL_ORDER, { status: 'PENDING_PAYMENT', paymentExpiresAt: '2026-09-20T08:00:00' }]),
    true,
    '两类倒计时并存时同样刷新'
  );
  assert.equal(rentalJourney.shouldRefreshCountdown([{ orderKind: 'SALE', status: 'COMPLETED' }]), false, '无倒计时来源时不必刷新');
  assert.equal(
    rentalJourney.shouldRefreshCountdown([{ ...RENTAL_ORDER, rental: { ...RENTAL_ORDER.rental, status: 'RETURNED' } }]),
    false,
    '已归还不必再走秒'
  );
  assert.equal(rentalJourney.shouldRefreshCountdown([]), false);
  assert.equal(rentalJourney.shouldRefreshCountdown(), false);
});

test('orderKind 缺失时一律视为售卖（存量订单向后兼容）', () => {
  const legacy = { id: 'ord_old', type: 'E_BIKE', status: 'FULFILLING' };

  assert.equal(rentalJourney.isRentalOrder(legacy), false);
  assert.deepEqual(rentalJourney.buildRentalJourney(legacy), []);
  assert.equal(rentalJourney.rentalCardText(legacy), null);
  assert.equal(rentalJourney.canRequestReturn(legacy), false);
  assert.equal(rentalJourney.isRentalOrder({ orderKind: undefined }), false);
  assert.equal(rentalJourney.isRentalOrder({ orderKind: '' }), false);
  assert.equal(rentalJourney.isRentalOrder({ orderKind: 'SALE' }), false);
  assert.equal(rentalJourney.isRentalOrder({ orderKind: 'RENT' }), false, '非 RENTAL 不视为租赁');
  assert.equal(rentalJourney.isRentalOrder({ orderKind: 'RENTAL' }), true);
  assert.equal(rentalJourney.isRentalOrder({ orderKind: ' rental ' }), true, '大小写与空格做归一化');
});

test('rentalCardText / rentalCountdownText 对非法输入安全降级', () => {
  assert.equal(rentalJourney.rentalCardText(SALE_ORDER), null);
  assert.equal(rentalJourney.rentalCardText(null), null);
  assert.equal(rentalJourney.rentalCardText({ orderKind: 'RENTAL' }), null, '缺 rental 时不得抛错');
  assert.equal(rentalJourney.rentalCountdownText(''), '');
  assert.equal(rentalJourney.rentalCountdownText('not-a-date'), '');
  assert.equal(rentalJourney.rentalCountdownText(undefined), '');
  assert.equal(rentalJourney.rentalCountdownText(null), '');
  assert.equal(rentalJourney.isRentalOverdue('not-a-date'), false);
  assert.equal(rentalJourney.isRentalOverdue(''), false);
});

test('rentalCardText 按小时租：单位与精度同时正确', () => {
  const hourly = {
    ...RENTAL_ORDER,
    rental: { status: 'RENTING', units: 2, unit: 'HOUR', rentAmountInCents: 1000, depositInCents: 9900, dueAt: '2026-09-20T12:00:00' }
  };
  const card = rentalJourney.rentalCardText(hourly);

  assert.equal(card.priceText, '¥5/小时');
  assert.equal(card.termText, '共 2 小时');
  assert.equal(card.depositText, '¥99.00', '按小时租的押金同样两位小数');
});

test('★ 洞口已关闭：未支付租赁单不点亮任何一步，且不可申请归还', () => {
  // 本条原先是一条**特征化断言**，把「未支付单被标成已支付待取车」的缺陷钉住，
  // 等 team-lead 裁决。裁决走「服务端根因」后，服务端已改为：
  //   建单 ⇒ `rental.status = 'PENDING_PAYMENT'`、`dueAt = null`（占用，不消耗租期）
  //   支付 ⇒ `startRental()` 置 `'RENTING'` 并按支付时刻起算 `dueAt`
  // 于是这里翻面：从「记录已知缺口」改为「断言洞口已关闭」。
  //
  // 未支付租赁单的**真实形态**（与 server/src/app.js 建单分支逐字对齐）：
  const unpaid = {
    ...RENTAL_ORDER,
    status: 'PENDING_PAYMENT',
    rental: { ...RENTAL_ORDER.rental, status: 'PENDING_PAYMENT', dueAt: null }
  };
  const journey = rentalJourney.buildRentalJourney(unpaid);

  // 仍渲染 4 步：空数组是「非租赁 / 状态无法识别」的降级表示，
  // 未支付租赁单若也返回空数组，就再也分不出它和普通售卖单。
  assert.equal(journey.length, 4, '租赁流程照常渲染 4 步，不退化成售卖单的空进度条');
  assert.deepEqual(journey.map((step) => step.done), [false, false, false, false],
    '未支付时没有任何一步可标为已完成（尤其第 1 步「已支付待取车」）');
  assert.deepEqual(journey.map((step) => step.current), [false, false, false, false],
    '未支付时没有「当前步骤」——租期还没开始');

  // 与服务端状态机对齐：`RETURN_REQUEST` 只允许 `RENTING` 起，未支付自动落在拒绝侧。
  assert.equal(rentalJourney.canRequestReturn(unpaid), false, '未支付不得申请归还');

  // 租期未起算 ⇒ 不得展示应还时间，也不该为它走秒。
  assert.equal(rentalJourney.rentalCardText(unpaid).dueAtText, '', 'dueAt 为 null 时不展示应还时间');
  assert.equal(rentalJourney.rentalCountdownText(unpaid.rental.dueAt, new Date()), '', 'dueAt 为 null 时倒计时文案为空');
  assert.equal(rentalJourney.shouldRefreshCountdown([unpaid]), false, '没有 dueAt 就不需要为它刷新倒计时');
});

test('支付成功后（RENTING + dueAt 已写入）恢复正常渲染与归还入口', () => {
  // 上一条断言「未支付被拦住」，这一条断言「支付后不会被误伤」——
  // 否则一个过宽的守卫会让真实租赁单永远点不了「申请归还」。
  const paid = {
    ...RENTAL_ORDER,
    status: 'PAID',
    rental: { ...RENTAL_ORDER.rental, status: 'RENTING', dueAt: '2026-09-23T10:00:00' }
  };

  assert.deepEqual(
    rentalJourney.buildRentalJourney(paid).map((step) => step.done),
    [true, false, false, false],
    '支付后第 1 步「已支付待取车」才被标为已完成'
  );
  assert.equal(rentalJourney.canRequestReturn(paid), true, '支付后可以申请归还');
  assert.equal(rentalJourney.rentalCardText(paid).dueAtText, '9月23日 10:00 前归还', '支付后展示应还时间');
  assert.equal(rentalJourney.shouldRefreshCountdown([paid]), true, '支付后应还倒计时需要走秒');
});

// ===========================================================================
// T40：商家端租赁动作（核验取车 / 核验归还）
// ===========================================================================
//
// 现状缺口：用户能租、能申请归还，但**商家点不到按钮** —— 用户申请归还后
// 没人核验，订单永远停在 `RETURN_REQUESTED`。这是租赁在界面上可用的最后一环。
//
// 「核验归还」的显示条件必须同时看两件事：`orderKind === 'RENTAL'` **与**
// `rental.status === 'RETURN_REQUESTED'`，任一不满足都不能出现按钮 ——
// 只认 `rental.status` 会让带 `rental` 字段的售卖单冒出归还按钮。

/** 租赁单：用户已申请归还（商家应看到「核验归还」）。 */
const RENTAL_RETURN_REQUESTED = {
  ...RENTAL_ORDER,
  status: 'FULFILLING',
  rental: { ...RENTAL_ORDER.rental, status: 'RETURN_REQUESTED' }
};

/** 租赁单：用户已归还（按钮必须消失，防重复提交）。 */
const RENTAL_RETURNED = {
  ...RENTAL_ORDER,
  status: 'COMPLETED',
  rental: { ...RENTAL_ORDER.rental, status: 'RETURNED' }
};

test('① canVerifyRentalReturn：用户已申请归还的租赁单 → true', () => {
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL', rental: { status: 'RETURN_REQUESTED' } }),
    true,
    '用户申请归还后商家必须能看到核验入口，否则订单永远停在 RETURN_REQUESTED'
  );
  assert.equal(rentalJourney.canVerifyRentalReturn(RENTAL_RETURN_REQUESTED), true);
});

test('② canVerifyRentalReturn：租期中（RENTING）→ false（用户还没申请归还）', () => {
  assert.equal(rentalJourney.canVerifyRentalReturn(RENTAL_ORDER), false, 'RENTING 阶段没有东西可核验');
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL', rental: { status: 'RENTING' } }),
    false
  );
});

test('③ canVerifyRentalReturn：已归还（RETURNED）→ false（防重复提交）', () => {
  assert.equal(rentalJourney.canVerifyRentalReturn(RENTAL_RETURNED), false);
  // 服务端对重复核验回 409 RENTAL_ALREADY_RETURNED，前端不该给出可点入口。
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL', rental: { status: 'RETURNED' } }),
    false
  );
});

test('④ ★ canVerifyRentalReturn：售卖单一律 false（绝不出现归还按钮）', () => {
  assert.equal(rentalJourney.canVerifyRentalReturn(SALE_ORDER), false, '售卖单没有归还概念');
  // 关键负例：一张声明为 SALE 却恰好带 rental 字段的订单（数据损坏 / 字段复用）。
  // 只认 `rental.status` 的实现会在这里返回 true，等于在售卖单上开了资损级入口。
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ orderKind: 'SALE', rental: { status: 'RETURN_REQUESTED' } }),
    false,
    'orderKind 必须参与判定，不能只看 rental.status'
  );
});

test('⑤ canVerifyRentalReturn：orderKind 缺失 → false（向后兼容存量订单）', () => {
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ rental: { status: 'RETURN_REQUESTED' } }),
    false,
    '存量订单没有 orderKind，缺省即售卖'
  );
  assert.equal(rentalJourney.canVerifyRentalReturn({}), false);
  assert.equal(rentalJourney.canVerifyRentalReturn(null), false);
  assert.equal(rentalJourney.canVerifyRentalReturn(undefined), false);
});

test('⑨ canVerifyRentalReturn：未知 rental.status → false 且不抛错', () => {
  assert.equal(
    rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL', rental: { status: 'SOMETHING_NEW' } }),
    false,
    '状态未知即降级为「不显示」，绝不猜'
  );
  // 形态损坏：声明 RENTAL 但没有 rental 对象 —— 不能抛异常（页面会白屏）。
  assert.equal(rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL' }), false);
  assert.equal(rentalJourney.canVerifyRentalReturn({ orderKind: 'RENTAL', rental: null }), false);
});

test('⑥ merchantRentalNextStep：RETURN_REQUESTED 时含「归还」', () => {
  const text = rentalJourney.merchantRentalNextStep(RENTAL_RETURN_REQUESTED);
  assert.ok(text.includes('归还'), `归还阶段文案应含「归还」，实际「${text}」`);
  // 这一阶段商家要做的就是核验，文案必须指向这个动作。
  assert.ok(text.includes('核验'), `归还阶段文案应含「核验」，实际「${text}」`);
  assert.equal(text, '用户已申请归还，请核验车辆后确认归还');
});

test('⑦ ★ 租赁文案绝不出现「配送」（租赁是取车不是配送）', () => {
  // 改造前商家端所有订单都走 `nextSteps[order.status]`，租赁单在 FULFILLING 时
  // 显示「核验交付码并完成配送」—— 对租赁是错的。
  const rentalPhases = [
    RENTAL_ORDER,                                              // RENTING + FULFILLING
    { ...RENTAL_ORDER, status: 'PAID' },                       // RENTING + PAID
    RENTAL_RETURN_REQUESTED,
    RENTAL_RETURNED,
    { ...RENTAL_ORDER, status: 'PENDING_PAYMENT', rental: { ...RENTAL_ORDER.rental, status: 'PENDING_PAYMENT', dueAt: null } }
  ];
  for (const order of rentalPhases) {
    const text = rentalJourney.merchantRentalNextStep(order);
    assert.ok(
      !String(text).includes('配送'),
      `租赁单不得出现售卖链路的「配送」措辞，实际「${text}」`
    );
    assert.ok(
      !String(rentalJourney.merchantRentalStatusLabel(order)).includes('配送'),
      '租赁状态标签同样不得出现「配送」'
    );
  }

  // 租赁 FULFILLING 阶段的措辞必须是「取车」语义。
  const fulfilling = rentalJourney.merchantRentalNextStep(RENTAL_ORDER);
  assert.ok(fulfilling.includes('取车'), `租赁 FULFILLING 文案应指向取车，实际「${fulfilling}」`);
  assert.equal(fulfilling, '核验交付码，确认用户已取车');
});

test('⑧ ★ 反向护栏：售卖单的 nextStep 必须回落到原售卖文案表（逐字一致）', () => {
  // `merchantRentalNextStep` 对非租赁单返回 **null**，页面据此回落到 `nextSteps`。
  // 这是「售卖链路一行不改」的结构性保证：只要它返回 null，售卖文案就只能来自原表。
  assert.equal(rentalJourney.merchantRentalNextStep(SALE_ORDER), null);
  assert.equal(rentalJourney.merchantRentalNextStep({ orderKind: 'SALE', rental: { status: 'RENTING' } }), null);
  assert.equal(rentalJourney.merchantRentalNextStep({}), null);
  assert.equal(rentalJourney.merchantRentalNextStep(null), null);
  // 售卖单的状态标签也必须回落到原表（不返回租赁标签）。
  assert.equal(rentalJourney.merchantRentalStatusLabel(SALE_ORDER), null);
  // 原售卖文案表本身逐字未动（完整表在 test/miniapp.test.js 另有源码断言）。
  assert.equal(rentalJourney.merchantRentalNextStep({ orderKind: 'RENTAL', rental: { status: '???' } }), '等待更新',
    '租赁单状态无法识别时给中性文案，**绝不**回落成售卖文案');
});

test('merchantRentalPhase：RENTING 必须按 order.status 分成「待取车」与「租期中」两阶段', () => {
  // 只看 rental.status 会把「用户还没来取车」与「车已在用户手上」混成一句话，
  // 而商家在这两个阶段该做的事完全不同。
  assert.equal(rentalJourney.merchantRentalPhase({ ...RENTAL_ORDER, status: 'PAID' }), 'RENTING_PAID');
  assert.equal(rentalJourney.merchantRentalPhase({ ...RENTAL_ORDER, status: 'FULFILLING' }), 'RENTING_FULFILLING');
  assert.equal(rentalJourney.merchantRentalPhase(RENTAL_ORDER), 'RENTING_FULFILLING');

  assert.equal(rentalJourney.merchantRentalStatusLabel({ ...RENTAL_ORDER, status: 'PAID' }), '待取车');
  assert.equal(rentalJourney.merchantRentalStatusLabel(RENTAL_ORDER), '租期中');
  assert.equal(rentalJourney.merchantRentalStatusLabel(RENTAL_RETURN_REQUESTED), '待核验归还');
  assert.equal(rentalJourney.merchantRentalStatusLabel(RENTAL_RETURNED), '已归还');
});

test('⑩ E2E：商家端「核验归还」入口 false → true → false（走真实服务端）', async () => {
  // 把上一轮的临时探针**固化成回归测试**：不再依赖手工跑脚本。
  // 全程走真实 HTTP + 真实状态机，前端纯函数直接吃接口返回值。
  const os = require('node:os');
  const http = require('node:http');
  const { JsonStore } = require('../server/src/store');
  const { createApp } = require('../server/src/app');

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-t40-e2e-'));
  const store = new JsonStore(path.join(tempDirectory, 'db.json'));
  const server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` })
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = async (pathname, options) => {
    const response = await fetch(`${baseUrl}${pathname}`, options);
    return { response, body: await response.json() };
  };
  const jsonHeaders = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

  try {
    // ---- 用户：下单 + 支付 ----
    const userLogin = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 't40_e2e_user' })
    });
    const userToken = userLogin.body.data.token;
    const created = await api('/api/orders', {
      method: 'POST',
      headers: jsonHeaders(userToken),
      body: JSON.stringify({ items: [{ productId: 'prod_ebike_rent_002', quantity: 1, rentalUnits: 3 }] })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.data.orderKind, 'RENTAL');
    const orderId = created.body.data.id;
    const paid = await api(`/api/payment-orders/${created.body.paymentOrder.id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}` }
    });
    assert.equal(paid.response.status, 200);

    // ---- 商家：登录 ----
    const merchantUser = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'merchant_demo' })
    });
    const merchantLogin = await api('/api/merchant/login', {
      method: 'POST',
      headers: jsonHeaders(merchantUser.body.data.token),
      body: JSON.stringify({ merchantId: 'merchant_001' })
    });
    assert.equal(merchantLogin.response.status, 200);
    const merchantToken = merchantLogin.body.data.token;

    // 商家视角拉订单 —— 与商家订单页同一条数据源（/api/merchant/overview）。
    const merchantOrderRow = async () => {
      const overview = await api('/api/merchant/overview', { headers: { authorization: `Bearer ${merchantToken}` } });
      const row = (overview.body.data.orders || []).find((item) => item.id === orderId);
      assert.ok(row, '商家端应能看到这张租赁单');
      return row;
    };

    // ---- 阶段 1：已支付、用户未申请归还 → 不该有「核验归还」----
    let row = await merchantOrderRow();
    assert.equal(row.orderKind, 'RENTAL', '商家端必须透传 orderKind，否则前端无从分流');
    assert.equal(row.rental.status, 'RENTING');
    assert.equal(rentalJourney.canVerifyRentalReturn(row), false, '未申请归还时不得出现「核验归还」');

    // ---- 阶段 2：商家取车核验（复用既有交付码机制，不新开一套）----
    const accepted = await api('/api/order-collab', {
      method: 'POST',
      headers: jsonHeaders(merchantToken),
      body: JSON.stringify({ role: 'MERCHANT', action: 'ACCEPT', orderId, note: '已备车，用户到店取车' })
    });
    assert.equal(accepted.response.status, 200);
    const deliveryCode = store.read().orders.find((item) => item.id === orderId).deliveryCode;
    assert.match(deliveryCode, /^\d{6}$/, '取车走既有交付码');
    const pickedUp = await api('/api/order-collab', {
      method: 'POST',
      headers: jsonHeaders(merchantToken),
      body: JSON.stringify({ role: 'MERCHANT', action: 'COMPLETE', orderId, note: '已核验交付码', deliveryCode })
    });
    assert.equal(pickedUp.response.status, 200);
    assert.equal(pickedUp.body.data.status, 'FULFILLING', '取车核验后车在用户手上，订单停在 FULFILLING');

    row = await merchantOrderRow();
    assert.equal(rentalJourney.canVerifyRentalReturn(row), false, '租期中不得出现「核验归还」');

    // ---- 阶段 3：用户申请归还 → 商家必须看到「核验归还」----
    const requested = await api('/api/order-collab', {
      method: 'POST',
      headers: jsonHeaders(userToken),
      body: JSON.stringify({ role: 'USER', action: 'RETURN_REQUEST', orderId, note: '已归还车辆' })
    });
    assert.equal(requested.response.status, 200);
    assert.equal(requested.body.data.rental.status, 'RETURN_REQUESTED');

    row = await merchantOrderRow();
    assert.equal(row.rental.status, 'RETURN_REQUESTED');
    assert.equal(
      rentalJourney.canVerifyRentalReturn(row),
      true,
      '★ 用户申请归还后，商家端必须出现「核验归还」入口（本轮修复的核心缺口）'
    );

    // ---- 阶段 4：商家核验归还 → 入口消失 ----
    const verified = await api('/api/order-collab', {
      method: 'POST',
      headers: jsonHeaders(merchantToken),
      body: JSON.stringify({ role: 'MERCHANT', action: 'RETURN_VERIFY', orderId, note: '归还核验通过' })
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.data.rental.status, 'RETURNED');
    assert.equal(verified.body.data.status, 'COMPLETED', '归还核验是租赁单进入 COMPLETED 的唯一入口');

    row = await merchantOrderRow();
    assert.equal(rentalJourney.canVerifyRentalReturn(row), false, '已核验后入口必须消失（防重复提交）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
