// 向管理员发送通知（webhook）。在环境变量里配置：
//   NOTIFY_WEBHOOK_URL = 你的 Slack/Discord/飞书 机器人 webhook 地址
//   NOTIFY_TYPE        = slack | discord | feishu | generic（默认 generic）
// 不配置 NOTIFY_WEBHOOK_URL 则不外发（管理后台仍有页面内提醒）。

export async function notifyAdmin(text) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  const type = (process.env.NOTIFY_TYPE || 'generic').toLowerCase();
  let body;
  if (type === 'slack') body = { text };
  else if (type === 'discord') body = { content: text };
  else if (type === 'feishu') body = { msg_type: 'text', content: { text } };
  else body = { text };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('通知发送失败:', e.message);
  }
}

// 一次领取后，根据剩余量决定是否触发阈值通知（只在“正好越过”时发一次）
export async function maybeNotifyStock(remaining) {
  const threshold = parseInt(process.env.LOW_STOCK_THRESHOLD || '10', 10);
  if (remaining === 0) {
    await notifyAdmin('⚠️ API Key 已全部发完（剩余 0）。请尽快补充 Key。');
  } else if (remaining === threshold) {
    await notifyAdmin(`⚠️ API Key 仅剩 ${threshold} 个，即将发完。请准备补充。`);
  }
}
