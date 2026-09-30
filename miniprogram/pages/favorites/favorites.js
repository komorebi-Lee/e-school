const { request } = require('../../services/api');
const loadState = require('../../utils/load-state');

function decorateFavorite(product) {
  const stock = Number(product.availableStock ?? (product.stock || 0));
  return {
    id: product.id,
    name: product.name,
    description: product.description || '',
    imageUrl: product.imageUrl || '',
    icon: product.icon || '车',
    color: product.color || '#eaf0ff',
    price: ((Number(product.effectivePriceInCents ?? (product.priceInCents || 0))) / 100).toFixed(2),
    originalPrice: product.promotion?.originalPriceInCents
      ? (Number(product.promotion.originalPriceInCents) / 100).toFixed(2) : '',
    promoText: product.promotion?.statusText || '',
    merchantName: product.merchantName || '平台自营',
    stockText: stock > 0 ? (stock < 5 ? `仅剩 ${stock} 件` : `库存 ${stock}`) : '已售罄',
    salesText: Number(product.salesCount || 0) > 0 ? `已售 ${product.salesCount}` : '新品上架',
    ratingText: product.ratingSummary?.count ? Number(product.ratingSummary.average || 0).toFixed(1) : '新',
    sellableStock: stock
  };
}

Page({
  // ★ 三态块（加载中 / 失败 / 无数据）。
  // 改造前失败时是「半对」：有 toast（错误可见了），但**仍然 `favorites: []`** ——
  // 清空数据等于告诉用户「你没有收藏」，而事实是「我们没取到」。
  //
  // 为什么把 toast 换成常驻占位：toast 一两秒就消失，用户视线一挪开就再也
  // 不知道列表是陈旧的，而且没有重试入口。占位会一直在，且带重试按钮。
  // （`removeFavorite` 里的 toast 是**动作**失败，不是加载失败，保持不动。）
  data: { favoritesBlock: loadState.initialListBlock(), saleCount: 0 },
  onShow() { this.loadFavorites(); },
  /**
   * 加载收藏列表。
   *
   * 失败时 `loadBlock` 只写 `error` 文案，**上一次的列表原样保留**。
   *
   * @returns {Promise<void>} 加载（或失败）完成后解析。
   */
  loadFavorites() {
    const removeFavorite = (productId) => {
      request(`/api/products/${encodeURIComponent(productId)}/favorite`, { method: 'POST', data: { favorited: false } })
        .then(() => {
          wx.showToast({ title: '已取消收藏', icon: 'success' });
          this.loadFavorites();
        })
        .catch((error) => wx.showToast({ title: error.message || '操作失败', icon: 'none' }));
    };
    this.removeFavorite = removeFavorite;
    return loadState.loadBlock({
      setData: (patch) => this.setData(patch),
      stateKey: 'favoritesBlock',
      prev: this.data.favoritesBlock,
      loader: () => request('/api/my/favorites').then(({ data }) => {
        const favorites = (data || []).map(decorateFavorite);
        // 促销件数是派生展示值，不属于本块数据，单独写入。
        this.setData({ saleCount: favorites.filter((item) => item.promoText).length });
        return favorites;
      })
    });
  },
  /** 重新加载：收藏列表。 */
  retryFavorites() {
    return this.loadFavorites();
  },
  goDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  }
  ,
  cancelFavorite(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || !this.removeFavorite) return;
    wx.showModal({
      title: '取消收藏',
      content: '确定不再关注这件商品吗？',
      success: ({ confirm }) => { if (confirm) this.removeFavorite(id); }
    });
  }
});
