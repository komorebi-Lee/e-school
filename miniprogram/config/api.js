// 狮山智生活云托管 API。该域名需在微信公众平台配置为 request 合法域名。
const cloudApiBaseUrl = 'https://express-k49o-306861-8-1478226138.sh.run.tcloudbase.com';
const localApiBaseUrl = 'http://127.0.0.1:3000';

function resolveApiBaseUrl() {
  try {
    if (wx.getAccountInfoSync().miniProgram.envVersion === 'develop' && wx.getDeviceInfo().platform === 'devtools') return localApiBaseUrl;
  } catch (error) {
    return cloudApiBaseUrl;
  }
  return cloudApiBaseUrl;
}

const API_BASE_URL = resolveApiBaseUrl();
module.exports = { API_BASE_URL };
