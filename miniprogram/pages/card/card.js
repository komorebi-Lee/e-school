Page({
  data:{plans:[{id:'plan-campus',name:'校园畅享卡',monthlyFee:29,data:'80GB校园流量',voice:'100分钟通话',badge:'学生常选'},{id:'plan-plus',name:'校园畅联卡',monthlyFee:39,data:'120GB校园流量',voice:'200分钟通话',badge:'流量推荐'},{id:'plan-basic',name:'校园轻享卡',monthlyFee:19,data:'40GB校园流量',voice:'50分钟通话',badge:'基础套餐'}],rechargePromos:[{id:'r150',pay:150,receive:200,badge:'多得50元'},{id:'r200',pay:200,receive:300,badge:'多得100元'}],selectedPlan:0,activeSection:0,companionPhone:''},
  choosePlan(e){this.setData({selectedPlan:Number(e.currentTarget.dataset.index)})},
  onReady(){this.measureSections()},
  measureSections(){const query=wx.createSelectorQuery();query.selectAll('.business-section').boundingClientRect();query.selectViewport().scrollOffset();query.exec(res=>{const scrollTop=(res[1]&&res[1].scrollTop)||0;this.sectionTops=(res[0]||[]).map(item=>item.top+scrollTop)})},
  onPageScroll(e){const tops=this.sectionTops||[];if(tops.length!==3)return;const marker=e.scrollTop+150;let active=0;if(marker>=tops[2])active=2;else if(marker>=tops[1])active=1;if(active!==this.data.activeSection)this.setData({activeSection:active})},
  jumpSection(e){const index=Number(e.currentTarget.dataset.index);this.setData({activeSection:index});const query=wx.createSelectorQuery();query.selectAll('.business-section').boundingClientRect();query.selectViewport().scrollOffset();query.exec(res=>{const sections=res[0]||[];const scrollTop=(res[1]&&res[1].scrollTop)||0;this.sectionTops=sections.map(item=>item.top+scrollTop);const target=sections[index];if(target)wx.pageScrollTo({scrollTop:Math.max(0,target.top+scrollTop-92),duration:280})})},
  submit(){const p=this.data.plans[this.data.selectedPlan];wx.navigateTo({url:`/pages/consult/consult?type=校园电话卡&interest=${encodeURIComponent(p.name)}`})},
  buyRecharge(e){const p=this.data.rechargePromos[Number(e.currentTarget.dataset.index)];wx.navigateTo({url:`/pages/consult/consult?type=话费权益&interest=${encodeURIComponent(`充${p.pay}送${p.receive}`)}`})},
  setCompanionPhone(e){this.setData({companionPhone:e.detail.value})},
  applyBroadband(){wx.navigateTo({url:'/pages/consult/consult?type=宽带权益&interest=双人购卡宽带'})}
});
