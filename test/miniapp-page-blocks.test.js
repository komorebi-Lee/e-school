/**
 * 页面级「静默失败」回归测试。
 *
 * ## 为什么需要单独一个文件
 *
 * 本批改造的交付物是**页面行为**：接口挂掉时页面要「看得见、点得动」，且
 * 一个块失败不能拖垮其余块。但页面脚本在顶层调用 `Page()`，`test/miniapp-runtime.test.js`
 * 的约定是「只覆盖不依赖 `Page` / `getApp` 的模块」，因此它只能覆盖三态工具本身；
 * `test/miniapp.test.js` 又只能做源码文本断言。
 *
 * 两者都**无法证明**「页面真的接上了工具」—— 把 `loadBlock` 从页面里删掉，
 * 那两处测试依然全绿。所以这里把 `Page` / `wx` / 网络层注入进来，让页面逻辑真跑一遍。
 *
 * ## 实现要点
 *
 * - 用 `Module._load` 拦截 `miniprogram/services/*`，其余（含 `utils/load-state`）用真模块，
 *   保证测的是真实接线而不是替身。
 * - `setData` 支持 `'a.b.c'` 路径写法，与微信一致。
 * - 每个用例结束都还原全局桩，避免污染同进程内的其他用例。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const miniprogramDirectory = path.join(__dirname, '..', 'miniprogram');

// 发布页草稿的共享模块（M6-P1-02 / M7-P1-02）。纯函数、不访问 wx，
// 因此可以在 Node 里直接加载；这里只用它的常量（key / 字段上限），
// 行为断言在 `miniapp-runtime.test.js`。
const publishDraft = require(path.join(miniprogramDirectory, 'utils', 'publish-draft.js'));

/**
 * 把 `{ 'a.b.c': value }` 形式的补丁写进对象，与微信 `setData` 的路径语义一致。
 *
 * @param {object} data 目标对象（就地修改）。
 * @param {object} patch setData 补丁。
 */
function applyPatch(data, patch) {
  for (const key of Object.keys(patch)) {
    const parts = key.split('.');
    let target = data;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (typeof target[parts[index]] !== 'object' || target[parts[index]] === null) target[parts[index]] = {};
      target = target[parts[index]];
    }
    target[parts[parts.length - 1]] = patch[key];
  }
}

/** 等一个宏任务，确保所有微任务链（Promise 链）都跑完。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 搭好页面运行环境。
 *
 * @returns {{loadPage: Function, setApiHandler: Function, storage: object, setRedirect: Function, restore: Function}}
 *   测试用的控制面。
 */
function createHarness() {
  const storage = {};
  let redirectUrl = '';
  // 草稿写入可能因配额耗尽 / 隐私模式而抛错（T42）。默认**不抛**，
  // 既有用例的行为因此逐字不变；需要验证「写失败时页面不崩」的用例
  // 用 `setStorageWriteFailure(true)` 打开。
  let storageWriteShouldFail = false;
  // 草稿读取同样可能抛错（T42）。默认**不抛**；`setStorageReadFailure(true)` 打开，
  // 用于验证「读不到草稿时页面仍能进」这条降级路径。
  let storageReadShouldFail = false;
  // `navigateBack` 默认静默成功；置 true 时回调 `fail`，用于验证「无上一页」的兜底分支。
  let navigateBackShouldFail = false;
  // `wx.showModal` / `wx.showToast` 的调用记录。
  // 不自动回调 `success`：由用例显式调用 `modal.success({ confirm: true })`，
  // 才能分别覆盖「点去支付」与「点稍后再说」两条分支。
  const modalCalls = [];
  const toastCalls = [];
  const switchTabCalls = [];
  const navigateBackCalls = [];
  const wxStub = new Proxy({
    getStorageSync: (key) => {
      if (storageReadShouldFail) throw new Error(`getStorageSync:fail ${key}`);
      return storage[key];
    },
    setStorageSync: (key, value) => {
      if (storageWriteShouldFail) throw new Error(`setStorageSync:fail ${key}`);
      storage[key] = value;
    },
    removeStorageSync: (key) => { delete storage[key]; },
    nextTick: (fn) => fn(),
    redirectTo: (options) => { redirectUrl = options.url; },
    switchTab: (options) => { switchTabCalls.push(options.url); },
    showModal: (options) => { modalCalls.push(options); },
    showToast: (options) => { toastCalls.push(options); },
    navigateBack: (options) => {
      navigateBackCalls.push({ options });
      if (navigateBackShouldFail && typeof options?.fail === 'function') options.fail({ errMsg: 'navigateBack:fail' });
    },
    env: { USER_DATA_PATH: '/tmp' },
    createSelectorQuery: () => ({
      selectAll: () => ({ boundingClientRect: () => ({}) }),
      selectViewport: () => ({ scrollOffset: () => ({}) }),
      exec: () => {}
    })
  }, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (typeof key === 'string') return () => {};
      return undefined;
    }
  });

  let apiHandler = () => Promise.resolve({ data: {} });
  // 支付调用默认成功；用例可置为 reject 来模拟「订单已创建但支付失败」。
  let paymentHandler = () => Promise.resolve({});
  // 业务配置的返回值。默认值与改造前**逐字一致**（既有用例依赖它），
  // 所以把写死的字面量抽成变量对既有用例是零行为变化。
  // 需要验证「上限随配置变化 / 配置缺失回落 / 配置后到」的用例用下面的 setter 覆盖。
  let businessConfigHandler = () => Promise.resolve({ phoneCardActivationHours: 48 });
  // 记录页面把跳转委托给 openLink 的调用（tabBar 页必须走它，不能自己调 navigateTo）。
  const openLinkCalls = [];
  const stubs = new Map([
    [require.resolve(path.join(miniprogramDirectory, 'services', 'api.js')), {
      request: (requestPath, options) => apiHandler(requestPath, options),
      apiRequest: (requestPath, options) => apiHandler(requestPath, options),
      userId: () => 'user-1'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'business.js')), {
      loadBusinessConfig: () => businessConfigHandler()
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'payment.js')), {
      payPaymentOrder: (paymentOrder) => paymentHandler(paymentOrder),
      payPaymentOrderById: (orderId) => paymentHandler({ id: orderId })
    }],
    [require.resolve(path.join(miniprogramDirectory, 'utils', 'navigation.js')), {
      openLink: (url, options) => { openLinkCalls.push({ url, options }); }
    }]
  ]);

  const originalLoad = Module._load;
  const originalPage = global.Page;
  const originalWx = global.wx;
  let captured = null;

  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (stubs.has(resolved)) return stubs.get(resolved);
    return originalLoad.apply(this, arguments);
  };
  global.Page = (definition) => { captured = definition; };
  global.wx = wxStub;

  return {
    storage,
    setApiHandler(handler) { apiHandler = handler; },
    /**
     * 设置 `loadBusinessConfig` 的**返回值**（立即 resolve）。
     *
     * @param {object} value 业务配置对象；缺字段即为「配置未下发该字段」。
     */
    setBusinessConfig(value) { businessConfigHandler = () => Promise.resolve(value); },
    /**
     * 设置 `loadBusinessConfig` 的**行为**（可延迟 resolve，用于验证并发竞态）。
     *
     * @param {Function} handler 无参函数，返回 Promise。
     */
    setBusinessConfigHandler(handler) { businessConfigHandler = handler; },
    /** 设置支付调用的行为（resolve = 支付成功；reject = 订单已创建但支付失败）。 */
    setPaymentHandler(handler) { paymentHandler = handler; },
    /** 记录到的 `wx.showModal` 调用（`success` 回调保留，由用例显式触发）。 */
    getModals() { return modalCalls.slice(); },
    /** 记录到的 `wx.showToast` 调用。 */
    getToasts() { return toastCalls.slice(); },
    /**
     * 让 `wx.setStorageSync` 抛错（T42 草稿写入失败路径）。
     *
     * @param {boolean} value true = 之后每次写入都抛错。
     */
    setStorageWriteFailure(value) { storageWriteShouldFail = Boolean(value); },
    /**
     * 让 `wx.getStorageSync` 抛错（T42 草稿读取失败路径）。
     *
     * @param {boolean} value true = 之后每次读取都抛错。
     */
    setStorageReadFailure(value) { storageReadShouldFail = Boolean(value); },
    /** 记录到的 `wx.switchTab` 目标（成功路径的跳转回归用）。 */
    getSwitchTabCalls() { return switchTabCalls.slice(); },
    /** 记录到的 `wx.navigateBack` 调用（改约被拒后应退回上一页）。 */
    getNavigateBackCalls() { return navigateBackCalls.map((call) => ({ ...call })); },
    clearNavigateBackCalls() { navigateBackCalls.length = 0; },
    clearModals() { modalCalls.length = 0; },
    clearToasts() { toastCalls.length = 0; },
    clearSwitchTabCalls() { switchTabCalls.length = 0; },
    getRedirectUrl() { return redirectUrl; },
    /** 控制 `wx.navigateBack` 是否回调 `fail`（验证「无上一页」的兜底分支）。 */
    setNavigateBackFailure(value) { navigateBackShouldFail = Boolean(value); },
    /** 页面把跳转委托给 openLink 的调用记录。 */
    getOpenLinkCalls() { return openLinkCalls.map((call) => ({ ...call })); },
    clearOpenLinkCalls() { openLinkCalls.length = 0; },
    /**
     * 加载一个页面脚本，并构造一个可以真实调用其方法的实例。
     *
     * @param {string} relativePath 相对 `miniprogram/` 的路径。
     * @returns {object} 页面实例（方法已绑定，`setData` 会写进 `this.data`）。
     */
    loadPage(relativePath) {
      captured = null;
      const file = path.join(miniprogramDirectory, relativePath);
      delete require.cache[require.resolve(file)];
      // ★ 页面**间接** require 的工具模块也必须从缓存里清掉。
      //
      // 这些模块在被 require 的那一刻就捕获了本次 harness 的桩：例如
      // `utils/product-route.js` 顶部 `require('./navigation')` 拿到的就是本次的
      // `openLink` 桩。若它留在缓存里，后续用例的页面会继续调用**上一个 harness
      // 的桩** —— 记录落进上一个实例的数组，本用例读到空数组，
      // 「没有发生跳转」这类断言就会**假通过**（而「跳了」的断言会假失败）。
      for (const name of fs.readdirSync(path.join(miniprogramDirectory, 'utils'))) {
        if (!name.endsWith('.js')) continue;
        delete require.cache[require.resolve(path.join(miniprogramDirectory, 'utils', name))];
      }
      require(file);
      assert.ok(captured, `${relativePath} 应调用 Page() 注册页面`);
      const definition = captured;
      const instance = {
        data: JSON.parse(JSON.stringify(definition.data)),
        setData(patch) { applyPatch(this.data, patch); }
      };
      for (const key of Object.keys(definition)) {
        if (typeof definition[key] === 'function') instance[key] = definition[key].bind(instance);
      }
      return instance;
    },
    restore() {
      Module._load = originalLoad;
      global.Page = originalPage;
      global.wx = originalWx;
    }
  };
}

test('真实页面逻辑：块之间互相独立，失败不清空数据，且保留既有降级', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // ==================== 一、card 页 ====================
  harness.setApiHandler((requestPath) => {
    if (requestPath.startsWith('/api/products')) return Promise.reject(new Error('套餐接口 500'));
    if (requestPath === '/api/recharge-promos') {
      return Promise.resolve({ data: [{ id: 'p1', pay: 100, receive: 120, isBuyable: true }] });
    }
    return Promise.resolve({ data: [] });
  });
  const card = harness.loadPage(path.join('pages', 'card', 'card.js'));
  card.onLoad({});
  await settle();

  assert.equal(card.data.plansBlock.loading, false, 'card：套餐块应结束加载态');
  assert.equal(card.data.plansBlock.error, '套餐接口 500', 'card：套餐块应写入接口错误文案');
  // 注意：只断言 `error === ''` 是不够的 —— 一个「压根没被加载过」的块同样是 ''，
  // 断言会**空过**。必须同时要求 `loading === false`（即它确实跑完过一轮），
  // 否则「两块共用一份状态」这类变异会从这条断言底下溜过去。
  assert.equal(
    card.data.promosBlock.loading, false,
    '★ card：活动块必须自己跑完一轮 —— 否则它可能压根没被加载，或状态被别人覆盖'
  );
  assert.equal(
    card.data.promosBlock.error, '',
    '★ card：活动块不得被套餐的失败牵连（PRD M2-P1-02 的核心要求）'
  );
  assert.equal(card.data.promosBlock.data.length, 1, 'card：活动块应正常渲染数据');
  assert.equal(card.data.configBlock.data.phoneCardActivationHours, 48, 'card：配置块独立成功');
  assert.equal(card.activationHours(), 48, 'card：激活时长应读到配置块');
  assert.deepEqual(card.currentPlans(), [], 'card：套餐数据缺失时应回落空数组，模板取属性不报错');

  // 重试成功 → 数据写入。
  harness.setApiHandler((requestPath) => (requestPath.startsWith('/api/products')
    ? Promise.resolve({ data: [{ id: 'pl1', name: '套餐A', priceInCents: 9900, stock: 3, active: true }] })
    : Promise.resolve({ data: [] })));
  await card.retryPlans();
  assert.equal(card.data.plansBlock.error, '', 'card：重试成功后应清掉错误');
  assert.equal(card.data.plansBlock.data[0].monthlyFee, 99, 'card：effectivePriceInCents 计价不得回归');

  // ★ 失败不清空：已有数据必须原样保留。
  harness.setApiHandler(() => Promise.reject(new Error('又挂了')));
  await card.retryPlans();
  assert.equal(card.data.plansBlock.error, '又挂了', 'card：再次失败应写入错误');
  assert.equal(
    card.data.plansBlock.data.length, 1,
    '★ card：失败时不得清空已加载的套餐 —— 清空等于告诉用户「这里本来就没有套餐」'
  );

  // ==================== 二、merchant 页 ====================
  harness.storage.campusGoMerchantId = 'm1';
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/merchant/login') return Promise.resolve({ data: { token: 'tok' } });
    if (requestPath === '/api/merchant/overview') {
      return Promise.resolve({
        data: {
          merchant: { id: 'm1', name: '测试商家', licenseExpireDate: '2027-01-01', settlementAccountReady: true },
          metrics: { revenueInCents: 1000, orderCount: 2, pendingCount: 1, today: { orderCount: 1, revenueInCents: 500 } },
          orders: [], settlements: [], payoutRequests: [], slaAlerts: [], riskTasks: [], products: [],
          pendingPublishProducts: [], scoreCases: [], qualificationRenewals: [], promotionSummary: []
        }
      });
    }
    if (requestPath === '/api/merchant/notifications') return Promise.reject(new Error('通知接口 503'));
    if (requestPath === '/api/merchant/message-subscriptions') return Promise.resolve({ data: { subscribed: true } });
    if (requestPath === '/api/subscribe-templates') {
      return Promise.resolve({ data: [{ key: 'k1', description: '售后提醒', audience: 'MERCHANT', configuredId: 'x1' }] });
    }
    if (requestPath === '/api/merchant/revenue-trend') {
      return Promise.resolve({ data: { series: [{ date: '2026-01-01', revenueInCents: 500, orderCount: 1 }] } });
    }
    if (requestPath.startsWith('/api/merchant/settlement-statement')) {
      return Promise.resolve({ data: { totals: { businessGrossInCents: 100, commissionInCents: 1, businessPayableInCents: 99, refundInCents: 0, netInCents: 99, payoutPaidInCents: 0 } } });
    }
    return Promise.resolve({ data: [] });
  });
  const merchant = harness.loadPage(path.join('pages', 'merchant', 'index.js'));
  // 注意：`load()` 内部没有 `return`（`onShow` 也不需要），所以它返回 undefined，
  // 只能等一个宏任务边界让整条 Promise 链跑完，而不是 `await load()`。
  merchant.load();
  await settle();

  assert.equal(merchant.data.loading, false, 'merchant：主体加载应结束');
  assert.equal(merchant.data.merchant.name, '测试商家', 'merchant：主体数据应写入');
  assert.equal(merchant.data.notificationsBlock.error, '通知接口 503', 'merchant：通知块应暴露错误');

  // ★ 一个块挂掉，其余四块必须照常成功（改造前它们被合并成一个静默失败）。
  // 每条都先要求 `loading === false`：确认该块**确实跑完过一轮**，而不是空过。
  assert.equal(merchant.data.templatesBlock.loading, false, '★ merchant：模板块必须自己跑完一轮');
  assert.equal(merchant.data.templatesBlock.error, '', '★ merchant：模板块不得被通知块牵连');
  assert.equal(merchant.data.templatesBlock.data.items.length, 1, 'merchant：模板块应有数据');
  assert.equal(merchant.data.templatesBlock.data.configuredCount, 1, 'merchant：已配置模板数应正确');
  assert.equal(merchant.data.subscriptionsBlock.loading, false, '★ merchant：订阅块必须自己跑完一轮');
  assert.equal(merchant.data.subscriptionsBlock.data.subscribed, true, '★ merchant：订阅块不得被牵连');
  assert.equal(merchant.data.trendBlock.loading, false, '★ merchant：趋势块必须自己跑完一轮');
  assert.equal(merchant.data.trendBlock.data.hasData, true, '★ merchant：趋势块不得被牵连');
  assert.equal(merchant.data.trendBlock.data.totalRevenueText, '5.00', 'merchant：趋势数据应经 buildTrend 归一化');
  assert.equal(merchant.data.statementBlock.loading, false, '★ merchant：对账单块必须自己跑完一轮');
  assert.equal(merchant.data.statementBlock.data.totals.netInCents, 99, '★ merchant：对账单块不得被牵连');

  // 重试通知 → 成功。
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/merchant/notifications') {
      return Promise.resolve({ data: [{ id: 'n1', title: '标题', content: '内容', read: false, createdAt: '2026-01-01T10:00:00Z' }] });
    }
    if (requestPath === '/api/merchant/notifications/read') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: [] });
  });
  await merchant.retryNotifications();
  assert.equal(merchant.data.notificationsBlock.error, '', 'merchant：重试通知后应清掉错误');
  assert.equal(merchant.data.notificationsBlock.data.items.length, 1, 'merchant：重试后应有列表');
  assert.equal(merchant.data.notificationsBlock.data.unread, 1, 'merchant：块内未读数应正确');
  assert.equal(merchant.data.workbenchCounts.messages, 1, 'merchant：页签红点应同步未读数');

  // ★ 失败不清空。
  harness.setApiHandler(() => Promise.reject(new Error('再次挂')));
  await merchant.retryNotifications();
  assert.equal(merchant.data.notificationsBlock.error, '再次挂', 'merchant：再次失败应写入错误');
  assert.equal(
    merchant.data.notificationsBlock.data.items.length, 1,
    '★ merchant：通知失败时不得清空已加载的列表'
  );

  await merchant.retryStatement();
  assert.equal(
    merchant.data.statementBlock.data.totals.netInCents, 99,
    '★ merchant：对账单失败时不得清空已加载的数据'
  );
  assert.equal(merchant.data.statementBlock.error, '再次挂', 'merchant：对账单块应暴露错误');

  // ==================== 三、既有降级逻辑必须保留 ====================
  harness.storage.campusGoMerchantId = 'm1';
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/merchant/login') return Promise.resolve({ data: { token: 'tok' } });
    if (requestPath === '/api/merchant/overview') return Promise.reject(new Error('overview 挂了'));
    if (requestPath.startsWith('/api/merchants')) return Promise.resolve({ data: [{ id: 'm1', status: 'REVIEWING' }] });
    return Promise.resolve({ data: [] });
  });
  const unapproved = harness.loadPage(path.join('pages', 'merchant', 'index.js'));
  unapproved.load();
  await settle();
  assert.equal(
    harness.getRedirectUrl(), '/pages/merchant/apply',
    '★ merchant：overview 失败时仍必须走「申请入驻」降级路径（本次改造不得破坏它）'
  );
  assert.equal(unapproved.data.loading, false, 'merchant：降级路径也应退出 loading');
});

