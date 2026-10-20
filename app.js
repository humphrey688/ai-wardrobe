/* ============================================================
 * AI 衣柜 · 天气穿搭助手
 * 基于开源项目 leoz9/AIWardrobe (MIT) 核心设计改造的纯网页版
 * 纯前端：数据存 localStorage，天气用 Open-Meteo 免费接口
 * ============================================================ */
'use strict';

/* ================= 工具函数 ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const CAT_NAMES = { top: '上装', bottom: '下装', outer: '外套', shoes: '鞋履', accessory: '配饰' };
const COLORS = [
  { k: '黑', c: '#3a3a40' }, { k: '白', c: '#f0f0f2' }, { k: '灰', c: '#9a9a9e' },
  { k: '红', c: '#d9534f' }, { k: '橙', c: '#e08a3c' }, { k: '黄', c: '#e6c84c' },
  { k: '绿', c: '#58a06b' }, { k: '蓝', c: '#4a7fb5' }, { k: '紫', c: '#8e6bb5' },
  { k: '粉', c: '#f09ab3' }, { k: '棕', c: '#8a6a52' }, { k: '牛仔', c: '#5b7ea6' },
  { k: '多色', c: '#c9c9d2' },
];
const STYLES = ['休闲', '简约', '通勤', '正式', '运动', '街头', '甜美', '复古', '户外', '旅行'];
const GOAL_STYLES = {
  '日常': ['休闲', '简约', '街头'],
  '通勤': ['简约', '通勤', '正式'],
  '运动': ['运动', '街头'],
  '约会': ['甜美', '复古', '简约'],
  '正式': ['正式', '简约', '通勤'],
  '旅行': ['旅行', '休闲', '户外'],
};
const WEATHER_ICON = {
  '晴': '☀️', '晴间多云': '🌤️', '多云': '⛅', '阴': '☁️', '雾': '🌫️',
  '毛毛雨': '🌦️', '冻雨': '🌧️', '雨': '🌧️', '阵雨': '🌧️', '降雪': '🌨️',
  '阵雪': '🌨️', '雷暴': '⛈️',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmt(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())}`;
}
function dateCN() {
  const d = new Date();
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${w}`;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function daySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:110px;transform:translateX(-50%);background:rgba(40,45,60,.92);color:#fff;padding:10px 20px;border-radius:999px;font-size:13px;z-index:200;transition:opacity .3s;pointer-events:none;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
}

/* ================= 数据层 ================= */
const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('aiwardrobe_' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem('aiwardrobe_' + key, JSON.stringify(val)); }
    catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      console.warn('本地保存失败:', e && e.name, key);
      alert(quota
        ? '保存失败：浏览器本地存储已满（上限约 5MB）。重新打开页面会自动瘦身旧图片；若仍提示，请删除部分不再穿的衣物。'
        : '保存失败：' + ((e && e.message) || e));
    }
  },
  clothes: () => Store.get('clothes', []),
  saveClothes(list) { Store.set('clothes', list); Store.set('dirty', true); },
  diary: () => Store.get('diary', []),
  saveDiary(list) { Store.set('diary', list); Store.set('dirty', true); },
  outfits: () => Store.get('outfits', []),
  saveOutfits(list) { Store.set('outfits', list); Store.set('dirty', true); },
  settings: () => Object.assign({
    city: { name: '武汉·华科', admin1: '湖北省', lat: 30.5113, lon: 114.4237 },
    favColors: [], avoidColors: [], favStyles: [],
  }, Store.get('settings', {})),
  saveSettings(s) { Store.set('settings', s); },
};

let state = {
  clothes: [], diary: [], outfits: [], settings: null,
  goal: '日常', wardrobeTab: 'all', wardrobeBox: 'all', outfitView: 'saved',
  targetDay: 'tomorrow',  // 默认为明天搭配（今晚选好明天的衣服）
  weather: null,          // { today, tomorrow }
};

/* ================= 存储瘦身（修复本地存储爆满导致保存失败） =================
 * 根源：抠图成品是带透明通道的 PNG（单张可达数百 KB），且日记/固定搭配每条
 * 都把图片再复制一份 → 图片存了三遍，很快超过 localStorage 约 5MB 上限。
 * 方案：① 大 PNG 抠图平铺成白底 JPEG（体积降 70%+，页面图片底色均为白色，视觉不变）
 *      ② 日记/搭配条目不再内嵌图片，渲染时按 id 从衣柜取（图片只存一份）
 *      ③ 启动时自动迁移旧数据 */
function flattenImage(dataUrl, thresholdKB = 100) {
  return new Promise(resolve => {
    if (!dataUrl || !dataUrl.startsWith('data:image/png') || dataUrl.length * 3 / 4 < thresholdKB * 1024) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        const out = c.toDataURL('image/jpeg', 0.85);
        resolve(out.length < dataUrl.length ? out : dataUrl);
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* 日记/搭配条目图片按 id 从衣柜解析（条目本身不再存图） */
function imgOfItem(it) {
  const c = state.clothes && state.clothes.find(x => x.id === it.id);
  return (c && c.image) || it.image || '';
}

const stripItemImages = items => (items || []).map(it => {
  const r = Object.assign({}, it); delete r.image; return r;
});

async function migrateStorage() {
  try {
    let clothChanged = false;
    for (const c of state.clothes) {
      const flat = await flattenImage(c.image);
      if (flat !== c.image) { c.image = flat; clothChanged = true; }
    }
    if (clothChanged) Store.saveClothes(state.clothes);
    if (state.diary.some(d => (d.items || []).some(it => 'image' in it))) {
      state.diary = state.diary.map(d => Object.assign({}, d, { items: stripItemImages(d.items) }));
      Store.saveDiary(state.diary);
    }
    if (state.outfits.some(o => (o.items || []).some(it => 'image' in it))) {
      state.outfits = state.outfits.map(o => Object.assign({}, o, { items: stripItemImages(o.items) }));
      Store.saveOutfits(state.outfits);
    }
  } catch (e) { console.warn('存储迁移失败（不影响使用）:', e); }
}

/* ================= 天气（Open-Meteo） ================= */
function mapWeatherCode(code, isDay) {
  if (code === 0) return '晴';
  if (code === 1) return '晴间多云';
  if (code === 2) return '多云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 67) return '雨';
  if (code >= 71 && code <= 77) return '降雪';
  if (code >= 80 && code <= 82) return '阵雨';
  if (code >= 85 && code <= 86) return '阵雪';
  if (code >= 95) return '雷暴';
  return '多云';
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function searchCity(q) {
  const data = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`
  );
  return (data.results || []).map(r => ({
    name: r.name, admin1: r.admin1 || '', admin2: r.admin2 || '',
    country: r.country || '', lat: r.latitude, lon: r.longitude,
  }));
}

/* 高德天气（中国气象局数据源，国内更准）。设置里填了 Key 就优先使用，失败回退 Open-Meteo */
const CITY_ADCODE = {
  '北京': '110000', '上海': '310000', '天津': '120000', '重庆': '500000',
  '武汉': '420100', '广州': '440100', '深圳': '440300', '成都': '510100',
  '杭州': '330100', '南京': '320100', '西安': '610100', '苏州': '320500',
  '长沙': '430100', '郑州': '410100', '青岛': '370200', '济南': '370100',
  '大连': '210200', '厦门': '350200', '福州': '350100', '合肥': '340100',
  '昆明': '530100', '贵阳': '520100', '南宁': '450100', '兰州': '620100',
  '太原': '140100', '石家庄': '130100', '哈尔滨': '230100', '长春': '220100',
  '南昌': '360100', '海口': '460100', '呼和浩特': '150100', '乌鲁木齐': '650100',
  '拉萨': '540100', '西宁': '630100', '银川': '640100', '香港': '810000', '澳门': '820000', '台北': '710000',
};

function mapAmapIcon(text) {
  const t = text || '';
  if (t.includes('雷')) return '⛈️';
  if (t.includes('雪')) return '🌨️';
  if (t.includes('雨')) return '🌧️';
  if (t.includes('沙') || t.includes('尘')) return '🌫️';
  if (t.includes('雾') || t.includes('霾')) return '🌫️';
  if (t.includes('阴')) return '☁️';
  if (t.includes('多云')) return '⛅';
  if (t.includes('晴')) return '☀️';
  return '🌤️';
}

async function fetchWeatherAmap(city, key) {
  const cityName = String(city.name || '').split(/[·,,，\s]/)[0] || '武汉';
  let adcode = CITY_ADCODE[cityName];
  if (!adcode) {
    try {
      const g = await fetchJson(`https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(cityName)}&key=${key}`);
      if (g && g.status === '1' && g.geocodes && g.geocodes.length) adcode = g.geocodes[0].adcode;
    } catch { /* 走兜底 */ }
  }
  if (!adcode) throw new Error('高德无法定位该城市');

  const base = await fetchJson(`https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(key)}&city=${adcode}&extensions=base`);
  if (!base || base.status !== '1' || !base.lives || !base.lives.length) {
    throw new Error((base && base.info) || '高德天气失败');
  }
  const live = base.lives[0];
  const today = {
    temperature: Number(live.temperature),
    feelsLike: Number(live.temperature),
    condition: live.weather, icon: mapAmapIcon(live.weather),
    humidity: Number(live.humidity || 60),
    windScale: live.windpower ? live.windpower + '级' : '微风',
    precip: 0, location: cityName, source: 'amap',
  };

  let tomorrow = null;
  try {
    const all = await fetchJson(`https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(key)}&city=${adcode}&extensions=all`);
    const casts = all && all.forecasts && all.forecasts[0] && all.forecasts[0].casts;
    const tmr = casts && casts[1];
    if (tmr) {
      const dayT = Number(tmr.daytemp), nightT = Number(tmr.nighttemp);
      tomorrow = {
        temperature: Math.round((dayT + nightT) / 2),
        feelsLike: Math.round((dayT + nightT) / 2),
        condition: tmr.dayweather, icon: mapAmapIcon(tmr.dayweather),
        tmin: nightT, tmax: dayT, rainProb: 0, humidity: 0,
        windScale: tmr.daypower ? tmr.daypower + '级' : '微风',
        precip: 0, location: cityName, source: 'amap',
      };
    }
  } catch (e) { console.warn('高德预报失败:', e); }
  if (!tomorrow) tomorrow = Object.assign({}, today);
  return { today, tomorrow };
}

async function fetchWeather(city) {
  // 优先：高德天气（填了 Key 才启用；数据源为中国气象局，国内更准）
  if (state.settings && state.settings.amapKey) {
    try {
      return await fetchWeatherAmap(city, state.settings.amapKey);
    } catch (e) {
      console.warn('高德天气不可用，回退 Open-Meteo:', e.message);
    }
  }

  const params = new URLSearchParams({
    latitude: city.lat, longitude: city.lon, timezone: 'auto',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,precipitation',
    hourly: 'apparent_temperature,weather_code,precipitation_probability',
    forecast_days: '2',
  });
  const r = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const c = r.current || {};
  const code = Number(c.weather_code ?? 0);
  const isDay = Number(c.is_day ?? 1);
  const condition = mapWeatherCode(code, isDay);
  const windKmh = Number(c.wind_speed_10m ?? 0);
  const windScale = windKmh < 5 ? 1 : Math.min(12, Math.round(windKmh / 10));
  const today = {
    temperature: Number(c.temperature_2m ?? 20),
    feelsLike: Number(c.apparent_temperature ?? c.temperature_2m ?? 20),
    condition, icon: WEATHER_ICON[condition] || '🌤️',
    humidity: Number(c.relative_humidity_2m ?? 60),
    windScale: `${windScale}级`,
    precip: Number(c.precipitation ?? 0),
    location: city.name || '当前位置',
  };

  /* 明天预报：取明天 7:00-22:00 的逐小时数据汇总 */
  let tomorrow = null;
  try {
    const times = (r.hourly && r.hourly.time) || [];
    const tDate = tomorrowStr();
    let sum = 0, n = 0, codeCount = {}, tmin = Infinity, tmax = -Infinity, rainProb = 0;
    for (let i = 0; i < times.length; i++) {
      if (!String(times[i]).startsWith(tDate)) continue;
      const hour = parseInt(String(times[i]).slice(11, 13), 10);
      if (hour < 7 || hour > 22) continue;
      const at = Number((r.hourly.apparent_temperature || [])[i] ?? 20);
      const wc = Number((r.hourly.weather_code || [])[i] ?? 0);
      const pp = Number((r.hourly.precipitation_probability || [])[i] ?? 0);
      sum += at; n++;
      codeCount[wc] = (codeCount[wc] || 0) + 1;
      if (at < tmin) tmin = at;
      if (at > tmax) tmax = at;
      if (pp > rainProb) rainProb = pp;
    }
    if (n > 0) {
      const ranked = Object.entries(codeCount).sort((a, b) => b[1] - a[1]);
      const domCode = Number(ranked[0][0]);
      const tcond = mapWeatherCode(domCode, 1);
      const feels = Math.round(sum / n);
      tomorrow = {
        temperature: feels,
        feelsLike: feels,
        condition: tcond, icon: WEATHER_ICON[tcond] || '🌤️',
        tmin: Math.round(tmin), tmax: Math.round(tmax),
        rainProb, humidity: 0,
        windScale: today.windScale, precip: 0,
        location: city.name || '当前位置',
      };
    }
  } catch (e) { console.warn('解析明日预报失败:', e); }
  if (!tomorrow) tomorrow = Object.assign({}, today); // 兜底：明天数据缺失时用当前
  return { today, tomorrow };
}

function tomorrowStr() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())}`;
}
function targetDateStr() {
  return state.targetDay === 'today' ? todayStr() : tomorrowStr();
}
function weatherForTarget() {
  const w = state.weather;
  if (!w) return null;
  return state.targetDay === 'today' ? w.today : w.tomorrow;
}

async function loadWeather() {
  const s = state.settings;
  if (!s.city) {
    $('#weatherLoc').textContent = '未设置城市';
    $('#weatherTemp').textContent = '--°';
    $('#weatherSub').textContent = '去「设置」页选择城市';
    $('#weatherIcon').textContent = '🏙️';
    return null;
  }
  $('#weatherLoc').textContent = s.city.name;
  $('#weatherSub').textContent = '正在获取天气…';
  try {
    const w = await fetchWeather(s.city);
    state.weather = w;
    renderWeather(weatherForTarget());
    renderTodayWorn();
    return weatherForTarget();
  } catch {
    const w = {
      today: { temperature: 20, feelsLike: 22, condition: '晴', icon: '🌤️', humidity: 60, windScale: '2级', precip: 0, location: s.city.name },
      tomorrow: { temperature: 20, feelsLike: 21, condition: '晴', icon: '🌤️', tmin: 18, tmax: 24, rainProb: 10, humidity: 60, windScale: '2级', precip: 0, location: s.city.name },
    };
    state.weather = w;
    $('#weatherSub').textContent = '天气获取失败，使用模拟数据（可重试）';
    renderWeather(weatherForTarget());
    renderTodayWorn();
    return weatherForTarget();
  }
}
function renderWeather(w) {
  if (!w) return;
  const isTomorrow = state.targetDay === 'tomorrow';
  $('#weatherLoc').textContent = (isTomorrow ? '明天 · ' : '') + w.location;
  $('#weatherTemp').textContent = Math.round(w.temperature) + '°';
  const src = w.source === 'amap' ? ' · 高德' : '';
  if (isTomorrow && w.tmin !== undefined) {
    $('#weatherSub').textContent = `${w.condition} · 白天体感 ${w.tmin}~${w.tmax}°${w.rainProb ? ` · 降水概率 ${w.rainProb}%` : ''}${src}`;
  } else {
    $('#weatherSub').textContent = `${w.condition} · 体感 ${Math.round(w.feelsLike)}° · 湿度 ${w.humidity}% · ${w.windScale}风${src}`;
  }
  $('#weatherIcon').textContent = w.icon;
}

/* 首页"今天已穿"摘要 */
function renderTodayWorn() {
  const bar = $('#todayWorn');
  if (!bar) return;
  const worn = state.diary.find(d => d.date === todayStr());
  if (worn && worn.items.length) {
    bar.style.display = 'block';
    bar.innerHTML = `✓ 今天已穿：${worn.items.map(it => esc(it.name)).join(' + ')}`;
  } else {
    bar.style.display = 'none';
  }
}

/* 按"今天/明天"切换更新首页文案 */
function updateDayUI() {
  const isTomorrow = state.targetDay === 'tomorrow';
  const gt = $('#goalTitle');
  if (gt) gt.textContent = isTomorrow ? '明天要去做什么？' : '今天要去做什么？';
  const bt = $('#btnGenerateText');
  if (bt) bt.textContent = isTomorrow ? '生成明日搭配' : '生成今日搭配';
}

/* ================= 图片处理 ================= */
function compressImage(file, maxSize = 480, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = src;
  });
}

