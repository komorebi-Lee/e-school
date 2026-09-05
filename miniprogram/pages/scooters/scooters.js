const { request } = require('../../services/api');
const { getScooters } = require('../../services/store');

function normalizeProduct(item) {
  // 可售库存已扣除待支付订单占用，避免展示“有货”却下不了单。
  const sellableStock = Number(item.availableStock !== undefined ? item.availableStock : item.stock || 0);
  return {
    ...item,
    price: Math.round((item.priceInCents || 0) / 100),
    subtitle: item.description || '支持校内配送和校园牌照辅助。',
    range: item.range || (item.id === 'prod_ebike_rent_001' ? '70 km' : '45 km'),
    speed: item.speed || '25 km/h',
    icon: item.icon || '车',
    color: item.color || '#eaf0ff',
    ratingText: item.ratingSummary?.count ? item.ratingSummary.average.toFixed(1) : '',
    ratingCountText: item.ratingSummary?.count ? `${item.ratingSummary.count}条已购评价` : '暂无已购评价',
    sellableStock,
    stockText: sellableStock > 0 ? (sellableStock < 5 ? `仅剩 ${sellableStock} 件` : `库存 ${sellableStock}`) : '已售罄'
  };
}

Page({
  data: { scooters: [], filtered: [], query: '', sortKey: 'recommend', sortOptions: [
    { key: 'recommend', label: '综合推荐' },
    { key: 'price', label: '价格优先' },
    { key: 'range', label: '续航优先' },
    { key: 'stock', label: '库存优先' }
  ], loading: true },
  onLoad() { this.loadProducts(); },
  loadProducts() {
    request('/api/products?category=E_BIKE_NEW').then(({ data }) => {
      const scooters = (data || []).map(normalizeProduct);
      this.setData({ scooters, filtered: this.filterProducts(scooters, this.data.query, this.data.sortKey), loading: false });
    }).catch((error) => {
      console.error('云端商品加载失败:', error);
      const cached = (getScooters() || []).map(normalizeProduct);
      this.setData({ scooters: cached, filtered: this.filterProducts(cached, this.data.query, this.data.sortKey), loading: false });
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
      price: (a, b) => a.price - b.price,
      range: (a, b) => rangeValue(b.range) - rangeValue(a.range),
      stock: (a, b) => b.sellableStock - a.sellableStock
    };
    return sorters[sortKey] ? filtered.sort(sorters[sortKey]) : filtered;
  }
});
