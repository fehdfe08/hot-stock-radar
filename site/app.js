const state = {
  data: null,
  query: "",
  filter: "all"
};

const els = {
  updateText: document.querySelector("#updateText"),
  stockCount: document.querySelector("#stockCount"),
  strongCount: document.querySelector("#strongCount"),
  catalystCount: document.querySelector("#catalystCount"),
  noCatalystCount: document.querySelector("#noCatalystCount"),
  sectorList: document.querySelector("#sectorList"),
  conceptList: document.querySelector("#conceptList"),
  leaderList: document.querySelector("#leaderList"),
  stockGrid: document.querySelector("#stockGrid"),
  resultText: document.querySelector("#resultText"),
  emptyState: document.querySelector("#emptyState"),
  searchInput: document.querySelector("#searchInput"),
  filterSelect: document.querySelector("#filterSelect")
};

init();

async function init() {
  bindEvents();
  try {
    const res = await fetch("./data/latest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`数据加载失败：${res.status}`);
    state.data = await res.json();
    render();
  } catch (error) {
    renderError(error);
  }
}

function bindEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderStocks();
  });
  els.filterSelect.addEventListener("change", (event) => {
    state.filter = event.target.value;
    renderStocks();
  });
}

function render() {
  const { data } = state;
  const generated = formatDateTime(data.generatedAt);
  const source = data.sourceTime ? `榜单 ${data.sourceTime}` : generated;
  els.updateText.textContent = `${source} 更新`;
  els.stockCount.textContent = data.stocks.length;
  els.strongCount.textContent = data.summary.strongCount;
  els.catalystCount.textContent = data.summary.catalystCount;
  els.noCatalystCount.textContent = data.summary.noCatalystCount;
  renderChips(els.sectorList, data.summary.sectors);
  renderChips(els.conceptList, data.summary.concepts);
  renderLeaders();
  renderStocks();
}

function renderChips(container, items) {
  container.innerHTML = items.map((item) => (
    `<span class="chip">${escapeHtml(item.name)} <b>${item.count}</b></span>`
  )).join("");
}

function renderLeaders() {
  const leaders = state.data.summary.leaders;
  els.leaderList.innerHTML = leaders.map((stock) => `
    <div class="leader-row">
      <div>
        <strong>${escapeHtml(stock.name)}</strong>
        <span>${stock.code} / ${escapeHtml(stock.industry)}</span>
      </div>
      <em class="${classBySign(stock.rankChange)}">排名 ${formatSigned(stock.rankChange)}</em>
    </div>
  `).join("");
}

function renderStocks() {
  const stocks = getFilteredStocks();
  els.resultText.textContent = `${stocks.length} 只匹配`;
  els.emptyState.hidden = stocks.length > 0;
  els.stockGrid.innerHTML = stocks.map(renderStockCard).join("");
}

function getFilteredStocks() {
  const query = state.query;
  return state.data.stocks.filter((stock) => {
    const haystack = [
      stock.name,
      stock.code,
      stock.industry,
      stock.region,
      ...(stock.concepts || []),
      ...(stock.drivers || [])
    ].join(" ").toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "catalyst" && stock.catalysts.length > 0) ||
      (state.filter === "strong" && stock.pct >= 5) ||
      (state.filter === "rankup" && stock.rankChange > 0);
    return matchesQuery && matchesFilter;
  });
}

function renderStockCard(stock) {
  const catalyst = stock.catalysts[0];
  return `
    <article class="stock-card">
      <div class="stock-top">
        <div class="stock-title">
          <span class="rank">${stock.rank}</span>
          <div>
            <strong>${escapeHtml(stock.name)}</strong>
            <span>${stock.code} / ${escapeHtml(stock.industry)}</span>
          </div>
        </div>
        <div class="pct ${classBySign(stock.pct)}">${formatPct(stock.pct)}</div>
      </div>
      <div class="fields">
        ${field("排名变化", `<span class="rank-change ${classBySign(stock.rankChange)}">${formatSigned(stock.rankChange)}</span>`)}
        ${field("小时热度", formatSigned(stock.hourRankChange))}
        ${field("新晋粉丝", `${formatNumber(stock.newFans, 0)}%`)}
        ${field("PE", stock.pe === null ? "--" : formatNumber(stock.pe, 1))}
      </div>
      <ul class="drivers">
        ${stock.drivers.map((driver) => `<li>${escapeHtml(driver)}</li>`).join("")}
      </ul>
      <div class="catalyst">
        ${catalyst ? renderCatalyst(catalyst) : renderNoCatalyst()}
      </div>
    </article>
  `;
}

function field(label, value) {
  return `<div class="field"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderCatalyst(item) {
  const title = escapeHtml(trimText(item.title, 54));
  const date = item.date ? ` · ${item.date.slice(5, 16)}` : "";
  const source = item.source ? ` · ${escapeHtml(item.source)}` : "";
  const meta = `${escapeHtml(item.type)}${date}${source}`;
  return `
    <span class="catalyst-label">${escapeHtml(item.tag)}</span>
    <a href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer">${title}</a>
    <p>${meta}</p>
  `;
}

function renderNoCatalyst() {
  return `
    <span class="catalyst-label">交易热度</span>
    <p>未检索到实质事件，当前更偏交易热度或板块联动。</p>
  `;
}

function renderError(error) {
  els.updateText.textContent = "数据加载失败";
  els.stockGrid.innerHTML = "";
  els.emptyState.hidden = false;
  els.emptyState.textContent = error.message;
}

function formatDateTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatPct(value) {
  return typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "--";
}

function formatSigned(value) {
  if (typeof value !== "number") return "--";
  return value > 0 ? `+${value}` : `${value}`;
}

function formatNumber(value, digits = 2) {
  return typeof value === "number" ? value.toFixed(digits) : "--";
}

function classBySign(value) {
  if (typeof value !== "number") return "";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

function trimText(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value || "#");
}