function dataUrlToFile(dataUrl) {
  try {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new File([buf], 'retry.jpg', { type: mime });
  } catch { return null; }
}

/* ================= AI 推理（onnxruntime-web + u2netp 抠图 + mobilenet 分类） =================
 * 抠图模型 u2netp.onnx 4.4MB（rembg 同款轻量版），分类模型 mobilenetv2.onnx 13.3MB。
 * 全部浏览器内推理，无需服务器。首次使用需下载约 28MB（含运行时），之后浏览器缓存。
 * 所有环节带超时与降级，失败不阻塞保存。
 * 模型下载带实时进度回调（流式 fetch），推理阶段显示不定进度动画。
 */
let _ortPromise = null;
let _ortRetry = 0;

/* 进度回调（由 processUpload 注入） */
let _aiProgress = null;
function setAIProgress(fn) { _aiProgress = fn; }
function reportAIProgress(stage, detail) {
  if (typeof _aiProgress === 'function') { try { _aiProgress(stage, detail); } catch { } }
}

/* 带下载进度的 fetch（ReadableStream 流式读取字节） */
async function progressFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const filename = (url.split('/').pop() || '').split('?')[0];

  if (!res.body || !total) {
    // 无法流式（如缓存命中）→ 直接返回
    reportAIProgress('download', { filename, loaded: total, total, done: true });
    return res;
  }

  const reader = res.body.getReader();
  let loaded = 0;
  const chunks = [];
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastReport > 150) { // 节流 150ms
      lastReport = now;
      reportAIProgress('download', { filename, loaded, total, done: false });
    }
  }
  reportAIProgress('download', { filename, loaded, total, done: true });

  const type = res.headers.get('content-type') || 'application/octet-stream';
  const blob = new Blob(chunks, { type });
  return new Response(blob, {
    status: res.status, statusText: res.statusText, headers: res.headers,
  });
}

function ensureOrt() {
  if (!_ortPromise) {
    // 重试时换 URL 绕过浏览器对失败 ES Module 的缓存
    const suffix = _ortRetry > 0 ? `?r=${_ortRetry}` : '';
    _ortPromise = import('./libs/ort/ort.min.mjs' + suffix).then(ort => {
      ort.env.wasm.numThreads = 1; // GitHub Pages 无 COOP/COEP，单线程稳妥
      return ort;
    });
    // 失败时清缓存，允许下次重试
    _ortPromise.catch(() => { _ortPromise = null; _ortRetry++; });
  }
  return _ortPromise;
}

const _sessions = {};
const _modelBlobs = {}; // 已下载模型的 Blob URL（内存缓存）

/* 预下载模型到内存 Blob（带精确进度），重复调用命中缓存 */
async function ensureModelBlob(modelPath) {
  if (_modelBlobs[modelPath]) return _modelBlobs[modelPath];
  const res = await progressFetch(modelPath);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  _modelBlobs[modelPath] = url;
  return url;
}

function ensureSession(modelPath) {
  if (!_sessions[modelPath]) {
    _sessions[modelPath] = (async () => {
      // 先带进度下载模型 → 再建 session（Blob URL 加载，无需再次网络请求）
      const modelUrl = await ensureModelBlob(modelPath);
      const ort = await ensureOrt();
      reportAIProgress('load', { model: modelPath });
      return ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
    })();
    // 失败时清缓存并重置 ort（wasm 初始化失败后内部状态无法恢复，需新实例），允许下次重试
    _sessions[modelPath].catch(() => {
      delete _sessions[modelPath];
      _ortPromise = null;
      _ortRetry++;
    });
  }
  return _sessions[modelPath];
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || '超时')), ms)),
  ]);
}

/* ---------- 1. AI 抠图（u2netp）---------- */
async function aiRemoveBackground(dataUrl) {
  const [session, ort] = await Promise.all([
    withTimeout(ensureSession('./libs/u2netp.onnx'), 90000, 'AI 模型加载超时'),
    ensureOrt(),
  ]);
  const S = 320;
  const img = await loadImageEl(dataUrl);

  const c1 = document.createElement('canvas');
  c1.width = S; c1.height = S;
  const ctx1 = c1.getContext('2d', { willReadFrequently: true });
  ctx1.drawImage(img, 0, 0, S, S);
  const px = ctx1.getImageData(0, 0, S, S).data;
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    input[i] = (px[i * 4] / 255 - 0.485) / 0.229;
    input[S * S + i] = (px[i * 4 + 1] / 255 - 0.456) / 0.224;
    input[2 * S * S + i] = (px[i * 4 + 2] / 255 - 0.406) / 0.225;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, S, S]);
  const results = await withTimeout(
    session.run({ [session.inputNames[0]]: tensor }),
    60000, 'AI 识别超时'
  );

  const out = results[session.outputNames[0]];
  const d = out.data;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < d.length; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
  const range = (mx - mn) || 1;
  const v = new Uint8ClampedArray(S * S);
  for (let i = 0; i < S * S; i++) v[i] = ((d[i] - mn) / range) * 255;

  /* ---- 连通域分析：一图多件自动分开 ----
   * 二值化 alpha>=60，BFS 标记连通域；
   * 面积 >= 3%（约一件衣服最小占比）算有效件，最多 4 件。 */
  const labels = new Int32Array(S * S); // 0=背景, >0=件id
  const comps = []; // { id, area }
  const stack = [];
  for (let p = 0; p < S * S; p++) {
    if (v[p] < 60 || labels[p]) continue;
    const id = comps.length + 1;
    let area = 0;
    stack.length = 0; stack.push(p);
    while (stack.length) {
      const q = stack.pop();
      if (q < 0 || q >= S * S) continue;
      if (labels[q] || v[q] < 60) continue;
      // 4 邻域（q = y*S+x）
      const x = q % S, y = (q - x) / S;
      labels[q] = id; area++;
      if (x > 0) stack.push(q - 1);
      if (x < S - 1) stack.push(q + 1);
      if (y > 0) stack.push(q - S);
      if (y < S - 1) stack.push(q + S);
    }
    comps.push({ id, area });
  }
  const MIN_AREA = S * S * 0.03;
  const valid = comps.filter(c => c.area >= MIN_AREA)
    .sort((a, b) => b.area - a.area).slice(0, 4);

  // 合成某一件（或全部）的抠图
  const composePiece = (keepId) => {
    const cm = document.createElement('canvas');
    cm.width = S; cm.height = S;
    const ctxm = cm.getContext('2d');
    const md = ctxm.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const on = keepId === 0 ? true : (labels[i] === keepId);
      md.data[i * 4] = 255; md.data[i * 4 + 1] = 255;
      md.data[i * 4 + 2] = 255; md.data[i * 4 + 3] = on ? v[i] : 0;
    }
    ctxm.putImageData(md, 0, 0);

    const c2 = document.createElement('canvas');
    c2.width = img.width; c2.height = img.height;
    const ctx2 = c2.getContext('2d');
    ctx2.drawImage(img, 0, 0);
    ctx2.globalCompositeOperation = 'destination-in';
    ctx2.imageSmoothingEnabled = true;
    ctx2.imageSmoothingQuality = 'high';
    ctx2.drawImage(cm, 0, 0, img.width, img.height);
    ctx2.globalCompositeOperation = 'source-over';
    return trimTransparent(c2, 480);
  };

  if (valid.length > 1) {
    // 多件：逐件合成
    const pieces = valid.map(c => composePiece(c.id));
    // 过滤裁剪后无效的极小件
    const ok = pieces.filter(p => p && p.length > 2000);
    return { pieces: ok.length > 1 ? ok : [composePiece(0)], multiple: ok.length > 1 };
  }
  return { pieces: [composePiece(0)], multiple: false };
}

/* ---------- 2. 快速抠图兜底：纯色背景移除（无网络、无模型，秒级） ---------- */
async function fastRemoveBg(dataUrl) {
  const img = await loadImageEl(dataUrl);
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, W, H);
  const px = imgData.data;

  // 采样四角（各 12x12）估计背景色；四角差异大则背景杂乱，容差放大
  const corner = (x0, y0) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + 12 && y < H; y++)
      for (let x = x0; x < x0 + 12 && x < W; x++) {
        const i = (y * W + x) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
      }
    return [r / n, g / n, b / n];
  };
  const corners = [corner(0, 0), corner(W - 12, 0), corner(0, H - 12), corner(W - 12, H - 12)];
  const bg = corners[0].map((_, k) => corners.reduce((s, cc) => s + cc[k], 0) / 4);
  const spread = Math.max(...corners.map(cc => Math.hypot(cc[0] - bg[0], cc[1] - bg[1], cc[2] - bg[2])));
  const tol = Math.min(90, 34 + spread);

  // 从边缘 floodfill：与背景色接近的连通区域 → 透明
  const visited = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push(x, 0, x, H - 1); }
  for (let y = 0; y < H; y++) { stack.push(0, y, W - 1, y); }
  while (stack.length) {
    const y = stack.pop(); const x = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    if (Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2]) < tol) {
      px[i + 3] = 0;
      stack.push(x - 1, y, x + 1, y, x, y - 1, x, y + 1);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return trimTransparent(c, 480);
}

