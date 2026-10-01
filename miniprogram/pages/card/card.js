const { loadBusinessConfig } = require('../../services/business');
const { payPaymentOrder } = require('../../services/payment');
const { openLink } = require('../../utils/navigation');
const loadState = require('../../utils/load-state');

/** 业务配置拿不到时的兜底激活时长（小时）。 */
const DEFAULT_ACTIVATION_HOURS = 24;

/**
 * 三个区块的状态键。
 *
 * 集中定义而不是散落字面量：`loadBlock` 靠 `stateKey` 决定写哪一块，
 * 拼错一个字母就会出现「块串味」（A 的加载态盖掉 B 的数据），而且不会报错。
 */
const BLOCK_KEYS = Object.freeze({
  PLANS: 'plansBlock',
  PROMOS: 'promosBlock',
  CONFIG: 'configBlock'
});

Page({
  data: {
    // ★ 三态区块：套餐 / 活动 / 业务配置各自独立。
    // 改造前三处都是空 catch：接口挂掉时页面既无提示也无重试，
    // 用户看到的是「空列表」—— 一个错误的结论（本来就没有套餐？）。
    plansBlock: loadState.initialBlock(),
    promosBlock: loadState.initialBlock(),
    configBlock: loadState.initialBlock(),
    selectedPlan: 0,
    selectedPromo: null,
    promoIsBuyable: true,
    // 选中套餐是否可办理。由服务端 `purchasable` 驱动，控制提交按钮的禁用与文案。
    // 初值 true：套餐还没加载出来时按钮保持可点，点下去会提示「套餐尚未加载完成」
    // —— 与改造前一致，不改变未加载状态下的交互。
    planPurchasable: true,
    activeSection: 0,
    profileName: '',
    profilePhone: '',
    companionPhone: '',
    submitting: false
  },
  onLoad(options = {}) {
    this.pendingPlanId = options.planId ? decodeURIComponent(options.planId) : '';
    this.pendingPromoId = options.promoId ? decodeURIComponent(options.promoId) : '';
    const profile = wx.getStorageSync('shishanUserProfile') || {};
    this.setData({
      profileName: profile.name || '',
      profilePhone: profile.phone || '',
      companionPhone: profile.companionPhone || ''
    });
    this.loadBusinessConfig();
    this.loadPlans();
    this.loadPromos();
  },

  /**
   * 用共享的三态工具加载一个区块。
   *
   * `loadBlock` 负责三件事：先写「加载中」（保留上一次数据）、成功写数据、
   * 失败**只**写 `error` 文案并把上一次的数据原样带回（绝不清空）。
   *
   * @param {string} stateKey 区块状态键，见 {@link BLOCK_KEYS}。
   * @param {Function} loader 返回 Promise 的加载函数，解析值即该区块的数据。
   * @returns {Promise<unknown>} 区块数据；失败时为 `undefined`（错误已写入区块）。
   */
  loadSection(stateKey, loader) {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey,
      prev: this.data[stateKey],
      loader
    });
  },

  /** 业务配置区块：失败只影响激活时长文案，不影响套餐与活动。 */
  loadBusinessConfig() {
    return this.loadSection(BLOCK_KEYS.CONFIG, () => loadBusinessConfig().then((config = {}) => {
      const hours = Number(config.phoneCardActivationHours || DEFAULT_ACTIVATION_HOURS);
      return { phoneCardActivationHours: hours > 0 ? hours : DEFAULT_ACTIVATION_HOURS };
    }));
  },
  /** 重新加载：业务配置。 */
  retryBusinessConfig() {
    return this.loadBusinessConfig();
  },

  /** 套餐区块：/api/products?category=PHONE_PLAN */
  loadPlans() {
    const { request } = require('../../services/api');
    return this.loadSection(BLOCK_KEYS.PLANS, () => request('/api/products?category=PHONE_PLAN').then(({ data }) => {
      const plans = (data || []).filter((item) => item.active !== false).map((item) => ({
        id: item.id,
        name: item.name,
        monthlyFee: Math.round((item.effectivePriceInCents ?? (item.priceInCents || 0)) / 100),
        originalFee: Math.round((item.promotion?.originalPriceInCents || 0) / 100),
        promoText: item.promotion?.statusText || '',
        data: item.description || '套餐详情以运营商确认为准',
        voice: item.voice || '通话资费见套餐说明',
        // 可办理与否由服务端的 `purchasable` 决定（在架 且 有可售库存）。
        // 字段缺失时按「可办理」处理 —— 与改造前一致，避免老服务端把页面锁死。
        // 用 `purchasable` 而不是 `item.stock > 0`：库存全被待支付订单占用时
        // 可售为 0，`stock` 仍是正数，只看 `stock` 会把「已售罄」显示成「可办理」。
        purchasable: item.purchasable !== false,
        badge: item.purchasable === false ? '已售罄' : '可办理'
      }));
      let selectedPlan = this.data.selectedPlan;
      if (plans.length) {
        selectedPlan = 0;
        if (this.pendingPlanId) {
          const focused = plans.findIndex((item) => item.id === this.pendingPlanId);
          if (focused >= 0) selectedPlan = focused;
          this.pendingPlanId = '';
        }
        this.setData({ selectedPlan });
      }
      return plans;
    })).then((plans) => {
      // 必须在区块**写入之后**再同步按钮状态：`loadBlock` 是在 loader 返回后
      // 才 `setData({ plansBlock })` 的，在 loader 内部读 `this.data.plansBlock`
      // 拿到的还是上一批数据（首次加载时是空数组），按钮会被错误地保持可点。
      this.syncPlanPurchasable();
      return plans;
    });
  },
  /** 重新加载：套餐。 */
  retryPlans() {
    return this.loadPlans();
  },

  /** 活动区块：/api/recharge-promos */
  loadPromos() {
    const { request } = require('../../services/api');
    return this.loadSection(BLOCK_KEYS.PROMOS, () => request('/api/recharge-promos').then(({ data }) => {
      const rechargePromos = (data || []).map((item) => {
        const isBuyable = item.isBuyable !== false;
        const statusLabel = item.statusLabel || (isBuyable ? '进行中' : '不可下单');
        return {
          id: item.id,
          pay: item.pay,
          receive: item.receive,
          badge: item.badge || '限时优惠',
          status: item.promoStatus || item.status || 'ACTIVE',
          statusLabel,
          isBuyable,
          availabilityText: isBuyable ? '开放下单' : '当前不可下单'
        };
      });
      if (rechargePromos.length) {
        let nextPromo = this.data.selectedPromo;
        if (this.pendingPromoId) {
          const focusedPromo = rechargePromos.findIndex((item) => item.id === this.pendingPromoId);
          if (focusedPromo >= 0) nextPromo = focusedPromo;
          this.pendingPromoId = '';
        }
        this.setData({
          selectedPromo: nextPromo,
          promoIsBuyable: nextPromo === null || rechargePromos[nextPromo]?.isBuyable !== false
        });
      }
      return rechargePromos;
    }));
  },
  /** 重新加载：活动。 */
  retryPromos() {
    return this.loadPromos();
  },

  /** 当前套餐列表（区块数据缺失时回落到空数组，避免模板取属性报错）。 */
  currentPlans() {
    return this.data.plansBlock.data || [];
  },
  /** 当前活动列表。 */
  currentPromos() {
    return this.data.promosBlock.data || [];
  },
  /** 激活时长：配置区块失败时用兜底值，不让提交流程断掉。 */
  activationHours() {
    const configured = this.data.configBlock.data?.phoneCardActivationHours;
    return Number(configured) > 0 ? Number(configured) : DEFAULT_ACTIVATION_HOURS;
  },

  /**
   * 同步「当前选中套餐是否可办理」到 data，供模板控制提交按钮的禁用与文案。
   *
   * 数据来源是 `plansBlock.data`（区块已写入的那份），所以调用点必须在
   * `loadSection(...).then(...)` 里，见 `loadPlans` 的说明。
   */
  syncPlanPurchasable() {
    const plan = this.currentPlans()[this.data.selectedPlan];
    // 套餐缺失（尚未加载 / 索引越界）时按「可办理」处理，与改造前一致：
    // 此时点提交会提示「套餐尚未加载完成」，比按钮直接变灰更说明问题。
    this.setData({ planPurchasable: Boolean(plan) && plan.purchasable !== false });
  },

  choosePlan(e) {
    this.setData({ selectedPlan: Number(e.currentTarget.dataset.index) });
    this.syncPlanPurchasable();
  },
  choosePromo(e) {
    const index = Number(e.currentTarget.dataset.index);
    const selectedPromo = this.data.selectedPromo === index ? null : index;
    const promoIsBuyable = selectedPromo === null || this.currentPromos()[selectedPromo]?.isBuyable !== false;
    this.setData({ selectedPromo, promoIsBuyable });
  },
  onReady() { this.measureSections(); },
  measureSections() { const query = wx.createSelectorQuery(); query.selectAll('.business-section').boundingClientRect(); query.selectViewport().scrollOffset(); query.exec(res => { const scrollTop = (res[1] && res[1].scrollTop) || 0; this.sectionTops = (res[0] || []).map(item => item.top + scrollTop) }) },
  onPageScroll(e) { const tops = this.sectionTops || []; if (tops.length !== 3) return; const marker = e.scrollTop + 150; let active = 0; if (marker >= tops[2]) active = 2; else if (marker >= tops[1]) active = 1; if (active !== this.data.activeSection) this.setData({ activeSection: active }) },
  jumpSection(e) { const index = Number(e.currentTarget.dataset.index); this.setData({ activeSection: index }); const query = wx.createSelectorQuery(); query.selectAll('.business-section').boundingClientRect(); query.selectViewport().scrollOffset(); query.exec(res => { const sections = res[0] || []; const scrollTop = (res[1] && res[1].scrollTop) || 0; this.sectionTops = sections.map(item => item.top + scrollTop); const target = sections[index]; if (target) wx.pageScrollTo({ scrollTop: Math.max(0, target.top + scrollTop - 92), duration: 280 }) }) },
  setProfileName(e) { this.setData({ profileName: e.detail.value }); this.saveProfile() },
  setProfilePhone(e) { this.setData({ profilePhone: e.detail.value }); this.saveProfile() },
  setCompanionPhone(e) { this.setData({ companionPhone: e.detail.value }); this.saveProfile() },
  saveProfile() { wx.setStorageSync('shishanUserProfile', { name: this.data.profileName.trim(), phone: this.data.profilePhone.trim(), companionPhone: this.data.companionPhone.trim() }) },
  profileValid() { return this.data.profileName.trim() && /^1\d{10}$/.test(this.data.profilePhone.trim()) },
  submit() {
    const p = this.currentPlans()[this.data.selectedPlan];
    const { request } = require('../../services/api');
    if (!p) return wx.showToast({ title: '套餐尚未加载完成', icon: 'none' });
    // ★ 已售罄 / 已下架：不发请求。服务端必然拒绝，白跑一趟网络，
    // 而且用户看到的是「点了没反应」或一句莫名其妙的失败提示。
    if (p.purchasable === false) return wx.showToast({ title: '该套餐已售罄，暂不可办理', icon: 'none' });
    if (!this.profileValid()) return wx.showModal({ title: '补充办理信息', content: '请先填写办理人姓名和手机号', showCancel: false });
    if (this.data.submitting) return;
    const promo = this.data.selectedPromo === null ? null : this.currentPromos()[this.data.selectedPromo];
    if (promo && promo.isBuyable === false) return wx.showToast({ title: promo.availabilityText || '当前不可下单', icon: 'none' });
    const saved = this.currentProfile();
    this.setData({ submitting: true });
    request('/api/phone-card-orders', { method: 'POST', header: { 'Idempotency-Key': 'tel-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) }, data: { customerName: saved.name, phone: saved.phone, productId: p.id } })
      .then(({ data, paymentOrder }) => {
        const finish = (benefitText) => { this.setData({ submitting: false }); wx.showModal({ title: '支付成功', content: `${p.name}已进入实名激活跟进${benefitText}，客服将在${this.activationHours()}小时内联系你。`, confirmText: '查看订单', cancelText: '继续浏览', success: (result) => { if (result.confirm) wx.switchTab({ url: '/pages/orders/orders' }) } }) };
        if (!paymentOrder || !paymentOrder.id) throw new Error('支付单创建失败');
        return payPaymentOrder(paymentOrder).then(() => {
          if (!promo) return finish('');
          return request('/api/recharge-orders', { method: 'POST', header: { 'Idempotency-Key': 'rech-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) }, data: { phone: saved.phone, promoId: promo.id } })
            .then(({ paymentOrder: benefitPayment }) => {
              if (!benefitPayment || !benefitPayment.id) return finish('，限时福利已同步创建');
              return payPaymentOrder(benefitPayment).then(() => finish('，限时福利已同步创建'));
            })
            .catch(() => finish('，限时福利下单失败，可联系客服处理'));
        });
      })
      .catch((error) => { this.setData({ submitting: false }); wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false }) });
  },
  applyBroadband() {
    const { request } = require('../../services/api');
    if (!this.profileValid()) return wx.showModal({ title: '补充办理信息', content: '请先填写办理人姓名和手机号', showCancel: false });
    if (!/^1\d{10}$/.test(this.data.companionPhone.trim())) return wx.showToast({ title: '请填写同伴手机号', icon: 'none' });
    const saved = this.currentProfile();
    request('/api/broadband-applications', { method: 'POST', data: { ownerPhone: saved.phone, companionPhone: this.data.companionPhone } })
      .then(() => { wx.showToast({ title: '宽带资格已提交' }); setTimeout(() => openLink('/pages/orders/orders'), 650) })
      .catch((error) => { wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false }) });
  },
  currentProfile() {
    const profile = wx.getStorageSync('shishanUserProfile') || {};
    return { name: profile.name || '', phone: profile.phone || '' };
  }
});
