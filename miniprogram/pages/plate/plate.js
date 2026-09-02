Page({
  data:{source:'platform',vehicleModel:''},
  chooseSource(e){this.setData({source:e.currentTarget.dataset.source})},
  setVehicleModel(e){this.setData({vehicleModel:e.detail.value})},
  submit(){const interest=this.data.source==='platform'?'平台购车免费上牌协助':(this.data.vehicleModel||'自带车上牌协助');wx.navigateTo({url:`/pages/consult/consult?type=校园牌照辅助&interest=${encodeURIComponent(interest)}`})},
  callService(){wx.makePhoneCall({phoneNumber:'15527111396'})}
});
