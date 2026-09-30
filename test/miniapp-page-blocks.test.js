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
  const wxStub = new Proxy({
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: (key) => { delete storage[key]; },
    nextTick: (fn) => fn(),
    redirectTo: (options) => { redirectUrl = options.url; },
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
      payPaymentOrder: () => Promise.resolve({})
    }],
    [require.resolve(path.join(miniprogramDirectory, 'utils', 'navigation.js')), {
      openLink: () => {}
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
    getRedirectUrl() { return redirectUrl; },
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