/**
 * 第二批：5 个「失败时显示空列表」的页面。
 *
 * 为什么这批比模式 A（完全静默）更急：模式 A 用户至少知道「没东西」，
 * 而**模式 B 是在向用户断言一个假事实** —— 接口失败时显示空列表，
 * 用户会相信「确实没有帖子 / 闲置 / 足迹 / 评价 / 收藏」。**误导比沉默更糟。**
 *
 * 每条断言都遵守上一批的教训：**否定式断言必须附带「对象确实被初始化过」的证据**
 * （`loading === false` / `Array.isArray` / `deepEqual([], ...)`），
 * 否则一个「压根没被加载过」的块会让 `error === ''` 这类断言**假通过**。
 */
test('第二批：5 个列表页失败时不清空数据，且「加载中 / 失败 / 无数据」三态互不混淆', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  /** 每个页面的接线信息。`seed` 用于制造「已有旧数据」的场景。 */
  const pages = [
    {
      name: 'forum', file: path.join('pages', 'forum', 'forum.js'),
      load: 'loadPosts', retry: 'retryPosts', key: 'postsBlock', endpoint: '/api/forum/posts',
      seed: [{ id: 's1', title: '帖子一' }, { id: 's2', title: '帖子二' }]
    },
    {
      name: 'market', file: path.join('pages', 'market', 'market.js'),
      load: 'loadItems', retry: 'retryItems', key: 'itemsBlock', endpoint: '/api/market/items',
      seed: [{ id: 's1', title: '闲置一' }, { id: 's2', title: '闲置二' }]
    },
    {
      name: 'footprints', file: path.join('pages', 'footprints', 'footprints.js'),
      load: 'load', retry: 'retryFootprints', key: 'footprintsBlock', endpoint: '/api/my/footprints',
      seed: [{ id: 's1', name: '商品一' }, { id: 's2', name: '商品二' }]
    },
    {
      name: 'reviews', file: path.join('pages', 'reviews', 'reviews.js'),
      load: 'load', retry: 'retryReviews', key: 'reviewsBlock', endpoint: '/api/my/product-reviews',
      seed: [{ id: 's1', productName: '商品一', rating: 5 }, { id: 's2', productName: '商品二', rating: 4 }]
    },
    {
      name: 'favorites', file: path.join('pages', 'favorites', 'favorites.js'),
      load: 'loadFavorites', retry: 'retryFavorites', key: 'favoritesBlock', endpoint: '/api/my/favorites',
      seed: [{ id: 's1', name: '商品一' }, { id: 's2', name: '商品二' }]
    }
  ];

  /** 只让目标接口有数据，其余一律空数组。 */
  const serving = (endpoint, payload) => (requestPath) => (
    requestPath === endpoint ? Promise.resolve({ data: payload }) : Promise.resolve({ data: [] })
  );

  // ==================== ① 有旧数据时失败 → 旧数据保留 + error 可见 ====================
  harness.setApiHandler(serving('/api/forum/posts', pages[0].seed));
  const forum = harness.loadPage(pages[0].file);
  await forum.loadPosts();
  assert.equal(forum.data.postsBlock.data.length, 2, '① forum 首次加载应有 2 条');
  assert.equal(forum.data.postsBlock.error, '', '① forum 成功时不应有错误');
  assert.equal(forum.data.filtered.length, 2, '① forum 派生列表应同步');

  harness.setApiHandler(() => Promise.reject(new Error('论坛接口挂了')));
  await forum.loadPosts();
  assert.equal(forum.data.postsBlock.error, '论坛接口挂了', '① ★ forum 失败必须暴露错误，不能沉默');
  assert.equal(forum.data.postsBlock.loading, false, '⑧ forum 必须确实跑完过一轮（否则下面的断言会假通过）');
  assert.equal(
    forum.data.postsBlock.data.length, 2,
    '① ★★ forum 失败时不得清空旧帖子 —— 清空等于告诉用户「确实没有帖子」'
  );
  assert.equal(forum.data.filtered.length, 2, '① forum 派生列表也不得被清空');

  // ==================== ② 无旧数据时失败 → 列表为空，但 error 非空 ====================
  // 关键：必须能区分「失败」与「无数据」——两者列表都为空，只有 error 不同。
  const forumCold = harness.loadPage(pages[0].file);
  harness.setApiHandler(() => Promise.reject(new Error('首次就挂了')));
  await forumCold.loadPosts();
  assert.deepEqual(
    forumCold.data.postsBlock.data, [],
    '② forum 首次失败时列表为空（且必须是真数组，不是 undefined）'
  );
  assert.equal(
    forumCold.data.postsBlock.error, '首次就挂了',
    '② ★★ forum 首次失败时 error 必须非空 —— 这是「失败」与「无数据」唯一的区分点'
  );
  assert.equal(forumCold.data.postsBlock.loading, false, '⑧ forum 首次失败后也必须结束加载态');

  // ==================== ③ market 同上两条 ====================
  harness.setApiHandler(serving('/api/market/items', pages[1].seed));
  const market = harness.loadPage(pages[1].file);
  await market.loadItems();
  assert.equal(market.data.itemsBlock.data.length, 2, '③ market 首次加载应有 2 条');
  harness.setApiHandler(() => Promise.reject(new Error('市集接口挂了')));
  await market.loadItems();
  assert.equal(market.data.itemsBlock.error, '市集接口挂了', '③ ★ market 失败必须暴露错误');
  assert.equal(market.data.itemsBlock.loading, false, '⑧ market 必须确实跑完过一轮');
  assert.equal(
    market.data.itemsBlock.data.length, 2,
    '③ ★★ market 失败时不得清空旧闲置 —— 否则页面会说「暂时没有符合条件的闲置」'
  );
  assert.equal(market.data.filtered.length, 2, '③ market 派生列表也不得被清空');

  const marketCold = harness.loadPage(pages[1].file);
  await marketCold.loadItems();
  assert.deepEqual(marketCold.data.itemsBlock.data, [], '③ market 首次失败时列表为空');
  assert.equal(marketCold.data.itemsBlock.error, '市集接口挂了', '③ ★★ market 首次失败时 error 必须非空');
  assert.equal(marketCold.data.itemsBlock.loading, false, '⑧ market 首次失败后也必须结束加载态');

  // ==================== ④ footprints / reviews：失败 → 数据保留 + error 非空 ====================
  for (const name of ['footprints', 'reviews']) {
    const spec = pages.find((item) => item.name === name);
    harness.setApiHandler(serving(spec.endpoint, spec.seed));
    const page = harness.loadPage(spec.file);
    await page[spec.load]();
    assert.equal(page.data[spec.key].data.length, 2, `④ ${name} 首次加载应有 2 条`);

    harness.setApiHandler(() => Promise.reject(new Error(`${name} 接口挂了`)));
    await page[spec.load]();
    assert.equal(page.data[spec.key].error, `${name} 接口挂了`, `④ ★ ${name} 失败必须暴露错误`);
    assert.equal(page.data[spec.key].loading, false, `⑧ ${name} 必须确实跑完过一轮`);
    assert.equal(
      page.data[spec.key].data.length, 2,
      `④ ★★ ${name} 失败时不得清空旧数据 —— 改造前它连 error 都不写，旧数据静默滞留`
    );
  }

  // ==================== ⑤ favorites：失败 → 数据保留 + error 非空 ====================
  const favoritesSpec = pages.find((item) => item.name === 'favorites');
  harness.setApiHandler(serving('/api/my/favorites', favoritesSpec.seed));
  const favorites = harness.loadPage(favoritesSpec.file);
  await favorites.loadFavorites();
  assert.equal(favorites.data.favoritesBlock.data.length, 2, '⑤ favorites 首次加载应有 2 条');
  harness.setApiHandler(() => Promise.reject(new Error('收藏接口挂了')));
  await favorites.loadFavorites();
  assert.equal(favorites.data.favoritesBlock.error, '收藏接口挂了', '⑤ ★ favorites 失败必须暴露错误');
  assert.equal(favorites.data.favoritesBlock.loading, false, '⑧ favorites 必须确实跑完过一轮');
  assert.equal(
    favorites.data.favoritesBlock.data.length, 2,
    '⑤ ★★ favorites 失败时不得清空收藏 —— 改造前它是「半对」：有 toast 但仍然清空'
  );

  // ==================== ⑥ 重试必须真的重新发起请求 ====================
  let forumCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath !== '/api/forum/posts') return Promise.resolve({ data: [] });
    forumCalls += 1;
    return forumCalls === 1
      ? Promise.reject(new Error('第一次挂'))
      : Promise.resolve({ data: [{ id: 'r1', title: '恢复的帖子' }] });
  });
  const forumRetry = harness.loadPage(pages[0].file);
  await forumRetry.loadPosts();
  assert.equal(forumRetry.data.postsBlock.error, '第一次挂', '⑥ 前置：第一次应失败');
  assert.equal(forumCalls, 1, '⑥ 前置：应只请求过一次');
  await forumRetry.retryPosts();
  assert.equal(forumCalls, 2, '⑥ ★★ 重试必须真的重新发起请求（而不是只把 error 清掉）');
  assert.equal(forumRetry.data.postsBlock.error, '', '⑥ 重试成功后应清掉错误');
  assert.equal(forumRetry.data.postsBlock.data.length, 1, '⑥ 重试成功后应写入新数据');
  assert.equal(forumRetry.data.postsBlock.loading, false, '⑥ 重试成功后应结束加载态');

  // ==================== ⑦ ★ 反向护栏：5 个页面都不得在失败路径清空数据 ====================
  for (const spec of pages) {
    harness.setApiHandler(serving(spec.endpoint, spec.seed));
    const page = harness.loadPage(spec.file);
    await page[spec.load]();
    assert.equal(page.data[spec.key].data.length, spec.seed.length, `⑦ ${spec.name} 前置：应先加载成功`);

    harness.setApiHandler(() => Promise.reject(new Error('boom')));
    await page[spec.load]();
    assert.equal(page.data[spec.key].loading, false, `⑧ ${spec.name} 必须确实跑完过一轮`);
    assert.equal(page.data[spec.key].error, 'boom', `⑦ ${spec.name} 失败应暴露错误`);
    assert.equal(
      page.data[spec.key].data.length, spec.seed.length,
      `⑦ ★★ ${spec.name} 的失败路径不得 setData 出空数组（清空 = 向用户断言「本来就没有」）`
    );
    assert.deepEqual(
      page.data[spec.key].data.map((item) => item.id), spec.seed.map((item) => item.id),
      `⑦ ★ ${spec.name} 保留的必须是原来那批数据，而不是空壳`
    );
  }
});

/**
 * 从 wxml 里抽出与「三态」有关的条件分支，并按 WXML 的**链**语义分组。
 *
 * WXML 的 `wx:elif` / `wx:else` 只与**紧邻的** `wx:if` 成链；因此一个 `wx:if`
 * 会开启新链，`elif` / `else` 续在当前链上。链内第一个为真的分支胜出。
 *
 * @param {string} wxml 模板源码。
 * @returns {Array<Array<{kind: string, expr: string, label: string}>>} 每条链的分支列表。
 */
function extractStateChains(wxml) {
  const isStateLine = (line) => (
    line.includes('load-error')
    || line.includes('class="empty card"')
    || line.includes('class="loading muted"')
    || line.includes('sale-banner')
    || /<block wx:else/.test(line)
  );
  const branches = [];
  for (const line of wxml.split('\n')) {
    if (!isStateLine(line)) continue;
    // 注意：加载占位复用了 `empty card` 这个类，只能靠文案区分，
    // 否则「加载中」会被误标成「空态」—— 探针第一版就是这么标错的。
    const label = line.includes('load-error') ? '错误占位(含重试)'
      : line.includes('sale-banner') ? '促销横幅'
        : /正在加载|正在同步/.test(line) ? '加载中占位'
          : line.includes('class="empty card"') ? '空态(暂无数据)'
            : line.includes('<block') ? '列表'
              : '其他';
    const matched = line.match(/wx:(if|elif)="\{\{([^}]+)\}\}"/);
    if (matched) branches.push({ kind: matched[1], expr: matched[2].trim(), label });
    else if (line.includes('wx:else')) branches.push({ kind: 'else', expr: 'true', label });
  }
  const chains = [];
  for (const branch of branches) {
    if (branch.kind === 'if' || chains.length === 0) chains.push([]);
    chains[chains.length - 1].push(branch);
  }
  return chains;
}

/**
 * 按链语义求值，返回**真正会渲染出来**的分支标签。
 *
 * @param {Array<Array<{expr: string, label: string}>>} chains 分支链。
 * @param {object} data 页面 data。
 * @returns {Array<string>} 每条链胜出的分支标签（无分支命中时为空）。
 */
function renderStateChains(chains, data) {
  const rendered = [];
  for (const chain of chains) {
    for (const branch of chain) {
      let value = false;
      try {
        // 求值的是 wxml 里的**原始表达式文本**，不是我重写的一份判断。
        value = Boolean(new Function('data', `with (data) { return (${branch.expr}); }`)(data));
      } catch (error) {
        value = false;
      }
      if (value) { rendered.push(branch.label); break; }
    }
  }
  return rendered;
}

/**
 * 「三态互不混淆」的模板级验证。
 *
 * 为什么必须有这一层：`test/miniapp.test.js` 只检查空态条件文本**存在**，
 * 但一段正确的文本若落在错误的 `wx:if` / `wx:elif` **链**里，渲染结果依然是错的。
 * 这里把 wxml 里真实的条件文本抽出来求值，验证三种输入下**真正渲染出来的分支**。
 */
test('三态互不混淆：5 个页面在「加载中 / 失败 / 无数据」下渲染的分支互不串台', () => {
  const pages = [
    { name: '论坛', wxml: path.join('pages', 'forum', 'forum.wxml'), key: 'postsBlock', hasFiltered: true },
    { name: '市集', wxml: path.join('pages', 'market', 'market.wxml'), key: 'itemsBlock', hasFiltered: true },
    { name: '足迹', wxml: path.join('pages', 'footprints', 'footprints.wxml'), key: 'footprintsBlock' },
    { name: '评价', wxml: path.join('pages', 'reviews', 'reviews.wxml'), key: 'reviewsBlock' },
    { name: '收藏', wxml: path.join('pages', 'favorites', 'favorites.wxml'), key: 'favoritesBlock' }
  ];

  for (const page of pages) {
    const chains = extractStateChains(fs.readFileSync(path.join(miniprogramDirectory, page.wxml), 'utf8'));
    /** 构造页面 data：列表块 + 该页依赖的派生字段。 */
    const fixture = (block, extra = {}) => {
      const data = { [page.key]: block, ...extra };
      if (page.hasFiltered) data.filtered = block.data;
      if (page.key === 'favoritesBlock') data.saleCount = 0;
      return data;
    };

    const loading = renderStateChains(chains, fixture({ loading: true, error: '', data: [] }));
    const failed = renderStateChains(chains, fixture({ loading: false, error: '接口 500', data: [] }));
    const empty = renderStateChains(chains, fixture({ loading: false, error: '', data: [] }));
    const stale = renderStateChains(chains, fixture({ loading: false, error: '接口 500', data: [{ id: 'a' }, { id: 'b' }] }));

    // 注意：失败且无数据时，「列表」容器本身仍会渲染 —— 但它有 0 条数据，
    // 屏幕上什么也不显示。真正要守住的是**空态不许出现**（见下一条 ★）。
    // 加载中：只出加载占位，绝不能出现错误占位或空态。
    assert.ok(
      loading.includes('加载中占位') && !loading.includes('错误占位(含重试)') && !loading.includes('空态(暂无数据)'),
      `${page.name}：加载中应只渲染加载占位，实得 ${JSON.stringify(loading)}`
    );
    // ★★ 失败：出错误占位，且**绝不能**出现「空态」—— 那是把「没取到」说成「确实没有」。
    assert.ok(
      failed.includes('错误占位(含重试)') && !failed.includes('空态(暂无数据)'),
      `${page.name}：失败必须渲染错误占位，且不得渲染空态，实得 ${JSON.stringify(failed)}`
    );
    // 无数据：确实没有数据时才出空态，且不得出现错误占位。
    assert.ok(
      empty.includes('空态(暂无数据)') && !empty.includes('错误占位(含重试)'),
      `${page.name}：只有确实没有数据时才渲染空态，实得 ${JSON.stringify(empty)}`
    );
    // 失败 + 旧数据：错误占位与旧列表并存，不得出现空态。
    assert.ok(
      stale.includes('错误占位(含重试)') && stale.includes('列表') && !stale.includes('空态(暂无数据)'),
      `${page.name}：失败时旧列表必须继续可见，且不得渲染空态，实得 ${JSON.stringify(stale)}`
    );
  }
});

