// Shared Discord webhook poster: sequential queue, retries on rate limits, console fallback.
const axios = require('axios');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

function makeDiscord(webhook, username) {
  if (webhook && !/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(webhook)) {
    console.error('DISCORD_WEBHOOK_URL in .env does not look like a Discord webhook URL.');
    process.exit(2);
  }
  let queue = Promise.resolve();
  const discord = function discord(title, description, color) {
    if (!webhook) { log(`[no webhook] ${title}: ${description}`); return queue; }
    queue = queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await axios.post(webhook, {
          username,
          embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
        }, { validateStatus: () => true }).catch((e) => ({ status: 0, data: e.message }));
        if (res.status >= 200 && res.status < 300) return;
        if (res.status === 429) { await new Promise((r) => setTimeout(r, (res.data?.retry_after ?? 1) * 1000)); continue; }
        log('Discord error', res.status, JSON.stringify(res.data));
        return;
      }
    });
    return queue;
  };
  discord.flush = () => queue; // await this before exiting a one-shot process
  return discord;
}

module.exports = { makeDiscord, log, GREEN: 0x26a69a, RED: 0xef5350, GREY: 0x787b86, BLUE: 0x2962ff };
