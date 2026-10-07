const { request, userId } = require('../../services/api');
const { FALLBACK_SERVICE_CONTACT, loadBusinessConfig } = require('../../services/business');
const loadState = require('../../utils/load-state');

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
  // ★ `contact` 的初值是**空串**，不是硬编码号码：`data` 在页面创建时即渲染，
  //   而配置是异步回来的。若写死号码，管理员改号后用户会先看到**已过期**的号。
  //   `consult.wxml` 的提示行对本字段做了 `wx:if`，未取到配置时不展示。
  data: { type: '电动车', interest: '', sourceType: '', sourceId: '', sourceNo: '', name: '', phone: '', time: '', note: '', submitting: false, responseHours: 24, contact: '' },
  onLoad(options) {
    // 配置加载：`loadBusinessConfig` 内部已用缓存/默认值兜底、永不 reject，
    // 失败也不影响可见内容（响应时长回落到默认值，联系电话保持空值、不展示），故显式忽略。
    loadBusinessConfig().then((config) => {
      this.setData({
        responseHours: Number(config.leadResponseHours || 24),
        contact: config.servicePhone || config.serviceWechat || ''
      });
    }).catch(loadState.ignoreSilently);
    this.setData({
      type: decodeParam(options.type, '电动车'),
      interest: decodeParam(options.interest),
      sourceType: decodeParam(options.sourceType),
      sourceId: decodeParam(options.sourceId),
      sourceNo: decodeParam(options.sourceNo)
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
        userId: userId(), name: name.trim(), phone: phone.trim(),
        businessType: this.data.type, interest: this.data.interest || '',
        sourceType: this.data.sourceType, sourceId: this.data.sourceId,
        expectedTime: this.data.time, deliveryNeed: this.data.type === 'E_BIKE' ? 'delivery' : '', note: this.data.note
      }
    }).then(() => {
      wx.showToast({ title: '已提交咨询' });
      setTimeout(() => wx.navigateBack(), 600);
    }).catch(() => {
      wx.showModal({ title: '提交失败', content: `可直接联系客服：${this.data.contact || FALLBACK_SERVICE_CONTACT}`, showCancel: false });
    }).finally(() => this.setData({ submitting: false }));
  }
});
