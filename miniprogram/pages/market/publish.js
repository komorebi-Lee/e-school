const { request } = require('../../services/api');

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

function uploadMarketImage(file) {
  const extension = file.tempFilePath.split('.').pop().toLowerCase();
  const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: 'base64',
      success: ({ data }) => resolve(data),
      fail: () => reject(new Error('图片读取失败'))
    });
  }).then((dataBase64) => request('/api/uploads', {
    method: 'POST',
    data: { dataBase64, mimeType }
  }).then(({ data }) => data.url));
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
    submitting: false
  },

  setTitle(event) { this.setData({ title: event.detail.value }); },
  setDescription(event) { this.setData({ description: event.detail.value }); },
  setContact(event) { this.setData({ contact: event.detail.value }); },
  setPrice(event) { this.setData({ priceInput: event.detail.value }); },

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
