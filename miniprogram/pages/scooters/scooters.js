const { request } = require('../../services/api');
const { getScooters } = require('../../services/store');
const { toProductCard } = require('../../utils/product-view');

function normalizeProduct(item) {
  // 可售库存已扣除待支付订单占用，避免展示“有货”却下不了单。
  const sellableStock = Number(item.availableStock !== undefined ? item.availableStock : item.stock || 0);
  const promotion = item.promotion || null;
  // 形态（售卖 / 租赁）、价格、押金、租期与销量文案统一由 utils/product-view.js 产出。
  // 该模块是纯函数、不依赖 Page()，因此能被 test/miniapp-runtime.test.js 真实加载并断言；
  // 写在本文件里则永远只有源码文本断言，租赁文案回归不会被发现。
  const card = toProductCard(item);
  return {
    ...item,
    ...card,
    originalPrice: promotion?.originalPriceInCents ? Math.round(Number(promotion.originalPriceInCents) / 100) : 0,
    promoText: promotion?.statusText || '',
    subtitle: item.description || '支持校内配送和校园牌照辅助。',
    speed: item.speed || '25 km/h',
    icon: item.icon || '车',
    color: item.color || '#eaf0ff',
    ratingText: item.ratingSummary?.count ? item.ratingSummary.average.toFixed(1) : '',
    ratingCountText: item.ratingSummary?.count ? `${item.ratingSummary.count}条已购评价` : '暂无已购评价',
    scoreText: item.merchantScore?.score ? `${item.merchantScore.score}分` : '新店',
    scoreTone: item.merchantScore?.stage === 'NORMAL'
      ? 'good'
      : item.merchantScore?.stage === 'LIMITED'
        ? 'watch'
        : item.merchantScore ? 'risk' : 'new',
    // 销量文案由 toProductCard 统一产出（租赁车为「N 辆在租」），此处显式透出便于阅读与调试。
    salesText: card.salesText,
    sellableStock,
    urgent: sellableStock > 0 && sellableStock < 5,
    stockText: sellableStock > 0 ? (sellableStock < 5 ? `仅剩 ${sellableStock} 件` : `库存 ${sellableStock}`) : '已售罄'
  };
}

Page({
  data: { scooters: [], filtered: [], hotProducts: [], query: '', sortKey: 'recommend', sortOptions: [
    { key: 'recommend', label: '综合推荐' },
    { key: 'rating', label: '评分优先' },
    { key: 'sales', label: '销量优先' },
    { key: 'price', label: '价格优先' },
    { key: 'range', label: '续航优先' },
    { key: 'stock', label: '库存优先' }
  ], loading: true },
  onLoad(options = {}) {
    const query = decodeURIComponent(options.query || '');
    if (query) this.setData({ query });
    this.loadProducts();
  },
  loadProducts() {
    request('/api/products?category=E_BIKE_NEW').then(({ data }) => {
      const scooters = (data || []).map(normalizeProduct);
      this.setData({ scooters, filtered: this.filterProducts(scooters, this.data.query, this.data.sortKey), loading: false });
      this.refreshHotProducts(scooters);
    }).catch((error) => {
      console.error('云端商品加载失败:', error);
      const cached = (getScooters() || []).map(normalizeProduct);
      this.setData({ scooters: cached, filtered: this.filterProducts(cached, this.data.query, this.data.sortKey), loading: false });
      this.refreshHotProducts(cached);
      wx.showToast({ title: '云端加载失败，已显示缓存', icon: 'none' });
    });
  },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` }); },
  setSearch(e) {
    const query = e.detail.value.trim();
    this.setData({ query, filtered: this.filterProducts(this.data.scooters, query, this.data.sortKey) });
  },
  setSort(e) {
    const sortKey = e.currentTarget.dataset.key;
    this.setData({ sortKey, filtered: this.filterProducts(this.data.scooters, this.data.query, sortKey) });
  },
  filterProducts(products, query, sortKey) {
    const keyword = String(query || '').toLowerCase();
    const filtered = products.filter(item => `${item.name} ${item.subtitle}`.toLowerCase().includes(keyword));
    const rangeValue = value => Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
    const sorters = {
      rating: (a, b) => this.ratingWeight(b) - this.ratingWeight(a),
      sales: (a, b) => b.salesCount - a.salesCount,
      // 「价格优先」按 sortPriceInCents 比较：售卖车取 effectivePriceInCents（服务端已折算促销价），
      // 租赁车取 rentalPlan.unitPriceInCents（单位租金）。若直接比较售价，319900 分的租赁车会永远垫底。
      price: (a, b) => a.sortPriceInCents - b.sortPriceInCents,
      range: (a, b) => rangeValue(b.range) - rangeValue(a.range),
      stock: (a, b) => b.sellableStock - a.sellableStock
    };
    if (sortKey === 'recommend') return filtered.sort((a, b) => this.recommendWeight(b) - this.recommendWeight(a));
    return sorters[sortKey] ? filtered.sort(sorters[sortKey]) : filtered;
  },
  ratingWeight(item) {
    const score = Number(item.ratingSummary?.average || 0.1) * 100;
    return score + Math.min(Number(item.salesCount || 0), 50);
  },
  recommendWeight(item) {
    return this.ratingWeight(item);
  },
  refreshHotProducts(scooters) {
    const hotProducts = scooters.filter(item => item.sellableStock > 0)
      .sort((a, b) => this.ratingWeight(b) - this.ratingWeight(a))
      .slice(0, 3);
    this.setData({ hotProducts });
  }
});
