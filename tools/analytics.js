'use strict';
// 统计域：analytics.summary —— 从采购/记账/预算数据本地聚合（App 的统计规则在端上算，服务端无聚合接口）
const { z } = require('zod');
const { register } = require('./util');
const { mapPurchase, mapExpense } = require('../lib/datamap');

const TZ = 8 * 3600 * 1000;
const ACTIVE_BUY = ['已下单', '已到', '已归档'];
const EXCLUDED_BUY = ['已退', '已取消'];

function bjParts(ms) {
  const d = new Date(Number(ms) + TZ);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function pad(n) { return String(n).padStart(2, '0'); }
function monthKey(y, m) { return y + '-' + pad(m); }

function parseMonth(month) {
  if (!month) { const b = bjParts(Date.now()); return b; }
  const mm = /^(\d{4})-(\d{1,2})$/.exec(String(month));
  if (!mm) throw new Error('month 格式应为 YYYY-MM');
  const y = Number(mm[1]), m = Number(mm[2]);
  if (m < 1 || m > 12) throw new Error('month 月份无效');
  return { y, m };
}
function monthRange(y, m) {
  return { start: Date.UTC(y, m - 1, 1) - TZ, end: Date.UTC(y, m, 1) - TZ };
}

function round(n) { return Math.round(Number(n) || 0); }

function aggregatePurchases(rows, start, end) {
  const inMonth = rows.filter(r => typeof r.date === 'number' && r.date >= start && r.date < end);
  const byStatus = {};
  const byCategory = {};
  let total = 0, active = 0, activeCount = 0, excluded = 0;
  for (const r of inMonth) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (EXCLUDED_BUY.includes(r.status)) { excluded++; continue; }
    const amt = (Number(r.price) || 0) * (Number(r.qty) || 1);
    total += amt;
    if (ACTIVE_BUY.includes(r.status)) {
      active += amt;
      activeCount++;
      const c = r.category || '其他';
      byCategory[c] = (byCategory[c] || 0) + amt;
    }
  }
  return { count: inMonth.length, activeCount, total: round(total), active: round(active), excluded, byStatus, byCategory };
}

function aggregateExpenses(rows, key) {
  const inMonth = rows.filter(r => String(r.date || '').slice(0, 7) === key);
  let total = 0, income = 0, linked = 0, fixed = 0;
  const byCategory = {}, byType = {};
  for (const r of inMonth) {
    const amt = Number(r.amount) || 0;
    byType[r.type] = (byType[r.type] || 0) + amt;
    if (r.type === '收入') { income += amt; continue; }
    total += amt;
    const note = String(r.note || '');
    if (note.includes('[采购]') || note.includes('[采购分期]')) { linked += amt; continue; }
    if (note.includes('[固定]')) { fixed += amt; continue; }
    const c = r.category || '其他';
    byCategory[c] = (byCategory[c] || 0) + amt;
  }
  return {
    count: inMonth.length,
    total: round(total),
    net: round(Math.max(0, total - linked - fixed)),
    income: round(income),
    linked: round(linked),
    fixed: round(fixed),
    byCategory,
    byType,
  };
}

function installmentDue(rows, y, m) {
  let due = 0, count = 0;
  for (const r of rows) {
    const n = Number(r.installments) || 0;
    const amt = Number(r.installmentAmount) || 0;
    if (n <= 1 || amt <= 0) continue;
    let sy, sm;
    const st = String(r.installmentStart || '');
    const mm = /^(\d{4})-(\d{1,2})$/.exec(st);
    if (mm) { sy = Number(mm[1]); sm = Number(mm[2]); }
    else if (typeof r.date === 'number') { const b = bjParts(r.date); sy = b.y; sm = b.m; }
    else continue;
    const diff = (y - sy) * 12 + (m - sm);
    if (diff >= 0 && diff < n) { due += amt; count++; }
  }
  return { due: round(due), count };
}

function getBudgetTotal(doc, key) {
  if (!doc || typeof doc !== 'object') return 0;
  const v = doc[key];
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.total === 'number') return v.total;
  return 0;
}

module.exports = function registerAnalytics(server, ctx) {
  const { api } = ctx;

  register(server, ctx, 'analytics.summary', {
    title: '月度统计',
    description: '按月汇总：采购/记账/收入/净支出/分期应还/预算使用率/分类 TOP/状态计数，并与上月比较。month 不传则取当前月（东八区）。',
    inputSchema: {
      month: z.string().optional().describe('YYYY-MM，默认当前月'),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const { y, m } = parseMonth(a.month);
    const key = monthKey(y, m);
    const { start, end } = monthRange(y, m);
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const prevKey = monthKey(prev.y, prev.m);
    const prevRange = monthRange(prev.y, prev.m);

    const [rawItems, rawExpenses, budgetDoc] = await Promise.all([
      api.get('/api/items'),
      api.get('/api/expenses'),
      api.get('/api/budgets').catch(() => ({ ok: true, data: {} })),
    ]);
    const items = rawItems.map(mapPurchase);
    const expenses = rawExpenses.map(mapExpense);

    const purchase = aggregatePurchases(items, start, end);
    const expense = aggregateExpenses(expenses, key);
    const prevPurchase = aggregatePurchases(items, prevRange.start, prevRange.end);
    const prevExpense = aggregateExpenses(expenses, prevKey);
    const installment = installmentDue(items, y, m);

    const totalSpend = purchase.active + expense.net;
    const prevTotal = prevPurchase.active + prevExpense.net;
    const deltaPct = prevTotal > 0 ? Math.round((totalSpend - prevTotal) / prevTotal * 100) : null;

    const budgetTotal = getBudgetTotal(budgetDoc && budgetDoc.data, key);
    const budget = budgetTotal > 0
      ? { total: round(budgetTotal), used: totalSpend, pct: Math.min(Math.round(totalSpend / budgetTotal * 100), 999) }
      : null;

    // 分类 TOP：有效采购 + 净支出（已排除关联采购/固定项的记账）
    const catMap = {};
    for (const [c, v] of Object.entries(purchase.byCategory)) catMap[c] = (catMap[c] || 0) + v;
    for (const [c, v] of Object.entries(expense.byCategory)) catMap[c] = (catMap[c] || 0) + v;
    const topCategories = Object.entries(catMap)
      .map(([category, amount]) => ({ category, amount: round(amount) }))
      .sort((x, y2) => y2.amount - x.amount)
      .slice(0, 5);

    return {
      month: key,
      range: { start, end },
      income: expense.income,
      purchase,
      expense,
      installment,
      totalSpend,
      budget,
      comparison: { prevMonth: prevKey, prevTotalSpend: prevTotal, deltaPct },
      topCategories,
      generatedAt: Date.now(),
    };
  });
};
