const sqlite = require('sqlite'); // License: MIT
const Telegraf = require('telegraf'); // License: MIT
const Telegram = require('telegraf/telegram'); // License: MIT
const Promise = require('bluebird'); // License: MIT
const axios = require('axios'); // License: MIT
const moment = require('moment'); // License: MIT
const SHA256 = require('crypto-js/sha256'); // License: MIT
const normalizeUrl = require('normalize-url'); // License: MIT
const schedule = require('node-schedule'); // License: MIT
const cheerio = require('cheerio'); // License: MIT

//
// CONFIG
// =============
const config = require('./config.json');

const bot = new Telegraf(config.token);
const telegram = new Telegram(config.token);

//
// REPORT MODES
// =============

// full report
const REPORT_DEBUG = 0;
// only report errors, otherwise just send OK Message
const REPORT_INFO = 1;
// only report errors, otherwise stay silent
const REPORT_ERROR = 2;

//
// HELP DOCUMENT
// ===================
const help = `🔋俊樹のuptime monitor bot\n\n
Here are the list of command available in this bot:\n
/scan ➡ Perform full scan of your site\n
/list ➡ List all your currently monitored sites\n
/register <url> ➡ Register some new sites\n
For example: \`/register google.com\` \n
/help ➡ Open this help menu again`;

//
// INIT SEQUENCE
// ===================

const dbPromise = Promise.resolve()
	.then(() => sqlite.open('./database.sqlite', { Promise }))
	.then(db => db.migrate())
	.catch(err => console.error(err.stack))
	.then(console.log('connected to database.sqlite'))
	.then(console.log('starting to poll for messages - startup sequence completed'))
	.finally(() => bot.startPolling());

//
// HELPER FUNCTIONS
// ===================

async function listWatchedSites() {
	const db = await dbPromise;
	const sites = await db.all('SELECT * FROM target_sites');
	let message = 'Currently monitored sites:\n\n';

	sites.forEach(site => {
		message += `${site.site_url}\n`;
	});

	return message;
}

async function startService(ctx) {
	const db = await dbPromise;
	try {
		db.run('INSERT OR REPLACE INTO users (id, first_name) VALUES ($id, $firstName)', {
			$id: ctx.chat.id,
			$firstName: ctx.chat.first_name
		});
	} catch (err) {
		console.err(err.stack);
	}
	const user = await db.get('SELECT * FROM users WHERE id = ?', ctx.chat.id);
	telegram.sendMessage(user.id, '🔋俊樹の𝓾𝓹𝓽𝓲𝓶𝓮 𝓶𝓸𝓷𝓲𝓻𝓸𝓽 𝓫𝓸𝓽\n\n🅘🅝🅣🅡🅞\nHi, welcome to use 🔋俊樹のuptime monitor bot, this bot serves a simple feature on tracking and scanning your website uptime and sends report approximately every 20 minutes via this bot DM chat, happy using! (◍•ᴗ•◍), start with /start command.\n\n🅣🅔🅒🅗 🅢🅣🅐🅒🅚\n1. Node.js dependencies: sqlite, bluebird, cheerio, crypto-js/sha256, telegraf/telegram,axios, moment, normalize-url, node-schedule.\n2. Server info: Azure Hong Kong, 1 core CPU, 924MB ram+63G SSD.\n3. Runner: pm2.\n\n🅞🅣🅗🅔🅡🅢\n1. Author: @andatoshiki\n2. Author Homepage: https://www.toshiki.top\n2. GitHub repo: https://github.com/andatoshiki/toshiki-uptime-bot\nPlease start with /help command.');
}

async function createReport(mode) {
	// prepare the message
	let message = '';
	let testPassed = true;

	// get sites from database
	// assuming small n here - might change to filter by user at some point
	const db = await dbPromise;
	const sites = await db.all('SELECT rowid, site_url, response_hash FROM target_sites');

	if (sites.length !== 0) {
		const pMessageChunks = sites.map(async site => {
			let messageChunk = '';
			const response = await axios.get(site.site_url).catch(err => {
				messageChunk = `❌ ${site.site_url} (HTTP Error)\n\n ${err.toString()}`;
				testPassed = false;
			});

			const $ = cheerio.load(response.data);
			// use combined text contents of whole page as content and hash it
			const responseHashNew = SHA256($.text()).toString();

			if (responseHashNew !== site.response_hash) {
				messageChunk = `❌ ${site.site_url} (Aww, site crashed x_x)\n`;
				testPassed = false;

				await db
					.run('UPDATE target_sites SET response_hash = $response_hash WHERE rowid = $rowid', {
						$rowid: site.rowid,
						$response_hash: responseHashNew
					})
					.catch(err => console.log(err));
			} else if (mode === REPORT_DEBUG) {
				messageChunk = `✅ ${site.site_url}\n`;
			}
			return messageChunk;
		});

		const messageChunks = await Promise.all(pMessageChunks);
		if (messageChunks) {
			messageChunks.forEach(chunk => {
				message += chunk;
			});
		}

		if (testPassed && mode === REPORT_INFO) {
			message = `✅ ${moment().format('DD.MM.YY HH:mm zz')}\n`;
		}
		if ((!testPassed && mode === REPORT_ERROR) || mode === REPORT_DEBUG) {
			message += `\n\ntimestamp: ${moment().format('DD.MM.YY HH:mm zz')}\n`;
		}
	} else {
		message = 'no target sites found';
	}
	return message;
}

async function sendReports(mode) {
	const message = await createReport(mode);

	if (message !== '') {
		const db = await dbPromise;
		const users = await db.all('SELECT * FROM users;');

		if (users.length !== 0) {
			users.map(async user => {
				telegram.sendMessage(user.id, message).catch(err => {
					console.log(err);
				});
			});
		}
	}
}

//
// COMMANDS
// =============

bot.start(ctx => startService(ctx));
bot.help(ctx => ctx.reply(help));

bot.command('scan', async ctx => {
	const report = await createReport(REPORT_DEBUG);
	ctx.reply(report);
});

bot.command('register', async ctx => {
	// get message parts
	const messageEntities = ctx.message.entities;
	const messageText = ctx.message.text;

	// throw away the command entity
	messageEntities.splice(0, 1);

	messageEntities.forEach(async entity => {
		if (entity.type === 'url') {
			const url = normalizeUrl(messageText.substr(entity.offset, entity.length));
			const db = await dbPromise;
			const selectUrl = await db.get('SELECT * FROM target_sites WHERE site_url = ?', url);
			if (selectUrl) {
				ctx.reply(`target site ${url} is already registered`);
			} else {
				const response = await axios.get(url);
				const hash = SHA256(response);

				db.run('INSERT INTO target_sites (site_url, response_hash) VALUES ($url, $hash)', {
					$url: url,
					$hash: hash
				})
					.catch(err => ctx.reply(`could not persist new target site ${url}\n: ${err}`))
					.then(ctx.reply(`successfully registered ${url}`));
			}
		}
	});
});

bot.command('list', async ctx => {
	ctx.reply(await listWatchedSites());
});

//
// SCHEDULES
// =============

// DAILY 04:30 (SYSTEM TIME UTC) BRIEFING
schedule.scheduleJob('0 30 4 * * *', async () => {
	await sendReports(REPORT_INFO);
});

// EVERY 20 MINUTE CHECK
schedule.scheduleJob('0 */20 * * * *', async () => {
	await sendReports(REPORT_ERROR);
});
