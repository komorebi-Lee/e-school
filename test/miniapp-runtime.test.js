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
// 分块加载的三态工具（loading / error / data）：纯函数 + 一个只依赖注入 setData 的薄包装。
const loadState = require(path.join(miniprogramDirectory, 'utils', 'load-state.js'));
// 待支付倒计时分级（文案 / 紧急判定）：纯函数模块，M3-P1-05 新增。
const format = require(path.join(miniprogramDirectory, 'utils', 'format.js'));
// 订单卡片装饰层（`card` 及其文案表）：纯函数模块，M3-P1-05 从 `orders.js` 抽出。
const orderCard = require(path.join(miniprogramDirectory, 'utils', 'order-card.js'));
// 图片读取 + 上传的唯一入口（M3-P2-01）：只在调用期访问 `wx`，可在 Node 中真实加载断言。
const upload = require(path.join(miniprogramDirectory, 'utils', 'upload.js'));
// 商品跳转目标（按品类分流，M2-P1-01 / M2-P1-03）：纯函数 + 一个只转发给 openLink 的薄包装。
const productRoute = require(path.join(miniprogramDirectory, 'utils', 'product-route.js'));
// 发布页草稿（M6-P1-02 / M7-P1-02）：纯函数 + 只在调用期访问 wx 的容错读写。
const publishDraft = require(path.join(miniprogramDirectory, 'utils', 'publish-draft.js'));

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
  for (const api of [...ASYNC_APIS, ...SYNC_APIS, 'cloudCallContainer', 'getFileSystemManager', 'readFile']) calls[api] = [];

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

    /**
     * 文件系统桩（M3-P2-01 抽出 `utils/upload.js` 后新增）。
     *
     * 三种形态都要能造出来，因为 upload.js 对它们的处理各不相同：
     * - 正常返回 `{ readFile }`；
     * - `config.fileSystemResult === 'missing'` → 返回没有 `readFile` 的对象；
     * - `config.fileSystemResult === 'throw'` → **同步抛错**（真实环境会出现，
     *   也是 upload.js 必须把它落成 reject 的原因）。
     */
    getFileSystemManager() {
      calls.getFileSystemManager.push({});
      if (config.fileSystemResult === 'throw') throw new Error('getFileSystemManager:fail');
      if (config.fileSystemResult === 'missing') return {};
      return {
        readFile(params = {}) {
          calls.readFile.push({ ...params });
          if (config.readFileResult === 'fail') {
            if (typeof params.fail === 'function') params.fail({ errMsg: 'readFile:fail 读取失败' });
            return;
          }
          if (typeof params.success === 'function') {
            params.success({ data: config.readFileData === undefined ? 'QkFTRTY0' : config.readFileData });
          }
        }
      };
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

test('openLink 跳转市集（已是第 5 个 tabBar 页）走 switchTab', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/market/market'));

  assert.equal(stub.calls.switchTab.length, 1, '市集已是 tabBar 页，必须走 switchTab');
  assert.equal(stub.calls.switchTab[0].url, '/pages/market/market');
  assert.equal(stub.calls.navigateTo.length, 0, '★ 不得调用 navigateTo —— 对 tabBar 页它必然失败，用户点了没反应');
  assert.equal(navigation.isTabBarPath('/pages/market/market'), true, 'isTabBarPath 应认市集');
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

test('isTabBarPath 对 5 个 tabBar 页面返回 true', () => {
  for (const pagePath of ['/pages/home/home', '/pages/map/map', '/pages/orders/orders', '/pages/profile/profile', '/pages/market/market']) {
    assert.equal(navigation.isTabBarPath(pagePath), true, `${pagePath} 应被识别为 tabBar 页面`);
  }
});

test('isTabBarPath 对非 tabBar 页面与空值返回 false', () => {
  // `/pages/market/item` 是 `/pages/market/market` 的近似串：必须按**整串**比对，
  // 不能用前缀/包含判断，否则市集详情页会被误判成 tabBar 页。
  for (const pagePath of ['/pages/market/item', '/pages/detail/detail', '/pages/orders/orders-detail', '', null, undefined]) {
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

/**
 * 分块加载的三态工具（`miniprogram/utils/load-state.js`）。
 *
 * 本批改造的主题是**静默失败**：接口挂掉时页面什么都不发生（没有提示、没有重试，
 * 数据保持空白或陈旧）。工具本身是纯函数 + 一个只依赖注入 `setData` 的薄包装，
 * 因此成功 / 失败两条路径都能在 Node 里真实跑通、真实断言。
 *
 * 十条断言对应派发要求 ①~⑩；`★` 标记的两条是本模块存在的理由。
 */
test('load-state：失败不清空数据、块之间互相独立', async () => {
  const {
    initialBlock, beginBlock, resolveBlock, rejectBlock, blockErrorText, loadBlock,
    DEFAULT_ERROR_TEXT, MAX_ERROR_TEXT_LENGTH
  } = loadState;

  // ① 初始块 = 加载中且无错误。
  assert.deepEqual(initialBlock(), { loading: true, error: '' }, '① 初始块应为「加载中、无错误」');

  // ①b 初始列表块：额外带 `data: []`，让「失败」与「无数据」在模板层永远可区分。
  assert.deepEqual(
    loadState.initialListBlock(), { loading: true, error: '', data: [] },
    '①b 初始列表块必须带空数组 data —— 否则首次加载失败后块里没有 data 字段，'
    + '模板里的 data.length 取到 undefined，会被 wx:if 当成假值，'
    + '「失败」就被渲染成了「空列表」'
  );
  assert.deepEqual(
    rejectBlock(new Error('挂了'), loadState.initialListBlock()).data, [],
    '①b 列表块首次失败后 data 仍须是数组（而不是 undefined）'
  );

  // ② 进入加载中必须保留上一次的数据 —— 重试期间旧列表不能闪成空白。
  const prev = { loading: false, error: '', data: [1, 2, 3] };
  const begun = beginBlock(prev);
  assert.deepEqual(begun.data, [1, 2, 3], '② 进入加载中不得丢掉上一次的数据');
  assert.equal(begun.loading, true, '② 进入加载中应置 loading=true');
  assert.equal(begun.error, '', '② 进入加载中应清掉上一次的错误');

  // ③ ★ 核心约定：失败绝不清空数据。
  const rejected = rejectBlock(new Error('接口 500'), prev);
  assert.deepEqual(
    rejected.data, [1, 2, 3],
    '③ 失败时必须保留旧数据 —— 清空等于向用户断言「这里本来就没有数据」，是假事实'
  );
  assert.equal(rejected.loading, false, '③ 失败应结束加载态');
  assert.equal(rejected.error, '接口 500', '③ 失败应写入可读错误文案');

  // ④ 成功态清掉 loading 与 error。
  assert.deepEqual(resolveBlock({ loading: true, error: 'x', data: 'k' }), { loading: false, error: '', data: 'k' }, '④ 成功态应清掉 loading 与 error，并保留数据');

  // ⑤ 文案兜底与截断。
  assert.equal(blockErrorText(new Error('')), DEFAULT_ERROR_TEXT, '⑤ 空 message 应回落到兜底文案');
  assert.equal(blockErrorText(undefined), DEFAULT_ERROR_TEXT, '⑤ 非 Error 入参也应回落，不得抛错');
  const truncated = blockErrorText(new Error('x'.repeat(300)));
  assert.equal(truncated.length, MAX_ERROR_TEXT_LENGTH, '⑤ 超长文案必须截断到上限（否则会撑爆单行占位，把重试按钮挤出屏幕）');
  assert.ok(truncated.endsWith('…'), '⑤ 截断应带省略号，提示用户文案不完整');

  // ⑥ ★ 块之间独立：同一页面上并发加载两块，一块失败不得牵连另一块。
  const written = {};
  const setData = (patch) => Object.assign(written, patch);
  await Promise.all([
    loadBlock({
      setData, stateKey: 'aBlock',
      prev: { loading: false, error: '', data: ['旧'] },
      loader: () => Promise.reject(new Error('A 挂了'))
    }),
    loadBlock({
      setData, stateKey: 'bBlock', prev: initialBlock(),
      loader: () => Promise.resolve(['新'])
    })
  ]);
  assert.equal(written.aBlock.error, 'A 挂了', '⑥ A 块失败应只写 A 块的 error');
  assert.deepEqual(written.aBlock.data, ['旧'], '⑥ A 块失败也不得清空自己的数据');
  assert.deepEqual(written.bBlock.data, ['新'], '⑥ B 块必须照常成功 —— 一个接口挂掉不该拖垮整页');
  assert.equal(written.bBlock.error, '', '⑥ B 块不得被写入 A 块的错误');

  // ⑦ 成功路径的 setData 序列：先「加载中」，再「数据 + 成功态」。
  const calls = [];
  const data7 = await loadBlock({
    setData: (patch) => calls.push(patch), stateKey: 'cBlock', prev: initialBlock(),
    loader: () => Promise.resolve(42)
  });
  assert.equal(data7, 42, '⑦ loadBlock 应把 loader 的解析值透传出去');
  assert.deepEqual(calls[0].cBlock, { loading: true, error: '' }, '⑦ 第一次 setData 应进入加载中');
  assert.deepEqual(calls[1].cBlock, { loading: false, error: '', data: 42 }, '⑦ 第二次 setData 应写入数据并清空错误');

  // ⑧ ★ 失败路径：不清空 prev 的数据，且不 rethrow。
  const calls8 = [];
  const result8 = await loadBlock({
    setData: (patch) => calls8.push(patch), stateKey: 'dBlock',
    prev: { loading: false, error: '', data: ['旧数据'] },
    loader: () => Promise.reject(new Error('挂了'))
  });
  assert.equal(result8, undefined, '⑧ 失败时不得 rethrow —— 否则调用方又得包一层空 catch，回到改造前');
  assert.deepEqual(calls8[calls8.length - 1].dBlock.data, ['旧数据'], '⑧ 失败时数据必须原样保留');

  // ⑨ loader 同步抛错同样要被接住（不能漏成未捕获异常）。
  const result9 = await loadBlock({
    setData: () => {}, stateKey: 'eBlock',
    loader: () => { throw new Error('同步炸'); }
  });
  assert.equal(result9, undefined, '⑨ loader 同步抛错同样不 rethrow');

  // ⑩ 入参校验：缺任何一个必需项都应在开发期立刻暴露，而不是静默写坏 state。
  assert.throws(() => loadBlock({ stateKey: 'x', loader: () => {} }), TypeError, '⑩ 缺 setData 应抛 TypeError');
  assert.throws(() => loadBlock({ setData: () => {}, loader: () => {} }), TypeError, '⑩ 缺 stateKey 应抛 TypeError');
  assert.throws(() => loadBlock({ setData: () => {}, stateKey: 'x' }), TypeError, '⑩ 缺 loader 应抛 TypeError');
});

// ===========================================================================
// 八、待支付倒计时分级（M3-P1-05）—— format.js 纯函数
// ===========================================================================

test('M3-P1-05：待支付倒计时分级文案与紧急判定（format.js）', () => {
  const NOW = new Date('2026-03-01T12:00:00.000Z');
  /** 相对 NOW 偏移 `offsetMs` 的 ISO 时间。 */
  const at = (offsetMs) => new Date(NOW.getTime() + offsetMs).toISOString();
  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;

  // ① ≥60 分钟 → 小时档（含「小时」「分钟」，不含秒）。
  const hourText = format.paymentCountdownText(at(2 * HOUR + 30 * MINUTE), NOW);
  assert.equal(hourText, '请在 2 小时 30 分钟内完成支付', '① 剩余 2 小时 30 分应走小时档');
  assert.equal(hourText.includes('秒'), false, '① 小时档不得出现秒 —— 秒级只在最后 5 分钟');

  // ② 5 分钟 ~ 60 分钟 → 分钟档（含「超时自动取消」，不含秒）。
  const minuteText = format.paymentCountdownText(at(30 * MINUTE), NOW);
  assert.equal(minuteText, '请在 30 分钟内完成支付，超时自动取消', '② 剩余 30 分应走分钟档');
  assert.equal(minuteText.includes('秒'), false, '② 分钟档不得出现秒');

  // ③ <5 分钟 → 秒档（含秒；不足 1 分钟时省略「0 分」）。
  assert.equal(
    format.paymentCountdownText(at(4 * MINUTE + 59 * 1000), NOW),
    '请在 4 分 59 秒内完成支付',
    '③ 剩余 4 分 59 秒必须精确到秒 —— 分钟粒度在最后 60 秒里数字不动，会被当成卡死'
  );
  assert.equal(
    format.paymentCountdownText(at(4 * MINUTE + 30 * 1000), NOW),
    '请在 4 分 30 秒内完成支付',
    '③ 还有整分时保留「X 分」—— ≥1 分钟这一侧的口径不变'
  );
  assert.equal(
    format.paymentCountdownText(at(30000), NOW),
    '请在 30 秒内完成支付',
    '③ ★ 不足 1 分钟时应省略「0 分」—— 「请在 0 分 30 秒内完成支付」读起来不自然'
  );
  assert.equal(
    /0\s*分/.test(format.paymentCountdownText(at(30000), NOW)), false,
    '③ ★ minutes === 0 时文案不得出现「0 分」（正则容错空格，避免只匹配字面量）'
  );

  // ④ ≤0 → 超时文案。
  assert.equal(format.paymentCountdownText(at(0), NOW), '支付已超时，刷新后订单将关闭', '④ 剩余恰好为 0 也算超时');
  assert.equal(
    format.paymentCountdownText(at(-5 * MINUTE), NOW),
    '支付已超时，刷新后订单将关闭',
    '④ 已过期同样是超时文案'
  );

  // ⑤ 非法 expiresAt → 空串（不能把「拿不到时间」说成「已超时」）。
  for (const bad of [undefined, null, '', 'not-a-date', NaN]) {
    assert.equal(
      format.paymentCountdownText(bad, NOW), '',
      `⑤ 非法 expiresAt(${String(bad)}) 应返回空串，不猜`
    );
  }

  // ⑥ isPaymentUrgent：剩余 >0 且 ≤5 分钟为真，其余为假。
  assert.equal(format.isPaymentUrgent(at(5 * MINUTE), NOW), true, '⑥ 恰好剩 5:00 算紧急（闭区间：宁可早一秒切秒级）');
  assert.equal(format.isPaymentUrgent(at(1 * MINUTE), NOW), true, '⑥ 剩 1 分钟算紧急');
  assert.equal(format.isPaymentUrgent(at(5 * MINUTE + 1), NOW), false, '⑥ 超过 5 分钟不算紧急');
  assert.equal(format.isPaymentUrgent(at(0), NOW), false, '⑥ 已超时不算紧急（走的是刷新链路，不是高亮）');
  assert.equal(format.isPaymentUrgent(at(-1), NOW), false, '⑥ 负剩余不算紧急');
  assert.equal(format.isPaymentUrgent(undefined, NOW), false, '⑥ 非法输入不算紧急');

  // ⑦ isPaymentExpired 与文案的超时判定必须同源：否则会出现「显示已超时却不去刷新」的空转。
  for (const offset of [-HOUR, -1, 0, 1, 30 * MINUTE, 2 * HOUR]) {
    const expiresAt = at(offset);
    const textSaysExpired = format.paymentCountdownText(expiresAt, NOW) === '支付已超时，刷新后订单将关闭';
    assert.equal(
      format.isPaymentExpired(expiresAt, NOW), textSaysExpired,
      `⑦ 偏移 ${offset}ms：isPaymentExpired 必须与文案的超时判定一致`
    );
  }
  assert.equal(format.isPaymentExpired(undefined, NOW), false, '⑦ 非法输入不得判为已超时');

  // ⑧ ★ 文案随时间单调：now 越晚，文案里隐含的剩余时间越小。
  // 先把文案还原成秒数再断言序列非递增 —— 并且必须**真的在变**：
  // 一句恒定文案也能满足「非递增」，那种假通过必须被排掉。
  const impliedSeconds = (text) => {
    if (!text) return null;
    if (text.includes('已超时')) return 0;
    const hours = Number((/(\d+)\s*小时/.exec(text) || [0, 0])[1]);
    const minuteWord = /(\d+)\s*分钟/.exec(text); // 小时档的 Y / 分钟档的 X
    const minuteChar = /(\d+)\s*分(?!钟)/.exec(text); // 秒档的 X
    const minutes = minuteWord ? Number(minuteWord[1]) : minuteChar ? Number(minuteChar[1]) : 0;
    const seconds = Number((/(\d+)\s*秒/.exec(text) || [0, 0])[1]);
    return hours * 3600 + minutes * 60 + seconds;
  };
  const expiresAt = at(3 * HOUR);
  const samples = [];
  for (let step = 0; step <= 120; step += 1) {
    const now = new Date(NOW.getTime() + step * 90000); // 每 1.5 分钟采样一次
    samples.push(impliedSeconds(format.paymentCountdownText(expiresAt, now)));
  }
  assert.ok(
    new Set(samples).size > 5,
    `⑧ 文案必须随时间变化（否则「单调」是废话），实得不同值 ${new Set(samples).size} 个`
  );
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(
      samples[index] <= samples[index - 1],
      `⑧ ★ 文案必须随时间单调不增：第 ${index} 个样本 ${samples[index]}s 大于前一个 ${samples[index - 1]}s`
    );
  }
  assert.equal(samples[samples.length - 1], 0, '⑧ 采样末端（now 已越过截止）必须归零');
});

// ===========================================================================
// 九、订单卡片装饰层（M3-P1-05）—— order-card.js 纯函数
// ===========================================================================

test('M3-P1-05：订单卡片装饰覆盖退款 / 超时 / 售后 / 商家 / 租赁分流（order-card.js）', () => {
  const MINUTE = 60000;
  const now = Date.now();
  const urgentExpiresAt = new Date(now + 2 * MINUTE).toISOString();
  const calmExpiresAt = new Date(now + 30 * MINUTE).toISOString();

  // ⑨ 基础装饰：类型名 / 图标 / 色调 / 金额 / 时间。
  const base = orderCard.card({
    id: 'e1', recordNo: 'E001', type: 'E_BIKE', status: 'COMPLETED', amountInCents: 19900,
    items: [{ name: '轻风 通勤版', quantity: 1, productId: 'p1', merchantId: 'm1' }],
    fulfillment: {}, merchantName: '测试商家',
    createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z'
  });
  assert.equal(base.typeLabel, '电瓶车', '⑨ typeLabel 应映射类型名');
  assert.equal(base.icon, '车', '⑨ icon 应映射类型图标');
  assert.equal(base.tone, 'done', '⑨ COMPLETED 应走 done 色调');
  assert.equal(base.priceText, '¥199.00', '⑨ 金额应以元展示两位小数');
  assert.equal(base.timeText, '01-01 10:00', '⑨ 时间文案应取 updatedAt 的月-日 时:分');

  // ⑩ 倒计时接线：待支付 + 紧急 → 文案含秒且 countdownUrgent 为真；非紧急 / 非待支付 → 假。
  const urgent = orderCard.card({ id: 'p1', type: 'E_BIKE', status: 'PENDING_PAYMENT', paymentExpiresAt: urgentExpiresAt, items: [], fulfillment: {} });
  assert.ok(urgent.countdownText.includes('秒'), '⑩ 紧急单的倒计时文案必须含秒');
  assert.equal(urgent.countdownUrgent, true, '⑩ ★ 紧急单必须带 countdownUrgent=true（模板靠它加高亮类）');
  const calm = orderCard.card({ id: 'p2', type: 'E_BIKE', status: 'PENDING_PAYMENT', paymentExpiresAt: calmExpiresAt, items: [], fulfillment: {} });
  assert.equal(calm.countdownUrgent, false, '⑩ 非紧急单不得高亮');
  assert.equal(calm.countdownText.includes('秒'), false, '⑩ 非紧急单文案不出现秒');
  const paid = orderCard.card({ id: 'p3', type: 'E_BIKE', status: 'PAID', items: [], fulfillment: {} });
  assert.equal(paid.countdownText, '', '⑩ 非待支付单没有倒计时文案');
  assert.equal(paid.countdownUrgent, false, '⑩ 非待支付单不得高亮');

  // ⑪ 部分退款：状态标签 + 剩余履约范围 + 已退金额。
  const partial = orderCard.card({
    id: 'e2', type: 'E_BIKE', status: 'FULFILLING', paymentStatus: 'PARTIALLY_REFUNDED',
    refundedQuantity: 1, partialRefundedInCents: 9900,
    items: [{ name: '轻风 通勤版', quantity: 2, productId: 'p1', merchantId: 'm1' }],
    fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z'
  });
  assert.equal(partial.statusLabel, '部分退款', '⑪ 部分退款应覆盖状态标签');
  assert.equal(partial.statusNote, '已退 1 件，剩余 1 件继续履约 · 已退 ¥99.00', '⑪ 部分退款应说明剩余履约范围与退款金额');

  // ⑫ 支付超时关闭：状态标签 + 可重新下单的提示。
  const timedOut = orderCard.card({ id: 'e3', type: 'E_BIKE', status: 'CANCELLED', cancelReason: 'PAYMENT_TIMEOUT', items: [], fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z' });
  assert.equal(timedOut.statusLabel, '已超时关闭', '⑫ 支付超时应显示「已超时关闭」');
  assert.equal(timedOut.statusNote, '超过支付时限自动关闭，可重新下单', '⑫ 超时关闭应提示可重新下单');

  // ⑬ 售后：进行中的工单进面板；超过承诺响应时限置 afterSaleOverdue。
  const overdueAt = new Date(now - 60 * MINUTE).toISOString();
  const withAfterSale = orderCard.card({
    id: 'e4', type: 'E_BIKE', status: 'AFTER_SALE', items: [], fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z',
    afterSales: [{ id: 'as1', status: 'REVIEWING', typeLabel: '退款', reason: '车况问题', responseDueAt: overdueAt }]
  });
  assert.ok(withAfterSale.afterSale, '⑬ 有售后工单时必须写入 afterSale');
  assert.equal(withAfterSale.afterSale.statusLabel, '处理中', '⑬ 售后状态标签应映射');
  assert.equal(withAfterSale.afterSaleOverdue, true, '⑬ ★ 超过承诺响应时限必须置 afterSaleOverdue（页面据此建催办卡）');
  assert.equal(withAfterSale.afterSale.overdueText, '已超过承诺响应时限，平台已加入催办', '⑬ 超时文案应说明平台已催办');
  assert.ok(withAfterSale.journey.length > 0, '⑬ AFTER_SALE 应有进度条');

  // ⑭ 商家：无商家名回落空串（模板用「平台自营」兜底）；有 merchantId 才给「进店」入口。
  const noMerchant = orderCard.card({ id: 'e5', type: 'E_BIKE', status: 'PAID', items: [], fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z' });
  assert.equal(noMerchant.merchantName, '', '⑭ 无商家名应为空串，交由模板兜底');
  assert.equal(noMerchant.actions.some((action) => action.key === 'store'), false, '⑭ 无 merchantId 不得给「进店」入口');
  const withMerchant = orderCard.card({ id: 'e6', type: 'E_BIKE', status: 'PAID', merchantId: 'm1', merchantName: '测试商家', items: [], fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z' });
  assert.equal(withMerchant.actions.some((action) => action.key === 'store'), true, '⑭ 有 merchantId 应给「进店」入口');

  // ⑮ 租赁分流：进度条 / 下一步 / 归还入口 / 应还倒计时全部走租赁口径（回归护栏）。
  const rental = orderCard.card({
    id: 'o-renting', recordNo: 'R001', type: 'E_BIKE', status: 'RENTING', orderKind: 'RENTAL',
    rental: { status: 'RENTING', dueAt: '2026-02-01T10:00:00.000Z', plan: { unit: 'MONTH', units: 1 }, depositInCents: 5000 },
    items: [{ name: '轻风 通勤版', quantity: 1, productId: 'p1', merchantId: 'm1' }],
    fulfillment: {}, merchantName: '测试商家', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z'
  });
  assert.equal(rental.isRental, true, '⑮ 租赁单 isRental 必须为真');
  assert.deepEqual(
    rental.journey.map((step) => `${step.key}:${step.done ? 'done' : step.current ? 'current' : 'todo'}`),
    ['PAID:done', 'RENTING:current', 'RETURN_REQUESTED:todo', 'RETURNED:todo'],
    '⑮ ★ 租赁单必须走租赁进度条（不得退回售卖文案）'
  );
  assert.equal(rental.nextStep, '凭交付码到校内取车点取车，按租期归还', '⑮ 租赁下一步不得出现「配送」措辞');
  assert.equal(rental.canReturnRequest, true, '⑮ RENTING 单应显示「申请归还」');
  assert.ok(rental.rentalCountdownText, '⑮ 租赁应还倒计时应有值');

  // ⑯ 平台处理结果 / 协同轨迹 / 留言。
  const collaborated = orderCard.card({
    id: 'e7', type: 'E_BIKE', status: 'FULFILLING', items: [], fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z',
    collaboration: {
      unrepliedMessage: { action: 'NOTE', text: '在吗', createdAt: '2026-01-01T10:00:00.000Z' },
      intervention: { status: 'RESOLVED', note: '已协调补发', updatedAt: '2026-01-02T03:00:00.000Z' },
      handoffs: [{ role: 'PLATFORM', note: '平台已介入', createdAt: '2026-01-02T02:00:00.000Z' }],
      messages: [{ id: 'm1', role: 'MERCHANT', text: '已安排' }]
    }
  });
  assert.equal(collaborated.platformResult.note, '已协调补发', '⑯ 平台处理结果应写入 note');
  assert.equal(collaborated.intervention, false, '⑯ RESOLVED 不等于 REQUESTED');
  assert.equal(collaborated.timeline.length, 1, '⑯ 协同轨迹应映射 handoffs');
  assert.equal(collaborated.timeline[0].roleLabel, '平台', '⑯ 轨迹角色应映射中文名');
  assert.equal(collaborated.messages.length, 1, '⑯ 留言应透传');
  assert.equal(collaborated.messageStatus, '已提交留言，预计 24 小时内回复', '⑯ 有未回复留言应给出响应预期');
});

// ===========================================================================
// M3-P1-01：订单已创建但支付未完成 → 「去支付」的跳转链路
// ===========================================================================

test('M3-P1-01：openLink 带 focusId 跳订单页 —— 经 Storage 传递且走 switchTab', () => {
  const stub = createWxStub();
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=o-777'));

  // 订单页是 tabBar 页：`switchTab` 不支持 query，所以 focusId 必须经 Storage 传。
  // 这条断言证明 checkout 的「去支付」不需要自己写一套跳转 + Storage 传递。
  assert.equal(stub.calls.switchTab.length, 1, '订单页是 tabBar 页，必须走 switchTab');
  assert.equal(stub.calls.switchTab[0].url, '/pages/orders/orders', 'switchTab 的目标不得带 query');
  assert.equal(stub.calls.navigateTo.length, 0, '★ 不得调用 navigateTo —— 对 tabBar 页它必然失败');

  assert.equal(stub.calls.setStorageSync.length, 1, 'focusId 应经 Storage 传递');
  assert.equal(stub.calls.setStorageSync[0].key, ORDER_FOCUS_KEY, '应写入订单焦点键');
  assert.equal(stub.calls.setStorageSync[0].value, 'o-777', '写入的必须是该订单 id');
  assert.equal(stub.storageGet(ORDER_FOCUS_KEY), 'o-777', 'Storage 里应真的存在该焦点值');
});

test('M3-P1-01：switchTab 失败时焦点参数必须回滚（否则下次进订单页会错误定位）', () => {
  const stub = createWxStub({ switchTabResult: 'fail' });
  withWx(stub, () => navigation.openLink('/pages/orders/orders?focusId=o-777'));

  assert.equal(stub.calls.switchTab.length, 1, '应尝试 switchTab');
  assert.equal(
    stub.storageGet(ORDER_FOCUS_KEY), '',
    '★ 跳转失败后必须清掉刚写入的 focusId —— 残留值会被下一次 onShow 当作本次意图'
  );
  assert.equal(stub.calls.showToast.length, 1, '跳转失败不应静默，应给出提示');
});

// ===========================================================================
// M3-P2-01：utils/upload.js —— 全仓唯一的图片读取入口
// ===========================================================================

test('M3-P2-01：readFileAsBase64 成功返回 base64、失败 reject 且错误可读', async () => {
  // ① 成功：返回 base64，并以 base64 编码读取
  const okStub = createWxStub({ readFileData: 'QUJD' });
  const data = await withWxAsync(okStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/a.png' }));
  assert.equal(data, 'QUJD', '① 成功时应原样返回 base64 字符串');
  assert.equal(okStub.calls.readFile.length, 1, '① 应真的调用一次 readFile');
  assert.equal(okStub.calls.readFile[0].filePath, '/tmp/a.png', '① 应把路径透传给 readFile');
  assert.equal(okStub.calls.readFile[0].encoding, 'base64', '① 必须按 base64 读取，否则上传内容会错');

  // ② 直接给路径字符串也应可用（页面之外复用）
  const stringStub = createWxStub({ readFileData: 'WFla' });
  const fromString = await withWxAsync(stringStub, () => upload.readFileAsBase64('/tmp/b.jpg'));
  assert.equal(fromString, 'WFla', '② 字符串入参应被接受并原样返回读取结果');
  assert.equal(stringStub.calls.readFile[0].filePath, '/tmp/b.jpg', '② 字符串入参应被当作路径');

  // ③ readFile 回调 fail → reject，且 message 可读
  const failStub = createWxStub({ readFileResult: 'fail' });
  await assert.rejects(
    () => withWxAsync(failStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/c.png' })),
    (error) => {
      assert.equal(error.message, '图片读取失败', '③ 失败文案应可读且与改造前一致');
      assert.ok(error.cause, '③ 底层原因应挂在 cause 上，便于排查');
      return true;
    },
    '③ readFile 失败必须 reject'
  );

  // ④ 自定义文案（各页面沿用原文案，避免用户可见提示回归）
  const customStub = createWxStub({ readFileResult: 'fail' });
  await assert.rejects(
    () => withWxAsync(customStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/d.png' }, { readErrorMessage: '材料图片读取失败' })),
    (error) => error.message === '材料图片读取失败',
    '④ readErrorMessage 应生效'
  );

  // ⑤ readFile 成功但内容为空 → 必须 reject（不能把空串当成功传下去）
  const emptyStub = createWxStub({ readFileData: '' });
  await assert.rejects(
    () => withWxAsync(emptyStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/e.png' })),
    (error) => error.message === '图片读取失败' && String(error.cause).includes('空'),
    '⑤ ★ 空内容必须 reject —— 否则会上传一个空图片并静默失败'
  );

  // ⑥ getFileSystemManager 同步抛错 → 必须 reject（不能变成同步异常，否则调用方 .catch 接不到）
  const throwStub = createWxStub({ fileSystemResult: 'throw' });
  await assert.rejects(
    () => withWxAsync(throwStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/f.png' })),
    (error) => error.message === '图片读取失败' && String(error.cause).includes('getFileSystemManager'),
    '⑥ ★ 同步抛错必须落成 reject，否则会变成未捕获异常'
  );

  // ⑦ 拿不到 readFile 能力 → reject
  const missingStub = createWxStub({ fileSystemResult: 'missing' });
  await assert.rejects(
    () => withWxAsync(missingStub, () => upload.readFileAsBase64({ tempFilePath: '/tmp/g.png' })),
    (error) => error.message === '图片读取失败',
    '⑦ 文件系统不可用时应 reject 而不是静默'
  );

  // ⑧ 空路径 → reject，且不应触碰文件系统
  const noPathStub = createWxStub();
  await assert.rejects(
    () => withWxAsync(noPathStub, () => upload.readFileAsBase64('')),
    (error) => error.message === '图片读取失败',
    '⑧ 空路径应 reject'
  );
  assert.equal(noPathStub.calls.readFile.length, 0, '⑧ 空路径不该调用 readFile');
});

test('M3-P2-01：mimeTypeForPath 按扩展名推断，未知扩展名回落 JPEG', () => {
  assert.equal(upload.mimeTypeForPath('/tmp/a.png'), 'image/png', 'png → image/png');
  assert.equal(upload.mimeTypeForPath('/tmp/a.webp'), 'image/webp', 'webp → image/webp');
  assert.equal(upload.mimeTypeForPath('/tmp/a.jpg'), 'image/jpeg', 'jpg → image/jpeg');
  assert.equal(upload.mimeTypeForPath('/tmp/a.JPEG'), 'image/jpeg', '★ 大写扩展名也应识别');
  assert.equal(upload.mimeTypeForPath('/tmp/a'), 'image/jpeg', '未知/无扩展名回落 image/jpeg');
  // ★ 带 query 的临时路径：改造前 `split('.').pop()` 会取到 `jpg?x=1`
  assert.equal(upload.mimeTypeForPath('/tmp/a.jpg?x=1'), 'image/jpeg', '★ 带 query 的路径应正确取扩展名');
  assert.equal(upload.mimeTypeForPath('/tmp/a.png?width=10'), 'image/png', '★ 带 query 的路径应正确取扩展名');
});

test('M3-P2-01：uploadImage 读取 + 上传一体，且拒绝未注入 request', async () => {
  const stub = createWxStub({ readFileData: 'QUJD' });
  const sent = [];
  const url = await withWxAsync(stub, () => upload.uploadImage(
    { tempFilePath: '/tmp/a.png' },
    (requestPath, options) => {
      sent.push({ requestPath, options });
      return Promise.resolve({ data: { url: 'https://cdn/x.png', size: 123 } });
    }
  ));

  assert.equal(sent.length, 1, '应恰好发起一次上传');
  assert.equal(sent[0].requestPath, '/api/uploads', '应打到上传接口');
  assert.equal(sent[0].options.method, 'POST', '上传应为 POST');
  assert.deepEqual(
    sent[0].options.data, { dataBase64: 'QUJD', mimeType: 'image/png' },
    '★ 上传载荷必须与改造前逐字段一致（dataBase64 + mimeType）'
  );
  assert.equal(url.url, 'https://cdn/x.png', '应 resolve 服务端返回的 data');
  assert.equal(url.size, 123, '★ 应保留 size —— merchant/apply 需要它，只返回 url 会逼它再读一次响应');

  assert.throws(
    () => upload.uploadImage({ tempFilePath: '/tmp/a.png' }, undefined),
    /需要注入 request 函数/,
    '未注入 request 应同步抛错（接线错误应立刻暴露）'
  );
});

test('商品跳转目标：电话卡进套餐页，其余进商品详情页（M2-P1-01 / M2-P1-03）', () => {
  // ⑦ 电话卡 → 套餐页（`card.js` 的 onLoad 读 `planId` 定位套餐）
  assert.equal(
    productRoute.productDetailUrl({ category: 'PHONE_PLAN', id: 'prod_card_service_001' }),
    '/pages/card/card?planId=prod_card_service_001',
    '⑦ ★ 电话卡必须进套餐页 —— 否则会落进电瓶车详情页（字段缺失、按钮语义错乱）'
  );
  // ⑧ 电动车 → 商品详情页
  assert.equal(
    productRoute.productDetailUrl({ category: 'E_BIKE_NEW', id: 'prod_ebike_001' }),
    '/pages/detail/detail?id=prod_ebike_001',
    '⑧ 电动车进商品详情页'
  );

  // 未知 / 缺失 category → 回落 detail：与改造前行为一致（零回归），且不会变成死路。
  assert.equal(
    productRoute.productDetailUrl({ category: 'UNKNOWN_KIND', id: 'x' }),
    '/pages/detail/detail?id=x',
    '未知品类回落 detail：与改造前一致，不会把入口变成死路'
  );
  assert.equal(
    productRoute.productDetailUrl({ id: 'x' }),
    '/pages/detail/detail?id=x',
    'category 缺失（存量数据）同样回落 detail'
  );

  // 边界：id 缺失 / 空白 → 空串，调用方据此跳过跳转（不得拼出 `?id=` 这种坏地址）。
  assert.equal(productRoute.productDetailUrl({ category: 'PHONE_PLAN' }), '', '无 id 时不得拼出地址');
  assert.equal(productRoute.productDetailUrl({ category: 'PHONE_PLAN', id: '   ' }), '', '空白 id 同样不得拼出地址');
  assert.equal(productRoute.productDetailUrl(null), '', '入参为 null 时不得抛错');
  assert.equal(productRoute.productDetailUrl(), '', '入参缺省时不得抛错');

  // id 必须转义，否则含 `&` / 空格的 id 会把 query 拆坏。
  assert.equal(
    productRoute.productDetailUrl({ category: 'PHONE_PLAN', id: 'a b&c' }),
    '/pages/card/card?planId=a%20b%26c',
    'id 必须 encodeURIComponent，否则 query 会被拆坏'
  );

  // ★ 正向控制：两个品类必须给出**不同**地址 ——
  // 否则「一律返回同一个地址」也会让 ⑦⑧ 同时通过（那是同一个值在自证）。
  assert.notEqual(
    productRoute.productDetailUrl({ category: 'PHONE_PLAN', id: 'x' }),
    productRoute.productDetailUrl({ category: 'E_BIKE_NEW', id: 'x' }),
    '★ 正向控制：两个品类必须给出不同地址'
  );
});

test('商品跳转走 openLink（tabBar 识别与失败提示都靠它，裸 navigateTo 会静默失败）', () => {
  const calls = [];
  const originalWx = global.wx;
  global.wx = {
    navigateTo: (options) => calls.push({ kind: 'navigateTo', url: options.url }),
    switchTab: (options) => calls.push({ kind: 'switchTab', url: options.url }),
    setStorageSync: () => {},
    removeStorageSync: () => {}
  };
  try {
    const url = productRoute.openProductDetail({ category: 'PHONE_PLAN', id: 'p1' });
    assert.equal(url, '/pages/card/card?planId=p1', '返回值应是实际使用的地址');
    assert.deepEqual(calls, [{ kind: 'navigateTo', url: '/pages/card/card?planId=p1' }], '非 tabBar 页走 navigateTo');

    // id 缺失时不得发起任何跳转（否则会跳到 `?planId=` 的坏地址）。
    calls.length = 0;
    assert.equal(productRoute.openProductDetail({ category: 'PHONE_PLAN' }), '', 'id 缺失时应返回空串');
    assert.equal(calls.length, 0, '★ id 缺失时不得发起跳转');
  } finally {
    global.wx = originalWx;
  }
});

// ===========================================================================
// 十二、发布页草稿（M6-P1-02 / M7-P1-02）
//
// 草稿的核心风险不是「存不进去」，而是**存进去的是坏内容**：
// 图片是临时路径 / 草稿里混着已发布的内容 / 空草稿覆盖有效草稿。
// 这三类都能在纯函数层真实断言，所以规则全部抽在 `utils/publish-draft.js`，
// 页面只负责在正确的时机调用它（页面级接线见 `miniapp-page-blocks.test.js`）。
// ===========================================================================

/** 一份「用户真的填过」的市场草稿，字段与页面 `data` 一一对应。 */
const MARKET_DRAFT_FIXTURE = {
  title: '高等数学教材（第七版）',
  description: '只翻过前三章，书角有轻微折痕，荟园自提',
  contact: 'wx_hello_2026',
  priceInput: '25.5',
  category: 'BOOK',
  condition: 'LIKE_NEW',
  images: ['/api/uploads/1a2b.jpg', '/api/uploads/3c4d.png']
};

/** 一份「用户真的填过」的论坛草稿。 */
const FORUM_DRAFT_FIXTURE = {
  title: '找一起自习的同学',
  content: '每周三、五晚上在图书馆四楼，长期有效。',
  board: 'STUDY',
  images: ['/api/uploads/9f8e.jpg']
};

test('M6-P1-02 ① 草稿写入用 PRD 指定的 key，且往返后逐字段一致', () => {
  const stub = createWxStub();
  const written = withWx(stub, () => publishDraft.writeDraft(publishDraft.DRAFT_KEYS.MARKET, MARKET_DRAFT_FIXTURE));

  assert.equal(written, true, '① 写入成功必须返回 true（返回值供调用方决定是否提示）');
  assert.deepEqual(
    stub.calls.setStorageSync,
    [{ key: 'campusGoMarketDraft', value: MARKET_DRAFT_FIXTURE }],
    '① 必须以 PRD 指定的 campusGoMarketDraft 为 key，把整份草稿写进去（只写一次）'
  );
  assert.equal(publishDraft.DRAFT_KEYS.MARKET, 'campusGoMarketDraft', '① key 字面量必须与 PRD 一致');
  assert.equal(publishDraft.DRAFT_KEYS.FORUM, 'campusGoForumDraft', '① 论坛 key 自定但必须稳定');

  // 往返：写进去再读出来，逐字段一致。只断言「写了一次」不够 ——
  // 存进去是 `[object Object]` 也能让上面那条通过。
  const back = withWx(stub, () => publishDraft.readDraft(publishDraft.DRAFT_KEYS.MARKET, publishDraft.normalizeMarketDraft));
  assert.deepEqual(back, MARKET_DRAFT_FIXTURE, '① 往返后必须逐字段一致（图片 URL 也要原样带回）');

  // 论坛侧同样的往返。
  const forumStub = createWxStub();
  withWx(forumStub, () => publishDraft.writeDraft(publishDraft.DRAFT_KEYS.FORUM, FORUM_DRAFT_FIXTURE));
  assert.deepEqual(
    withWx(forumStub, () => publishDraft.readDraft(publishDraft.DRAFT_KEYS.FORUM, publishDraft.normalizeForumDraft)),
    FORUM_DRAFT_FIXTURE,
    '① 论坛草稿同样必须往返一致'
  );
  assert.deepEqual(
    forumStub.calls.setStorageSync.map((call) => call.key),
    ['campusGoForumDraft'],
    '① 两页的 key 必须不同 —— 否则市集的草稿会被论坛页恢复出来'
  );
});

test('M6-P1-02 ③ clearDraft 真的把草稿从 Storage 里拿掉', () => {
  const stub = createWxStub({ initialStorage: { campusGoMarketDraft: MARKET_DRAFT_FIXTURE } });
  assert.deepEqual(stub.storageKeys(), ['campusGoMarketDraft'], '③ 前置：草稿确实在 Storage 里');

  const cleared = withWx(stub, () => publishDraft.clearDraft(publishDraft.DRAFT_KEYS.MARKET));

  assert.equal(cleared, true, '③ 清理成功应返回 true');
  assert.deepEqual(stub.calls.removeStorageSync, [{ key: 'campusGoMarketDraft' }], '③ 必须调用 removeStorageSync');
  assert.deepEqual(stub.storageKeys(), [], '③ 清理后 Storage 里不得再有该 key');
  assert.equal(
    withWx(stub, () => publishDraft.readDraft(publishDraft.DRAFT_KEYS.MARKET, publishDraft.normalizeMarketDraft)),
    null,
    '③ 清理后再读必须读不到 —— 否则下次进页面会把「已发布」的内容恢复出来，用户以为发布失败而再发一次'
  );
});

test('★ ③ 的兜底：removeStorageSync 失败时必须落一份「空草稿」把残留内容盖掉', () => {
  // 为什么需要这道防线：残留草稿会在下次进页面时被恢复成「已发布的内容」→ 重复发布。
  // 清不掉就必须**盖掉**，不能就这么算了。
  const stub = createWxStub({
    initialStorage: { campusGoMarketDraft: MARKET_DRAFT_FIXTURE },
    removeStorageSyncResult: 'fail'
  });

  const cleared = withWx(stub, () => publishDraft.clearDraft(publishDraft.DRAFT_KEYS.MARKET));

  assert.equal(cleared, true, '兜底路径最终仍应报告成功（哨兵已落盘）');
  assert.deepEqual(
    stub.calls.setStorageSync.map((call) => call.key),
    ['campusGoMarketDraft'],
    '兜底必须往**同一个 key** 写一次'
  );
  const stored = stub.storageGet('campusGoMarketDraft');
  assert.notDeepEqual(stored, MARKET_DRAFT_FIXTURE, '兜底必须覆盖掉残留草稿，而不是把它留着');
  // ★ 第二道防线自己也得是好的：若它写的哨兵不是「空」，恢复逻辑仍会把它当成草稿。
  assert.equal(
    publishDraft.isEmptyMarketDraft(stored),
    true,
    '★ 兜底写入的哨兵必须被判为「空草稿」—— 否则第二道防线本身就是坏的'
  );
  const reread = withWx(stub, () => publishDraft.readDraft(publishDraft.DRAFT_KEYS.MARKET, publishDraft.normalizeMarketDraft));
  assert.equal(
    publishDraft.isEmptyMarketDraft(reread),
    true,
    '★ 兜底之后「再读」必须被判为空 —— 这才是第二道防线真正要保证的事（页面的 onLoad 靠这个判断跳过恢复）'
  );
});

test('★ M6-P1-02 ④ 「进页面什么都没填」必须判为空草稿（分类/成色有默认值，不算内容）', () => {
  // 页面初始 data 里 `selectedCategory` / `selectedCondition` 一定是非空对象（有默认值）。
  // 若把它们算进「内容」，则「进页面就退出」也会被当成有草稿 ——
  // 而那份「草稿」只有默认分类，会**覆盖掉上一次的有效草稿**，是数据丢失。
  const untouched = publishDraft.marketDraftOf({
    title: '', description: '', contact: '', priceInput: '', images: [],
    selectedCategory: { key: 'BOOK', label: '二手书' },
    selectedCondition: { key: 'LIKE_NEW', label: '九成新' }
  });
  assert.equal(
    publishDraft.isEmptyMarketDraft(untouched),
    true,
    '★ ④ 空表单必须判为空 —— 否则空草稿会覆盖掉上次的有效草稿（那是数据丢失，不是保守行为）'
  );

  // 逐项「只要有一项有内容就不算空」，避免判据只在全空时成立。
  for (const patch of [
    { title: 'x' }, { description: 'x' }, { contact: 'x' },
    { priceInput: '1' }, { images: ['/api/uploads/a.jpg'] }
  ]) {
    assert.equal(
      publishDraft.isEmptyMarketDraft({ ...untouched, ...patch }),
      false,
      `④ 只要 ${Object.keys(patch)[0]} 有内容就不算空草稿`
    );
  }

  // 只有分类/成色不同 → 仍算空：它们不是「用户填的内容」，而是页面默认值。
  assert.equal(
    publishDraft.isEmptyMarketDraft({ ...untouched, category: 'ELECTRONICS', condition: 'USED' }),
    true,
    '④ 分类/成色有默认值，不得单独构成「有草稿」'
  );
  assert.equal(publishDraft.isEmptyMarketDraft(null), true, '④ 读不到草稿（null）也算空');
  assert.equal(publishDraft.isEmptyMarketDraft(undefined), true, '④ undefined 也算空');

  // 论坛侧同理（板块有默认值）。
  const emptyForum = publishDraft.forumDraftOf({ title: '', content: '', images: [], selectedBoard: { key: 'CAMPUS' } });
  assert.equal(publishDraft.isEmptyForumDraft(emptyForum), true, '④ 论坛空表单同样必须判为空');
  assert.equal(publishDraft.isEmptyForumDraft(publishDraft.forumDraftOf({ title: 'x' })), false, '④ 论坛有标题就不算空');
  assert.equal(publishDraft.isEmptyForumDraft(publishDraft.forumDraftOf({ content: 'x' })), false, '④ 论坛有正文就不算空');
  assert.equal(publishDraft.isEmptyForumDraft(publishDraft.forumDraftOf({ images: ['/api/uploads/a.jpg'] })), false, '④ 论坛只有图片也算有内容');
  assert.equal(publishDraft.isEmptyForumDraft(null), true, '④ 论坛读不到草稿也算空');
});

test('★ M6-P1-02 ⑤ 草稿里的图片必须是服务端 URL：临时路径一律被剔除（不假装恢复了图片）', () => {
  // `wx.chooseMedia` 的 `tempFilePath` 不是持久的（微信会在会话结束后清理），
  // 而两页的 `chooseImage()` 在上传成功回调里**只把服务端 URL 存进 data.images**
  // —— 临时路径从未被保留过。草稿因此天然是持久的。
  // 但 Storage 里可能混进别的形状（历史版本 / 别处写入），必须提前挡掉：
  // 存进去就等于「恢复出一个图片框，图是坏的」—— 那是在向用户断言假事实。
  const mixed = [
    '/api/uploads/ok-1.jpg',
    'wxfile://tmp_abc123.jpg',
    'http://tmp/other.png',
    '/api/uploads/ok-2.png',
    'blob:https://x/y',
    '',
    null,
    42
  ];
  assert.deepEqual(
    publishDraft.normalizeImages(mixed, 6),
    ['/api/uploads/ok-1.jpg', '/api/uploads/ok-2.png'],
    '⑤ 只保留 /api/uploads/ 开头的项 —— 服务端对其它形状一律 400，恢复出来也渲染不了'
  );

  // ★ 正向控制：合法项必须**原样保留**。否则「一律过滤成空数组」也能让上面那条通过。
  assert.deepEqual(
    publishDraft.normalizeImages(MARKET_DRAFT_FIXTURE.images, 6),
    MARKET_DRAFT_FIXTURE.images,
    '★ 正向控制：合法的服务端 URL 必须原样保留（过滤不得伤及无辜）'
  );

  // 张数上限与服务端 `images.slice(0, N)` 对齐。
  const many = Array.from({ length: 8 }, (item, index) => `/api/uploads/img-${index}.jpg`);
  assert.equal(publishDraft.normalizeImages(many, 6).length, 6, '⑤ 市场侧最多保留 6 张（与服务端 slice(0, 6) 一致）');
  assert.equal(publishDraft.normalizeImages(many, 3).length, 3, '⑤ 论坛侧最多保留 3 张（与服务端 slice(0, 3) 一致）');
  assert.deepEqual(publishDraft.normalizeImages(many, 6)[5], '/api/uploads/img-5.jpg', '⑤ 截断必须是**保留前 6 张**，不是后 6 张');

  // 非数组一律当空：不得抛错，也不得把字符串当成数组用。
  for (const raw of [undefined, null, 'wxfile://tmp_x.jpg', 42, {}]) {
    assert.deepEqual(publishDraft.normalizeImages(raw, 6), [], `⑤ normalizeImages(${JSON.stringify(raw)}) 必须回落空数组`);
  }

  // 归一化后的草稿同样只留服务端 URL（走完整路径，而不只是单独调 filter）。
  assert.deepEqual(
    publishDraft.normalizeMarketDraft({ ...MARKET_DRAFT_FIXTURE, images: mixed }).images,
    ['/api/uploads/ok-1.jpg', '/api/uploads/ok-2.png'],
    '⑤ 归一化草稿时也要过一遍过滤'
  );
  assert.deepEqual(
    publishDraft.normalizeForumDraft({ ...FORUM_DRAFT_FIXTURE, images: mixed }).images,
    ['/api/uploads/ok-1.jpg', '/api/uploads/ok-2.png'],
    '⑤ 论坛侧同样过滤（上限 3，这里只给了 2 张合法的）'
  );

  // ★ 一条「只剩临时路径」的草稿必须整体判为空 —— 这样页面就不会显示
  // 「已恢复上次未发布的草稿」，也不会渲染出任何图片框。
  const tempOnly = { ...MARKET_DRAFT_FIXTURE, title: '', description: '', contact: '', priceInput: '', images: ['wxfile://tmp_only.jpg'] };
  assert.equal(
    publishDraft.isEmptyMarketDraft(publishDraft.normalizeMarketDraft(tempOnly)),
    true,
    '★ ⑤ 草稿里只剩失效的临时路径时必须整体判为空 —— 硬约束是「不能出现恢复了图片框但图片是坏的」'
  );
});

test('M6-P1-02 ⑥ 字数计数与服务端同口径（59 / 60 / 61 三个边界）', () => {
  assert.deepEqual(
    publishDraft.countText('a'.repeat(59), 60),
    { length: 59, maxLength: 60, over: false, text: '59/60' },
    '⑥ 59 字：未超限'
  );
  assert.deepEqual(
    publishDraft.countText('a'.repeat(60), 60),
    { length: 60, maxLength: 60, over: false, text: '60/60' },
    '⑥ ★ 60/60 必须**不**标记超限 —— 若这里 over 为 true，用户会被拦在一个服务端本来接受的输入上'
  );
  assert.deepEqual(
    publishDraft.countText('a'.repeat(61), 60),
    { length: 61, maxLength: 60, over: true, text: '61/60' },
    '⑥ 61 字：超限'
  );

  // 未填写 / 脏值不得抛错。
  assert.equal(publishDraft.countText(undefined, 60).text, '0/60', '⑥ 未填写时计数为 0/60，不得抛错');
  assert.equal(publishDraft.countText(null, 500).length, 0, '⑥ null 按空串处理');
  assert.equal(publishDraft.countText(42, 60).length, 0, '⑥ 非字符串按空串处理（与服务端 requireString 同口径）');

  // ★ 口径 = **UTF-16 码元数**，与服务端 `requireString` 里
  // `(typeof value === 'string' ? value.trim() : '').length` 完全同源。
  // 若前端改成「按码点 / 按字」计数，就会出现「界面显示 60/60 但服务端说太长」。
  assert.equal(publishDraft.countText('🎓', 60).length, 2, '★ ⑥ emoji 占 2 个码元，必须与服务端同口径');
  assert.equal(publishDraft.countText('教材', 60).length, 2, '⑥ 中文按码元数计');
  assert.equal(publishDraft.countText('🎓'.repeat(30), 60).over, false, '⑥ 30 个 emoji = 60 码元，恰好在界内');
  assert.equal(publishDraft.countText('🎓'.repeat(31), 60).over, true, '⑥ 31 个 emoji = 62 码元，越界');

  // 截断保留尽可能多的内容（只截展示、不截数据会重现「显示与数据不一致」）。
  assert.equal(publishDraft.clampText('a'.repeat(70), 60).length, 60, '⑥ 超长值应被截断到上限');
  assert.equal(publishDraft.clampText('短', 60), '短', '⑥ 未超长时原样返回');
  assert.equal(publishDraft.clampText(null, 60), '', '⑥ 脏值回落空串');
});

test('M6-P1-02 ⑦ 价格校验与服务端同源（0 / 0.01 / 100000 / 100000.01）', () => {
  // 空输入 = 「尚未填写」，不是「填错了」：返回空串，按钮不置灰。
  // 否则用户一进页面看到的第一个东西就是一个灰按钮。
  assert.equal(publishDraft.priceErrorOf(''), '', '⑦ 空输入不是错误');
  assert.equal(publishDraft.priceErrorOf('   '), '', '⑦ 纯空白同样按未填写处理');
  assert.equal(publishDraft.priceErrorOf(null), '', '⑦ null 同样按未填写处理');

  // 边界四连（与服务端 `priceInCents <= 0 || priceInCents > 10000000` 一一对应）。
  assert.notEqual(publishDraft.priceErrorOf('0'), '', '⑦ 0 元必须非法（服务端 priceInCents <= 0 拒绝）');
  assert.equal(publishDraft.priceErrorOf('0.01'), '', '⑦ 0.01 元是下界，必须合法');
  assert.equal(publishDraft.priceErrorOf('100000'), '', '⑦ 100000 元是上界，必须合法');
  assert.notEqual(
    publishDraft.priceErrorOf('100000.01'),
    '',
    '⑦ ★ 100000.01 元必须在本地就被拦下 —— 改造前它会一路发到服务端再吃一个 400（白跑一趟网络往返）'
  );
  assert.notEqual(publishDraft.priceErrorOf('-1'), '', '⑦ 负数非法');
  assert.notEqual(publishDraft.priceErrorOf('abc'), '', '⑦ 非数字非法');
  assert.notEqual(publishDraft.priceErrorOf('1e9'), '', '⑦ 科学计数法换算后越界，同样非法');

  // 换算与服务端 `Math.round(Number(body.priceInCents))` 同源。
  assert.equal(publishDraft.priceInCentsOf('0.01'), 1, '⑦ 0.01 元 = 1 分（= 服务端下界）');
  assert.equal(publishDraft.priceInCentsOf('29'), 2900, '⑦ 29 元 = 2900 分（既有用例 M6-P0-01 依赖这个值）');
  assert.equal(publishDraft.priceInCentsOf('25.5'), 2550, '⑦ 25.5 元 = 2550 分');
  assert.equal(publishDraft.priceInCentsOf('100000'), 10000000, '⑦ 上界 100000 元 = 10000000 分（= 服务端上界常量）');
  assert.equal(publishDraft.priceInCentsOf('1.005'), 100, '⑦ ★ 浮点误差必须被 Math.round 收掉（1.005×100 = 100.49999…）');

  // ★ 正向控制：上界与「上界 + 1 分」必须真的落在常量的两侧。
  // 没有这条，「越界值」可能只是被我写错的期望值，而判据在边界上是钝的。
  assert.equal(publishDraft.PRICE_MAX_CENTS, 10000000, '⑦ 上界常量必须与服务端字面量一致');
  assert.ok(
    publishDraft.priceInCentsOf('100000.01') > publishDraft.PRICE_MAX_CENTS,
    '★ ⑦ 越界值必须真的越过上界常量'
  );
  assert.equal(publishDraft.PRICE_MIN_CENTS, 1, '⑦ 下界 1 分对应服务端的「> 0」');
  assert.equal(publishDraft.PRICE_MAX_YUAN * 100, publishDraft.PRICE_MAX_CENTS, '⑦ 元/分换算必须自洽');
});

test('★ M6-P1-02 ⑧ 草稿读写容错：Storage 抛错时不得把异常抛给页面', () => {
  // 写：配额耗尽 / 隐私模式 → `setStorageSync` 抛。
  // 调用点在 `onHide` / `onUnload`，抛出去会打断页面生命周期。
  const writeFail = createWxStub({ setStorageSyncResult: 'fail' });
  assert.equal(
    withWx(writeFail, () => publishDraft.writeDraft(publishDraft.DRAFT_KEYS.MARKET, MARKET_DRAFT_FIXTURE)),
    false,
    '⑧ 写入失败必须返回 false 而不是抛异常（草稿是辅助能力，不该拦住用户发布）'
  );

  // 读：`getStorageSync` 抛 → 当作「没有草稿」。
  const readFail = createWxStub({ getStorageSyncResult: 'fail' });
  assert.equal(
    withWx(readFail, () => publishDraft.readDraft(publishDraft.DRAFT_KEYS.MARKET, publishDraft.normalizeMarketDraft)),
    null,
    '⑧ 读取失败必须当作「没有草稿」，不得抛异常'
  );

  // 兜底路径也失败时：仍不得抛（`clearDraft` 的 catch 里又调了 `writeDraft`）。
  const bothFail = createWxStub({
    initialStorage: { campusGoMarketDraft: MARKET_DRAFT_FIXTURE },
    removeStorageSyncResult: 'fail',
    setStorageSyncResult: 'fail'
  });
  assert.equal(
    withWx(bothFail, () => publishDraft.clearDraft(publishDraft.DRAFT_KEYS.MARKET)),
    false,
    '⑧ 两道防线都失败时返回 false，但绝不抛'
  );

  // 归一化对任何脏形状都不抛（Storage 里可能是历史版本的形状 / 被别的代码覆盖过）。
  for (const raw of [undefined, null, '', 0, 'string', [], true, { images: 'not-array' }, { title: 42 }, { images: [{}] }]) {
    assert.doesNotThrow(() => publishDraft.normalizeMarketDraft(raw), `⑧ normalizeMarketDraft(${JSON.stringify(raw)}) 不得抛错`);
    assert.doesNotThrow(() => publishDraft.normalizeForumDraft(raw), `⑧ normalizeForumDraft(${JSON.stringify(raw)}) 不得抛错`);
  }
  assert.equal(publishDraft.normalizeMarketDraft([]), null, '⑧ 数组不是合法草稿形状 → null');
  assert.equal(publishDraft.normalizeMarketDraft('x'), null, '⑧ 字符串不是合法草稿形状 → null');
  assert.equal(publishDraft.normalizeForumDraft(null), null, '⑧ null → null');

  // 超长草稿读回来必须被截断，而不是把超长值带进页面（那会变成「界面显示 61/60 却能提交」）。
  const oversized = publishDraft.normalizeMarketDraft({ ...MARKET_DRAFT_FIXTURE, title: 'a'.repeat(70) });
  assert.equal(oversized.title.length, 60, '⑧ 超长标题读回来必须被截到 60');
  assert.equal(publishDraft.countText(oversized.title, 60).over, false, '⑧ 截断后不得再标记超限');
});

test('★ 前端字段约束（上限 + contact 下限）必须与服务端源码逐条同源（防漂移：服务端改了而前端没跟 → 此用例转红）', () => {
  const appPath = path.join(__dirname, '..', 'server', 'src', 'app.js');
  assert.ok(fs.existsSync(appPath), `服务端源码应存在（server/ 是 submodule，需先 checkout）：${appPath}`);
  const source = fs.readFileSync(appPath, 'utf8');

  /**
   * 截取某个 POST 端点的源码片段。
   *
   * 必须按 `request.method === 'POST' && pathname === '...'` 精确定位：
   * `/api/market/items` 的 GET 分支在前，若只按 pathname 找会截到 GET 那段，
   * 里面没有任何 `requireString` —— 判据会以「找不到」而不是「不一致」失败，
   * 那就成了「红在错误的原因上」。
   *
   * @param {string} endpoint 端点路径。
   * @returns {string} 该 POST 分支的源码片段。
   */
  function endpointSource(endpoint) {
    const marker = `request.method === 'POST' && pathname === '${endpoint}'`;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `服务端应存在 POST ${endpoint}`);
    const rest = source.slice(start + marker.length);
    const next = rest.indexOf("request.method === 'POST' && pathname ===");
    return next >= 0 ? rest.slice(0, next) : rest;
  }

  /**
   * 取出端点片段里某字段的 `maxLength`。
   *
   * @param {string} endpoint 端点路径。
   * @param {string} field 字段名。
   * @returns {number} 服务端实际使用的上限。
   */
  function serverMaxLength(endpoint, field) {
    const fragment = endpointSource(endpoint);
    const match = fragment.match(new RegExp(`requireString\\(body\\.${field}, '${field}', \\{[^}]*?maxLength: (\\d+)`));
    assert.ok(match, `服务端 POST ${endpoint} 的 ${field} 应有 maxLength`);
    return Number(match[1]);
  }

  /**
   * 取出端点片段里某字段的 `minLength`（T44 新增，与 `serverMaxLength` 完全对称）。
   *
   * @param {string} endpoint 端点路径。
   * @param {string} field 字段名。
   * @returns {number} 服务端实际使用的下限。
   */
  function serverMinLength(endpoint, field) {
    const fragment = endpointSource(endpoint);
    const match = fragment.match(new RegExp(`requireString\\(body\\.${field}, '${field}', \\{[^}]*?minLength: (\\d+)`));
    assert.ok(match, `服务端 POST ${endpoint} 的 ${field} 应有 minLength`);
    return Number(match[1]);
  }

  // ★★ 为什么是 `[^}]*?` 而不是 `[\s\S]*?`（**T44 修掉的一个「绿在错误原因上」的洞**）
  //
  // `[\s\S]*?` 能跨过字段选项对象的 `}`，于是「找 A 字段的 minLength」会一路找到
  // **B 字段**的 minLength。实测（`server/src/app.js` 的 POST /api/market/items 片段）：
  //
  //     minLength(title)       = 5   ← 错！title 根本没有 minLength，这是 contact 的
  //     minLength(description) = 5   ← 错！同上
  //     minLength(contact)     = 5   ← 对，但只是**碰巧**对
  //
  // 也就是说，用 `[\s\S]*?` 时上面那条 contact 断言**即使问错字段也照样绿** ——
  // 判据会在「压根没查 contact」的情况下通过，属于本会话一直在追的那类失效。
  // 收紧为 `[^}]*?`（不跨出选项对象）后：title / description 正确地「找不到」，
  // contact 正确地取到 5。既有 5 条 maxLength 断言的取值**一个都没变**（60 / 500 / 50），
  // 因为每个字段自己的 maxLength 本来就是最近的那个。
  //
  // ★ 判据自测：两种红必须可区分 —— 「找不到」与「数值不一致」。
  // 没有这两条，就无法判断下面的断言是红在数值上，还是红在正则压根没命中上。
  assert.throws(
    () => serverMinLength('/api/market/items', 'title'),
    /应有 minLength/,
    '★ 判据自测：title 只有 maxLength，问它的 minLength 必须以「找不到」失败（证明两种红可区分）'
  );
  assert.throws(
    () => serverMinLength('/api/market/items', 'priceInCents'),
    /应有 minLength/,
    '★ 判据自测：非 requireString 字段必须以「找不到」失败，而不是返回邻居的值'
  );
  assert.throws(
    () => serverMaxLength('/api/market/items', 'priceInCents'),
    /应有 maxLength/,
    '★ 判据自测：serverMaxLength 同样不得跨字段取值'
  );
  // ★ 正向控制：contact 必须**真的**取到值（否则上面三条「找不到」可以靠「永远找不到」通过）。
  assert.equal(
    typeof serverMinLength('/api/market/items', 'contact'), 'number',
    '★ 正向控制：contact 必须真的能取到 minLength —— 否则上面的「找不到」是钝的'
  );

  assert.equal(
    serverMaxLength('/api/market/items', 'title'),
    publishDraft.FIELD_LIMITS.market.title,
    '★ 市集标题上限：前端常量必须等于服务端 requireString 的 maxLength'
  );
  assert.equal(
    serverMaxLength('/api/market/items', 'description'),
    publishDraft.FIELD_LIMITS.market.description,
    '★ 市集描述上限必须等于服务端 maxLength'
  );
  assert.equal(
    serverMaxLength('/api/market/items', 'contact'),
    publishDraft.FIELD_LIMITS.market.contact,
    '★ 联系方式上限必须等于服务端 maxLength'
  );
  // ★ T44：contact 的**下限**同样要同源。上限只拦住「太长」，
  // 下限拦的是「太短」—— 服务端把 minLength 上调而前端仍放 5 字符过去，
  // 用户就会白跑一趟网络往返吃 400，正是 `market/publish.js` 本地拦截要避免的失效模式。
  assert.equal(
    serverMinLength('/api/market/items', 'contact'),
    publishDraft.CONTACT_MIN_LENGTH,
    '★ 联系方式下限必须等于服务端 minLength —— 前端本地拦截用的是同一个常量，不得手抄'
  );
  assert.equal(
    serverMaxLength('/api/forum/posts', 'title'),
    publishDraft.FIELD_LIMITS.forum.title,
    '★ 帖子标题上限必须等于服务端 maxLength'
  );
  assert.equal(
    serverMaxLength('/api/forum/posts', 'content'),
    publishDraft.FIELD_LIMITS.forum.content,
    '★ 帖子正文上限必须等于服务端 maxLength'
  );

  // 价格：服务端 `!Number.isFinite(priceInCents) || priceInCents <= 0 || priceInCents > 10000000`。
  const marketFragment = endpointSource('/api/market/items');
  const priceMatch = marketFragment.match(/priceInCents > (\d+)/);
  assert.ok(priceMatch, '服务端应有价格上界判定');
  assert.equal(Number(priceMatch[1]), publishDraft.PRICE_MAX_CENTS, '★ 价格上界必须与服务端 10000000 分一致');
  assert.ok(marketFragment.includes('priceInCents <= 0'), '服务端下界是「<= 0」，即 0.01 元起');

  // 图片张数：服务端 `body.images.slice(0, N)`。
  const marketImages = marketFragment.match(/body\.images\.slice\(0, (\d+)\)/);
  assert.ok(marketImages, '服务端应有市场图片张数上限');
  assert.equal(Number(marketImages[1]), publishDraft.IMAGE_LIMITS.market, '★ 市场图片张数上限必须与服务端一致');
  const forumImages = endpointSource('/api/forum/posts').match(/body\.images\.slice\(0, (\d+)\)/);
  assert.ok(forumImages, '服务端应有论坛图片张数上限');
  assert.equal(Number(forumImages[1]), publishDraft.IMAGE_LIMITS.forum, '★ 论坛图片张数上限必须与服务端一致');

  // 图片前缀：服务端只接受 `/api/uploads/`，草稿里存别的一律 400。
  assert.ok(
    marketFragment.includes(`!image.startsWith('${publishDraft.UPLOAD_URL_PREFIX}')`),
    '★ 图片前缀常量必须与服务端的校验一致（否则草稿里的图片到提交时全变 400）'
  );
  assert.ok(
    endpointSource('/api/forum/posts').includes(`!image.startsWith('${publishDraft.UPLOAD_URL_PREFIX}')`),
    '★ 论坛侧图片前缀同样必须与服务端一致'
  );

  // 输入框的 `maxlength` 也必须与常量一致 —— 否则用户能输入服务端不接受的长度。
  /**
   * 取出 wxml 里某个 `bindinput` 处理器所在的标签原文。
   *
   * @param {string} wxml wxml 源码。
   * @param {string} handler bindinput 处理器名。
   * @returns {string} 标签原文。
   */
  function inputTag(wxml, handler) {
    const match = wxml.match(new RegExp(`<(?:input|textarea)[^>]*bindinput="${handler}"[^>]*>`));
    assert.ok(match, `wxml 应有 bindinput="${handler}" 的输入框`);
    return match[0];
  }

  const marketWxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'market', 'publish.wxml'), 'utf8');
  assert.ok(
    inputTag(marketWxml, 'setTitle').includes(`maxlength="${publishDraft.FIELD_LIMITS.market.title}"`),
    '★ 市集标题输入框的 maxlength 必须等于常量 60（与服务端同源）'
  );
  assert.ok(
    inputTag(marketWxml, 'setDescription').includes(`maxlength="${publishDraft.FIELD_LIMITS.market.description}"`),
    '★ 市集描述输入框的 maxlength 必须等于常量 500'
  );
  assert.ok(
    inputTag(marketWxml, 'setContact').includes(`maxlength="${publishDraft.FIELD_LIMITS.market.contact}"`),
    '★ 联系方式输入框的 maxlength 必须等于常量 50'
  );
  const forumWxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'forum', 'publish.wxml'), 'utf8');
  assert.ok(
    inputTag(forumWxml, 'setTitle').includes(`maxlength="${publishDraft.FIELD_LIMITS.forum.title}"`),
    '★ 帖子标题输入框的 maxlength 必须等于常量 60'
  );
  assert.ok(
    inputTag(forumWxml, 'setContent').includes(`maxlength="${publishDraft.FIELD_LIMITS.forum.content}"`),
    '★ 帖子正文输入框的 maxlength 必须等于常量 1000'
  );
});