/* ---------- 3. 自动识别衣物属性（mobilenetv2 + ImageNet 类映射） ---------- */
const CLOTHES_MAP = {
  399: { cat: 'outer', thick: 2, seasons: ['秋', '冬'], zh: '罩袍' },
  400: { cat: 'outer', thick: 2, seasons: ['秋', '冬'], zh: '长袍' },
  433: { cat: 'accessory', thick: 1, seasons: ['夏'], zh: '泳帽' },
  445: { cat: 'bottom', thick: 1, seasons: ['夏'], zh: '泳衣' },
  474: { cat: 'outer', thick: 2, seasons: ['春', '秋'], zh: '开衫' },
  502: { cat: 'shoes', thick: 2, seasons: ['春', '夏', '秋'], zh: '木屐鞋' },
  514: { cat: 'shoes', thick: 3, seasons: ['秋', '冬'], zh: '短靴' },
  515: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋'], zh: '帽子' },
  568: { cat: 'outer', thick: 3, seasons: ['冬'], zh: '皮草大衣' },
  578: { cat: 'bottom', thick: 2, seasons: ['春', '夏', '秋'], zh: '长裙' },
  601: { cat: 'bottom', thick: 2, seasons: ['春', '夏'], zh: '蓬蓬裙' },
  608: { cat: 'bottom', thick: 2, seasons: ['春', '秋', '冬'], zh: '牛仔裤' },
  610: { cat: 'top', thick: 1, seasons: ['春', '夏'], zh: 'T恤' },
  614: { cat: 'outer', thick: 2, seasons: ['春', '秋'], zh: '和风外套' },
  617: { cat: 'outer', thick: 2, seasons: ['春', '秋'], zh: '长外套' },
  630: { cat: 'shoes', thick: 2, seasons: ['春', '夏', '秋'], zh: '乐福鞋' },
  638: { cat: 'top', thick: 1, seasons: ['夏'], zh: '泳装上衣' },
  639: { cat: 'top', thick: 1, seasons: ['夏'], zh: '连体泳衣' },
  652: { cat: 'outer', thick: 3, seasons: ['秋', '冬'], zh: '制服外套' },
  655: { cat: 'bottom', thick: 1, seasons: ['夏'], zh: '短裙' },
  658: { cat: 'accessory', thick: 3, seasons: ['冬'], zh: '手套' },
  679: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋', '冬'], zh: '项链' },
  689: { cat: 'bottom', thick: 2, seasons: ['春', '夏'], zh: '半裙' },
  697: { cat: 'top', thick: 2, seasons: ['春', '秋', '冬'], zh: '睡衣' },
  735: { cat: 'outer', thick: 2, seasons: ['秋', '冬'], zh: '披风' },
  770: { cat: 'shoes', thick: 1, seasons: ['春', '夏', '秋'], zh: '运动鞋' },
  774: { cat: 'shoes', thick: 1, seasons: ['夏'], zh: '凉鞋' },
  775: { cat: 'bottom', thick: 1, seasons: ['夏'], zh: '沙龙裙' },
  806: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋', '冬'], zh: '袜子' },
  808: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋'], zh: '宽檐帽' },
  834: { cat: 'outer', thick: 2, seasons: ['春', '秋', '冬'], zh: '西装' },
  836: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋'], zh: '墨镜' },
  837: { cat: 'accessory', thick: 1, seasons: ['春', '夏', '秋'], zh: '墨镜' },
  841: { cat: 'top', thick: 2, seasons: ['秋', '冬'], zh: '卫衣' },
  842: { cat: 'bottom', thick: 1, seasons: ['夏'], zh: '泳裤' },
  869: { cat: 'outer', thick: 2, seasons: ['秋', '冬'], zh: '风衣' },
};

const THICK_NAMES = { 1: '轻薄', 2: '适中', 3: '厚重' };

/* 返回 { cat, thick, seasons, label, prob } 或 null */
async function classifyCloth(dataUrl) {
  const [session, ort] = await Promise.all([
    withTimeout(ensureSession('./libs/mobilenetv2.onnx'), 90000, '识别模型加载超时'),
    ensureOrt(),
  ]);
  const S = 224;
  const img = await loadImageEl(dataUrl);

  // 贴白底 + letterbox 到 224x224
  const c1 = document.createElement('canvas');
  c1.width = S; c1.height = S;
  const ctx1 = c1.getContext('2d', { willReadFrequently: true });
  ctx1.fillStyle = '#fff';
  ctx1.fillRect(0, 0, S, S);
  const scale = Math.min(S / img.width, S / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx1.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
  const px = ctx1.getImageData(0, 0, S, S).data;

  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    input[i] = (px[i * 4] / 255 - 0.485) / 0.229;
    input[S * S + i] = (px[i * 4 + 1] / 255 - 0.456) / 0.224;
    input[2 * S * S + i] = (px[i * 4 + 2] / 255 - 0.406) / 0.225;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, S, S]);
  const results = await withTimeout(
    session.run({ [session.inputNames[0]]: tensor }),
    30000, '识别超时'
  );

  const logits = results[session.outputNames[0]].data;
  const exps = Array.from(logits, v => Math.exp(v));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sum);
  // top8 中找第一个衣物类
  const top = probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p).slice(0, 8);
  for (const t of top) {
    const hit = CLOTHES_MAP[t.i];
    if (hit) {
      return Object.assign({ prob: t.p }, hit);
    }
  }
  // 没找到衣物类 → 形状启发式兜底（抠图后的前景宽高比）
  const ratio = img.height / img.width;
  if (ratio > 1.7) return { cat: 'bottom', thick: 2, seasons: ['春', '秋', '冬'], label: '下装', prob: 0, fallback: true };
  return null;
}

/* 裁掉全透明边缘并限制尺寸，输出透明 PNG */
function trimTransparent(canvas, maxSize) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: W, height: H } = canvas;
  const data = ctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas.toDataURL('image/png'); // 全透明兜底
  // 留 8px 余量
  minX = Math.max(0, minX - 8); minY = Math.max(0, minY - 8);
  maxX = Math.min(W - 1, maxX + 8); maxY = Math.min(H - 1, maxY + 8);
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const scale = Math.min(1, maxSize / Math.max(bw, bh));
  const c3 = document.createElement('canvas');
  c3.width = Math.max(1, Math.round(bw * scale));
  c3.height = Math.max(1, Math.round(bh * scale));
  const ctx3 = c3.getContext('2d');
  ctx3.imageSmoothingQuality = 'high';
  ctx3.drawImage(canvas, minX, minY, bw, bh, 0, 0, c3.width, c3.height);
  return c3.toDataURL('image/png');
}

