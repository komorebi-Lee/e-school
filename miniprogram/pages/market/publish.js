const { request } = require('../../services/api');
const upload = require('../../utils/upload');

const categoryOptions = [
  { key: 'BOOK', label: '二手书' },
  { key: 'DAILY', label: '生活用品' },
  { key: 'ELECTRONICS', label: '数码' },
  { key: 'SPORTS', label: '运动装备' },
  { key: 'OTHER', label: '其他' }
];

const conditionOptions = [
  { key: 'LIKE_NEW', label: '九成新' },
  { key: 'GOOD', label: '七成新' },
  { key: 'USED', label: '有使用痕迹' }
];

// 联系方式的最小长度（去空白后）。与服务端 `POST /api/market/items` 的 `minLength: 5`
// 是同一个口径 —— 前端拦截只是为了「不白跑一趟网络」，服务端那道才是真正的防线。
const CONTACT_MIN_LENGTH = 5;

function uploadMarketImage(file) {
  return upload.uploadImage(file, request).then((data) => data.url);
}

Page({
  data: {
    title: '',
    description: '',
    contact: '',
    priceInput: '',
    categoryOptions,
    conditionOptions,
    selectedCategory: categoryOptions[0],
    selectedCondition: conditionOptions[0],
    images: [],
    // 控制联系方式输入框的聚焦。提交被本地拦下时置 true，把光标直接送到该输入框。
    contactFocus: false,
    submitting: false
  },

  setTitle(event) { this.setData({ title: event.detail.value }); },
  setDescription(event) { this.setData({ description: event.detail.value }); },
  setContact(event) { this.setData({ contact: event.detail.value }); },
  setPrice(event) { this.setData({ priceInput: event.detail.value }); },

  /**
   * 输入框失焦时复位聚焦标记。
   *
   * `focus` 是「置 true 时聚焦」的一次性指令：若不复位，用户第二次提交时
   * `setData({ contactFocus: true })` 因为值没变而不会触发聚焦 ——
   * 表现就是「第一次会跳过去，之后就再也不跳了」。
   */
  blurContact() { this.setData({ contactFocus: false }); },

  setCategory(event) {
    const selected = this.data.categoryOptions.find((option) => option.key === event.currentTarget.dataset.key);
    if (selected) this.setData({ selectedCategory: selected });
  },

  setCondition(event) {
    const selected = this.data.conditionOptions.find((option) => option.key === event.currentTarget.dataset.key);
    if (selected) this.setData({ selectedCondition: selected });
  },

  chooseImage() {
    if (this.data.images.length >= 6) return wx.showToast({ title: '图片数量已达上限', icon: 'none' });
    wx.chooseMedia({
      count: 6 - this.data.images.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        if (!tempFiles?.length) return;
        wx.showLoading({ title: '上传中', mask: true });
        Promise.all(tempFiles.map((file) => uploadMarketImage(file))).then((urls) => {
          wx.hideLoading();
          this.setData({ images: [...this.data.images, ...urls].slice(0, 6) });
        }).catch((error) => {
          wx.hideLoading();
          wx.showToast({ title: error.message || '图片上传失败', icon: 'none' });
        });
      }
    });
  },

  previewImages(event) {
    const current = event.currentTarget.dataset.url;
    if (!current) return;
    wx.previewImage({ current, urls: this.data.images });
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  submit() {
    const { title, description, contact, priceInput, selectedCategory, selectedCondition, images, submitting } = this.data;
    if (submitting) return;
    const price = Math.round(Number(priceInput) * 100);
    if (!title.trim()) return wx.showToast({ title: '请填写闲置标题', icon: 'none' });
    if (!description.trim()) return wx.showToast({ title: '请描述闲置情况', icon: 'none' });
    if (!Number.isFinite(price) || price <= 0) return wx.showToast({ title: '请填写正确的价格', icon: 'none' });
    // ★ 本地拦截：没有联系方式就不发请求。
    // 为什么要在本地拦而不是等服务端 400：服务端拒绝意味着用户已经等了一趟网络往返，
    // 而且错误只能以 toast 呈现、光标还停在别处。这里直接聚焦到该输入框，用户少走一步。
    if (contact.trim().length < CONTACT_MIN_LENGTH) {
      this.setData({ contactFocus: true });
      return wx.showToast({ title: '请填写联系方式（微信号或手机号）', icon: 'none' });
    }
    this.setData({ submitting: true });
    request('/api/market/items', {
      method: 'POST',
      data: {
        title: title.trim(),
        description: description.trim(),
        category: selectedCategory.key,
        condition: selectedCondition.key,
        priceInCents: price,
        images,
        contact: contact.trim()
      }
    }).then(({ data }) => {
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/market/item?id=${encodeURIComponent(data.id)}` }), 600);
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    });
  }
});
