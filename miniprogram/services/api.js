const { API_BASE_URL } = require('../config/api');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${path}`,
      method: options.method || 'GET',
      data: options.data,
      header: { 'content-type': 'application/json', ...(options.header || {}) },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error((res.data && res.data.error && res.data.error.message) || `请求失败（${res.statusCode}）`));
      },
      fail: reject
    });
  });
}

const userId = () => wx.getStorageSync('campusGoUserId') || 'miniapp_guest';
module.exports = { request, userId };
