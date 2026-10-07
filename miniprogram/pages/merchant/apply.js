const { request, userId } = require('../../services/api');
const upload = require('../../utils/upload');
const loadState = require('../../utils/load-state');

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
    licenseExpireDate: '',
    serviceArea: '',
    description: '',
    settlementAccountName: '',
    settlementBank: '',
    settlementAccount: '',
    licenseFile: null,
    agreeAgreement: false,
    agreePrivacy: false,
    application: null,
    // ★ 入驻申请加载失败的可见状态（T49）。非空即表示「当前展示的是失败态」。
    applicationError: '',
    resubmitNote: '',
    resubmitSubmitting: false,
    submitting: false
  },

  onShow() {
    this.loadApplication();
  },

  /**
   * 加载当前用户的入驻申请。
   *
   * ★ 失败时**不得**把 `application` 置空（T49）。
   *
   * 改造前失败路径是 `setData({ application: null })`，而
   * `apply.wxml` 的结构是：
   *   `:12 wx:if="{{application && status !== 'REJECTED'}}"`（审核中/已通过）
   *   `:33 wx:if="{{application && status === 'REJECTED'}}"`（被驳回 + 补充材料）
   *   `:75 wx:else`（**全新申请表单**）
   * `application` 一被置空，前两支都不成立，页面就落进 `wx:else` ——
   * **一个正在审核中、甚至已被驳回的商家会看到一张空白的入驻申请表**。
   * 后果有两个，都是用户可见的错误：
   *   1. 他会以为自己的申请没提交成功，于是**再提交一次**（重复申请）；
   *   2. 被驳回的商家看不到驳回原因，也看不到「补充资质材料」入口 ——
   *      即 M2 里那条「被驳回不能变成死单」的路径被这次网络抖动关掉了。
   *
   * 现在失败只写 `applicationError`，`application` 一律不动。
   *
   * ★ 顺带删掉了 `canForm`（T49 收尾）：它曾是本页的 data 字段，被 4 处 `setData`
   *   写过 `true` / `false`，但**没有任何读取方**（`grep -rn canForm miniprogram/`
   *   去掉本条注释后为 0 处，`test/` 与 `server/test/` 也各为 0 处）—— 一个只会
   *   让人误以为「它在控制什么」的死字段。表单该不该出现，实际由 `apply.wxml` 里
   *   `application` 的三个分支决定。
   *   之所以把「删过它」写在这里：将来有人想加回一个「能不能填表」的开关时，
   *   会先看到这条，知道开关在模板的分支里、不需要新的 data 字段。
   */
  loadApplication() {
    return request(`/api/merchants?userId=${encodeURIComponent(userId())}`).then(({ data }) => {
      const active = data.find((item) => item.status !== 'REJECTED');
      if (!active || active.status === 'REJECTED') {
        const rejected = data.find((item) => item.status === 'REJECTED');
        if (rejected) {
          this.setData({
            application: rejected,
            applicationError: '',
            licenseNo: rejected.licenseNo || '',
            licenseExpireDate: rejected.licenseExpireDate || '',
            settlementAccountName: rejected.settlementAccountName || '',
            settlementBank: rejected.settlementBank || '',
            settlementAccount: rejected.settlementAccount || '',
            licenseFile: null,
            resubmitNote: ''
          });
          return;
        }
        this.setData({ application: null, applicationError: '' });
        return;
      }
      if (active.status === 'APPROVED') {
        wx.redirectTo({ url: '/pages/merchant/index' });
        return;
      }
      this.setData({ application: active, applicationError: '' });
    }).catch((error) => this.setData({ applicationError: loadState.blockErrorText(error) }));
  },
  retryApplication() { return this.loadApplication(); },

  setField(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  setResubmitNote(event) {
    this.setData({ resubmitNote: event.detail.value });
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

  setLicenseExpireDate(event) {
    this.setData({ licenseExpireDate: event.detail.value });
  },

  chooseLicense() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (response) => {
        const file = response.tempFiles[0];
        if (!file) return;
        // `readDone` 用来区分「读图失败」与「上传失败」—— 改造前这两条路径分别弹
        // 「读取照片失败」和「upload failed」，合并成一个 catch 后必须保留这个区分，
        // 否则用户看到的提示会退化。
        let readDone = false;
        upload.readImagePayload(file, { readErrorMessage: '读取照片失败' })
          .then((payload) => {
            readDone = true;
            this.setData({ licenseFile: { name: '营业执照照片', uploading: true, progress: '正在上传…' } });
            return request('/api/uploads', { method: 'POST', data: payload });
          })
          .then((body) => {
            const { url, size } = body.data;
            this.setData({ licenseFile: { name: 'license', path: file.tempFilePath, url, size, uploading: false } });
          })
          .catch((error) => {
            this.setData({ licenseFile: null });
            wx.showToast({ title: readDone ? 'upload failed' : (error.message || '读取照片失败'), icon: 'none' });
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
    if (!this.data.settlementAccountName || !this.data.settlementBank || !/^\d{9,32}$/.test(this.data.settlementAccount.replace(/\s+/g, ''))) {
      return wx.showToast({ title: '请填写完整收款账户信息', icon: 'none' });
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
      if (!this.data.licenseExpireDate) {
        return wx.showToast({ title: '请选择营业执照有效期', icon: 'none' });
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
        licenseExpireDate: merchantType.value === 'PERSONAL' ? '' : this.data.licenseExpireDate,
        category: category.value,
        serviceArea: this.data.serviceArea,
        description: this.data.description,
        settlementAccountName: this.data.settlementAccountName,
        settlementBank: this.data.settlementBank,
        settlementAccount: this.data.settlementAccount,
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

  ,
  resubmitEvidence() {
    const application = this.data.application;
    if (!application || application.status !== 'REJECTED') return;
    if (application.merchantType !== 'PERSONAL' && !/^[0-9A-Z]{15,18}$/.test(this.data.licenseNo)) {
      return wx.showToast({ title: '请填写正确执照编号', icon: 'none' });
    }
    if (!this.data.licenseFile?.url) {
      return wx.showToast({ title: '请上传资质照片', icon: 'none' });
    }
    if (!this.data.licenseExpireDate) {
      return wx.showToast({ title: '请选择资质有效期', icon: 'none' });
    }
    if (!this.data.settlementAccountName || !this.data.settlementBank || !/^\d{9,32}$/.test(this.data.settlementAccount.replace(/\s+/g, ''))) {
      return wx.showToast({ title: '请补全收款账户', icon: 'none' });
    }
    if (this.data.resubmitSubmitting) return;
    this.setData({ resubmitSubmitting: true });
    request(`/api/merchants/${application.id}/resubmit`, {
      method: 'POST',
      data: {
        licenseNo: application.merchantType === 'PERSONAL' ? '' : this.data.licenseNo,
        licenseUrl: this.data.licenseFile.url,
        licenseExpireDate: this.data.licenseExpireDate,
        settlementAccountName: this.data.settlementAccountName,
        settlementBank: this.data.settlementBank,
        settlementAccount: this.data.settlementAccount,
        note: this.data.resubmitNote || '已补充平台要求材料'
      }
    }).then(() => wx.showModal({
      title: '复审申请已提交',
      content: '平台会继续核对补充材料，通过后即可进入工作台。',
      showCancel: false,
      success: () => this.loadApplication()
    })).catch((error) => wx.showToast({ title: error.message || '提交失败', icon: 'none' })).finally(() => this.setData({ resubmitSubmitting: false }));
  }
});
