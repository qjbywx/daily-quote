/**
 * 每日自动抓取句子并追加到 quotes.json
 * 运行环境：GitHub Actions（Node 20，仓库根目录为工作目录）
 *
 * 功能：
 * 1. 每个时段尝试追加 PER_SLOT 句新句子（一言优先，失败回退今日诗词）；
 * 2. 过滤鸡汤/空洞/过长内容；
 * 3. 去重：与 quotes.json 全部历史、以及最近 30 天抓取记录（history.json）均不重复；
 * 4. 留存：每天抓到的句子记入 history.json，只保留最近 30 天记录（更早记录由 git 提交历史永久留存）；
 * 5. 当天没有新句子则不写入、不产生空提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'quotes.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');

const SLOTS = ['dawn', 'morning', 'afternoon', 'dusk', 'night'];
const SLOT_CATS = {
  dawn: ['d', 'i'],
  morning: ['e', 'g'],
  afternoon: ['a', 'b'],
  dusk: ['h', 'j'],
  night: ['f', 'k']
};
const BLACKLIST = /努力|坚持|成功|奋斗|加油|付出|回报|一定|必须|只要|就能|终将|必将|拼搏|梦想成真|熬过去/i;
const PER_SLOT = 1; // 每个时段每天追加的句数
const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3; // 每个时段寻找新句子的最大尝试次数
const KEEP_DAYS = 30; // history.json 保留最近天数

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function todayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function dayKey(daysAgo) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - daysAgo * 86400000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function isGood(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (s.length < 4 || s.length > 40) return false;
  if (/https?:|www\.|[\uFFFD]|[\\<>{}]/.test(s)) return false;
  if (BLACKLIST.test(s)) return false;
  return true;
}

function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { signal: controller.signal })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

async function fetchHitokoto(slot) {
  const cats = SLOT_CATS[slot].slice().sort(() => Math.random() - 0.5);
  for (const c of cats) {
    try {
      const data = await fetchJson('https://v1.hitokoto.cn/?c=' + c + '&encode=json');
      const text = data && typeof data.hitokoto === 'string' ? data.hitokoto.trim() : '';
      if (isGood(text)) return text;
    } catch (e) {
      /* 继续尝试下一个分类 */
    }
  }
  return null;
}

async function fetchJinrishici() {
  try {
    const data = await fetchJson('https://v1.jinrishici.com/all.json');
    const text = data && typeof data.content === 'string' ? data.content.trim() : '';
    return isGood(text) ? text : null;
  } catch (e) {
    return null;
  }
}

function readQuotes() {
  if (!fs.existsSync(FILE)) throw new Error('找不到 quotes.json：' + FILE);
  const pool = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const slot of SLOTS) {
    if (!Array.isArray(pool[slot])) throw new Error('quotes.json 缺少时段：' + slot);
  }
  return pool;
}

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  let history = {};
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) history = raw;
  } catch (e) {
    console.log('history.json 无法解析，按空历史处理');
  }
  return history;
}

async function main() {
  const pool = readQuotes();
  const history = readHistory();

  // 只保留最近 KEEP_DAYS 天的记录（含今天）
  const cutoff = dayKey(KEEP_DAYS - 1);
  const pruned = {};
  for (const date of Object.keys(history).sort()) {
    if (date >= cutoff && Array.isArray(history[date])) pruned[date] = history[date];
  }

  // 最近 30 天内出现过的句子集合（用于去重）
  const recent = new Set();
  for (const list of Object.values(pruned)) {
    for (const s of list) recent.add(String(s).trim());
  }

  const today = todayKey();
  if (!pruned[today]) pruned[today] = [];
  const usedToday = new Set(pruned[today].map((s) => String(s).trim()));

  let added = 0;
  for (const slot of SLOTS) {
    const existing = new Set(pool[slot].map((s) => String(s).trim()));
    for (let i = 0; i < PER_SLOT; i++) {
      let text = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !text; attempt++) {
        const t = (await fetchHitokoto(slot)) || (await fetchJinrishici());
        if (t && !existing.has(t) && !recent.has(t) && !usedToday.has(t)) text = t;
      }
      if (!text) break;
      pool[slot].push(text);
      pruned[today].push(text);
      existing.add(text);
      recent.add(text);
      usedToday.add(text);
      added++;
    }
  }

  if (added === 0) {
    console.log('没有抓到新句子，跳过写入');
    return;
  }

  // 输出按日期排序，保持文件整洁
  const sortedHistory = {};
  for (const date of Object.keys(pruned).sort()) sortedHistory[date] = pruned[date];

  fs.writeFileSync(FILE, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(sortedHistory, null, 2) + '\n', 'utf8');
  console.log('已追加 ' + added + ' 句新句子，并记入 history.json（保留 ' + Object.keys(sortedHistory).length + ' 天记录）');
  for (const slot of SLOTS) {
    console.log('  ' + slot + '：' + pool[slot].length + ' 句 | 最新：' + pool[slot][pool[slot].length - 1]);
  }
}

main().catch((e) => {
  console.error('执行失败：', e);
  process.exit(1);
});