/* 主色识别：缩小采样 → 按饱和度/亮度/色相归入颜色关键词 */
function guessColor(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 40; canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 40, 40);
        const { data } = ctx.getImageData(0, 0, 40, 40);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 100) continue; // 跳过透明
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
        if (!n) return resolve('');
        r /= n; g /= n; b /= n;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const light = max / 255;
        let best = '多色', bestDist = Infinity;
        if (sat < 0.18) {
          if (light > 0.82) best = '白';
          else if (light < 0.3) best = '黑';
          else best = '灰';
        } else {
          if (light < 0.35) { best = '黑'; }
          else {
            COLORS.forEach(col => {
              if (col.k === '多色') return;
              const m = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(col.c);
              if (!m) return;
              const cr = parseInt(m[1], 16), cg = parseInt(m[2], 16), cb = parseInt(m[3], 16);
              const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
              if (d < bestDist) { bestDist = d; best = col.k; }
            });
          }
        }
        resolve(best);
      } catch { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

/* ================= 温度档位（移植 AIWardrobe 逻辑） ================= */
function tempProfile(feelsLike) {
  if (feelsLike <= 5) return {
    label: '寒冷', seasons: ['冬'],
    advice: '天气很冷，优先厚羽绒服、羊毛衫、加绒长裤和保暖鞋，围巾手套安排上。',
    thick: { 3: 10, 2: 0, 1: -8 },
  };
  if (feelsLike <= 14) return {
    label: '偏凉', seasons: ['秋', '冬'],
    advice: '体感偏凉，适合轻量叠穿：外套 + 长裤，鞋选包裹性强的款式。',
    thick: { 3: 2, 2: 1, 1: -3 },
  };
  if (feelsLike <= 24) return {
    label: '舒适', seasons: ['春', '秋'],
    advice: '温度适中，保持透气与层次，早晚温差大可以加件薄外套。',
    thick: { 3: -1, 2: 2, 1: 1 },
  };
  if (feelsLike <= 30) return {
    label: '偏热', seasons: ['春', '夏'],
    advice: '有点热，优先透气轻薄的单品，少叠穿。',
    thick: { 3: -3, 2: 1, 1: 3 },
  };
  return {
    label: '炎热', seasons: ['夏'],
    advice: '天气很热，选吸汗透气的轻薄衣物，能少穿就少穿。',
    thick: { 3: -5, 2: -1, 1: 3 },
  };
}

/* ================= 推荐算法 ================= */
function scoreItem(item, profile, goal, weather, settings, rand) {
  let score = 50;
  const reasons = [];

  // 季节匹配（无标签视为四季通用）
  const seasons = item.seasons && item.seasons.length ? item.seasons : ['春', '夏', '秋', '冬'];
  const hit = seasons.some(se => profile.seasons.includes(se));
  if (hit) { score += 30; reasons.push(`适合${profile.label}天气`); }
  else { score -= 5; reasons.push('季节不太匹配'); }

  // 厚薄
  const tb = (profile.thick || {})[item.thick] || 0;
  score += tb;
  if (tb > 0) reasons.push('厚薄正合适');
  else if (tb < 0) reasons.push('厚薄不太合拍');

  // 目标场景
  const goalStyles = GOAL_STYLES[goal] || [];
  if (goalStyles.some(gs => (item.styles || []).includes(gs))) {
    score += 10; reasons.push(`适合${goal}场合`);
  }

  // 颜色偏好 / 避开
  if (settings.favColors.includes(item.color)) { score += 8; reasons.push('你偏爱的颜色'); }
  if (settings.avoidColors.includes(item.color)) { score -= 25; reasons.push('你避开这颜色'); }

  // 风格偏好
  if ((item.styles || []).some(st => settings.favStyles.includes(st))) { score += 6; reasons.push('你偏爱的风格'); }

  // 雨雪天：鞋履防滑加分
  const isRainy = /雨|雪|阵/.test(weather.condition);
  if (item.cat === 'shoes' && isRainy) {
    const text = item.name + (item.tags || []).join('');
    if (/防水|雨靴|短靴|靴/.test(text)) { score += 10; reasons.push('防滑防水'); }
    else { score -= 5; reasons.push('有雨，鞋要防滑'); }
  }

  // 今天刚穿过的衣服轻微减分（自然隔天换装；衣柜够时避开）
  if (item.lastWorn === todayStr()) {
    score -= 6; reasons.push('今天刚穿过');
  }

  // 没洗的降权（洗完再穿；衣柜全没洗时仍能出方案，只是都会提示）
  if (item.washed === false) {
    score -= 15; reasons.push('没洗，先洗再穿');
  }

  // 轻微随机扰动（同一天稳定，第二天自然变化）
  score += Math.floor(rand() * 6) - 3;
  return { score, reasons };
}

function buildPool(goal, weather, rand) {
  const profile = tempProfile(weather.feelsLike);
  const pool = {};
  ['top', 'bottom', 'outer', 'shoes', 'accessory'].forEach(cat => {
    pool[cat] = state.clothes
      .filter(c => c.cat === cat)
      .map(c => Object.assign({ c }, scoreItem(c, profile, goal, weather, state.settings, rand)))
      .sort((a, b) => b.score - a.score);
  });
  return { profile, pool };
}

function pickCandidate(list, n, usedIds) {
  if (!list.length) return null;
  let usable = list.filter(x => !usedIds.has(x.c.id));
  if (!usable.length) usable = list;
  const top = usable.slice(0, 3);
  return top[n % top.length] || usable[0];
}

function generateOutfits(goal, weather) {
  const rand = mulberry32(daySeed());
  const { profile, pool } = buildPool(goal, weather, rand);
  const outfits = [];

  /* 外套按体感温度分档：凉→必备；适中→仅方案A备一件（早晚温差）；热→不推荐 */
  const t = weather.feelsLike;
  const outerMode = t <= 14 ? 'required' : (t <= 24 ? 'optional' : 'none');

  for (let i = 0; i < 3; i++) {
    const usedIds = new Set();
    const o = { profile, goal, items: [], missing: [] };

    const top = pickCandidate(pool.top, i, usedIds);
    const bottom = pickCandidate(pool.bottom, i, usedIds);
    let outer = null;
    if (outerMode === 'required' || (outerMode === 'optional' && i === 0)) outer = pickCandidate(pool.outer, i, usedIds);
    const shoes = pickCandidate(pool.shoes, i, usedIds);
    const acc = pickCandidate(pool.accessory, i, usedIds);

    if (top) { o.items.push({ c: top.c, role: '上装', why: top.reasons.slice(0, 2).join('、') || '基础搭配' }); usedIds.add(top.c.id); }
    else o.missing.push('上装');
    if (bottom) { o.items.push({ c: bottom.c, role: '下装', why: bottom.reasons.slice(0, 2).join('、') || '基础搭配' }); usedIds.add(bottom.c.id); }
    else o.missing.push('下装');
    if (outer) {
      o.items.push({
        c: outer.c, role: '外套',
        why: outerMode === 'optional' ? '早晚凉可备一件，热了脱' : (outer.reasons.slice(0, 2).join('、') || '基础搭配'),
      });
      usedIds.add(outer.c.id);
    } else if (outerMode === 'required') o.missing.push('外套');
    if (shoes) { o.items.push({ c: shoes.c, role: '鞋履', why: shoes.reasons.slice(0, 2).join('、') || '基础搭配' }); usedIds.add(shoes.c.id); }
    else o.missing.push('鞋履');
    if (acc) { o.items.push({ c: acc.c, role: '配饰', why: acc.reasons.slice(0, 2).join('、') || '点缀' }); usedIds.add(acc.c.id); }

    outfits.push(o);
  }
  return outfits;
}

/* ================= 渲染：推荐 ================= */
function renderRecommendation(weather) {
  const box = $('#recoResult');
  const goal = state.goal;
  const outfits = generateOutfits(goal, weather);
  const profile = outfits[0].profile;
  const isTomorrow = state.targetDay === 'tomorrow';
  const targetDate = targetDateStr();
  const dayLabel = isTomorrow ? '明日' : '今日';
  const diaryEntry = state.diary.find(d => d.date === targetDate);

  let html = `<div class="reco-block">
    <div class="reco-head"><h3>${dayLabel}穿搭方案</h3>
      <button onclick="refreshReco()">换一批 ↻</button></div>
    <div class="temp-rule">🧥 ${dayLabel}${isTomorrow && weather.tmin !== undefined ? `白天体感 ${weather.tmin}~${weather.tmax}` : `体感 ${Math.round(weather.feelsLike)}`}°C → <b>${profile.label}</b>：${profile.advice}</div>`;

  /* 固定搭配快捷条：按天气匹配的套装备先展示 */
  const starRand = mulberry32(daySeed());
  const starFits = state.outfits
    .map(o => {
      const rand2 = mulberry32(daySeed()); // 每套独立随机避免同步扰动
      let sum = 0, n = 0;
      o.items.forEach(it => {
        const c = state.clothes.find(x => x.id === it.id);
        if (!c) return;
        const r = scoreItem(c, profile, goal, weather, state.settings, rand2);
        sum += r.score; n++;
      });
      return { o, avg: n ? sum / n : 0 };
    })
    .filter(x => x.o.items.length >= 2 && x.avg >= 62)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);
  if (starFits.length) {
    html += `<div class="star-outfit">
      <div class="star-head">
        <span class="star-name">⭐ 你的固定搭配（适合${dayLabel}）</span>
        <span class="star-fit">一键整套穿</span>
      </div>`;
    starFits.forEach(s => {
      html += `<div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;font-weight:700;color:#8a6d3b">${esc(s.o.name)}</span>
          <button class="pick-btn-mini" data-starwear="${s.o.id}" style="flex:0 0 auto;padding:5px 12px">穿这套</button>
        </div>
        <div class="star-items">${s.o.items.map(it => `<span>${esc(it.name)}</span>`).join('')}</div>
      </div>`;
    });
    html += `</div>`;
  }

  const labels = ['方案 A', '方案 B', '方案 C'];
  // 判断方案是否与方案A重复（衣柜单品不够时会出现）
  const keyOf = o => o.items.map(it => it.c.id).sort().join(',');
  const firstKey = outfits[0] ? keyOf(outfits[0]) : '';
  outfits.forEach((o, idx) => {
    const chosen = diaryEntry && diaryEntry.items.some(it => o.items.some(x => x.c.id === it.id));
    const dupWithFirst = idx > 0 && keyOf(o) === firstKey;
    const reason = idx === 0
      ? '综合得分最高'
      : dupWithFirst ? '衣柜里这类单品还不够多' : (idx === 1 ? '换个风格看看' : '再来一套');
    html += `<div class="outfit-set">
      <div class="outfit-set-head">
        <span class="outfit-badge">${idx === 0 ? '最推荐' : labels[idx]}</span>
        <span class="reason">${reason}</span>
      </div>
      <div class="outfit-items">`;
    o.items.forEach(it => {
      html += `<div class="outfit-item">
        ${it.c.image ? `<img src="${it.c.image}" alt="">` : '<img src="" alt="" style="visibility:hidden">'}
        <div class="oi-info">
          <div class="oi-cat">${it.role}</div>
          <div class="oi-name">${esc(it.c.name)}${it.c.washed === false ? '<span class="wash-flag">🧺 没洗</span>' : ''}</div>
          <div class="oi-why">${esc(it.why)}</div>
        </div>
      </div>`;
    });
    if (o.missing.length) {
      html += `<div class="buy-tip" style="grid-column:span 2">🛒 衣柜里还缺 <b>${o.missing.join('、')}</b>，建议添置：${missingHint(o.missing)}</div>`;
    }
    html += `</div>
      <div class="outfit-actions">
        <button class="btn-secondary pick-btn ${chosen ? 'outfit-picked' : ''}" data-idx="${idx}">${chosen ? `✓ ${dayLabel}穿这套` : '选这套 ✨'}</button>
        <button class="btn-secondary" data-saveoutfit="${idx}" style="flex:0 0 auto;padding:9px 12px" title="存为固定搭配">⭐ 存搭配</button>
      </div>
    </div>`;
  });
  html += `</div>`;
  box.innerHTML = html;

  $$('#recoResult .pick-btn').forEach(btn => {
    btn.onclick = () => pickOutfit(Number(btn.dataset.idx), outfits, weather);
  });
  $$('#recoResult [data-saveoutfit]').forEach(btn => {
    btn.onclick = () => saveOutfitFromReco(Number(btn.dataset.saveoutfit), outfits);
  });
  $$('#recoResult [data-starwear]').forEach(btn => {
    btn.onclick = () => { wearSavedOutfit(Number(btn.dataset.starwear)); renderRecommendation(weather); };
  });
}

function missingHint(missing) {
  const hints = {
    '上装': 'T恤 / 衬衫 / 卫衣', '下装': '牛仔裤 / 休闲裤',
    '外套': '夹克 / 风衣 / 卫衣外套', '鞋履': '运动鞋 / 休闲鞋',
  };
  return missing.map(m => hints[m] || m).join('；');
}

function pickOutfit(idx, outfits, weather) {
  const o = outfits[idx];
  const isTomorrow = state.targetDay === 'tomorrow';
  recordOutfit(o.items.map(it => ({ id: it.c.id, name: it.c.name, cat: it.c.cat, why: it.why })), weather, o.goal);
  renderRecommendation(weather);
  renderTodayWorn();
  toast(isTomorrow ? '已记为明日穿搭 ✓ 今晚不用纠结啦' : '已记录今日穿搭 ✓');
}

/* 把推荐方案存为固定搭配 */
function saveOutfitFromReco(idx, outfits) {
  const o = outfits[idx];
  if (!o || !o.items.length) return;
  const defaultName = '我的搭配 ' + (state.outfits.length + 1);
  const name = prompt('给这套搭配起个名字：', defaultName);
  if (name === null) return;
  const finalName = name.trim() || defaultName;
  state.outfits.unshift({
    id: Date.now(),
    name: finalName,
    items: o.items.map(it => ({ id: it.c.id, name: it.c.name, cat: it.c.cat })),
    createdAt: Date.now(), useCount: 0, lastUsed: '',
  });
  Store.saveOutfits(state.outfits);
  toast(`已存为固定搭配「${finalName}」⭐`);
  renderRecommendation(weatherForTarget()); // 快捷条即时显示
}

function refreshReco() {
  loadWeather().then(w => { if (w) renderRecommendation(w); });
}

/* ================= 渲染：衣柜 ================= */
function renderWardrobe() {
  renderBoxFilter();
  const grid = $('#clothGrid');
  const tab = state.wardrobeTab;
  const list = state.clothes
    .filter(c => (tab === 'all' || c.cat === tab) && (state.wardrobeBox === 'all' || (state.wardrobeBox === '__unwashed' ? c.washed === false : c.box === state.wardrobeBox)))
    .slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // 空状态：完全没衣物 vs 筛选不到（某个位置/类别里没有）
  const emptyEl = $('#wardrobeEmpty');
  if (!state.clothes.length) {
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = '<div class="empty-icon">🧺</div><p>衣柜还是空的</p><p class="empty-sub">点击「添加衣物」，把衣服拍进来<br>之后就能每天自动帮你搭配啦</p>';
  } else if (!list.length) {
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = '<div class="empty-icon">📦</div><p>这个筛选下还没有衣物</p><p class="empty-sub">换个位置或类别看看，或编辑衣物补上收纳位置</p>';
  } else {
    emptyEl.style.display = 'none';
  }
  grid.style.display = list.length ? 'grid' : 'none';

  grid.innerHTML = list.map(c => `
    <div class="cloth-card" data-id="${c.id}">
      <div class="cloth-img">
        ${c.image ? `<img src="${c.image}" alt="${esc(c.name)}">` : '<div class="noimg">👕</div>'}
      </div>
      <div class="cloth-info">
        <div class="cloth-name">${esc(c.name)}</div>
        <div class="cloth-tags">${CAT_NAMES[c.cat] || ''} · ${c.color || ''}${c.seasons ? ' · ' + c.seasons.join('') : ''}</div>
        ${c.box ? `<div class="cloth-box">${boxIcon(c.box)} ${esc(c.box)}</div>` : ''}
        ${c.washed === false ? `<button class="cloth-wash" data-washtoggle="${c.id}">🧺 没洗 · 洗完点此标已洗</button>` : ''}
        ${c.wearCount ? `<div class="cloth-worn">已穿 ${c.wearCount} 次</div>` : ''}
      </div>
    </div>`).join('');

  $$('#clothGrid .cloth-card').forEach(card => {
    card.onclick = () => {
      const item = state.clothes.find(c => c.id === Number(card.dataset.id));
      if (item) openClothModal(item);
    };
  });
  // 没洗 → 洗完一键标已洗（不弹编辑窗）
  $$('#clothGrid [data-washtoggle]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.washtoggle);
      state.clothes = state.clothes.map(c => c.id === id ? Object.assign({}, c, { washed: true }) : c);
      Store.saveClothes(state.clothes);
      renderWardrobe();
      toast('已标记为已洗 ✓');
    };
  });
}

/* ================= 弹窗：添加/编辑衣物 ================= */
let editingId = null;
let pendingImage = null;
/* 多件识别队列：一张照片拆出的多件衣物，逐件填写保存 */
let uploadQueue = [];   // [{ image, cls, color }]
let queueIndex = 0;

/* 把识别结果预填到表单（cls/color 可为 null） */
function applyRecognition(cls, color) {
  if (cls) {
    setChips($('#catChips'), null, false, [cls.cat]);
    setChips($('#thickChips'), null, false, [String(cls.thick)]);
    setChips($('#seasonChips'), null, true, cls.seasons);
    updateBoxChips(cls.cat, null); // 识别到鞋 → 位置选项切换为 地上/袋子里面
  }
  if (color) setChips($('#colorChips'), null, false, [color]);
}

/* 依据识别结果生成默认名称（如「黑 卫衣」），用户可改 */
function suggestName(cls, color) {
  const zh = cls ? (cls.zh || CAT_NAMES[cls.cat]) : '';
  return (color || '') + (zh ? ' ' + zh : '');
}

