const express = require('express');
const cors = require('cors');
const { CheerioCrawler, Configuration } = require('crawlee');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
// BASIC CRAWL STATE (original)
// ─────────────────────────────────────────────
let isCrawling = false;
let crawledCount = 0;
let totalErrors = 0;
let totalWarnings = 0;

// ─────────────────────────────────────────────
// PRO CRAWL STATE (Screaming Frog style)
// ─────────────────────────────────────────────
const proCrawl = {
    isRunning: false,
    stopRequested: false,
    crawledCount: 0,
    errorCount: 0,
    warningCount: 0,
    startTime: null,
    domain: '',
    currentUrl: '',
    results: [],
    totalQueued: 0
};

// ─────────────────────────────────────────────
// ORIGINAL Endpoints (kept intact)
// ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ isCrawling, crawledCount, totalErrors, totalWarnings });
});

app.get('/api/debug-files', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname);
        res.json({ dirname: __dirname, files });
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.post('/api/crawl', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (isCrawling) return res.status(400).json({ error: 'A crawl is already in progress' });

    isCrawling = true;
    crawledCount = 0;
    totalErrors = 0;
    totalWarnings = 0;
    res.json({ message: 'Crawling started successfully' });

    try {
        const domain = new URL(url).hostname;
        const csvWriter = createObjectCsvWriter({
            path: path.join(__dirname, 'seo_audit_report.csv'),
            header: [
                { id: 'url', title: 'URL' },
                { id: 'status', title: 'Status Code' },
                { id: 'title', title: 'Title' },
                { id: 'titleLength', title: 'Title Length' },
                { id: 'h1', title: 'H1 Tag' },
                { id: 'wordCount', title: 'Word Count' }
            ]
        });
        const config = new Configuration({
            storageDir: path.join(__dirname, 'storage', `basic-crawl-${Date.now()}`),
            ignoreRobotsTxt: true
        });
        const crawler = new CheerioCrawler({
            maxRequestsPerCrawl: 30000,
            maxConcurrency: 5,
            preNavigationHooks: [
                async ({ request }) => {
                    request.headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        ...request.headers
                    };
                }
            ],
            async requestHandler({ request, $, response }) {
                crawledCount++;
                const status = response ? response.statusCode : 0;
                if (status >= 400) totalErrors++;
                const title = $('title').text() || '';
                const h1 = $('h1').first().text() || '';
                const wordCount = $('body').text().split(/\s+/).length;
                if (title.length > 60 || title.length < 10) totalWarnings++;
                await csvWriter.writeRecords([{ url: request.loadedUrl, status, title, titleLength: title.length, h1, wordCount }]);
                console.log(`[${crawledCount}] Crawled: ${request.loadedUrl}`);
                const links = $('a[href]');
                for (let i = 0; i < links.length; i++) {
                    const href = $(links[i]).attr('href');
                    if (href) {
                        try {
                            const absoluteUrl = new URL(href, request.loadedUrl);
                            if (absoluteUrl.hostname === domain || absoluteUrl.hostname.endsWith('.' + domain)) {
                                await crawler.addRequests([absoluteUrl.href]);
                            }
                        } catch (e) {}
                    }
                }
            },
            failedRequestHandler({ request }) {
                console.log(`Request failed: ${request.url}`);
                totalErrors++;
            }
        }, config);
        await crawler.run([url]);
        console.log('Basic crawling finished.');
        isCrawling = false;
    } catch (err) {
        console.error('Crawl error:', err);
        isCrawling = false;
    }
});

// ─────────────────────────────────────────────
// HELPER: Clean storage before new crawl
// ─────────────────────────────────────────────
async function cleanStorage() {
    const storagePath = path.join(__dirname, 'storage');
    try {
        const files = await fs.promises.readdir(storagePath);
        for (const file of files) {
            if (file.startsWith('pro-crawl-') || file.startsWith('basic-crawl-')) {
                await fs.promises.rm(path.join(storagePath, file), { recursive: true, force: true });
            }
        }
    } catch (e) { /* ignore */ }
}