test('第三批：plate 申请状态三态化；动作类失败不得产生错误占位', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // ==================== 一、plate：加载类 → 三态 ====================
  const servingStatus = (records) => (requestPath) => (
    requestPath === '/api/service-records'
      ? Promise.resolve({ data: { serviceRecords: records } })
      : Promise.resolve({ data: [] })
  );
  const plateRecord = { id: 'pl1', type: 'PLATE', statusLabel: '审核中', title: '轻风 通勤版', amountInCents: 4900 };

  // ① 有旧数据时失败 → 旧数据保留 + error 可见
  harness.setApiHandler(servingStatus([plateRecord]));
  const plate = harness.loadPage(path.join('pages', 'plate', 'plate.js'));
  await plate.loadStatus();
  assert.equal(plate.data.statusBlock.data.id, 'pl1', 'plate：首次加载应写入申请状态');
  assert.equal(plate.data.statusBlock.error, '', 'plate：成功时不应有错误');
  assert.equal(plate.data.statusBlock.loading, false, '⑧ plate：状态块必须确实跑完过一轮');

  harness.setApiHandler(() => Promise.reject(new Error('状态接口 500')));
  await plate.loadStatus();
  assert.equal(plate.data.statusBlock.error, '状态接口 500', '★ plate：失败必须暴露错误，不能沉默');
  assert.equal(plate.data.statusBlock.loading, false, '⑧ plate：失败后必须结束加载态');
  assert.equal(
    plate.data.statusBlock.data.id, 'pl1',
    '★ plate：失败时不得清空已加载的状态 —— 否则「没取到」会被渲染成「你还没申请」，用户可能重复提交'
  );

  // ② 无旧数据时失败 → 无状态数据，但 error 非空（能区分「失败」与「还没申请」）
  const plateCold = harness.loadPage(path.join('pages', 'plate', 'plate.js'));
  harness.setApiHandler(() => Promise.reject(new Error('首次就挂了')));
  await plateCold.loadStatus();
  assert.equal(
    plateCold.data.statusBlock.data, undefined,
    'plate：首次失败时不应有状态数据（且必须真的是 undefined，不是空壳）'
  );
  assert.equal(
    plateCold.data.statusBlock.error, '首次就挂了',
    '★ plate：首次失败时 error 必须非空 —— 这是「失败」与「还没申请」唯一的区分点'
  );
  assert.equal(plateCold.data.statusBlock.loading, false, '⑧ plate：首次失败后也必须结束加载态');

  // ③ 重试必须真的重新发起请求
  let statusCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath !== '/api/service-records') return Promise.resolve({ data: [] });
    statusCalls += 1;
    return statusCalls === 1
      ? Promise.reject(new Error('第一次挂'))
      : Promise.resolve({ data: { serviceRecords: [] } });
  });
  const plateRetry = harness.loadPage(path.join('pages', 'plate', 'plate.js'));
  await plateRetry.loadStatus();
  assert.equal(plateRetry.data.statusBlock.error, '第一次挂', 'plate：前置，第一次应失败');
  assert.equal(statusCalls, 1, 'plate：前置，应只请求过一次');
  await plateRetry.retryStatus();
  assert.equal(statusCalls, 2, '★ plate：重试必须真的重新发起请求（而不是只把 error 清掉）');
  assert.equal(plateRetry.data.statusBlock.error, '', 'plate：重试成功后应清掉错误');
  assert.equal(plateRetry.data.statusBlock.loading, false, 'plate：重试成功后应结束加载态');

  // ==================== 二、动作类：失败不得产生错误占位 ====================
  // profile 的「上报已读」是动作：失败既不清空列表，也不该产生任何错误态。
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/my/notifications') {
      return Promise.resolve({ data: [{ id: 'n1', title: 'a', read: false }, { id: 'n2', title: 'b', read: true }] });
    }
    if (requestPath === '/api/my/notifications/read') return Promise.reject(new Error('上报失败'));
    return Promise.resolve({ data: [] });
  });
  const profile = harness.loadPage(path.join('pages', 'profile', 'profile.js'));
  await profile.loadNotifications();
  // ★ 先用**肯定式**证明列表确实被初始化过（不是空壳），再做「未被牵连」的判断 ——
  // 否则「列表没变」这种否定式断言在「压根没加载过」时会假通过。
  assert.ok(Array.isArray(profile.data.notifications), '★ profile：通知列表必须是数组（证明它确实被初始化过）');
  assert.equal(profile.data.notifications.length, 2, 'profile：前置，通知应加载 2 条');
  assert.equal(profile.data.unreadNotificationCount, 1, 'profile：前置，未读数应为 1');

  const before = JSON.parse(JSON.stringify(profile.data));
  await profile.markNotificationsRead();
  await settle();
  assert.equal(profile.data.notifications.length, 2, '★ 动作类失败不得清空列表 —— 上报已读失败与「列表内容」无关');
  assert.equal(profile.data.unreadNotificationCount, 1, '★ 动作类失败不得篡改未读数');
  assert.deepEqual(
    profile.data, before,
    '★ 动作类（上报已读）失败不得改动页面任何可见状态 —— 既不清空列表，也不产生错误占位'
  );
});

test('第四批：orders / addresses / aftersales 失败不再清空数据；租赁行为逐条不变', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const RENTAL = {
    id: 'o-renting', orderNo: 'R001', status: 'RENTING', totalInCents: 9900,
    items: [{ name: '轻风 通勤版', quantity: 1, productId: 'p1', merchantId: 'm1' }],
    orderKind: 'RENTAL',
    rental: { status: 'RENTING', dueAt: '2026-02-01T10:00:00.000Z', plan: { unit: 'MONTH', units: 1 }, depositInCents: 5000 },
    fulfillment: {}, merchantName: '测试商家',
    createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z'
  };
  const EBIKE = {
    id: 'e1', orderNo: 'E001', status: 'COMPLETED', statusLabel: '已完成', totalInCents: 19900,
    merchantName: '测试商家',
    items: [{ name: '轻风 通勤版', quantity: 1, productId: 'p1', merchantId: 'm1' }],
    fulfillment: {}, createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z'
  };
  const serveOrders = (orders) => (requestPath) => (
    requestPath === '/api/my/orders'
      ? Promise.resolve({ data: { ebikeOrders: orders, serviceRecords: [] } })
      : Promise.resolve({ data: [] })
  );

  // ==================== ① orders：失败 → 不清空 + error 可见 ====================
  harness.setApiHandler(serveOrders([RENTAL]));
  const orders = harness.loadPage(path.join('pages', 'orders', 'orders.js'));
  orders.loadRecords();
  await settle();
  assert.equal(orders.data.records.length, 1, '① orders 首次加载应有 1 条');
  assert.equal(orders.data.recordsError, '', '① orders 成功时不应有错误');

  harness.setApiHandler(() => Promise.reject(new Error('订单接口 500')));
  orders.loadRecords();
  await settle();
  assert.equal(orders.data.recordsError, '订单接口 500', '① ★ orders 失败必须暴露错误，不能沉默');
  assert.equal(orders.data.loading, false, '⑧ orders 必须确实跑完过一轮（否则下面的断言会假通过）');
  assert.equal(
    orders.data.records.length, 1,
    '① ★★ orders 失败时不得清空服务记录 —— 清空等于告诉用户「你确实没有订单」'
  );
  assert.equal(orders.data.filtered.length, 1, '① orders 派生列表也不得被清空');

  // ==================== ⑥ ★ 租赁回归：改造后逐条不变 ====================
  const rentalRecord = orders.data.records[0];
  assert.equal(rentalRecord.orderKind, 'RENTAL', '⑥ 租赁单 orderKind 透传不得改动');
  assert.equal(rentalRecord.isRental, true, '⑥ 租赁单 isRental 不得改动');
  assert.equal(rentalRecord.type, 'E_BIKE', '⑥ 租赁单仍沿用 type E_BIKE（交付码 / 履约依赖它）');
  assert.equal(rentalRecord.canReturnRequest, true, '⑥ RENTING 单 canRequestReturn 必须为 true');
  assert.deepEqual(
    (rentalRecord.journey || []).map((step) => `${step.key}:${step.done ? 'done' : step.current ? 'current' : 'todo'}`),
    ['PAID:done', 'RENTING:current', 'RETURN_REQUESTED:todo', 'RETURNED:todo'],
    '⑥ 租赁进度条必须逐条不变'
  );
  assert.equal(rentalRecord.rentalDueAtText, '2月1日 18:00 前归还', '⑥ 应还时间文案不得改动');
  assert.equal(rentalRecord.nextStep, '凭交付码到校内取车点取车，按租期归还', '⑥ 租赁下一步文案不得改动');
  assert.ok(rentalRecord.rentalCountdownText, '⑥ 应还倒计时不得改动（应有值）');

  // ==================== ⑥ ★★ 页面级也要覆盖「不可申请归还」的两态 ====================
  // 上面只断言了 RENTING 一张单。页面级测的是「页面确实接上了判定」，所以它必须对
  // **判定结果本身**有检出能力 —— 只覆盖 true 时，「RETURN_REQUESTED / PENDING_PAYMENT
  // 也返回 true」这类变异能从页面级整体溜过去（runtime 用例能拦，但那是另一层）。
  harness.setApiHandler((requestPath) => (
    requestPath === '/api/my/orders'
      ? Promise.resolve({
        data: {
          ebikeOrders: [
            RENTAL,
            // 已申请归还：再显示「申请归还」就是重复提交。
            { ...RENTAL, id: 'o-returning', orderNo: 'R002', rental: { ...RENTAL.rental, status: 'RETURN_REQUESTED' } },
            // 未支付：租期还没起算，谈不上归还。
            { ...RENTAL, id: 'o-unpaid', orderNo: 'R003', status: 'PENDING_PAYMENT', rental: { ...RENTAL.rental, status: 'PENDING_PAYMENT' } }
          ],
          serviceRecords: []
        }
      })
      : Promise.resolve({ data: [] })
  ));
  const ordersRentalStates = harness.loadPage(path.join('pages', 'orders', 'orders.js'));
  ordersRentalStates.loadRecords();
  await settle();
  assert.equal(ordersRentalStates.data.records.length, 3, '⑥ 前置：三张租赁单都应加载出来（否则下面两条会假通过）');
  const canReturnById = Object.fromEntries(
    ordersRentalStates.data.records.map((record) => [record.id, record.canReturnRequest])
  );
  assert.equal(canReturnById['o-returning'], false, '⑥ ★★ 已申请归还的单不得再显示「申请归还」—— 那是重复提交');
  assert.equal(canReturnById['o-unpaid'], false, '⑥ ★★ 未支付租赁单不得显示「申请归还」—— 租期还没起算');

  // ==================== ② orders：失败且无旧数据 → 空列表但 error 非空 ====================
  const ordersCold = harness.loadPage(path.join('pages', 'orders', 'orders.js'));
  harness.setApiHandler(() => Promise.reject(new Error('首次就挂了')));
  ordersCold.loadRecords();
  await settle();
  assert.ok(Array.isArray(ordersCold.data.records), '② orders 冷启动失败后 records 仍须是数组（不是 undefined）');
  assert.deepEqual(ordersCold.data.records, [], '② orders 首次失败时列表为空');
  assert.equal(
    ordersCold.data.recordsError, '首次就挂了',
    '② ★★ orders 首次失败时 error 必须非空 —— 这是「失败」与「无订单」唯一的区分点'
  );
  assert.equal(ordersCold.data.loading, false, '⑧ orders 首次失败后也必须结束加载态');

  // ==================== ③ addresses：同上两条 ====================
  const addressRecord = { id: 'a1', contactName: '张三', contactPhone: '13800000000', address: '宿舍 1 栋' };
  harness.setApiHandler((requestPath) => (
    requestPath === '/api/my/addresses' ? Promise.resolve({ data: [addressRecord] }) : Promise.resolve({ data: [] })
  ));
  const addresses = harness.loadPage(path.join('pages', 'addresses', 'addresses.js'));
  addresses.loadAddresses();
  await settle();
  assert.equal(addresses.data.addresses.length, 1, '③ addresses 首次加载应有 1 条');
  harness.setApiHandler(() => Promise.reject(new Error('地址接口 500')));
  addresses.loadAddresses();
  await settle();
  assert.equal(addresses.data.addressesError, '地址接口 500', '③ ★ addresses 失败必须暴露错误');
  assert.equal(addresses.data.loading, false, '⑧ addresses 必须确实跑完过一轮');
  assert.equal(
    addresses.data.addresses.length, 1,
    '③ ★★ addresses 失败时不得清空地址 —— 否则页面会说「还没有常用地址」'
  );

  const addressesCold = harness.loadPage(path.join('pages', 'addresses', 'addresses.js'));
  harness.setApiHandler(() => Promise.reject(new Error('地址首次就挂了')));
  addressesCold.loadAddresses();
  await settle();
  assert.ok(Array.isArray(addressesCold.data.addresses), '③ addresses 冷启动失败后 addresses 仍须是数组');
  assert.deepEqual(addressesCold.data.addresses, [], '③ addresses 首次失败时列表为空');
  assert.equal(addressesCold.data.addressesError, '地址首次就挂了', '③ ★★ addresses 首次失败时 error 必须非空');
  assert.equal(addressesCold.data.loading, false, '⑧ addresses 首次失败后也必须结束加载态');

  // ==================== ④ aftersales：error 非空（改造前完全没有）+ 数据保留 ====================
  const serveContext = (orders, afterSales) => (requestPath) => {
    if (requestPath === '/api/my/orders') return Promise.resolve({ data: { ebikeOrders: orders } });
    if (requestPath === '/api/after-sales') return Promise.resolve({ data: afterSales });
    return Promise.resolve({ data: [] });
  };
  harness.setApiHandler(serveContext([EBIKE], []));
  const aftersales = harness.loadPage(path.join('pages', 'aftersales', 'aftersales.js'));
  aftersales.data.orderId = 'e1';
  await aftersales.loadContext();
  assert.ok(aftersales.data.order, '④ aftersales 前置：应加载到订单');
  assert.equal(aftersales.data.order.title, '轻风 通勤版', '④ aftersales 前置：订单标题应正确');
  assert.equal(aftersales.data.contextError, '', '④ aftersales 成功时不应有错误');

  harness.setApiHandler(() => Promise.reject(new Error('售后接口 500')));
  await aftersales.loadContext();
  assert.equal(
    aftersales.data.contextError, '售后接口 500',
    '④ ★★ aftersales 失败必须暴露错误 —— 改造前它连提示都没有（页面直接变空白）'
  );
  assert.equal(aftersales.data.loading, false, '⑧ aftersales 必须确实跑完过一轮');
  assert.ok(aftersales.data.order, '④ ★★ aftersales 失败时不得清空订单信息');
  assert.equal(aftersales.data.order.title, '轻风 通勤版', '④ aftersales 保留的必须是原来那条订单');

  const aftersalesCold = harness.loadPage(path.join('pages', 'aftersales', 'aftersales.js'));
  aftersalesCold.data.orderId = 'e1';
  harness.setApiHandler(() => Promise.reject(new Error('售后首次就挂了')));
  await aftersalesCold.loadContext();
  assert.equal(aftersalesCold.data.order, null, '④ aftersales 首次失败时没有订单数据');
  assert.equal(
    aftersalesCold.data.contextError, '售后首次就挂了',
    '④ ★★ aftersales 首次失败时 error 必须非空 —— 这是「失败」与「未找到订单」唯一的区分点'
  );
  assert.equal(aftersalesCold.data.loading, false, '⑧ aftersales 首次失败后也必须结束加载态');

  // ==================== ⑤ 三处重试都必须真的重新发起请求 ====================
  let ordersCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath !== '/api/my/orders') return Promise.resolve({ data: [] });
    ordersCalls += 1;
    return ordersCalls === 1
      ? Promise.reject(new Error('第一次挂'))
      : Promise.resolve({ data: { ebikeOrders: [RENTAL], serviceRecords: [] } });
  });
  const ordersRetry = harness.loadPage(path.join('pages', 'orders', 'orders.js'));
  ordersRetry.loadRecords();
  await settle();
  assert.equal(ordersRetry.data.recordsError, '第一次挂', '⑤ orders 前置：第一次应失败');
  assert.equal(ordersCalls, 1, '⑤ orders 前置：应只请求过一次');
  ordersRetry.retryRecords();
  await settle();
  assert.equal(ordersCalls, 2, '⑤ ★★ orders 重试必须真的重新发起请求（而不是只把 error 清掉）');
  assert.equal(ordersRetry.data.recordsError, '', '⑤ orders 重试成功后应清掉错误');
  assert.equal(ordersRetry.data.records.length, 1, '⑤ orders 重试成功后应写入数据');

  let addressCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath !== '/api/my/addresses') return Promise.resolve({ data: [] });
    addressCalls += 1;
    return addressCalls === 1 ? Promise.reject(new Error('第一次挂')) : Promise.resolve({ data: [addressRecord] });
  });
  const addressesRetry = harness.loadPage(path.join('pages', 'addresses', 'addresses.js'));
  addressesRetry.loadAddresses();
  await settle();
  assert.equal(addressesRetry.data.addressesError, '第一次挂', '⑤ addresses 前置：第一次应失败');
  assert.equal(addressCalls, 1, '⑤ addresses 前置：应只请求过一次');
  addressesRetry.retryAddresses();
  await settle();
  assert.equal(addressCalls, 2, '⑤ ★★ addresses 重试必须真的重新发起请求');
  assert.equal(addressesRetry.data.addressesError, '', '⑤ addresses 重试成功后应清掉错误');
  assert.equal(addressesRetry.data.addresses.length, 1, '⑤ addresses 重试成功后应写入数据');

  let contextCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath !== '/api/my/orders') return Promise.resolve({ data: [] });
    contextCalls += 1;
    return contextCalls === 1
      ? Promise.reject(new Error('第一次挂'))
      : Promise.resolve({ data: { ebikeOrders: [EBIKE] } });
  });
  const aftersalesRetry = harness.loadPage(path.join('pages', 'aftersales', 'aftersales.js'));
  aftersalesRetry.data.orderId = 'e1';
  await aftersalesRetry.loadContext();
  assert.equal(aftersalesRetry.data.contextError, '第一次挂', '⑤ aftersales 前置：第一次应失败');
  assert.equal(contextCalls, 1, '⑤ aftersales 前置：应只请求过一次');
  await aftersalesRetry.retryContext();
  assert.equal(contextCalls, 2, '⑤ ★★ aftersales 重试必须真的重新发起请求');
  assert.equal(aftersalesRetry.data.contextError, '', '⑤ aftersales 重试成功后应清掉错误');
  assert.ok(aftersalesRetry.data.order, '⑤ aftersales 重试成功后应写入订单');
});

test('M3-P1-05：待支付倒计时定时器按紧迫度动态切换，且重建时先清后建', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 把 Node 的定时器换成可观测桩：只记录「谁被创建、谁被清掉」，不真的走时间。
  // 用桩而不是真定时器的原因：真定时器会让「同时只有一条存活」这件事无法在
  // 单次运行里断言，而且会让测试进程被挂住的句柄拖住。
  const liveTimers = new Set();
  const events = [];
  const intervals = [];
  let nextHandle = 1;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => {
    const handle = nextHandle;
    nextHandle += 1;
    liveTimers.add(handle);
    intervals.push(ms);
    events.push({ type: 'set', handle, ms });
    return handle;
  };
  global.clearInterval = (handle) => {
    liveTimers.delete(handle);
    events.push({ type: 'clear', handle });
  };
  t.after(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  const MINUTE = 60000;
  const urgentOrder = {
    id: 'u1', orderNo: 'U001', status: 'PENDING_PAYMENT', totalInCents: 9900,
    paymentExpiresAt: new Date(Date.now() + 2 * MINUTE).toISOString(),
    items: [{ name: '轻风 通勤版', quantity: 1, productId: 'p1', merchantId: 'm1' }],
    fulfillment: {}, merchantName: '测试商家',
    createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z'
  };
  const calmOrder = {
    ...urgentOrder, id: 'u2', orderNo: 'U002',
    paymentExpiresAt: new Date(Date.now() + 30 * MINUTE).toISOString()
  };
  const serveOrders = (orders) => (requestPath) => (
    requestPath === '/api/my/orders'
      ? Promise.resolve({ data: { ebikeOrders: orders, serviceRecords: [] } })
      : Promise.resolve({ data: [] })
  );

  // ⑰ 无紧急订单 → 30000ms。
  harness.setApiHandler(serveOrders([calmOrder]));
  const orders = harness.loadPage(path.join('pages', 'orders', 'orders.js'));
  orders.loadRecords();
  await settle();
  orders.startCountdownTimer();
  assert.equal(orders.countdownIntervalFor(), 30000, '⑰ 无紧急订单应回落 30000ms');
  assert.equal(intervals[intervals.length - 1], 30000, '⑰ ★ 实测建出来的间隔必须是 30000ms');
  assert.equal(liveTimers.size, 1, '⑰ 常态下应只有一条定时器存活');

  // ⑰ 出现紧急订单 → 1000ms（由 refreshCountdowns 侦测到档位变化后重建）。
  orders.setData({
    records: orders.data.records.map((item) => ({ ...item, paymentExpiresAt: urgentOrder.paymentExpiresAt }))
  });
  orders.refreshCountdowns();
  assert.equal(orders.countdownIntervalFor(), 1000, '⑰ 有紧急订单应切到 1000ms');
  assert.equal(intervals[intervals.length - 1], 1000, '⑰ ★ 实测建出来的间隔必须是 1000ms');
  assert.equal(liveTimers.size, 1, '⑰ 切换档位后仍只应有一条定时器（切换本身也要先清后建）');
  assert.equal(orders.data.records[0].countdownUrgent, true, '⑰ refreshCountdowns 应把 countdownUrgent 写进记录（模板据此高亮）');

  // ⑰ 脱离紧急档 → 回落到 30000ms。
  orders.setData({
    records: orders.data.records.map((item) => ({ ...item, paymentExpiresAt: calmOrder.paymentExpiresAt }))
  });
  orders.refreshCountdowns();
  assert.equal(intervals[intervals.length - 1], 30000, '⑰ ★ 脱离紧急档必须回落到 30000ms，不能一直按秒空转');
  assert.equal(orders.data.records[0].countdownUrgent, false, '⑰ 脱离紧急档后高亮应撤掉');

  // ⑱ ★ 反复重建不得累积：每次都是先 clear 再 set，存活数恒为 1。
  for (let round = 0; round < 3; round += 1) {
    orders.startCountdownTimer();
    assert.equal(liveTimers.size, 1, `⑱ ★ 第 ${round + 1} 次重建后仍只应有一条定时器（先 clear 再 set）`);
  }
  assert.deepEqual(
    events.slice(-2).map((event) => event.type), ['clear', 'set'],
    '⑱ ★ 重建的最后两步必须是「先 clear 再 set」——少了 clear 就会留下孤儿定时器'
  );

  // ⑱ 停表后存活数为 0；且隐藏页面后到达的加载结果不得把定时器重新拉起来（后台空转）。
  orders.stopCountdownTimer();
  assert.equal(liveTimers.size, 0, '⑱ stopCountdownTimer 应清掉唯一一条定时器');
  orders.loadRecords();
  await settle();
  assert.equal(liveTimers.size, 0, '⑱ ★ 页面已停表时，异步到达的加载结果不得重新拉起定时器');
});

