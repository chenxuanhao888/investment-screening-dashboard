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
    ["profit_growth","利润增长"],["mom126","126日动量"],["max_dd","最大回撤"]
  ]
};
const pct = new Set(["premium","mom63","mom126","max_dd","revenue_growth","profit_growth","roe"]);
const money = new Set(["amount"]);
function value(key, raw) {
  if (raw === "" || raw == null || Number.isNaN(Number(raw))) return "—";
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
  const signals = [...new Set(state.data[view].map(r => r.signal).filter(Boolean))];
  $("#signal-filter").innerHTML = `<option value="">全部信号</option>${signals.map(s => `<option>${s}</option>`).join("")}`;
  $("#search").value = "";
  render();
}

$("#unlock-form").addEventListener("submit", async e => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true; button.textContent = "解密中…"; $("#error").textContent = "";
  try {
    state.data = await decrypt($("#password").value);
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
