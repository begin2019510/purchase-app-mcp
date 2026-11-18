'use strict';
// T1 高危操作二次授权：confirm 必须精确等于目标展示名。
// 执行前由 MCP 在服务端读取目标真实名称再校验；不匹配则报错并附目标摘要，绝不执行。
// 诚实边界：MCP 无法真正验证「用户已点头」——与 GitHub delete-repo 同构：
// 参数在工具调用里可见 + 本地 audit.log 留痕，作为标准折中。

const CONFIRM_LITERAL = '覆盖确认';

function assertConfirm(confirm, expected, summary) {
  const c = String(confirm == null ? '' : confirm).trim();
  const e = String(expected == null ? '' : expected).trim();
  if (!e) {
    throw new Error('无法解析确认目标（目标不存在或名称为空），已中止。' + (summary ? ' 目标：' + summary : ''));
  }
  if (!c) {
    throw new Error(
      '高危操作需要二次授权：先向用户展示一行预览（对象 + 后果 + 不可逆点），' +
      '获得明确同意后，将 confirm 精确设为「' + e + '」再调用。' +
      (summary ? ' 目标：' + summary : '')
    );
  }
  if (c !== e) {
    throw new Error(
      'confirm 不匹配：期望「' + e + '」，收到「' + c + '」。' +
      (summary ? ' 目标：' + summary + '。' : '') +
      '请先向用户展示预览并获得明确同意，再用目标名称重试。'
    );
  }
  return true;
}

module.exports = { assertConfirm, CONFIRM_LITERAL };
