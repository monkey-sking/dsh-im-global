import { DiscordAdapter } from '../lib/adapters/discord.js';
import { SlackAdapter } from '../lib/adapters/slack.js';
import { MatrixAdapter } from '../lib/adapters/matrix.js';
import { MattermostAdapter } from '../lib/adapters/mattermost.js';
import { ZulipAdapter } from '../lib/adapters/zulip.js';
import { TelegramAdapter } from '../lib/adapters/telegram.js';

const logger = { info(){}, warn(){}, error(){} };
const cases = [
  ['telegram', new TelegramAdapter({ id:'t', logger, config:{ token:'111:invalid' }, onMessage(){} })],
  ['discord',  new DiscordAdapter({ id:'d', logger, config:{ token:'invalid' }, onMessage(){} })],
  ['slack',    new SlackAdapter({ id:'s', logger, config:{ token:'xoxb-invalid', appToken:'xapp-invalid' }, onMessage(){} })],
  ['matrix',   new MatrixAdapter({ id:'m', logger, config:{ token:'invalid', homeserverUrl:'https://matrix.org' }, onMessage(){} })],
  ['mattermost', new MattermostAdapter({ id:'mm', logger, config:{ token:'invalid', baseUrl:'https://chat.example.com' }, onMessage(){} })],
  ['zulip',    new ZulipAdapter({ id:'z', logger, config:{ token:'a@b.c:invalid', baseUrl:'https://chat.zulip.org' }, onMessage(){} })],
];

for (const [name, adapter] of cases) {
  const started = Date.now();
  try {
    await Promise.race([
      adapter.start(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15000)),
    ]);
    console.log(`${name.padEnd(11)} 启动成功（意外：假凭据不该成功）`);
  } catch (error) {
    const msg = String(error?.message ?? error).slice(0, 90);
    const verdict = /401|403|invalid|Unauthorized|Failed|not set|invalid_auth|M_UNKNOWN_TOKEN|timeout/i.test(msg) ? 'OK（认证/网络层拒绝，未崩溃）' : '⚠️ 异常';
    console.log(`${name.padEnd(11)} ${verdict} :: ${msg}  [${Date.now()-started}ms]`);
  } finally {
    try { await adapter.stop(); } catch {}
  }
}
