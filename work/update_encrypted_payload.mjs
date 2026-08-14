import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const password = process.env.DASHBOARD_PASSWORD;
if (!password) throw new Error("DASHBOARD_PASSWORD secret is required");
const encryptedPath = process.argv[2] || "encrypted-data.json";
const snapshotPath = process.argv[3] || "work/daily_snapshot.json";
const payload = JSON.parse(readFileSync(encryptedPath, "utf8"));
const salt = Buffer.from(payload.salt, "base64");
const key = pbkdf2Sync(password, salt, payload.iterations, 32, "sha256");
const cipherBytes = Buffer.from(payload.ciphertext, "base64");
const tag = cipherBytes.subarray(cipherBytes.length - 16);
const ciphertext = cipherBytes.subarray(0, -16);
const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
decipher.setAuthTag(tag);
const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
const data = JSON.parse(clear.toString("utf8"));
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const frozen = JSON.parse(readFileSync("work/frozen_model.json", "utf8"));
if (snapshot.model_version !== frozen.model_version) {
  throw new Error(`Frozen model mismatch: ${snapshot.model_version} != ${frozen.model_version}`);
}

// Prospective validation is append-only by model version. A parameter change
// must use a new version and therefore starts a new, independent track record.
data.forwardValidation ||= {};
const fv = data.forwardValidation[frozen.model_version] ||= {
  model_version: frozen.model_version,
  frozen_at: frozen.frozen_at,
  assumptions: frozen.execution_assumptions,
  signals: [], positions: [], closed_positions: [], daily_summaries: [],
};

const quoteMap = new Map((snapshot.evaluation_quotes || []).map(q => [q.code, q]));
const entrySlip = frozen.execution_assumptions.entry_slippage_bps / 10000;
const exitSlip = frozen.execution_assumptions.exit_slippage_bps / 10000;
const maxDays = frozen.execution_assumptions.maximum_holding_days;
const isOnePriceBoard = q => q && q.high != null && q.low != null && q.high === q.low && q.open === q.high;
const round = x => Math.round(x * 10000) / 10000;

// Evaluate open positions conservatively: when target and stop are both inside
// the same daily bar, assume the stop was reached first.
const stillOpen = [];
for (const p of fv.positions) {
  const q = quoteMap.get(p.code);
  if (!q || q.high == null || q.low == null || q.close == null) { stillOpen.push(p); continue; }
  p.holding_days += 1;
  let reason = null, rawExit = null;
  if (q.low <= p.stop_loss_price) { reason = "stop"; rawExit = Math.min(q.open ?? p.stop_loss_price, p.stop_loss_price); }
  else if (q.high >= p.recommended_sell_price) { reason = "target"; rawExit = Math.max(q.open ?? p.recommended_sell_price, p.recommended_sell_price); }
  else if (p.holding_days >= maxDays) { reason = "time"; rawExit = q.close; }
  if (reason) {
    const exitPrice = rawExit * (1 - exitSlip);
    fv.closed_positions.push({...p, exit_date: snapshot.date, exit_price: round(exitPrice), exit_reason: reason,
      return_pct: round((exitPrice / p.entry_price - 1) * 100)});
  } else stillOpen.push(p);
}
fv.positions = stillOpen;

// Yesterday's frozen signals may enter today. One-price boards are treated as
// untradeable. Limit-board rejection is deliberately conservative.
const pending = fv.signals.filter(s => !s.evaluated && s.signal_date < snapshot.date);
let fills = 0, rejected = 0;
for (const s of pending) {
  const q = quoteMap.get(s.code);
  s.evaluated = true; s.evaluation_date = snapshot.date;
  if (!q || q.low == null || q.open == null || isOnePriceBoard(q) || q.low > s.recommended_buy_price) {
    s.entry_status = isOnePriceBoard(q) ? "limit_board_rejected" : "not_reached"; rejected += 1; continue;
  }
  const rawEntry = q.open <= s.recommended_buy_price ? q.open : s.recommended_buy_price;
  const entryPrice = rawEntry * (1 + entrySlip);
  s.entry_status = "filled"; s.entry_price = round(entryPrice); fills += 1;
  fv.positions.push({code:s.code, name:s.name, signal_date:s.signal_date, entry_date:snapshot.date,
    entry_price:round(entryPrice), recommended_sell_price:s.recommended_sell_price,
    stop_loss_price:s.stop_loss_price, holding_days:0});
}

if (!fv.signals.some(s => s.signal_date === snapshot.date)) {
  for (const [index, r] of (snapshot.top100 || []).entries()) fv.signals.push({
    signal_date: snapshot.date, rank: index + 1, code: r.code, name: r.name, score: r.score,
    reference_close: r.price, recommended_buy_price: r.recommended_buy_price,
    recommended_sell_price: r.recommended_sell_price, stop_loss_price: r.stop_loss_price,
    evaluated: false,
  });
}
const closed = fv.closed_positions;
const summary = {date:snapshot.date, signals_added:(snapshot.top100 || []).length,
  entries_filled:fills, entries_rejected_or_not_reached:rejected, open_positions:fv.positions.length,
  closed_positions:closed.length, winning_positions:closed.filter(x=>x.return_pct>0).length,
  win_rate:closed.length ? round(closed.filter(x=>x.return_pct>0).length/closed.length) : null};
const summaryIndex = fv.daily_summaries.findIndex(x => x.date === snapshot.date);
if (summaryIndex >= 0) fv.daily_summaries[summaryIndex] = summary;
else fv.daily_summaries.push(summary);

data.dailyMarket = snapshot;
data.stockHistory ||= {};
if (!data.stockHistory[snapshot.date]) data.stockHistory[snapshot.date] = {
  date: snapshot.date,
  model_version: snapshot.model_version,
  universe_count: snapshot.universe_count,
  eligible_count: snapshot.eligible_count,
  tests: snapshot.tests,
  top100: snapshot.top100,
};
data.updatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const newSalt = randomBytes(16), iv = randomBytes(12), iterations = 250000;
const newKey = pbkdf2Sync(password, newSalt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", newKey, iv);
const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
writeFileSync(encryptedPath, JSON.stringify({
  v: 1, kdf: "PBKDF2-SHA256", cipher: "AES-256-GCM", iterations,
  salt: newSalt.toString("base64"), iv: iv.toString("base64"),
  ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64"),
}));
console.log(`Updated encrypted history for ${snapshot.date}; ${Object.keys(data.stockHistory).length} dates retained.`);
