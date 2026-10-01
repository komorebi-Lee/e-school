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
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
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
  // 记录页面把跳转委托给 openLink 的调用（tabBar 页必须走它，不能自己调 navigateTo）。
  const openLinkCalls = [];
  const stubs = new Map([
    [require.resolve(path.join(miniprogramDirectory, 'services', 'api.js')), {
      request: (requestPath, options) => apiHandler(requestPath, options),
      apiRequest: (requestPath, options) => apiHandler(requestPath, options),
      userId: () => 'user-1'
    }],
    [require.resolve(path.join(miniprogramDirectory, 'services', 'business.js')), {
      loadBusinessConfig: () => Promise.resolve({ phoneCardActivationHours: 48 })
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
    /** 设置支付调用的行为（resolve = 支付成功；reject = 订单已创建但支付失败）。 */
    setPaymentHandler(handler) { paymentHandler = handler; },
    /** 记录到的 `wx.showModal` 调用（`success` 回调保留，由用例显式触发）。 */
    getModals() { return modalCalls.slice(); },
    /** 记录到的 `wx.showToast` 调用。 */
    getToasts() { return toastCalls.slice(); },
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
