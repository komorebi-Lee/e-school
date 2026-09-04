const { request } = require('../../services/api');

function decodeParam(value, fallback = '') {
  if (!value) return fallback;
  let decoded = String(value);
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch (e) { break; }
  }
  return decoded;
}

Page({
  data: { type: '电动车', interest: '', name: '', phone: '', time: '', note: '', submitting: false },
  onLoad(options) {
    this.setData({
      type: decodeParam(options.type, '电动车'),
      interest: decodeParam(options.interest)
    });
  },
  setName(e) { this.setData({ name: e.detail.value }); },
  setPhone(e) { this.setData({ phone: e.detail.value }); },
  setTime(e) { this.setData({ time: e.detail.value }); },
  setNote(e) { this.setData({ note: e.detail.value }); },
  submit() {
    const { name, phone } = this.data;
    if (!name.trim() || !phone.trim()) return wx.showToast({ title: '请填写姓名和手机号', icon: 'none' });
    if (!/^1\d{10}$/.test(phone.trim())) return wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    request('/api/leads', {
      method: 'POST',
      data: {
        userId: 'miniapp_guest', name: name.trim(), phone: phone.trim(),
        businessType: this.data.type, interest: this.data.interest || '',
        expectedTime: this.data.time, deliveryNeed: this.data.type === 'E_BIKE' ? 'delivery' : '', note: this.data.note
      }
    }).then(() => {
      wx.showToast({ title: 'submitted' });
      setTimeout(() => wx.navigateBack(), 600);
    }).catch(() => {
      wx.showModal({ title: 'offline', content: 'contact 15527111396', showCancel: false });
    }).finally(() => this.setData({ submitting: false }));
  }
});
