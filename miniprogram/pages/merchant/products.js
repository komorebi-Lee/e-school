const { request: apiRequest } = require('../../services/api');

const categories = [
  { value: 'E_BIKE_NEW', label: '电动车整车' },
  { value: 'DIGITAL', label: '数码配件' },
  { value: 'FOOD', label: '食品生鲜' },
  { value: 'SERVICE', label: '生活服务' }
];

const categoryLabels = { E_BIKE_NEW:'电动车整车', DIGITAL:'数码配件', FOOD:'食品生鲜', SERVICE:'生活服务' };

const emptyForm = { name: '', categoryIndex: 0, price: '', stock: '', description: '', imageUrl: '', active: true };

Page({
  data: {
    categories, products: [], filtered: [], metrics: null, lowStockThreshold: 10, query: '', filter: 'ALL',
    filters: [
      { key:'ALL', label:'全部' },
      { key:'LOW', label:'低库存' },
      { key:'OFF', label:'已下架' }
    ],
    form: emptyForm, editId: '', loading: true
  },
  onShow() {
    this.load();
  },

  request(path, options = {}) {
    const token = wx.getStorageSync('campusGoMerchantToken');
    return apiRequest(path, { ...options, header: { authorization: `Bearer ${token}` } });
  },
  load() {
    this.request('/api/merchant/overview').then(({ data }) => {
      const products = (data.products || []).map((product) => {
        // 商家看到的“可售”已扣除待支付订单占用，补货判断以可售库存为准。
        const sellableStock = Number(product.availableStock !== undefined ? product.availableStock : product.stock || 0);
        const reservedStock = Number(product.reservedStock || 0);
        const lowStockThreshold = Number(data.lowStockThreshold ?? 10);
        return {
          ...product,
          categoryLabel: categoryLabels[product.category] || product.category,
          sellableStock,
          reservedStock,
          stockText: sellableStock === 0 ? '已售罄' : sellableStock <= lowStockThreshold ? `可售仅剩 ${sellableStock}` : `可售 ${sellableStock}`,
          stockDetailText: reservedStock > 0 ? `总库存 ${product.stock} · 待支付占用 ${reservedStock}` : `总库存 ${product.stock}`,
          hasImage: Boolean(product.imageUrl),
          autoDelisted: product.autoDelistRule === 'LOW_QUALITY' && !product.active,
          autoDelistText: product.autoDelistRule === 'LOW_QUALITY' ? product.autoDelistReason || '触发低质风控规则' : ''
        };
      });
      this.setData({
        products,
        filtered: this.filterProducts(products, this.data.query, this.data.filter),
        metrics: data.metrics || null,
        lowStockThreshold: Number(data.lowStockThreshold ?? 10),
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
      wx.showToast({ title: '请重新进入商家工作台', icon: 'none' });
    });
  },
  setSearch(event) {
    const query = event.detail.value.trim();
    this.setData({ query, filtered: this.filterProducts(this.data.products, query, this.data.filter) });
  },
  setFilter(event) {
    const filter = event.currentTarget.dataset.key || 'ALL';
    this.setData({ filter, filtered: this.filterProducts(this.data.products, this.data.query, filter) });
  },
  filterProducts(products, query, filter) {
    const keyword = String(query || '').toLowerCase();
    return products.filter((product) => `${product.name} ${product.description}`.toLowerCase().includes(keyword)).filter((product) => {
      if (filter === 'LOW') return product.sellableStock <= (this.data.lowStockThreshold || 10);
      if (filter === 'OFF') return !product.active;
      return true;
    });
  },
  restock(event) {
    const product = this.data.products.find((item) => item.id === event.currentTarget.dataset.id);
    if (!product) return;
    wx.showModal({
      title: '快捷补货',
      editable: true,
      placeholderText: `请输入为“${product.name}”增加的库存数量`,
      success: (result) => {
        if (!result.confirm) return;
        const quantity = Number(result.content);
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return wx.showToast({ title: '请输入大于 0 的整数', icon: 'none' });
        }
        this.request(`/api/merchant/products/${product.id}`, { method:'POST', data:{ stock: product.stock + quantity } }).then(() => {
          wx.showToast({ title: '库存已更新' });
          this.load();
        }).catch((error) => wx.showToast({ title: error.message || '补货失败', icon: 'none' }));
      }
    });
  },
  setField(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: event.detail.value });
  },
  setActive(event) {
    this.setData({ 'form.active': event.detail.value });
  },
  setCategory(event) {
    this.setData({ 'form.categoryIndex': Number(event.detail.value) });
  },
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0];
        if (!file) return;
        const extension = file.tempFilePath.split('.').pop().toLowerCase();
        const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
        wx.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          encoding: 'base64',
          success: ({ data }) => {
            wx.showLoading({ title: '上传中' });
            apiRequest('/api/uploads', { method:'POST', data:{ dataBase64:data, mimeType } }).then(({ data: result }) => {
              wx.hideLoading();
              this.setData({ 'form.imageUrl': result.url });
              wx.showToast({ title: '图片已上传', icon: 'success' });
            }).catch((error) => {
              wx.hideLoading();
              wx.showToast({ title: error.message || '图片上传失败', icon: 'none' });
            });
          },
          fail: () => wx.showToast({ title: '图片读取失败', icon: 'none' })
        });
      }
    });
  },
  removeImage() {
    this.setData({ 'form.imageUrl': '' });
  },
  select(event) {
    const item = this.data.products.find((product) => product.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      editId: item.id,
      form: {
        name: item.name,
        categoryIndex: Math.max(0, this.data.categories.findIndex((category) => category.value === item.category)),
        price: String(item.priceInCents / 100),
        stock: String(item.stock),
        description: item.description,
        imageUrl: item.imageUrl || '',
        active: item.active
      }
    });
  },
  reset() {
    this.setData({ editId: '', form: emptyForm });
  },
  submit() {
    const { name, categoryIndex, price, stock, description, imageUrl, active } = this.data.form;
    const category = this.data.categories[categoryIndex];
    if (!name || !category || !price || stock === '') return wx.showToast({ title: '请完整填写商品信息', icon: 'none' });
    const payload = {
      name,
      category: category.value,
      description: description || '暂无简介',
      imageUrl,
      priceInCents: Math.round(Number(price) * 100),
      stock: Number(stock),
      active
    };
    const path = this.data.editId ? `/api/merchant/products/${this.data.editId}` : '/api/merchant/products';
    this.request(path, { method: 'POST', data: payload }).then(() => {
      wx.showToast({ title: this.data.editId ? '商品已保存' : '商品已上架' });
      this.reset();
      this.load();
    }).catch((error) => wx.showToast({ title: error.message || '保存失败', icon: 'none' }));
  },
  toggle(event) {
    const { id, active } = event.currentTarget.dataset;
    this.request(`/api/merchant/products/${id}`, { method: 'POST', data: { active: !active } }).then(() => this.load()).catch((error) => wx.showToast({ title: error.message || '操作失败', icon: 'none' }));
  }
});