/* 显示队列中的第 i 件 */
function showQueueItem(i) {
  const it = uploadQueue[i];
  if (!it) return;
  queueIndex = i;
  editingId = null;
  pendingImage = it.image;
  renderPhotoPreview(pendingImage);
  applyRecognition(it.cls, it.color);
  updateBoxChips(chipState($('#catChips'))[0] || 'top', null); // 每件队列重置收纳位置
  setChips($('#washChips'), null, false, ['1']); // 每件队列重置清洗状态为已洗
  $('#clothName').value = suggestName(it.cls, it.color);

  const st = $('#cutStatus');
  const parts = [];
  if (it.cls) { parts.push(it.cls.zh || CAT_NAMES[it.cls.cat]); parts.push(THICK_NAMES[it.cls.thick]); }
  if (it.color) parts.push(it.color);
  st.textContent = `第 ${i + 1}/${uploadQueue.length} 件 · ${(parts.join(' · ') || '未识别')}（可调整）`;
  st.className = 'cut-status ok';
  $('#btnRetryAI').style.display = 'none';
  const del = $('#btnDeleteCloth');
  del.style.display = 'inline-block';
  del.textContent = '跳过此件';
}

function setChips(container, selected, multi, preselect) {
  const chps = container.querySelectorAll('.chip');
  chps.forEach(ch => {
    const val = ch.dataset.cat || ch.dataset.season || ch.dataset.style || ch.dataset.color || ch.dataset.thick || ch.dataset.box || ch.dataset.wash;
    let on = false;
    if (multi) {
      const arr = preselect || [];
      on = arr.includes(val);
    } else {
      const target = (selected !== null && selected !== undefined) ? selected : (preselect && preselect[0]);
      on = target === val;
    }
    ch.classList.toggle('active', on);
  });
}

function chipState(container) {
  return [...container.querySelectorAll('.chip.active')].map(ch =>
    ch.dataset.cat || ch.dataset.season || ch.dataset.style || ch.dataset.color || ch.dataset.thick || ch.dataset.box || ch.dataset.wash);
}

/* ================= 收纳位置 ================= */
/* 衣服四个箱：上箱、下箱、椅子箱、大行李箱；鞋只有：地上、袋子里面 */
const BOX_OPTIONS = {
  cloth: [
    { k: '上箱子', icon: '📦' },
    { k: '下箱子', icon: '📦' },
    { k: '椅子箱子', icon: '📦' },
    { k: '大行李箱', icon: '🧳' },
    { k: '洗衣机里面', icon: '🌀' },
  ],
  shoes: [
    { k: '地上', icon: '🏠' },
    { k: '袋子里面', icon: '🛍️' },
    { k: '洗衣机里面', icon: '🌀' },
  ],
};
function boxIcon(k) {
  const f = [...BOX_OPTIONS.cloth, ...BOX_OPTIONS.shoes].find(o => o.k === k);
  return f ? f.icon : '📦';
}
/* 按类别渲染收纳位置选项；keepBox 是当前选择（换类别后失效则用默认值） */
function updateBoxChips(cat, keepBox) {
  const opts = cat === 'shoes' ? BOX_OPTIONS.shoes : BOX_OPTIONS.cloth;
  const valid = opts.some(o => o.k === keepBox);
  const sel = valid ? keepBox : (cat === 'shoes' ? '地上' : '上箱子');
  $('#boxChips').innerHTML = opts.map(o =>
    `<button class="chip ${o.k === sel ? 'active' : ''}" data-box="${o.k}">${o.icon} ${o.k}</button>`).join('');
}
/* 衣柜页收纳位置筛选（带每处件数，点一下看这个位置里有什么） */
function renderBoxFilter() {
  const counts = {};
  state.clothes.forEach(c => { if (c.box) counts[c.box] = (counts[c.box] || 0) + 1; });
  const opts = [...BOX_OPTIONS.cloth, ...BOX_OPTIONS.shoes].filter((o, i, arr) => arr.findIndex(x => x.k === o.k) === i); // 衣服/鞋共用的位置去重（洗衣机）
  const unwashedN = state.clothes.filter(c => c.washed === false).length;
  $('#boxFilterChips').innerHTML = [
    `<button class="chip ${state.wardrobeBox === 'all' ? 'active' : ''}" data-boxf="all">全部位置 ${state.clothes.length}</button>`,
    ...opts.map(o => `<button class="chip ${state.wardrobeBox === o.k ? 'active' : ''}" data-boxf="${o.k}">${o.icon} ${o.k}${counts[o.k] ? ' ' + counts[o.k] : ''}</button>`),
    `<button class="chip ${state.wardrobeBox === '__unwashed' ? 'active' : ''}" data-boxf="__unwashed">🧺 没洗 ${unwashedN}</button>`,
  ].join('');
}

function renderPhotoPreview(dataUrl) {
  const pv = $('#photoPreview');
  pv.innerHTML = dataUrl
    ? `<img src="${dataUrl}" alt="衣物">`
    : '<div class="photo-placeholder">📷<br><span>拍照或上传</span></div>';
}

function openClothModal(item) {
  editingId = item ? item.id : null;
  pendingImage = item ? item.image : null;
  $('#clothModalTitle').textContent = item ? '编辑衣物' : '添加衣物';
  uploadQueue = []; queueIndex = 0; // 重置多件队列
  $('#btnDeleteCloth').style.display = item ? 'block' : 'none';
  $('#btnDeleteCloth').textContent = '删除';
  $('#clothName').value = item ? item.name : '';
  renderPhotoPreview(pendingImage);
  const st = $('#cutStatus');
  st.textContent = ''; st.className = 'cut-status';
  delete st.dataset.origin;
  $('#btnRetryAI').style.display = 'none';
  $('#aiProgressWrap').style.display = 'none';
  setChips($('#catChips'), null, false, [item ? item.cat : 'top']);
  updateBoxChips(item ? item.cat : 'top', item ? item.box : null);
  setChips($('#washChips'), null, false, [item ? (item.washed === false ? '0' : '1') : '1']);
  setChips($('#colorChips'), null, false, [item ? item.color : '白']);
  setChips($('#seasonChips'), null, true, item ? item.seasons : ['春', '夏', '秋', '冬']);
  setChips($('#styleChips'), null, true, item ? item.styles : []);
  setChips($('#thickChips'), null, false, [String(item ? item.thick : 2)]);
  $('#clothModal').classList.add('open');
}

/* ================= 渲染：日记 ================= */
/* ================= 渲染：搭配页（固定搭配 | 穿搭日记） ================= */
function renderOutfitsPage() {
  const view = state.outfitView;
  $$('#outfitTabs .chip').forEach(c => c.classList.toggle('active', c.dataset.view === view));
  $('#savedOutfitsView').style.display = view === 'saved' ? 'block' : 'none';
  $('#diaryView').style.display = view === 'diary' ? 'block' : 'none';
  if (view === 'saved') renderSavedOutfits();
  else renderDiary();
}

function renderSavedOutfits() {
  const list = state.outfits.slice().sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || b.createdAt - a.createdAt);
  $('#savedEmpty').style.display = list.length ? 'none' : 'block';
  const box = $('#savedOutfitList');
  box.style.display = list.length ? 'block' : 'none';

  box.innerHTML = list.map(o => {
    const clothesNow = state.clothes.filter(c => o.items.some(it => it.id === c.id));
    return `
    <div class="saved-outfit" data-id="${o.id}">
      <div class="saved-head">
        <div>
          <div class="saved-name">⭐ ${esc(o.name)}</div>
          <div class="saved-meta">${o.items.length} 件 · 用过 ${o.useCount || 0} 次${o.lastUsed ? ' · 上次 ' + o.lastUsed : ''}</div>
        </div>
      </div>
      <div class="saved-items">
        ${o.items.map(it => `
          <div class="diary-piece">
            ${imgOfItem(it) ? `<img src="${imgOfItem(it)}" alt="">` : ''}
            <span>${esc(it.name)}</span>
          </div>`).join('')}
      </div>
      <div class="saved-actions">
        <button class="pick-btn-mini" data-wear="${o.id}">✨ 穿这套</button>
        <button class="btn-secondary" data-rename="${o.id}" style="flex:0 0 70px">改名</button>
        <button class="btn-secondary" data-deloutfit="${o.id}" style="flex:0 0 70px;color:var(--danger)">删除</button>
      </div>
      ${clothesNow.length < o.items.length ? `<div class="field-note" style="margin-top:8px;color:var(--danger)">⚠ 有 ${o.items.length - clothesNow.length} 件衣物已从衣柜移除</div>` : ''}
    </div>`;
  }).join('');

  // 事件
  $$('#savedOutfitList [data-wear]').forEach(btn => btn.onclick = () => wearSavedOutfit(Number(btn.dataset.wear)));
  $$('#savedOutfitList [data-rename]').forEach(btn => btn.onclick = () => {
    const o = state.outfits.find(x => x.id === Number(btn.dataset.rename));
    if (!o) return;
    const name = prompt('新名称：', o.name);
    if (name && name.trim()) { o.name = name.trim(); Store.saveOutfits(state.outfits); renderSavedOutfits(); }
  });
  $$('#savedOutfitList [data-deloutfit]').forEach(btn => btn.onclick = () => {
    if (!confirm('删除这套固定搭配？')) return;
    state.outfits = state.outfits.filter(x => x.id !== Number(btn.dataset.deloutfit));
    Store.saveOutfits(state.outfits);
    renderSavedOutfits();
    toast('已删除');
  });
}

/* 穿固定搭配：记入目标日期日记 + 更新统计 */
function wearSavedOutfit(outfitId) {
  const o = state.outfits.find(x => x.id === outfitId);
  if (!o) return;
  const weather = weatherForTarget() || { condition: '晴', temperature: 20, feelsLike: 20 };
  const date = targetDateStr();
  recordOutfit(o.items, weather, state.goal, o.name);
  o.useCount = (o.useCount || 0) + 1;
  o.lastUsed = date;
  Store.saveOutfits(state.outfits);
  const isTomorrow = state.targetDay === 'tomorrow';
  toast(isTomorrow ? `已安排「${o.name}」为明日穿搭 ✓` : `已记录「${o.name}」为今日穿搭 ✓`);
  renderSavedOutfits();
  renderTodayWorn();
}

/* 选衣弹窗（三种模式共用：new 新建固定搭配 / custom 自己挑一身 / diary 修改穿搭记录） */
let outfitPicks = new Set();
let outfitModalMode = 'new';
let diaryEditDate = '';

function openPickModal(mode, date) {
  if (!state.clothes.length) { toast('衣柜还是空的，先添加衣服'); switchPage('wardrobe'); return; }
  outfitModalMode = mode;
  const nameField = $('#outfitNameField');
  const saveBtn = $('#btnSaveOutfit');
  if (mode === 'new') {
    $('#outfitModalTitle').textContent = '新建固定搭配';
    nameField.style.display = '';
    $('#outfitName').value = '我的搭配 ' + (state.outfits.length + 1);
    saveBtn.textContent = '保存搭配';
    outfitPicks = new Set();
  } else if (mode === 'custom') {
    const dayLabel = state.targetDay === 'tomorrow' ? '明天' : '今天';
    $('#outfitModalTitle').textContent = `自己挑一身（记为${dayLabel}穿搭）`;
    nameField.style.display = 'none';
    saveBtn.textContent = '就这样穿 ✓';
    outfitPicks = new Set();
  } else {
    diaryEditDate = date;
    const entry = state.diary.find(d => d.date === date);
    if (!entry) return;
    $('#outfitModalTitle').textContent = `修改穿搭 · ${date}`;
    nameField.style.display = 'none';
    saveBtn.textContent = '保存修改 ✓';
    outfitPicks = new Set(entry.items.map(it => it.id));
  }
  renderOutfitPickGrid(outfitPicks);
  $('#outfitModal').classList.add('open');
}

/* 新建搭配弹窗的衣物多选网格 */
function renderOutfitPickGrid(picks) {
  const grid = $('#outfitPickGrid');
  const list = state.clothes.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  grid.innerHTML = list.map(c => `
    <div class="pick-item ${picks.has(c.id) ? 'picked' : ''}" data-id="${c.id}">
      ${c.image ? `<img src="${c.image}" alt="">` : '<div style="aspect-ratio:1;background:#f2f3f6;border-radius:8px"></div>'}
      <p>${esc(c.name)}</p>
    </div>`).join('');
}

/* 通用：记录一套穿搭到目标日期（日记+穿着统计） */
function recordOutfit(items, weather, goal, source) {
  const list = Store.diary();
  const date = targetDateStr();
  const rest = list.filter(d => d.date !== date);
  rest.unshift({
    date,
    goal: goal || '日常',
    weather: { condition: weather.condition, temperature: weather.temperature, feelsLike: weather.feelsLike },
    items: items.map(it => ({ id: it.id, name: it.name, cat: it.cat, why: source ? '固定搭配' : it.why })),
    profile: '',
  });
  Store.saveDiary(rest);
  state.diary = rest;

  const wornIds = items.map(it => it.id);
  state.clothes = state.clothes.map(c => wornIds.includes(c.id) ? Object.assign({}, c, { wearCount: (c.wearCount || 0) + 1, lastWorn: date }) : c);
  Store.saveClothes(state.clothes);
}