test('M1-P1-02：市集提为 tabBar 页后 forum / market-item 的 goMarket 走 openLink；首页价格不编造', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // ==================== ⑤-a forum.js：goMarket 必须交给 openLink ====================
  // 说明分工：本用例证明「这两个页面把市集跳转委托给 openLink」；
  // 「openLink 对 /pages/market/market 真的走 switchTab」由
  // test/miniapp-runtime.test.js 用真实 navigation.js + wx 桩断言。
  // 两者合起来才是完整保证：页面不再自己调 navigateTo（对 tabBar 页必然失败）。
  const forum = harness.loadPage(path.join('pages', 'forum', 'forum.js'));
  harness.clearOpenLinkCalls();
  forum.goMarket();
  assert.deepEqual(
    harness.getOpenLinkCalls().map((call) => call.url), ['/pages/market/market'],
    '⑤ ★ forum 的 goMarket 必须把市集交给 openLink（tabBar 页走 navigateTo 会静默失败）'
  );

  // ==================== ⑤-b market/item.js：兜底分支同样走 openLink ====================
  const item = harness.loadPage(path.join('pages', 'market', 'item.js'));
  harness.clearOpenLinkCalls();
  harness.setNavigateBackFailure(false);
  item.goMarket();
  assert.deepEqual(
    harness.getOpenLinkCalls(), [],
    '⑤ 有上一页时应优先返回上一页，不该跳市集（正常路径行为不变）'
  );

  harness.setNavigateBackFailure(true);
  item.goMarket();
  assert.deepEqual(
    harness.getOpenLinkCalls().map((call) => call.url), ['/pages/market/market'],
    '⑤ ★ 无上一页的兜底分支，市集也必须经 openLink（而不是 navigateTo）'
  );

  // ==================== ⑥ 首页编造价回归（T18 ①②③ 已修，此处作回归） ====================
  const home = harness.loadPage(path.join('pages', 'home', 'home.js'));

  // 正对照：接口正常时价格必须来自服务端 —— 没有这一步，下面的 null 断言会假通过
  //（一个「压根没跑过 loadCatalog」的页面，价格同样是 null）。
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/products') {
      return Promise.resolve({
        data: [
          { id: 'p1', name: '轻风 通勤版', category: 'E_BIKE_NEW', active: true, effectivePriceInCents: 239900 },
          { id: 'p2', name: '校园卡 29', category: 'PHONE_PLAN', active: true, effectivePriceInCents: 2900, stock: 5 }
        ]
      });
    }
    return Promise.resolve({ data: [] });
  });
  await home.loadCatalog();
  assert.equal(home.data.scooterFromPrice, 2399, '⑥ 正对照：接口正常时车辆起步价必须来自服务端');
  assert.equal(home.data.phoneFromPrice, 29, '⑥ 正对照：接口正常时电话卡起步价必须来自服务端');

  // 断开 /api/products → 价格必须为 null，绝不编造数字
  harness.setApiHandler(() => Promise.reject(new Error('商品接口 500')));
  await home.loadCatalog();
  assert.equal(home.data.scootersLoading, false, '⑥ 必须确实跑完过一轮（否则下面的 null 断言会假通过）');
  assert.equal(home.data.scooterFromPrice, null, '⑥ ★ 接口挂掉后不得编造车辆起步价（曾硬编码 1899，真实最低价 2399）');
  assert.equal(home.data.phoneFromPrice, null, '⑥ ★ 接口挂掉后不得编造电话卡起步价（曾硬编码 19，真实最低价 29）');
  assert.equal(home.data.catalogError, true, '⑥ 失败必须置 catalogError，模板据此给出「价格加载失败，点击重试」');
  const shownPrices = JSON.stringify({ scooter: home.data.scooterFromPrice, phone: home.data.phoneFromPrice });
  assert.equal(shownPrices.includes('1899'), false, '⑥ ★ 页面价格区不得出现编造价 1899');
  assert.equal(shownPrices.includes('19'), false, '⑥ ★ 页面价格区不得出现编造价 19');

  // 接口成功但无数据：同样不编造（「取到空」不等于「有个默认价」）
  harness.setApiHandler(() => Promise.resolve({ data: [] }));
  await home.loadCatalog();
  assert.equal(home.data.scootersLoading, false, '⑥ 空数据也必须跑完一轮');
  assert.equal(home.data.scooterFromPrice, null, '⑥ 接口成功但无商品时同样不得编造车辆价');
  assert.equal(home.data.phoneFromPrice, null, '⑥ 接口成功但无商品时同样不得编造电话卡价');
  assert.equal(home.data.catalogError, false, '⑥ 成功（哪怕空）不应置 catalogError —— 否则会把「暂无报价」说成「加载失败」');

  // 重试入口必须真的重新发起请求
  let catalogCalls = 0;
  harness.setApiHandler(() => { catalogCalls += 1; return Promise.reject(new Error('又挂了')); });
  home.reloadCatalog();
  await settle();
  assert.equal(catalogCalls, 1, '⑥ reloadCatalog 必须真的重新发起请求（而不是只把 catalogError 清掉）');
  assert.equal(home.data.catalogError, true, '⑥ 重试再次失败应保持错误态');
});

test('M3-P1-01：支付失败时用户必须知道订单已存在（与「下单失败」区分）', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const checkout = harness.loadPage(path.join('pages', 'checkout', 'checkout.js'));
  checkout.setData({
    name: '张三', phone: '13800000000', date: '2026-09-01', deliveryAddress: '东区 1 栋 101',
    scooter: { id: 'p1', sellableStock: 5 }, quantity: 1, payToken: 'tok-1',
    deliveryTimeSlots: ['09:00-12:00'], deliveryTimeIndex: 0,
    // `submit()` 的第一道门就是协议勾选，未勾选会直接 return（默认 false）。
    agreed: true,
    // 关掉「保存常用地址」，让成功路径不再多发一个无关请求。
    saveAddress: false
  });

  // ==================== ① ★ 支付失败（订单已创建）→ 必须弹窗，而不是只 toast ====================
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/orders') {
      return Promise.resolve({ data: { id: 'o-777' }, paymentOrder: { id: 'pay-1' } });
    }
    return Promise.resolve({ data: {} });
  });
  harness.setPaymentHandler(() => Promise.reject(new Error('支付被取消')));
  harness.clearModals();
  harness.clearToasts();

  checkout.submit();
  await settle();

  const pendingModal = harness.getModals().at(-1);
  assert.ok(pendingModal, '① ★ 订单已创建但支付失败时必须弹窗 —— 只 toast「提交失败」会让用户以为什么都没发生');
  assert.equal(pendingModal.title, '订单已创建，支付未完成', '① 弹窗标题必须点明「订单已创建」');
  assert.equal(pendingModal.confirmText, '去支付', '① 主按钮应为「去支付」');
  assert.equal(pendingModal.cancelText, '稍后再说', '① 次按钮应为「稍后再说」');
  assert.ok(
    String(pendingModal.content || '').includes('30 分钟'),
    '① 文案应说明订单会超时关闭，让用户知道不处理的后果'
  );
  assert.equal(
    checkout.data.submitting, false,
    '④ ★ 弹窗出现时 submitting 就必须复位 —— 弹窗是异步的，用户可能直接离开，不能把按钮锁住'
  );

  // ==================== ② ★ 点「去支付」→ 委托 openLink 并带 focusId ====================
  harness.clearOpenLinkCalls();
  pendingModal.success({ confirm: true });
  const openCalls = harness.getOpenLinkCalls();
  assert.equal(openCalls.length, 1, '② ★ 点「去支付」应恰好委托一次 openLink（不自己写一套跳转）');
  assert.equal(
    openCalls[0].url, '/pages/orders/orders?focusId=o-777',
    '② ★ 必须带上该订单的 focusId，订单页才能定位到这笔待支付订单'
  );

  // ==================== ④ 点「稍后再说」→ 不跳转 ====================
  harness.clearOpenLinkCalls();
  pendingModal.success({ confirm: false, cancel: true });
  assert.equal(harness.getOpenLinkCalls().length, 0, '④ 点「稍后再说」不得跳转');
  assert.equal(checkout.data.submitting, false, '④ 取消后提交态仍须为已复位');

  // ==================== ③ ★★ 核心区分：POST /api/orders 失败 → 订单没创建，不得弹该弹窗 ====================
  let paymentCalls = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/orders') return Promise.reject(new Error('库存不足'));
    return Promise.resolve({ data: {} });
  });
  harness.setPaymentHandler(() => { paymentCalls += 1; return Promise.resolve({}); });
  harness.clearModals();
  harness.clearToasts();

  checkout.submit();
  await settle();

  assert.equal(paymentCalls, 0, '③ 下单都没成功，绝不该走到支付');
  assert.equal(
    harness.getModals().length, 0,
    '③ ★★ 订单根本没创建时不得弹「订单已创建，支付未完成」—— 那是在向用户断言一个不存在的订单'
  );
  const failureToast = harness.getToasts().at(-1);
  assert.ok(failureToast, '③ 下单失败仍必须有提示（不能因为改了弹窗就变成静默失败）');
  assert.equal(failureToast.title, '库存不足', '③ 下单失败应 toast 接口错误文案，与改造前一致');
  assert.equal(checkout.data.submitting, false, '③ 下单失败后提交态必须复位');

  // ==================== ⑤ 回归：支付成功路径的弹窗与跳转不变 ====================
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/orders') {
      return Promise.resolve({ data: { id: 'o-888' }, paymentOrder: { id: 'pay-2' } });
    }
    return Promise.resolve({ data: {} });
  });
  harness.setPaymentHandler(() => Promise.resolve({ data: { order: { orderNo: 'CG20260901001' } } }));
  harness.clearModals();
  harness.clearSwitchTabCalls();

  checkout.submit();
  await settle();

  const successModal = harness.getModals().at(-1);
  assert.ok(successModal, '⑤ 支付成功应弹确认弹窗');
  assert.equal(successModal.title, '支付成功', '⑤ 成功弹窗标题不得回归');
  assert.equal(successModal.confirmText, '查看订单', '⑤ 成功弹窗按钮不得回归');
  assert.equal(successModal.showCancel, false, '⑤ 成功弹窗不应有取消按钮');
  assert.ok(String(successModal.content).includes('CG20260901001'), '⑤ 成功弹窗应含订单号');
  assert.ok(String(successModal.content).includes('校园牌照辅助'), '⑤ 售卖单文案不得回归');
  assert.equal(
    harness.getModals().length, 1,
    '⑤ 成功路径只应有一个弹窗（不得混入「订单已创建，支付未完成」）'
  );

  successModal.success();
  assert.deepEqual(
    harness.getSwitchTabCalls(), ['/pages/orders/orders'],
    '⑤ 成功路径仍走 switchTab 跳订单页（订单页是 tabBar 页）'
  );
});

test('M6-P0-01：市集发布不填联系方式时本地拦截（不发请求）并聚焦输入框', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 记录页面真正发出的请求。**这是「本地拦截」与「发出去被服务端拒」唯一的分界证据** ——
  // 只断言 toast 文案的话，两种实现都会通过。
  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'market_new_1' } });
  });

  const publish = harness.loadPage(path.join('pages', 'market', 'publish.js'));
  // 其余字段全部合法：一旦请求计数为 0，原因只可能是联系方式被本地拦下。
  publish.setData({
    title: '宿舍台灯（可调亮度）',
    description: '用了半年，功能完好，荟园自提',
    priceInput: '29',
    contact: ''
  });

  // ==================== ⑦ ★ 本地拦截：请求计数必须为 0 ====================
  publish.submit();
  await settle();
  assert.equal(
    requests.length, 0,
    '⑦ ★★ 未填联系方式必须在本地拦下 —— 请求计数应为 0。'
    + '若变成 1，说明拦截被挪到了服务端：用户白等一趟网络往返，且错误只能以 toast 呈现'
  );

  // ==================== ⑧ 聚焦输入框 + 不锁按钮 + 文案正确 ====================
  assert.equal(publish.data.contactFocus, true, '⑧ 被拦下时必须把光标送到联系方式输入框');
  assert.equal(
    publish.data.submitting, false,
    '被拦下时不得把按钮锁在「正在发布…」—— 用户还没发出任何请求'
  );
  assert.equal(
    harness.getToasts().at(-1)?.title, '请填写联系方式（微信号或手机号）',
    '提示必须告诉用户填什么，而不是笼统的「提交失败」'
  );

  // 边界：4 字符仍在拦截侧（下界是 5）。
  publish.setData({ contact: '1234' });
  publish.submit();
  await settle();
  assert.equal(requests.length, 0, '4 字符低于下界 5，仍应被本地拦下');
  assert.equal(publish.data.contactFocus, true, '4 字符被拦下时同样应聚焦');

  // ==================== ⑨ ★ 正向控制：填了合法值必须真的发请求 ====================
  // 没有这条，⑦ 的「计数为 0」也可能只是因为「任何输入都不发请求」。
  publish.setData({ contact: '12345' });
  publish.submit();
  await settle();
  assert.equal(
    requests.length, 1,
    '⑨ ★ 填了合法联系方式必须真的发出请求 —— 否则⑦的「计数为 0」不成立'
  );
  assert.equal(requests[0].path, '/api/market/items', '⑨ 应打到市集发布端点');
  assert.equal(requests[0].data.contact, '12345', '⑨ 联系方式应原样带在请求体里');
  assert.equal(requests[0].data.priceInCents, 2900, '⑨ 其余字段不得因本次改动而变形');

  // 成功路径有 `setTimeout(..., 600)` 的跳转，等它跑完再结束用例，
  // 否则定时器会在 harness.restore() 之后触发（那时 global.wx 已被还原）。
  await new Promise((resolve) => { setTimeout(resolve, 700); });
});

test('M3-P1-03：改约被拒（ORDER_NOT_MODIFIABLE）时提示并退回订单页', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const editOrder = harness.loadPage(path.join('pages', 'edit-order', 'edit-order.js'));
  editOrder.setData({
    orderId: 'o-1', orderNo: 'CG1',
    name: '李同学', phone: '15527111396', date: '2026-09-01', address: '荟园学生社区 7 栋',
    timeSlot: '今天 12:00-14:00', submitting: false
  });

  // ==================== ⑨ 订单已终态 / 钱已退过 → 固定文案 + 退回上一页 ====================
  harness.setApiHandler(() => Promise.reject(Object.assign(
    new Error('当前订单状态（已完成）不支持改约'),
    { code: 'ORDER_NOT_MODIFIABLE', statusCode: 409 }
  )));
  editOrder.save();
  await settle();
  assert.equal(
    harness.getToasts().at(-1)?.title, '当前订单状态不支持改约',
    '⑨ 改约被拒必须给一句用户能懂的话（而不是把服务端那句带状态标签的长文案原样弹出来）'
  );
  assert.equal(
    editOrder.data.submitting, false,
    '⑨ 被拒后必须解锁按钮 —— 否则 navigateBack 万一失败，用户会卡在一个按钮永远灰着的页面上'
  );
  // navigateBack 走的是 `setTimeout(..., 500)`，等它跑完再断言。
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  assert.equal(
    harness.getNavigateBackCalls().length, 1,
    '⑨ ★ 必须退回订单页 —— 留在本页用户只会「改一次被拒一次」，无论怎么改都是 409'
  );

  // ==================== ⑨ 正向控制：只有该错误码才退回 ====================
  // 没有这一条，「navigateBack 被调用过」也可能来自一个「catch 里无条件 navigateBack」的实现 ——
  // 那会把网络抖动、参数错误也变成「把你踢回订单页」，用户看不懂为什么被退出来。
  harness.clearToasts();
  harness.clearNavigateBackCalls();
  harness.setApiHandler(() => Promise.reject(Object.assign(
    new Error('服务器开小差了'), { code: 'INTERNAL_ERROR', statusCode: 500 }
  )));
  editOrder.save();
  await settle();
  assert.equal(harness.getToasts().at(-1)?.title, '服务器开小差了', '⑨ 其他错误应原样展示服务端文案，不得被替换');
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  assert.equal(
    harness.getNavigateBackCalls().length, 0,
    '⑨ ★ 正向控制：只有 ORDER_NOT_MODIFIABLE 才退回 —— 否则「一律 navigateBack」也会让上一条通过'
  );
});

