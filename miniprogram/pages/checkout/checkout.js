const { request, userId } = require('../../services/api');
const { loadBusinessConfig } = require('../../services/business');
const { payPaymentOrder } = require('../../services/payment');
const loadState = require('../../utils/load-state');
// 订单页是 tabBar 页，跳转必须走 openLink（focusId 经 Storage 传递）。
const { openLink } = require('../../utils/navigation');
const {
  readRentalPlan,
  rentalUnitLabel,
  toProductCard,
  computeRentalFees,
  computeRentalDueAt,
  stepRentalUnits
} = require('../../utils/product-view');

/**
 * 单笔最多购买数量上限（售卖商品）的**兜底默认值**。
 *
 * 真正的上限来自运营配置 `adminSettings.maxOrderQuantityPerItem`，由服务端
 * `GET /api/business-config` 下发（M3-P1-02 已落地，服务端侧含 1~99 的边界校验）。
 *
 * ⚠️ 这个常量是**兜底**，不是上限本身。配置请求失败时 `loadBusinessConfig()`
 * 会回落到 `services/business.js` 的 `defaultConfig`，那里**没有**这个字段；
 * 老服务端也不会下发它。两种情况都会得到 `undefined`。
 *
 * 为什么必须兜底而不能直接读：`Math.min(stock, undefined)` 得到 `NaN`，
 * 而 `NaN` 会被 `updateTotals` 里的 `|| 1` 兜住 —— 用户会看到一个「只能买 1 件」
 * 的页面，却完全不知道原因。**静默失效比明确报错更难排查。**
 */
const DEFAULT_MAX_ORDER_QUANTITY_PER_ITEM = 5;

/**
 * 从业务配置里解析出平台单笔上限。
 *
 * 判据与服务端 `publicSettings` / 下单校验逐字同源：只有 **1~99 的整数**才算合法
 * 配置值；其余（`undefined` / `0` / `-1` / `'abc'` / `NaN` / 越界）一律回落默认值。
 * 两侧判据一致，才不会出现「服务端按 5 拦、前端按 2 提示」这种错位。
 *
 * @param {object|null} config `/api/business-config` 的响应体（可能尚未到达）。
 * @returns {number} 平台单笔上限，恒为 ≥ 1 的整数。
 */
function resolveMaxOrderQuantityPerItem(config) {
  const configured = Number(config && config.maxOrderQuantityPerItem);
  return Number.isInteger(configured) && configured >= 1 && configured <= 99 ? configured : DEFAULT_MAX_ORDER_QUANTITY_PER_ITEM;
}