/* 修改/删除穿搭记录后，同步修正衣物的穿着统计 */
function adjustWearStats(oldItems, newItems, date) {
  const oldIds = new Set((oldItems || []).map(it => it.id));
  const newIds = new Set((newItems || []).map(it => it.id));
  state.clothes = state.clothes.map(c => {
    let wc = c.wearCount || 0, lw = c.lastWorn || '';
    if (oldIds.has(c.id) && !newIds.has(c.id)) {
      wc = Math.max(0, wc - 1);
      if (lw === date) lw = '';
    } else if (!oldIds.has(c.id) && newIds.has(c.id)) {
      wc += 1;
      lw = date;
    }
    if (wc !== (c.wearCount || 0) || lw !== (c.lastWorn || '')) return Object.assign({}, c, { wearCount: wc, lastWorn: lw });
    return c;
  });
  Store.saveClothes(state.clothes);
}

function renderDiary() {
  const list = state.diary.slice().sort((a, b) => b.date.localeCompare(a.date));
  const box = $('#diaryList');
  $('#diaryEmpty').style.display = list.length ? 'none' : 'block';
  box.innerHTML = list.map(d => {
    const isPlan = d.date > todayStr();
    const isToday = d.date === todayStr();
    const dateLabel = isPlan ? `📅 ${d.date}（明日计划）`
      : isToday ? `${d.date}（今天）` : d.date;
    return `
    <div class="diary-item">
      <div class="diary-date">${dateLabel}
        <span class="w">${d.weather ? d.weather.condition + ' ' + Math.round(d.weather.temperature) + '°' : ''} · ${d.goal || '日常'}</span>
      </div>
      <div class="diary-items">
        ${d.items.map(it => `
          <div class="diary-piece">
            ${imgOfItem(it) ? `<img src="${imgOfItem(it)}" alt="">` : ''}
            <span>${esc(it.name)}</span>
          </div>`).join('')}
      </div>
      <div class="diary-actions">
        <button class="btn-secondary" data-editdiary="${d.date}">✏️ 修改</button>
        <button class="btn-secondary" data-deldiary="${d.date}" style="color:var(--danger)">删除</button>
      </div>
    </div>`;
  }).join('');

  // 修改：打开选衣弹窗（预选当前这套，增删衣物后保存）
  $$('#diaryList [data-editdiary]').forEach(btn => {
    btn.onclick = () => openPickModal('diary', btn.dataset.editdiary);
  });
  // 删除
  $$('#diaryList [data-deldiary]').forEach(btn => {
    btn.onclick = () => {
      const date = btn.dataset.deldiary;
      if (!confirm(`删除 ${date} 的穿搭记录？`)) return;
      const entry = state.diary.find(x => x.date === date);
      if (entry) adjustWearStats(entry.items, [], date);
      state.diary = state.diary.filter(x => x.date !== date);
      Store.saveDiary(state.diary);
      renderDiary();
      renderTodayWorn();
      renderWardrobe();
      toast('已删除');
    };
  });
}

/* ================= 渲染：设置 ================= */
function renderSettings() {
  const s = state.settings;

  $('#favColorChips').innerHTML = COLORS.map(c =>
    `<button class="chip ${s.favColors.includes(c.k) ? 'active' : ''}" data-color="${c.k}" style="border-left:3px solid ${c.c}">${c.k}</button>`).join('');
  $('#avoidColorChips').innerHTML = COLORS.map(c =>
    `<button class="chip ${s.avoidColors.includes(c.k) ? 'active' : ''}" data-color="${c.k}" style="border-left:3px solid ${c.c}">${c.k}</button>`).join('');
  $('#favStyleChips').innerHTML = STYLES.map(st =>
    `<button class="chip ${s.favStyles.includes(st) ? 'active' : ''}" data-style="${st}">${st}</button>`).join('');

  $('#cityInput').value = s.city ? s.city.name : '';
  $('#cityNote').textContent = s.city
    ? `当前城市：${s.city.name}${s.city.admin1 ? '（' + s.city.admin1 + '）' : ''} · ${s.amapKey ? '高德天气（中国气象局数据）' : 'Open-Meteo 免费接口'}`
    : '天气来自 Open-Meteo 免费接口，无需注册';
  const amapInput = $('#amapKeyInput');
  if (amapInput && document.activeElement !== amapInput) amapInput.value = s.amapKey || '';

  // 云端同步状态回显
  const st2 = $('#syncTokenInput');
  if (st2 && document.activeElement !== st2) st2.value = getSyncToken();
  const meta = getSyncMeta();
  const stEl = $('#syncStatus');
  if (stEl && !stEl.className.includes('busy')) {
    if (meta.lastSyncAt) {
      const d = new Date(meta.lastSyncAt);
      renderSyncStatus('ok', `✓ 上次备份：${d.toLocaleString('zh-CN')} · ${meta.sizeKB || '?'} KB · ${meta.count || 0} 条数据`);
    } else {
      renderSyncStatus('', getSyncToken() ? 'Token 已保存，尚未备份' : '尚未同步');
    }
  }

  // 绑定颜色/风格选择
  $$('#favColorChips .chip').forEach(ch => ch.onclick = () => {
    ch.classList.toggle('active');
    state.settings.favColors = chipState($('#favColorChips'));
    Store.saveSettings(state.settings);
  });
  $$('#avoidColorChips .chip').forEach(ch => ch.onclick = () => {
    ch.classList.toggle('active');
    state.settings.avoidColors = chipState($('#avoidColorChips'));
    Store.saveSettings(state.settings);
  });
  $$('#favStyleChips .chip').forEach(ch => ch.onclick = () => {
    ch.classList.toggle('active');
    state.settings.favStyles = chipState($('#favStyleChips'));
    Store.saveSettings(state.settings);
  });
}

/* ================= 导出 / 导入 ================= */
function exportData() {
  const data = {
    app: 'AI衣柜', version: 1, exportedAt: new Date().toISOString(),
    clothes: Store.clothes(), diary: Store.diary(), outfits: Store.outfits(), settings: Store.settings(),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `AI衣柜备份_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('备份已导出');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'AI衣柜' || !Array.isArray(data.clothes)) throw new Error('格式错误');
      // 导入即瘦身：大图平铺 + 条目去图（旧备份里内嵌的图片不再重复存储）
      const clothes = [];
      for (const c of data.clothes) {
        const copy = Object.assign({}, c);
        copy.image = await flattenImage(copy.image);
        clothes.push(copy);
      }
      Store.saveClothes(clothes);
      Store.saveDiary((data.diary || []).map(d => Object.assign({}, d, { items: stripItemImages(d.items) })));
      Store.saveOutfits((data.outfits || []).map(o => Object.assign({}, o, { items: stripItemImages(o.items) })));
      if (data.settings) Store.saveSettings(Object.assign({}, state.settings, data.settings));
      state.clothes = Store.clothes();
      state.diary = Store.diary();
      state.outfits = Store.outfits();
      state.settings = Store.settings();
      renderAll();
      toast('导入成功 ✓');
    } catch { toast('备份文件格式不正确'); }
  };
  reader.readAsText(file);
}

/* ================= 云端同步（GitHub，离线优先 + 手动同步） ================= */
const SYNC_REPO = 'humphrey688/ai-wardrobe';
const SYNC_FILE = 'cloud-data.json';
const SYNC_API = 'https://api.github.com';

function getSyncToken() { return Store.get('syncToken', ''); }
function getSyncMeta() { return Store.get('syncMeta', {}); }

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* 同步用瘦身图（320px PNG，保留透明）控制云端体积 */
async function shrinkImage(dataUrl, maxSize = 320) {
  if (!dataUrl || !dataUrl.startsWith('data:image')) return dataUrl || '';
  try {
    if (dataUrl.length < 100 * 1024) return dataUrl; // 已够小
    const img = await loadImageEl(dataUrl);
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/png');
    return out.length < dataUrl.length ? out : dataUrl;
  } catch { return dataUrl; }
}

/* 组装同步 payload（日记图片按 id 关联衣物，不重复存） */
async function buildSyncPayload() {
  const clothes = await Promise.all(state.clothes.map(async c => {
    const copy = Object.assign({}, c);
    copy.image = await shrinkImage(c.image);
    return copy;
  }));
  const diary = state.diary.map(d => Object.assign({}, d, {
    items: (d.items || []).map(it => {
      const rest = Object.assign({}, it);
      delete rest.image; // 恢复时按 id 从衣物补
      return rest;
    }),
  }));
  return {
    app: 'AI衣柜', version: 1,
    syncedAt: new Date().toISOString(),
    clothes, diary, outfits: state.outfits, settings: state.settings,
  };
}

async function ghApi(method, path, body, token, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(SYNC_API + path, {
      method, signal: ctrl.signal,
      cache: 'no-store', // 避免 GET sha 被 HTTP 缓存导致 PUT 409
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ai-wardrobe-sync',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = 'HTTP ' + res.status;
      if (res.status === 401) msg += '：Token 无效';
      else if (res.status === 403) msg += '：Token 无仓库写入权限或触发限流';
      else if (res.status === 404) msg += '：文件不存在或仓库不对';
      else if (res.status === 409) msg += '：文件版本冲突';
      throw new Error(msg + ' ' + t.slice(0, 100));
    }
    return res.status === 200 ? res.json() : null;
  } finally { clearTimeout(timer); }
}

async function backupToCloud() {
  const token = getSyncToken();
  if (!token) throw new Error('请先填写 GitHub Token');
  const payload = await buildSyncPayload();
  const json = JSON.stringify(payload);
  const sizeKB = Math.round(json.length / 1024);

  // PUT（处理 CDN 陈旧导致的 409：重新拿 sha 重试，最多 3 次）
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha = null;
    try {
      const cur = await ghApi('GET', `/repos/${SYNC_REPO}/contents/${SYNC_FILE}?ref=main`, null, token, 20000);
      if (cur && cur.sha) sha = cur.sha;
    } catch (e) { /* 404 = 首次备份，无 sha */ }
    try {
      await ghApi('PUT', `/repos/${SYNC_REPO}/contents/${SYNC_FILE}`, {
        message: 'AI衣柜云端备份 · ' + new Date().toLocaleString('zh-CN'),
        content: utf8ToB64(json),
        branch: 'main',
        sha: sha || undefined,
      }, token);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!String(e.message).includes('409')) throw e;
      console.warn('备份版本冲突，2 秒后重试（CDN 同步延迟）...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;

  Store.set('dirty', false); // 备份成功，清除脏标记
  Store.set('syncMeta', {
    lastSyncAt: payload.syncedAt,
    sizeKB, count: payload.clothes.length + payload.diary.length + payload.outfits.length,
  });
  return { sizeKB };
}

async function restoreFromCloud() {
  const token = getSyncToken();
  if (!token) throw new Error('请先填写 GitHub Token');
  const cur = await ghApi('GET', `/repos/${SYNC_REPO}/contents/${SYNC_FILE}?ref=main`, null, token, 30000);
  if (!cur || !cur.content) throw new Error('云端还没有备份，请先「备份到云端」');
  const data = JSON.parse(b64ToUtf8(cur.content));
  if (data.app !== 'AI衣柜' || !Array.isArray(data.clothes)) throw new Error('云端数据格式不正确');
  const stats = await applyCloudPayload(data);
  Store.set('dirty', false);
  return Object.assign(stats, { syncedAt: data.syncedAt });
}

/* 把云端数据应用到本地（导入即瘦身：大图平铺、条目不存图），返回统计 */
async function applyCloudPayload(data) {
  const clothes = [];
  for (const c of (data.clothes || [])) {
    const copy = Object.assign({}, c);
    copy.image = await flattenImage(copy.image);
    clothes.push(copy);
  }
  const diary = (data.diary || []).map(d => Object.assign({}, d, { items: stripItemImages(d.items) }));
  const outfits = (data.outfits || []).map(o => Object.assign({}, o, { items: stripItemImages(o.items) }));
  Store.saveClothes(clothes);
  Store.saveDiary(diary);
  Store.saveOutfits(outfits);
  if (data.settings) Store.saveSettings(Object.assign({}, data.settings, { city: data.settings.city || null }));
  state.clothes = Store.clothes();
  state.diary = Store.diary();
  state.outfits = Store.outfits();
  state.settings = Store.settings();
  const meta = getSyncMeta();
  Store.set('syncMeta', Object.assign({}, meta, { lastSyncAt: data.syncedAt }));
  renderAll();
  renderTodayWorn();
  return { count: clothes.length, diaryCount: diary.length, outfitCount: outfits.length };
}

/* 公开拉取云端数据（无需 Token，公开仓库可直接读；no-store 保证最新） */
async function fetchCloudDataPublic() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    // 走 api.github.com（国内可用，参考 AP 店铺经验；不用会缓存陈旧数据的 CDN）
    const res = await fetch(`https://api.github.com/repos/${SYNC_REPO}/contents/${SYNC_FILE}?ref=main`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal,
      cache: 'no-store', // 关键：绕过 HTTP 缓存，保证拿到最新备份
    });
    if (!res.ok) return null; // 限流/无数据：静默降级，不影响本地使用
    const json = await res.json();
    if (!json || !json.content) return null;
    const data = JSON.parse(b64ToUtf8(json.content));
    if (data.app !== 'AI衣柜' || !Array.isArray(data.clothes)) return null;
    return data;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/* 打开页面时检查云端更新：
 * - 本地为空 + 云端有数据 → 自动载入（访客/新设备，打开就是最新的）
 * - 本地有数据 + 云端更新 → 首页提示条，一键载入
 */
