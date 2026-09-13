// 狮山智生活 · 校园地图 POI 数据（GCJ-02 坐标系，与高德/微信地图一致）
// 坐标采集方法见 E:\e-school\docs\research\地图POI采集指南.md
// lat/lng 为 null 的点 = 待采集，不会显示在地图上；填上即自动出现
//
// 采集口径：
//  - 点状设施（食堂/驿站/营业厅）取大门或入口处坐标
//  - 片区（宿舍区/试验田）取片区几何中心
//  - 精度要求 5–10 米即可，拾取器上把十字对准屋顶/门口

const categories = [
  "全部",
  "校门",
  "食堂",
  "宿舍区",
  "教学楼",
  "快递",
  "生活服务",
  "运动场馆",
  "医疗",
  "合作商家"
];

const pois = [
  // ===== 校门 =====
  { id: 101, name: "西门", category: "校门", lat: 30.475773, lng: 114.339386, address: "狮子山街1号", desc: "出校主门，正对珞狮南路，去壕沟/南湖大道车行走这边" },
  { id: 102, name: "西北门", category: "校门", lat: null, lng: null, address: "梧桐路方向", desc: "近低年级宿舍区，去珞狮南路也方便" },
  { id: 103, name: "南门", category: "校门", lat: 30.471085, lng: 114.348857, address: "南湖大道方向", desc: "临南湖" },

  // ===== 食堂 =====
  { id: 201, name: "荟园食堂", category: "食堂", lat: 30.473042, lng: 114.361828, address: "南荟路", desc: "荟园宿舍区主食堂" },
  { id: 202, name: "桃园食堂", category: "食堂", lat: 30.471322, lng: 114.361704, address: "桃园宿舍区", desc: "" },
  { id: 203, name: "博园食堂", category: "食堂", lat: 30.477017, lng: 114.362964, address: "博园宿舍区", desc: "" },
  { id: 204, name: "西苑食堂", category: "食堂", lat: 30.476326, lng: 114.349482, address: "西苑小区", desc: "" },

  // ===== 宿舍区 =====
  { id: 301, name: "荟园宿舍区", category: "宿舍区", lat: 30.471466, lng: 114.363625, address: "南荟路", desc: "荟一至荟九，本科生主宿舍区" },
  { id: 302, name: "桃园宿舍区", category: "宿舍区", lat: 30.471322, lng: 114.361704, address: "", desc: "" },
  { id: 303, name: "博园宿舍区", category: "宿舍区", lat: 30.477017, lng: 114.362964, address: "", desc: "研究生片区" },

  // ===== 教学楼/公共设施 =====
  { id: 401, name: "图书馆", category: "教学楼", lat: 30.471634, lng: 114.357292, address: "", desc: "" },
  { id: 402, name: "大学生活动中心", category: "教学楼", lat: 30.473332, lng: 114.365729, address: "", desc: "社团、讲座、活动集中地" },
  { id: 403, name: "学生综合服务楼", category: "教学楼", lat: 30.473106, lng: 114.362562, address: "梧桐路", desc: "联通营业厅、打印、杂货都在这" },
  { id: 404, name: "梧桐路步行街", category: "教学楼", lat: 30.474581, lng: 114.350099, address: "梧桐路", desc: "校内最热闹的商业街" },

  // ===== 快递 =====
  { id: 501, name: "菜鸟驿站（荟园）", category: "快递", lat: 30.472657, lng: 114.362686, address: "荟园", desc: "" },
  { id: 502, name: "快递点（桃园）", category: "快递", lat: null, lng: null, address: "桃园", desc: "具体驿站名和位置明天踩点确认" },

  // ===== 生活服务 =====
  { id: 601, name: "中国移动 华农营业厅", category: "生活服务", lat: 30.473392, lng: 114.364301, address: "南荟路·荟五广场", desc: "已谈合作意向，校园卡办理" },
  { id: 602, name: "中国电信 华农营业厅", category: "生活服务", lat: 30.475691, lng: 114.350267, address: "校园西侧", desc: "已谈拢，校园卡主推渠道" },

  // ===== 运动场馆 =====
  { id: 701, name: "第一运动场", category: "运动场馆", lat: 30.474981, lng: 114.359609, address: "", desc: "" },
  { id: 702, name: "体育馆", category: "运动场馆", lat: 30.473119, lng: 114.360672, address: "", desc: "" },

  // ===== 医疗 =====
  { id: 801, name: "校医院", category: "医疗", lat: 30.473822, lng: 114.353849, address: "", desc: "" },

  // ===== 合作商家（走访已谈的，坐标随二次拜访补） =====
  { id: 901, name: "雅迪电动车（西苑店）", category: "合作商家", lat: 30.476316, lng: 114.349579, address: "西苑小区", desc: "平台合作车行，意向明确" },
  { id: 902, name: "五星钻豹电动车（西大门店）", category: "合作商家", lat: 30.478053, lng: 114.338734, address: "西大门·狮山美庐", desc: "平台合作车行" },
  { id: 903, name: "爱玛电动车（西大门店）", category: "合作商家", lat: null, lng: null, address: "西大门", desc: "平台合作车行" },
  { id: 904, name: "绿源电动车（澜花语岸店）", category: "合作商家", lat: 30.480343, lng: 114.343378, address: "澜花语岸", desc: "平台合作车行" },
  { id: 503, name: "菜鸟驿站（西苑）", category: "快递", lat: 30.476582, lng: 114.343844, address: "西苑教育超市旁", desc: "西苑片区快递点" }
];

module.exports = { categories, pois };
