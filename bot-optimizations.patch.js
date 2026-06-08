// 🚀 PERFORMANCE OPTIMIZATION PATCH
// Apply these changes to bot.js for maximum performance improvements
// This file contains the exact code changes needed

// ============================================================================
// STEP 1: Add this at the TOP of bot.js (after require('dotenv').config())
// ============================================================================

const perf = require('./performance-config');

console.log('✅ Performance optimization module loaded');
console.log('  • HTTP/HTTPS connection pooling enabled');
console.log('  • Translation cache ready (24h TTL)');
console.log('  • Token verification cache ready (5m TTL)');
console.log('  • Async file I/O enabled');


// ============================================================================
// STEP 2: REPLACE the saveData() function (around line 837-867)
// ============================================================================

// 🔴 OLD CODE TO REMOVE (lines ~837-867):
// function saveData() {
//     const tmpFile = DATA_FILE + '.tmp';
//     try {
//         const serialised = JSON.stringify(botData, null, 2);
//         fs.writeFileSync(tmpFile, 'utf8', serialised);  // ❌ BLOCKING
//         if (fs.existsSync(BACKUP_FILES[1])) fs.copyFileSync(BACKUP_FILES[1], BACKUP_FILES[2]);
//         if (fs.existsSync(BACKUP_FILES[0])) fs.copyFileSync(BACKUP_FILES[0], BACKUP_FILES[1]);
//         if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILES[0]);
//         fs.renameSync(tmpFile, DATA_FILE);  // ❌ BLOCKING
//     } catch(e) { ... }
// }

// ✅ NEW CODE TO ADD (FIX #2 - Async File I/O):
let _saveQueue = Promise.resolve();
let _pendingSave = false;
let _saveTimeout = null;

function saveData() {
    // Return immediately if save already queued
    if (_pendingSave) return;
    _pendingSave = true;
    
    // Debounce: coalesce rapid saves within 200ms into single write
    // This prevents event loop blocking when multiple operations trigger saves
    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
        _saveQueue = _saveQueue
            .then(() => _atomicSave())
            .finally(() => { _pendingSave = false; });
    }, 200);
}

async function _atomicSave() {
    try {
        const serialised = JSON.stringify(botData, null, 2);
        
        // ✅ Use async I/O (non-blocking)
        await perf.atomicBackupAndWrite(DATA_FILE, BACKUP_FILES, serialised);
        
        const walletCount = botData.userWallets?.length ?? 0;
        const userCount = Object.keys(botData.users ?? {}).length;
        console.log(`💾 Saved async — ${walletCount} wallets | ${userCount} users`);
    } catch (err) {
        console.error('❌ Error saving data:', err.message);
    }
}


// ============================================================================
// STEP 3: REPLACE the translateText() function (around line 457-503)
// ============================================================================