async function checkCloudUpdate() {
  const data = await fetchCloudDataPublic();
  if (!data) return; // 无云端数据或网络失败：静默，不影响本地使用
  const localEmpty = state.clothes.length === 0 && state.diary.length === 0;
  const meta = getSyncMeta();
  const cloudNewer = !meta.lastSyncAt || (data.syncedAt && data.syncedAt > meta.lastSyncAt);

  if (localEmpty) {
    // 访客或新设备：自动载入云端衣柜
    const stats = await applyCloudPayload(data);
    renderCloudBar('loaded', `☁ 已载入共享衣柜：${stats.count} 件衣物 · ${stats.outfitCount} 套搭配（备份于 ${new Date(data.syncedAt).toLocaleString('zh-CN')}）`);
    toast('已同步云端衣柜 ✓');
    return;
  }
  if (cloudNewer) {
    // 本地有数据但云端更新：提示载入
    renderCloudBar('update', `☁ 云端衣柜有更新（${new Date(data.syncedAt).toLocaleString('zh-CN')}）`, async () => {
      await applyCloudPayload(data);
      Store.set('dirty', false);
      renderCloudBar('loaded', '☁ 已更新到云端最新版本 ✓');
      toast('已载入云端最新衣柜 ✓');
    });
  }
}

/* 有 Token 且数据有变动 → 打开页面时自动静默备份（别人打开永远是最新） */
async function autoBackupIfNeeded() {
  const token = getSyncToken();
  if (!token) return;
  if (!Store.get('dirty', false)) return;
  try {
    await backupToCloud();
    Store.set('dirty', false);
    renderSyncStatus('ok', '✓ 已自动备份最新数据到云端');
    console.log('自动备份完成');
  } catch (e) {
    console.warn('自动备份失败（下次打开重试）:', e.message);
  }
}

/* 首页云端提示条 */
function renderCloudBar(type, text, onClick) {
  let bar = $('#cloudBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'cloudBar';
    bar.className = 'cloud-bar';
    const ref = $('#daySwitch');
    ref.parentNode.insertBefore(bar, ref.nextSibling);
  }
  bar.style.display = 'block';
  bar.className = 'cloud-bar ' + type;
  if (onClick) {
    bar.innerHTML = `${esc(text)} <button class="cloud-load-btn">载入</button>`;
    bar.querySelector('.cloud-load-btn').onclick = onClick;
  } else {
    bar.textContent = text;
    // 20 秒后自动收起
    clearTimeout(bar._timer);
    bar._timer = setTimeout(() => { bar.style.display = 'none'; }, 20000);
  }
}