test('M2-P1-01 / M2-P1-03：收藏与足迹按品类分流，电话卡不再落进电瓶车详情页', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 同一份数据里**同时**放两种品类：只有两种都在，才能证明分流是按品类做的，
  // 而不是「一律跳 card」或「一律跳 detail」。
  const PHONE_PLAN_ITEM = {
    id: 'prod_card_service_001', category: 'PHONE_PLAN', name: '校园电话卡',
    description: '月租套餐', imageUrl: '', icon: '卡', color: '#eaf0ff',
    effectivePriceInCents: 2900, salesCount: 3, availableStock: 5,
    ratingSummary: { average: 4.5, count: 2 }
  };
  const E_BIKE_ITEM = {
    id: 'prod_ebike_001', category: 'E_BIKE_NEW', name: '狮山通勤车',
    description: '续航 60km', imageUrl: '', icon: '车', color: '#eaf0ff',
    effectivePriceInCents: 199900, salesCount: 8, availableStock: 4,
    ratingSummary: { average: 4.8, count: 5 }
  };
  harness.setApiHandler((requestPath) => {
    if (requestPath === '/api/my/favorites') return Promise.resolve({ data: [PHONE_PLAN_ITEM, E_BIKE_ITEM] });
    if (requestPath === '/api/my/footprints') return Promise.resolve({ data: [PHONE_PLAN_ITEM, E_BIKE_ITEM] });
    return Promise.resolve({ data: [] });
  });

  // ==================== ⑨ 收藏页：电话卡 → 套餐页 ====================
  const favorites = harness.loadPage(path.join('pages', 'favorites', 'favorites.js'));
  favorites.loadFavorites();
  await settle();
  const favoriteItems = favorites.data.favoritesBlock.data;
  assert.equal(favoriteItems.length, 2, '⑨ 前置：两条收藏都应加载出来（否则下面的点击断言会空转）');
  // 装饰层必须保留 category —— 丢了它，分流只能靠猜。
  assert.equal(
    favoriteItems.find((item) => item.id === 'prod_card_service_001')?.category, 'PHONE_PLAN',
    '⑨ 前置：装饰后的收藏项必须保留 category'
  );

  harness.clearOpenLinkCalls();
  favorites.goDetail({ currentTarget: { dataset: { id: 'prod_card_service_001' } } });
  assert.equal(
    harness.getOpenLinkCalls().at(-1)?.url, '/pages/card/card?planId=prod_card_service_001',
    '⑨ ★ 收藏里的电话卡必须进套餐页，而不是电瓶车详情页'
  );

  // ==================== ⑪ 正向控制：电动车仍进商品详情页 ====================
  harness.clearOpenLinkCalls();
  favorites.goDetail({ currentTarget: { dataset: { id: 'prod_ebike_001' } } });
  assert.equal(
    harness.getOpenLinkCalls().at(-1)?.url, '/pages/detail/detail?id=prod_ebike_001',
    '⑪ ★ 正向控制：电动车仍进商品详情页 —— 否则「一律跳 card」也会让 ⑨ 通过'
  );

  // ==================== ⑩ 足迹页：同一套分流 ====================
  const footprints = harness.loadPage(path.join('pages', 'footprints', 'footprints.js'));
  footprints.load();
  await settle();
  const footprintItems = footprints.data.footprintsBlock.data;
  assert.equal(footprintItems.length, 2, '⑩ 前置：两条足迹都应加载出来');
  assert.equal(
    footprintItems.find((item) => item.id === 'prod_card_service_001')?.category, 'PHONE_PLAN',
    '⑩ 前置：足迹项必须保留原始 category（只有 categoryLabel 不足以判断该进哪个页）'
  );

  harness.clearOpenLinkCalls();
  footprints.goDetail({ currentTarget: { dataset: { id: 'prod_card_service_001' } } });
  assert.equal(
    harness.getOpenLinkCalls().at(-1)?.url, '/pages/card/card?planId=prod_card_service_001',
    '⑩ ★ 足迹里的电话卡必须进套餐页'
  );

  harness.clearOpenLinkCalls();
  footprints.goDetail({ currentTarget: { dataset: { id: 'prod_ebike_001' } } });
  assert.equal(
    harness.getOpenLinkCalls().at(-1)?.url, '/pages/detail/detail?id=prod_ebike_001',
    '⑩ ★ 正向控制：足迹里的电动车仍进商品详情页'
  );

  // 跳转必须委托给 openLink：走裸 wx.navigateTo 的话这里一条记录都不会有
  //（harness 的 wx 桩对未知方法返回空函数，不会报错、也不会被记录）。
  assert.ok(harness.getOpenLinkCalls().length >= 1, '分流后的跳转必须委托给 openLink');
});

test('M2-P1-03：套餐售罄时提交按钮不可点，且不白跑一趟网络', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  let orderPostCount = 0;
  harness.setApiHandler((requestPath) => {
    if (requestPath.startsWith('/api/products')) {
      return Promise.resolve({ data: [
        { id: 'p-soldout', category: 'PHONE_PLAN', name: '售罄套餐', description: 'x', active: true, purchasable: false, effectivePriceInCents: 2900, stock: 4 },
        { id: 'p-ok', category: 'PHONE_PLAN', name: '在售套餐', description: 'y', active: true, purchasable: true, effectivePriceInCents: 3900, stock: 9 }
      ] });
    }
    if (requestPath === '/api/phone-card-orders') {
      orderPostCount += 1;
      return Promise.resolve({ data: { id: 'pco-1' }, paymentOrder: { id: 'po-1' } });
    }
    return Promise.resolve({ data: [] });
  });
  harness.storage.shishanUserProfile = { name: '测试同学', phone: '15527111396' };

  const card = harness.loadPage(path.join('pages', 'card', 'card.js'));
  card.onLoad({});
  await settle();

  assert.equal(card.data.plansBlock.data.length, 2, '⑫ 前置：两个套餐都应加载出来');
  assert.equal(card.data.selectedPlan, 0, '⑫ 前置：默认选中第一个（售罄的那个）');
  assert.equal(card.data.planPurchasable, false, '⑫ ★ 售罄套餐下提交按钮必须不可点');
  assert.equal(card.data.plansBlock.data[0].purchasable, false, '⑫ 售罄套餐的 purchasable 应为 false');
  assert.equal(card.data.plansBlock.data[0].badge, '已售罄', '⑫ 售罄套餐的角标必须写「已售罄」');

  card.submit();
  await settle();
  assert.equal(orderPostCount, 0, '⑫ ★ 售罄时不得发下单请求（白跑一趟网络，用户只看到「点了没反应」）');
  assert.equal(harness.getToasts().at(-1)?.title, '该套餐已售罄，暂不可办理', '⑫ 必须给出用户看得懂的提示');

  // 边界另一侧：切到在售套餐后恢复可点，且真的能提交。
  card.choosePlan({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(card.data.planPurchasable, true, '⑫ ★ 切到在售套餐后提交按钮必须恢复可点');
  assert.equal(card.data.plansBlock.data[1].badge, '可办理', '⑫ 在售套餐的角标应为「可办理」');
  card.submit();
  await settle();
  assert.equal(orderPostCount, 1, '⑫ ★ 正向控制：在售套餐必须真的能提交 —— 否则「一律拦死」也会让上面几条通过');
});

test('M2-P1-03：已下架商品给出常驻的「该商品已下架」，而不是含糊的「加载失败」', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 服务端对已下架商品返回 404 + PRODUCT_NOT_FOUND（server 侧断言 ③ 已锁住这个事实）。
  harness.setApiHandler((requestPath) => {
    if (requestPath.startsWith('/api/products/')) {
      return Promise.reject(Object.assign(
        new Error('Product not found'), { code: 'PRODUCT_NOT_FOUND', statusCode: 404 }
      ));
    }
    return Promise.resolve({ data: [] });
  });

  // 注意：`services/store` 用的是**真模块**（harness 没有桩它），
  // 所以 `getScooter('prod_card_service_001')` 真的会去 data/mock.js 里找 —— 找不到，
  // 于是走「无缓存」分支。这正是「真被下架的商品」的路径。
  const detail = harness.loadPage(path.join('pages', 'detail', 'detail.js'));
  detail.onLoad({ id: 'prod_card_service_001' });
  await settle();

  assert.equal(detail.data.loading, false, '⑬ 前置：加载必须结束，否则页面停在「正在加载」');
  assert.equal(detail.data.scooter, null, '⑬ 前置：商品取不到时 scooter 必须为空');
  assert.equal(detail.data.goneText, '该商品已下架', '⑬ ★ 必须明确说「已下架」，而不是含糊的「加载失败」');
  assert.equal(
    harness.getToasts().length, 0,
    '⑬ ★ 不得弹「商品加载失败」这类暗示「过一会儿再试」的 toast —— 下架重试也没用，且 toast 一两秒就消失'
  );

  // 正向控制：网络故障（不是 404）必须保留原有措辞与 toast，不能被这条改动误伤。
  harness.clearToasts();
  harness.setApiHandler((requestPath) => {
    if (requestPath.startsWith('/api/products/')) {
      return Promise.reject(Object.assign(new Error('网络异常'), { statusCode: 500 }));
    }
    return Promise.resolve({ data: [] });
  });
  const detailOnNetworkFailure = harness.loadPage(path.join('pages', 'detail', 'detail.js'));
  detailOnNetworkFailure.onLoad({ id: 'prod_ebike_001' });
  await settle();
  assert.equal(
    detailOnNetworkFailure.data.goneText, '车型不存在或已下架',
    '⑬ ★ 正向控制：网络故障不得被说成「已下架」'
  );
  assert.equal(
    harness.getToasts().at(-1)?.title, '商品加载失败',
    '⑬ ★ 正向控制：网络故障仍保留原有提示'
  );
});

test('M7-P1-01：我的帖子页失败走三态，且失败绝不被说成「你还没有发过帖子」', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // ==================== 第一段：首次加载就失败 ====================
  let shouldFail = true;
  const requestedPaths = [];
  harness.setApiHandler((requestPath) => {
    requestedPaths.push(requestPath);
    if (shouldFail) return Promise.reject(new Error('论坛接口 500'));
    return Promise.resolve({
      data: [
        { id: 'p_live', title: '在售帖', content: '正文 A', boardText: '校园生活', likes: 3, commentCount: 1, status: 'PUBLISHED', createdAt: '2026-09-01T10:00:00.000Z' },
        { id: 'p_hidden', title: '被隐藏的帖', content: '正文 B', boardText: '学习交流', likes: 0, commentCount: 0, status: 'HIDDEN', createdAt: '2026-09-02T11:30:00.000Z' }
      ]
    });
  });

  const mine = harness.loadPage(path.join('pages', 'forum', 'mine.js'));
  mine.onShow();
  await settle();

  assert.deepEqual(
    requestedPaths, ['/api/forum/posts?mine=1'],
    '⑧ ★ 「我的帖子」必须打 ?mine=1 —— 这是隐藏帖唯一的恢复入口，走主列表会一条都看不到'
  );
  assert.equal(mine.data.postsBlock.loading, false, '⑧ 失败后必须结束加载态，否则页面永远停在「正在加载」');
  assert.equal(mine.data.postsBlock.error, '论坛接口 500', '⑧ ★ 失败必须成为一种可见状态（常驻占位 + 重试），而不是一闪而过的 toast');
  // ★ 这一条是本用例的核心：`data` 必须仍是**数组**。
  // 若失败时把它清成 `undefined`，模板里的 `!postsBlock.data.length` 会取到
  // `undefined` —— 在 `wx:if` 里是假值 —— 于是「接口挂了」被渲染成「你还没有发过帖子」，
  // 用户会以为自己发的帖子被删了。这是一个**假事实**，比空白更糟。
  assert.ok(
    Array.isArray(mine.data.postsBlock.data), '⑧ ★★ 失败时 data 必须仍是数组（否则「失败」会被渲染成「空」）'
  );
  assert.equal(mine.data.postsBlock.data.length, 0, '⑧ 首次加载失败时本就没有旧数据可留');

  // ==================== 第二段：重试成功 ====================
  shouldFail = false;
  await mine.retryPosts();
  await settle();

  assert.equal(mine.data.postsBlock.error, '', '⑧ ★ 重试成功后必须清掉错误态');
  assert.equal(mine.data.postsBlock.loading, false, '⑧ 重试成功后必须结束加载态');
  assert.equal(mine.data.postsBlock.data.length, 2, '⑧ 重试成功后应渲染两条帖子');
  assert.equal(mine.data.postsBlock.data[0].statusText, '已发布', '⑧ 未隐藏的帖子应标为「已发布」');
  assert.equal(mine.data.postsBlock.data[0].hidden, false, '⑧ 未隐藏的帖子 hidden 为 false');
  // ★ 隐藏态必须看得见：这一页是「恢复」的唯一入口，看不出哪条被隐藏，
  // 用户就不知道要恢复什么，功能等于没有。
  assert.equal(mine.data.postsBlock.data[1].hidden, true, '⑧ ★★ 隐藏的帖子必须被标出来');
  assert.equal(mine.data.postsBlock.data[1].statusText, '已隐藏', '⑧ ★★ 隐藏帖的状态文案必须是「已隐藏」');
  assert.equal(mine.data.postsBlock.data[1].boardText, '学习交流', '⑧ 板块文案应原样透传');

  // ==================== 第三段：已有数据后再失败，旧列表不得被清空 ====================
  shouldFail = true;
  await mine.loadMine();
  await settle();

  assert.equal(mine.data.postsBlock.error, '论坛接口 500', '⑧ 再次失败应重新进入错误态');
  assert.equal(
    mine.data.postsBlock.data.length, 2,
    '⑧ ★★ 失败绝不清空旧列表 —— 旧数据比「假装没有数据」有用得多'
  );

  // ==================== 第四段：跳转 ====================
  harness.clearOpenLinkCalls();
  mine.goPost({ currentTarget: { dataset: { id: 'post a&b' } } });
  assert.equal(harness.getOpenLinkCalls().length, 1, '⑧ 点击帖子应跳转');
  assert.equal(
    harness.getOpenLinkCalls()[0].url, '/pages/forum/post?id=post%20a%26b',
    '⑧ ★ id 必须转义后再拼进 query（否则含 & 的 id 会被截成另一个参数）'
  );

  harness.clearOpenLinkCalls();
  mine.goPost({ currentTarget: { dataset: {} } });
  assert.equal(harness.getOpenLinkCalls().length, 0, '⑧ 缺 id 时不得跳转到一个空详情的死页');

  mine.goPublish();
  assert.equal(harness.getOpenLinkCalls().length, 1, '⑧ 「去发帖」应跳转');
  assert.equal(harness.getOpenLinkCalls()[0].url, '/pages/forum/publish', '⑧ 「去发帖」应进发帖页');
});

test('M7-P1-01：帖子详情页的隐藏/恢复只发给作者，且恢复用 PUBLISHED 而不是 ACTIVE', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const makePost = (isOwner, status) => ({
    id: 'post_1',
    title: '标题',
    content: '正文',
    boardText: '校园生活',
    likes: 0,
    liked: false,
    comments: [],
    commentCount: 0,
    status,
    isOwner,
    createdAt: '2026-09-01T10:00:00.000Z'
  });

  let payload = makePost(true, 'PUBLISHED');
  const calls = [];
  harness.setApiHandler((requestPath, options) => {
    calls.push({ path: requestPath, options });
    return Promise.resolve({ data: payload });
  });

  const page = harness.loadPage(path.join('pages', 'forum', 'post.js'));
  page.onLoad({ id: 'post_1' });
  page.onShow();
  await settle();

  // ==================== 方向一：作者本人 ====================
  assert.equal(page.data.loading, false, '⑨ 前置：详情必须加载结束');
  assert.equal(
    page.data.post.isOwner, true,
    '⑨ ★ 作者本人：isOwner 必须原样传进 data —— 模板的 wx:if="{{post.isOwner}}" 求值为真，按钮才渲染'
  );
  assert.equal(page.data.post.status, 'PUBLISHED', '⑨ 前置：当前是已发布状态');

  // ==================== 方向二：非作者 ====================
  payload = makePost(false, 'PUBLISHED');
  page.loadPost();
  await settle();
  assert.equal(
    page.data.post.isOwner, false,
    '⑨ ★★ 非作者：isOwner 为 false —— 模板的 wx:if 求值为假，按钮不渲染'
  );
  assert.equal(page.data.post.title, '标题', '⑨ 前置：非作者同样能正常看到帖子内容');

  // ==================== 隐藏：必须发 HIDDEN ====================
  payload = makePost(true, 'PUBLISHED');
  page.loadPost();
  await settle();
  calls.length = 0;
  page.toggleVisibility();
  // ★ 同步断言：`togglingStatus` 必须在**发请求之前**就置为 true，
  // 否则用户连点两下会发出两次状态请求（后一次覆盖前一次）。
  assert.equal(page.data.togglingStatus, true, '⑨ ★ 进行中必须立刻置 togglingStatus（按钮据此禁用）');
  page.toggleVisibility(); // 重复点击：应被上面的守卫挡掉
  await settle();
  await settle();

  const hideCalls = calls.filter((call) => call.path === '/api/forum/posts/post_1/status');
  assert.equal(hideCalls.length, 1, '⑨ ★ 重复点击不得发出第二次状态请求');
  assert.equal(hideCalls[0].options.method, 'POST', '⑨ 状态变更必须用 POST');
  assert.equal(hideCalls[0].options.data.status, 'HIDDEN', '⑨ ★ 隐藏必须发 HIDDEN');
  assert.equal(page.data.togglingStatus, false, '⑨ 完成后必须复位 togglingStatus');

  // ==================== 恢复：必须是 PUBLISHED ====================
  payload = makePost(true, 'HIDDEN');
  page.loadPost();
  await settle();
  assert.equal(page.data.post.status, 'HIDDEN', '⑨ 前置：作者能看到自己隐藏帖的真实状态');

  calls.length = 0;
  page.toggleVisibility();
  await settle();
  await settle();

  const restoreCalls = calls.filter((call) => call.path === '/api/forum/posts/post_1/status');
  assert.equal(restoreCalls.length, 1, '⑨ 恢复也应发一次状态请求');
  assert.equal(
    restoreCalls[0].options.data.status, 'PUBLISHED',
    '⑨ ★★ 恢复必须发 PUBLISHED（不是 ACTIVE）—— 列表/详情/点赞/评论四处读取都判 '
    + '=== PUBLISHED，发 ACTIVE 会让帖子对所有人永久消失，连作者都恢复不回来'
  );
  assert.notEqual(
    restoreCalls[0].options.data.status, 'ACTIVE',
    '⑨ ★★ 正向控制：确认上一条断言不是恒真 —— 它确实区分 PUBLISHED 与 ACTIVE'
  );
});

