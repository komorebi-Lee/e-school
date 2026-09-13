const { request, userId } = require('../../services/api');
const { loadBusinessConfig } = require('../../services/business');
const { payPaymentOrder } = require('../../services/payment');

Page({
  data: { scooter: null, config: null, deliveryTimeSlots: [], deliveryTimeIndex: 0, name: '', phone: '', date: '', minDate: '', deliveryAddress: '', addresses: [], selectedAddressId: '', saveAddress: true, submitting: false, payToken: '', itemsFee: 0, deliveryFee: 0, totalFee: 0, agreed: false, quantity: 1, maxQuantity: 1 },
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
      this.setData({ maxQuantity: Math.max(1, Math.min(sellableStock, 5)), scooter: {
        ...data,
        price: Math.round((data.effectivePriceInCents ?? data.priceInCents) / 100),
        originalPrice: Math.round((data.promotion?.originalPriceInCents || 0) / 100),
        promoText: data.promotion?.statusText || '',
        subtitle: data.description,
        color: '#eaf0ff',
        icon: '车',
        sellableStock,
        stockNote: sellableStock > 0 ? '' : '该车型已售罄或库存被待支付订单占用，暂不能提交订单。'
      } });
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
    const unitPrice = Math.round((scooter.effectivePriceInCents ?? scooter.price ?? (scooter.priceInCents || 0)) / 100);
    const quantity = Math.max(1, Math.min(Number(this.data.quantity || 1), this.data.maxQuantity || 1));
    const itemsFee = unitPrice * quantity;
    this.setData({ itemsFee, deliveryFee, totalFee: itemsFee + deliveryFee });
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
    wx.setStorageSync('shishanUserProfile',{...wx.getStorageSync('shishanUserProfile')||{},name,phone});
    this.setData({ submitting: true });
    request('/api/orders', { method: 'POST', header: { 'Idempotency-Key': this.data.payToken }, data: { userId: userId(), items: [{ productId: scooter.id, quantity }], fulfillment: { type: 'DELIVERY', address: deliveryAddress, date, timeSlot: this.data.deliveryTimeSlots[this.data.deliveryTimeIndex] || '', contactName: name, contactPhone: phone } } })
      .then(({ data, paymentOrder }) => {
        if (!paymentOrder || !paymentOrder.id) throw new Error('支付单创建失败');
        return payPaymentOrder(paymentOrder).then(({ data: result }) => {
          return this.saveNewAddress().then(() => {
            wx.showModal({
              title: '支付成功',
              content: `订单 ${result.order.orderNo} 已支付。平台购车订单会同步生成免费校园牌照辅助。`,
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