// ─────────────────────────────────────────────
// PRO CRAWL: Start
// ─────────────────────────────────────────────
app.post('/api/pro/start', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL zaroori hai' });
    if (proCrawl.isRunning) return res.status(400).json({ error: 'Crawl pehle se chal raha hai' });

    let domain;
    try { domain = new URL(url).hostname; }
    catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

    // Reset state
    proCrawl.isRunning = true;
    proCrawl.stopRequested = false;
    proCrawl.crawledCount = 0;
    proCrawl.errorCount = 0;
    proCrawl.warningCount = 0;
    proCrawl.startTime = Date.now();
    proCrawl.domain = domain;
    proCrawl.currentUrl = '';
    proCrawl.results = [];
    proCrawl.totalQueued = 1;

    res.json({ message: 'Pro crawl shuru ho gaya!', domain });

    // Clean old storage
    await cleanStorage();

    // Start crawl in background
    (async () => {
        try {
            const config = new Configuration({
                storageDir: path.join(__dirname, 'storage', `pro-crawl-${Date.now()}`),
                ignoreRobotsTxt: true
            });
            const crawler = new CheerioCrawler({
                maxRequestsPerCrawl: Infinity,
                maxConcurrency: 5,
                requestHandlerTimeoutSecs: 30,
                navigationTimeoutSecs: 30,

                preNavigationHooks: [
                    async ({ request }) => {
                        request.userData.startTime = Date.now();
                        request.headers = {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            ...request.headers
                        };
                    }
                ],

                async requestHandler({ request, $, response }) {
                    if (proCrawl.stopRequested) return;

                    const responseTime = Date.now() - (request.userData.startTime || Date.now());
                    const loadedUrl = request.loadedUrl || request.url;
                    proCrawl.currentUrl = loadedUrl;

                    const status = response ? response.statusCode : 0;

                    // ── Extract all SEO data ──
                    const title = $('title').first().text().trim() || '';
                    const titleLength = title.length;

                    let metaDesc = '';
                    $('meta').each((i, el) => {
                        const name = $(el).attr('name') || '';
                        const property = $(el).attr('property') || '';
                        if (name.toLowerCase() === 'description' || property.toLowerCase() === 'description' || property.toLowerCase() === 'og:description') {
                            metaDesc = $(el).attr('content') || '';
                        }
                    });
                    metaDesc = metaDesc.trim();
                    const metaDescLength = metaDesc.length;

                    const h1First = $('h1').first().text().trim() || '';
                    const h1Count = $('h1').length;
                    const h2Count = $('h2').length;

                    const canonical = $('link[rel="canonical"]').attr('href') || '';
                    const robotsMeta = $('meta[name="robots"]').attr('content') || '';
                    const isNoindex = /noindex/i.test(robotsMeta);

                    // Images
                    const allImgs = $('img');
                    const totalImages = allImgs.length;
                    const imagesNoAlt = allImgs.filter((i, el) => {
                        const alt = $(el).attr('alt');
                        return !alt || alt.trim() === '';
                    }).length;

                    // Links
                    let internalLinks = 0;
                    let externalLinks = 0;
                    const seenLinks = new Set();
                    $('a[href]').each((i, el) => {
                        const href = $(el).attr('href') || '';
                        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
                        try {
                            const absUrl = new URL(href, loadedUrl);
                            if (absUrl.hostname === domain || absUrl.hostname.endsWith('.' + domain)) {
                                internalLinks++;
                                if (!proCrawl.stopRequested && !seenLinks.has(absUrl.href)) {
                                    seenLinks.add(absUrl.href);
                                    crawler.addRequests([{ url: absUrl.href }]).catch(() => {});
                                }
                            } else if (absUrl.protocol.startsWith('http')) {
                                externalLinks++;
                            }
                        } catch (e) {}
                    });

                    // Word count (body text)
                    const bodyText = $('body').text() || '';
                    const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

                    // Page size
                    let pageSize = 0;
                    try { pageSize = Math.round(Buffer.byteLength($.html() || '', 'utf8') / 102.4) / 10; } catch(e) {}

                    // Schema markup
                    const hasSchema = $('script[type="application/ld+json"]').length > 0;

                    // Open Graph
                    const ogTitle = $('meta[property="og:title"]').attr('content') || '';

                    // Redirect URL
                    let redirectUrl = '';
                    if (status >= 300 && status < 400) {
                        redirectUrl = response.headers?.location || '';
                    }

                    // Issues count
                    if (status >= 400) proCrawl.errorCount++;
                    if (!metaDesc || titleLength > 60 || titleLength < 10 || h1Count === 0) proCrawl.warningCount++;

                    proCrawl.crawledCount++;

                    const row = {
                        url: loadedUrl,
                        status,
                        redirectUrl,
                        title,
                        titleLength,
                        metaDesc,
                        metaDescLength,
                        h1: h1First,
                        h1Count,
                        h2Count,
                        canonical,
                        robots: robotsMeta,
                        isNoindex,
                        totalImages,
                        imagesNoAlt,
                        internalLinks,
                        externalLinks,
                        wordCount,
                        pageSize,
                        responseTime,
                        hasSchema,
                        ogTitle
                    };

                    proCrawl.results.push(row);
                    console.log(`[PRO ${proCrawl.crawledCount}] ${status} ${loadedUrl}`);
                },

                failedRequestHandler({ request, error }) {
                    if (proCrawl.stopRequested) return;
                    proCrawl.errorCount++;
                    proCrawl.crawledCount++;
                    proCrawl.results.push({
                        url: request.url,
                        status: 0,
                        redirectUrl: '',
                        title: '',
                        titleLength: 0,
                        metaDesc: '',
                        metaDescLength: 0,
                        h1: '',
                        h1Count: 0,
                        h2Count: 0,
                        canonical: '',
                        robots: '',
                        isNoindex: false,
                        totalImages: 0,
                        imagesNoAlt: 0,
                        internalLinks: 0,
                        externalLinks: 0,
                        wordCount: 0,
                        pageSize: 0,
                        responseTime: 0,
                        hasSchema: false,
                        ogTitle: '',
                        _error: error ? error.message : 'Unknown error'
                    });
                    console.log(`[PRO FAIL] ${request.url}: ${error?.message}`);
                }
            }, config);

            await crawler.run([{ url }]);
            console.log('[PRO] Crawl complete!');
        } catch (err) {
            console.error('[PRO] Crawl error:', err.message);
        } finally {
            proCrawl.isRunning = false;
            proCrawl.stopRequested = false;
            proCrawl.currentUrl = '';
        }
    })();
});

