const { request } = require('../../services/api');
const { openLink } = require('../../utils/navigation');
const loadState = require('../../utils/load-state');

/**
 * 对**公众**可见的状态 —— 与 server 的 `MARKET_ITEM_PUBLIC_STATUSES` 一一对应。
 *
 * 只有这几种状态能进详情页：服务端对 `DELETED`（卖家软删除）与 `REMOVED`
 * （平台违规下架）的详情返回 404，点进去只会看到一句「商品不存在或已下架」。
 */
const VIEWABLE_STATUSES = ['ACTIVE', 'RESERVED', 'SOLD'];

/** 状态 → 角标样式类（与 mine.wxss 里的 `.status-*` 对应）。 */
const STATUS_CLASSES = {
  ACTIVE: 'status-active',
  RESERVED: 'status-reserved',
  SOLD: 'status-sold',
  DELETED: 'status-deleted',
  REMOVED: 'status-removed'
};

/**
 * 不可删除时的说明文案。
 *
 * 为什么要写出来：用户看到「已出」的闲置旁边没有删除按钮，如果没有一句话，
 * 他会以为页面坏了或者按钮被吞了。写明原因（而且与服务端的拒绝理由一致）
 * 才是完整的交互。
 *
 * @param {string} status 闲置状态。
 * @returns {string} 说明文案；`ACTIVE` 返回空串（此时有删除按钮）。
 */
function lockedTextFor(status) {
  if (status === 'RESERVED' || status === 'SOLD') return '已产生交易记录，无法删除';
  if (status === 'DELETED') return '已删除，仅你自己可见';
  if (status === 'REMOVED') return '已被平台下架，如需申诉请联系客服';
  return '';
}

/**
 * 把服务端返回的闲置映射成列表要用的形状。
 *
 * @param {object} item 服务端返回的闲置。
 * @returns {object} 列表项。
 */