test('M6-P1-01：我发布的闲置页三态 + 状态可见 + 删除（含 409 的明确提示）', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const item = (id, status, statusText) => ({
    id,
    title: `闲置 ${id}`,
    description: '描述',
    categoryText: '其他',
    conditionText: '七成新',
    priceText: '¥10.00',
    price: 10,
    status,
    statusText,
    images: [],
    createdAt: '2026-09-01T10:00:00.000Z'
  });

  let shouldFail = true;
  const calls = [];
  harness.setApiHandler((requestPath, options) => {
    calls.push({ path: requestPath, options });
    if (shouldFail) return Promise.reject(new Error('市集接口 500'));
    return Promise.resolve({
      data: [
        item('m_active', 'ACTIVE', '在售'),
        item('m_sold', 'SOLD', '已出'),
        item('m_deleted', 'DELETED', '已删除')
      ]
    });
  });

  const mine = harness.loadPage(path.join('pages', 'market', 'mine.js'));
  mine.onShow();
  await settle();

  // ==================== ⑦ 失败走三态 ====================
  assert.deepEqual(
    calls.map((call) => call.path), ['/api/my/market-items'],
    '⑦ ★ 必须走既有的 `/api/my/market-items` —— 它本来就不按状态过滤，'
    + '「我发布的」要能看到已售 / 已删除，另造一个 ?mine=1 只会多一份要维护的口径'
  );
  assert.equal(mine.data.itemsBlock.loading, false, '⑦ 失败后必须结束加载态');
  assert.equal(mine.data.itemsBlock.error, '市集接口 500', '⑦ ★ 失败必须成为可见状态（常驻占位 + 重试）');
  // ★ 失败时 `data` 必须仍是数组：清成 `undefined` 后模板的
  // `!itemsBlock.data.length` 取到 undefined（在 wx:if 里是假值），
  // 「接口挂了」会被渲染成「你还没有发布过闲置」—— 用户以为自己发的东西没了。
  assert.ok(
    Array.isArray(mine.data.itemsBlock.data),
    '⑦ ★★ 失败时 data 必须仍是数组（否则失败会被渲染成「你还没有发布过闲置」）'
  );

  // ==================== ⑧ 重试成功 → 再失败，旧列表不得清空 ====================
  shouldFail = false;
  await mine.retryItems();
  await settle();
  assert.equal(mine.data.itemsBlock.error, '', '⑧ 重试成功后应清掉错误');
  assert.equal(mine.data.itemsBlock.data.length, 3, '⑧ 重试成功后应渲染 3 条');

  shouldFail = true;
  await mine.loadMine();
  await settle();
  assert.equal(mine.data.itemsBlock.error, '市集接口 500', '⑧ 再次失败应重新进入错误态');
  assert.equal(
    mine.data.itemsBlock.data.length, 3,
    '⑧ ★★ 失败绝不清空旧列表 —— 旧数据比「假装没有数据」有用得多'
  );

  // ==================== ⑨ 每条能看出状态 ====================
  const [active, sold, deleted] = mine.data.itemsBlock.data;
  assert.equal(active.statusText, '在售', '⑨ 在售的文案');
  assert.equal(sold.statusText, '已出', '⑨ 已出的文案');
  // ★ 这一条针对一个真实缺陷：`publicMarketItem` 的 statusText 原来是嵌套三元、
  // 没有 DELETED 分支，未知状态会掉进兜底的「在售」。
  assert.equal(
    deleted.statusText, '已删除',
    '⑨ ★★ 已删除必须显示「已删除」，不得掉进兜底的「在售」（那是在断言一个假事实）'
  );
  assert.equal(deleted.statusClass, 'status-deleted', '⑨ 已删除应有独立角标样式，扫一眼能分辨');
  assert.equal(active.statusClass, 'status-active', '⑨ 在售的角标样式');

  assert.equal(active.deletable, true, '⑨ 在售的可以删除');
  assert.equal(sold.deletable, false, '⑨ ★ 已出的不给删除按钮（点了必然被服务端 409 拒绝）');
  assert.equal(deleted.deletable, false, '⑨ 已删除的不给删除按钮');
  assert.equal(
    sold.lockedText, '已产生交易记录，无法删除',
    '⑨ ★ 不给按钮时必须说明原因，否则用户以为页面坏了'
  );
  assert.equal(active.lockedText, '', '⑨ 有删除按钮时不需要说明文案');

  assert.equal(active.viewable, true, '⑨ 在售的可查看详情');
  assert.equal(deleted.viewable, false, '⑨ ★ 已删除的不可查看详情（服务端对 DELETED 返回 404）');

  // ==================== ⑨ 跳转 ====================
  harness.clearOpenLinkCalls();
  mine.goItem({ currentTarget: { dataset: { id: 'm_active' } } });
  assert.equal(harness.getOpenLinkCalls().length, 1, '⑨ 在售的应能进详情');
  assert.equal(harness.getOpenLinkCalls()[0].url, '/pages/market/item?id=m_active', '⑨ 跳转目标应为市集详情页');

  harness.clearOpenLinkCalls();
  harness.clearToasts();
  mine.goItem({ currentTarget: { dataset: { id: 'm_deleted' } } });
  assert.equal(
    harness.getOpenLinkCalls().length, 0,
    '⑨ ★★ 已删除的不得跳转 —— 服务端是 404，跳过去只会看到「商品不存在或已下架」'
  );
  assert.equal(
    harness.getToasts().at(-1)?.title, '已删除的闲置无法查看详情',
    '⑨ ★ 必须说明为什么不跳，而不是点了没反应'
  );

  harness.clearOpenLinkCalls();
  mine.goPublish();
  assert.equal(harness.getOpenLinkCalls()[0]?.url, '/pages/market/publish', '⑨ 「去发布」应进发布页');

  // ==================== ⑩ 不可删除的条目不弹确认框 ====================
  // 注意前置条件：这一段必须在**三条目都在列表里**的时候跑。
  // 第一次写时我把它放在了 409 那一段之后 —— 那时 handler 只返回一条
  // `m_active`，`m_sold` 在列表里根本不存在，页面自然找不到它、也就没拦住，
  // 断言报 `1 !== 0`。**这是我的用例前置写错了，不是页面的问题。**
  harness.clearModals();
  mine.deleteItem({ currentTarget: { dataset: { id: 'm_sold' } } });
  assert.equal(harness.getModals().length, 0, '⑩ ★ 已售出的条目不弹确认框（它根本没有删除按钮）');
  assert.equal(mine.data.itemsBlock.data.find((entry) => entry.id === 'm_sold').deletable, false, '⑩ 前置：已售出的 deletable 为 false');

  // ==================== ⑩ 409：明确提示，而不是通用「操作失败」 ====================
  shouldFail = false;
  await mine.retryItems();
  await settle();

  calls.length = 0;
  harness.clearToasts();
  harness.clearModals();
  harness.setApiHandler((requestPath, options) => {
    calls.push({ path: requestPath, options });
    if (options && options.method === 'POST') {
      return Promise.reject(Object.assign(
        new Error('该闲置已产生交易记录，无法删除；如需下架请联系客服'),
        { code: 'MARKET_ITEM_HAS_TRADE', statusCode: 409 }
      ));
    }
    return Promise.resolve({ data: [item('m_active', 'ACTIVE', '在售')] });
  });

  // 场景是真实竞态：页面加载时这条闲置还在售，点「删除」的这一刻买家把它预留了。
  mine.deleteItem({ currentTarget: { dataset: { id: 'm_active' } } });
  assert.equal(harness.getModals().length, 1, '⑩ ★ 删除前必须先弹确认框（软删除不可逆，不能误触即删）');
  assert.equal(harness.getModals()[0].title, '删除闲置', '⑩ 确认框标题');
  assert.equal(calls.length, 0, '⑩ ★ 用户还没确认，不得发任何请求');

  harness.getModals()[0].success({ confirm: true });
  await settle();
  await settle();

  const deleteCall = calls.find((call) => call.path === '/api/market/items/m_active');
  assert.ok(deleteCall, '⑩ 删除应打到 POST /api/market/items/:id');
  assert.equal(deleteCall.options.method, 'POST', '⑩ 状态变更必须用 POST');
  assert.equal(deleteCall.options.data.status, 'DELETED', '⑩ ★ 删除必须发 DELETED');
  const refusalToast = harness.getToasts().at(-1)?.title || '';
  assert.equal(
    refusalToast.includes('交易记录'), true,
    `⑩ ★★ 409 必须给出明确原因（含「交易记录」），而不是通用「操作失败」或「删除失败，请重试」；实得：${refusalToast}`
  );
  assert.notEqual(refusalToast, '删除失败，请重试', '⑩ ★ 不得退化成通用失败提示');

  // ==================== ⑩ 点「取消」不发请求 ====================
  calls.length = 0;
  harness.clearModals();
  mine.deleteItem({ currentTarget: { dataset: { id: 'm_active' } } });
  harness.getModals()[0].success({ confirm: false });
  await settle();
  assert.equal(calls.length, 0, '⑩ ★ 点「取消」不得发请求');

  // ==================== ⑩ 正向控制：删除成功路径必须真的走得通 ====================
  let deletedBody = null;
  calls.length = 0;
  harness.clearToasts();
  harness.clearModals();
  harness.setApiHandler((requestPath, options) => {
    calls.push({ path: requestPath, options });
    if (options && options.method === 'POST') {
      deletedBody = options.data;
      return Promise.resolve({ data: {} });
    }
    return Promise.resolve({ data: [] });
  });
  mine.deleteItem({ currentTarget: { dataset: { id: 'm_active' } } });
  harness.getModals()[0].success({ confirm: true });
  await settle();
  await settle();
  assert.equal(deletedBody && deletedBody.status, 'DELETED', '⑩ 正向控制：成功路径也必须发出 DELETED');
  assert.equal(
    harness.getToasts().at(-1)?.title, '已删除',
    '⑩ ★ 正向控制：成功必须给出成功提示 —— 否则「一律报错」也能让上面几条通过'
  );
});

/**
 * 把 wxml 里所有 `{{...}}` 求值成文本，拼出「这一页真正会渲染出来的内容」。
 *
 * 只用于「页面上会不会出现某个字符串」这类断言 —— 例如「页面上不得出现完整
 * 18 位身份证号」。求值的是 wxml 里的**原始表达式文本**，不是我重写的一份判断。
 *
 * `wx:for` 作用域内的表达式（`item.xxx` / `index`）在循环外求值会抛错，按空串处理；
 * 本用例关心的是认证区，那里没有循环变量。
 *
 * @param {string} wxml 模板源码。
 * @param {object} data 页面 data。
 * @returns {string} 渲染出来的文本（含未命中分支的标签，仅用于子串断言）。
 */
function renderExpressions(wxml, data) {
  return wxml.replace(/\{\{([\s\S]*?)\}\}/g, (match, expr) => {
    try {
      const value = new Function('data', `with (data) { return (${expr}); }`)(data);
      return value === undefined || value === null ? '' : String(value);
    } catch (error) {
      return '';
    }
  });
}

/**
 * 去掉 JS 源码里的注释，只留下**可执行代码**（用于源码级断言）。
 *
 * 为什么需要：`profile.js` 的文档注释里**如实记录**了改造前那行
 * `this.setData({ verified: true })` —— 直接对整份源码做子串断言会把注释也算进去，
 * 于是「记录历史」和「禁止重犯」这两件事互相打架。断言要管的是可执行代码。
 *
 * 局限：只处理整行注释与块注释，不处理行尾注释里出现的目标串（那种情形下
 * 目标串本来也不是可执行代码，属可接受的假阴性）。
 *
 * @param {string} source JS 源码。
 * @returns {string} 去掉注释后的源码。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('M8-P1-01：学生认证真实落库 —— profile 页真的发请求、只展示脱敏信息、失败走三态', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const profileDirectory = path.join(miniprogramDirectory, 'pages', 'profile');
  const wxmlSource = fs.readFileSync(path.join(profileDirectory, 'profile.wxml'), 'utf8');
  const jsSource = fs.readFileSync(path.join(profileDirectory, 'profile.js'), 'utf8');

  // 只用于**输入框**的合法身份证号（格式合法即可，校验位不必真实）。
  const idNumber = '110101199001011234';
  const maskedIdNumber = '1101********1234';

  const calls = [];
  // 服务端侧的「已认证」记录：**只存脱敏值**，与 store 的 `identityRecords` 同形。
  let identityRecord = null;
  let identityShouldFail = false;
  let verifyShouldFail = false;
  // 认证接口是否真的写入了持久记录 —— 用于「本地不得乐观置真」的反向控制。
  let verifyPersists = true;

  harness.setApiHandler((requestPath, options) => {
    calls.push({ path: requestPath, options });
    if (requestPath === '/api/my/identity') {
      if (identityShouldFail) return Promise.reject(new Error('身份接口 500'));
      return Promise.resolve({ data: identityRecord ? { ...identityRecord } : { verified: false } });
    }
    if (requestPath === '/api/identity/verify') {
      if (verifyShouldFail) return Promise.reject(new Error('身份证号格式或校验位不正确'));
      if (verifyPersists) {
        identityRecord = {
          verified: true,
          ownerNameMasked: '张*',
          idNumberMasked: maskedIdNumber,
          verifiedAt: '2026-09-01T02:00:00.000Z'
        };
      }
      return Promise.resolve({
        data: {
          token: 'tk',
          status: 'VERIFIED',
          ownerNameMasked: '张*',
          idNumberMasked: maskedIdNumber,
          verifiedAt: '2026-09-01T02:00:00.000Z'
        }
      });
    }
    return Promise.resolve({ data: [] });
  });

  const profile = harness.loadPage(path.join('pages', 'profile', 'profile.js'));
  /** 填写认证表单。 */
  const fillIdentityForm = (ownerName, id) => {
    profile.setIdentityField({ currentTarget: { dataset: { field: 'ownerName' } }, detail: { value: ownerName } });
    profile.setIdentityField({ currentTarget: { dataset: { field: 'idNumber' } }, detail: { value: id } });
  };

  // ==================== ⑨ onShow 读取 GET /api/my/identity ====================
  calls.length = 0;
  profile.onShow();
  assert.equal(profile.data.identityBlock.loading, true, '⑨ onShow 应立刻进入加载态');
  assert.equal(
    profile.data.identityBadgeText, '读取中',
    '⑨ ★ 还没有结论时角标不得显示「未认证」—— 那是把「不知道」说成了「没有」'
  );
  await settle();

  assert.equal(
    calls.filter((call) => call.path === '/api/my/identity').length, 1,
    '⑨ ★ onShow 必须读取 GET /api/my/identity（认证状态只认服务端）'
  );
  assert.equal(profile.data.identityBlock.error, '', '⑨ 成功时不应有错误');
  assert.equal(profile.data.verified, false, '⑨ 未认证时 verified 为 false');
  assert.equal(profile.data.identityBadgeText, '未认证', '⑨ 服务端给出了结论时才显示「未认证」');
  assert.equal(profile.data.identity, null, '⑨ 未认证时没有可展示的认证信息');

  // ==================== ⑧ 前置：不合法输入不得白跑一趟网络 ====================
  calls.length = 0;
  harness.clearToasts();
  fillIdentityForm('张', '123');
  await profile.verify();
  await settle();
  assert.equal(
    calls.filter((call) => call.path === '/api/identity/verify').length, 0,
    '⑧ 前置：姓名 / 证件号不合法时不得发请求'
  );
  assert.equal(
    harness.getToasts().at(-1)?.title, '请输入真实姓名和 18 位身份证号',
    '⑧ 前置：必须说明为什么没提交'
  );

  // ==================== ★ 反向控制：认证接口成功但服务端状态没变 ====================
  // 这是「⑧ 的结论确实来自服务端」的**判据自测**：若页面在本地乐观置真
  // （改造前正是 `this.setData({ verified: true })`），下面两条会红。
  verifyPersists = false;
  fillIdentityForm('张三', idNumber);
  calls.length = 0;
  await profile.verify();
  await settle();
  await settle();
  assert.equal(
    calls.filter((call) => call.path === '/api/identity/verify').length, 1,
    '★ 反向控制：认证请求确实发出了'
  );
  assert.equal(
    calls.filter((call) => call.path === '/api/my/identity').length, 1,
    '★ 反向控制：认证成功后确实重新拉了状态'
  );
  assert.equal(
    profile.data.verified, false,
    '★ 反向控制：服务端没落库时页面必须保持「未认证」—— 证明 verified 来自服务端，不是本地置真'
  );
  assert.equal(profile.data.identity, null, '★ 反向控制：没有服务端记录就没有可展示的认证信息');
  verifyPersists = true;

  // ==================== ⑧ verify() 真的发出请求 ====================
  calls.length = 0;
  harness.clearToasts();
  fillIdentityForm('张三', idNumber);
  assert.equal(
    profile.data.identityForm.idNumber, idNumber,
    '⑧ 前置：输入框里确实有用户刚填的 18 位号码'
  );
  await profile.verify();
  await settle();
  await settle();

  const verifyCalls = calls.filter((call) => call.path === '/api/identity/verify');
  assert.equal(
    verifyCalls.length, 1,
    '⑧ ★★ verify() 必须真的发出一次认证请求（请求计数断言，不是源码 grep）'
  );
  assert.equal(verifyCalls[0].options.method, 'POST', '⑧ 认证必须用 POST');
  assert.deepEqual(
    verifyCalls[0].options.data, { ownerName: '张三', idNumber },
    '⑧ 请求体必须是用户填写的姓名与证件号'
  );

  // ==================== ⑩ 展示的是脱敏信息 ====================
  assert.equal(profile.data.verified, true, '⑧ ★ 认证成功后的状态来自服务端（重新拉取的结果）');
  assert.equal(profile.data.identityBadgeText, '已认证', '⑧ 角标文案');
  assert.equal(profile.data.identity.ownerNameMasked, '张*', '⑩ 展示服务端返回的脱敏姓名');
  assert.equal(profile.data.identity.idNumberMasked, maskedIdNumber, '⑩ 展示服务端返回的脱敏证件号');
  assert.equal(profile.data.identity.verifiedAtText, '2026-09-01', '⑩ 认证日期');
  assert.equal(
    profile.data.identityForm.idNumber, '',
    '⑩ ★ 提交成功后必须清空身份证号输入 —— 它已完成使命，留着只是让敏感信息多活一会儿'
  );
  assert.equal(profile.data.identityForm.ownerName, '', '⑩ 姓名同样清空');

  const renderedPage = renderExpressions(wxmlSource, profile.data);
  const leaked = renderedPage.match(/\d{18}/);
  assert.equal(leaked, null, `⑩ ★★ 页面上不得出现完整 18 位身份证号；实得：${leaked && leaked[0]}`);
  // 正向控制：上面那条若因「什么都没渲染」而通过，就毫无价值。
  assert.equal(
    renderedPage.includes(maskedIdNumber), true,
    '⑩ 正向控制：脱敏证件号确实渲染出来了（否则上一条可能是恒真断言）'
  );
  assert.equal(renderedPage.includes('已完成学生认证'), true, '⑩ 正向控制：已认证分支确实渲染了');
  assert.equal(renderedPage.includes('张*'), true, '⑩ 正向控制：脱敏姓名确实渲染出来了');
  // 判据自测：把同一个渲染器用在「页面数据里带着完整号码」的输入上，必须能抓到。
  const leakyRender = renderExpressions(wxmlSource, {
    ...profile.data,
    identityForm: { ownerName: '张三', idNumber }
  });
  assert.equal(
    /\d{18}/.test(leakyRender), true,
    '⑩ 判据自测：渲染器在「数据里带着完整号码」时确实会抓到（否则上一条是恒真断言）'
  );

  // ==================== ⑪ 失败走三态（且不清空已取到的结果） ====================
  identityShouldFail = true;
  await profile.retryIdentity();
  await settle();
  assert.equal(
    profile.data.identityBlock.error, '身份接口 500',
    '⑪ ★ 失败必须成为可见状态（常驻占位 + 重试），而不是一闪而过的 toast'
  );
  assert.equal(
    profile.data.identity.ownerNameMasked, '张*',
    '⑪ ★★ 失败绝不清空已取到的结果 —— 旧数据比「假装没有」有用得多'
  );
  assert.equal(
    profile.data.verified, true,
    '⑪ ★★ 失败时保留上一次的结论，而不是把它翻成「未认证」'
  );
  assert.equal(
    profile.data.identityBadgeText, '已认证',
    '⑪ 有结论时角标就用结论；没有结论才说「状态未知」'
  );

  // 失败 + 重试成功：错误态必须能退出去。
  identityShouldFail = false;
  await profile.retryIdentity();
  await settle();
  assert.equal(profile.data.identityBlock.error, '', '⑪ 重试成功后应清掉错误');
  assert.equal(profile.data.verified, true, '⑪ 重试成功后仍是已认证');

  // ==================== ⑪ 没有旧结果时：只有失败占位，不渲染表单 ====================
  // 最可能的失败原因是「未登录」，此时渲染一个提交出去也只会失败的认证表单是误导。
  //
  // 注意前置：这里必须用一个**新的页面实例**。上面那个实例的块里还留着上一次取到的
  // 结果 —— 失败不清空数据是**正确行为**（上一条正是在断言它），所以拿它测不出
  // 「从来没有取到过结果 + 读取失败」这一种组合。第一版我把这两件事混在一起，
  // 断言报 `actual: {ownerNameMasked: '张*'}` `expected: null`。**是用例前置写错了，
  // 不是页面的问题。**
  const freshProfile = harness.loadPage(path.join('pages', 'profile', 'profile.js'));
  identityRecord = null;
  identityShouldFail = true;
  await freshProfile.retryIdentity();
  await settle();
  assert.equal(freshProfile.data.identity, null, '⑪ 前置：这个实例从来没有取到过结果');
  assert.equal(
    freshProfile.data.identityBadgeText, '状态未知',
    '⑪ ★★ 没有结论 + 读取失败 → 「状态未知」，绝不能是「未认证」'
  );
  assert.equal(freshProfile.data.verified, false, '⑪ 状态未知时不得凭空置为已认证');
  assert.equal(freshProfile.data.identityBlock.error, '身份接口 500', '⑪ 前置：确实处于错误态');

  // ==================== ⑪ 认证失败：动作类失败给提示，保留用户已填内容 ====================
  identityShouldFail = false;
  verifyShouldFail = true;
  await profile.retryIdentity();
  await settle();
  fillIdentityForm('张三', idNumber);
  calls.length = 0;
  harness.clearToasts();
  await profile.verify();
  await settle();
  await settle();
  assert.equal(
    calls.filter((call) => call.path === '/api/my/identity').length, 0,
    '⑪ ★ 认证失败时不该再重拉状态（把「提交失败」的现场冲掉）'
  );
  assert.equal(profile.data.verifying, false, '⑪ 失败后必须退出「认证中」');
  assert.equal(
    profile.data.identityForm.idNumber, idNumber,
    '⑪ ★ 认证失败必须保留用户已填的号码（否则要他重打一遍）'
  );
  assert.equal(
    harness.getToasts().at(-1)?.title, '身份证号格式或校验位不正确',
    '⑪ 失败提示必须采用服务端给出的原因，而不是通用「操作失败」'
  );

  // ==================== ⑫ 按钮文案不含「模拟」 ====================
  // 认证变成真的之后，「模拟」二字就是**界面在说反话**。
  assert.equal(
    renderedPage.includes('模拟'), false,
    '⑫ ★ 已认证态渲染结果里不得出现「模拟」'
  );
  assert.equal(
    wxmlSource.includes('模拟'), false,
    '⑫ ★★ 模板里不得再出现「模拟」—— 按钮文案住在模板里，这一条能挡住有人把它加回来'
  );
  assert.equal(
    jsSource.includes('演示认证成功'), false,
    '⑫ 改造前那句假的成功提示（`wx.showToast({ title: "演示认证成功" })`）必须消失'
  );
  assert.equal(
    stripComments(jsSource).includes('this.setData({ verified: true })'), false,
    '⑫ ★ 本地把 `verified` 置真的写法必须消失（只查可执行代码；注释里如实记录它不算）'
  );
  // 判据自测：`stripComments` 不能把代码一起吃掉，否则上一条会因「什么都没剩」而假通过。
  assert.equal(
    stripComments(jsSource).includes('identityBlock'), true,
    '⑫ 判据自测：去掉注释之后可执行代码仍在（否则上一条是恒真断言）'
  );
});