// ─────────────────────────────────────────────
// PRO CRAWL: Status (cursor-based polling)
// ─────────────────────────────────────────────
app.get('/api/pro/status', (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const newResults = proCrawl.results.slice(offset);
    const elapsed = proCrawl.startTime ? Math.floor((Date.now() - proCrawl.startTime) / 1000) : 0;
    const speed = elapsed > 0 ? (proCrawl.crawledCount / elapsed).toFixed(1) : 0;

    res.json({
        isRunning: proCrawl.isRunning,
        crawledCount: proCrawl.crawledCount,
        errorCount: proCrawl.errorCount,
        warningCount: proCrawl.warningCount,
        currentUrl: proCrawl.currentUrl,
        domain: proCrawl.domain,
        elapsed,
        speed,
        total: proCrawl.results.length,
        newResults
    });
});

// ─────────────────────────────────────────────
// PRO CRAWL: Stop
// ─────────────────────────────────────────────
app.post('/api/pro/stop', (req, res) => {
    if (!proCrawl.isRunning) return res.json({ message: 'Koi crawl chal nahi raha tha' });
    proCrawl.stopRequested = true;
    res.json({ message: 'Stop request bhej diya — thodi der me rukega' });
});

// ─────────────────────────────────────────────
// PRO CRAWL: Export CSV
// ─────────────────────────────────────────────
app.get('/api/pro/export', (req, res) => {
    const results = proCrawl.results;
    if (results.length === 0) return res.status(400).json({ error: 'Koi data nahi hai' });

    const headers = [
        'URL', 'Status', 'Redirect URL', 'Title', 'Title Length',
        'Meta Description', 'Meta Desc Length', 'H1', 'H1 Count', 'H2 Count',
        'Canonical', 'Robots Meta', 'No-index', 'Total Images', 'Images No Alt',
        'Internal Links', 'External Links', 'Word Count', 'Page Size (KB)',
        'Response Time (ms)', 'Schema Markup', 'OG Title'
    ];

    const rows = results.map(r => [
        r.url, r.status, r.redirectUrl, r.title, r.titleLength,
        r.metaDesc, r.metaDescLength, r.h1, r.h1Count, r.h2Count,
        r.canonical, r.robots, r.isNoindex ? '✓' : '✗',
        r.totalImages, r.imagesNoAlt, r.internalLinks, r.externalLinks,
        r.wordCount, r.pageSize, r.responseTime,
        r.hasSchema ? 'Yes' : 'No', r.ogTitle
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`));

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const bom = '\uFEFF'; // UTF-8 BOM for Excel

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="seo-spider-${proCrawl.domain}-${Date.now()}.csv"`);
    res.send(bom + csv);
});

// ─────────────────────────────────────────────
// AI HELPERS (from previous update)
// ─────────────────────────────────────────────
async function fetchHtml(targetUrl) {
    const { gotScraping } = await import('got-scraping');
    const response = await gotScraping({
        url: targetUrl
    });
    return response.body;
}

function extractCleanContent(html) {
    let clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s{2,}/g, ' ').trim();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    return { text: clean, title };
}

