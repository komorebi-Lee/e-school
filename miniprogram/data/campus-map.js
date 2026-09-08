const OFFICIAL_SOURCE = '华中农业大学校园地图服务系统（官方点位库）';
const OFFICIAL_MAP_URL = 'http://gis.hzau.edu.cn';

const mapBounds = {
  minX: 209800,
  maxX: 213900,
  minY: 289200,
  maxY: 291400
};

function toMapPosition(coordinate) {
  const x = ((coordinate[0] - mapBounds.minX) / (mapBounds.maxX - mapBounds.minX)) * 100;
  const y = (1 - (coordinate[1] - mapBounds.minY) / (mapBounds.maxY - mapBounds.minY)) * 100;
  return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
}

function createSpot(config) {
  const position = toMapPosition(config.coordinate);
  return {
    ...config,
    ...position,
    qImage: config.qImage || '/assets/campus/q/canteen.webp',
    realImage: config.realImage || '/assets/campus/q/canteen.webp',
    source: config.source || OFFICIAL_SOURCE
  };
}

const spots = [
  createSpot({ id: 'south-gate', title: '南校门', category: 'gate', icon: '门', coordinate: [210035, 290275], aliases: ['南门', '狮子山门'], use: '主入口 · 南湖大道侧', tip: '第一次来校先记住南校门。公共交通到站后沿主干道向北，图书馆和核心教学区在前方。', qImage: '/assets/campus/q/south-gate.webp', qName: '狮子山门楼', qPlan: '正面门楼、校名景和狮子山轮廓' }),
  createSpot({ id: 'north-gate', title: '北校门', category: 'gate', icon: '北', coordinate: [211381, 291351], aliases: ['北门'], use: '北侧出入口 · 科研片区', tip: '北门更靠近科研医疗片区，去校医院、实验楼和北侧场馆时更顺路。', qImage: '/assets/campus/q/south-gate.webp', qName: '北门入口', qPlan: '门柱、林荫路和方向牌' }),
  createSpot({ id: 'east-gate', title: '东校门', category: 'gate', icon: '东', coordinate: [213827, 289711], aliases: ['东门'], use: '东侧出入口 · 博园方向', tip: '从东门进入后先认准博园生活区方向，去核心教学区前建议先打开路线。', qImage: '/assets/campus/q/south-gate.webp', qName: '东门岗亭', qPlan: '门柱、岗亭和指向牌' }),
  createSpot({ id: 'southwest-gate', title: '西南门', category: 'gate', icon: '西', coordinate: [209835, 290970], aliases: ['西南校门'], use: '西南侧出入口 · 生活片区', tip: '西南门连接生活片区和校外道路，适合从西南侧到校时作为定位起点。', qImage: '/assets/campus/q/south-gate.webp', qName: '西南门入口', qPlan: '门牌、树荫和路口关系' }),
  createSpot({ id: 'library', title: '图书馆', category: 'landmark', icon: '书', coordinate: [210401, 290037], aliases: ['图书馆自习', '自习室'], use: '自习 · 借阅 · 小组学习', tip: '图书馆是核心教学区的认路坐标。看到大台阶和开阔广场，就能判断自己已经到达核心区。', qImage: '/assets/campus/q/library.webp', qName: '大台阶书屋', qPlan: '保留台阶、玻璃入口和树阵' }),
  createSpot({ id: 'museum', title: '博物馆·档案馆', category: 'landmark', icon: '博', coordinate: [211124, 290496], aliases: ['博物馆', '档案馆'], use: '校史展示 · 参观打卡', tip: '博物馆和图书馆相邻，是新生熟悉核心教学区时很好的第二个坐标点。', qImage: '/assets/campus/q/library.webp', qName: '圆顶档案馆', qPlan: '圆顶、入口台阶和农业纹样' }),
  createSpot({ id: 'qiushi-building', title: '求是楼', category: 'teaching', icon: '教', coordinate: [211148, 290227], aliases: ['第一教学楼', '一教'], use: '第一教学楼 · 集中上课', tip: '求是楼是第一教学楼。第一次上课不要只记楼名，建议把课程楼栋和路线一起收藏。', qImage: '/assets/campus/q/library.webp', qName: '求是教学楼', qPlan: '横向楼体、楼号牌和连廊' }),
  createSpot({ id: 'qiuzhen-building', title: '求真楼', category: 'teaching', icon: '真', coordinate: [211054, 290160], aliases: ['第二教学楼', '二教'], use: '第二教学楼 · 课间转场', tip: '求真楼靠近核心教学区南侧，和求是楼之间的转场路线适合提前熟悉。', qImage: '/assets/campus/q/library.webp', qName: '求真教学楼', qPlan: '连廊教室、楼号牌和课表框' }),
  createSpot({ id: 'yifu-building', title: '逸夫教学楼', category: 'teaching', icon: '课', coordinate: [211300, 290330], aliases: ['逸夫楼', '逸夫教学楼A座'], use: '教学楼 · 课程教室', tip: '逸夫教学楼由多个楼座组成，查课时要确认 A、B、C 座，再开始步行。', qImage: '/assets/campus/q/library.webp', qName: '逸夫教学楼', qPlan: '多楼座、连桥和楼座字牌' }),
  createSpot({ id: 'humanities-building', title: '人文社科楼', category: 'professional', icon: '文', coordinate: [210505, 289764], aliases: ['人文社科楼A座', '人文楼'], use: '人文社科学院 · 专业课', tip: '人文社科楼分为多个楼座，导航时先确认 A 座或 M 座，避免在天桥附近绕行。', qImage: '/assets/campus/q/library.webp', qName: '人文社科楼', qPlan: '米白楼体、天桥和学院铭牌' }),
  createSpot({ id: 'engineering-building', title: '工学院', category: 'professional', icon: '工', coordinate: [210976, 290035], aliases: ['工科楼', '工科创新实训基地'], use: '工学院 · 实训与专业课', tip: '工学院靠近核心教学区西侧，第一次去实训课建议预留找楼和换鞋时间。', qImage: '/assets/campus/q/engineering.webp', qName: '工学院实训楼', qPlan: '工业蓝屋顶、齿轮线稿和实训窗' }),
  createSpot({ id: 'animal-science-building', title: '动科楼', category: 'professional', icon: '动', coordinate: [211296, 290578], aliases: ['动物科学楼', '动物科学技术学院'], use: '动物科学学院 · 专业课', tip: '动科楼在图书馆东南方向，沿主路找学院标识会比只看楼体更快。', qImage: '/assets/campus/q/animal.webp', qName: '动科实验楼', qPlan: '奶油黄立面、动物剪影和实验窗' }),
  createSpot({ id: 'aquaculture-building', title: '水产学院', category: 'professional', icon: '水', coordinate: [210728, 290221], aliases: ['水产楼', '水产学院教学楼'], use: '水产学院 · 专业课与实验', tip: '水产学院位于求真楼西侧，认路时可以把求真楼和水产学院作为一组地标。', qImage: '/assets/campus/q/aquaculture.webp', qName: '水产学院', qPlan: '蓝绿色屋顶、水波纹和鱼形标志' }),
  createSpot({ id: 'landscape-building', title: '景园楼', category: 'professional', icon: '园', coordinate: [211588, 290351], aliases: ['园艺楼', '园艺林学学院'], use: '园艺林学学院 · 专业课', tip: '景园楼在核心教学区东侧，附近楼宇名称较多，先搜景园楼再看路线更省时间。', qImage: '/assets/campus/q/landscape.webp', qName: '景园植物楼', qPlan: '玻璃温室、绿叶屋顶和花园入口' }),
  createSpot({ id: 'food-science-building', title: '食品学院', category: 'professional', icon: '食', coordinate: [212270, 289885], aliases: ['食品科学技术学院', '食品楼'], use: '食品科学技术学院 · 专业课', tip: '食品学院靠近博园和橘园片区，去上课前可以顺手规划一条“教学楼到食堂”的路线。', qImage: '/assets/campus/q/canteen.webp', qName: '食品科技楼', qPlan: '暖黄色立面、麦穗和实验瓶' }),
  createSpot({ id: 'resources-building', title: '资环学院', category: 'professional', icon: '环', coordinate: [211468, 290574], aliases: ['资源与环境学院', '资源环境学院'], use: '资源与环境学院 · 专业课', tip: '资环学院位于科研教学片区，周边有多个附楼，建议把主楼作为路线终点。', qImage: '/assets/campus/q/landscape.webp', qName: '资环学院主楼', qPlan: '绿色屋顶、叶片图形和主楼标牌' }),
  createSpot({ id: 'huiyuan-canteen', title: '荟园食堂', category: 'food', icon: '饭', coordinate: [211346, 289717], aliases: ['荟园餐厅', '荟园'], use: '正餐 · 高峰分流', tip: '荟园食堂在生活区东侧，饭点高峰可以先看距离，再决定是否去桃园或竹苑。', qImage: '/assets/campus/q/canteen.webp', qName: '荟园餐车', qPlan: '暖色屋顶、餐窗和排队动线' }),
  createSpot({ id: 'taoyuan-canteen', title: '桃园食堂', category: 'food', icon: '桃', coordinate: [210985, 289527], aliases: ['桃园餐厅', '桃园'], use: '正餐 · 小吃选择', tip: '桃园食堂靠近南片生活区，适合从南侧回宿舍或运动场时顺路就餐。', qImage: '/assets/campus/q/canteen.webp', qName: '桃源小馆', qPlan: '桃叶屋檐、窗口和小吃摊' }),
  createSpot({ id: 'boyuan-canteen', title: '博园食堂', category: 'food', icon: '餐', coordinate: [211777, 290082], aliases: ['博园餐厅', '博园'], use: '东北片区 · 就近用餐', tip: '博园食堂离东北侧教学和生活区更近，适合按片区选择，不必专程穿校区。', qImage: '/assets/campus/q/canteen.webp', qName: '博园餐堂', qPlan: '方正食堂、菜单双层招牌' }),
  createSpot({ id: 'orange-canteen', title: '橘园食堂', category: 'food', icon: '橘', coordinate: [212089, 289948], aliases: ['橘园餐厅', '橘园'], use: '东侧生活区 · 就餐', tip: '橘园食堂位于东侧生活区，去食品学院和博园方向时都可以作为中途补给点。', qImage: '/assets/campus/q/canteen.webp', qName: '橘园餐厅', qPlan: '橙色屋顶、果实图案和餐窗' }),
  createSpot({ id: 'campus-supermarket', title: '教超', category: 'commerce', icon: '超', coordinate: [211723, 289970], aliases: ['后勤集团商贸服务中心', '校园超市', '超市'], use: '日用品 · 零食 · 生活补给', tip: '教超适合新生第一周集中采购。搜索“超市”或“教超”都能找到这里。', qImage: '/assets/campus/q/canteen.webp', qName: '校园补给站', qPlan: '绿色招牌、购物篮和生活货架' }),
  createSpot({ id: 'activity-center', title: '大学生活动中心', category: 'service', icon: '社', coordinate: [211872, 289327], aliases: ['学生活动中心', '大活'], use: '社团 · 讲座 · 报到活动', tip: '招新、讲座和迎新活动常在这里集合。路线分享可以直接把大学生活动中心作为终点。', qImage: '/assets/campus/q/activity.webp', qName: '活动礼堂', qPlan: '小礼堂、社团旗和活动海报栏' }),
  createSpot({ id: 'clinic', title: '校医院', category: 'medical', icon: '医', coordinate: [210419, 290666], aliases: ['医院', '校医务室'], use: '门诊 · 应急咨询', tip: '校医院在科研医疗片区西侧。身体不适时直接搜“校医院”，不要只按片区猜位置。', qImage: '/assets/campus/q/clinic.webp', qName: '安心医疗站', qPlan: '白墙绿顶、医疗十字和入口雨棚' }),
  createSpot({ id: 'west-gymnasium', title: '西体育馆', category: 'sports', icon: '体', coordinate: [211129, 289860], aliases: ['西馆', '体育馆'], use: '运动 · 体测 · 活动场馆', tip: '西体育馆在南片运动带，体测或活动前先确认是西馆还是东馆。', qImage: '/assets/campus/q/gymnasium.webp', qName: '圆顶运动馆', qPlan: '弧形屋顶、球场线和运动旗' }),
  createSpot({ id: 'east-gymnasium', title: '东体育馆', category: 'sports', icon: '东', coordinate: [211532, 289905], aliases: ['东馆'], use: '运动 · 场馆活动', tip: '东体育馆靠近核心教学区南侧，和西体育馆不要混淆，预约时看清场馆名称。', qImage: '/assets/campus/q/gymnasium.webp', qName: '东侧运动馆', qPlan: '弧形屋顶、看台和运动标线' }),
  createSpot({ id: 'sports-field', title: '运动场', category: 'sports', icon: '场', coordinate: [211170, 290046], aliases: ['西运动场', '篮球场', '操场'], use: '跑步 · 体测 · 球类运动', tip: '运动场靠近西体育馆，适合把“运动场 + 西体育馆”设为一条运动路线。', qImage: '/assets/campus/q/gymnasium.webp', qName: '狮山运动场', qPlan: '跑道、草坪和看台色块' }),
  createSpot({ id: 'tennis-court', title: '网球场', category: 'sports', icon: '网', coordinate: [212036, 290065], aliases: ['北网球场'], use: '网球 · 课外运动', tip: '北网球场位于博园北侧，和篮球场、羽毛球场一起组成东北运动点位。', qImage: '/assets/campus/q/gymnasium.webp', qName: '北侧网球场', qPlan: '绿色场地、网架和遮阳棚' }),
  createSpot({ id: 'solar-terms', title: '二十四节气柱', category: 'scenic', icon: '节', coordinate: [211010, 290430], aliases: ['节气柱', '二十四节气'], use: '校园景点 · 拍照打卡', tip: '二十四节气柱适合做新生打卡路线地标，正式上线前请按实地照片复核具体入口方向。', qImage: '/assets/campus/q/solar.webp', qName: '节气长廊', qPlan: '二十四根彩色立柱、农作物纹样', source: `${OFFICIAL_SOURCE}；景点位置待实地复核` }),
  createSpot({ id: 'gym', title: '健身房', category: 'sports', icon: '练', coordinate: [211300, 289980], aliases: ['健身', '运动健身'], use: '器械训练 · 日常锻炼', tip: '健身房的具体开放时段可能随学期调整，路线确认后仍要看现场公告。', qImage: '/assets/campus/q/gymnasium.webp', qName: '狮山健身房', qPlan: '玻璃入口、器械剪影和活力色块', source: `${OFFICIAL_SOURCE}；室内设施位置待实地复核` })
];

