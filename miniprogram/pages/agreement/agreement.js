const docTypes = {
  privacy: {
    title: '隐私政策',
    sections: [
      { heading: '我们收集什么', items: ['姓名和手机号：用于订单联系、校内配送和业务办理回访。', '订单信息：用于履约、售后、结算和对账。', '配送与车辆资料：用于校内配送、校园牌照辅助和资格核验。'] },
      { heading: '我们如何使用', items: ['仅用于完成你申请的校园服务，不向无关第三方出售。', '商家仅能看到履约必需的联系人、地址和商品信息。', '平台会按运营和法规要求留存交易与协同记录。'] },
      { heading: '如何联系我们', items: ['客服电话 / 微信：15527111396。', '你可以通过客服查询、更正或申请删除与订单相关的个人信息。'] }
    ],
    effectiveAt: '2026年9月5日'
  },
  service: {
    title: '服务协议',
    sections: [
      { heading: '平台角色', items: ['“狮山智生活”为校园交易与服务平台，提供下单、支付、协同、售后和牌照辅助入口。', '商品与履约服务由入驻商家或平台合作方提供，平台负责规则、协同与纠纷协助。'] },
      { heading: '交易与履约', items: ['电动车、电话卡和话费权益按页面展示价格下单；服务范围以学校、运营商和商家最终确认为准。', '校内配送订单需提供真实联系人、手机号和校区地址；商家完成配送时需核验 6 位交付码。', '售后可在订单中提交申请，平台会在承诺时间内跟进。'] },
      { heading: '校区合规', items: ['车辆上牌、充电资格和校园准入以华中农业大学及主管部门规则为准。', '电话卡实名激活、话费到账和宽带资格以运营商核验结果为准。'] }
    ],
    effectiveAt: '2026年9月5日'
  }
};

Page({
  data: { doc: null },
  onLoad(options) {
    const key = options.type === 'service' ? 'service' : 'privacy';
    this.setData({ doc: docTypes[key] });
    wx.setNavigationBarTitle({ title: docTypes[key].title });
  },
  contactService() {
    wx.makePhoneCall({ phoneNumber: '15527111396' });
  }
});