function extractNextJsContent(html) {
    const regex = /__next_f\.push\(\s*\[\s*\d+\s*,\s*"([\s\S]*?)"\s*\]\s*\)/g;
    let match;
    let concatenated = '';
    
    while ((match = regex.exec(html)) !== null) {
        let chunk = match[1];
        chunk = chunk
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>')
            .replace(/\\u0026/g, '&');
        concatenated += chunk + '\n';
    }
    
    let text = concatenated
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ');
        
    let lines = text.split('\n');
    lines = lines.filter(line => {
        line = line.trim();
        if (!line) return false;
        if (/^:?[a-f0-9]+:/.test(line)) return false;
        if (/^:[A-Z]+/.test(line)) return false;
        if (line.includes('_next/static/')) return false;
        if (line.includes('"$Sreact')) return false;
        if (line.includes('.js')) return false;
        if (line.includes('static/')) return false;
        if (line.includes('chunks/')) return false;
        if (line.includes('xlinkHref')) return false;
        if (line.includes('viewBox')) return false;
        
        const bracketsCount = (line.match(/[{}[\]"']/g) || []).length;
        if (bracketsCount > line.length * 0.15) return false;
        
        return true;
    });
    
    const clean = lines.join('\n').replace(/\s{2,}/g, ' ').trim();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    return { text: clean, title };
}

async function callGemini(apiKey, prompt) {
    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'text/plain' }
    });
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) return reject(new Error(parsed.error.message));
                    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!text) return reject(new Error('No content in Gemini response'));
                    resolve(text);
                } catch (e) { reject(new Error('Failed to parse Gemini response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Gemini API timed out')); });
        req.write(body);
        req.end();
    });
}

function parseAiJson(text) {
    let cleaned = text.trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// AI ENDPOINTS (from previous update)
// ─────────────────────────────────────────────
app.post('/api/fetch-url', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
        const html = await fetchHtml(url);
        let { text, title } = extractCleanContent(html);
        let wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

        // Fallback to Next.js flight data parser if standard body text is too small (e.g. client side rendered pages)
        if (wordCount < 100) {
            const nextResult = extractNextJsContent(html);
            const nextWordCount = nextResult.text.split(/\s+/).filter(w => w.length > 0).length;
            if (nextWordCount > wordCount) {
                text = nextResult.text;
                title = nextResult.title || title;
                wordCount = nextWordCount;
            }
        }

        if (wordCount < 50) return res.status(400).json({ error: 'Could not extract enough content. Please paste manually.' });
        const truncated = text.length > 15000 ? text.substring(0, 15000) + '...' : text;
        res.json({ content: truncated, title, wordCount });
    } catch (err) {
        res.status(500).json({ error: 'URL fetch error: ' + err.message });
    }
});