const categories = [
  { id: 'all', label: '全部', icon: '✦' },
  { id: 'professional', label: '专业楼', icon: '学' },
  { id: 'food', label: '吃饭', icon: '饭' },
  { id: 'commerce', label: '买东西', icon: '购' },
  { id: 'sports', label: '运动', icon: '动' },
  { id: 'landmark', label: '地标', icon: '景' },
  { id: 'service', label: '服务', icon: '用' }
];

function normalizeKeyword(keyword) {
  return String(keyword || '').trim().toLowerCase().replace(/\s+/g, '');
}

function searchSpots(keyword) {
  const query = normalizeKeyword(keyword);
  if (!query) return spots;
  return spots.filter((spot) => [spot.title, spot.use, ...(spot.aliases || [])]
    .join('')
    .toLowerCase()
    .replace(/\s+/g, '')
    .includes(query));
}

function filterSpots(category) {
  if (!category || category === 'all') return spots;
  return spots.filter((spot) => spot.category === category);
}

function getSpotById(id) {
  return spots.find((spot) => spot.id === id) || null;
}

function getRouteSummary(start, end) {
  const horizontal = Math.abs(start.coordinate[0] - end.coordinate[0]);
  const vertical = Math.abs(start.coordinate[1] - end.coordinate[1]);
  const directDistance = Math.sqrt(horizontal * horizontal + vertical * vertical);
  const distanceMeters = Math.max(80, Math.round(directDistance * 1.18 / 10) * 10);
  const durationMinutes = Math.max(2, Math.ceil(distanceMeters / 75));
  const landmarks = spots
    .filter((spot) => spot.id !== start.id && spot.id !== end.id)
    .map((spot) => ({ spot, score: Math.abs(spot.x - (start.x + end.x) / 2) + Math.abs(spot.y - (start.y + end.y) / 2) }))
    .sort((left, right) => left.score - right.score)
    .slice(0, 2)
    .map(({ spot }) => spot.title);

  return {
    start: start.title,
    end: end.title,
    distanceMeters,
    distanceText: `${distanceMeters} 米`,
    durationMinutes,
    durationText: `步行约 ${durationMinutes} 分钟`,
    landmarks
  };
}

module.exports = {
  OFFICIAL_MAP_URL,
  OFFICIAL_SOURCE,
  categories,
  campusZones: [
    { id: 'north', title: '科研医疗', x: 5, y: 5, w: 44, h: 29, copy: '校医院 · 实验楼', tone: 'blue' },
    { id: 'northeast', title: '博园生活', x: 52, y: 5, w: 43, h: 29, copy: '食堂 · 教超', tone: 'gold' },
    { id: 'center', title: '核心教学', x: 31, y: 31, w: 48, h: 34, copy: '教学楼 · 图书馆', tone: 'green' },
    { id: 'southwest', title: '荟园生活', x: 5, y: 58, w: 42, h: 35, copy: '食堂 · 活动', tone: 'coral' },
    { id: 'south', title: '南片运动', x: 51, y: 59, w: 44, h: 34, copy: '体育馆 · 运动场', tone: 'mint' }
  ],
  mapBounds,
  spots,
  searchSpots,
  filterSpots,
  getSpotById,
  getRouteSummary
};