// ✅ NEW CODE TO ADD (FIX #3 - Translation Caching):
async function translateText(text, targetLang) {
    // ✅ FIX: Fast path - no translation needed for English
    if (!targetLang || targetLang === 'en') return text;
    if (!text || text.trim().length === 0) return text;

    const cacheKey = `${targetLang}\x00${text}`;
    
    // ✅ FIX #3: Check cache first (eliminates 5-10 API calls per interaction)
    if (perf.translationCache.has(cacheKey)) {
        const cached = perf.translationCache.get(cacheKey);
        if (Date.now() - cached.timestamp < perf.CACHE_TTL) {
            return cached.data;  // Instant response from cache
        }
    }

    return new Promise((resolve) => {
        const encoded = encodeURIComponent(text);
        const reqPath = `/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encoded}`;

        const req = https.request({
            hostname: 'translate.googleapis.com',
            port: 443,
            path: reqPath,
            method: 'GET',
            agent: perf.httpsAgent,  // ✅ FIX #1: Connection pooling
            headers: { 
                'User-Agent': 'Mozilla/5.0', 
                'Accept': 'application/json' 
            }
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
                            // ✅ Cache the translation for future use
                            if (perf.translationCache.size >= perf.MAX_CACHE_SIZE) {
                                // LRU: remove first (oldest) entry
                                perf.translationCache.delete(perf.translationCache.keys().next().value);
                            }
                            perf.translationCache.set(cacheKey, {
                                data: translated,
                                timestamp: Date.now()
                            });
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


// ============================================================================
// STEP 4: UPDATE ALL HTTPS.REQUEST CALLS
// ============================================================================

// 🎯 FIND & REPLACE in these functions - add "agent: perf.httpsAgent," to all https.request() calls:

// 1️⃣ fetchDexScreenerData() - around line 125-131
const req = https.request({
    hostname: 'api.dexscreener.com',
    port: 443,
    path: `/latest/dex/tokens/${contractAddress}`,
    method: 'GET',
    agent: perf.httpsAgent,  // ✅ ADD THIS LINE - Connection pooling
    headers: { 'User-Agent': 'BonkPumpBot/1.0' }
}, (res) => {
    // ... rest of function
});

// 2️⃣ fetchGeckoTerminalToken() - around line 150-155
const req = https.request({
    hostname: 'api.geckoterminal.com',
    port: 443,
    path: `/api/v2/networks/${network}/tokens/${contractAddress}`,
    method: 'GET',
    agent: perf.httpsAgent,  // ✅ ADD THIS LINE - Connection pooling
    headers: { 
        'User-Agent': 'BonkPumpBot/1.0', 
        'Accept': 'application/json' 
    }
}, (res) => {
    // ... rest of function
});

// 3️⃣ fetchNativePricesFromCoinGecko() - around line 1003-1001
const req = https.request({
    hostname: 'api.coingecko.com',
    path: `/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
    method: 'GET',
    agent: perf.httpsAgent,  // ✅ ADD THIS LINE - Connection pooling
    headers: { 
        'Accept': 'application/json', 
        'User-Agent': 'DexVolumeBot/1.0' 
    }
}, (res) => {
    // ... rest of function
});

// 4️⃣ fetchNativePrices() - around line 1055-1052
const req = https.request({
    hostname: 'api.binance.com',
    path: `/api/v3/ticker/price?symbols=${symbols}`,
    method: 'GET',
    agent: perf.httpsAgent,  // ✅ ADD THIS LINE - Connection pooling
    headers: { 
        'Accept': 'application/json', 
        'User-Agent': 'DexVolumeBot/1.0' 
    }
}, (res) => {
    // ... rest of function
});


// ============================================================================
// STEP 5: UPDATE verifyTokenWithDexScreener() - ADD CACHING
// ============================================================================

// ✅ Add this at the START of verifyTokenWithDexScreener() function (around line 207):

async function verifyTokenWithDexScreener(contractAddress, chainId = null) {
    const cacheKey = `${chainId}:${contractAddress}`;
    
    // ✅ FIX #6: Check cache first (avoid duplicate API calls)
    if (perf.tokenVerificationCache.has(cacheKey)) {
        const cached = perf.tokenVerificationCache.get(cacheKey);
        if (Date.now() - cached.timestamp < perf.TOKEN_CACHE_TTL) {
            console.log('✅ Cache hit for token:', contractAddress);
            return cached.data;  // Instant response
        }
    }
    
    console.log(`🔍 Verifying token (fresh): ${contractAddress} (chain: ${chainId || 'auto'})`);
    
    // ... REST OF FUNCTION STAYS THE SAME ...
    
    // ✅ At the END, before returning tokenInfo, ADD THIS:
    if (tokenInfo.success) {
        perf.tokenVerificationCache.set(cacheKey, {
            data: tokenInfo,
            timestamp: Date.now()
        });
    }
    
    return tokenInfo;
}


// ============================================================================
// STEP 6: REPLACE safeEdit() function - around line 3653-3656
// ============================================================================

// 🔴 OLD CODE TO REMOVE:
// async function safeEdit(ctx, text, opts) {
//     try { await ctx.editMessageText(text, opts); }
//     catch(e) { await ctx.reply(text, opts); }
// }

// ✅ NEW CODE TO ADD (FIX #5 - Smart Telegram API):
async function safeEdit(ctx, text, opts) {
    // ✅ FIX #5: Use smart reply that avoids unnecessary retries
    const smartReply = perf.createSmartReply(ctx);
    return await smartReply(text, opts);
}


// ============================================================================
// QUICK REFERENCE: All Changes Needed
// ============================================================================

/*
CHECKLIST - Apply changes in this order:

1. ✅ Add performance-config.js import at top
   Line 1-5 (after require('dotenv').config())

2. ✅ Replace saveData() and _atomicSave()
   Lines ~837-867

3. ✅ Replace translateText()
   Lines ~457-503

4. ✅ Add "agent: perf.httpsAgent," to 4 functions:
   - fetchDexScreenerData() (line ~127)
   - fetchGeckoTerminalToken() (line ~152)
   - fetchNativePricesFromCoinGecko() (line ~1005)
   - fetchNativePrices() (line ~1057)

5. ✅ Add token cache to verifyTokenWithDexScreener()
   - Add cacheKey check at start (line ~207)
   - Add cache set at end (before return)

6. ✅ Replace safeEdit()
   Lines ~3653-3656

7. ✅ Deploy to performance-optimization branch

8. ✅ Test on Render - verify <2s response times

9. ✅ Merge to main

EXPECTED RESULT:
- Response time: 20-30s ❌ → 1-2s ✅ (15x faster!)
- API calls: 8-12 → 2-3 per request
- Event loop blocking: 200ms → <5ms
*/