app.post('/api/ai/optimize', async (req, res) => {
    const { content, apiKey, level } = req.body;
    if (!content || !apiKey) return res.status(400).json({ error: 'Content aur API key zaroori hain' });
    const levelMap = { basic: 'lightly improve', advanced: 'do advanced SEO optimization', complete: 'completely rewrite' };
    const prompt = `You are a professional SEO content expert. Analyze the following blog and ${levelMap[level] || levelMap.advanced}.
BLOG:
"""${content.substring(0, 12000)}"""
Respond ONLY valid JSON (no markdown fences):
{"seoScore":<0-100>,"readabilityScore":<0-100>,"keywordDensityScore":<0-100>,"engagementScore":<0-100>,"metaTitle":"<max 60 chars>","metaDescription":"<150-160 chars>","focusKeyword":"<primary keyword>","lsiKeywords":["kw1","kw2","kw3","kw4","kw5"],"recommendations":["rec1","rec2","rec3","rec4","rec5"],"faqs":[{"question":"q1","answer":"a1"},{"question":"q2","answer":"a2"},{"question":"q3","answer":"a3"},{"question":"q4","answer":"a4"}],"optimizedContent":"<full optimized markdown blog, min 800 words>"}`;
    try {
        const aiText = await callGemini(apiKey, prompt);
        res.json(parseAiJson(aiText));
    } catch (err) {
        res.status(500).json({ error: 'AI optimization error: ' + err.message });
    }
});

app.post('/api/ai/generate', async (req, res) => {
    const { topic, keyword, length, tone, instructions, apiKey } = req.body;
    if (!topic || !keyword || !apiKey) return res.status(400).json({ error: 'Topic, keyword, API key zaroori hain' });
    const lengthMap = { short: '600-900 words', medium: '1200-1600 words', long: '2200-2800 words' };
    const prompt = `You are a professional SEO blog writer. Write a high-quality SEO-optimized blog post.
Topic: ${topic}, Keyword: ${keyword}, Length: ${lengthMap[length] || lengthMap.medium}, Tone: ${tone || 'Professional'}, Instructions: ${instructions || 'None'}
Respond ONLY valid JSON (no markdown fences):
{"metaTitle":"<max 60 chars>","metaDescription":"<150-160 chars>","focusKeyword":"${keyword}","lsiKeywords":["kw1","kw2","kw3","kw4","kw5"],"wordCount":<number>,"readingTime":"<e.g. 7 min read>","headingCount":<number>,"faqs":[{"question":"q1","answer":"a1"},{"question":"q2","answer":"a2"},{"question":"q3","answer":"a3"},{"question":"q4","answer":"a4"}],"blogContent":"<full markdown blog with # H1, ## H2, ### H3, bullets, bold, conclusion>"}`;
    try {
        const aiText = await callGemini(apiKey, prompt);
        res.json(parseAiJson(aiText));
    } catch (err) {
        res.status(500).json({ error: 'Blog generation error: ' + err.message });
    }
});

app.post('/api/ai/analyze', async (req, res) => {
    const { content, apiKey } = req.body;
    if (!content || !apiKey) return res.status(400).json({ error: 'Content aur API key zaroori hain' });
    const prompt = `You are an expert SEO auditor. Analyze:
"""${content.substring(0, 12000)}"""
Respond ONLY valid JSON (no markdown fences):
{"readabilityScore":<0-100>,"seoScore":<0-100>,"engagementScore":<0-100>,"qualityScore":<0-100>,"wordCount":<number>,"sentenceCount":<number>,"avgWordsPerSentence":<number>,"detectedKeywords":["kw1","kw2","kw3","kw4","kw5"],"strengths":["s1","s2","s3","s4"],"improvements":["i1","i2","i3","i4","i5"],"suggestedMetaTitle":"<max 60 chars>","suggestedMetaDescription":"<150-160 chars>","overallFeedback":"<2-3 sentences>"}`;
    try {
        const aiText = await callGemini(apiKey, prompt);
        res.json(parseAiJson(aiText));
    } catch (err) {
        res.status(500).json({ error: 'Content analysis error: ' + err.message });
    }
});

// ─────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n╔═══════════════════════════════════════════╗`);
    console.log(`║   SEO Suite Backend running on port ${PORT}   ║`);
    console.log(`║   Open: http://localhost:${PORT}             ║`);
    console.log(`╚═══════════════════════════════════════════╝\n`);
});
