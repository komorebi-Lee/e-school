const { request } = require('../../services/api');
const upload = require('../../utils/upload');
const publishDraft = require('../../utils/publish-draft');

const boardOptions = [
  { key: 'CAMPUS', label: '校园生活' },
  { key: 'SECONDHAND', label: '二手交流' },
  { key: 'LOST_FOUND', label: '失物招领' },
  { key: 'STUDY', label: '学习互助' },
  { key: 'RIDES', label: '拼车顺风' }
];

function uploadPostImage(file) {
  return upload.uploadImage(file, request).then((data) => data.url);
}

Page({
  data: {
    boardOptions,
    selectedBoard: boardOptions[0],
    title: '',
    content: '',
    images: [],
    // 是否恢复过草稿。用于在页面上说明「这些内容是哪来的」，
    // 否则用户会困惑「我没填过怎么有字」。
    draftRestored: false,
    // ★ 本实例的内容**已经发布成功**，因此不再是草稿。
    //
    // 为什么单靠 `clearDraft` 不够：成功路径的最后一步是
    // `setTimeout(() => wx.redirectTo(...), 600)`，而 `redirectTo` 会卸载本页 →
    // 触发 `onUnload` → `saveDraft()`，**那时 `data` 里还是刚发布的内容**。
    // 于是草稿被原样写回去，下次进页面会恢复出「已发布」的内容，
    // 用户以为上次没发成功而再发一次 —— 重复发布。
    // 而「空草稿不写入」那道守卫在这里帮不上忙：内容并不空。
    // 所以需要一个显式的「封版」标记，让落盘彻底停掉。
    published: false,
    submitting: false
  },

  /**
   * 进页面时尝试恢复上次未发布的草稿。
   *
   * 空草稿（或没有草稿）时**什么都不做** —— 既不改 data，也不显示提示。
   */
  onLoad() {
    const restored = publishDraft.readDraft(publishDraft.DRAFT_KEYS.FORUM, publishDraft.normalizeForumDraft);
    if (publishDraft.isEmptyForumDraft(restored)) return;
    // 板块存的是 key，恢复时要找回对应的 option 对象（找不到就保留默认值）。
    const board = this.data.boardOptions.find((option) => option.key === restored.board);
    this.setData({
      title: restored.title,
      content: restored.content,
      images: restored.images,
      selectedBoard: board || this.data.selectedBoard,
      draftRestored: true
    });
  },

  /**
   * 页面被遮挡（切后台 / 接电话 / 跳到别的页）时落盘。
   *
   * 与 `onUnload` **两处都存**：`onHide` 覆盖「被打断」，`onUnload` 覆盖
   * 「用户点了返回」。两者可能同时触发，重复写一次同样的内容是幂等的。
   */
  onHide() { this.saveDraft(); },

  /** 页面被销毁（返回上一页）时落盘。 */
  onUnload() { this.saveDraft(); },

  /**
   * 把当前表单落成草稿。
   *
   * ★ **已发布成功过就不再落盘**：成功路径的 `redirectTo` 会触发 `onUnload`，
   * 若继续落盘就会把刚发布的内容写回草稿（见 `data.published` 的说明）。
   *
   * ★ **空草稿不写入**：否则「进页面什么都没填就退出」会用一份空草稿
   * 覆盖掉上一次的有效草稿 —— 那是数据丢失，不是保守行为。
   */
  saveDraft() {
    if (this.data.published) return;
    const current = publishDraft.forumDraftOf(this.data);
    if (publishDraft.isEmptyForumDraft(current)) return;
    publishDraft.writeDraft(publishDraft.DRAFT_KEYS.FORUM, current);
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
      // ★ 先「封版」再清草稿。顺序不能反：`clearDraft` 之后紧跟的 `redirectTo`
      // 会触发 `onUnload → saveDraft()`，只有 `published` 已置位才能挡住它。
      this.setData({ published: true });
      // ★ 发布成功后**必须**清除草稿。否则下次进页面会把「已发布」的内容恢复出来，
      // 用户会以为上次没发成功而再发一次 —— 重复发布。
      publishDraft.clearDraft(publishDraft.DRAFT_KEYS.FORUM);
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/forum/post?id=${encodeURIComponent(data.id)}` }), 600);
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    });
  }
});
