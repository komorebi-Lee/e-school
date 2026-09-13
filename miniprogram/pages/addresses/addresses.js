const { request } = require('../../services/api');
const { loadBusinessConfig } = require('../../services/business');

Page({
  data: {
    addresses: [],
    loading: true,
    saving: false,
    form: {
      visible: false,
      id: '',
      contactName: '',
      contactPhone: '',
      address: '',
      campusName: '',
      isDefault: false
    }
  },

  onLoad() {
    loadBusinessConfig().then((config) => {
      this.setData({ 'form.campusName': config.campusName || '' });
    }).catch(() => {});
    this.loadAddresses();
  },

  loadAddresses() {
    request('/api/my/addresses').then(({ data }) => {
      this.setData({ addresses: data || [], loading: false });
    }).catch((error) => {
      this.setData({ addresses: [], loading: false });
      wx.showToast({ title: error.message || '地址加载失败', icon: 'none' });
    });
  },

  startCreate() {
    this.setData({
      form: {
        visible: true,
        id: '',
        contactName: '',
        contactPhone: '',
        address: '',
        campusName: this.data.form.campusName || '',
        isDefault: false
      }
    });
  },

  startEdit(event) {
    const item = this.data.addresses.find((address) => address.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      form: {
        visible: true,
        id: item.id,
        contactName: item.contactName || '',
        contactPhone: item.contactPhone || '',
        address: item.address || '',
        campusName: item.campusName || '',
        isDefault: Boolean(item.isDefault)
      }
    });
  },

  setField(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    this.setData({ [`form.${key}`]: event.detail.value });
  },

  saveAddress() {
    const { form } = this.data;
    const contactName = String(form.contactName || '').trim();
    const contactPhone = String(form.contactPhone || '').trim();
    const address = String(form.address || '').trim();
    const campusName = String(form.campusName || '').trim();
    if (!contactName || !contactPhone || !address) {
      wx.showToast({ title: '请填写完整地址信息', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(contactPhone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const payload = { contactName, contactPhone, address, campusName };
    const requestPromise = form.id
      ? request(`/api/my/addresses/${encodeURIComponent(form.id)}`, { method: 'PATCH', data: payload })
      : request('/api/my/addresses', { method: 'POST', data: payload });
    requestPromise.then(() => {
      this.setData({
        saving: false,
        form: { visible: false, id: '', contactName: '', contactPhone: '', address: '', campusName, isDefault: false }
      });
      wx.showToast({ title: form.id ? '地址已更新' : '地址已保存', icon: 'success' });
      this.loadAddresses();
    }).catch((error) => {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    });
  },

  setDefault(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    request(`/api/my/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', data: { isDefault: true } })
      .then(() => {
        wx.showToast({ title: '已设为默认', icon: 'success' });
        this.loadAddresses();
      }).catch((error) => wx.showToast({ title: error.message || '设置失败', icon: 'none' }));
  },

  deleteAddress(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '删除地址',
      content: '确定删除这个常用地址吗？',
      success: ({ confirm }) => {
        if (!confirm) return;
        request(`/api/my/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => {
          wx.showToast({ title: '地址已删除', icon: 'success' });
          this.loadAddresses();
        }).catch((error) => wx.showToast({ title: error.message || '删除失败', icon: 'none' }));
      }
    });
  }
});
