// ==UserScript==
// @name         租房筛选助手（贝壳 / 安居客：面积 / 通勤 / 房龄 / 停车）
// @namespace    https://github.com/zhang-dc/ke-rent-filter
// @version      2.7.3
// @description  帮租客和租赁中介整理、比较贝壳、安居客地图找房上的房源：按面积、通勤时间（自行车 / 步行 / 地铁）、房龄、每平米租金、停车条件筛选，标在地图上，可收藏、拉黑和导出。
// @author       zhang-dc
// @match        https://map.ke.com/map/*
// @match        https://*.anjuke.com/community/*
// @match        https://*.zu.anjuke.com/ditu*
// @match        https://*.zu.anjuke.com/map/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @connect      ke.com
// @connect      anjuke.com
// @run-at       document-start
// @homepageURL  https://github.com/zhang-dc/ke-rent-filter
// @supportURL   https://github.com/zhang-dc/ke-rent-filter/issues
// @downloadURL  https://raw.githubusercontent.com/zhang-dc/ke-rent-filter/main/ke-rent-filter.user.js
// @updateURL    https://raw.githubusercontent.com/zhang-dc/ke-rent-filter/main/ke-rent-filter.user.js
// @license      MIT
// ==/UserScript==

/* ============================================================================
 * 贝壳租房筛选助手
 *   帮租客和租赁中介按「面积 / 到某地的距离 / 每平米租金 / 停车」整理、比较房源。
 *   只读取页面上本来就能看到的房源信息，不改动任何数据；结果只存在本地浏览器。
 *
 * 为什么按面积排序查询
 *   地图找房的筛选项里没有「面积」，只能用「几居」近似，误差很大。
 *   查询时按面积从大到小排序，一旦低于你设的面积下限就停止翻页，
 *   既查得全，翻页次数也少（通常 30 页左右）。
 *
 * 结构
 *   1. 页面加载前：记下页面创建的地图，后面要在它上面画标记
 *   2–4. 配置、工具、查询
 *   5–6. 小区定位、停车、房源详情（各自缓存在 IndexedDB）
 *   7. 本地筛选视图：所有筛选都在本地完成，不发请求
 *   8. 地图标记   9. 面板
 * ========================================================================== */

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ══════════════════ 0. 安居客小区页：记下你看到的小区信息 ══════════════════
  // 贝壳地图数据里没有房龄。你在安居客浏览小区列表 / 小区详情时，把页面上显示的
  // 竣工年份、停车位、停车费等记到脚本存储里（GM 存储跨站共享），贝壳面板按小区名匹配显示。
  // 只读当前页面已经显示的内容，不发任何请求。
  const AJK_CITY = { 310000: 'shanghai', 110000: 'beijing', 440100: 'guangzhou', 440300: 'shenzhen', 330100: 'hangzhou',
    320100: 'nanjing', 510100: 'chengdu', 420100: 'wuhan', 500000: 'chongqing', 120000: 'tianjin', 320500: 'suzhou', 610100: 'xa' };
  // 小区名归一：去括号内容、空白、间隔点，两边才对得上（「三花现代城(三期金兰苑)」→「三花现代城」）
  const normName = (s) => String(s || '').replace(/[(（][^)）]*[)）]?/g, '').replace(/[\s·・]/g, '').trim();

  function runAnjuke() {
    const sub = location.hostname.split('.')[0];
    const cityId = Object.keys(AJK_CITY).find((k) => AJK_CITY[k] === sub);
    if (!cityId) return;
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    function collect() {
      const found = [];
      // 小区列表页
      document.querySelectorAll('a.li-row').forEach((a) => {
        const name = clean(a.querySelector('.li-community-title')?.textContent);
        if (!name) return;
        const year = +((a.querySelector('.year')?.textContent || '').match(/(\d{4})年/) || [])[1] || null;
        const addr = clean([...(a.querySelectorAll('.props span') || [])].map((s) => s.textContent).filter((t) => t.includes('-')).pop());
        const price = +((a.textContent.match(/(\d{4,6})\s*元\/m²/) || [])[1]) || null;
        found.push({ name, year, addr, price, url: a.href });
      });
      // 小区详情页：label / value 成对
      if (/\/community\/view\/\d+/.test(location.pathname)) {
        const info = {};
        document.querySelectorAll('.label').forEach((l) => {
          const k = clean(l.textContent);
          const vEl = l.nextElementSibling;
          const v = clean(vEl?.querySelector('.value')?.textContent || vEl?.textContent);
          if (k && v && k.length <= 6 && !(k in info)) info[k] = v;
        });
        const name = clean((document.title.split(/[，,]/)[0] || ''));
        if (name && Object.keys(info).length) {
          found.push({
            name, url: location.href.split('?')[0],
            year: +((info['竣工时间'] || '').match(/(\d{4})/) || [])[1] || null,
            extra: Object.fromEntries(['停车位', '停车费', '车位管理费', '物业费', '总户数', '容积率', '绿化率', '建筑类型']
              .filter((k) => info[k] && info[k] !== '暂无数据').map((k) => [k, info[k]])),
          });
        }
      }
      return found;
    }

    let last = '';
    function save() {
      const found = collect();
      const sig = found.map((f) => f.name + f.year + JSON.stringify(f.extra || '')).join('|');
      if (!found.length || sig === last) return;
      last = sig;
      const db = GM_getValue('kef-ajk', {});
      for (const f of found) {
        const key = `${cityId}:${normName(f.name)}`;
        const old = db[key] || {};
        db[key] = { ...old, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== '')), extra: { ...(old.extra || {}), ...(f.extra || {}) }, t: Date.now() };
      }
      GM_setValue('kef-ajk', db);
      const withYear = found.filter((f) => f.year).length;
      toast(`贝壳租房筛选助手：已记下本页 ${found.length} 个小区${withYear ? `（${withYear} 个有竣工年份）` : ''}，累计 ${Object.keys(db).length} 个。`);
    }

    function toast(msg) {
      let el = document.getElementById('kef-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'kef-toast';
        el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#00ae66;color:#fff;'
          + 'padding:8px 12px;border-radius:8px;font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
          + 'box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:360px';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      clearTimeout(el.__t);
      el.style.display = 'block';
      el.__t = setTimeout(() => { el.style.display = 'none'; }, 5000);
    }

    let t = 0;
    const kick = () => { clearTimeout(t); t = setTimeout(save, 800); };
    const start = () => { kick(); new MutationObserver(kick).observe(document.body, { childList: true, subtree: true }); };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
  }

  // 安居客租房地图页跑完整面板（数据源换成安居客）；其他安居客页面（小区列表 / 详情）只记录小区信息
  const IS_AJK_MAP = /(^|\.)zu\.anjuke\.com$/.test(location.hostname) && /^\/(ditu|map)(\/|$)/.test(location.pathname);
  if (/(^|\.)anjuke\.com$/.test(location.hostname) && !IS_AJK_MAP) { runAnjuke(); return; }
  const SITE = IS_AJK_MAP ? 'ajk' : 'ke';

  // ══════════════════ 1. 页面加载前：记下页面的地图 ══════════════════
  // 这一段跑在 document-start。页面不对外提供地图对象，
  // 只能在 BMap 加载时包一层 Map 构造函数，记下页面创建的那张地图。

  let mapInstance = null;
  let ownMap = false;           // 我们自己 new 的离屏地图（百度地名搜索用），不能当成页面地图

  (function watchMap() {
    let _B;
    try {
      Object.defineProperty(W, 'BMap', {
        configurable: true,
        get: () => _B,
        set: (v) => {
          _B = v;
          if (v && v.Map && !v.Map.__kefPatched) {
            const Orig = v.Map;
            function Patched() {
              const inst = new Orig(...arguments);
              // 只认页面的地图。② 定位时 new 的离屏地图如果也记下来，
              // 会顶掉页面地图，之后的标记都画到一张看不见的地图上
              if (!ownMap) mapInstance = inst;
              return inst;
            }
            Patched.prototype = Orig.prototype;
            Object.setPrototypeOf(Patched, Orig);
            Patched.__kefPatched = true;
            v.Map = Patched;
          }
        },
      });
    } catch (e) { console.warn('[kef] 地图初始化监听失败', e); }
  })();

  const API = 'https://map.ke.com/proxyApi/i.c-pc-webapi.ke.com/map/houselist';
  const rawFetch = W.fetch.bind(W);

  let mapSync = false;          // ③ 地图同步：开启时地图上只显示筛选后的房源

  // ══════════════════════════ 2. 常量与配置 ══════════════════════════
  const PAGE_SIZE = 10;
  const HARD_CAP = 1000;        // 100 页 × 10 条
  const REQ_DELAY = 170;        // 翻页间隔，和正常浏览节奏相当，别调快
  const DETAIL_DELAY = 700;
  const GEO_DELAY = 120;        // 百度地名 / 周边搜索的间隔
  const DRY_PAGES = 2;          // 连续几页「最大面积 < 下限」才收工

  const VOCAB = {
    rentType: [['', '不限'], ['Urt200600000001', '整租'], ['Urt200600000002', '合租']],
    room:     [['l1', '一室'], ['l2', '二室'], ['l3', '三室'], ['l4', '四室'], ['l5', '五室+']],
    facing:   [['Uf100500000003', '南'], ['Uf100500000009', '南北'], ['Uf100500000001', '东'],
               ['Uf100500000005', '西'], ['Uf100500000007', '北']],
    floor:    [['Ulc200500000003', '低楼层'], ['Ulc200500000002', '中楼层'], ['Ulc200500000001', '高楼层']],
    feature:  [['Usu1', '近地铁'], ['Uhot1', '必看好房'], ['Ubc1', '拎包入住'], ['Ude1', '精装修'],
               ['Urpw1', '押一付一'], ['Uin1', '新上'], ['Uhk1', '随时看房'], ['Uvr1', 'VR房源']],
    elevator: [['', '不限'], ['Uie1', '有电梯'], ['Uie0', '无电梯']],
    ORDER_AREA_DESC: 'Urco32',   // 按面积从大到小排序
  };

  const DEFAULTS = {
    cityId: 310000,
    anchorName: '人民广场',
    anchorLng: 121.4806, anchorLat: 31.2363,     // BD-09，与贝壳地图同系
    radiusKm: 4,
    minPrice: 0, maxPrice: 6000,
    minArea: 60, maxArea: 0,
    maxUnitPrice: 0,
    ajkRentType: '1', ajkRooms: [],               // 安居客自己的查询条件
    maxBikeMin: 0, maxWalkMin: 0, maxMetroMin: 0, // 通勤分钟上限（满足任一即可），0 = 不限
    rentType: 'Urt200600000001',
    rooms: [], facings: [], floors: [], features: [],
    elevator: '',
  };

  let cfg = Object.assign({}, DEFAULTS, GM_getValue('kef-cfg', {}));
  let all = [];                 // 查询全集：定位、校验都写回这里，从不做破坏性过滤
  let rows = [];                // 当前视图 = all 过一遍本地筛选
  let queryCfg = null;          // 查询时的条件快照，用来提示「放宽了要重新查询」
  let busy = false, abort = false;
  let reqCount = 0;
  let overlays = [];

  // ══════════════════ 缓存：IndexedDB ══════════════════
  // 按小区的坐标 / 停车、按房源的详情、上次查询结果，都存在 map.ke.com 源下的 IndexedDB（库 kef-cache）。
  // 启动时整表读进内存 Map，之后改一条写一条。GM 存储只放配置、收藏这类小东西。
  // 有效期：坐标不过期；停车 60 天；详情 3 天（已下架的记 7 天）。过期的启动时清掉。
  const DAY = 864e5;
  const TTL = { geo: Infinity, park: 60 * DAY, detail: 3 * DAY, dead: 7 * DAY, commute: 90 * DAY };
  const STORES = ['geo', 'park', 'detail', 'result', 'commute'];
  const geoCache = new Map();         // `${cityId}:${小区}` → { lng, lat, t }
  const parkCache = new Map();        // `${cityId}:${小区}` → { own, ownNames, near, count, t }
  const detailCache = new Map();      // 房源编号 → { t, alive, deadReason, ...详情字段 }
  const commuteCache = new Map();     // `v2|${cityId}:${小区}@锚点` → { bike, walk, metro, t }
  let lastResult = null;              // { all, queryCfg, savedAt }
  let idb = null;

  const idbReq = (q) => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  function idbOpen() {
    const q = W.indexedDB.open('kef-cache', 3);     // v3 加了 commute
    q.onupgradeneeded = () => STORES.forEach((s) => { if (!q.result.objectStoreNames.contains(s)) q.result.createObjectStore(s); });
    return idbReq(q);
  }
  async function idbLoad(store) {
    const os = idb.transaction(store, 'readonly').objectStore(store);
    const [keys, vals] = await Promise.all([idbReq(os.getAllKeys()), idbReq(os.getAll())]);
    return new Map(keys.map((k, i) => [k, vals[i]]));
  }
  // 写失败不影响功能，内存里照样有，只是下次要重拉
  function idbPut(store, key, val) {
    if (!idb) return;
    try { idb.transaction(store, 'readwrite').objectStore(store).put(val, key); } catch (e) { console.warn('[kef] 缓存写入失败', store, e); }
  }
  function idbPutMany(store, entries) {
    if (!idb || !entries.length) return;
    try { const os = idb.transaction(store, 'readwrite').objectStore(store); entries.forEach(([k, v]) => os.put(v, k)); } catch (e) { console.warn('[kef] 缓存写入失败', store, e); }
  }

  const fresh = (e, ttl) => !!e && (!e.t || Date.now() - e.t < ttl);   // 没时间戳的老数据当新鲜
  const detailTTL = (e) => (e.alive === false ? TTL.dead : TTL.detail);

  async function initCache() {
    try {
      idb = await idbOpen();
      const [g, p, d, r, rd] = await Promise.all(STORES.map(idbLoad));
      const stale = { park: [], detail: [] };
      g.forEach((v, k) => geoCache.set(k, v));
      p.forEach((v, k) => (fresh(v, TTL.park) ? parkCache.set(k, v) : stale.park.push(k)));
      d.forEach((v, k) => (fresh(v, detailTTL(v)) ? detailCache.set(k, v) : stale.detail.push(k)));
      lastResult = r.get('last') || null;
      rd.forEach((v, k) => (fresh(v, TTL.commute) ? commuteCache.set(k, v) : null));
      for (const [s, ks] of Object.entries(stale)) {
        if (ks.length) { const os = idb.transaction(s, 'readwrite').objectStore(s); ks.forEach((k) => os.delete(k)); }
      }
      // 从 2.1 的 GM 存储迁过来，迁完腾掉
      const old = { geo: GM_getValue('kef-geo', null), park: GM_getValue('kef-park2', null) };
      if (old.geo) { idbPutMany('geo', Object.entries(old.geo).filter(([k]) => !geoCache.has(k))); Object.entries(old.geo).forEach(([k, v]) => geoCache.has(k) || geoCache.set(k, v)); GM_setValue('kef-geo', null); }
      if (old.park) { idbPutMany('park', Object.entries(old.park).filter(([k]) => !parkCache.has(k))); Object.entries(old.park).forEach(([k, v]) => parkCache.has(k) || parkCache.set(k, v)); GM_setValue('kef-park2', null); }
      const oldRes = GM_getValue('kef-result', null);
      if (oldRes && !lastResult) { lastResult = oldRes; idbPut('result', 'last', oldRes); }
      if (oldRes) GM_setValue('kef-result', null);
    } catch (e) {
      idb = null;
      console.warn('[kef] IndexedDB 不可用，缓存只在本次页面有效', e);
    }
  }
  const cacheReady = initCache();

  async function clearCache() {
    geoCache.clear(); parkCache.clear(); detailCache.clear(); commuteCache.clear(); lastResult = null;
    if (idb) STORES.forEach((s) => { try { idb.transaction(s, 'readwrite').objectStore(s).clear(); } catch {} });
  }

  // ══════════════════════════ 3. 工具 ══════════════════════════
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const $ = (id) => document.getElementById(id);

  function radiusToBBox(lat, lng, km) {
    const dLat = km / 111.19, dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
    return { minLatitude: lat - dLat, maxLatitude: lat + dLat, minLongitude: lng - dLng, maxLongitude: lng + dLng };
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, rad = (d) => (d * Math.PI) / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
            + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function buildCondition(c) {
    let s = '';
    if (c.rentType) s += c.rentType;
    if (c.rooms.length) s += c.rooms.join('');
    if (c.minPrice > 0) s += `obrp${c.minPrice}`;
    if (c.maxPrice > 0) s += `oerp${c.maxPrice}`;
    [...c.facings, ...c.floors, ...c.features].forEach((f) => { s += f; });
    if (c.elevator) s += c.elevator;
    return s + VOCAB.ORDER_AREA_DESC;
  }

  // 标题「整租·控江四村 2室2厅」→「控江四村」。公寓类标题是一整句广告
  //（「整租·城投宽庭 江湾社区 新E2户型 66平 …」），只取第一个词当小区名，否则定位、分组都对不上
  // 上架时间：列表接口里没有，但房源编号（SH2218300938802692096）是按时间生成的 ID，
  // 高位是从 2010-01-01 起的毫秒数。实测带「新上」标签的房源解出来中位数 10 天前、没有晚于今天的，能精确到天。
  // 这是编号生成的时间（≈首次挂牌）；下架后重新上架沿用老编号的，会显示得比较早。
  const ID_EPOCH = Date.UTC(2010, 0, 1);
  function listedAtOf(url) {
    const m = String(url || '').match(/\/[A-Z]{2}(\d{15,})\.html/);
    if (!m) return null;
    try {
      const t = Number(BigInt(m[1]) >> 22n) + ID_EPOCH;
      return t > Date.UTC(2015, 0, 1) && t < Date.now() + 864e5 ? t : null;   // 编号规则不同的（解出未来时间）当未知
    } catch { return null; }
  }
  const listedAgo = (r) => (r.listedAt ? Math.floor((Date.now() - r.listedAt) / 864e5) : null);
  const listedOf = (r) => { const d = listedAgo(r); return d == null ? '上架未知' : d <= 7 ? '7天内' : d <= 30 ? '30天内' : d <= 90 ? '90天内' : '更早'; };

  function communityOf(title) {
    const s = (title.split('·')[1] || title).replace(/\s+\d+室.*$/, '').trim();
    const words = s.split(/\s+/);
    return words.length > 1 && s.length > 12 ? words[0] : s;
  }

  // desc 形如 "62m²|2室2厅1卫|南|链家"
  function parseRow(r) {
    const p = (r.desc || '').split('|').map((s) => s.trim());
    const parsed = parseFloat(p[0]);
    const area = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const price = parseInt(String(r.priceStr || '').replace(/[^\d]/g, ''), 10) || 0;
    const title = r.title || '';
    return {
      raw: r, url: r.actionUrl, title,
      community: communityOf(title),
      area, price,
      unitPrice: area ? Math.round(price / area) : 0,
      layout: p[1] || '', facing: p[2] || '', brand: p[3] || '',
      cardType: r.cardType || '',
      tags: (r.tags || []).map((t) => t.desc).join(' '),
      listedAt: listedAtOf(r.actionUrl),
      lat: null, lng: null, distKm: null, water: '', power: '', elevatorInfo: '',
    };
  }

  function passes(r, c) {
    if (c.minArea > 0 && r.area < c.minArea) return false;
    if (c.maxArea > 0 && r.area > c.maxArea) return false;
    if (c.minPrice > 0 && r.price < c.minPrice) return false;
    if (c.maxPrice > 0 && r.price > c.maxPrice) return false;
    if (c.maxUnitPrice > 0 && r.unitPrice > c.maxUnitPrice) return false;
    if (!commuteOK(r, c)) return false;
    if (r.distKm != null && c.radiusKm > 0 && r.distKm > c.radiusKm) return false;
    return true;
  }

  // ══════════════════ 4. 查询：面积降序 + 早停 ══════════════════
  async function apiHouseList(box, condition, page, cityId) {
    reqCount++;
    const url = `${API}?${qs({ cityId, dataSource: 'ZF', curPage: page, condition, type: '', resblockId: '', ...box })}`;
    const j = await (await rawFetch(url, { credentials: 'include' })).json();
    // 两种错误格式都有：{errno, errmsg} 和 {code, msg}（比如登录失效是 code=31002「请先登录」）
    if (j.errno) throw new Error(`errno=${j.errno} ${j.errmsg || ''}`);
    if (j.code && String(j.code) !== '0') {
      throw new Error(/登录/.test(j.msg || '') ? '贝壳登录已失效，请在页面上重新登录后再查询' : `code=${j.code} ${j.msg || ''}`);
    }
    return j.data || {};
  }

  async function queryListings(c, box, onProgress) {
    const condition = buildCondition(c);
    const out = new Map();
    let total = 0, dry = 0, early = false, hit = 0;
    const maxPage = HARD_CAP / PAGE_SIZE;

    for (let p = 1; p <= maxPage; p++) {
      if (abort) break;
      const d = await apiHouseList(box, condition, p, c.cityId);
      total = d.total || total;
      const list = d.list || [];
      if (!list.length) break;

      // 用「本页最大面积」判停：公寓/集中式公寓类房源不参与排序、会乱序插入，
      // 用最小值会被离群点骗停（实测第 16 页 [69,55,55,69,...]，少拿 147 套）。
      let pageMax = -Infinity;
      for (const raw of list) {
        const r = parseRow(raw);
        if (r.area > 0) pageMax = Math.max(pageMax, r.area);
        // 全部留下，筛选交给本地视图：之后收紧再放宽都不用重新查询
        if (!out.has(r.url)) { out.set(r.url, r); if (passes(r, c)) hit++; }
      }
      onProgress?.({ found: hit, total, page: p });

      if (c.minArea > 0 && pageMax < c.minArea) { if (++dry >= DRY_PAGES) { early = true; break; } }
      else dry = 0;

      if (p < maxPage) await sleep(REQ_DELAY);
    }
    return { list: [...out.values()], total, early, capped: !early && total > HARD_CAP };
  }

  // ══════════ 4b. 安居客房源：同范围同条件一起查，合进同一张表 ══════════
  // 安居客地图找房用的接口按经纬度范围返回房源（每页 60 条），户型 / 租金 / 整租合租在服务端过滤，
  // 面积在本地过滤。没有坐标，按小区名走百度定位，和贝壳房源共用缓存。
  const AJK_ZU = { 310000: 'sh', 110000: 'bj', 440100: 'gz', 440300: 'sz', 330100: 'hz', 320100: 'nj',
    510100: 'cd', 420100: 'wh', 500000: 'cq', 120000: 'tj', 320500: 'su', 610100: 'xa' };
  const AJK_DELAY = 1200;       // 安居客翻页间隔（再加随机 0–800ms），比贝壳更慢一点
  // 安居客不能按面积排序，范围大时动辄上万套。按最新发布排序（order_id=3），每种户型只取前 N 页：
  // 新发布的最可能还在租，老房源常常租掉了没下架
  const AJK_MAX_PAGES = 20;
  const AJK_ORDER_NEWEST = 3;

  function ajkGetJSON(url) {
    // 在安居客地图页上就是同源请求，直接 fetch
    if (SITE === 'ajk') {
      return rawFetch(url, { credentials: 'include' }).then((r) => r.text()).then((t) => {
        try { return JSON.parse(t); } catch { throw new Error('安居客要求先完成验证'); }
      });
    }
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('没有 GM_xmlhttpRequest'));
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000,
        onload: (r) => {
          if (/captcha|verify|callback/.test(r.finalUrl || '')) return reject(new Error('安居客要求先完成验证'));
          try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('安居客要求先完成验证')); }   // 返回的不是 JSON，多半是验证页
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }

  function parseAjkRow(p) {
    const area = parseFloat(p.area) || 0;
    const price = +p.price || 0;
    return {
      source: 'ajk', raw: null,
      url: `https://${AJK_ZU[cfg.cityId] || 'sh'}.zu.anjuke.com/fangyuan/${p.id}`,
      title: p.title || '',
      community: String(p.community_name || '').replace(/[(（](宝山|杨浦|虹口|浦东|闵行|静安|普陀|徐汇|长宁|黄浦|嘉定|松江|青浦|奉贤|金山|崇明)[)）]$/, '').trim(),
      area, price, unitPrice: area ? Math.round(price / area) : 0,
      layout: p.rhval || '', facing: p.orient || '', brand: '安居客',
      cardType: p.rent_type_name || '', tags: [p.fitment, p.block_name].filter(Boolean).join(' '),
      ajkCommunityUrl: p.community_url || '', ajkCommunityId: p.community_id || null,
      listedAt: null,
      lat: null, lng: null, distKm: null, water: '', power: '', elevatorInfo: '',
    };
  }

  // 安居客自己的查询条件（和贝壳的编码不通用，单独存）
  const AJK_VOCAB = {
    rentType: [['', '不限'], ['1', '整租'], ['2', '合租']],
    room: [['1', '一室'], ['2', '二室'], ['3', '三室'], ['4', '四室'], ['5', '五室+']],
  };

  async function queryAnjuke(c, box, onProgress) {
    const sub = AJK_ZU[c.cityId];
    if (!sub) return { list: [], total: 0, error: '这个城市还没适配安居客' };
    const rooms = c.ajkRooms.length ? c.ajkRooms.map(Number) : [0];   // 接口一次只能查一种户型，逐个查；不选 = 不限
    const rentType = +c.ajkRentType || 0;
    const out = new Map();
    let total = 0, error = '';
    try {
      for (const room of rooms) {
        for (let p = 1; p <= AJK_MAX_PAGES; p++) {
          if (abort) break;
          const url = `https://${sub}.zu.anjuke.com/map/ajax/pclist/Api_get_house_list?${qs({
            p, maxp: 99, room_num: room >= 5 ? 5 : room, price_id: 0, rent_type: rentType,
            price_min: c.minPrice || 0, price_max: c.maxPrice || 0, lx_id: '', tag_id: '', orient_id: '', order_id: AJK_ORDER_NEWEST,
            lat: `${box.minLatitude.toFixed(6)}_${box.maxLatitude.toFixed(6)}`,
            lng: `${box.minLongitude.toFixed(6)}_${box.maxLongitude.toFixed(6)}`, zoom: 15, kw: '' })}`;
          reqCount++;
          const j = await ajkGetJSON(url);
          if (j.code !== 0 && j.code !== '0') throw new Error(`安居客返回 ${j.code} ${j.msg || ''}`);
          const props = (j.val && j.val.props) || [];
          const pages = (j.val && j.val.pages) || {};
          if (p === 1) total += +pages.total || 0;
          for (const raw of props) {
            const r = parseAjkRow(raw);
            if (!out.has(r.url)) out.set(r.url, r);
          }
          onProgress?.({ found: out.size, total, page: p, room });
          if (!props.length || p * (+pages.page_size || 60) >= (+pages.total || 0)) break;
          await sleep(AJK_DELAY + Math.random() * 800);
        }
        if (abort) break;
      }
    } catch (e) { error = e.message; }
    // 同一套房常被多个经纪人重复挂：小区 + 户型 + 价格 + 面积完全相同的只留一条，其余链接挂在 dupUrls 上
    const seen = new Map();
    let dup = 0;
    for (const r of out.values()) {
      const k = `${normName(r.community)}|${r.layout}|${r.price}|${r.area}`;
      const first = seen.get(k);
      if (first) { (first.dupUrls = first.dupUrls || []).push(r.url); dup++; } else seen.set(k, r);
    }
    return { list: [...seen.values()], total, error, dup };
  }

  // ══════════ 5. 坐标：小区名 → 经纬度（百度地图） ══════════
  // houselist 记录里没有经纬度。逐套开详情页要 0.7s/套；但同一小区共用坐标，
  // 用百度 LocalSearch 按小区名批量解析，几百个名字只要几十秒，且不给贝壳压力。
  let geoMap = null;
  // box：限定在这个范围里搜。房源本来就是按范围查出来的，小区一定在范围内；
  // 不限定的话同名小区会定位到别处（实测「政立小区」被定到 12km 外）
  function geocodeOne(name, box) {
    return new Promise((resolve) => {
      const NS = W.BMapGL || W.BMap;
      if (!NS) return resolve(null);
      try {
        if (!geoMap) {
          ownMap = true;
          try { geoMap = new NS.Map(document.createElement('div')); } finally { ownMap = false; }
        }
        const ls = new NS.LocalSearch(geoMap, {
          onSearchComplete: (r) => {
            try { const p = r.getPoi(0); resolve(p ? { lng: p.point.lng, lat: p.point.lat } : null); }
            catch { resolve(null); }
          },
        });
        ls.setPageCapacity(1);
        if (box) {
          ls.searchInBounds(name, new NS.Bounds(new NS.Point(box.minLongitude, box.minLatitude), new NS.Point(box.maxLongitude, box.maxLatitude)));
        } else ls.search(name);
        setTimeout(() => resolve(null), 5000);
      } catch { resolve(null); }
    });
  }

  // 查询范围外扩一圈作为定位的合理范围
  function geoBox(c) {
    const b = c && radiusToBBox(c.anchorLat, c.anchorLng, c.radiusKm * 1.3 + 0.5);
    return b;
  }
  const inBox = (p, b) => !b || (p.lat >= b.minLatitude && p.lat <= b.maxLatitude && p.lng >= b.minLongitude && p.lng <= b.maxLongitude);

  async function geocodeRows(list, c, onProgress) {
    await cacheReady;
    const names = [...new Set(list.map((r) => r.community).filter(Boolean))];
    const cityHint = c.cityId === 310000 ? '上海' : '';
    const box = geoBox(queryCfg || c);
    let done = 0;
    for (const n of names) {
      if (abort) break;
      const key = `${c.cityId}:${n}`;
      const cached = geoCache.get(key);
      // 没缓存，或缓存的点落在查询范围外（多半是同名小区定错了）→ 限定范围重新搜
      if (!cached || !inBox(cached, box)) {
        const p = await geocodeOne(`${n} ${cityHint}`, box);
        if (p) { p.t = Date.now(); geoCache.set(key, p); idbPut('geo', key, p); }
        await sleep(GEO_DELAY);
      }
      onProgress?.({ done: ++done, total: names.length });
    }
    applyGeo(list, c);
  }

  function applyGeo(list, c) {
    const box = geoBox(queryCfg || c);
    for (const r of list) {
      if (r.preciseXY) continue;                         // 详情页给过精确坐标的不覆盖
      const p = geoCache.get(`${c.cityId}:${r.community}`);
      if (p && inBox(p, box)) {
        r.lng = p.lng; r.lat = p.lat;
        r.distKm = +haversineKm(c.anchorLat, c.anchorLng, p.lat, p.lng).toFixed(2);
      } else {
        r.lng = null; r.lat = null; r.distKm = null;     // 范围外的点不可信，宁可当没定位
      }
    }
  }

  // ══════════ 6. 详情页补全（可选）：精确坐标 + 商水商电 ══════════
  // houselist 的记录里没有任何状态字段（只有 title/desc/tags/coverPic/priceStr/
  // unitPriceStr/actionUrl/cardType），贝壳索引滞后，下架房源会继续挂着。
  // 判活只能开详情页，多重信号取并集，宁可保守。
  const DEAD_WORDS = ['已下架', '已出租', '已租出', '房源已失效', '房源不存在', '停止出租', '未找到页面'];

  // 详情页在 {city}.zu.ke.com，和地图页不同源，浏览器不允许页面直接读取（2.0 的 ④ 因此
  // 每套都是「请求失败」）。必须走 GM_xmlhttpRequest，它不受同源限制且会带上 ke.com 的 cookie。
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('没有 GM_xmlhttpRequest'));
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000,
        onload: (r) => resolve({ status: r.status, finalUrl: r.finalUrl || url, text: r.responseText || '' }),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }

  // 详情页「基本信息」里的字段，形如 <li>车位：暂无数据</li>
  const DETAIL_FIELDS = { floor: '楼层', elevatorInfo: '电梯', carSpot: '车位', water: '用水', power: '用电',
    gas: '燃气', heating: '采暖', checkin: '入住', lease: '租期', maintain: '维护' };

  async function fetchDetail(url) {
    try {
      const res = await gmGet(url);
      // 验证页：不是房源没了，是贝壳要求先完成验证。上层据此整体停下
      if (/captcha|hip\.ke\.com/.test(res.finalUrl)) return { alive: null, captcha: true, deadReason: '需要验证' };
      if (res.status !== 200) return { alive: false, deadReason: `HTTP ${res.status}` };
      // 跳走了通常就是没了
      if (!res.finalUrl.includes(url.split('/').pop())) return { alive: false, deadReason: '重定向' };
      const h = res.text;
      const txt = h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      const hit = DEAD_WORDS.find((w) => txt.includes(w));
      if (hit) return { alive: false, deadReason: hit };
      if (!/元\s*\/\s*月/.test(txt)) return { alive: false, deadReason: '无价格块' };

      const lat = parseFloat((h.match(/latitude["'\s:=]+([\d.]{6,12})/i) || [])[1]);
      const lng = parseFloat((h.match(/longitude["'\s:=]+([\d.]{6,12})/i) || [])[1]);
      const info = (txt.match(/基本信息(.{0,400}?)(配套设施|房源描述)/) || [])[1] || txt;
      const out = { alive: true, lat: lat || null, lng: lng || null };
      for (const [k, label] of Object.entries(DETAIL_FIELDS)) {
        const v = ((info.match(new RegExp(`${label}[：:]\\s*(\\S+)`)) || [])[1] || '').replace(/^暂无数据$/, '');
        out[k] = v;
      }
      return out;
    } catch (e) {
      return { alive: null, deadReason: '请求失败' };   // null = 不确定，保留
    }
  }

  // ══════════ 6b. 停车：百度地图周边搜索 ══════════
  // 房源详情里的「车位」字段大多是「暂无数据」，所以改用百度地图的停车场信息。
  // 百度 POI 里小区自有停车场会以「小区名-地下停车场 / -地上停车场」命名，
  // 按小区坐标搜周边 500m 的停车场，就能分出：小区自有车场（地下/地上）+ 最近公共停车场距离 + 周边数量。
  const PARK_RADIUS = 500;

  function searchParking(pt, community) {
    return new Promise((resolve) => {
      const NS = W.BMap;
      if (!NS || !geoMap) return resolve(null);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const ls = new NS.LocalSearch(geoMap, {
          pageCapacity: 50,
          onSearchComplete: (rs) => {
            try {
              const own = new Set(), ownNames = [];
              // 只认标题：「小区名-地下停车场」。按地址匹配会把「XX公司北侧停车场 @逸仙二村东北侧」也算进来
              const base = (community || '').replace(/[(（].*$/, '').trim();
              let near = null;
              const n = rs.getCurrentNumPois();
              for (let i = 0; i < n; i++) {
                const p = rs.getPoi(i);
                const d = Math.round(haversineKm(pt.lat, pt.lng, p.point.lat, p.point.lng) * 1000);
                const title = p.title || '';
                const mine = base.length >= 2 && title.startsWith(base);
                if (mine) { own.add(/地下/.test(title) ? '地下' : '地上'); ownNames.push(title); }
                else if (near == null || d < near) near = d;
              }
              finish({ own: [...own].sort().join('+'), ownNames: ownNames.slice(0, 6), near, count: rs.getNumPois() || n });
            } catch { finish(null); }
          },
        });
        ls.searchNearby('停车场', new NS.Point(pt.lng, pt.lat), PARK_RADIUS);
        setTimeout(() => finish(null), 6000);
      } catch { finish(null); }
    });
  }

  function applyParking(list, c) {
    for (const r of list) {
      const p = parkCache.get(`${c.cityId}:${r.community}`);
      if (!p) { r.park = null; r.parkLabel = ''; r.parkNear = null; setParkLevel(r); continue; }
      r.park = p;
      r.parkLabel = p.own.includes('地下') ? '地下车库' : p.own ? '小区地上' : '无小区车场';
      r.parkNear = p.near;
      setParkLevel(r);
    }
  }

  async function lookupParking(list, c, onProgress) {
    await cacheReady;
    if (!geoMap) await geocodeOne('人民广场');           // 借它把离屏地图建起来
    const groups = new Map();
    for (const r of list) if (r.lng != null && r.community && !groups.has(r.community)) groups.set(r.community, r);
    let done = 0;
    for (const [name, r] of groups) {
      if (abort) break;
      const key = `${c.cityId}:${name}`;
      if (!parkCache.has(key)) {
        const p = await searchParking({ lng: r.lng, lat: r.lat }, name);
        if (p) { p.t = Date.now(); parkCache.set(key, p); idbPut('park', key, p); }
        await sleep(GEO_DELAY);
      }
      onProgress?.({ done: ++done, total: groups.size });
    }
    applyParking(list, c);
  }

  // 详情按房源编号缓存：重新 ① 查询后，缓存里有的直接带上，④ 只补新房源
  const houseCode = (url) => (url.match(/([A-Z]{2}\d{8,})\.html/) || [])[1] || url;

  function rememberDetail(r, d) {
    const e = { t: Date.now(), alive: d.alive, deadReason: d.deadReason || '' };
    if (d.alive) for (const k of ['lat', 'lng', ...Object.keys(DETAIL_FIELDS)]) e[k] = d[k];
    const code = houseCode(r.url);
    detailCache.set(code, e);
    idbPut('detail', code, e);
  }

  function applyDetail(list, c) {
    let n = 0;
    for (const r of list) {
      const e = detailCache.get(houseCode(r.url));
      if (!e) continue;
      n++;
      r.alive = e.alive; r.deadReason = e.deadReason;
      if (e.alive === false) continue;
      for (const k of Object.keys(DETAIL_FIELDS)) r[k] = e[k];
      r.detailed = true;
      if (e.lat && e.lng) {
        r.lat = e.lat; r.lng = e.lng; r.preciseXY = true;
        r.distKm = +haversineKm(c.anchorLat, c.anchorLng, e.lat, e.lng).toFixed(2);
      }
    }
    return n;
  }

  // ══════════ 6c. 安居客记下的小区信息：房龄 / 停车费 / 车位数 ══════════
  let ajkDb = GM_getValue('kef-ajk', {});

  function findAjk(community, cityId) {
    const n = normName(community);
    if (!n) return null;
    const exact = ajkDb[`${cityId}:${n}`];
    if (exact) return exact;
    if (n.length < 3) return null;
    // 名字对不齐时退一步：互相包含，取最长的那个（「华润橡树湾」↔「华润置地橡树湾」这种不算，宁缺毋滥）
    let best = null, bestLen = 0;
    for (const [k, v] of Object.entries(ajkDb)) {
      if (!k.startsWith(`${cityId}:`)) continue;
      const m = k.slice(k.indexOf(':') + 1);
      if (m.length >= 3 && (m.includes(n) || n.includes(m) || nearSame(m, n)) && m.length > bestLen) { best = v; bestLen = m.length; }
    }
    return best;
  }

  // 一个名字是另一个删掉一两个字的结果：「新江湾时代花园」↔「新江湾城时代花园」
  function nearSame(a, b) {
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (s.length < 4 || l.length - s.length > 2) return false;
    let i = 0;
    for (const ch of l) if (ch === s[i]) i++;
    return i === s.length;
  }

  function applyAjk(list, c) {
    const memo = new Map();
    // 安居客房源自带小区 ID，先按 ID 精确对上记录过的小区，对不上再按名字
    const byId = new Map(Object.values(ajkDb).map((v) => [(String(v.url || '').match(/view\/(\d+)/) || [])[1], v]).filter(([id]) => id));
    for (const r of list) {
      if (!memo.has(r.community)) memo.set(r.community, findAjk(r.community, c.cityId));
      const e = (r.ajkCommunityId && byId.get(String(r.ajkCommunityId))) || memo.get(r.community)
        || (r.ajkCommunityUrl ? { url: r.ajkCommunityUrl } : null);       // 没记录过也至少能跳到安居客小区页
      r.ajk = e || null;
      r.year = (e && e.year) || null;
      r.ajkParkSpots = (e && e.extra && e.extra['停车位']) || '';
      r.ajkParkFee = (e && e.extra && e.extra['停车费']) || '';
      r.parkRatio = parkRatioOf(e && e.extra);
      setParkLevel(r);
    }
  }

  // 车位比：安居客写成「130(1:0.4)」；没写比例时用 车位数 / 总户数 算
  function parkRatioOf(extra) {
    if (!extra) return null;
    const s = extra['停车位'] || '';
    // 有车位数和户数就自己算：网站写的比例只保留一位小数，32/1290 会写成「1:0.0」
    const spots = +(s.match(/^\s*(\d+)/) || [])[1];
    const hh = +((extra['总户数'] || '').match(/\d+/) || [])[0];
    if (spots > 0 && hh > 0) return +(spots / hh).toFixed(2);
    const m = s.match(/1\s*[:：]\s*([\d.]+)/);
    return m ? +(+m[1]).toFixed(2) : null;
  }

  // 停车档位：有车位比按车位比分；没有就只能说「有车场·车位未知」
  function setParkLevel(r) {
    if (r.parkRatio != null) r.parkLevel = r.parkRatio >= 0.8 ? '车位充足' : r.parkRatio >= 0.4 ? '车位一般' : '车位紧张';   // 不是每户都有车，0.4 已算过得去
    else if (r.parkLabel === '无小区车场') r.parkLevel = '无小区车场';
    else if (r.parkLabel) r.parkLevel = r.parkLabel === '地下车库' ? '有地下车库·车位未知' : '有车场·车位未知';
    else r.parkLevel = '';
  }

  const ageOf = (r) => (!r.year ? '房龄未知' : r.year >= 2015 ? '2015年后' : r.year >= 2010 ? '2010–2014' : r.year >= 2000 ? '2000–2009' : '2000年前');

  // ══════════ 6d. 通勤时间：自行车 / 步行 / 地铁+自行车（百度路线规划） ══════════
  // 直线距离会被河、高架、铁路骗到，三种方式都按真实路线算：
  //   自行车：百度骑行路线的时间（约 12km/h）
  //   步行：百度步行路线的时间
  //   地铁+自行车：百度公交方案里只取纯地铁的，进站前、出站后超过 300m 的步行段换成骑车
  //               （每段 +1 分钟取车还车），中途换乘仍按步行，取最快的方案
  // 按「小区 + 锚点」缓存，换锚点才重算。
  const BIKE_MPS = 3.33, WALK_MPS = 1.17;       // 和百度骑行 / 步行路线的速度一致
  const BIKE_LEG_MIN_M = 300, BIKE_LEG_EXTRA_S = 60;
  // 直线距离超过这个就不算了，肯定到不了（省请求）
  const SKIP_KM = { walk: 2.5, bike: 6, metro: 10 };
  const commuteKey = (c, community) => `v2|${c.cityId}:${community}@${c.anchorLng.toFixed(4)},${c.anchorLat.toFixed(4)}`;

  function routeOnce(kind, from, to) {
    return new Promise((resolve) => {
      const NS = W.BMap;
      // 安居客页面上是百度地图 2.0，没有骑行路线：用步行路线的路程按骑车速度折算（路程两者差不多）
      const bikeByWalk = kind === 'bike' && NS && !NS.RidingRoute;
      const Ctor = NS && { bike: bikeByWalk ? NS.WalkingRoute : NS.RidingRoute, walk: NS.WalkingRoute, metro: NS.TransitRoute }[kind];
      if (!Ctor || !geoMap) return resolve(null);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const opts = {
          onSearchComplete: (rs) => {
            try {
              if (!rs) return finish(null);
              if (kind !== 'metro') {
                const p = rs.getPlan(0);
                if (!p) return finish(null);
                const dist = p.getDistance(false);
                return finish(bikeByWalk ? { dist, sec: Math.round(dist / BIKE_MPS), est: true } : { dist, sec: p.getDuration(false) });
              }
              finish(bestMetroPlan(rs));
            } catch { finish(null); }
          },
        };
        if (kind === 'metro') opts.policy = W.BMAP_TRANSIT_POLICY_FIRST_SUBWAYS ?? 5;
        new Ctor(geoMap, opts).search(new NS.Point(from.lng, from.lat), new NS.Point(to.lng, to.lat));
        setTimeout(() => finish(null), 8000);
      } catch { finish(null); }
    });
  }

  // 公交方案 → 只要纯地铁的，接驳步行换骑车，取最快
  function bestMetroPlan(rs) {
    const SUBWAY = W.BMAP_LINE_TYPE_SUBWAY ?? 1;
    let best = null;
    for (let i = 0; i < rs.getNumPlans(); i++) {
      const p = rs.getPlan(i);
      const lines = [];
      for (let j = 0; j < p.getNumLines(); j++) lines.push(p.getLine(j));
      if (!lines.length || lines.some((l) => l.type !== SUBWAY)) continue;
      const walks = [];
      for (let j = 0; j < p.getNumRoutes(); j++) walks.push(p.getRoute(j).getDistance(false));
      let sec = p.getDuration(false);
      walks.forEach((d, j) => {
        const edge = j === 0 || j === walks.length - 1;           // 进站前 / 出站后
        if (edge && d > BIKE_LEG_MIN_M) sec += -d / WALK_MPS + d / BIKE_MPS + BIKE_LEG_EXTRA_S;
      });
      if (!best || sec < best.sec) best = { sec: Math.round(sec), lines: lines.map((l) => l.title).join('→') };
    }
    return best || { sec: null, lines: '' };                      // 没有纯地铁方案也缓存下来，免得重查
  }

  const minOf = (x) => (x && x.sec != null ? Math.round(x.sec / 60) : null);

  function applyCommute(list, c) {
    for (const r of list) {
      const e = commuteCache.get(commuteKey(c, r.community));
      r.commute = e || null;
      r.bikeMin = e ? minOf(e.bike) : null;
      r.walkMin = e ? minOf(e.walk) : null;
      r.metroMin = e ? minOf(e.metro) : null;
      const ms = [r.bikeMin, r.walkMin, r.metroMin].filter((v) => v != null);
      r.commuteBest = ms.length ? Math.min(...ms) : null;
    }
    // 已定位的都算过了才算「就绪」，否则新查到的小区还没来得及算就被排除
    const located = list.filter((r) => r.lng != null && r.community);
    commuteReady = located.length > 0 && located.every((r) => r.commute);
  }

  // 三个上限「满足任一」即可。还没点过「🚲 通勤」时不过滤；点过之后，算不出通勤的（没定位上）也排除
  function commuteOK(r, c) {
    const lim = [[r.bikeMin, c.maxBikeMin], [r.walkMin, c.maxWalkMin], [r.metroMin, c.maxMetroMin]].filter(([, m]) => m > 0);
    if (!lim.length) return true;
    if (!r.commute) return !commuteReady;
    return lim.some(([v, m]) => v != null && v <= m);
  }
  let commuteReady = false;     // 当前结果里是否已经算过通勤

  async function lookupCommute(list, c, onProgress) {
    await cacheReady;
    if (!geoMap) await geocodeOne('人民广场');
    const groups = new Map();
    for (const r of list) if (r.lng != null && r.community && !groups.has(r.community)) groups.set(r.community, r);
    const to = { lng: c.anchorLng, lat: c.anchorLat };
    let done = 0;
    for (const [name, r] of groups) {
      if (abort) break;
      const key = commuteKey(c, name);
      if (!commuteCache.has(key)) {
        const from = { lng: r.lng, lat: r.lat };
        const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
        const e = { t: Date.now() };
        for (const kind of ['bike', 'walk', 'metro']) {
          if (abort) break;
          if (km > SKIP_KM[kind]) { e[kind] = { sec: null, far: true }; continue; }
          e[kind] = await routeOnce(kind, from, to);
          await sleep(GEO_DELAY);
        }
        if (!abort && ['bike', 'walk', 'metro'].every((k) => e[k] !== null)) {   // 有一项失败就不缓存，下次重试
          commuteCache.set(key, e); idbPut('commute', key, e);
        }
      }
      onProgress?.({ done: ++done, total: groups.size });
    }
    applyCommute(list, c);
  }

  function commuteTip(r) {
    const e = r.commute;
    if (!e) return '';
    const f = (x, label) => (x && x.sec != null ? `${label} ${Math.round(x.sec / 60)} 分钟${x.dist ? `（${(x.dist / 1000).toFixed(1)}km${x.est ? '，按步行路线折算' : ''}）` : ''}` : `${label} ${x && x.far ? '太远' : '无'}`);
    return [f(e.bike, '自行车'), f(e.walk, '步行'), e.metro && e.metro.sec != null ? `地铁+自行车 ${Math.round(e.metro.sec / 60)} 分钟（${e.metro.lines}）` : `地铁+自行车 ${e.metro && e.metro.far ? '太远' : '无纯地铁方案'}`].join('\n');
  }

  // ══════════════════ 7. 结果视图：本地二次筛选 ══════════════════
  // all 是查询全集，rows 是视图。每次都从 all 重算，条件随便收紧再放宽，不发请求。
  // 只有放宽到查询范围之外（面积下限、租金、半径、锚点）才需要重新查询，面板会提示。
  const marks = GM_getValue('kef-marks', {});            // url → 'star' | 'hide'，跨会话保留
  const VF_DEFAULT = { rooms: [], types: [], brands: [], parks: [], ages: [], listed: [], facings: [], kw: '', exkw: '',
    onlyStar: false, showHidden: false, onlyLocated: false, noComm: false };
  const vf = Object.assign({}, VF_DEFAULT, GM_getValue('kef-vf', {}));
  let focus = null;                                      // 地图上点中的小区，表格只看它

  const roomOf = (r) => {
    const m = /(\d+)室/.exec(r.layout) || /(\d+)居/.exec(r.title);
    if (!m) return '其他';
    return +m[1] >= 4 ? '4室+' : `${m[1]}室`;
  };
  const groupKey = (r) => r.community || `${r.lng},${r.lat}`;
  // [vf 键, 显示名, 取值函数] —— 选项从查到的数据里动态生成，带计数
  const FACETS = [
    ['rooms', '居室', roomOf],
    ['types', '类型', (r) => r.cardType || '其他'],
    ['brands', '品牌', (r) => r.brand || '其他'],
    ['parks', '停车', (r) => r.parkLevel || '未查'],
    ['ages', '房龄', ageOf],
    ['listed', '上架', listedOf],
    ['facings', '朝向', (r) => String(r.facing || '').replace(/朝|\s/g, '') || '未知'],
  ];
  const TOGGLES = [['onlyStar', '只看★'], ['onlyLocated', '只看已定位'], ['noComm', '排除商水商电'], ['showHidden', '显示已隐藏/拉黑']];

  // 小区黑名单：整个小区不再显示，跨会话、跨查询保留。键带城市，避免不同城市同名小区误伤
  const blacklist = new Set(GM_getValue('kef-blk', []));
  const blkKeyOf = (community) => `${cfg.cityId}:${community}`;
  const isBlk = (r) => !!r.community && blacklist.has(blkKeyOf(r.community));
  let showBlkList = false;

  // skip：算某个分面的计数时跳过它自己，否则选了「2室」之后「3室」永远显示 0
  function viewPass(r, skip) {
    if (r.alive === false) return false;
    const m = marks[r.url];
    if (m === 'hide' && !vf.showHidden) return false;
    if (!vf.showHidden && isBlk(r)) return false;
    if (vf.onlyStar && m !== 'star') return false;
    if (!passes(r, cfg)) return false;
    if (vf.onlyLocated && r.lng == null) return false;
    if (vf.noComm && r.water === '商水') return false;
    for (const [k, , fn] of FACETS) if (k !== skip && vf[k].length && !vf[k].includes(fn(r))) return false;
    const hay = `${r.title} ${r.community} ${r.tags} ${r.layout} ${r.facing} ${r.brand} ${r.cardType}`;
    const words = (s) => s.split(/\s+/).filter(Boolean);
    if (words(vf.kw).some((w) => !hay.includes(w))) return false;
    if (words(vf.exkw).some((w) => hay.includes(w))) return false;
    return true;
  }

  // 被筛掉的原因（和 viewPass 同一套顺序），聚焦小区时告诉用户「另有几套被什么条件筛掉了」
  function hiddenReason(r) {
    const m = marks[r.url];
    if (m === 'hide' && !vf.showHidden) return '手动隐藏';
    if (!vf.showHidden && isBlk(r)) return '拉黑';
    if (vf.onlyStar && m !== 'star') return '只看★';
    if (cfg.minArea > 0 && r.area < cfg.minArea) return '面积';
    if (cfg.maxArea > 0 && r.area > cfg.maxArea) return '面积';
    if ((cfg.minPrice > 0 && r.price < cfg.minPrice) || (cfg.maxPrice > 0 && r.price > cfg.maxPrice)) return '租金';
    if (cfg.maxUnitPrice > 0 && r.unitPrice > cfg.maxUnitPrice) return '单价';
    if (r.distKm != null && cfg.radiusKm > 0 && r.distKm > cfg.radiusKm) return '半径';
    if (!commuteOK(r, cfg)) return '通勤';
    for (const [k, name, fn] of FACETS) if (vf[k].length && !vf[k].includes(fn(r))) return name;
    if (!viewPass(r)) return '其他条件';
    return '';
  }

  // 结果筛选里正在生效的条件，一行写出来，免得忘了自己勾过什么
  function activeFilters() {
    const out = FACETS.filter(([k]) => vf[k].length).map(([k, name]) => `${name}=${vf[k].join('/')}`);
    if (vf.kw) out.push(`包含「${vf.kw}」`);
    if (vf.exkw) out.push(`排除「${vf.exkw}」`);
    for (const [k, t] of TOGGLES) if (vf[k] && k !== 'showHidden') out.push(t);
    return out;
  }
  let focusAll = false;         // 聚焦小区时，临时把被筛掉的也列出来

  // 本地视图只能在查到的范围里收紧，放宽到范围外的部分要重新查询
  function loosened() {
    const a = queryCfg;
    if (!a) return '';
    const out = [];
    if (cfg.minArea < a.minArea) out.push('面积下限');
    if (a.minPrice > 0 && cfg.minPrice < a.minPrice) out.push('租金下限');
    if (a.maxPrice > 0 && (cfg.maxPrice === 0 || cfg.maxPrice > a.maxPrice)) out.push('租金上限');
    if (cfg.radiusKm > a.radiusKm) out.push('半径');
    if (cfg.anchorLng !== a.anchorLng || cfg.anchorLat !== a.anchorLat || cfg.cityId !== a.cityId) out.push('锚点');
    return out.join('、');
  }

  function recomputeDist() {
    for (const r of all) {
      if (r.lat != null) r.distKm = +haversineKm(cfg.anchorLat, cfg.anchorLng, r.lat, r.lng).toFixed(2);
    }
  }

  let refreshT = 0;
  function refresh({ fit = false } = {}) {
    clearTimeout(refreshT);
    rows = all.filter((r) => viewPass(r));
    if (focus && !rows.some((r) => groupKey(r) === focus)) focus = null;
    renderFacets(); renderTable(); renderNote();
    if (mapSync) drawOnMap(rows, fit);
  }
  const refreshSoon = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 150); };

  // 结果存本地：刷新页面后不用从 ① 重来（raw 也要存，地图同步时左侧列表要用）
  function saveResult() {
    lastResult = { all, queryCfg, savedAt: Date.now() };
    idbPut('result', 'last', lastResult);
  }
  function restoreResult() {
    const s = lastResult;
    if (!s || !Array.isArray(s.all) || !s.all.length) return null;
    all = s.all.filter((r) => (r.source || 'ke') === SITE);          // 只要本平台的（旧版本曾把安居客合进贝壳）
    if (!all.length) return null;
    queryCfg = s.queryCfg || null;
    recomputeDist();
    applyParking(all, cfg);
    applyAjk(all, cfg);
    applyCommute(all, cfg);
    for (const r of all) if (r.listedAt === undefined) r.listedAt = listedAtOf(r.url);   // 老版本存的结果没有这个字段
    applyDetail(all, cfg);
    return s;
  }

  function toggleBlk(community, { silent = false } = {}) {
    const key = blkKeyOf(community);
    const adding = !blacklist.has(key);
    if (adding) blacklist.add(key); else blacklist.delete(key);
    GM_setValue('kef-blk', [...blacklist]);
    if (adding && focus === community) focus = null;
    refresh();
    if (silent) return;
    if (adding) {
      const n = all.filter((r) => r.community === community).length;
      st(`已拉黑「${esc(community)}」（${n} 套），以后都不再显示。<a class="undo" data-ub="${esc(community)}">撤销</a>`);
    } else {
      st(`已把「${esc(community)}」移出黑名单。`);
    }
  }

  function toggleMark(url, kind) {
    if (marks[url] === kind) delete marks[url]; else marks[url] = kind;
    GM_setValue('kef-marks', marks);
    refresh();
  }

  // ══════════════════ 8. 在地图上画筛后结果 ══════════════════
  // 同一小区的房源共用一个坐标，一套一个标记会全叠在一起只看得见最上面那个。
  // 所以按小区聚合成一个价格气泡；颜色按小区里最便宜的元/㎡ 在当前结果里的四分位分档。
  const PIN_COLORS = ['#00ae66', '#3c9ce8', '#ff8f1f', '#f54a45'];   // 便宜 → 贵
  let pins = new Map();                                    // groupKey → { id, label, pt }
  let bands = [];                                          // 元/㎡ 三个分界 → 四档

  function quantiles(list) {
    const v = list.map((r) => r.unitPrice).filter((x) => x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return [q(0.25), q(0.5), q(0.75)];
  }
  const bandOf = (u) => { let i = 0; while (i < bands.length && u > bands[i]) i++; return i; };

  function clearOverlays() {
    if (!mapInstance) return;
    overlays.forEach((o) => { try { mapInstance.__kefRawRemove(o); } catch {} });
    overlays = [];
    pins = new Map();
  }

  /**
   * 贝壳的 React 组件每次 moveend/zoomend 都会 map.clearOverlays() 重画气泡，
   * 会把我们的标记一起清掉——表现就是「一操作就没了」。
   * 这里给实例的清理方法加一层：只清页面自己的覆盖物，我们的保留；
   * 再挂 moveend/zoomend 兜底，万一还是被抹掉就补回来。
   */
  function protectMap(map) {
    if (!map || map.__kefProtected) return;
    const rawClear = map.clearOverlays.bind(map);
    const rawRemove = map.removeOverlay.bind(map);
    map.__kefRawRemove = rawRemove;          // 我们自己删要走原始方法

    map.clearOverlays = function () {
      try {
        const mine = new Set(overlays);
        const all = map.getOverlays().slice();          // 先快照，边删边遍历会漏
        all.forEach((o) => { if (!mine.has(o)) rawRemove(o); });
      } catch { rawClear(); overlays = []; }
    };

    map.removeOverlay = function (o) {
      if (overlays.includes(o)) return;                 // 我们的，不许删
      return rawRemove(o);
    };

    // 地图同步开启时，页面自己的房源气泡不再加到地图上，地图上只剩筛选后的标记。
    // 关掉同步后恢复原样，页面下次刷新气泡就回来了
    const rawAdd = map.addOverlay.bind(map);
    map.addOverlay = function (o) {
      if (mapSync && o && !o.__kef) return;
      return rawAdd(o);
    };

    const ensure = () => {
      if (!overlays.length) return;
      try {
        const present = new Set(map.getOverlays());
        overlays.forEach((o) => { if (!present.has(o)) map.addOverlay(o); });
      } catch {}
    };
    map.addEventListener('moveend', ensure);
    map.addEventListener('zoomend', ensure);
    map.addEventListener('zoomend', updateCompact);
    map.__kefProtected = true;
  }

  // 气泡用 Label 承载自定义 HTML：容器样式清空，视觉全在 .kef-pin 上
  function addPin(NS, pt, html, z) {
    const lbl = new NS.Label(html, { position: pt, offset: new NS.Size(0, 0) });
    lbl.setStyle({ border: '0', background: 'transparent', padding: '0' });
    try { lbl.setZIndex(z); } catch {}
    lbl.__kef = true;
    mapInstance.addOverlay(lbl);
    overlays.push(lbl);
    return lbl;
  }

  function drawOnMap(list, fit) {
    const NS = W.BMap;
    if (!mapInstance || !NS) return { n: 0, g: 0 };
    protectMap(mapInstance);
    clearOverlays();
    bands = quantiles(list);

    const groups = new Map();
    for (const r of list) {
      if (r.lng == null) continue;
      const k = groupKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }

    // 半径圈 + 锚点
    const anchor = new NS.Point(cfg.anchorLng, cfg.anchorLat);
    const circle = new NS.Circle(anchor, cfg.radiusKm * 1000, {
      strokeColor: '#00ae66', strokeWeight: 2, strokeOpacity: 0.7, fillColor: '#00ae66', fillOpacity: 0.05,
    });
    circle.__kef = true;
    mapInstance.addOverlay(circle); overlays.push(circle);
    addPin(NS, anchor, `<div class="kef-pin kef-anchor">📍 ${esc(cfg.anchorName || '锚点')}</div>`, 1);

    let n = 0, id = 0;
    const pts = [anchor];
    for (const [k, items] of groups) {
      const best = items.reduce((a, b) => (b.unitPrice > 0 && (!(a.unitPrice > 0) || b.unitPrice < a.unitPrice) ? b : a));
      const minPrice = Math.min(...items.map((r) => r.price));
      const star = items.some((r) => marks[r.url] === 'star');
      const color = PIN_COLORS[bandOf(best.unitPrice)];
      const pt = new NS.Point(best.lng, best.lat);
      const tip = `${items[0].community}｜${items.length} 套｜最低 ${best.unitPrice} 元/㎡${best.year ? `｜${best.year}年竣工` : ''}${best.commute ? `
${commuteTip(best)}` : ''}`;
      const html = `<div class="kef-pin${focus === k ? ' hl' : ''}${star ? ' star' : ''}" data-g="${id}" style="--c:${color}" title="${esc(tip)}">`
        + `${star ? '★ ' : ''}<b>${minPrice}${items.length > 1 ? '起' : ''}</b>`
        + `<span>${items.length > 1 ? `${items.length}套` : `${best.area}㎡`}</span></div>`;
      const lbl = addPin(NS, pt, html, star ? 3 : 2);
      lbl.addEventListener('click', () => focusGroup(k));
      lbl.addEventListener('mouseover', () => hlRows(k, true));
      lbl.addEventListener('mouseout', () => hlRows(k, false));
      pins.set(k, { id, label: lbl, pt });
      pts.push(pt);
      n += items.length; id++;
    }
    if (fit) { try { mapInstance.setViewport(pts); } catch {} }
    updateCompact();
    renderLegend();
    return { n, g: groups.size };
  }

  // 缩小时气泡会叠成一片：退化成彩色圆点，悬停/高亮/收藏的才展开成完整气泡
  function updateCompact() {
    try {
      const box = mapInstance.getContainer();
      box.classList.toggle('kef-compact', pins.size > 40 && mapInstance.getZoom() <= 15);
    } catch {}
  }

  function hlPin(k, on) {
    const p = pins.get(k);
    if (!p) return;
    document.querySelector(`.kef-pin[data-g="${p.id}"]`)?.classList.toggle('hl', on);
    try { p.label.setZIndex(on ? 1e6 : 2); } catch {}
  }

  function hlRows(k, on) {
    $('tb')?.querySelectorAll('tr').forEach((tr) => { if (tr.dataset.g === k) tr.classList.toggle('hl', on); });
  }

  // 点地图气泡：表格只看这个小区（再点一次取消）
  function focusGroup(k) {
    if (focus) hlPin(focus, false);
    focus = focus === k ? null : k;
    focusAll = false;
    if (focus) hlPin(focus, true);
    $('kef')?.classList.remove('min');
    renderTable(); renderNote();
    $('kef-table')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function renderLegend() {
    const el = $('legend');
    if (!el) return;
    if (!mapSync || !bands.length) { el.innerHTML = ''; return; }
    const lab = ['≤' + bands[0], '≤' + bands[1], '≤' + bands[2], '>' + bands[2]];
    el.innerHTML = '气泡颜色 = 小区最低元/㎡：' + lab.map((t, i) => `<span style="background:${PIN_COLORS[i]}">${t}</span>`).join('');
  }

  // ══════════════════════════ 9. 面板 UI ══════════════════════════
  const CSS = `
  #kef{position:fixed;right:16px;top:76px;z-index:2147483647;width:500px;max-height:88vh;display:flex;flex-direction:column;
    background:#fff;border:1px solid #d8dde3;border-radius:10px;box-shadow:0 10px 36px rgba(0,0,0,.18);
    font:13px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2329}
  #kef.min{max-height:42px;overflow:hidden}
  #kef header{padding:10px 13px;font-size:13px;font-weight:600;border-bottom:1px solid #eef1f4;background:#fafbfc;
    display:flex;align-items:center;justify-content:space-between;cursor:move;border-radius:10px 10px 0 0;user-select:none}
  #kef header button{border:0;background:none;cursor:pointer;font-size:15px;color:#8a9099;padding:0 3px;line-height:1}
  #kef header button.on{color:#00ae66}
  #kef.wide{width:min(1180px,calc(100vw - 32px))}
  #kef td.cell{white-space:nowrap;color:#646a73}
  #kef td.tags{white-space:normal;min-width:120px;font-size:11px;color:#8a9099}
  #kef .park-good{color:#00ae66;font-weight:600}
  #kef .park-ok{color:#3c9ce8}
  #kef .park-no{color:#a8adb3}
  #kef .park-bad{color:#f54a45}
  #kef .body{padding:11px 13px 13px;overflow:auto}
  #kef .row{display:grid;grid-template-columns:52px 1fr 52px 1fr;gap:6px 7px;align-items:center;margin-bottom:6px}
  #kef label.k{color:#8a9099;font-size:12px;white-space:nowrap}
  #kef input,#kef select{width:100%;box-sizing:border-box;padding:4px 7px;border:1px solid #d8dde3;
    border-radius:5px;font-size:12px;background:#fff;color:#1f2329}
  #kef details>summary{cursor:pointer;font-size:12px;color:#646a73;margin:4px 0;user-select:none}
  #kef .chips{display:flex;flex-wrap:wrap;gap:5px;margin:3px 0 8px}
  #kef .chip{padding:2px 9px;border:1px solid #d8dde3;border-radius:12px;font-size:12px;cursor:pointer;
    background:#fff;color:#646a73;user-select:none;white-space:nowrap}
  #kef .chip i{font-style:normal;color:#a8adb3;font-size:11px}
  #kef .chip.on{background:#00ae66;border-color:#00ae66;color:#fff}
  #kef .chip.on i{color:#d6f5e6}
  #kef .grp{font-size:11px;color:#a8adb3;margin:7px 0 2px}
  #kef .sec{margin-top:12px;padding-top:9px;border-top:1px dashed #e5e8eb}
  #kef .sec-h{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600;margin-bottom:6px}
  #kef .sec-h a{font-weight:400;color:#8a9099;cursor:pointer}
  #kef .kw{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
  #kef .frow{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-bottom:5px}
  #kef .fk{color:#8a9099;font-size:12px;width:30px}
  #kef .acts{display:flex;gap:6px;margin-top:10px}
  #kef .acts button{flex:1;padding:7px 0;border:0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500}
  #kef .primary{background:#00ae66;color:#fff}
  #kef .ghost{background:#f2f3f5;color:#1f2329}
  #kef .ghost.on{background:#00ae66;color:#fff}
  #kef .danger{background:#fdeceb;color:#f54a45}
  #kef .acts button:disabled{opacity:.45;cursor:not-allowed}
  #kef .status,#kef .note{margin-top:8px;font-size:12px;color:#646a73;min-height:16px}
  #kef .status b,#kef .note b{color:#00ae66}
  #kef .note .chip{margin-left:4px}
  #kef .legend{font-size:11px;color:#8a9099;margin-top:6px}
  #kef .legend span{display:inline-block;color:#fff;border-radius:8px;padding:0 6px;margin-left:4px}
  #kef .warn{color:#ff8f1f}
  #kef .err{color:#f54a45}
  #kef table{width:100%;border-collapse:collapse;margin-top:9px;font-size:12px}
  #kef th{text-align:left;padding:5px 3px;border-bottom:1.5px solid #e5e8eb;cursor:pointer;white-space:nowrap;
    color:#8a9099;font-weight:500;position:sticky;top:-11px;background:#fff;z-index:1}
  #kef th:hover{color:#00ae66}
  #kef th.on{color:#00ae66}
  #kef td{padding:5px 3px;border-bottom:1px solid #f2f3f5;vertical-align:top}
  #kef tr[data-u]{cursor:pointer}
  #kef tr.hl td{background:#e8f8f0}
  #kef tr.hid td{opacity:.45}
  #kef tr.blk td{opacity:.4}
  #kef tr.blk td a{text-decoration:line-through}
  #kef .blk-tag{font-size:11px;color:#f54a45}
  #kef .act[data-a="blk"]{font-size:11px;filter:grayscale(1);opacity:.55}
  #kef .act[data-a="blk"]:hover,#kef .act[data-a="blk"].on{filter:none;opacity:1}
  #kef .blk-btn{border-color:#f54a45;color:#f54a45}
  #kef .blk-list{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0 2px}
  #kef .blk-list .chip:hover{border-color:#f54a45;color:#f54a45}
  #kef a.link,#kef a.undo{color:#3c9ce8;cursor:pointer;margin-left:6px}
  #kef a.ajk{color:#3c9ce8;text-decoration:none;font-size:11px;white-space:nowrap}
  #kef a.ajk:hover{text-decoration:underline}
  #kef .new{color:#00ae66;font-weight:600}
  #kef .dup{font-size:10px;color:#8a9099;border:1px solid #d8dde3;border-radius:3px;padding:0 3px;cursor:help}
  #kef .presets{display:flex;gap:6px;align-items:center;margin:2px 0 6px}
  #kef .presets .k{color:#8a9099;font-size:12px;width:52px}
  #kef td a{color:#1f2329;text-decoration:none}
  #kef td a:hover{color:#00ae66;text-decoration:underline}
  #kef .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  #kef .sub{color:#a8adb3;font-size:11px}
  #kef .hot{color:#f54a45;font-weight:600}
  #kef .star{color:#f5a623}
  #kef .ops{white-space:nowrap;text-align:right}
  #kef .act{cursor:pointer;color:#a8adb3;padding:0 3px;font-size:13px}
  #kef .act:hover{color:#00ae66}
  #kef .act.on{color:#f5a623}
  .kef-pin{position:relative;display:inline-block;transform:translate(-50%,calc(-100% - 6px));transform-origin:50% 100%;
    background:var(--c,#00ae66);color:#fff;padding:1px 7px;border-radius:10px;white-space:nowrap;cursor:pointer;
    font:12px/18px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35);
    transition:transform .12s}
  .kef-pin::after{content:"";position:absolute;left:50%;bottom:-5px;margin-left:-5px;
    border:5px solid transparent;border-bottom:0;border-top-color:var(--c,#00ae66)}
  .kef-pin span{margin-left:5px;opacity:.85;font-size:11px}
  .kef-pin:hover,.kef-pin.hl{transform:translate(-50%,calc(-100% - 6px)) scale(1.2);outline:2px solid #1f2329;outline-offset:1px}
  .kef-anchor{--c:#1f2329;font-weight:600;cursor:default}
  .kef-compact .kef-pin:not(.hl):not(.star):not(.kef-anchor){width:12px;height:12px;padding:0;border-radius:50%;
    font-size:0;line-height:0;box-sizing:border-box;border:2px solid #fff;transform:translate(-50%,-50%)}
  .kef-compact .kef-pin:not(.hl):not(.star):not(.kef-anchor) *{display:none}
  .kef-compact .kef-pin:not(.hl):not(.star):not(.kef-anchor)::after{display:none}
  .kef-compact .kef-pin:not(.hl):not(.star):not(.kef-anchor):hover{transform:translate(-50%,-50%) scale(1.6);outline:0}
  @media (prefers-color-scheme:dark){
    #kef{background:#1f2329;border-color:#3a4048;color:#e3e6ea}
    #kef header{background:#252a31;border-bottom-color:#3a4048}
    #kef input,#kef select{background:#2a3038;border-color:#3a4048;color:#e3e6ea}
    #kef .chip{background:#2a3038;border-color:#3a4048;color:#a8adb3}
    #kef .chip.on{background:#00ae66;border-color:#00ae66;color:#fff}
    #kef .ghost{background:#2a3038;color:#e3e6ea}
    #kef .sec{border-top-color:#3a4048}
    #kef th{background:#1f2329;border-bottom-color:#3a4048}
    #kef td{border-bottom-color:#2a3038}#kef td a{color:#e3e6ea}
    #kef tr.hl td{background:#1d3a2c}
  }`;

  let sortKey = 'unitPrice', sortAsc = true;
  const chips = (name, list, sel) => list.map(([v, t]) =>
    `<span class="chip${(Array.isArray(sel) ? sel.includes(v) : sel === v) ? ' on' : ''}" data-n="${name}" data-v="${v}">${t}</span>`).join('');

  function panelHTML() {
    return `
    <header><span>${SITE === 'ajk' ? '安居客租房' : '贝壳租房'} · 筛选面板</span><span><button id="kef-wide" title="宽表：楼层 / 电梯 / 停车 / 水电 / 入住 / 标签 各占一列">⇔</button><button id="kef-min">—</button></span></header>
    <div class="body">
      <div class="row">
        <label class="k">面积≥</label><input type="number" id="f-amin" value="${cfg.minArea}">
        <label class="k">面积≤</label><input type="number" id="f-amax" value="${cfg.maxArea}">
        <label class="k">租金≥</label><input type="number" id="f-pmin" value="${cfg.minPrice}">
        <label class="k">租金≤</label><input type="number" id="f-pmax" value="${cfg.maxPrice}">
        <label class="k">元/㎡≤</label><input type="number" id="f-uprice" value="${cfg.maxUnitPrice}">
        <label class="k">半径km</label><input type="number" id="f-radius" step="0.5" value="${cfg.radiusKm}">
        <label class="k" title="自行车到锚点的分钟数上限。三项通勤满足任一即可">自行车≤</label><input type="number" id="f-bike" placeholder="分钟" value="${cfg.maxBikeMin || 0}">
        <label class="k" title="步行到锚点的分钟数上限。三项通勤满足任一即可">步行≤</label><input type="number" id="f-walk" placeholder="分钟" value="${cfg.maxWalkMin || 0}">
        <label class="k" title="地铁+自行车（接驳骑车）到锚点的分钟数上限。三项通勤满足任一即可">地铁+骑≤</label><input type="number" id="f-metro" placeholder="分钟" value="${cfg.maxMetroMin || 0}">
        <label class="k">锚点</label><input type="text" id="f-aname" value="${esc(cfg.anchorName)}" placeholder="输地名回车，或地图上右键">
        <label class="k">城市ID</label><input type="number" id="f-city" value="${cfg.cityId}">
        <label class="k">经纬</label><input type="text" id="f-anchor" value="${cfg.anchorLng},${cfg.anchorLat}" title="锚点框输地名回车自动填；或在地图上右键直接设锚点">
        <label class="k">电梯</label><select id="f-ele">${VOCAB.elevator.map(([v, t]) => `<option value="${v}"${cfg.elevator === v ? ' selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="presets"><span class="k">预设</span><span class="chip" id="b-preset-bd" title="自行车≤20 / 步行≤30 / 地铁+自行车≤20 分钟，满足任一">字节房补</span></div>
      ${SITE === 'ajk' ? `<details id="query-opts" open><summary>安居客查询条件（改了要重新 ① 查询；朝向在下面结果筛选里筛）</summary>
        <div class="grp">方式</div><div class="chips">${chips('ajkRentType', AJK_VOCAB.rentType, cfg.ajkRentType)}</div>
        <div class="grp">户型（不选=不限）</div><div class="chips">${chips('ajkRooms', AJK_VOCAB.room, cfg.ajkRooms)}</div>
      </details>` : `<details id="query-opts" open><summary>贝壳官方条件（改了要重新 ① 查询）</summary>
        <div class="grp">方式</div><div class="chips">${chips('rentType', VOCAB.rentType, cfg.rentType)}</div>
        <div class="grp">户型（不选=不限）</div><div class="chips">${chips('rooms', VOCAB.room, cfg.rooms)}</div>
        <div class="grp">朝向</div><div class="chips">${chips('facings', VOCAB.facing, cfg.facings)}</div>
        <div class="grp">楼层</div><div class="chips">${chips('floors', VOCAB.floor, cfg.floors)}</div>
        <div class="grp">亮点</div><div class="chips">${chips('features', VOCAB.feature, cfg.features)}</div>
      </details>`}
      <div class="acts">
        <button class="primary" id="b-run">① 查询</button>
        <button class="ghost" id="b-geo" title="解析小区坐标，得到精确距离">② 定位</button>
        <button class="ghost" id="b-map" title="地图上只保留筛后房源，之后随筛选自动同步；再点一次还原">③ 画到地图</button>
        <button class="danger" id="b-stop">停止</button>
      </div>
      <div class="acts">
        <button class="ghost" id="b-park" title="按小区查百度 POI：小区自有停车场（地下/地上）、最近公共停车场距离。数据来自百度地图，有缓存">🅿 查停车</button>
        <button class="ghost" id="b-commute" title="按百度路线规划算每个小区到锚点的自行车 / 步行 / 地铁+自行车时间，有缓存">🚲 通勤</button>
        <button class="ghost" id="b-detail"${SITE === 'ajk' ? ' style="display:none"' : ''} title="逐套开详情页：剔除已下架，补楼层 / 电梯 / 车位 / 水电 / 燃气 / 入住 / 租期 + 精确坐标。慢，0.7s/套">④ 详情补全</button>
        <button class="ghost" id="b-csv">导出 CSV</button>
      </div>
      <div class="status" id="st">面积和半径是贝壳没有的维度。按 ①②③ 顺序点。</div>
      <div class="legend" id="legend"></div>

      <div class="sec" id="vf">
        <div class="sec-h"><span>结果筛选 <span class="sub">即时生效，不发请求；上面的数字框也是即时的</span></span><a id="v-reset">重置</a></div>
        <div class="kw">
          <input type="text" id="v-kw" placeholder="包含（空格=且）" value="${esc(vf.kw)}">
          <input type="text" id="v-ex" placeholder="排除（如：公寓 合租 地下）" value="${esc(vf.exkw)}">
        </div>
        <div id="facets"></div>
        <div class="note" id="vnote"></div>
      </div>

      <table id="kef-table">
        <thead id="th"></thead>
        <tbody id="tb"></tbody>
      </table>
    </div>`;
  }

  function readUI() {
    const g = $;
    const [lng, lat] = g('f-anchor').value.split(',').map((s) => parseFloat(s.trim()));
    const prevLng = cfg.anchorLng, prevLat = cfg.anchorLat;
    Object.assign(cfg, {
      minArea: num(g('f-amin').value), maxArea: num(g('f-amax').value),
      minPrice: num(g('f-pmin').value), maxPrice: num(g('f-pmax').value),
      maxUnitPrice: num(g('f-uprice').value), radiusKm: num(g('f-radius').value),
      maxBikeMin: num(g('f-bike').value), maxWalkMin: num(g('f-walk').value), maxMetroMin: num(g('f-metro').value),
      cityId: num(g('f-city').value), anchorName: g('f-aname').value.trim(),
      elevator: g('f-ele').value,
      anchorLng: Number.isFinite(lng) ? lng : cfg.anchorLng,
      anchorLat: Number.isFinite(lat) ? lat : cfg.anchorLat,
    });
    if (cfg.anchorLng !== prevLng || cfg.anchorLat !== prevLat) { recomputeDist(); applyCommute(all, cfg); }
    GM_setValue('kef-cfg', cfg);
    return cfg;
  }

  const st = (h) => { const e = $('st'); if (e) e.innerHTML = h; };

  function renderFacets() {
    const box = $('facets');
    if (!box) return;
    const rowsHTML = FACETS.map(([k, name, fn]) => {
      const cnt = new Map();
      for (const r of all) if (viewPass(r, k)) { const v = fn(r); cnt.set(v, (cnt.get(v) || 0) + 1); }
      for (const v of vf[k]) if (!cnt.has(v)) cnt.set(v, 0);
      if (cnt.size <= 1 && !vf[k].length) return '';           // 只有一种取值，没得筛
      const ORDER = { ages: ['2015年后', '2010–2014', '2000–2009', '2000年前', '房龄未知'], listed: ['7天内', '30天内', '90天内', '更早', '上架未知'],
        parks: ['车位充足', '车位一般', '车位紧张', '有地下车库·车位未知', '有车场·车位未知', '无小区车场', '未查'] };
      const items = [...cnt].sort((a, b) => (ORDER[k] ? ORDER[k].indexOf(a[0]) - ORDER[k].indexOf(b[0]) : k === 'rooms' ? a[0].localeCompare(b[0], 'zh') : b[1] - a[1]));
      return `<div class="frow"><span class="fk">${name}</span>${items.map(([v, c]) =>
        `<span class="chip${vf[k].includes(v) ? ' on' : ''}" data-f="${k}" data-v="${esc(v)}">${esc(v)} <i>${c}</i></span>`).join('')}</div>`;
    }).join('');
    const tg = `<div class="frow"><span class="fk">更多</span>${TOGGLES.map(([k, t]) =>
      `<span class="chip${vf[k] ? ' on' : ''}" data-t="${k}">${t}</span>`).join('')}</div>`;
    box.innerHTML = rowsHTML + tg;
  }

  function renderNote() {
    const el = $('vnote');
    if (!el) return;
    const blkHTML = () => {
      const mine = [...blacklist].filter((k) => k.startsWith(`${cfg.cityId}:`)).map((k) => k.slice(k.indexOf(':') + 1));
      if (!mine.length) return '';
      let s = ` · <a class="link" id="v-blk">已拉黑 ${mine.length} 个小区${showBlkList ? ' ▴' : ' ▾'}</a>`;
      if (showBlkList) {
        s += `<div class="blk-list">${mine.map((c) =>
          `<span class="chip" data-ub="${esc(c)}" title="移出黑名单">${esc(c)} ✕</span>`).join('')}</div>`;
      }
      return s;
    };
    if (!all.length) {
      el.innerHTML = '查询后在这里按居室 / 类型 / 品牌 / 关键词继续筛；表格里 ☆ 收藏、✕ 隐藏、⛔ 拉黑小区（都会记住）。' + blkHTML();
      return;
    }
    const alive = all.filter((r) => r.alive !== false);
    const nStar = alive.filter((r) => marks[r.url] === 'star').length;
    const nHide = alive.filter((r) => marks[r.url] === 'hide').length;
    const nBlk = alive.filter(isBlk).length;
    let h = `显示 <b>${rows.length}</b> / ${alive.length} 套`;
    if (nStar) h += ` · ★ ${nStar}`;
    if (nHide) h += ` · 已隐藏 ${nHide}`;
    if (nBlk) h += ` · 拉黑小区里 ${nBlk} 套`;
    h += blkHTML();
    const af = activeFilters();
    if (af.length) h += `<br><span class="sub">结果筛选生效中：${esc(af.join(' · '))}</span>`;
    if (focus) {
      const n = rows.filter((r) => groupKey(r) === focus).length;
      h += `<br><span class="chip on" id="v-unfocus" title="取消聚焦">只看 ${esc(focus)}（${n}）✕</span>`;
      if (!isBlk({ community: focus })) h += `<span class="chip blk-btn" data-ub="${esc(focus)}" title="整个小区以后都不再显示">⛔ 拉黑这个小区</span>`;
      // 这个小区里被筛掉的房源：数量 + 原因，点一下临时全部列出
      const hidden = all.filter((r) => groupKey(r) === focus && r.alive !== false && !rows.includes(r));
      if (hidden.length) {
        const why = {};
        hidden.forEach((r) => { const k = hiddenReason(r) || '其他条件'; why[k] = (why[k] || 0) + 1; });
        const txt = Object.entries(why).map(([k, v]) => `${k} ${v}`).join('、');
        h += `<span class="chip${focusAll ? ' on' : ''}" id="v-focusall" title="被筛掉的原因：${esc(txt)}">${focusAll ? '已显示全部' : `另有 ${hidden.length} 套被筛掉（${esc(txt)}）· 显示`}</span>`;
      }
    }
    const lo = loosened();
    if (lo) h += `<br><span class="warn">${lo}比查询时放宽了，范围外的房源要重新 ① 查询才有</span>`;
    el.innerHTML = h;
  }

  // 表格列。wide: 只在宽表（⇔）里单独成列；窄表时这些信息挤在小区名下面那行
  const COLS = [
    { k: 'area', t: '㎡', num: true },
    { k: 'price', t: '月租', num: true },
    { k: 'unitPrice', t: '元/㎡', num: true },
    { k: 'distKm', t: 'km', num: true, wide: true },
    { k: 'commuteBest', t: '通勤', num: true, v: (r) => commuteCell(r) },
    { k: 'bikeMin', t: '自行车', num: true, wide: true, v: (r) => minCell(r.bikeMin, cfg.maxBikeMin) },
    { k: 'walkMin', t: '步行', num: true, wide: true, v: (r) => minCell(r.walkMin, cfg.maxWalkMin) },
    { k: 'metroMin', t: '地铁+骑', num: true, wide: true, v: (r) => minCell(r.metroMin, cfg.maxMetroMin, r.commute && r.commute.metro && r.commute.metro.lines) },
    { k: 'listedAt', t: '上架', num: true, desc: true, v: (r) => listedCell(r) },
    { k: 'year', t: '竣工', num: true, v: (r) => (r.year ? `<span class="${r.year >= 2010 ? 'new' : ''}">${r.year}</span>` : ajkLink(r, '查')) },
    { k: 'floor', t: '楼层', wide: true },
    { k: 'elevatorInfo', t: '电梯', wide: true },
    { k: 'parkRatio', t: '车位比', wide: true, num: true, desc: true, v: (r) => parkHTML(r) },
    { k: 'parkNear', t: '最近车场', num: true, wide: true, v: (r) => (r.parkNear != null ? `${r.parkNear}m` : '') },
    { k: 'carSpot', t: '车位', wide: true },
    { k: 'ajkParkSpots', t: '车位数', wide: true },
    { k: 'ajkParkFee', t: '停车费', wide: true, v: (r) => (r.ajkParkFee ? esc(r.ajkParkFee) : ajkLink(r, '查')) },
    { k: 'water', t: '水电', wide: true, v: (r) => (r.water === '商水' ? '<span class="hot">商水商电</span>' : esc([r.water, r.power].filter(Boolean).join('/'))) },
    { k: 'gas', t: '燃气', wide: true },
    { k: 'checkin', t: '入住', wide: true },
    { k: 'lease', t: '租期', wide: true },
    { k: 'tags', t: '标签', wide: true, cls: 'tags' },
  ];
  let wide = !!GM_getValue('kef-wide', false);
  const visibleCols = () => COLS.filter((c) => wide || !c.wide);

  // 通勤：显示最快的那种方式，悬停看三种明细；满足上限的标绿
  function commuteCell(r) {
    if (r.commuteBest == null) return r.commute ? '<span class="park-no">远</span>' : '';
    const mode = r.commuteBest === r.bikeMin ? '骑' : r.commuteBest === r.metroMin ? '铁' : '走';
    const ok = (cfg.maxBikeMin || cfg.maxWalkMin || cfg.maxMetroMin) && commuteOK(r, cfg);
    return `<span class="${ok ? 'new' : ''}" title="${esc(commuteTip(r))}">${mode}${r.commuteBest}′</span>`;
  }
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // 今年的显示「10-05」，往年的显示「2023-06」；7 天内标绿
  function listedCell(r) {
    if (!r.listedAt) return '';
    const days = listedAgo(r);
    const full = ymd(r.listedAt);
    const text = new Date(r.listedAt).getFullYear() === new Date().getFullYear() ? full.slice(5) : full.slice(0, 7);
    return `<span class="${days <= 7 ? 'new' : ''}" title="${full}，约 ${days} 天前（由房源编号推算的首次挂牌时间）">${text}</span>`;
  }

  function minCell(v, max, tip) {
    if (v == null) return '';
    return `<span class="${max > 0 && v <= max ? 'new' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${v}′</span>`;
  }

  // 有车位比（安居客）就按车位比显示；没有就退回百度的「有没有车场」，并明说车位数未知
  function parkHTML(r) {
    const level = r.parkLevel;
    if (!level) return '';
    const cls = level === '车位充足' ? 'park-good' : level === '车位一般' ? 'park-ok' : level === '车位紧张' ? 'park-bad' : 'park-no';
    const tip = [];
    if (r.parkRatio != null) {
      tip.push(`车位比 1:${r.parkRatio}（每户 ${r.parkRatio} 个车位，来自安居客）`);
      if (r.ajkParkSpots) tip.push(`停车位：${r.ajkParkSpots}`);
      if (r.ajk && r.ajk.extra && r.ajk.extra['总户数']) tip.push(`总户数：${r.ajk.extra['总户数']}`);
      if (r.ajkParkFee) tip.push(`停车费：${r.ajkParkFee}`);
    } else {
      tip.push('车位数未知：百度地图只能看出有没有停车场，看不出车位够不够。在安居客打开小区详情页会记下车位比');
    }
    const names = (r.park && r.park.ownNames) || [];
    if (names.length) tip.push('百度地图上的小区停车场：' + names.join('、'));
    if (r.park) tip.push(`周边 ${PARK_RADIUS}m 内停车场 ${r.park.count} 个`);
    const text = r.parkRatio != null ? `1:${r.parkRatio} ${level.replace('车位', '')}` : level;
    return `<span class="${cls}" title="${esc(tip.join('\n'))}">${esc(text)}</span>`;
  }

  // 安居客小区页：房龄、停车费、车位数在那边。点开浏览时脚本会顺手记下（见第 0 节）
  // 记过的小区直接跳详情页，没记过的跳安居客小区搜索。打开浏览时脚本会把房龄、停车费记下来
  function ajkLink(r, label = '安居客') {
    if (!r.community) return '';
    const sub = AJK_CITY[cfg.cityId] || 'www';
    const name = normName(r.community);
    const href = (r.ajk && r.ajk.url) || `https://${sub}.anjuke.com/community/?kw=${encodeURIComponent(name)}`;
    return `<a class="ajk" href="${esc(href)}" target="_blank" rel="noopener" title="在安居客打开「${esc(name)}」，页面上的竣工年份、停车费、车位数会自动记下">${label}↗</a>`;
  }

  // 窄表：小区名下面一行塞下户型、楼层、电梯、停车这些
  function subLine(r) {
    const bits = [r.layout, r.facing, r.brand].filter(Boolean).map(esc);
    if (!wide) {
      if (r.floor) bits.push(esc(r.floor));
      if (r.elevatorInfo) bits.push(`电梯${esc(r.elevatorInfo)}`);
      if (r.parkLevel) bits.push(`🅿${parkHTML(r)} ${ajkLink(r)}`);
      if (r.carSpot) bits.push(`车位${esc(r.carSpot)}`);
      if (r.water === '商水') bits.push('<span class="hot">商水商电</span>');
    }
    return bits.join(' · ');
  }

  function renderTable() {
    const tb = $('tb');
    if (!tb) return;
    rows.sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      const c = typeof x === 'string' || typeof y === 'string'
        ? (x || '￿').localeCompare(y || '￿', 'zh')         // 空值永远排最后
        : (x ?? 1e9) - (y ?? 1e9);
      return sortAsc ? c : -c;
    });
    const cols = visibleCols();
    const list = !focus ? rows
      : focusAll ? all.filter((r) => groupKey(r) === focus && r.alive !== false)    // 聚焦小区时临时显示全部（含被筛掉的）
      : rows.filter((r) => groupKey(r) === focus);
    $('th').innerHTML = `<tr><th data-k="community">小区 · ${list.length} 套</th>`
      + cols.map((c) => (c.nosort ? `<th>${c.t}</th>` : `<th data-k="${c.k}"${c.num ? ' class="num"' : ''}>${c.t}</th>`)).join('') + '<th></th></tr>';
    $('th').querySelectorAll('th[data-k]').forEach((th) => th.classList.toggle('on', th.dataset.k === sortKey));
    tb.innerHTML = list.slice(0, 500).map((r) => {
      const m = marks[r.url];
      const blk = isBlk(r);
      const cls = [(m === 'hide' || (focusAll && !rows.includes(r))) && 'hid', blk && 'blk'].filter(Boolean).join(' ');
      return `
      <tr data-u="${esc(r.url)}" data-g="${esc(groupKey(r))}"${cls ? ` class="${cls}"` : ''}>
        <td><a href="${esc(r.url)}" target="_blank" title="${esc(r.title)}">${esc(r.community)}</a>${r.dupUrls ? ` <span class="dup" title="同一套房还被挂了 ${r.dupUrls.length} 次：\n${esc(r.dupUrls.join('\n'))}">×${r.dupUrls.length + 1}</span>` : ''}${m === 'star' ? ' <span class="star">★</span>' : ''}${blk ? ' <span class="blk-tag">已拉黑</span>' : ''}
          <div class="sub">${subLine(r)}</div></td>
        ${cols.map((c) => `<td class="${c.num ? 'num' : 'cell'}${c.cls ? ` ${c.cls}` : ''}">${c.v ? c.v(r) : esc(r[c.k] ?? '')}</td>`).join('')}
        <td class="ops"><span class="act${m === 'star' ? ' on' : ''}" data-a="star" title="收藏">${m === 'star' ? '★' : '☆'}</span><span class="act" data-a="hide" title="${m === 'hide' ? '取消隐藏' : '隐藏这套'}">${m === 'hide' ? '↺' : '✕'}</span><span class="act${blk ? ' on' : ''}" data-a="blk" title="${blk ? '移出黑名单' : '拉黑整个小区，以后都不再显示'}">⛔</span></td></tr>`;
    }).join('') + (list.length > 500 ? `<tr><td colspan="${cols.length + 2}" class="sub">还有 ${list.length - 500} 套没列出，收紧条件或导出 CSV</td></tr>` : '');
  }

  function exportCSV() {
    const cols = ['source', 'community', 'title', 'area', 'layout', 'facing', 'price', 'unitPrice', 'distKm', 'floor', 'elevatorInfo',
      'bikeMin', 'walkMin', 'metroMin', 'listedDate', 'year', 'parkLabel', 'parkNear', 'carSpot', 'ajkParkSpots', 'ajkParkFee', 'water', 'power', 'gas', 'heating', 'checkin', 'lease', 'brand', 'cardType', 'tags', 'star', 'url'];
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(c === 'star' ? (marks[r.url] === 'star' ? '★' : '') : c === 'listedDate' ? (r.listedAt ? ymd(r.listedAt) : '') : r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `贝壳-${cfg.minArea}平以上-${cfg.maxPrice}以内-${rows.length}套.csv`;
    a.click();
  }

  function guard(btnId, fn) {
    return async () => {
      if (busy) return;
      busy = true; abort = false;
      const btn = $(btnId);
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '进行中';
      try { await fn(); }
      catch (e) { st(`<span class="err">失败：${esc(e.message)}</span>`); console.error('[kef]', e); }
      finally { busy = false; btn.disabled = false; btn.textContent = label; }
    };
  }

  // 官方条件栏查询后会折叠，标题里直接写出勾了什么——曾经勾着「精装修」忘了，漏掉一批房源
  function officialSummary() {
    const groups = {};
    document.querySelectorAll('#query-opts .chip.on').forEach((c) => {
      if (c.dataset.v === '') return;                                   // 「不限」不用写
      (groups[c.dataset.n] = groups[c.dataset.n] || []).push(c.textContent.trim());
    });
    return Object.values(groups).map((v) => v.join('/')).join(' · ') || '不限';
  }
  function updateOptsSummary() {
    const s = document.querySelector('#query-opts summary');
    if (s) s.textContent = `${SITE === 'ajk' ? '安居客' : '贝壳'}官方条件：${officialSummary()}（改了要重新 ① 查询）`;
  }

  function setMapBtn() {
    const b = $('b-map');
    if (!b) return;
    b.classList.toggle('on', mapSync);
    b.textContent = mapSync ? '③ 地图同步中' : '③ 画到地图';
  }

  function mount() {
    if ($('kef')) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const el = document.createElement('div'); el.id = 'kef'; el.innerHTML = panelHTML();
    document.body.appendChild(el);

    let drag = null;
    el.querySelector('header').addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop }; e.preventDefault();
    });
    addEventListener('mousemove', (e) => {
      if (!drag) return;
      el.style.left = `${drag.l + e.clientX - drag.x}px`;
      el.style.top = `${drag.t + e.clientY - drag.y}px`; el.style.right = 'auto';
    });
    addEventListener('mouseup', () => { drag = null; });

    el.querySelector('#kef-min').onclick = () => el.classList.toggle('min');

    // 官方条件（查询用）
    el.querySelectorAll('.chip[data-n]').forEach((c) => {
      c.onclick = () => {
        const n = c.dataset.n, v = c.dataset.v;
        if (n === 'rentType' || n === 'ajkRentType') {                  // 单选
          el.querySelectorAll(`[data-n="${n}"]`).forEach((x) => x.classList.remove('on'));
          c.classList.add('on'); cfg[n] = v;
        } else {
          c.classList.toggle('on');
          cfg[n] = [...el.querySelectorAll(`[data-n="${n}"].on`)].map((x) => x.dataset.v);
        }
        GM_setValue('kef-cfg', cfg);
        updateOptsSummary();
      };
    });
    updateOptsSummary();

    // 数字框即时筛选：查过之后改面积/租金/单价/半径，结果和地图立刻跟着变
    ['f-amin', 'f-amax', 'f-pmin', 'f-pmax', 'f-uprice', 'f-radius', 'f-bike', 'f-walk', 'f-metro', 'f-anchor'].forEach((id) => {
      el.querySelector(`#${id}`).addEventListener('input', () => { readUI(); if (all.length) refreshSoon(); });
    });

    // 结果筛选：分面 / 开关 / 聚焦 / 重置，全部委托
    el.querySelector('#vf').addEventListener('click', (e) => {
      const t = e.target.closest('[data-f],[data-t],[data-ub],#v-unfocus,#v-reset,#v-blk,#v-focusall');
      if (!t) return;
      if (t.dataset.ub != null) { toggleBlk(t.dataset.ub); return; }   // 拉黑 / 移出黑名单
      if (t.id === 'v-blk') { showBlkList = !showBlkList; renderNote(); return; }
      if (t.id === 'v-focusall') { focusAll = !focusAll; renderTable(); renderNote(); return; }
      if (t.dataset.f) {
        const k = t.dataset.f, v = t.dataset.v;
        vf[k] = vf[k].includes(v) ? vf[k].filter((x) => x !== v) : [...vf[k], v];
      } else if (t.dataset.t) {
        vf[t.dataset.t] = !vf[t.dataset.t];
      } else if (t.id === 'v-unfocus') {
        focusGroup(focus); return;
      } else if (t.id === 'v-reset') {
        Object.assign(vf, VF_DEFAULT, { rooms: [], types: [], brands: [], parks: [], ages: [], listed: [], facings: [] });
        el.querySelector('#v-kw').value = ''; el.querySelector('#v-ex').value = '';
        focus = null;
      }
      GM_setValue('kef-vf', vf);
      refresh();
    });
    const onKw = () => {
      vf.kw = el.querySelector('#v-kw').value.trim();
      vf.exkw = el.querySelector('#v-ex').value.trim();
      GM_setValue('kef-vf', vf);
      refreshSoon();
    };
    el.querySelector('#v-kw').addEventListener('input', onKw);
    el.querySelector('#v-ex').addEventListener('input', onKw);

    // 表头每次重画（宽/窄表列不同），排序走委托
    el.querySelector('#th').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-k]');
      if (!th) return;
      const k = th.dataset.k;
      if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = !(COLS.find((c) => c.k === k) || {}).desc; }   // 上架这类默认新的在前
      renderTable();
    });

    const applyWide = () => { el.classList.toggle('wide', wide); $('kef-wide').classList.toggle('on', wide); };
    el.querySelector('#kef-wide').onclick = () => {
      wide = !wide; GM_setValue('kef-wide', wide);
      if (wide) { el.style.left = ''; el.style.right = '16px'; }    // 变宽后别跑出屏幕
      applyWide(); renderTable();
    };
    applyWide();

    // 表格 ↔ 地图：悬停高亮气泡，点行把地图移过去，☆/✕ 收藏隐藏
    const tb = el.querySelector('#tb');
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-u]');
      if (!tr || e.target.closest('a')) return;
      const act = e.target.closest('[data-a]');
      if (act && act.dataset.a === 'blk') { toggleBlk(tr.dataset.g); return; }
      if (act) { toggleMark(tr.dataset.u, act.dataset.a); return; }
      const p = pins.get(tr.dataset.g);
      if (p && mapInstance) {
        try { mapInstance.panTo(p.pt); } catch {}
        hlPin(tr.dataset.g, true);
        setTimeout(() => { if (focus !== tr.dataset.g) hlPin(tr.dataset.g, false); }, 1500);
      }
    });
    let hovered = null;
    tb.addEventListener('mouseover', (e) => {
      const g = e.target.closest('tr[data-g]')?.dataset.g ?? null;
      if (g === hovered) return;
      if (hovered != null && hovered !== focus) hlPin(hovered, false);
      hovered = g;
      if (g != null) hlPin(g, true);
    });
    tb.addEventListener('mouseleave', () => { if (hovered != null && hovered !== focus) hlPin(hovered, false); hovered = null; });

    el.querySelector('#f-aname').onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      st('定位中…');
      const p = await geocodeOne(`${e.target.value} ${cfg.cityId === 310000 ? '上海' : ''}`);
      if (p) {
        el.querySelector('#f-anchor').value = `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
        readUI();
        st('锚点已更新，距离已按新锚点重算');
        if (all.length) refresh({ fit: true });
      } else st('<span class="err">没找到这个地名，直接填经纬度也行</span>');
    };

    // 地图上右键 = 把这里设为锚点（比输地名直接）
    const waitMap = setInterval(() => {
      if (!mapInstance) return;
      clearInterval(waitMap);
      mapInstance.addEventListener('rightclick', (e) => {
        if (!e || !e.point) return;
        el.querySelector('#f-anchor').value = `${e.point.lng.toFixed(6)},${e.point.lat.toFixed(6)}`;
        el.querySelector('#f-aname').value = '地图选点';
        readUI();
        if (all.length) refresh();
        const lo = loosened();
        st(`锚点已设到右键位置，距离已重算。${lo ? '<br><span class="warn">锚点变了，范围外的房源要重新 ① 查询。</span>' : ''}`);
      });
    }, 500);

    el.querySelector('#b-stop').onclick = () => { abort = true; st('<span class="warn">已请求停止…</span>'); };

    // 状态栏里的「撤销」拉黑
    el.querySelector('#st').addEventListener('click', (e) => {
      const u = e.target.closest('[data-ub]');
      if (u) toggleBlk(u.dataset.ub);
    });

    el.querySelector('#b-run').onclick = guard('b-run', async () => {
      const c = readUI();
      reqCount = 0;
      const t0 = performance.now();
      const box = radiusToBBox(c.anchorLat, c.anchorLng, c.radiusKm);
      let res, ajkMsg = '';
      if (SITE === 'ajk') {
        // 安居客：不能按面积排序，按最新发布取前 N 页，面积和半径在本地筛
        const aj = await queryAnjuke(c, box,
          (p) => st(`安居客：${p.room ? `${p.room}室 ` : ''}第 ${p.page} 页 · 已拿到 ${p.found} / ${p.total} 套 · ${reqCount} 请求`));
        res = { list: aj.list, total: aj.total };
        ajkMsg = aj.total > aj.list.length ? `<br>范围内共 ${aj.total} 套，按最新发布每种户型取前 ${AJK_MAX_PAGES} 页；想看全可以缩小半径。` : '';
        if (aj.dup) ajkMsg += `<br>${aj.dup} 条是同一套房被重复挂出的（小区、户型、价格、面积都相同），已合并，表格里标「×N」。`;
        if (aj.error) ajkMsg += ` <span class="warn">${esc(aj.error)}，已停在这里${/验证/.test(aj.error) ? '（在页面上按提示完成验证后再查）' : ''}。</span>`;
      } else {
        res = await queryListings(c, box,
          (p) => st(`面积降序第 ${p.page} 页 · 命中 <b>${p.found}</b> / 候选 ${p.total} · ${reqCount} 请求`));
      }
      all = res.list.map((r) => Object.assign(r, { source: SITE }));
      // 坐标 / 停车按小区、详情按房源，缓存里有的直接带上，不发请求
      queryCfg = { ...c };                               // applyGeo 要用新的查询范围校验坐标
      applyGeo(all, c);
      applyParking(all, c);
      applyAjk(all, c);
      applyCommute(all, c);
      const nDetail = applyDetail(all, c);
      queryCfg = { ...c };
      focus = null;
      saveResult();
      refresh({ fit: true });
      let msg = `查到 ${all.length} 套，符合条件 <b>${rows.length}</b> 套（候选 ${res.total}，${reqCount} 请求，${((performance.now() - t0) / 1000).toFixed(1)}s）`;
      if (res.early) msg += ' · 降序提前收工';
      if (abort) msg += ' <span class="warn">· 已中止</span>';
      if (res.capped) msg += ' <span class="warn">· 触及 1000 条上限，建议缩半径或提高面积下限</span>';
      msg += ajkMsg;
      msg += `<br><span class="sub">官方条件：${esc(officialSummary())}</span>`;
      const located = all.filter((r) => r.lng != null).length;
      const parked = all.filter((r) => r.parkLabel).length;
      msg += `<br>缓存命中：坐标 ${located} 套 · 停车 ${parked} 套 · 详情 ${nDetail} 套。`;
      if (!all.length) msg += '没有符合条件的房源，放宽一下条件试试。';
      else msg += located < all.length ? '下一步点「② 定位」补剩下的坐标。' : '坐标齐了，可以直接点「③ 画到地图」。';
      st(msg);
      if (all.length) el.querySelector('#query-opts').open = false;   // 腾地方给结果
    });

    el.querySelector('#b-geo').onclick = guard('b-geo', async () => {
      if (!all.length) return st('先点「① 查询」');
      const c = readUI();
      await geocodeRows(all, c, (p) => st(`解析小区坐标 ${p.done}/${p.total}（百度地图）`));
      applyCommute(all, c);
      const located = all.filter((r) => r.lng != null).length;
      sortKey = 'distKm'; sortAsc = true;
      saveResult();
      refresh({ fit: true });
      st(`定位 ${located}/${all.length} 套；按 ${c.radiusKm}km 圆筛后显示 <b>${rows.length}</b> 套。<br>下一步点「③ 画到地图」。`);
    });

    el.querySelector('#b-map').onclick = () => {
      if (mapSync) {
        mapSync = false;
        clearOverlays(); setMapBtn(); renderLegend();
        try { mapInstance.panBy(1, 0); } catch {}       // 触发一次 moveend，让原生气泡回来
        return st(`已还原${SITE === 'ajk' ? '安居客' : '贝壳'}原生地图。`);
      }
      if (!all.length) return st('<span class="warn">还没有数据：先点「① 查询」，再点「② 定位」。</span>');
      if (!rows.length) return st('<span class="warn">当前筛选结果是 0 套，放宽一下结果筛选。</span>');
      if (!mapInstance) return st('<span class="err">没找到地图，刷新一下页面再试。</span>');
      if (!rows.some((r) => r.lng != null)) return st('<span class="warn">还没有坐标，先点「② 定位」。</span>');
      mapSync = true; setMapBtn();
      const { n, g } = drawOnMap(rows, true);
      try { mapInstance.clearOverlays(); } catch {}      // 清掉页面已画的气泡（我们的标记会保留）
      st(`地图上 <b>${g}</b> 个小区 / ${n} 套（同小区合并成一个气泡，原生气泡已隐藏）。<br>`
        + '点气泡 = 表格只看该小区；悬停表格行 = 高亮气泡；之后改筛选地图自动同步。');
    };

    el.querySelector('#b-detail').onclick = guard('b-detail', async () => {
      if (!rows.length) return st('先点「① 查询」');
      // 只补当前视图里还没补过的，可以中途停下、下次接着来
      const todo = rows.filter((r) => !r.detailed && r.source !== 'ajk');   // 安居客详情页结构不同，不补
      if (!todo.length) return st('当前显示的房源都已补全过详情。');
      let dead = 0, failed = 0, captcha = false, i = 0;
      for (; i < todo.length; i++) {
        if (abort) break;
        const r = todo[i];
        const d = await fetchDetail(r.url);
        if (d.captcha) { captcha = true; break; }
        r.alive = d.alive;
        r.deadReason = d.deadReason || '';
        if (d.alive != null) rememberDetail(r, d);           // 请求失败（null）不缓存，下次还会重试
        if (d.alive) {
          Object.assign(r, d);
          r.detailed = true;
          if (d.lat && d.lng) {
            r.preciseXY = true;
            r.distKm = +haversineKm(cfg.anchorLat, cfg.anchorLng, d.lat, d.lng).toFixed(2);
          }
        } else if (d.alive === false) dead++;
        else failed++;
        st(`详情补全 ${i + 1}/${todo.length} · 剔除失效 ${dead} 套 · 剩约 ${((todo.length - i) * DETAIL_DELAY / 1000).toFixed(0)}s`);
        if (i % 20 === 19) saveResult();                    // 中途也存，刷新不白跑
        await sleep(DETAIL_DELAY);
      }
      // alive === false 才丢；null（请求失败）保留，不误杀
      saveResult();
      refresh();
      let msg = `详情补全 ${i}/${todo.length}：剔除 <b>${dead}</b> 套失效，显示 <b>${rows.length}</b> 套。楼层 / 电梯 / 车位 / 水电已进表格（⇔ 宽表看全）。`;
      if (failed) msg += ` <span class="warn">${failed} 套请求失败，已保留。</span>`;
      if (captcha) msg += '<br><span class="err">贝壳页面要求先完成验证，已暂停。在新标签打开任意一套房源按提示完成，再点 ④ 会接着补。</span>';
      st(msg);
    });

    el.querySelector('#b-commute').onclick = guard('b-commute', async () => {
      if (!all.length) return st('<span class="warn">先点「① 查询」，再点「② 定位」。</span>');
      if (!all.some((r) => r.lng != null)) return st('<span class="warn">要先有小区坐标，点「② 定位」。</span>');
      const c = readUI();
      await lookupCommute(all, c, (p) => st(`算通勤路线 ${p.done}/${p.total} 个小区（自行车 / 步行 / 地铁，百度地图）`));
      saveResult();
      sortKey = 'commuteBest'; sortAsc = true;
      refresh();
      const comms = new Map(all.filter((r) => r.commute).map((r) => [r.community, r]));
      const cnt = (f) => [...comms.values()].filter(f).length;
      const okRows = all.filter((r) => r.commute && r.alive !== false && !isBlk(r) && commuteOK(r, cfg)).length;
      const anyLimit = cfg.maxBikeMin || cfg.maxWalkMin || cfg.maxMetroMin;
      st(`通勤算完 ${comms.size} 个小区：自行车 20 分钟内 ${cnt((r) => r.bikeMin != null && r.bikeMin <= 20)} 个 · `
        + `步行 30 分钟内 ${cnt((r) => r.walkMin != null && r.walkMin <= 30)} 个 · 地铁+骑 20 分钟内 ${cnt((r) => r.metroMin != null && r.metroMin <= 20)} 个。`
        + (anyLimit ? `<br>按当前通勤上限（满足任一）符合 <b>${okRows}</b> 套。` : '<br>在上面填通勤上限，或点「预设：字节房补」。'));
    });

    // 预设：字节房补的通勤要求——自行车 20 / 步行 30 / 地铁+自行车 20 分钟，满足任一。锚点用你设的办公地点
    el.querySelector('#b-preset-bd').onclick = () => {
      el.querySelector('#f-bike').value = 20;
      el.querySelector('#f-walk').value = 30;
      el.querySelector('#f-metro').value = 20;
      if (num(el.querySelector('#f-radius').value) < 5) el.querySelector('#f-radius').value = 5;   // 自行车 20 分钟大约直线 3～4km，地铁更远
      readUI();
      if (all.length) refresh();
      const lo = loosened();
      st('已套用「字节房补」通勤预设：自行车≤20 · 步行≤30 · 地铁+自行车≤20 分钟（满足任一）。锚点请设成你的办公地点。'
        + (lo ? '<br><span class="warn">半径放大到 5km 了，点「① 查询」重新查，再依次点「② 定位」「🚲 通勤」。</span>'
          : (all.length && !all.some((r) => r.commute) ? '<br>下一步点「🚲 通勤」算每个小区的通勤时间。' : '')));
    };

    // 在安居客浏览小区页时记下的新信息，实时同步过来
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener('kef-ajk', (_k, _old, v, remote) => {
        if (!remote) return;
        ajkDb = v || {};
        applyAjk(all, cfg);
        refresh();
        const n = all.filter((r) => r.year).length;
        st(`已同步安居客记下的小区信息：当前结果里 ${n} 套有竣工年份。`);
      });
    }

    el.querySelector('#b-park').onclick = guard('b-park', async () => {
      if (!all.length) return st('<span class="warn">先点「① 查询」，再点「② 定位」。</span>');
      if (!all.some((r) => r.lng != null)) return st('<span class="warn">要先有小区坐标，点「② 定位」。</span>');
      const c = readUI();
      await lookupParking(all, c, (p) => st(`查小区停车 ${p.done}/${p.total}（百度地图）`));
      saveResult();
      refresh();
      const byComm = new Map(all.filter((r) => r.parkLabel).map((r) => [r.community, r.parkLabel]));
      const cnt = (l) => [...byComm.values()].filter((v) => v === l).length;
      st(`停车查完 ${byComm.size} 个小区：地下车库 <b>${cnt('地下车库')}</b> · 仅地上 ${cnt('小区地上')} · 无小区车场 ${cnt('无小区车场')}。`
        + '<br>在「结果筛选 → 停车」里筛；⇔ 宽表能看最近公共停车场距离。');
    });

    el.querySelector('#b-csv').onclick = () => rows.length && exportCSV();

    renderFacets(); renderNote();
    // IndexedDB 是异步的，读完再恢复上次结果
    cacheReady.then(() => {
      if (all.length) return;                            // 等缓存期间已经手动查过了
      const restored = restoreResult();
      if (!restored) return;
      sortKey = 'distKm'; sortAsc = true;
      refresh();
      const mins = Math.round((Date.now() - restored.savedAt) / 60000);
      const ago = mins < 60 ? `${mins} 分钟` : mins < 2880 ? `${Math.round(mins / 60)} 小时` : `${Math.round(mins / 1440)} 天`;
      const located = all.filter((r) => r.lng != null).length;
      st(`已恢复上次结果：${all.length} 套（${ago}前查的，${located} 套有坐标）。`
        + (located ? '<br>可以直接点「③ 画到地图」，或重新 ① 查询拿最新房源。' : '<br>下一步点「② 定位」。'));
      el.querySelector('#query-opts').open = false;
    });
  }

  // 调试出口：在 Console 里 __kef.diag() 一把看清所有状态
  W.__kef = {
    get map() { return mapInstance; },
    get all() { return all; },
    get rows() { return rows; },
    get overlays() { return overlays; },
    get mapSync() { return mapSync; },
    cfg, vf, marks,
    redraw: () => drawOnMap(rows, false),
    clearCache,                              // __kef.clearCache() 清掉 IndexedDB 里的全部缓存
    focus: (k) => focusGroup(k),             // __kef.focus('小区名') 表格只看这个小区
    cacheStats: () => ({ IndexedDB: !!idb, 小区坐标: geoCache.size, 小区停车: parkCache.size, 房源详情: detailCache.size, 通勤路线: commuteCache.size, 安居客小区: Object.keys(ajkDb).length, 上次结果: lastResult ? lastResult.all.length : 0 }),
    diag() {
      const NS = W.BMap;
      const withXY = rows.filter((r) => r.lng && r.lat);
      return {
        脚本版本: '2.7.3',
        找到地图: !!mapInstance,
        BMap可用: !!NS,
        BMap有Label: !!(NS && NS.Label),
        地图同步中: mapSync,
        覆盖物保护已装: !!(mapInstance && mapInstance.__kefProtected),
        查到房源: all.length,
        当前显示: rows.length,
        其中有坐标: withXY.length,
        地图气泡数: pins.size,
        已画覆盖物: overlays.length,
        地图上覆盖物总数: (() => { try { return mapInstance.getOverlays().length; } catch (e) { return 'err:' + e.message; } })(),
        当前zoom: (() => { try { return mapInstance.getZoom(); } catch (e) { return null; } })(),
        样例坐标: withXY.slice(0, 3).map((r) => `${r.community} ${r.lng},${r.lat} ${r.distKm}km`),
        锚点: `${cfg.anchorLng},${cfg.anchorLat} 半径${cfg.radiusKm}km`,
        结果筛选: JSON.stringify(vf),
      };
    },
  };

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(mount, 1000));
  else setTimeout(mount, 1000);
})();
