const { request, userId } = require('../../services/api');

const categories = [
  { value: 'E_BIKE', label: '电动车/维修服务', extra: '如销售整车，请确认车辆来源与保修责任；如维修，请确认服务范围。' },
  { value: 'DIGITAL', label: '数码配件', extra: '如涉及品牌商品，请准备品牌授权或进货凭证。' },
  { value: 'FOOD', label: '食品生鲜', extra: '如涉及食品经营，请准备食品经营/备案资质。' },
  { value: 'LIFE_SERVICE', label: '生活服务', extra: '如涉及特许服务，请准备对应行业资质。' }
];

const merchantTypes = [
  { value: 'INDIVIDUAL', label: '个体工商户', licenseLabel: '个体工商户营业执照' },
  { value: 'ENTERPRISE', label: '企业/公司', licenseLabel: '企业营业执照' },
  { value: 'PERSONAL', label: '个人身份', licenseLabel: '个人身份证' }
];

const statusLabels = { REVIEWING: '审核中', APPROVED: '已通过', REJECTED: '未通过' };

Page({
  data: {
    categories,
    merchantTypes,
    statusLabels,
    merchantTypeIndex: 0,
    idNumber: '',
    identityVerification: null,
    verifyingIdentity: false,
    categoryIndex: -1,
    name: '',
    ownerName: '',
    phone: '',
    licenseNo: '',
    serviceArea: '',
    description: '',
    licenseFile: null,
    agreeAgreement: false,
    agreePrivacy: false,
    application: null,
    canForm: true,
    submitting: false
  },

  onShow() {
    this.loadApplication();
  },

  loadApplication() {
    request(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const active = data.find((item) => item.status !== 'REJECTED');
      if (!active || active.status === 'REJECTED') {
        this.setData({ application: null, canForm: true });
        return;
      }
      if (active.status === 'APPROVED') {
        wx.redirectTo({ url: '/pages/merchant/index' });
        return;
      }
      this.setData({ application: active, canForm: false });
    }).catch(() => this.setData({ application: null, canForm: true }));
  },

  setField(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  verifyIdentity() {
    const ownerName = this.data.ownerName;
    const idNumber = this.data.idNumber;
    if (ownerName.length < 2 || !/^\d{17}[\dXx]$/.test(idNumber)) {
      return wx.showToast({ title: '请输入真实姓名和身份证号', icon: 'none' });
    }
    if (this.data.verifyingIdentity) return;
    this.setData({ verifyingIdentity: true });
    request('/api/identity/verify', {
      method: 'POST',
      data: { userId: userId(), ownerName, idNumber }
    }).then((body) => {
      this.setData({ identityVerification: body.data });
      wx.showToast({ title: 'verified', icon: 'success' });
    }).catch((error) => {
      this.setData({ identityVerification: null });
      wx.showToast({ title: error.message || 'verify failed', icon: 'none' });
    }).finally(() => this.setData({ verifyingIdentity: false }));
  },

  selectMerchantType(event) {
    this.setData({
      merchantTypeIndex: Number(event.currentTarget.dataset.index),
      licenseFile: null
    });
  },

  setCategory(event) {
    this.setData({ categoryIndex: Number(event.detail.value) });
  },

  chooseLicense() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (response) => {
        const file = response.tempFiles[0];
        wx.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          encoding: 'base64',
          success: ({ data }) => {
            const extension = file.tempFilePath.split('.').pop().toLowerCase();
            const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
            this.setData({ licenseFile: { name: '营业执照照片', uploading: true, progress: '正在上传…' } });
            request('/api/uploads', {
              method: 'POST',
              data: { dataBase64: data, mimeType }
            }).then((body) => {
              const { url, size } = body.data;
              this.setData({ licenseFile: { name: 'license', path: file.tempFilePath, url, size, uploading: false } });
            }).catch(() => {
              this.setData({ licenseFile: null });
              wx.showToast({ title: 'upload failed', icon: 'none' });
            });
          },
          fail: () => wx.showToast({ title: '读取照片失败', icon: 'none' })
        });
      }
    });
  },

  setAgreement(event) {
    this.setData({ agreeAgreement: event.detail.value.length > 0 });
  },

  setPrivacy(event) {
    this.setData({ agreePrivacy: event.detail.value.length > 0 });
  },

  submit() {
    const merchantType = this.data.merchantTypes[this.data.merchantTypeIndex];
    const category = this.data.categories[this.data.categoryIndex];
    if (!merchantType || !category || this.data.name.length < 2 || this.data.ownerName.length < 2) {
      return wx.showToast({ title: '请完整填写店铺基础信息', icon: 'none' });
    }
    if (!/^1\d{10}$/.test(this.data.phone)) {
      return wx.showToast({ title: '请输入正确手机号', icon: 'none' });
    }
    if (!this.data.serviceArea || !this.data.description) {
      return wx.showToast({ title: '请填写服务区域和店铺简介', icon: 'none' });
    }
    if (merchantType.value === 'PERSONAL' && !this.data.identityVerification) {
      return wx.showToast({ title: '请先完成模拟实名验证', icon: 'none' });
    }
    if (merchantType.value !== 'PERSONAL') {
      if (!/^[0-9A-Z]{15,18}$/.test(this.data.licenseNo)) {
        return wx.showToast({ title: '请输入营业执照编号', icon: 'none' });
      }
      if (!this.data.licenseFile) {
        return wx.showToast({ title: '请上传营业执照照片', icon: 'none' });
      }
    }
    if (!this.data.agreeAgreement || !this.data.agreePrivacy) {
      return wx.showToast({ title: '请先同意协议和隐私指引', icon: 'none' });
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    request('/api/merchants', {
      method: 'POST',
      data: {
        userId: userId(),
        merchantType: merchantType.value,
        name: this.data.name,
        ownerName: this.data.ownerName,
        phone: this.data.phone,
        licenseNo: this.data.licenseNo,
        licenseUrl: merchantType.value === 'PERSONAL' ? '' : (this.data.licenseFile?.url || ''),
        category: category.value,
        serviceArea: this.data.serviceArea,
        description: this.data.description,
        identityVerificationToken: merchantType.value === 'PERSONAL' ? this.data.identityVerification.token : '',
        agreeAgreement: this.data.agreeAgreement,
        agreePrivacy: this.data.agreePrivacy
      }
    }).then((response) => {
      const message = response.idempotent ? '您已有入驻申请，请等待平台审核。' : '平台审核通过后即可登录商家工作台。';
      wx.showModal({
        title: response.idempotent ? '申请已存在' : '申请已提交',
        content: message,
        showCancel: false,
        success: () => this.loadApplication()
      });
    }).catch((error) => {
      wx.showToast({ title: error.message || '提交失败，请稍后重试', icon: 'none' });
    }).finally(() => this.setData({ submitting: false }));
  }
});
