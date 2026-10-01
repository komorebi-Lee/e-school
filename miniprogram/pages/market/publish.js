const { request } = require('../../services/api');
const upload = require('../../utils/upload');
const publishDraft = require('../../utils/publish-draft');

// 字段上限直接取自共享模块，避免在这里再抄一遍数字而与服务端漂移。
const TITLE_LIMIT = publishDraft.FIELD_LIMITS.market.title;
const DESCRIPTION_LIMIT = publishDraft.FIELD_LIMITS.market.description;

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
    // 实时字数计数。口径与服务端 `requireString` 一致（UTF-16 码元数），
    // 所以「60/60」表示服务端一定会接受，而不是「看起来差不多」。
    titleCount: publishDraft.countText('', TITLE_LIMIT),
    descriptionCount: publishDraft.countText('', DESCRIPTION_LIMIT),
    // 价格非法时的原因文案；空串表示合法或尚未填写。
    // 非空时「发布闲置」按钮置灰 —— 不要只在提交时弹 toast。
    priceError: '',
    // 合法区间的展示文案。从共享模块取，避免在 wxml 里再抄一遍数字而与服务端漂移。
    // 带「元」：服务端的拒绝文案是「价格需要在 0.01 元到 10 万元之间」，
    // 前端若只显示「0.01 ~ 100000」，用户会把 100000 读成别的量纲。
    priceRangeText: `${publishDraft.PRICE_MIN_YUAN} ~ ${publishDraft.PRICE_MAX_YUAN} 元`,
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
    // 控制联系方式输入框的聚焦。提交被本地拦下时置 true，把光标直接送到该输入框。
    contactFocus: false,
    submitting: false
  },

  /**
   * 进页面时尝试恢复上次未发布的草稿。
   *
   * 空草稿（或没有草稿）时**什么都不做** —— 既不改 data，也不显示提示。
   */
  onLoad() {
    const restored = publishDraft.readDraft(publishDraft.DRAFT_KEYS.MARKET, publishDraft.normalizeMarketDraft);
    if (publishDraft.isEmptyMarketDraft(restored)) return;
    // 分类 / 成色存的是 key，恢复时要找回对应的 option 对象（找不到就保留默认值）。
    const category = this.data.categoryOptions.find((option) => option.key === restored.category);
    const condition = this.data.conditionOptions.find((option) => option.key === restored.condition);
    this.setData({
      title: restored.title,
      description: restored.description,
      contact: restored.contact,
      priceInput: restored.priceInput,
      images: restored.images,
      selectedCategory: category || this.data.selectedCategory,
      selectedCondition: condition || this.data.selectedCondition,
      titleCount: publishDraft.countText(restored.title, TITLE_LIMIT),
      descriptionCount: publishDraft.countText(restored.description, DESCRIPTION_LIMIT),
      priceError: publishDraft.priceErrorOf(restored.priceInput),
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
    const current = publishDraft.marketDraftOf(this.data);
    if (publishDraft.isEmptyMarketDraft(current)) return;
    publishDraft.writeDraft(publishDraft.DRAFT_KEYS.MARKET, current);
  },

  setTitle(event) {
    const title = event.detail.value;
    this.setData({ title, titleCount: publishDraft.countText(title, TITLE_LIMIT) });
  },

  setDescription(event) {
    const description = event.detail.value;
    this.setData({ description, descriptionCount: publishDraft.countText(description, DESCRIPTION_LIMIT) });
  },

  setContact(event) { this.setData({ contact: event.detail.value }); },

  /**
   * 价格输入：即时校验并展示原因。
   *
   * 校验逻辑放在 `utils/publish-draft.js` 的纯函数里，与服务端的
   * `priceInCents > 0 && <= 10000000` 同源，避免前端一套、后端一套。
   */
  setPrice(event) {
    const priceInput = event.detail.value;
    this.setData({ priceInput, priceError: publishDraft.priceErrorOf(priceInput) });
  },

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
    if (!title.trim()) return wx.showToast({ title: '请填写闲置标题', icon: 'none' });
    if (!description.trim()) return wx.showToast({ title: '请描述闲置情况', icon: 'none' });
    if (!priceInput.trim()) return wx.showToast({ title: '请填写正确的价格', icon: 'none' });
    // ★ 本地拦截越界价格。改造前这里只有 `price <= 0` 一道，
    // `100000.01` 会一路发到服务端再吃一个 400 —— 白跑一趟网络往返。
    // 判据与 `setPrice` 的内联提示、以及服务端的 `priceInCents <= 10000000`
    // 同源（都取自 utils/publish-draft.js），不会出现「界面说合法、服务端说越界」。
    const priceError = publishDraft.priceErrorOf(priceInput);
    if (priceError) return wx.showToast({ title: priceError, icon: 'none' });
    const price = publishDraft.priceInCentsOf(priceInput);
    // ★ 本地拦截：没有联系方式就不发请求。
    // 为什么要在本地拦而不是等服务端 400：服务端拒绝意味着用户已经等了一趟网络往返，
    // 而且错误只能以 toast 呈现、光标还停在别处。这里直接聚焦到该输入框，用户少走一步。
    // 下限取自共享模块（服务端 `minLength` 的唯一副本），所以服务端一旦上调，
    // 这里跟着一起动 —— 不会出现「前端放过去、服务端必然 400」。
    if (contact.trim().length < publishDraft.CONTACT_MIN_LENGTH) {
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
      // ★ 先「封版」再清草稿。顺序不能反：`clearDraft` 之后紧跟的 `redirectTo`
      // 会触发 `onUnload → saveDraft()`，只有 `published` 已置位才能挡住它。
      this.setData({ published: true });
      // ★ 发布成功后**必须**清除草稿。否则下次进页面会把「已发布」的内容恢复出来，
      // 用户会以为上次没发成功而再发一次 —— 重复发布。
      publishDraft.clearDraft(publishDraft.DRAFT_KEYS.MARKET);
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/market/item?id=${encodeURIComponent(data.id)}` }), 600);
    }).catch((error) => {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    });
  }
});
