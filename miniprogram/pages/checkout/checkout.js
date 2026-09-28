const { request, userId } = require('../../services/api');
const { loadBusinessConfig } = require('../../services/business');
const { payPaymentOrder } = require('../../services/payment');
const {
  readRentalPlan,
  rentalUnitLabel,
  toProductCard,
  computeRentalFees,
  computeRentalDueAt,
  stepRentalUnits
} = require('../../utils/product-view');

/**
 * 单笔最多购买数量上限（售卖商品）。
 *
 * ⚠️ 这里**暂时保留写死的 5**。PRD `M3-P1-02` 要求复用运营配置
 * `adminSettings.maxOrderQuantityPerItem`，但该配置**在服务端尚不存在**（属于 T21）。
 * 在它落地前不能凭空读取一个不存在的字段：`config.maxOrderQuantityPerItem` 会永远是
 * `undefined`，`Math.min(stock, undefined)` 得到 `NaN`，反而把上限静默压成 1。
 * 因此先抽成具名常量，待 T21 把配置下发到 `/api/business-config` 后，
 * 这里改为读取 `config.maxOrderQuantityPerItem` 即可（届时再补 `?? 5` 兜底）。
 */
const MAX_ORDER_QUANTITY_PER_ITEM = 5;

Page({
  data: { scooter: null, config: null, deliveryTimeSlots: [], deliveryTimeIndex: 0, name: '', phone: '', date: '', minDate: '', deliveryAddress: '', addresses: [], selectedAddressId: '', saveAddress: true, submitting: false, payToken: '', itemsFee: 0, deliveryFee: 0, totalFee: 0, agreed: false, quantity: 1, maxQuantity: 1, isRental: false, rentalPlan: null, rentalUnits: 1, rentalUnitLabel: '', rentalFees: null, rentalDue: null },
  onShow() {
    const now = new Date();
    const minDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const profile=wx.getStorageSync('shishanUserProfile')||{};
    this.setData({ minDate, name:profile.name||'', phone:profile.phone||'', date: this.data.date || minDate });
    this.loadAddresses();
  },
  onLoad(options) {
    const id = options.id || '';
    this.setData({ payToken: `ebike-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    request(`/api/products/${encodeURIComponent(id)}`).then(({ data }) => {
      const sellableStock = Number(data.availableStock ?? (data.stock || 0));
      const rentalPlan = readRentalPlan(data);
      const isRental = Boolean(rentalPlan);
      // 租赁车顶部摘要沿用展示层映射：若直接渲染 `scooter.price`，会把买断参考价 3199
      // 当成「价格」展示，正是 T37 修掉的同类问题。
      const card = isRental ? toProductCard(data) : null;
      this.setData({
        maxQuantity: Math.max(1, Math.min(sellableStock, MAX_ORDER_QUANTITY_PER_ITEM)),
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
      this.updateTotals();
    }).catch((error) => {
      wx.showToast({ title: error.message || '商品加载失败，请稍后重试', icon: 'none' });
    });
    loadBusinessConfig().then((config) => {
      this.setData({ config, deliveryTimeSlots: config.deliveryTimeSlots });
      this.updateTotals();
    });
  },
  loadAddresses() {
    request('/api/my/addresses').then(({ data }) => {
      const addressList = Array.isArray(data) ? data : [];
      this.setData({ addresses: addressList });
      const selected = addressList.find((item) => item.isDefault) || addressList[0];
      if (selected) this.applyAddress(selected);
    }).catch(() => this.setData({ addresses: [] }));
  },
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
    if (next > maxQuantity) return wx.showToast({ title: `最多可买 ${maxQuantity} 辆`, icon: 'none' });
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
    return request('/api/my/addresses', {
      method: 'POST',
      data: {
        contactName: this.data.name,
        contactPhone: this.data.phone,
        address: this.data.deliveryAddress,
        campusName: this.data.config?.campusName || ''
      }
    }).then(() => this.setData({ saveAddress: false })).catch(() => {});
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
    const orderItem = this.data.isRental
      ? { productId: scooter.id, quantity: 1, rentalUnits: this.data.rentalUnits }
      : { productId: scooter.id, quantity };
    wx.setStorageSync('shishanUserProfile',{...wx.getStorageSync('shishanUserProfile')||{},name,phone});
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', header: { 'Idempotency-Key': this.data.payToken }, data: { userId: userId(), items: [orderItem], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, timeSlot: this.data.deliveryTimeSlots[this.data.deliveryTimeIndex] || '', contactName: name, contactPhone: phone } } })
      .then(({ data, paymentOrder }) => {
        if (!paymentOrder || !paymentOrder.id) throw new Error('支付单创建失败');
        return payPaymentOrder(paymentOrder).then(({ data: result }) => {
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
        });
      })
      .catch((error) => { this.setData({ submitting: false }); wx.showToast({ title: error.message || '提交失败', icon: 'none' }); });
  },
  toggleAgreement() { this.setData({ agreed: !this.data.agreed }); },
  openAgreement() { wx.navigateTo({ url: '/pages/agreement/agreement?type=service' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/agreement/agreement?type=privacy' }); }
});