test('M3-P1-02：结算页单笔上限读运营配置、配置缺失回落 5（不是 NaN）、超限提示用实际配置值', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const checkoutPath = path.join('pages', 'checkout', 'checkout.js');
  const source = fs.readFileSync(path.join(miniprogramDirectory, checkoutPath), 'utf8');
  // 商品库存刻意给 20（远高于任何上限）：这样 `maxQuantity` 只由**平台上限**决定，
  // 库存不参与干扰，断言才直接指向「有没有读到配置」。
  const product = {
    id: 'prod_ebike_001', name: '轻风 通勤版', description: '45km参考续航',
    priceInCents: 239900, stock: 20, availableStock: 20
  };

  // ==================== ⑩ 那段失效注释必须已更新 ====================
  // 改造前写的是「该配置**在服务端尚不存在**（属于 T21）」—— T21 落地后这句就变成假的了。
  assert.equal(
    source.includes('属于 T21'), false,
    '⑩ ★ 失效注释必须删掉（不能再把该配置说成「属于 T21」的待做项）'
  );
  assert.equal(
    source.includes('在服务端尚不存在'), false,
    '⑩ ★ 不能再声称该配置在服务端不存在'
  );
  assert.ok(
    source.includes('M3-P1-02 已落地'),
    '⑩ 注释必须明确说明配置已落地（只删不写会留下「为什么读这个字段」的空白）'
  );
  // 判据自测：证明上面那条判据真的能抓到旧文案，而不是恒真。
  assert.equal(
    '但该配置**在服务端尚不存在**（属于 T21）'.includes('属于 T21'), true,
    '⑩ 判据自测：改造前那句注释确实命中该判据'
  );
  // 模块级写死常量必须消失（`MAX_ORDER_QUANTITY_PER_ITEM` 现在是方法内的局部量，
  // 值来自配置解析，不再是写死的 5）。
  assert.equal(
    /^const MAX_ORDER_QUANTITY_PER_ITEM/m.test(source), false,
    '⑩ ★ 模块级 `const MAX_ORDER_QUANTITY_PER_ITEM = 5` 必须消失 —— 它是「写死」的化身'
  );

  // ==================== ⑦ 上限取自配置，不是常量 ====================
  // 库存 20 时：读配置 → 2；用写死的常量 → 5。断言 2 就能把两者分开。
  harness.setBusinessConfig({ phoneCardActivationHours: 48, deliveryTimeSlots: ['尽快配送'], maxOrderQuantityPerItem: 2 });
  harness.setApiHandler(() => Promise.resolve({ data: product }));
  const configured = harness.loadPage(checkoutPath);
  configured.onLoad({ id: 'prod_ebike_001' });
  await settle();
  assert.equal(
    configured.data.maxQuantity, 2,
    '⑦ ★★ 上限必须取自 config.maxOrderQuantityPerItem（库存 20、配置 2 → 2；若仍是写死的 5 则为 5）'
  );
  assert.equal(configured.data.scooter.stock, 20, '⑦ 判据自测：库存确实是 20，所以 2 只能来自配置');

  // ==================== ⑨ 超限提示用**实际**配置值 ====================
  harness.clearToasts();
  configured.setQuantity({ currentTarget: { dataset: { action: 'increase' } } });
  assert.equal(configured.data.quantity, 2, '⑨ 前置：1 → 2 在上限内，应当被接受');
  configured.setQuantity({ currentTarget: { dataset: { action: 'increase' } } });
  const limitToast = harness.getToasts().at(-1);
  assert.equal(configured.data.quantity, 2, '⑨ 超限时不改变数量');
  assert.ok(limitToast, '⑨ 超限必须给提示');
  assert.ok(
    String(limitToast.title).includes('2'),
    `⑨ ★★ 提示里的 N 必须是实际配置值 2，实得 ${JSON.stringify(limitToast.title)}`
  );
  assert.equal(
    String(limitToast.title).includes('5'), false,
    `⑨ ★★ 提示里不得出现默认值 5（那说明 N 是写死的），实得 ${JSON.stringify(limitToast.title)}`
  );
  assert.ok(
    String(limitToast.title).includes('平台规则'),
    '⑨ 提示必须说明这是平台规则，而不是库存限制'
  );

  // ==================== ⑧ 配置缺失 → 回落 5，且**不是 NaN** ====================
  // `loadBusinessConfig()` 在请求失败时回落到 `services/business.js` 的 `defaultConfig`，
  // 那里没有这个字段 —— 这就是真实会发生的「配置缺失」。
  harness.setBusinessConfig({ phoneCardActivationHours: 48, deliveryTimeSlots: ['尽快配送'] });
  const fallback = harness.loadPage(checkoutPath);
  fallback.onLoad({ id: 'prod_ebike_001' });
  await settle();
  assert.equal(fallback.data.maxQuantity, 5, '⑧ 配置缺失时必须回落到 5');
  assert.equal(
    Number.isNaN(fallback.data.maxQuantity), false,
    '⑧ ★★ 反向护栏：绝不能是 NaN（`Math.min(20, undefined)` 得 NaN，会被 `|| 1` 静默压成 1）'
  );
  // 判据自测：证明上面那条反向护栏**有区分度** ——
  // 照抄「去掉兜底」的写法，结果确实是 NaN，而不是「怎么算都不是 NaN」。
  assert.equal(
    Number.isNaN(Math.max(1, Math.min(20, undefined))), true,
    '⑧ 判据自测：`Math.min(stock, undefined)` 确实得到 NaN —— 所以「不是 NaN」是一条真断言'
  );
  // 非法配置值同样回落（与服务端 `publicSettings` 同一判据，避免两侧错位）。
  for (const bad of [0, -1, 'abc', 100]) {
    harness.setBusinessConfig({ phoneCardActivationHours: 48, deliveryTimeSlots: ['尽快配送'], maxOrderQuantityPerItem: bad });
    const dirty = harness.loadPage(checkoutPath);
    dirty.onLoad({ id: 'prod_ebike_001' });
    await settle();
    assert.equal(dirty.data.maxQuantity, 5, `⑧ 非法配置 ${JSON.stringify(bad)} 必须回落 5`);
    assert.equal(Number.isNaN(dirty.data.maxQuantity), false, `⑧ 非法配置 ${JSON.stringify(bad)} 不能是 NaN`);
  }

  // ==================== ★ 竞态：配置**先到**、商品后到 ====================
  // `onLoad` 里两条请求是并发的，谁先返回不确定。让商品请求人为延迟，验证「配置先到」
  // 这条路径也会收敛到配置值（否则配置会被随后到达的商品回调覆盖掉）。
  harness.setBusinessConfig({ phoneCardActivationHours: 48, deliveryTimeSlots: ['尽快配送'], maxOrderQuantityPerItem: 2 });
  harness.setApiHandler(() => new Promise((resolve) => setTimeout(() => resolve({ data: product }), 25)));
  const configFirst = harness.loadPage(checkoutPath);
  configFirst.onLoad({ id: 'prod_ebike_001' });
  await settle();
  assert.equal(configFirst.data.maxQuantity, 1, '★ 竞态前置：商品未到时上限还是初始值 1（此时算不了）');
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  assert.equal(configFirst.data.maxQuantity, 2, '★ 配置先到、商品后到：必须收敛到配置值 2');

  // ==================== ★ 竞态：配置**后到**且把上限调低 ====================
  // 用户可能已经选满 5 件；配置后到把它压到 2 时，**数量本身**也必须跟着降 ——
  // 只截断展示而不同步 `quantity`，`submit()` 会把 5 原样发给服务端并被 400 拒绝。
  harness.setApiHandler(() => Promise.resolve({ data: product }));
  let releaseConfig = null;
  harness.setBusinessConfigHandler(() => new Promise((resolve) => { releaseConfig = resolve; }));
  const configLast = harness.loadPage(checkoutPath);
  configLast.onLoad({ id: 'prod_ebike_001' });
  await settle();
  assert.equal(configLast.data.maxQuantity, 5, '★ 竞态前置：配置未到时先用兜底 5');
  for (let index = 0; index < 4; index += 1) {
    configLast.setQuantity({ currentTarget: { dataset: { action: 'increase' } } });
  }
  assert.equal(configLast.data.quantity, 5, '★ 竞态前置：用户已选满 5 件');
  assert.ok(releaseConfig, '★ 竞态前置：配置请求的 resolve 已被捕获');
  releaseConfig({ phoneCardActivationHours: 48, deliveryTimeSlots: ['尽快配送'], maxOrderQuantityPerItem: 2 });
  await settle();
  assert.equal(configLast.data.maxQuantity, 2, '★ 配置后到且调低：上限必须降到 2');
  assert.equal(configLast.data.quantity, 2, '★★ 已选数量必须同时被夹回 2（否则 submit 会发出超限数量）');
});

// ===========================================================================
// 发布页草稿（M6-P1-02 / M7-P1-02）—— 页面级接线
//
// 规则本身（上限 / 空草稿判定 / 图片过滤 / 容错）在 `miniapp-runtime.test.js`
// 的纯函数用例里断言过了。这里只回答一个问题：**页面真的接上了吗？**
// 把 `onHide` 里的 `this.saveDraft()` 删掉、或把 `clearDraft` 从成功回调里删掉，
// 纯函数用例**依然全绿** —— 所以必须有这一层。
//
// ⚠️ 关于时序保真：harness 的 `wx.redirectTo` 只**记录**目标地址，不会真的卸载页面
// （真实运行时它会触发 `onUnload`）。因此凡是「跳转之后」的断言，都在确认
// `getRedirectUrl()` 已置位之后**显式**补调 `onUnload()` —— 这一步是必须的，
// 否则本文件会漏掉整整一类缺陷（见下面 ③ 的 ★★）。
// ===========================================================================

/** 一份「用户真的填过」的市集草稿，与页面 data 字段一一对应。 */
const MARKET_DRAFT_EXPECTED = {
  title: '宿舍台灯（可调亮度）',
  description: '用了半年，功能完好，荟园自提',
  contact: 'wx_light_2026',
  priceInput: '29',
  category: 'DAILY',
  condition: 'GOOD',
  images: ['/api/uploads/aa11.jpg']
};

/** 把市集发布页填成「用户真的填过」的样子。 */
function fillMarketForm(publish) {
  publish.setData({
    title: MARKET_DRAFT_EXPECTED.title,
    description: MARKET_DRAFT_EXPECTED.description,
    contact: MARKET_DRAFT_EXPECTED.contact,
    priceInput: MARKET_DRAFT_EXPECTED.priceInput,
    images: MARKET_DRAFT_EXPECTED.images.slice()
  });
  publish.setCategory({ currentTarget: { dataset: { key: 'DAILY' } } });
  publish.setCondition({ currentTarget: { dataset: { key: 'GOOD' } } });
}

const marketPublishPath = path.join('pages', 'market', 'publish.js');
const forumPublishPath = path.join('pages', 'forum', 'publish.js');

test('M6-P1-02 ① 市集发布页：onHide 与 onUnload 各自都会落盘，key 与内容逐字段正确', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const publish = harness.loadPage(marketPublishPath);
  fillMarketForm(publish);
  assert.equal(
    harness.storage.campusGoMarketDraft, undefined,
    '① 前置：仅仅填表不该落盘（落盘只发生在生命周期钩子里，见下）'
  );

  // ==================== onHide：切后台 / 接电话 ====================
  publish.onHide();
  assert.deepEqual(
    harness.storage.campusGoMarketDraft, MARKET_DRAFT_EXPECTED,
    '① onHide（被打断）必须把整份表单落盘，key = campusGoMarketDraft（PRD 指定）'
  );

  // ==================== onUnload：用户点了返回 ====================
  // 先删掉，确认**它自己**会写 —— 否则「onHide 写过」会让这条断言空过。
  delete harness.storage.campusGoMarketDraft;
  publish.onUnload();
  assert.deepEqual(
    harness.storage.campusGoMarketDraft, MARKET_DRAFT_EXPECTED,
    '① onUnload（点返回）同样必须落盘 —— 只挂 onHide 会漏掉「直接返回」这条路径'
  );
});

test('M6-P1-02 ② 市集发布页：onLoad 逐字段恢复草稿，且计数 / 价格校验跟着刷新', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  harness.storage.campusGoMarketDraft = {
    title: '考研英语真题',
    description: '只做了两套，答案齐全',
    contact: 'wx_kaoyan',
    priceInput: '12.5',
    category: 'BOOK',
    condition: 'USED',
    images: ['/api/uploads/bb22.png']
  };

  const publish = harness.loadPage(marketPublishPath);
  assert.equal(publish.data.title, '', '② 前置：onLoad 之前 data 必须是空的（否则下面的断言是空过）');
  publish.onLoad();

  // 逐字段断言，不用 deepEqual 一把梭：这样失败时报错能直接指出是哪个字段没恢复。
  assert.equal(publish.data.title, '考研英语真题', '② title');
  assert.equal(publish.data.description, '只做了两套，答案齐全', '② description');
  assert.equal(publish.data.contact, 'wx_kaoyan', '② contact');
  assert.equal(publish.data.priceInput, '12.5', '② priceInput');
  assert.deepEqual(publish.data.images, ['/api/uploads/bb22.png'], '② images');
  assert.equal(publish.data.selectedCategory.key, 'BOOK', '② 分类存的是 key，恢复时必须找回对应的 option 对象');
  assert.equal(publish.data.selectedCategory.label, '二手书', '② 找回的 option 必须是完整对象（label 要能渲染）');
  assert.equal(publish.data.selectedCondition.key, 'USED', '② 成色同样按 key 找回');
  assert.equal(publish.data.draftRestored, true, '② 恢复过草稿必须置标记 —— 页面上要说明「这些内容是哪来的」');

  // 计数与价格校验必须跟着恢复后的值一起刷新，
  // 否则会出现「输入框里有字，但角标写着 0/60」这种自相矛盾的界面。
  assert.equal(publish.data.titleCount.text, '6/60', '② 恢复后标题计数必须刷新（考研英语真题 = 6 字）');
  assert.equal(publish.data.descriptionCount.text, '10/500', '② 恢复后描述计数必须刷新（只做了两套，答案齐全 = 10 字）');
  assert.equal(publish.data.priceError, '', '② 12.5 元合法，不得报错');

  // ==================== 未知 key 必须回落默认值 ====================
  // 若不回落，`selectedCategory` 会变成 undefined，提交时 `selectedCategory.key` 直接抛错。
  harness.storage.campusGoMarketDraft = { title: '只有标题', category: 'NOT_A_REAL_CATEGORY', condition: 'ALSO_FAKE' };
  const fallback = harness.loadPage(marketPublishPath);
  fallback.onLoad();
  assert.equal(
    fallback.data.selectedCategory.key, 'BOOK',
    '② ★ 草稿里的分类 key 在选项表里不存在时必须保留默认值 —— 否则 selectedCategory.key 会变成 undefined，提交时直接抛错'
  );
  assert.equal(fallback.data.selectedCondition.key, 'LIKE_NEW', '② ★ 成色同理');
  assert.equal(fallback.data.title, '只有标题', '② 未知分类不得影响其余字段的恢复');
});

test('M6-P1-02 ③ ★ 提交成功后草稿被清除 —— 且跳转触发的 onUnload 不得把它写回去', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'market_new_9' } });
  });

  const publish = harness.loadPage(marketPublishPath);
  fillMarketForm(publish);
  // 前置：先落一份草稿，模拟「填到一半切了后台又回来」。
  publish.onHide();
  assert.deepEqual(
    harness.storage.campusGoMarketDraft, MARKET_DRAFT_EXPECTED,
    '③ 前置：草稿确实存在 —— 否则「提交后被清除」这条断言会因为本来就是空而空过'
  );

  publish.submit();
  await settle();
  assert.equal(requests.length, 1, '③ 前置：确实发出了发布请求');
  assert.equal(
    harness.storage.campusGoMarketDraft, undefined,
    '③ ★★ 发布成功后草稿必须被清除 —— 否则下次进页面会把「已发布」的内容恢复出来，用户以为发布失败而再发一次'
  );

  // ★★ 真正的坑在时序上：成功路径的最后一步是 `setTimeout(redirectTo, 600)`，
  // 而 `redirectTo` 会卸载本页 → `onUnload` → `saveDraft()`。
  // 那一刻 `data` 里**还是刚发布的内容**，所以「空草稿不写入」那道守卫帮不上忙 ——
  // 草稿会被原样写回去，「提交后清除」在真实时序上等于没做。
  // harness 的 `redirectTo` 不模拟卸载，所以这里显式补上这一步。
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  assert.equal(
    harness.getRedirectUrl(), '/pages/market/item?id=market_new_9',
    '③ 前置：跳转确实发生了 —— 没有它，下面补调的 onUnload 就是凭空捏造的场景'
  );
  publish.onUnload();
  publish.onHide();
  assert.equal(
    harness.storage.campusGoMarketDraft, undefined,
    '③ ★★ 跳转（redirectTo → onUnload / onHide）之后草稿仍必须为空 ——'
    + '否则「提交成功后清除草稿」在真实时序上根本不成立，用户会重复发布'
  );
});

