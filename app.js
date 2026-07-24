const state = { data: null, view: "etfs" };
const $ = (s) => document.querySelector(s);
const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const text = new TextDecoder();
const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

async function decrypt(password) {
  const payload = await fetch("encrypted-data.json", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("无法加载加密数据");
    return r.json();
  });
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(payload.salt), iterations: payload.iterations, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(payload.iv) }, key, b64(payload.ciphertext));
  return JSON.parse(text.decode(clear));
}

const columns = {
  etfs: [
    ["code","代码"],["name","名称"],["region","市场"],["signal","信号"],["score","总分"],
    ["price","价格"],["premium","溢价率"],["amount","成交额"],["mom63","63日动量"],["mom126","126日动量"],["max_dd","最大回撤"]
  ],
  stocks: [
    ["code","代码"],["name","名称"],["signal","信号"],["score","总分"],["quality_score","质量"],
    ["value_score","估值"],["pe","PE"],["pb","PB"],["roe","ROE"],["revenue_growth","营收增长"],
    ["profit_growth","利润增长"],["mom126","126日动量"],["max_dd","最大回撤"],["buy_state","买点判断"]
  ]
};
const pct = new Set(["premium","mom63","mom126","max_dd","revenue_growth","profit_growth","roe"]);
const money = new Set(["amount"]);
function value(key, raw) {
  if (raw === "" || raw == null) return "—";
  if (typeof raw === "string" && Number.isNaN(Number(raw))) return raw;
  if (Number.isNaN(Number(raw))) return "—";
  if (pct.has(key)) return `${fmt.format(Number(raw) * (["premium","mom63","mom126","max_dd"].includes(key) ? 100 : 1))}%`;
  if (money.has(key)) return Number(raw) >= 1e8 ? `${fmt.format(Number(raw)/1e8)}亿` : fmt.format(raw);
  if (key === "score" || key.endsWith("_score")) return fmt.format(raw);
  return raw;
}
function render() {
  const q = $("#search").value.trim().toLowerCase();
  const sig = $("#signal-filter").value;
  const rows = state.data[state.view].filter(r => {
    const hay = [r.code,r.name,r.region,r.signal].join(" ").toLowerCase();
    return (!q || hay.includes(q)) && (!sig || r.signal === sig);
  });
  const cols = columns[state.view];
  $("#thead").innerHTML = `<tr>${cols.map(([,label]) => `<th>${label}</th>`).join("")}</tr>`;
  $("#tbody").innerHTML = rows.map(r => `<tr>${cols.map(([key]) => {
    const cls = key === "score" ? "score" : "";
    const content = key === "signal" ? `<span class="signal">${r[key] || "—"}</span>` : value(key,r[key]);
    return `<td class="${cls}">${content}</td>`;
  }).join("")}</tr>`).join("");
  $("#count").textContent = `显示 ${rows.length} / ${state.data[state.view].length} 条`;
}
function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const validation = view === "validation";
  $("#ranking-toolbar").hidden = validation;
  $("#ranking-table").hidden = validation;
  $("#ranking-footnote").hidden = validation;
  $("#validation-panel").hidden = !validation;
  if (validation) {
    renderValidation();
    return;
  }
  $("#stock-method-button").hidden = view !== "stocks";
  const signals = [...new Set(state.data[view].map(r => r.signal).filter(Boolean))];
  $("#signal-filter").innerHTML = `<option value="">全部信号</option>${signals.map(s => `<option>${s}</option>`).join("")}`;
  $("#search").value = "";
  render();
}
function percent(raw) {
  return `${fmt.format(Number(raw) * 100)}%`;
}
function renderValidation() {
  const v = state.data.validation;
  const o = v.oos_metrics;
  const b = v.benchmark_metrics;
  $("#validation-summary").innerHTML = `
    <div><span>可靠度评级</span><strong class="grade">${v.reliability_grade}</strong></div>
    <p>${v.reliability_conclusion}</p>
    <small>数据 ${v.data_start} 至 ${v.data_end} · ${v.universe_tested} 只股票 · 测试 ${v.configurations_tested} 组参数 · 样本外 ${o.months} 个月</small>`;
  $("#validation-metrics").innerHTML = `
    <div><span>样本外年化</span><strong>${percent(o.cagr)}</strong><small>沪深300：${percent(b.cagr)}</small></div>
    <div><span>累计收益</span><strong>${percent(o.cumulative_return)}</strong><small>沪深300：${percent(b.cumulative_return)}</small></div>
    <div><span>最大回撤</span><strong>${percent(o.max_drawdown)}</strong><small>沪深300：${percent(b.max_drawdown)}</small></div>
    <div><span>月度胜率</span><strong>${percent(o.positive_month_rate)}</strong><small>跑赢基准月份：${percent(v.excess_positive_month_rate)}</small></div>
    <div><span>夏普比率</span><strong>${fmt.format(o.sharpe)}</strong><small>已扣单边 ${percent(v.transaction_cost_one_way)} 成本</small></div>`;
  $("#market-state").innerHTML = v.market_filter_on
    ? `<div class="market-badge market-on">市场趋势过滤：通过</div><p>仅对“回踩可分批”或“突破确认”标的考虑小仓位、分批执行。</p>`
    : `<div class="market-badge market-off">市场趋势过滤：未通过</div><p>当前不判定为理想的新开仓窗口。榜单中的强势股以“等待回踩”为主，不建议追高。</p>`;
  const timing = v.current_timing.slice(0, 20);
  $("#timing-tbody").innerHTML = timing.map(r => `<tr>
    <td>${r.code}</td><td>${r.name}</td><td class="score">${fmt.format(r.timing_score)}</td>
    <td><span class="signal">${r.buy_state}</span></td><td>${fmt.format(r.price)}</td>
    <td>${fmt.format(r.ma20)}</td><td>${fmt.format(r.ma120)}</td><td>${fmt.format(r.invalidation_reference)}</td>
  </tr>`).join("");
  $("#validation-limitations").innerHTML = v.limitations.map(x => `<li>${x}</li>`).join("");
}

$("#unlock-form").addEventListener("submit", async e => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true; button.textContent = "解密中…"; $("#error").textContent = "";
  try {
    state.data = await decrypt($("#password").value);
    const timing = new Map((state.data.validation?.current_timing || []).map(x => [x.code, x]));
    state.data.stocks = state.data.stocks.map(x => ({...x, buy_state: timing.get(x.code)?.buy_state || "未进入择时前100"}));
    $("#password").value = "";
    $("#lock").hidden = true; $("#dashboard").hidden = false;
    $("#updated").textContent = `模型数据更新时间：${state.data.updatedAt} · 共 ${state.data.etfs.length} 只 ETF / ${state.data.stocks.length} 只个股`;
    setView("etfs");
  } catch {
    $("#error").textContent = "密码错误，或加密数据加载失败。";
  } finally {
    button.disabled = false; button.textContent = "解锁";
  }
});
$("#lock-button").addEventListener("click", () => location.reload());
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
$("#search").addEventListener("input", render);
$("#signal-filter").addEventListener("change", render);
$("#stock-method-button").addEventListener("click", () => $("#stock-method-dialog").showModal());
$("#close-method-button").addEventListener("click", () => $("#stock-method-dialog").close());
$("#stock-method-dialog").addEventListener("click", e => {
  if (e.target === $("#stock-method-dialog")) $("#stock-method-dialog").close();
});