function decorateItem(item) {
  const source = item || {};
  const status = source.status || 'ACTIVE';
  return {
    id: source.id,
    title: source.title,
    description: source.description || '',
    categoryText: source.categoryText || '其他',
    conditionText: source.conditionText || '七成新',
    priceText: source.priceText || `¥${Number(source.price || 0).toFixed(2)}`,
    status,
    statusText: source.statusText || '在售',
    statusClass: STATUS_CLASSES[status] || 'status-active',
    cover: Array.isArray(source.images) && source.images.length ? source.images[0] : '',
    timeText: String(source.createdAt || '').slice(5, 16).replace('T', ' '),
    // 详情在服务端对 DELETED / REMOVED 返回 404，这两类不能点进去。
    viewable: VIEWABLE_STATUSES.indexOf(status) !== -1,
    // ★ 只有「在售」才给删除按钮。
    //
    // 已预留 / 已出会被服务端以 `409 MARKET_ITEM_HAS_TRADE` 拒绝，给一个点了
    // 必然失败的按钮是在骗用户；已删除 / 已下架则本就无意义。
    // 与 T23「售罄套餐不给提交按钮」同一判断：**能确定会被拒的，就不要让用户白跑一趟**。
    // 服务端的 409 分支仍然保留（见 `confirmDelete`）—— 页面加载后买家才把商品
    // 预留走，是真实存在的竞态，本地判断挡不住它。
    deletable: status === 'ACTIVE',
    lockedText: lockedTextFor(status)
  };
}

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 「我发布的闲置」最怕的是**失败被说成空**：接口挂掉时显示「你还没有发布过闲置」，
  // 那是在向用户断言一个假事实 —— 他会以为自己发的东西被删了。
  // 所以失败必须自己成为一种可见状态（常驻占位 + 重试），而不是一闪而过的 toast。
  data: {
    itemsBlock: loadState.initialListBlock(),
    // 正在删除的闲置 id，用于禁用按钮防重复提交。
    deletingId: ''
  },

  onShow() {
    this.loadMine();
  },

  /**
   * 加载「我发布的闲置」（**含已售 / 已删除 / 已下架**）。
   *
   * 走既有的 `GET /api/my/market-items`（未登录 401），**不按状态过滤** ——
   * 这一页的价值恰恰在于能看到那些已经不在市集里的条目。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  loadMine() {
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: 'itemsBlock',
      prev: this.data.itemsBlock,
      loader: () => request('/api/my/market-items').then(({ data }) => (data || []).map(decorateItem))
    });
  },

  /** 重新加载：我发布的闲置。 */
  retryItems() {
    return this.loadMine();
  },

  /**
   * 打开闲置详情。
   *
   * 已删除 / 已下架的条目在服务端是 404，不能点进去 —— 否则用户点一下
   * 只会看到一句「商品不存在」，还以为是网络问题。
   *
   * @param {object} event 点击事件（`data-id`）。
   * @returns {void}
   */
  goItem(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const items = this.data.itemsBlock.data || [];
    const item = items.find((entry) => entry.id === id);
    if (item && !item.viewable) {
      wx.showToast({ title: `${item.statusText}的闲置无法查看详情`, icon: 'none' });
      return;
    }
    openLink(`/pages/market/item?id=${encodeURIComponent(id)}`);
  },

  /** 去发布新闲置。 */
  goPublish() {
    openLink('/pages/market/publish');
  },

  /**
   * 请求删除自己的闲置（先弹确认框）。
   *
   * 软删除是不可逆的（删除后详情 404，页面上也不再提供恢复入口），
   * 所以必须让用户确认一次，避免误触。
   *
   * @param {object} event 点击事件（`data-id`）。
   * @returns {void}
   */
  deleteItem(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.deletingId) return;
    const items = this.data.itemsBlock.data || [];
    const item = items.find((entry) => entry.id === id);
    // 按钮本来就不该出现（模板用 `wx:if="{{item.deletable}}"`），这里只是防御。
    //
    // 注意 `item` 取不到时**放行**（不是 return）：`deleteItem` 只可能从那个按钮
    // 进来，按钮只对 `deletable` 的条目渲染 —— 取不到说明列表已经刷新过、
    // 事件来自旧的一帧。此时该不该拒绝由**服务端**判定（它会独立校验卖家归属
    // 与交易记录），前端凭一份可能过期的列表把它拦下来反而会漏判。
    if (item && !item.deletable) return;
    wx.showModal({
      title: '删除闲置',
      content: '删除后这条闲置会从市集移除。已产生交易记录的闲置无法删除。',
      confirmText: '删除',
      success: (result) => {
        if (!result || !result.confirm) return;
        this.confirmDelete(id);
      }
    });
  },

  /**
   * 真正发出删除请求（置 `DELETED`）。
   *
   * @param {string} id 闲置 id。
   * @returns {Promise<void>} 请求结束后解析。
   */
  confirmDelete(id) {
    this.setData({ deletingId: id });
    return request(`/api/market/items/${encodeURIComponent(id)}`, {
      method: 'POST',
      data: { status: 'DELETED' }
    }).then(() => {
      this.setData({ deletingId: '' });
      wx.showToast({ title: '已删除', icon: 'success' });
      // 重新拉取而不是本地把 status 改成 DELETED：服务端还会更新 `updatedAt` 并写审计，
      // 本地改会让页面与库里的实际状态漂移。
      this.loadMine();
    }).catch((error) => {
      this.setData({ deletingId: '' });
      const code = error && error.code;
      // ★ 409 必须说清**为什么**删不掉。
      //
      // 页面加载时这条闲置还是在售的，点「删除」的这一刻买家把它预留 / 拍下了 ——
      // 这是真实存在的竞态，不是异常。只显示通用「操作失败」的话，用户只会反复
      // 重试，而重试永远不会成功。文案直接采用服务端返回的原因。
      if (code === 'MARKET_ITEM_HAS_TRADE') {
        wx.showToast({ title: (error && error.message) || '该闲置已产生交易记录，无法删除', icon: 'none' });
        // 顺带刷新：让状态角标追上真实状态，用户就能看到它其实已经「已出」。
        this.loadMine();
        return;
      }
      wx.showToast({ title: (error && error.message) || '删除失败，请重试', icon: 'none' });
    });
  }
});
