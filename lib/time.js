'use strict';
// 北京时间工具：MCP 运行在任意 agent 机器上，不能依赖本机时区。
// 硬规则：记账/采购/待办的日期必须带时刻（YYYY-MM-DDTHH:mm）。
// 服务端把纯日期解释为当天 00:00（+08:00），等于把用户说的时间抹掉——这是 v1.4.0 的真实 bug。

const BJ_OFFSET = 8 * 3600 * 1000;
const DAY_MS = 86400000;
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return String(n).padStart(2, '0'); }

function bjParts(ms) {
  const d = new Date(Number(ms) + BJ_OFFSET);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

function isoOf(ms) {
  const p = bjParts(ms);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
}
function dateOf(ms) {
  const p = bjParts(ms);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}

// 当前北京时间，供 time.now 与相对日期解析使用
function nowBj(ms) {
  const t = (ms === undefined || ms === null) ? Date.now() : Number(ms);
  const p = bjParts(t);
  return {
    iso: isoOf(t),
    millis: t,
    date: dateOf(t),
    time: pad(p.hour) + ':' + pad(p.minute),
    weekday: WEEKDAY_CN[p.weekday],
    weekdayIndex: p.weekday,
    timezone: 'Asia/Shanghai (UTC+8)',
  };
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const str = String(s);
  const y = Number(str.slice(0, 4));
  const m = Number(str.slice(5, 7));
  const d = Number(str.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, n) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

// 严格校验日期时间。opts.allowDateOnly 仅用于「只到天」的字段（项目截止日、跟踪记录日期），
// 记账/采购/待办一律禁止纯日期，避免静默变成 00:00。
// 返回 { iso, millis, date, time, dateOnly, timezone }
function normalizeDateTime(v, label, opts) {
  const name = label || '时间';
  const options = opts || {};
  if (v === null || v === undefined || v === '') {
    throw new Error('缺少' + name);
  }
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{12,13}$/.test(v.trim()))) {
    const ms = Number(v);
    if (!Number.isFinite(ms)) throw new Error('无法识别' + name + '：' + v);
    return { iso: isoOf(ms), millis: ms, date: dateOf(ms), time: isoOf(ms).slice(11), dateOnly: false, timezone: 'Asia/Shanghai (UTC+8)' };
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) {
    throw new Error('无法识别' + name + '「' + s + '」。请用北京时间「YYYY-MM-DDTHH:mm」，例如「' + dateOf(Date.now()) + 'T19:00」。');
  }
  const date = m[1] + '-' + m[2] + '-' + m[3];
  if (!isValidDate(date)) {
    throw new Error(name + '「' + s + '」不是有效日期。请用北京时间「YYYY-MM-DDTHH:mm」。');
  }
  if (m[4] === undefined) {
    if (options.allowDateOnly) {
      return { iso: date + 'T00:00', millis: Date.parse(date + 'T00:00:00+08:00'), date: date, time: '00:00', dateOnly: true, timezone: 'Asia/Shanghai (UTC+8)' };
    }
    throw new Error(
      name + '「' + s + '」只有日期没有时刻，会被记成当天 00:00，等于把时间抹掉了。' +
      '请补上北京时间的具体时刻，例如「' + date + 'T19:00」。'
    );
  }
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (hh > 23 || mi > 59 || ss > 59) {
    throw new Error(name + '「' + s + '」时刻不合法。请用 24 小时制「YYYY-MM-DDTHH:mm」，例如「' + date + 'T19:00」。');
  }
  let ms;
  if (m[7]) {
    ms = Date.parse(s.replace(' ', 'T'));
    if (!Number.isFinite(ms)) throw new Error('无法识别' + name + '「' + s + '」。');
  } else {
    // 无时区标记 = 北京时间（东八区），与服务端 dateStrToTs 的语义一致
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mi, ss) - BJ_OFFSET;
  }
  const iso = isoOf(ms);
  return { iso: iso, millis: ms, date: iso.slice(0, 10), time: iso.slice(11, 16), dateOnly: false, timezone: 'Asia/Shanghai (UTC+8)' };
}

