const { request } = require('../../services/api');

function decorateFavorite(product) {
  const stock = Number(product.availableStock ?? product.stock || 0);
  return {
    id: product.id,
    name: product.name,
    description: product.description || '',
    imageUrl: product.imageUrl || '',
    icon: product.icon || '车',
    color: product.color || '#eaf0ff',
    price: ((Number(product.effectivePriceInCents ?? product.priceInCents || 0)) / 100).toFixed(2),
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
  data: { favorites: [], loading: true, saleCount: 0 },
  onShow() { this.loadFavorites(); },
  loadFavorites() {
    request('/api/my/favorites').then(({ data }) => {
      const favorites = (data || []).map(decorateFavorite);
      this.setData({ favorites, saleCount: favorites.filter((item) => item.promoText).length, loading: false });
    }).catch((error) => {
      this.setData({ favorites: [], loading: false });
      wx.showToast({ title: error.message || '收藏加载失败', icon: 'none' });
    });
  },
  goDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` });
  }
});
