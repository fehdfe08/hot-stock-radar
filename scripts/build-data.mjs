import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, "site", "data");
const OUT_FILE = path.join(DATA_DIR, "latest.json");

const EASTMONEY_REFERER = "https://guba.eastmoney.com/rank/";
const AES_KEY = Buffer.from(crypto.createHash("md5").update("getUtilsFromFile").digest("hex"), "utf8");
const AES_IV = Buffer.from("getClassFromFile", "utf8");

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const rank = await fetchTopRank(10);
  const stocks = await attachCatalysts(await enrichQuotes(rank));

  const sectors = topCounts(stocks.map((s) => s.industry), 8);
  const concepts = topCounts(stocks.flatMap((s) => s.concepts), 12);
  const leaders = [...stocks].sort((a, b) => b.rankChange - a.rankChange).slice(0, 3);
  const strong = stocks.filter((s) => typeof s.pct === "number" && s.pct >= 5).length;
  const catalystCount = stocks.filter((s) => s.catalysts.length > 0).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceTime: stocks[0]?.exactTime || "",
    sourceUrl: "https://guba.eastmoney.com/rank/",
    summary: {
      sectors,
      concepts,
      leaders: leaders.map((s) => pickStockSummary(s)),
      strongCount: strong,
      catalystCount,
      noCatalystCount: stocks.length - catalystCount
    },
    stocks
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUT_FILE}`);
}

async function fetchTopRank(limit) {
  const minute = new Date().getMinutes();
  const url = `https://gbcdn.dfcfw.com/rank/popularityList.js?type=0&sort=0&page=1&m=${minute}`;
  const text = await fetchText(url);
  const base64 = text.replace(/^var\s+popularityList='/, "").replace(/'\s*$/, "").replace(/\s/g, "");
  const decipher = crypto.createDecipheriv("aes-256-cbc", AES_KEY, AES_IV);
  const json = Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(json).slice(0, limit);
}

async function enrichQuotes(items) {
  const secids = items.map((item) => `${item.code.startsWith("6") ? "1" : "0"}.${item.code}`).join(",");
  const fields = [
    "f2", "f3", "f4", "f12", "f14", "f20", "f21", "f23", "f100", "f102", "f103", "f152"
  ].join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&np=3&ut=a79f54e3d4c8d44e494efb8f748db291&invt=2&secids=${secids}&fields=${fields}`;
  const quoteJson = await fetchJson(url);
  const byCode = new Map((quoteJson?.data?.diff || []).map((q) => [q.f12, q]));

  return items.map((item) => {
    const q = byCode.get(item.code) || {};
    const current = item.history?.at?.(-1) || {};
    return {
      code: item.code,
      name: clean(q.f14) || item.code,
      rank: Number(item.rankNumber),
      rankChange: Number(item.changeNumber || current.HISRANKCHANGE || 0),
      hourRankChange: Number(current.HOURRANKCHANGE || 0),
      price: numberOrNull(q.f2),
      pct: numberOrNull(q.f3),
      marketCap: numberOrNull(q.f20),
      floatMarketCap: numberOrNull(q.f21),
      pe: numberOrNull(q.f23),
      industry: clean(q.f100) || "未知行业",
      region: clean(q.f102) || "",
      concepts: splitConcepts(q.f103).slice(0, 10),
      newFans: Number(item.newFans || 0),
      ironsFans: Number(item.ironsFans || 0),
      hotScore: Number(current.HOTRANKSCORE || 0),
      exactTime: item.exactTime || current.CALCTIME || ""
    };
  });
}

async function attachCatalysts(stocks) {
  return Promise.all(stocks.map(async (stock) => {
    const catalysts = await fetchCatalysts(stock).catch((error) => {
      console.warn(`Catalyst fetch failed for ${stock.code}: ${error.message}`);
      return [];
    });
    return {
      ...stock,
      catalysts,
      drivers: buildDrivers(stock, catalysts)
    };
  }));
}

async function fetchCatalysts(stock) {
  const param = {
    uid: "",
    keyword: `${stock.name} ${stock.code}`,
    type: ["cmsArticleWebOld", "noticeWebHome", "researchReport"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: { searchScope: "ALL", sort: "DEFAULT", pageIndex: 1, pageSize: 8, preTag: "", postTag: "" },
      noticeWebHome: { pageIndex: 1, pageSize: 5, preTag: "", postTag: "" },
      researchReport: { client: "web", pageIndex: 1, pageSize: 5, preTag: "", postTag: "" }
    }
  };
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery&param=${encodeURIComponent(JSON.stringify(param))}`;
  const text = await fetchText(url, "https://so.eastmoney.com/");
  const result = parseJsonp(text)?.result || {};
  const items = [
    ...(result.cmsArticleWebOld || []).map((item) => normalizeCatalyst(item, "资讯")),
    ...(result.noticeWebHome || []).map((item) => normalizeCatalyst(item, "公告")),
    ...(result.researchReport || []).map((item) => normalizeCatalyst(item, "研报"))
  ];

  return items
    .filter((item) => isRelevantCatalyst(item, stock))
    .map((item) => ({ ...item, score: catalystScore(item) }))
    .sort((a, b) => b.score - a.score || new Date(b.date) - new Date(a.date))
    .slice(0, 2);
}