// 便捷包装：只取规范化后的字符串
function requireDateTime(v, label) {
  return normalizeDateTime(v, label).iso;
}

// ===== 中文相对时间解析（给 time.parse 用）=====
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!s) return null;
  if (s === '十') return 10;
  if (s[0] === '十') {
    const n = CN_DIGITS[s[1]];
    return n === undefined ? null : 10 + n;
  }
  if (s[1] === '十') {
    const tens = CN_DIGITS[s[0]];
    const ones = s[2] === undefined ? 0 : CN_DIGITS[s[2]];
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  if (s.length === 1) {
    const n = CN_DIGITS[s];
    return n === undefined ? null : n;
  }
  return null;
}

// 日期词 → 相对天数 + 隐含时段（「昨晚」同时给出 evening）
const DAY_WORDS = [
  { re: /大前天/, offset: -3, period: '' },
  { re: /大后天/, offset: 3, period: '' },
  { re: /前天/, offset: -2, period: '' },
  { re: /后天/, offset: 2, period: '' },
  { re: /昨天|昨日|昨儿|昨晚|昨夜/, offset: -1, period: '' },
  { re: /今天|今日|今儿|今晚|今早|今夜/, offset: 0, period: '' },
  { re: /明天|明日|明儿|明晚|明早|明夜/, offset: 1, period: '' },
];
const COMPOUND_PERIODS = [
  { re: /昨晚|昨夜/, period: '晚上' },
  { re: /今晚|今夜/, period: '晚上' },
  { re: /明晚|明夜/, period: '晚上' },
  { re: /今早/, period: '早上' },
  { re: /明早/, period: '早上' },
];
const PERIOD_WORDS = [
  { re: /凌晨/, period: '凌晨' },
  { re: /早上|早晨|清晨|一早/, period: '早上' },
  { re: /上午/, period: '上午' },
  { re: /中午|正午/, period: '中午' },
  { re: /下午/, period: '下午' },
  { re: /傍晚|黄昏|日落/, period: '傍晚' },
  { re: /晚上|夜里|夜间|晚些|晚/, period: '晚上' },
  { re: /半夜|午夜|深夜/, period: '深夜' },
];

function adjustHour(hour, period, notes) {
  if (hour == null) return hour;
  if (period === '下午' || period === '傍晚') {
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === '晚上') {
    if (hour === 12) {
      notes.push('「晚上12点」按次日 00:00 处理');
      return { hour: 0, nextDay: true };
    }
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === '中午') {
    if (hour < 11) return hour + 12;
    return hour;
  }
  // 凌晨 / 早上 / 上午 / 深夜：保持原小时（凌晨1点=01:00）
  return hour;
}