test('M7-P1-02 ① ② ③ 论坛发布页：落盘 / 逐字段恢复 / 提交后清除（含跳转后的 onUnload）', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const forumDraft = {
    title: '找一起自习的同学',
    content: '每周三、五晚上在图书馆四楼，长期有效。',
    board: 'STUDY',
    images: ['/api/uploads/cc33.jpg']
  };

  // ==================== ① 落盘 ====================
  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'post_new_9' } });
  });

  const publish = harness.loadPage(forumPublishPath);
  publish.setData({ title: forumDraft.title, content: forumDraft.content, images: forumDraft.images.slice() });
  publish.setBoard({ currentTarget: { dataset: { key: 'STUDY' } } });
  assert.equal(harness.storage.campusGoForumDraft, undefined, '① 前置：填表本身不该落盘');
  publish.onHide();
  assert.deepEqual(
    harness.storage.campusGoForumDraft, forumDraft,
    '① 论坛页必须用自己的 key（campusGoForumDraft）落盘，内容逐字段正确'
  );
  assert.equal(
    publishDraft.DRAFT_KEYS.FORUM !== publishDraft.DRAFT_KEYS.MARKET, true,
    '① 两页的 key 必须不同 —— 否则市集草稿会被论坛页恢复出来'
  );

  // ==================== ② 恢复 ====================
  const restored = harness.loadPage(forumPublishPath);
  restored.onLoad();
  assert.equal(restored.data.title, forumDraft.title, '② 论坛 title');
  assert.equal(restored.data.content, forumDraft.content, '② 论坛 content');
  assert.deepEqual(restored.data.images, forumDraft.images, '② 论坛 images');
  assert.equal(restored.data.selectedBoard.key, 'STUDY', '② 板块按 key 找回 option 对象');
  assert.equal(restored.data.selectedBoard.label, '学习互助', '② 找回的 option 必须是完整对象');
  assert.equal(restored.data.draftRestored, true, '② 恢复过草稿必须置标记');

  // ==================== ③ 提交后清除 ====================
  restored.submit();
  await settle();
  assert.equal(requests.length, 1, '③ 前置：确实发出了发帖请求');
  assert.equal(requests[0].path, '/api/forum/posts', '③ 应打到论坛发帖端点');
  assert.equal(
    harness.storage.campusGoForumDraft, undefined,
    '③ ★★ 发帖成功后草稿必须被清除（与市集页同一条纪律）'
  );

  // 同 ③：跳转触发的 onUnload 不得把刚发布的内容写回草稿。
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  assert.equal(
    harness.getRedirectUrl(), '/pages/forum/post?id=post_new_9',
    '③ 前置：跳转确实发生了'
  );
  restored.onUnload();
  assert.equal(
    harness.storage.campusGoForumDraft, undefined,
    '③ ★★ 跳转之后论坛草稿仍必须为空'
  );
});

test('M6-P1-02 ④ ★ 空草稿不得覆盖有效草稿（data 为空时退出 → 不得写入）', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 触发路径有两条，都会让页面 data 保持空：
  // ① `onLoad` 里的读取静默失败（`readDraft` 把 `getStorageSync` 的异常吞成 null）；
  // ② 页面在 `onLoad` 之前就被销毁。
  // 两者都会走到「data 为空时退出」，若无守卫就会用空草稿**覆盖掉**那份有效草稿。
  const marketSnapshot = JSON.parse(JSON.stringify(MARKET_DRAFT_EXPECTED));
  harness.storage.campusGoMarketDraft = marketSnapshot;
  const untouched = harness.loadPage(marketPublishPath);
  // 注意：**故意不调 onLoad** —— 一旦恢复，data 就非空了，这条判据也就测不到守卫。
  untouched.onHide();
  untouched.onUnload();
  assert.deepEqual(
    harness.storage.campusGoMarketDraft, marketSnapshot,
    '④ ★★ 进页面什么都没填就退出，不得用空草稿覆盖上一次的有效草稿 —— 那是数据丢失，不是保守行为'
  );

  // 论坛页同一条纪律。
  const forumSnapshot = { title: '上次填了一半', content: '正文正文', board: 'CAMPUS', images: [] };
  harness.storage.campusGoForumDraft = JSON.parse(JSON.stringify(forumSnapshot));
  const untouchedForum = harness.loadPage(forumPublishPath);
  untouchedForum.onUnload();
  assert.deepEqual(
    harness.storage.campusGoForumDraft, forumSnapshot,
    '④ ★★ 论坛页同样不得用空草稿覆盖有效草稿'
  );

  // ★ 正向控制：真的填了内容时必须写 —— 否则「一律不写」也能让上面两条通过。
  const filled = harness.loadPage(marketPublishPath);
  filled.setData({ title: '新内容' });
  filled.onHide();
  assert.equal(
    harness.storage.campusGoMarketDraft.title, '新内容',
    '★ ④ 正向控制：有内容时必须照常落盘（守卫不能把功能一起关掉）'
  );
});

test('M6-P1-02 ⑤ ★ 恢复出来的图片必须真的能用：只剩失效临时路径的草稿整体不恢复', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 两页的 `chooseImage()` 在上传成功回调里只把**服务端 URL** 存进 `data.images`，
  // 临时路径从未被保留过。所以正常草稿里的图片一定是 `/api/uploads/...`。
  harness.storage.campusGoMarketDraft = {
    title: '有图有真相', description: '', contact: '', priceInput: '',
    category: 'BOOK', condition: 'LIKE_NEW', images: ['/api/uploads/real-1.jpg', '/api/uploads/real-2.png']
  };
  const publish = harness.loadPage(marketPublishPath);
  publish.onLoad();
  assert.deepEqual(
    publish.data.images, ['/api/uploads/real-1.jpg', '/api/uploads/real-2.png'],
    '⑤ 服务端 URL 必须被原样恢复'
  );
  assert.ok(
    publish.data.images.every((url) => url.startsWith('/api/uploads/')),
    '⑤ ★ 恢复出来的每一个图片地址都必须是服务端 URL —— 这样渲染出来的图**真的存在**，不是裂图'
  );

  // ★ 硬约束的反面：一份「只剩失效临时路径」的草稿**不得**被恢复。
  // 若恢复了，用户会看到「已恢复上次未发布的草稿」+ 一个图片框，而图是坏的
  // —— 那是在向用户断言假事实。
  harness.storage.campusGoMarketDraft = {
    title: '', description: '', contact: '', priceInput: '',
    category: 'BOOK', condition: 'LIKE_NEW',
    images: ['wxfile://tmp_dead_1.jpg', 'wxfile://tmp_dead_2.jpg']
  };
  const tempOnly = harness.loadPage(marketPublishPath);
  tempOnly.onLoad();
  assert.deepEqual(
    tempOnly.data.images, [],
    '⑤ ★★ 草稿里只剩失效的临时路径时，不得恢复出任何图片框（宁可没有图，也不能有坏图）'
  );
  assert.equal(
    tempOnly.data.draftRestored, false,
    '⑤ ★★ 也不得显示「已恢复上次未发布的草稿」—— 那会承诺一份并不存在的内容'
  );

  // 论坛页同样的过滤（它有自己的张数上限 3）。
  harness.storage.campusGoForumDraft = {
    title: '带图帖子', content: '正文', board: 'CAMPUS',
    images: ['wxfile://tmp_dead.jpg', '/api/uploads/keep.jpg', 'http://tmp/x.png']
  };
  const forum = harness.loadPage(forumPublishPath);
  forum.onLoad();
  assert.deepEqual(forum.data.images, ['/api/uploads/keep.jpg'], '⑤ ★ 论坛侧同样只留服务端 URL');
});

test('M6-P1-02 ⑥ 市集发布页：字数计数真的接上了（59 / 60 / 61），且输入框限长与常量一致', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const publish = harness.loadPage(marketPublishPath);
  assert.equal(publish.data.titleCount.text, '0/60', '⑥ 初始计数应为 0/60');
  assert.equal(publish.data.descriptionCount.text, '0/500', '⑥ 初始描述计数应为 0/500');

  publish.setTitle({ detail: { value: 'a'.repeat(59) } });
  assert.equal(publish.data.titleCount.text, '59/60', '⑥ 59 字');
  assert.equal(publish.data.titleCount.over, false, '⑥ 59 字未超限');

  publish.setTitle({ detail: { value: 'a'.repeat(60) } });
  assert.equal(publish.data.titleCount.text, '60/60', '⑥ 60 字');
  assert.equal(publish.data.titleCount.over, false, '⑥ ★ 60/60 不得标记超限（服务端接受这个长度）');

  publish.setTitle({ detail: { value: 'a'.repeat(61) } });
  assert.equal(publish.data.titleCount.text, '61/60', '⑥ 61 字');
  assert.equal(publish.data.titleCount.over, true, '⑥ 61 字必须标记超限（角标要变红，提示用户）');

  publish.setDescription({ detail: { value: 'a'.repeat(500) } });
  assert.equal(publish.data.descriptionCount.text, '500/500', '⑥ 描述 500 字');
  assert.equal(publish.data.descriptionCount.over, false, '⑥ 描述 500 字不得标记超限');
  publish.setDescription({ detail: { value: 'a'.repeat(501) } });
  assert.equal(publish.data.descriptionCount.over, true, '⑥ 描述 501 字必须标记超限');

  // 「无法继续输入」由 wxml 的 `maxlength` 保证 —— 这是唯一能验证它的探针
  // （`maxlength` 是渲染层的截断，页面 JS 里看不到）。
  const wxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'market', 'publish.wxml'), 'utf8');
  assert.ok(
    wxml.includes(`maxlength="${publishDraft.FIELD_LIMITS.market.title}"`),
    '⑥ 标题输入框必须有 maxlength=60（与服务端上限同源）'
  );
  assert.ok(
    wxml.includes(`maxlength="${publishDraft.FIELD_LIMITS.market.description}"`),
    '⑥ 描述输入框必须有 maxlength=500'
  );
  assert.ok(wxml.includes('{{titleCount.text}}'), '⑥ 计数必须真的渲染在页面上（只算不显示等于没做）');
  assert.ok(wxml.includes('{{descriptionCount.text}}'), '⑥ 描述计数同样必须渲染出来');
  assert.ok(wxml.includes('titleCount.over'), '⑥ 超限时必须能改变样式（否则用户看不出「满了」）');
});

test('M6-P1-02 ⑦ 市集发布页：价格非法时按钮置灰 + 显示原因（0 / 0.01 / 100000 / 100000.01）', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const publish = harness.loadPage(marketPublishPath);
  assert.equal(publish.data.priceError, '', '⑦ 未填写时不算错误（否则一进页面按钮就是灰的）');

  publish.setPrice({ detail: { value: '0' } });
  assert.notEqual(publish.data.priceError, '', '⑦ 0 元必须给出原因（服务端 priceInCents <= 0 会拒绝）');
  assert.ok(
    publish.data.priceError.includes('0.01') && publish.data.priceError.includes('100000'),
    '⑦ 原因里必须写明合法区间，否则用户不知道该改成多少'
  );

  publish.setPrice({ detail: { value: '0.01' } });
  assert.equal(publish.data.priceError, '', '⑦ 0.01 元（下界）必须合法');
  publish.setPrice({ detail: { value: '100000' } });
  assert.equal(publish.data.priceError, '', '⑦ 100000 元（上界）必须合法');
  publish.setPrice({ detail: { value: '100000.01' } });
  assert.notEqual(publish.data.priceError, '', '⑦ ★ 100000.01 元必须当场报错（不是等提交时弹 toast）');
  publish.setPrice({ detail: { value: 'abc' } });
  assert.notEqual(publish.data.priceError, '', '⑦ 非数字必须当场报错');

  // 区间提示的文案（页面 data 里的 `priceRangeText`）必须带单位「元」——
  // 服务端的拒绝文案是「价格需要在 0.01 元到 10 万元之间」，前端不带单位会被读成别的量纲。
  assert.equal(
    publish.data.priceRangeText, '0.01 ~ 100000 元',
    '⑦ 区间提示必须带「元」，与服务端文案同口径'
  );

  // 「按钮置灰」由 wxml 的 disabled 表达式保证。
  const wxml = fs.readFileSync(path.join(miniprogramDirectory, 'pages', 'market', 'publish.wxml'), 'utf8');
  assert.ok(
    wxml.includes("disabled=\"{{submitting || priceError !== ''}}\""),
    '⑦ ★ 按钮必须在 priceError 非空时置灰 —— 不能只在提交时弹 toast（用户要等一趟往返才知道填错了）'
  );
  assert.ok(wxml.includes('wx:if="{{priceError}}"'), '⑦ 错误原因必须显示在价格输入框旁边');
  assert.ok(wxml.includes('{{priceRangeText}}'), '⑦ 合法区间必须常驻显示（不要等用户填错才告诉他范围）');

  // ==================== 提交侧同源：越界值不得发出去 ====================
  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'market_x' } });
  });
  publish.setData({ title: '标题', description: '描述', contact: 'wx_ok_123', priceInput: '100000.01' });
  publish.submit();
  assert.equal(
    requests.length, 0,
    '⑦ ★ 越界价格必须在本地拦下（请求计数为 0）—— 改造前它会发出去再吃一个 400，白跑一趟网络'
  );
});

test('M6-P1-02 ⑧ ★ setStorageSync 抛错时页面不崩，且仍然能发布', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  // 配额耗尽 / 隐私模式：`wx.setStorageSync` 抛错。
  harness.setStorageWriteFailure(true);

  const publish = harness.loadPage(marketPublishPath);
  fillMarketForm(publish);

  assert.doesNotThrow(() => publish.onHide(), '⑧ ★ 写草稿失败不得把异常抛出 onHide（会打断页面生命周期）');
  assert.doesNotThrow(() => publish.onUnload(), '⑧ ★ 同样不得抛出 onUnload');
  assert.equal(
    harness.storage.campusGoMarketDraft, undefined,
    '⑧ 前置：草稿确实没写进去（桩真的在抛错）'
  );

  // 页面必须仍然可用：草稿是**辅助**能力，不该拦住用户发布。
  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'market_ok' } });
  });
  publish.submit();
  await settle();
  assert.equal(
    requests.length, 1,
    '⑧ ★★ Storage 写失败后必须仍然能发布 —— 草稿写不进去是次要问题，拦住发布才是主要问题'
  );
  assert.equal(requests[0].data.title, MARKET_DRAFT_EXPECTED.title, '⑧ 请求体不得因 Storage 故障而变形');

  // 成功路径有 `setTimeout(..., 600)` 的跳转，等它跑完再结束用例（否则定时器会在 restore 之后触发）。
  await new Promise((resolve) => { setTimeout(resolve, 700); });
});

test('M6-P1-02 ⑧ 草稿读取抛错时页面仍能进，且不销毁 Storage 里那份草稿', (t) => {
  // 单独一个用例而不是接在 ⑧ 后面：两个 harness 同时存在会互相套娃 ——
  // 后建的那个把「前一个的补丁」当成原始值记下来，`restore()` 一执行就会
  // 把前一个的桩永久留在 `global.wx` 上，污染同文件后续所有用例。
  const harness = createHarness();
  t.after(() => harness.restore());

  // 预置一份有效草稿再让读取抛错 —— 这样「读不到」与「本来就没草稿」被区分开。
  harness.storage.campusGoMarketDraft = MARKET_DRAFT_EXPECTED;
  harness.setStorageReadFailure(true);

  const publish = harness.loadPage(marketPublishPath);
  assert.doesNotThrow(() => publish.onLoad(), '⑧ ★ 读草稿失败不得把异常抛出 onLoad（否则用户根本进不了发布页）');
  assert.equal(publish.data.draftRestored, false, '⑧ 读不到草稿时不得显示「已恢复草稿」');
  assert.equal(publish.data.title, '', '⑧ 读不到草稿时表单应保持空白，不得是半截状态');
  // ★ 读失败也不能把 Storage 里那份草稿弄丢：用户下次进来（Storage 恢复正常）还应该能恢复。
  assert.deepEqual(
    harness.storage.campusGoMarketDraft, MARKET_DRAFT_EXPECTED,
    '⑧ ★ 读取失败只是「这次读不到」，不得顺手删掉 Storage 里那份草稿'
  );

  harness.setStorageReadFailure(false);
  const retry = harness.loadPage(marketPublishPath);
  retry.onLoad();
  assert.equal(retry.data.title, MARKET_DRAFT_EXPECTED.title, '⑧ ★ 读取恢复正常后草稿必须还能恢复（失败不销毁数据）');
});

test('★ M6-P1-02（T44）contact 下限必须单点同源：页面不得手抄数字', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const requests = [];
  harness.setApiHandler((requestPath, options) => {
    requests.push({ path: requestPath, data: (options && options.data) || {} });
    return Promise.resolve({ data: { id: 'market_min_1' } });
  });

  const publish = harness.loadPage(marketPublishPath);
  // ★ 判据自己也不写数字：边界由**共享常量**推出。这样测试文件里不会出现第二份副本，
  // 常量一改，这里的边界跟着改 —— 否则「测试跟着实现一起错」就无人能发现。
  const min = publishDraft.CONTACT_MIN_LENGTH;

  // ==================== 边界：min - 1 字符 → 必须本地拦下 ====================
  // 先测被拦的一侧：它不发请求、不起定时器，用例不必等跳转。
  publish.setData({
    title: '标题', description: '描述', priceInput: '9',
    contact: 'x'.repeat(min - 1)
  });
  publish.submit();
  await settle();
  assert.equal(
    requests.length, 0,
    `★ ${min - 1} 字符（= 共享常量 - 1）必须被本地拦下（请求计数 0）——`
    + '若变成 1，说明页面的下限与共享常量不是同一个值（手抄的副本漂移了），'
    + '用户会白跑一趟网络往返吃 400'
  );
  assert.equal(publish.data.contactFocus, true, '被拦下时必须把光标送到联系方式输入框');
  assert.equal(publish.data.submitting, false, '被拦下时不得把按钮锁在「正在发布…」');

  // ==================== 边界：恰好 min 字符 → 必须真的发出去 ====================
  // 没有这条，「计数为 0」也可能只是因为「任何长度都不发请求」。
  publish.setData({ contact: 'x'.repeat(min), submitting: false });
  publish.submit();
  await settle();
  assert.equal(
    requests.length, 1,
    `★ 恰好 ${min} 字符（= 共享常量）必须放行 —— 否则用户会被拦在一个服务端本来接受的值上`
  );
  assert.equal(requests[0].data.contact, 'x'.repeat(min), '放行时联系方式应原样带在请求体里');

  // ==================== 源码级：确认页面真的**引用**共享常量 ====================
  // 为什么光有行为断言不够：它无法区分「读共享常量」与「两处各写一个恰好相同的数字」——
  // 前者服务端一动就跟着动，后者不会。而后者正是 T44 要消灭的东西。
  // 所以必须再看一眼源码（与防漂移用例里 wxml `maxlength` 的做法同一路数）。
  const pageSource = fs.readFileSync(path.join(miniprogramDirectory, marketPublishPath), 'utf8');
  assert.ok(
    pageSource.includes('publishDraft.CONTACT_MIN_LENGTH'),
    '★ 页面必须引用 publishDraft.CONTACT_MIN_LENGTH（否则服务端上调下限时前端不会跟）'
  );
  assert.ok(
    !/CONTACT_MIN_LENGTH\s*=\s*\d/.test(pageSource),
    '★ 页面里不得再出现 `CONTACT_MIN_LENGTH = <数字>` 的手抄副本 —— 那正是 T44 要消灭的东西'
  );

  // 成功路径有 `setTimeout(..., 600)` 的跳转，等它跑完再结束用例（否则定时器会在 restore 之后触发）。
  await new Promise((resolve) => { setTimeout(resolve, 700); });
});
