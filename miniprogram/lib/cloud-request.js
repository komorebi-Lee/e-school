const cloudConfig = require('../config/api');

function callContainer(path, options = {}, token = '') {
  return wx.cloud.callContainer({
    config: { env: cloudConfig.CLOUD_ENV_ID },
    path,
    method: options.method || 'GET',
    data: options.data,
    header: {
      'content-type': 'application/json',
      'X-WX-SERVICE': cloudConfig.CLOUD_SERVICE_NAME,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.header || {})
    }
  });
}

function responseError(response) {
  const statusCode = Number(response.statusCode || 0);
  const error = new Error(response.data?.error?.message || `请求失败（${statusCode}）`);
  error.statusCode = statusCode;
  error.code = response.data?.error?.code;
  error.details = response.data?.error?.details;
  return error;
}

function loginWeChat() {
  const demoMode = true;
  if (demoMode) {
    return new Promise((resolve, reject) => {
      callContainer('/api/auth/demo-login', { method: 'POST' }).then((response) => {
        if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) {
          return reject(responseError(response));
        }
        const { token, userId, expiresIn } = response.data?.data || {};
        if (!token || !userId) return reject(new Error('登录失败，请稍后重试'));
        wx.setStorageSync('campusGoUserToken', token);
        wx.setStorageSync('campusGoUserId', userId);
        wx.setStorageSync('campusGoUserTokenExpiresAt', Date.now() + (expiresIn || 604800) * 1000);
        resolve({ token, userId });
      }).catch((error) => reject(new Error(error.errMsg || '登录失败，请稍后重试')));
    });
  }
  return new Promise((resolve, reject) => {
    wx.login({
      success: ({ code }) => {
        if (!code) return reject(new Error('微信登录失败，请稍后重试'));
        callContainer('/api/auth/login', { method: 'POST', data: { code } }).then((response) => {
          if (Number(response.statusCode || 0) < 200 || Number(response.statusCode || 0) >= 300) {
            return reject(responseError(response));
          }
          const { token, userId, expiresIn } = response.data?.data || {};
          if (!token || !userId) return reject(new Error('微信登录失败，请稍后重试'));
          wx.setStorageSync('campusGoUserToken', token);
          wx.setStorageSync('campusGoUserId', userId);
          wx.setStorageSync('campusGoUserTokenExpiresAt', Date.now() + (expiresIn || 604800) * 1000);
          resolve({ token, userId });
        }).catch((error) => reject(new Error(error.errMsg || '微信登录失败，请稍后重试')));
      },
      fail: (error) => reject(new Error(error.errMsg || '微信登录失败，请稍后重试'))
    });
  });
}

async function getWeChatSession() {
  const token = wx.getStorageSync('campusGoUserToken');
  const expiresAt = wx.getStorageSync('campusGoUserTokenExpiresAt') || 0;
  if (token && expiresAt > Date.now() + 60000) return token;
  const session = await loginWeChat();
  return session.token;
}

async function request(path, options = {}) {
  const token = await getWeChatSession();
  const response = await callContainer(path, options, token);
  const statusCode = Number(response.statusCode || 0);
  if (statusCode >= 200 && statusCode < 300) return response.data;
  throw responseError(response);
}

module.exports = { request, loginWeChat };