function parseChinese(text, nowMs) {
  const input = String(text == null ? '' : text).trim();
  if (!input) throw new Error('缺少要解析的时间文本');
  const base = (nowMs === undefined || nowMs === null) ? Date.now() : Number(nowMs);
  const now = nowBj(base);
  const notes = [];
  const matched = { day: '', dayOffset: null, period: '', hour: null, minute: null, fuzzy: false };

  // 先尝试完整 ISO：用户/agent 直接给标准时间时不再猜
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(input)) {
    const norm = normalizeDateTime(input.replace(' ', 'T'), '时间');
    return {
      ok: true, input: input, iso: norm.iso, date: norm.date, time: norm.time,
      weekday: WEEKDAY_CN[new Date(norm.millis + BJ_OFFSET).getUTCDay()],
      millis: norm.millis, timezone: norm.timezone,
      matched: { day: '完整时间', dayOffset: 0, period: '', hour: Number(norm.time.slice(0, 2)), minute: Number(norm.time.slice(3, 5)), fuzzy: false },
      notes: notes, hint: '',
    };
  }

  for (const d of DAY_WORDS) {
    if (d.re.test(input)) { matched.day = d.re.exec(input)[0]; matched.dayOffset = d.offset; break; }
  }
  for (const p of COMPOUND_PERIODS) {
    if (p.re.test(input)) { matched.period = p.period; break; }
  }
  if (!matched.period) {
    for (const p of PERIOD_WORDS) {
      if (p.re.test(input)) { matched.period = p.period; break; }
    }
  }

  // 显式 19:30 / 7:05
  let hour = null, minute = null;
  const colon = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(input);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
    matched.fuzzy = false;
  }
  if (hour === null) {
    // 7点 / 七点半 / 7点20 / 7点多 / 十点
    const pt = /(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*点\s*(半|一刻|三刻|\d{1,2}\s*分?|[多来左右]+)?/.exec(input);
    if (pt) {
      hour = cnToNumber(pt[1]);
      const tail = pt[2] || '';
      if (tail === '半') minute = 30;
      else if (tail === '一刻') minute = 15;
      else if (tail === '三刻') minute = 45;
      else if (/^\d{1,2}/.test(tail)) minute = Number(/^\d{1,2}/.exec(tail)[0]);
      else if (tail) { minute = 0; matched.fuzzy = true; notes.push('「' + tail + '」按整点处理'); }
      else minute = 0;
    }
  }

  if (hour === null) {
    // 只有日期没有时刻：不替用户编造 00:00
    if (matched.day) {
      const date = addDays(now.date, matched.dayOffset);
      return {
        ok: true, input: input, iso: null, date: date, time: null,
        weekday: WEEKDAY_CN[new Date(Date.parse(date + 'T00:00:00+08:00') + BJ_OFFSET).getUTCDay()],
        millis: null, timezone: 'Asia/Shanghai (UTC+8)', matched: matched, notes: notes,
        needTime: true,
        hint: '识别到日期「' + matched.day + '」（' + date + '），但没有具体时刻。请向用户确认几点几分，再传 YYYY-MM-DDTHH:mm。',
      };
    }
    throw new Error('无法从「' + input + '」识别时间。请让用户说明日期和时刻（如「昨天 19:00」），或用 YYYY-MM-DDTHH:mm。');
  }

  if (hour > 23 || minute > 59) {
    throw new Error('时间「' + input + '」超出范围，请用 24 小时制。');
  }
  let dayOffset = matched.dayOffset;
  if (dayOffset === null) {
    dayOffset = 0;
    notes.push('未说明是哪一天，按北京时间今天处理');
  }
  const adjusted = adjustHour(hour, matched.period, notes);
  if (adjusted && typeof adjusted === 'object') {
    hour = adjusted.hour;
    if (adjusted.nextDay) dayOffset += 1;
  } else if (adjusted != null) {
    hour = adjusted;
  }
  if (!matched.period && hour <= 12) {
    notes.push('未说明上午/下午，按 24 小时制 ' + pad(hour) + ':' + pad(minute) + ' 处理；如不确定请向用户确认');
  }
  matched.hour = hour;
  matched.minute = minute;

  const date = addDays(now.date, dayOffset);
  const iso = date + 'T' + pad(hour) + ':' + pad(minute);
  const millis = Date.parse(iso + ':00+08:00');
  return {
    ok: true, input: input, iso: iso, date: date, time: pad(hour) + ':' + pad(minute),
    weekday: WEEKDAY_CN[new Date(millis + BJ_OFFSET).getUTCDay()],
    millis: millis, timezone: 'Asia/Shanghai (UTC+8)', matched: matched, notes: notes, hint: '',
  };
}

module.exports = {
  BJ_OFFSET,
  nowBj,
  addDays,
  isValidDate,
  normalizeDateTime,
  requireDateTime,
  parseChinese,
  WEEKDAY_CN,
};