function renderSyncStatus(cls, text) {
  const el = $('#syncStatus');
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

/* ================= 页面切换 ================= */
function switchPage(page) {
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#page-' + page);
  if (target) target.classList.add('active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  if (page === 'wardrobe') renderWardrobe();
  if (page === 'outfits') renderOutfitsPage();
  if (page === 'settings') renderSettings();
}

function renderAll() {
  renderWardrobe(); renderOutfitsPage(); renderSettings();
}

/* ================= 初始化 ================= */
async function init() {
  // Service Worker：缓存 /libs/ 模型与运行时（约 28MB，内容不变），下载一次永久生效，页面更新不受影响
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW 注册失败:', err));
  }

  state.clothes = Store.clothes();
  state.diary = Store.diary();
  state.outfits = Store.outfits();
  state.settings = Store.settings();

  // 存储瘦身迁移：旧数据大图平铺、日记/搭配去内嵌图（修复存储爆满导致保存失败）
  await migrateStorage();

  // 顶部日期
  $('#topDate').textContent = dateCN();

  // 底部导航
  $$('.tab').forEach(t => t.onclick = () => switchPage(t.dataset.page));
  $('#btnSettingsJump').onclick = () => switchPage('settings');

  // 目标场景 chips
  $$('#goalChips .chip').forEach(ch => ch.onclick = () => {
    $$('#goalChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    state.goal = ch.dataset.goal;
  });

  // 今天/明天切换（默认面向明天）
  $$('#daySwitch .chip').forEach(ch => ch.onclick = () => {
    $$('#daySwitch .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    state.targetDay = ch.dataset.day;
    updateDayUI();
    const w = weatherForTarget();
    if (w) {
      renderWeather(w);
      renderRecommendation(w); // 已有结果时按新目标重算
    }
  });

  // 生成推荐
  $('#btnGenerate').onclick = async () => {
    if (!state.clothes.length) { toast('衣柜还是空的，先去添加衣服吧'); switchPage('wardrobe'); return; }
    const btn = $('#btnGenerate');
    btn.disabled = true;
    btn.querySelector('.spark').textContent = '⏳';
    try {
      const w = await loadWeather();
      if (w) renderRecommendation(w);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      btn.disabled = false;
      btn.querySelector('.spark').textContent = '✨';
    }
  };

  // 添加衣物 / 拍照上传
  $('#btnAddCloth').onclick = () => openClothModal();
  $('#photoPicker').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    processUpload(file);
  };

  // 「重新识别」按钮（AI 失败后可重试）
  $('#btnRetryAI').onclick = () => {
    if (!pendingImage) return;
    const st = $('#cutStatus');
    if (st.dataset.origin) {
      // 用原图重跑完整识别流程
      const origin = st.dataset.origin;
      const fakeFile = dataUrlToFile(origin);
      if (fakeFile) { processUpload(fakeFile); return; }
    }
    toast('请重新上传照片');
  };

  async function processUpload(file) {
    const st = $('#cutStatus');
    const wrap = $('#aiProgressWrap');
    const bar = $('#aiProgressBar');
    const ptext = $('#aiProgressText');
    const barBox = wrap.querySelector('.progress-bar');

    // 进度 UI 控制
    const showIndeterminate = (text) => {
      wrap.style.display = 'block';
      barBox.classList.add('indeterminate');
      bar.style.width = '30%';
      ptext.innerHTML = text;
    };
    const showDownload = (loaded, total, speed) => {
      wrap.style.display = 'block';
      barBox.classList.remove('indeterminate');
      const pct = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
      bar.style.width = pct + '%';
      const mb = (n) => (n / 1048576).toFixed(1);
      ptext.innerHTML = total
        ? `下载 AI 模型 ${pct}% <span class="speed">(${mb(loaded)} / ${mb(total)} MB${speed ? ' · ' + speed : ''})</span>`
        : `下载 AI 模型… ${mb(loaded)} MB`;
    };
    const hideProgress = () => { wrap.style.display = 'none'; };

    // AI 进度回调（节流在 progressFetch 里已做）
    let downStart = 0, downLoaded0 = 0;
    setAIProgress((stage, d) => {
      if (stage === 'download') {
        if (!d.done) {
          const now = Date.now();
          if (!downStart) { downStart = now; downLoaded0 = d.loaded; }
          const dt = (now - downStart) / 1000;
          if (d.total && dt > 1) {
            const speed = (d.loaded - downLoaded0) / dt / 1048576;
            showDownload(d.loaded, d.total, speed.toFixed(1) + ' MB/s');
          } else {
            showDownload(d.loaded, d.total);
          }
        } else if (d.total) {
          showDownload(d.total, d.total);
        }
      } else if (stage === 'load') {
        showIndeterminate('模型加载初始化中…');
      }
    });

    delete st.dataset.origin;
    try {
      // 1. 压缩并立即预览原图
      st.textContent = '正在处理照片…';
      st.className = 'cut-status busy';
      const origin = await compressImage(file, 640, 0.9);
      st.dataset.origin = origin; // 留作重试
      pendingImage = origin;
      renderPhotoPreview(pendingImage);

      // 2. AI 抠图（u2netp，自动分件；失败 → 纯色背景移除兜底）
      st.textContent = '';
      showIndeterminate('AI 正在识别衣物并抠图…');
      st.className = 'cut-status busy';
      let pieces = null, multiple = false, cutMode = 'ai';
      try {
        const r = await aiRemoveBackground(origin);
        pieces = r.pieces; multiple = r.multiple;
      } catch (err) {
        console.warn('AI 抠图失败，走快速兜底:', err.message);
        pieces = null;
      }
      hideProgress();

      if (!pieces) {
        st.textContent = 'AI 模型加载失败，尝试快速抠图…';
        try {
          const cut = await fastRemoveBg(origin);
          pieces = [cut];
          cutMode = 'fast';
        } catch { pieces = [origin]; cutMode = 'none'; }
      }
      uploadQueue = []; queueIndex = 0;

      if (multiple && pieces.length > 1) {
        // 3a. 多件：逐件识别（品类/颜色），入队
        for (let i = 0; i < pieces.length; i++) {
          showIndeterminate(`正在识别第 ${i + 1}/${pieces.length} 件（品类/颜色）…`);
          const cls = await classifyCloth(pieces[i]).catch(() => null);
          const color = await guessColor(pieces[i]).catch(() => '');
          uploadQueue.push({ image: pieces[i], cls, color });
        }
        hideProgress();
        setAIProgress(null);
        showQueueItem(0);
        toast(`识别到 ${uploadQueue.length} 件衣物，逐件确认保存`);
        return;
      }

      // 3b. 单件：现有流程
      pendingImage = pieces[0];
      renderPhotoPreview(pendingImage);

      // 识别衣物属性（品类/厚薄/季节）
      st.textContent = '正在识别衣物类型…';
      st.className = 'cut-status busy';
      showIndeterminate('正在识别衣物类型（品类/厚薄/季节）…');
      let cls = null;
      if (cutMode !== 'none') {
        cls = await classifyCloth(pendingImage).catch(err => { console.warn('分类失败:', err.message); return null; });
      }
      hideProgress();

      // 4. 颜色识别（抠图后的前景更准）
      const guessed = await guessColor(pendingImage).catch(() => '');

      // 5. 预填识别结果（用户可再调整）
      const parts = [];
      applyRecognition(cls, guessed);
      if (cls) {
        parts.push(cls.zh || CAT_NAMES[cls.cat]);
        parts.push(THICK_NAMES[cls.thick]);
      } else {
        parts.push('类别未识别');
      }
      if (guessed) parts.push(guessed);
      const autoName = suggestName(cls, guessed);
      if (autoName && !$('#clothName').value.trim()) $('#clothName').value = autoName;

      // 6. 状态汇总
      hideProgress();
      setAIProgress(null);
      if (cutMode === 'ai') {
        st.textContent = '已自动抠图 ✓ 识别：' + parts.join(' · ') + '（可调整）';
        st.className = 'cut-status ok';
        $('#btnRetryAI').style.display = 'none';
      } else if (cutMode === 'fast') {
        st.textContent = 'AI 模型加载失败，已用快速抠图。识别：' + parts.join(' · ');
        st.className = 'cut-status err';
        $('#btnRetryAI').style.display = 'inline-block';
      } else {
        st.textContent = '抠图不可用（已保留原图）。识别：' + parts.join(' · ') + '，可手动填写后保存';
        st.className = 'cut-status err';
        $('#btnRetryAI').style.display = 'inline-block';
      }
    } catch (err) {
      console.error('上传处理失败:', err);
      hideProgress();
      setAIProgress(null);
      st.textContent = '处理失败：' + (err.message || '未知错误') + '。可重试或直接保存';
      st.className = 'cut-status err';
      $('#btnRetryAI').style.display = 'inline-block';
    } finally {
      hideProgress();
      setAIProgress(null);
    }
  }

  // 弹窗交互（单选：类别/颜色/厚薄/收纳位置；多选：季节/风格）
  $('#catChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#catChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    updateBoxChips(ch.dataset.cat, chipState($('#boxChips'))[0]); // 换类别 → 收纳位置选项跟着切
  });
  $('#boxChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#boxChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
  });
  $('#washChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#washChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
  });
  $('#colorChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#colorChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
  });
  $('#thickChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#thickChips .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
  });
  ['seasonChips', 'styleChips'].forEach(id => {
    $('#' + id).addEventListener('click', ev => {
      const ch = ev.target.closest('.chip');
      if (ch) ch.classList.toggle('active');
    });
  });

  // 保存衣物（多件队列：保存后自动切下一件）
  $('#btnSaveCloth').onclick = async () => {
    const name = $('#clothName').value.trim();
    if (!name) { toast('给衣物起个名字吧'); return; }
    const cat = chipState($('#catChips'))[0] || 'top';
    const box = chipState($('#boxChips'))[0] || (cat === 'shoes' ? '地上' : '上箱子');
    const washed = chipState($('#washChips'))[0] !== '0'; // 没选或选已洗都算已洗
    const color = chipState($('#colorChips'))[0] || '多色';
    const seasons = chipState($('#seasonChips'));
    const styles = chipState($('#styleChips'));
    const thick = Number(chipState($('#thickChips'))[0] || 2);
    // 保存前瘦身：大 PNG 抠图平铺成白底 JPEG，控制本地存储体积
    if (pendingImage) pendingImage = await flattenImage(pendingImage);
    const list = Store.clothes();

    let cloth;
    if (editingId) {
      const idx = list.findIndex(c => c.id === editingId);
      if (idx >= 0) {
        cloth = Object.assign({}, list[idx], {
          name, cat, color, seasons, styles, thick, box, washed, image: pendingImage,
        });
        list[idx] = cloth;
      }
    }
    if (!cloth) {
      cloth = { id: Date.now(), name, cat, color, seasons, styles, thick, box, washed, image: pendingImage, createdAt: Date.now(), wearCount: 0, lastWorn: '' };
      list.unshift(cloth);
    }
    Store.saveClothes(list);
    state.clothes = list;
    renderWardrobe();

    // 多件队列：还有下一件 → 切换；全部完成 → 关闭
    if (!editingId && uploadQueue.length) {
      if (queueIndex < uploadQueue.length - 1) {
        showQueueItem(queueIndex + 1);
        toast(`已保存 ✓ 还剩 ${uploadQueue.length - queueIndex - 1} 件待确认`);
        return;
      }
      uploadQueue = []; queueIndex = 0;
      $('#clothModal').classList.remove('open');
      toast('一套全部录入完成 🎉');
      return;
    }
    $('#clothModal').classList.remove('open');
    toast(editingId ? '已保存 ✓' : '已加入衣柜 🎉');
  };

  // 删除衣物（多件队列模式下 = 跳过此件）
  $('#btnDeleteCloth').onclick = () => {
    if (!editingId && uploadQueue.length) {
      if (queueIndex < uploadQueue.length - 1) {
        showQueueItem(queueIndex + 1);
        toast(`已跳过，还剩 ${uploadQueue.length - queueIndex - 1} 件`);
      } else {
        uploadQueue = []; queueIndex = 0;
        $('#clothModal').classList.remove('open');
        toast('已跳过最后一件');
      }
      return;
    }
    if (!confirm('确定删除这件衣物吗？')) return;
    state.clothes = state.clothes.filter(c => c.id !== editingId);
    Store.saveClothes(state.clothes);
    $('#clothModal').classList.remove('open');
    renderWardrobe();
    toast('已删除');
  };
  // 点击遮罩关闭
  $('#clothModal').addEventListener('click', ev => {
    if (ev.target === $('#clothModal')) $('#clothModal').classList.remove('open');
  });

  // 衣柜分类 tab
  $('#wardrobeTabs').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $$('#wardrobeTabs .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    state.wardrobeTab = ch.dataset.cat;
    renderWardrobe();
  });

  // 衣柜收纳位置筛选（动态 chips，事件委托）
  $('#boxFilterChips').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    state.wardrobeBox = ch.dataset.boxf;
    renderWardrobe();
  });

  // 搭配页子Tab切换（固定搭配 | 穿搭日记）
  $('#outfitTabs').addEventListener('click', ev => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    state.outfitView = ch.dataset.view;
    renderOutfitsPage();
  });

  // 新建固定搭配 / 自己挑一身（共用选衣弹窗）
  $('#btnNewOutfit').onclick = () => openPickModal('new');
  $('#btnCustomPick').onclick = () => openPickModal('custom');
  $('#outfitPickGrid').addEventListener('click', ev => {
    const item = ev.target.closest('.pick-item');
    if (!item) return;
    const id = Number(item.dataset.id);
    if (outfitPicks.has(id)) outfitPicks.delete(id); else outfitPicks.add(id);
    item.classList.toggle('picked', outfitPicks.has(id));
  });
  $('#btnCancelOutfit').onclick = () => $('#outfitModal').classList.remove('open');
  $('#outfitModal').addEventListener('click', ev => {
    if (ev.target === $('#outfitModal')) $('#outfitModal').classList.remove('open');
  });
  $('#btnSaveOutfit').onclick = () => {
    if (outfitModalMode === 'diary') {
      // 修改穿搭记录：只改衣物清单，日期/天气/场景保留
      if (!outfitPicks.size) { toast('至少选 1 件'); return; }
      const entry = state.diary.find(d => d.date === diaryEditDate);
      if (!entry) { $('#outfitModal').classList.remove('open'); return; }
      const items = state.clothes.filter(c => outfitPicks.has(c.id))
        .map(c => ({ id: c.id, name: c.name, cat: c.cat, why: '手动调整' }));
      adjustWearStats(entry.items, items, diaryEditDate);
      entry.items = items;
      Store.saveDiary(state.diary);
      $('#outfitModal').classList.remove('open');
      renderDiary();
      renderTodayWorn();
      renderWardrobe();
      toast('穿搭记录已修改 ✓');
      return;
    }
    if (outfitModalMode === 'custom') {
      // 自己挑一身：记入今天/明天的日记
      if (outfitPicks.size < 2) { toast('至少选 2 件组成一套'); return; }
      const weather = weatherForTarget() || { condition: '晴', temperature: 20, feelsLike: 20 };
      const items = state.clothes.filter(c => outfitPicks.has(c.id))
        .map(c => ({ id: c.id, name: c.name, cat: c.cat, why: '自己挑的' }));
      const isTomorrow = state.targetDay === 'tomorrow';
      recordOutfit(items, weather, state.goal);
      $('#outfitModal').classList.remove('open');
      renderTodayWorn();
      renderRecommendation(weatherForTarget());
      toast(isTomorrow ? '已记为明日穿搭 ✓ 今晚不用纠结啦' : '已记录今日穿搭 ✓');
      return;
    }
    // new：存为固定搭配
    if (outfitPicks.size < 2) { toast('至少选 2 件组成一套'); return; }
    const name = $('#outfitName').value.trim() || ('我的搭配 ' + (state.outfits.length + 1));
    const items = state.clothes.filter(c => outfitPicks.has(c.id))
      .map(c => ({ id: c.id, name: c.name, cat: c.cat }));
    state.outfits.unshift({ id: Date.now(), name, items, createdAt: Date.now(), useCount: 0, lastUsed: '' });
    Store.saveOutfits(state.outfits);
    $('#outfitModal').classList.remove('open');
    state.outfitView = 'saved';
    renderOutfitsPage();
    toast(`固定搭配「${name}」已保存 ⭐`);
  };

  // 城市搜索
  $('#btnCitySearch').onclick = doCitySearch;
  $('#cityInput').addEventListener('keydown', ev => { if (ev.key === 'Enter') doCitySearch(); });
  async function doCitySearch() {
    const q = $('#cityInput').value.trim();
    if (!q) return;
    const box = $('#cityResults');
    box.innerHTML = '<div class="loading-dots"><i></i><i></i><i></i></div>';
    try {
      const cities = await searchCity(q);
      if (!cities.length) {
        box.innerHTML = '<div class="city-item">没找到该城市，换个关键词试试</div>';
        return;
      }
      box.innerHTML = cities.map(c =>
        `<div class="city-item" data-i="${cities.indexOf(c)}">${esc(c.name)}${c.admin1 ? ' · ' + esc(c.admin1) : ''}${c.country ? ' · ' + esc(c.country) : ''}</div>`
      ).join('');
      $$('#cityResults .city-item').forEach((el, i) => el.onclick = () => {
        const c = cities[i];
        state.settings.city = { name: c.name, admin1: c.admin1, lat: c.lat, lon: c.lon };
        Store.saveSettings(state.settings);
        box.innerHTML = '';
        $('#cityNote').textContent = `已选择：${c.name}`;
        loadWeather();
        toast(`已切换到 ${c.name}`);
      });
    } catch {
      box.innerHTML = '<div class="city-item">网络不可用，稍后重试</div>';
    }
  }

  // 高德天气 Key：填了立即切换为中国气象局数据源（与手机自带天气一致）
  $('#amapKeyInput').onchange = () => {
    const k = $('#amapKeyInput').value.trim();
    state.settings.amapKey = k;
    Store.saveSettings(state.settings);
    renderSettings();
    loadWeather();
    toast(k ? '高德 Key 已保存，天气将用中国气象局数据 ✓' : '已清空 Key，改用 Open-Meteo 免费接口');
  };

  // 数据导出/导入/清空
  $('#btnExport').onclick = exportData;
  $('#btnImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => {
    if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  };
  $('#btnWipe').onclick = () => {
    if (!confirm('确定清空所有衣物和日记吗？此操作不可恢复！')) return;
    localStorage.removeItem('aiwardrobe_clothes');
    localStorage.removeItem('aiwardrobe_diary');
    localStorage.removeItem('aiwardrobe_outfits');
    state.clothes = []; state.diary = []; state.outfits = [];
    renderAll();
    toast('已清空');
  };

  // 云端同步（GitHub）
  $('#syncTokenInput').onchange = () => {
    Store.set('syncToken', $('#syncTokenInput').value.trim());
    renderSyncStatus('', $('#syncTokenInput').value.trim() ? 'Token 已保存 ✓ 点击「备份到云端」试试' : '尚未同步');
    toast('Token 已保存');
  };
  $('#btnSyncUp').onclick = async () => {
    if (!getSyncToken()) { renderSyncStatus('err', '请先填写 GitHub Token'); toast('请先填写 Token'); return; }
    const btn = $('#btnSyncUp');
    btn.disabled = true;
    renderSyncStatus('busy', '正在备份到云端…（衣物较多时需等待）');
    try {
      const { sizeKB } = await backupToCloud();
      const t = new Date();
      const meta = getSyncMeta();
      renderSyncStatus('ok', `✓ 已备份 ${sizeKB} KB · ${t.getHours()}:${fmt(t.getMinutes())}（衣物+日记共 ${meta.count || ''} 条）`);
      toast('云端备份成功 ✓');
    } catch (e) {
      console.warn('备份失败:', e);
      renderSyncStatus('err', '✗ 备份失败：' + (e.name === 'AbortError' ? '网络超时，请重试' : e.message) + '（点击按钮重试）');
      toast('备份失败，可重试');
    } finally {
      btn.disabled = false;
    }
  };
  $('#btnSyncDown').onclick = async () => {
    if (!getSyncToken()) { renderSyncStatus('err', '请先填写 GitHub Token'); toast('请先填写 Token'); return; }
    if (!confirm('将用云端数据覆盖本机当前数据，确定恢复？')) return;
    const btn = $('#btnSyncDown');
    btn.disabled = true;
    renderSyncStatus('busy', '正在从云端拉取…');
    try {
      const r = await restoreFromCloud();
      renderSyncStatus('ok', `✓ 已恢复 ${r.count} 件衣物 · ${r.outfitCount} 套搭配 · ${r.diaryCount} 条日记（云端备份于 ${new Date(r.syncedAt).toLocaleString('zh-CN')}）`);
      toast('云端恢复成功 ✓');
    } catch (e) {
      console.warn('恢复失败:', e);
      renderSyncStatus('err', '✗ 恢复失败：' + (e.name === 'AbortError' ? '网络超时，请重试' : e.message));
      toast('恢复失败，可重试');
    } finally {
      btn.disabled = false;
    }
  };

  // 初始渲染
  renderWardrobe();
  renderOutfitsPage();
  renderSettings();
  updateDayUI();
  renderTodayWorn();
  loadWeather();
  // 云端同步：检查更新（访客自动载入）+ 主人有变动时自动备份
  checkCloudUpdate();
  autoBackupIfNeeded();
}

document.addEventListener('DOMContentLoaded', init);