Page({
  data: { scooter: null, config: null, deliveryTimeSlots: [], deliveryTimeIndex: 0, name: '', phone: '', date: '', minDate: '', deliveryAddress: '', addresses: [], selectedAddressId: '', saveAddress: true, submitting: false, payToken: '', itemsFee: 0, deliveryFee: 0, totalFee: 0, agreed: false, quantity: 1, maxQuantity: 1, isRental: false, rentalPlan: null, rentalUnits: 1, rentalUnitLabel: '', rentalFees: null, rentalDue: null, addressesError: '',
    // ★ `productLoaded` / `productError`（T50）：把「取商品」这一块补成三态。
    //
    //   改造前这块**没有任何状态**：`scooter` 的初值是 `null`，而整页被
    //   `checkout.wxml:1` 的 `wx:if="{{scooter}}"` 包住 —— 于是
    //   ① 首屏那一次请求还没回来时**整页空白**（连一句「正在加载」都没有）；
    //   ② 请求**失败**时 `scooter` 永远是 `null`，而那条 catch 只弹一个 toast、
    //      **不设任何错误态** → 页面**永久空白**，toast 一两秒就消失，
    //      之后既没有内容也没有重试入口。这比我们修过的那批「假陈述」更糟：
    //      那些至少说了句错话，这个是**什么都不说且无法恢复**。
    //
    //   `productLoaded` 的语义与 `plate.js` 的 `ordersLoaded` 同源：区分
    //   「**还没取到**」与「取到了」，**成功与失败都置 `true`** —— 它回答的是
    //   「有没有得到答复」，不是「成不成功」。
    productLoaded: false, productError: '' },
  onShow() {
    const now = new Date();
    const minDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    this.setData({ minDate, name:profile.name||'', phone:profile.phone||'', date: this.data.date || minDate });
    this.loadAddresses();
  },
  onLoad(options) {
    const id = options.id || '';
    // ★ T50：商品 id 存在实例上，供 `loadProduct()` / `retryProduct()` 复用。
    //   不放进 `data` —— 它不参与渲染，放进去只会让每次 `setData` 都多带一份。
    this.productId = id;
    this.setData({ payToken: `ebike-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    // ★ T50：商品加载搬进 `loadProduct()`，好让失败重试能**复用同一条链**，
    //   而不必重跑 `onLoad` —— 重跑会重新生成 `payToken`，那是提交路径上的东西。
    //   于是 `payToken` 由 `onLoad` 独占，天然保证「**每次进页面只生成一次**」。
    this.loadProduct();
    loadBusinessConfig().then((config) => {
      this.setData({ config, deliveryTimeSlots: config.deliveryTimeSlots });
      this.refreshMaxQuantity();
    });
  },
  /**
   * 加载商品详情。
   *
   * ★ 本方法是 T50 从 `onLoad` 里**逐字节搬出来**的（原 `:60-88` 一行未改，
   *   连缩进都没变，因为两边都是「方法 → then 回调」同一层）。搬出来**只有一个目的**：
   *   让失败重试能复用同一条链。
   *
   * ★ 搬移后职责更清楚：`onLoad` 只做「进页面时做一次」的事（`payToken`、配置加载），
   *   本方法只做「取商品」，`retryProduct()` 因此可以只重取商品而**不动 `payToken`**。
   *
   * @returns {Promise<unknown>} 商品请求的 promise（供重试与测试 await）。
   */
  loadProduct() {
    return request(`/api/products/${encodeURIComponent(this.productId)}`).then(({ data }) => {
      const sellableStock = Number(data.availableStock ?? (data.stock || 0));
      const rentalPlan = readRentalPlan(data);
      const isRental = Boolean(rentalPlan);
      // 租赁车顶部摘要沿用展示层映射：若直接渲染 `scooter.price`，会把买断参考价 3199
      // 当成「价格」展示，正是 T37 修掉的同类问题。
      const card = isRental ? toProductCard(data) : null;
      this.setData({
        isRental,
        rentalPlan,
        rentalUnitLabel: rentalPlan ? rentalUnitLabel(rentalPlan.unit) : '',
        rentalUnits: rentalPlan ? rentalPlan.minUnits : 1,
        quantity: isRental ? 1 : this.data.quantity,
        scooter: {
          ...data,
          price: Math.round((data.effectivePriceInCents ?? data.priceInCents) / 100),
          originalPrice: Math.round((data.promotion?.originalPriceInCents || 0) / 100),
          promoText: data.promotion?.statusText || '',
          priceText: card ? card.priceText : '',
          originalPriceText: card ? card.originalPriceText : '',
          subtitle: data.description,
          color: '#eaf0ff',
          icon: '车',
          sellableStock,
          stockNote: sellableStock > 0 ? '' : (isRental
            ? '该车型已租满或库存被待支付订单占用，暂不能提交订单。'
            : '该车型已售罄或库存被待支付订单占用，暂不能提交订单。')
        }
      });
      this.refreshMaxQuantity();
      // ★ T50：得到了答复 —— 从此才允许撤掉加载态。见 `data.productLoaded` 的注释。
      this.setData({ productError: '', productLoaded: true });
    }).catch((error) => {
      // ★ T50：改造前这里**只弹一个 toast**（`wx.showToast`），没有任何常驻状态 ——
      //   于是 `scooter` 永远是 `null`、整页永久空白，且**无法恢复**。
      //   现在落成**常驻错误占位 + 重试入口**，与 T49 对 `notifications.js:52` /
      //   `store.js` 的同一纪律：失败必须**可见 + 可重试**，不靠会消失的提示承载。
      const text = loadState.blockErrorText(error);
      this.setData({
        // ★ 只在**兜底文案**这一种情形下加主语：这一屏上「常用地址」块也会渲染同一句
        //   兜底文案（`loadAddresses`），两块都挂时用户会看到两句一模一样的
        //   「加载失败，请重试」，分不清哪一块挂了。服务端给了真实错误信息时原样透传，
        //   不替它编话。与 `plate.js` 的既有做法同源。
        productError: text === loadState.DEFAULT_ERROR_TEXT ? '商品加载失败，请重试' : text,
        // ★ 失败也算「得到了答复」：此后由 `productError` 决定说不说失败，
        //   不再需要 `productLoaded` 兜着「还没问过」这一种状态。
        productLoaded: true
      });
    });
  },
  /**
   * 重试商品加载。
   *
   * ★ 必须走 `loadProduct()`，**不得走 `onLoad()`**：`onLoad` 会重新生成
   *   `payToken`（提交路径上的东西），重试商品不该动它。用例「重试后 `payToken`
   *   逐字相同」就是钉住这一点的。
   *
   * @returns {Promise<unknown>} 同 `loadProduct()`。
   */
  retryProduct() {
    this.setData({ productError: '', productLoaded: false });
    return this.loadProduct();
  },
  /**
   * 重算「单笔最多可买几件」，并把已选数量夹到新上限内。
   *
   * ★ 必须由**产品请求**与**配置请求**两条回调**都**调用。
   * 两者是 `onLoad` 里并发发出的两条独立请求，谁先返回**不确定**：
   * - 商品先到、配置后到：`this.data.config` 还是 `null` → 先用兜底 5，配置到达后重算；
   * - 配置先到、商品后到：此时没有 `scooter`，本方法直接返回，等商品到达时配置已就位。
   * 两种顺序都会收敛到同一个 `maxQuantity`，不会出现「先到先得、后到不生效」。
   *
   * 上限算完之后顺带重算金额（`updateTotals` 依赖 `maxQuantity` 与 `config`）。
   */
  refreshMaxQuantity() {
    const scooter = this.data.scooter;
    // 商品还没到就没有可夹的库存，此时算上限没有意义 —— 等商品回调再算。
    if (!scooter) return;
    const sellableStock = Number(scooter.sellableStock || 0);
    const MAX_ORDER_QUANTITY_PER_ITEM = resolveMaxOrderQuantityPerItem(this.data.config);
    const maxQuantity = Math.max(1, Math.min(sellableStock, MAX_ORDER_QUANTITY_PER_ITEM));
    this.setData({
      maxQuantity,
      // 配置**后到**时可能把上限调低（默认 5 → 运营改成 2）。此时 `updateTotals`
      // 只是在**展示**上把数量截断，`this.data.quantity` 仍是用户先前选的旧值，
      // `submit()` 会把它原样发给服务端并被 400 拒绝。所以数量本身也要跟着降下来。
      quantity: this.data.isRental ? 1 : Math.max(1, Math.min(Number(this.data.quantity || 1), maxQuantity))
    });
    this.updateTotals();
  },
  /**
   * 加载常用地址。
   *
   * ★ 失败时**不清空** `addresses`，也不再让地址卡静默消失（T49）。
   *   改造前失败走 `setData({addresses:[]})`，`checkout.wxml:25` 判的是
   *   `addresses.length` —— 于是「常用地址」卡片整块不见，用户会以为
   *   **自己没有存过地址**，于是当场手输一遍（甚至以为地址丢了）。
   */
  loadAddresses() {
    return request('/api/my/addresses').then(({ data }) => {
      const addressList = Array.isArray(data) ? data : [];
      this.setData({ addresses: addressList, addressesError: '' });
      const selected = addressList.find((item) => item.isDefault) || addressList[0];
      if (selected) this.applyAddress(selected);
    }).catch((error) => this.setData({ addressesError: loadState.blockErrorText(error) }));
  },
  retryAddresses() { return this.loadAddresses(); },
  goAddresses() {
    wx.navigateTo({ url: '/pages/addresses/addresses' });
  },
  applyAddress(address) {
    if (!address) return;
    this.setData({
      selectedAddressId: address.id,
      name: address.contactName || '',
      phone: address.contactPhone || '',
      deliveryAddress: address.address || ''
    });
  },
  selectAddress(event) {
    const selected = this.data.addresses.find((item) => item.id === event.currentTarget.dataset.id);
    this.applyAddress(selected);
  },
  deleteAddress(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除常用地址',
      content: '删除后下次下单需要重新填写配送信息。',
      success: ({ confirm }) => {
        if (!confirm) return;
        request(`/api/my/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => {
          if (this.data.selectedAddressId === id) this.setData({ selectedAddressId: '' });
          this.loadAddresses();
          wx.showToast({ title: '地址已删除', icon: 'success' });
        }).catch((error) => wx.showToast({ title: error.message || '删除失败', icon: 'none' }));
      }
    });
  },
  updateTotals() {
    const scooter = this.data.scooter;
    if (!scooter) return;
    const deliveryFee = this.data.config ? this.data.config.deliveryFee : 0;
    // 租赁与售卖的费用口径完全分流：租赁走纯函数，售卖保持原逻辑一行不动。
    if (this.data.isRental) return this.updateRentalTotals();
    const unitPrice = Math.round((scooter.effectivePriceInCents ?? scooter.price ?? (scooter.priceInCents || 0)) / 100);
    const quantity = Math.max(1, Math.min(Number(this.data.quantity || 1), this.data.maxQuantity || 1));
    const itemsFee = unitPrice * quantity;
    this.setData({ itemsFee, deliveryFee, totalFee: itemsFee + deliveryFee });
  },
  /**
   * 租赁费用重算：租金合计 / 押金 / 配送费 / 应付合计。
   *
   * 口径与 `server/src/app.js` 建单逻辑逐字对齐（租金 + 押金 + 配送费），
   * 因此结算页展示的「应付合计」与支付单 `amountInCents` 必然一致。
   */
  updateRentalTotals() {
    const rentalFees = computeRentalFees({
      rentalPlan: this.data.rentalPlan,
      rentalUnits: this.data.rentalUnits,
      // 注意单位：这里用「分」（`deliveryFeeInCents`），售卖分支用的是「元」（`deliveryFee`）。
      deliveryFeeInCents: this.data.config ? this.data.config.deliveryFeeInCents : 0
    });
    if (!rentalFees) return;
    this.setData({
      rentalUnits: rentalFees.rentalUnits,
      rentalFees,
      rentalDue: computeRentalDueAt(rentalFees.rentalUnits, this.data.rentalPlan.unit, new Date())
    });
  },
  setQuantity(event) {
    const action = event.currentTarget.dataset.action;
    const maxQuantity = this.data.maxQuantity;
    const next = action === 'increase' ? this.data.quantity + 1 : this.data.quantity - 1;
    if (next < 1) return wx.showToast({ title: '至少购买 1 辆', icon: 'none' });
    // 提示里的 N 必须用**实际生效的**上限（`maxQuantity` 已由配置解析而来），
    // 不能写死：运营把上限改成 2 时，这里必须说 2。
    if (next > maxQuantity) return wx.showToast({ title: `本商品单笔最多可买 ${maxQuantity} 件（平台规则）`, icon: 'none' });
    this.setData({ quantity: next });
    this.updateTotals();
  },
  /**
   * 租赁租期步进。
   *
   * 越界时**不修改** `rentalUnits`（`stepRentalUnits` 返回 `accepted: false`），
   * 只提示上限/下限，保证展示的金额与实际提交的租期始终一致。
   */
  setRentalUnits(event) {
    const action = event.currentTarget.dataset.action;
    const result = stepRentalUnits({
      rentalPlan: this.data.rentalPlan,
      rentalUnits: this.data.rentalUnits,
      action
    });
    if (!result) return;
    if (!result.accepted) {
      if (result.message) wx.showToast({ title: result.message, icon: 'none' });
      return;
    }
    this.setData({ rentalUnits: result.rentalUnits });
    this.updateTotals();
  },
  setName(e) { this.setData({ name: e.detail.value, selectedAddressId: '' }); },
  setPhone(e) { this.setData({ phone: e.detail.value, selectedAddressId: '' }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setDeliveryTime(e) { this.setData({ deliveryTimeIndex: Number(e.detail.value) }); },
  setAddress(e) { this.setData({ deliveryAddress: e.detail.value, selectedAddressId: '' }); },
  setSaveAddress() { this.setData({ saveAddress: !this.data.saveAddress }); },
  saveNewAddress() {
    if (!this.data.saveAddress || this.data.selectedAddressId) return Promise.resolve();
    // 「保存常用地址」是动作、不是加载：下单已成功，失败只影响下次是否预填，
    // 不影响用户看到的任何内容，故显式忽略。
    return request('/api/my/addresses', {
      method: 'POST',
      data: {
        contactName: this.data.name,
        contactPhone: this.data.phone,
        address: this.data.deliveryAddress,
        campusName: this.data.config?.campusName || ''
      }
    }).then(() => this.setData({ saveAddress: false })).catch(loadState.ignoreSilently);
  },
  submit() {
    if (!this.data.agreed) return wx.showToast({ title: '请先阅读并同意协议', icon: 'none' });
    const { name, phone, date, deliveryAddress, scooter } = this.data;
    if (!name || !phone || !date || !deliveryAddress || !scooter || this.data.submitting) return wx.showToast({ title: '请填写完整信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    const quantity = this.data.quantity;
    if (quantity < 1 || quantity > Number(scooter.sellableStock || 0)) return wx.showToast({ title: '购买数量超出库存', icon: 'none' });
    // 租赁单必须带 `rentalUnits`，且服务端要求租赁项 `quantity` 恒为 1（一单一车）；
    // 售卖单的 payload 形状保持改造前完全一致：`{ productId, quantity }`。
    // 售卖数量由服务端按 `maxOrderQuantityPerItem` 复核，前端不再重复实现一遍上限。
    const orderItem = this.data.isRental
      ? { productId: scooter.id, quantity: 1, rentalUnits: this.data.rentalUnits }
      : { productId: scooter.id, quantity };
    wx.setStorageSync('shishanUserProfile',{...wx.getStorageSync('shishanUserProfile')||{},name,phone});
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', header: { 'Idempotency-Key': this.data.payToken }, data: { userId: userId(), items: [orderItem], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, timeSlot: this.data.deliveryTimeSlots[this.data.deliveryTimeIndex] || '', contactName: name, contactPhone: phone } } })
      .then(({ data, paymentOrder }) => {
        // ★ 走到这一行，订单**已经创建**（库存已预占，30 分钟未支付会自动关闭）。
        // 从这里往后的一切失败，性质都与「订单没创建」完全不同：必须明确告诉用户
        // 「订单已存在」，否则用户会以为什么都没发生，然后重复下单。
        const orderId = (data && data.id) || '';
        if (!paymentOrder || !paymentOrder.id) {
          return this.showPaymentPending(orderId, '支付单创建失败');
        }
        // 内层 catch 只挂在支付调用上 —— 它一旦触发，订单必然已经存在。
        // 这个结构本身就是「两种失败」的区分：外层 catch 只可能来自 POST /api/orders。
        return payPaymentOrder(paymentOrder)
          .then(({ data: result }) => this.showPaymentSuccess(result))
          .catch((error) => this.showPaymentPending(orderId, (error && error.message) || '支付未完成'));
      })
      .catch((error) => {
        // 只有 `POST /api/orders` 本身失败才会到这里 —— 订单**没有**创建，toast 是正确提示。
        this.setData({ submitting: false });
        wx.showToast({ title: (error && error.message) || '提交失败', icon: 'none' });
      });
  },
  /** 支付成功后的确认弹窗（文案区分租赁单与售卖单，与改造前逐字一致）。 */
  showPaymentSuccess(result) {
    return this.saveNewAddress().then(() => {
      wx.showModal({
        title: '支付成功',
        // 租赁单不能说「购车订单 / 购车牌照辅助」，否则用户会以为押金是消费。
        content: this.data.isRental
          ? `订单 ${result.order.orderNo} 已支付。押金将在归还核验后原路退回，不计入商家分账。`
          : `订单 ${result.order.orderNo} 已支付。平台购车订单会同步生成免费校园牌照辅助。`,
        confirmText: '查看订单',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/orders/orders' })
      });
    });
  },
  /**
   * 订单已创建但支付未完成。
   *
   * 与「订单根本没创建」是两种性质完全不同的失败：此时库存已预占、订单真实存在，
   * 只 toast 一句「提交失败」会让用户以为无事发生，进而重复下单。
   *
   * `submitting` 在这里就复位：弹窗是异步的，用户可能点「稍后再说」直接离开，
   * 不能把按钮一直锁在提交中。
   *
   * @param {string} orderId 已创建订单的 id（可能为空，此时无法定位）。
   * @param {string} reason 失败原因，用于向用户解释。
   */
  showPaymentPending(orderId, reason) {
    this.setData({ submitting: false });
    wx.showModal({
      title: '订单已创建，支付未完成',
      content: `${reason || '支付未完成'}。订单已经生成，30 分钟内未支付会自动关闭；可以到订单页继续支付。`,
      confirmText: '去支付',
      cancelText: '稍后再说',
      success: (result) => {
        if (!result || !result.confirm) return;
        // 订单页是 tabBar 页，不能带 query —— focusId 由 openLink 经 Storage 传递，
        // 订单页 onShow 读回并高亮，这里不重复实现一套跳转 + Storage 传递。
        openLink(orderId ? `/pages/orders/orders?focusId=${orderId}` : '/pages/orders/orders');
      }
    });
  },
  toggleAgreement() { this.setData({ agreed: !this.data.agreed }); },
  openAgreement() { wx.navigateTo({ url: '/pages/agreement/agreement?type=service' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/agreement/agreement?type=privacy' }); }
});
