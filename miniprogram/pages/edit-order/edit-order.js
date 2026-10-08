const { request } = require('../../services/api');
const loadState = require('../../utils/load-state');

Page({
  data: { orderId: '', orderNo: '', name: '', phone: '', date: '', timeSlot: '', address: '', deliveryTimeSlots: [], deliveryTimeIndex: 0, loading: true, submitting: false },
  onLoad(options) {
    const id = options.id || '';
    this.setData({ orderId: id, minDate: this.today() });
    request(`/api/orders/${encodeURIComponent(id)}`).then(({ data }) => {
      const fulfillment = data.fulfillment || {};
      const slots = this.data.deliveryTimeSlots.length ? this.data.deliveryTimeSlots : ['尽快配送'];
      const timeSlot = fulfillment.timeSlot || slots[0];
      this.setData({
        orderNo: data.orderNo || id,
        name: fulfillment.contactName || '',
        phone: fulfillment.contactPhone || '',
        date: fulfillment.date || this.today(),
        address: fulfillment.address || '',
        deliveryTimeSlots: slots,
        deliveryTimeIndex: Math.max(0, slots.indexOf(timeSlot)),
        loading: false
      });
    }).catch(() => {
      // ★ 这里**不补** `navigateBack` 的 `fail` 兜底（T51 勘察判定，T52 登记）。
      //
      // 前提：本页的唯一入口是 `orders.js` 的 `editOrder()`（`wx.navigateTo`），
      // 所以页面栈里**必定**还有上一页，`navigateBack` 必然成功。失败时先 toast
      // 「订单加载失败」再退回订单页，用户不会停在一个空表单上（`edit-order.wxml`
      // 的表单块是 `wx:if="{{!loading}}"`，失败时表单根本没渲染，停在加载文案）。
      //
      // ★ 若将来加了**分享 / 深链**入口（页面栈里可能没有上一页），这里就必须补
      //   `fail` 兜底 —— 否则 `navigateBack` 静默失败，用户会**卡在加载态**。
      wx.showToast({ title: '订单加载失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 500);
    });
    this.loadSlots();
  },
  loadSlots() {
    // 配置加载：失败时 `onLoad` 已用 ['尽快配送'] 兜底，配送时段列表非空，
    // 用户看到的内容仍然有效，故显式忽略。
    request('/api/business-config').then(({ data }) => {
      const slots = Array.isArray(data.deliveryTimeSlots) && data.deliveryTimeSlots.length ? data.deliveryTimeSlots : ['尽快配送'];
      const current = this.data.deliveryTimeSlots[this.data.deliveryTimeIndex];
      this.setData({
        deliveryTimeSlots: slots,
        deliveryTimeIndex: Math.max(0, slots.indexOf(current))
      });
    }).catch(loadState.ignoreSilently);
  },
  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setDate(e) { this.setData({ date: e.detail.value }); },
  setTimeSlot(e) {
    const deliveryTimeIndex = Number(e.detail.value);
    this.setData({
      deliveryTimeIndex,
      timeSlot: this.data.deliveryTimeSlots[deliveryTimeIndex] || ''
    });
  },
  setAddress(e) { this.setData({ address: e.detail.value }); },
  save() {
    const { name, phone, date, timeSlot, address } = this.data;
    if (!name || !phone || !date || !address || this.data.submitting) return wx.showToast({ title: '请填写完整配送信息', icon: 'none' });
    if (!/^1\d{10}$/.test(phone)) return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    this.setData({ submitting: true });
    request(`/api/orders/${encodeURIComponent(this.data.orderId)}`, {
      method: 'PATCH',
      data: { fulfillment: { type: 'DELIVERY', contactName: name, contactPhone: phone, date, timeSlot, address } }
    }).then(() => {
      wx.showToast({ title: '配送已改约' });
      setTimeout(() => wx.navigateBack(), 500);
    }).catch((error) => {
      this.setData({ submitting: false });
      // 订单已进入终态 / 钱已退过 → 服务端返回 ORDER_NOT_MODIFIABLE。
      // 这时留在本页没有意义：用户无论怎么改都会被拒，改一次拒一次。
      // 所以给一句明确的提示后直接退回订单页，而不是让他在这里反复试。
      if (error && error.code === 'ORDER_NOT_MODIFIABLE') {
        wx.showToast({ title: '当前订单状态不支持改约', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 500);
        return;
      }
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    });
  }
});