function buildDrivers(stock, catalysts) {
  const drivers = [];
  if (typeof stock.pct === "number") {
    if (stock.pct >= 9.8) drivers.push("涨停/强势");
    else if (stock.pct >= 5) drivers.push(`涨幅${stock.pct.toFixed(1)}%`);
    else if (stock.pct <= -5) drivers.push(`跌幅${stock.pct.toFixed(1)}%`);
  }
  if (stock.rankChange >= 10) drivers.push(`排名跃升${stock.rankChange}位`);
  else if (stock.rankChange > 0) drivers.push(`排名上升${stock.rankChange}位`);
  if (stock.hourRankChange > 0) drivers.push(`小时热度+${stock.hourRankChange}`);
  if (stock.newFans >= 60) drivers.push(`新晋粉丝${stock.newFans.toFixed(0)}%`);
  if (stock.industry && stock.industry !== "未知行业") drivers.push(stock.industry);
  drivers.push(...stock.concepts.slice(0, 2));
  if (catalysts[0]?.tag) drivers.push(catalysts[0].tag);
  return [...new Set(drivers.filter(Boolean))].slice(0, 6);
}

function normalizeCatalyst(item, type) {
  const title = cleanHtml(item.title);
  const content = cleanHtml(item.content);
  return {
    type,
    title,
    content: trimText(content, 120),
    date: clean(item.date),
    source: clean(item.mediaName || item.source),
    url: clean(item.url),
    tag: classifyCatalyst(`${title} ${content}`)
  };
}

function isRelevantCatalyst(item, stock) {
  const text = `${item.title} ${item.content}`;
  if (!item.title) return false;
  if (!(text.includes(stock.name) || text.includes(stock.code))) return false;
  if (isLowValueMarketItem(text)) return false;
  if (isStaleCatalyst(item)) return false;
  return catalystScore(item) >= 8;
}

function catalystScore(item) {
  const text = `${item.title} ${item.content}`;
  let score = 0;
  if (item.type === "公告") score += 8;
  if (item.type === "研报") score += 6;
  if (/业绩|净利润|营收|年报|季报|预告|同比|高增|扭亏|增长/.test(text)) score += 10;
  if (/中标|订单|合同|签订|合作|收购|并购|投资|扩产|项目|投产|产能/.test(text)) score += 10;
  if (/政策|国常会|发改委|工信部|补贴|规划|行业景气|涨价|供需|出口|国产替代/.test(text)) score += 8;
  if (/回购|增持|股权激励|分红|重组|定增|资产注入/.test(text)) score += 7;
  if (/机构|研报|评级|目标价|买入|增持评级|首次覆盖|深度/.test(text)) score += 5;
  if (/不包含|不涉及|暂无|没有|未开展|不属于|澄清/.test(text)) score -= 12;
  if (/下降|下滑|减少|亏损|风险|减持|诉讼|处罚|问询|监管函/.test(text)) score -= 8;
  const ageDays = (Date.now() - new Date(item.date).getTime()) / 86400000;
  if (Number.isFinite(ageDays)) {
    if (ageDays <= 7) score += 5;
    else if (ageDays <= 30) score += 3;
    else if (ageDays <= 90) score += 1;
    else score -= 4;
  }
  return score;
}

function isLowValueMarketItem(text) {
  return /龙虎榜|融资融券|大宗交易|北向资金|沪深股通|主力资金流向|盘口异动|快速拉升|快速跳水|涨跌幅偏离|换手率|成交额|复盘一览|投资者关系管理制度|投资者关系管理档案|调研活动信息|业绩说明会|路演活动|基金.*投资.*非公开发行/.test(text);
}

function isStaleCatalyst(item) {
  const time = new Date(item.date).getTime();
  if (!Number.isFinite(time)) return false;
  return (Date.now() - time) / 86400000 > 180;
}

function classifyCatalyst(text) {
  if (/业绩|净利润|营收|年报|季报|预告/.test(text)) return "业绩线索";
  if (/中标|订单|合同|签订|合作|收购|并购|投资|扩产|项目|投产|产能|公告/.test(text)) return "公告事件";
  if (/政策|规划|补贴|行业景气|涨价|供需|国产替代/.test(text)) return "行业催化";
  if (/回购|增持|股权激励|分红|重组|定增|资产注入/.test(text)) return "资本动作";
  if (/券商|机构|研报|评级/.test(text)) return "机构关注";
  return "实质资讯";
}

function pickStockSummary(stock) {
  return {
    code: stock.code,
    name: stock.name,
    rank: stock.rank,
    rankChange: stock.rankChange,
    pct: stock.pct,
    industry: stock.industry
  };
}

function topCounts(values, limit) {
  const counts = new Map();
  for (const value of values) {
    const key = clean(value);
    if (!key || key === "-") continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function splitConcepts(value) {
  return clean(value).split(",").map((x) => x.trim()).filter(Boolean).filter((x) => x !== "-");
}

function parseJsonp(text) {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("Invalid JSONP response");
  return JSON.parse(text.slice(start + 1, end));
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

async function fetchText(url, referer = EASTMONEY_REFERER) {
  const res = await fetch(url, { headers: { Referer: referer, "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

function clean(value) {
  return String(value ?? "").trim();
}

function cleanHtml(value) {
  return clean(value).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
}

function trimText(value, max = 80) {
  const text = cleanHtml(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
