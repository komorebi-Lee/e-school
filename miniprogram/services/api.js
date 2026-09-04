const { request } = require('../lib/cloud-request');

const userId = () => wx.getStorageSync('campusGoUserId') || 'miniapp_guest';
module.exports = { request, userId };
