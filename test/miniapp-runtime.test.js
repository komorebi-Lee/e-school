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
