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
