// ✅ PERFORMANCE OPTIMIZATION CONFIG
// High-performance HTTP/HTTPS connection pooling and caching

const https = require('https');
const http = require('http');

// ✅ FIX #1: HTTP/HTTPS Agent with Connection Pooling
// Reuses TCP connections instead of creating new ones for every API call
// Expected improvement: 3-5x faster API responses (eliminates SSL handshake overhead)

const httpsAgent = new https.Agent({
    keepAlive: true,           // ✅ Reuse connections
    keepAliveMsecs: 30000,     // Keep-alive every 30s
    maxSockets: 50,            // Max concurrent connections
    maxFreeSockets: 10,        // Keep 10 idle connections ready
    timeout: 10000,            // 10 second timeout
    freeSocketTimeout: 30000,  // Free socket after 30s
});

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 10000,
});

// ✅ FIX #3: Aggressive Translation Caching
// Cache all translations in memory with TTL
const translationCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 10000; // Max 10k entries

// Pre-cache common phrases
const COMMON_TRANSLATIONS = {
    en: {
        'Back to Main': 'Back to Main',
        'Cancel': 'Cancel',
        'Confirm': 'Confirm',
        'Payment Sent': 'Payment Sent',
        'Loading': 'Loading...',
        'Please wait': 'Please wait',
    }
};

// ✅ FIX #6: Token Verification Cache
// Cache token data for 5 minutes to avoid duplicate API calls
const tokenVerificationCache = new Map();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache cleanup (run every 10 minutes)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean translation cache
    for (const [key, value] of translationCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            translationCache.delete(key);
            cleaned++;
        }
    }
    
    // Clean token verification cache
    for (const [key, value] of tokenVerificationCache.entries()) {
        if (now - value.timestamp > TOKEN_CACHE_TTL) {
            tokenVerificationCache.delete(key);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Cache cleanup: removed ${cleaned} expired entries`);
    }
}, 10 * 60 * 1000);

// ✅ FIX #5: Smart Telegram API Caller
// Avoids unnecessary retries on failed edit operations
function getSmartReplyFunction(ctx) {
    return async (text, opts) => {
        // Only try edit if this is a callback query (guaranteed to work)
        if (ctx.callbackQuery) {
            try {
                return await ctx.editMessageText(text, opts);
            } catch (e) {
                console.warn('⚠️ Edit failed, sending new message:', e.message);
                return await ctx.reply(text, opts);
            }
        }
        // For regular messages, just reply (faster, no retry needed)
        return await ctx.reply(text, opts);
    };
}

module.exports = {
    httpsAgent,
    httpAgent,
    translationCache,
    tokenVerificationCache,
    CACHE_TTL,
    TOKEN_CACHE_TTL,
    MAX_CACHE_SIZE,
    COMMON_TRANSLATIONS,
    getSmartReplyFunction,
};
