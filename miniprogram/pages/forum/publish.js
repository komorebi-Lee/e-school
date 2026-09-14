const { request } = require('../../services/api');

const boardOptions = [
  { key: 'CAMPUS', label: '校园生活' },
  { key: 'SECONDHAND', label: '二手交流' },
  { key: 'LOST_FOUND', label: '失物招领' },
  { key: 'STUDY', label: '学习互助' },
  { key: 'RIDES', label: '拼车顺风' }
];

function uploadPostImage(file) {
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
    boardOptions,
    selectedBoard: boardOptions[0],
    title: '',
    content: '',
    images: [],
    submitting: false
  },

  setBoard(event) {
    const selected = this.data.boardOptions.find((option) => option.key === event.currentTarget.dataset.key);
    if (selected) this.setData({ selectedBoard: selected });
  },

  setTitle(event) { this.setData({ title: event.detail.value }); },
  setContent(event) { this.setData({ content: event.detail.value }); },

  chooseImage() {
    if (this.data.images.length >= 3) return wx.showToast({ title: '图片数量已达上限', icon: 'none' });
    wx.chooseMedia({
      count: 3 - this.data.images.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        if (!tempFiles?.length) return;
        wx.showLoading({ title: '上传中', mask: true });
        Promise.all(tempFiles.map((file) => uploadPostImage(file))).then((urls) => {
          wx.hideLoading();
          this.setData({ images: [...this.data.images, ...urls].slice(0, 3) });
        }).catch((error) => {
          wx.hideLoading();
          wx.showToast({ title: error.message || '图片上传失败', icon: 'none' });
        });
      }
    });
  },

  removeImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const images = [...this.data.images];
    images.splice(index, 1);
    this.setData({ images });
  },

  submit() {
    const { title, content, selectedBoard, images, submitting } = this.data;
    if (submitting) return;
    if (!title.trim()) return wx.showToast({ title: '请填写帖子标题', icon: 'none' });
    if (!content.trim()) return wx.showToast({ title: '请填写帖子内容', icon: 'none' });
    this.setData({ submitting: true });
    request('/api/forum/posts', {
      method: 'POST',
      data: {
        title: title.trim(),
        content: content.trim(),
        board: selectedBoard.key,
        images
      }
    }).then(({ data }) => {
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/forum/post?id=${encodeURIComponent(data.id)}` }), 600);
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    });
  }
});
