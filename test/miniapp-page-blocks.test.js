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
