/**
 * AnimeDekho.app Importer (HTML Scraper version)
 *
 * animedekho.app is a server-rendered HTML site with a different structure than animerulz.cc.
 * Key differences:
 * - Anime pages at /serie/slug/
 * - Episodes listed as S1-E1, S2-E33 inline on the page
 * - Episode watch pages at /epi/slug-seasonxepisode/
 *
 * Usage:
 *   node animedekho_importer.js search "Naruto"
 *   node animedekho_importer.js db-export "Naruto" > output.sql
 *   node animedekho_importer.js bulk-export 50 > all_anime.sql
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

const SITE_BASE = 'https://animedekho.app';

const sleep = ms => new Promise(res => setTimeout(res, ms));

// ─── HTTP Helper ───────────────────────────────────────────────────────────────

function fetchHTML(url, retries = 3, delay = 1000) {
    return new Promise((resolve, reject) => {
        const attemptFetch = (n) => {
            const mod = url.startsWith('https') ? https : http;
            const req = mod.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Cookie': 'toronites_server=vidstream'
                },
                timeout: 30000,
            }, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : new URL(res.headers.location, url).toString();
                    fetchHTML(redirectUrl, retries, delay).then(resolve).catch(reject);
                    return;
                }

                if (res.statusCode >= 400) {
                    if (n > 0 && (res.statusCode === 429 || res.statusCode >= 500)) {
                        console.error(`  HTTP ${res.statusCode} for ${url}. Retrying in ${delay}ms... (${n} left)`);
                        setTimeout(() => attemptFetch(n - 1), delay);
                        return;
                    }
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });

            req.on('error', (err) => {
                if (n > 0) {
                    console.error(`  Error fetching ${url}: ${err.message}. Retrying in ${delay}ms... (${n} left)`);
                    setTimeout(() => attemptFetch(n - 1), delay * 1.5); // Exponential backoff
                } else {
                    reject(err);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (n > 0) {
                    console.error(`  Timeout fetching ${url}. Retrying in ${delay}ms... (${n} left)`);
                    setTimeout(() => attemptFetch(n - 1), delay * 1.5);
                } else {
                    reject(new Error('Request timeout'));
                }
            });
        };

        attemptFetch(retries);
    });
}

// ─── Regex Helper ──────────────────────────────────────────────────────────────

function extractAllMatches(text, regex) {
    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        matches.push(match);
    }
    return matches;
}

// ─── SQL Escape ────────────────────────────────────────────────────────────────

function sqlEscape(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/**
 * Basic HTML entity decoder for common entities.
 */
function decodeHTMLEntities(str) {
    if (!str) return '';
    return str
        .replace(/&#039;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#8211;/g, '-')
        .replace(/&#8212;/g, '--')
        .replace(/&hellip;/g, '...')
        .replace(/&nbsp;/g, ' ');
}

// ─── Importer Class ────────────────────────────────────────────────────────────

class AnimeDekhoImporter {

    /**
     * Search for anime using the site's search functionality.
     */
    async search(query) {
        const results = [];
        const seenSlugs = new Set();

        try {
            // Use the official search URL provided by the user
            const searchUrl = `${SITE_BASE}/?s=${encodeURIComponent(query)}`;
            const html = await fetchHTML(searchUrl);

            // Pattern for search results: look for article blocks
            const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
            const articles = extractAllMatches(html, articleRegex);

            for (const match of articles) {
                const block = match[1];
                const linkMatch = block.match(/href="https:\/\/animedekho\.app\/serie\/([^\/]+)\/"/i);

                if (linkMatch) {
                    const slug = linkMatch[1].replace(/\/+$/, '');
                    if (slug && !seenSlugs.has(slug)) {
                        // Title is usually in h2.entry-title or h3.post-title
                        const titleMatch = block.match(/<(?:h2|h3)[^>]*>(.*?)<\/(?:h2|h3)>/i);
                        let title = titleMatch ? decodeHTMLEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

                        if (!title) {
                            title = decodeHTMLEntities(slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
                        }

                        seenSlugs.add(slug);
                        results.push({
                            title: title,
                            url: `${SITE_BASE}/serie/${slug}/`,
                            slug: slug,
                            type: (title && title.toLowerCase().includes('movie')) || (slug && slug.includes('movie')) ? 'movie' : 'series',
                        });
                    }
                }
            }

            // Fallback: If no results found with specific search pattern, try original list parsing
            if (results.length === 0) {
                results.push(...this._parseAnimeList(html));
            }

        } catch (e) {
            console.error(`Search error: ${e.message}`);
        }

        // If still no results, fallback to homepage scraping (original behavior)
        if (results.length === 0) {
            try {
                const homeHtml = await fetchHTML(`${SITE_BASE}/home/`);
                results.push(...this._parseAnimeList(homeHtml));
            } catch (e) {
                console.error(`Home fallback error: ${e.message}`);
            }
        }

        // Filter results by query match (partial)
        const lowerQuery = query.toLowerCase();
        const filtered = results.filter(r =>
            (r.title && r.title.toLowerCase().includes(lowerQuery)) ||
            (r.slug && r.slug.toLowerCase().includes(lowerQuery)) ||
            (r.title && lowerQuery.split(' ').every(word => r.title.toLowerCase().includes(word)))
        );

        // Remove duplicates by slug
        const finalResults = [];
        const finalSeen = new Set();
        for (const r of filtered) {
            if (!finalSeen.has(r.slug)) {
                finalSeen.add(r.slug);
                finalResults.push(r);
            }
        }
        return finalResults;
    }

    /**
     * Get the estimated schedule from the homepage.
     */

    /**
     * Get the estimated schedule from the homepage.
     */
    async getSchedule() {
        try {
            const html = await fetchHTML(`${SITE_BASE}/home/`);

            // Extract the scheduleData array from the script tag
            const match = html.match(/const scheduleData = (\[[\s\S]*?\]);/);

            if (!match) return JSON.stringify({ error: "Schedule data script not found." });

            const rawData = match[1];
            return rawData.trim();
        } catch (e) {
            return JSON.stringify({ error: `Error fetching schedule: ${e.message}` });
        }
    }

    /**
     * Helper to clean anime titles by removing common SEO suffixes/prefixes.
     */
    _cleanTitle(title) {
        if (!title) return '';
        return title
            .replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '')
            .replace(/Watch\s+Online\s+/i, '')
            .replace(/\s+in\s+Hindi\s+Dubbed.*$/i, '')
            .replace(/\s+All\s+Season\s+Episodes.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _parseAnimeList(html) {
        const results = [];
        const seenSlugs = new Set();

        // Pattern 1: h2 headers with Watch Now links (Markdown-ish style found in some pages)
        const animeRegex = /<h[23][^>]*>([^<]+)<\/h[23]>\s*\[[^\]]*\]\((https:\/\/animedekho\.app\/serie\/([^\/]+)\/)\)/gi;
        const matches = extractAllMatches(html, animeRegex);

        for (const match of matches) {
            const rawTitle = match[1].trim();
            const title = this._cleanTitle(rawTitle);
            const url = match[2];
            const slug = match[3].replace(/\/+$/, '');

            if (slug && title && !seenSlugs.has(slug)) {
                const isMovie = title.toLowerCase().includes('movie') ||
                    slug.includes('movie') ||
                    /\bfilm\b/i.test(title);

                seenSlugs.add(slug);
                results.push({
                    title: title,
                    url: url,
                    slug: slug,
                    type: isMovie ? 'movie' : 'series',
                });
            }
        }

        // Pattern 2: Serie links with titles inside (Standard HTML links)
        const serieRegex = /href="(https:\/\/animedekho\.app\/serie\/([^\/]+)\/)"[^>]*>([^<]+)<\/a>/gi;
        const serieMatches = extractAllMatches(html, serieRegex);

        for (const match of serieMatches) {
            const url = match[1];
            const slug = match[2].replace(/\/+$/, '');
            const rawTitle = match[3].trim();
            const title = this._cleanTitle(rawTitle);

            if (slug && title && !seenSlugs.has(slug) && title.length > 2 && !title.includes('Watch Series') && !title.includes('Series')) {
                const isMovie = title.toLowerCase().includes('movie') ||
                    slug.includes('movie') ||
                    /\bfilm\b/i.test(title);

                seenSlugs.add(slug);
                results.push({
                    title: title,
                    url: url,
                    slug: slug,
                    type: isMovie ? 'movie' : 'series',
                });
            }
        }

        // Pattern 3: Watch Series buttons - look for the title in the nearest H2/H3
        // Structure usually: <h2 ...>Title</h2> ... <a ...>Watch Series</a>
        const blocks = html.split(/<h[23]/i);
        for (let i = 1; i < blocks.length; i++) {
            const block = blocks[i];
            const titleMatch = block.match(/>([^<]+)<\/h[23]>/i);
            const linkMatch = block.match(/href="(https:\/\/animedekho\.app\/serie\/([^\/]+)\/)"[^>]*>Watch Series<\/a>/i);

            if (titleMatch && linkMatch) {
                const rawTitle = titleMatch[1].trim();
                const title = this._cleanTitle(rawTitle);
                const url = linkMatch[1];
                const slug = linkMatch[2].replace(/\/+$/, '');

                if (slug && !seenSlugs.has(slug)) {
                    seenSlugs.add(slug);
                    results.push({
                        title: title,
                        url: url,
                        slug: slug,
                        type: title.toLowerCase().includes('movie') || slug.includes('movie') ? 'movie' : 'series',
                    });
                }
            }
        }

        return results;
    }


    /**
     * Get anime details by scraping the anime page HTML.
     */
    async getAnimeDetails(slugOrUrl) {
        let slug = slugOrUrl;
        if (slugOrUrl.startsWith('http')) {
            slug = slugOrUrl.replace(/^https?:\/\/[^/]+\/serie\//, '').replace(/\/$/, '');
        }

        const url = `${SITE_BASE}/serie/${slug}/`;
        const html = await fetchHTML(url);

        // Extract title
        let title = '';
        const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
        if (ogTitleMatch) {
            title = decodeHTMLEntities(ogTitleMatch[1])
                .replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '')
                .replace(/Watch\s+Online\s+/i, '')
                .replace(/\s+in\s+Hindi\s+Dubbed.*$/i, '')
                .replace(/\s+All\s+Season\s+Episodes.*$/i, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        // Extract description
        let description = '';
        const descPatterns = [
            /<meta[^>]*name="description"[^>]*content="([^"]+)"/i,
            /<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i,
        ];
        for (const pattern of descPatterns) {
            const descMatch = html.match(pattern);
            if (descMatch) {
                description = decodeHTMLEntities(descMatch[1])
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&[a-z]+;/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                break;
            }
        }

        // Extract poster
        let poster = '';
        const posterPatterns = [
            // Standard poster in aside/post-thumbnail
            /<aside[^>]*>[\s\S]*?<div class="post-thumbnail"[^>]*>[\s\S]*?<img [^>]*src="([^"]+)"/i,
            // Any figure with an image
            /<figure[^>]*>[\s\S]*?<img [^>]*src="([^"]+)"/i,
            // Open Graph image
            /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i,
            // Fallback to any TMDB image link
            /https:\/\/image\.tmdb\.org\/t\/p\/w\d+\/[^"'\s<>]+/i
        ];
        for (const pattern of posterPatterns) {
            const match = html.match(pattern);
            if (match) {
                poster = match[1] || match[0];
                // Prefer high-quality TMDB images
                if (poster.includes('image.tmdb.org')) {
                    poster = poster.replace(/\/w\d+\//, '/w500/');
                }
                break;
            }
        }

        // Determine type
        const isMovie = title.toLowerCase().includes('movie') ||
            slug.includes('movie') ||
            /\bfilm\b/i.test(title);
        const type = isMovie ? 'movie' : 'series';

        // Build season list from episode markers (S1-E1, S2-E33, etc.)
        let seasonList = [];
        const seasonRegex = /S(\d+)-E\d+/gi;
        const seasonMatches = extractAllMatches(html, seasonRegex);

        for (const match of seasonMatches) {
            const seasonNum = parseInt(match[1]);
            if (!isNaN(seasonNum) && seasonNum > 0 && !seasonList.find(s => s.seasonNumber === seasonNum)) {
                seasonList.push({
                    seasonNumber: seasonNum,
                    slug: slug,
                    title: `Season ${seasonNum}`,
                });
            }
        }

        seasonList.sort((a, b) => a.seasonNumber - b.seasonNumber);

        if (seasonList.length === 0) {
            seasonList.push({ seasonNumber: 1, slug: slug, title: 'Season 1' });
        }

        return {
            title: title,
            description: description,
            poster: poster,
            type: type,
            totalEpisodes: 0,
            totalSeasons: seasonList.length,
            seasons: seasonList,
            slug: slug,
        };
    }

    /**
     * Get episodes by parsing S#-E# markers from the anime page.
     * Returns episodes in format: {episodeId, number, title, season}
     */
    async getEpisodes(slug) {
        const episodes = [];
        const url = `${SITE_BASE}/serie/${slug}/`;

        try {
            const html = await fetchHTML(url);

            // 1. Robust Scraping: Find all list items in seasons-lst
            const liRegex = /<li>([\s\S]*?)<\/li>/gi;
            const liMatches = extractAllMatches(html, liRegex);

            for (const match of liMatches) {
                const block = match[1];

                // Matches patterns like <span>S1-E1</span> Episode Title
                const titleMatch = block.match(/<span>S(\d+)-E(\d+)<\/span>\s*([^<]+)/i);
                // Matches /epi/ links
                const linkMatch = block.match(/href="([^"]*\/epi\/[^"]+)\/"/i) || block.match(/href="([^"]*\/epi\/[^"]+)"/i);

                if (titleMatch && linkMatch) {
                    const seasonNum = parseInt(titleMatch[1]);
                    const episodeNum = parseInt(titleMatch[2]);
                    const epTitle = titleMatch[3].trim();
                    let epSlug = linkMatch[1].replace(/^https?:\/\/animedekho\.app\/epi\//, '').replace(/\/$/, '');

                    if (!isNaN(seasonNum) && !isNaN(episodeNum)) {
                        const key = `${seasonNum}x${episodeNum}`;
                        if (!episodes.find(e => `${e.season}x${e.number}` === key)) {
                            episodes.push({
                                episodeId: epSlug,
                                number: episodeNum,
                                title: epTitle || `Episode ${episodeNum}`,
                                season: seasonNum,
                                isFiller: false,
                            });
                        }
                    }
                }
            }

            // 2. Fallback: If no links found via the structured list, try loose regex patterns
            if (episodes.length === 0) {
                const episodeRegex = /S(\d+)-E(\d+)\s+([^<[\n]+)/gi;
                const epMatches = extractAllMatches(html, episodeRegex);
                for (const m of epMatches) {
                    const s = parseInt(m[1]);
                    const e = parseInt(m[2]);
                    const t = m[3].trim().replace(/<[^>]+>/g, '').trim();
                    if (!isNaN(s) && !isNaN(e)) {
                        episodes.push({
                            episodeId: `${slug}-${s}x${e}`,
                            number: e,
                            title: t,
                            season: s,
                            isFiller: false
                        });
                    }
                }
            }

            return episodes.sort((a, b) => {
                if (a.season !== b.season) return a.season - b.season;
                return a.number - b.number;
            });

        } catch (e) {
            console.error(`Error getting episodes for ${slug}: ${e.message}`);
            return [];
        }
    }

    /**
     * Get video link for an episode by scraping the episode page.
     * Systematic multi-server fallback: tries ALL servers until a direct video link is found.
     */
    async getEpisodeLink(episodeId) {
        try {
            const watchUrl = `${SITE_BASE}/epi/${episodeId}/`;
            const html = await fetchHTML(watchUrl);

            // 1. Extract ALL potential server sources
            const serverSources = [];

            // From data-src (Priority)
            const dataSrcRegex = /data-src=["']([a-zA-Z0-9+/=]+)["']/gi;
            const dataSrcMatches = extractAllMatches(html, dataSrcRegex);
            for (const match of dataSrcMatches) {
                try {
                    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
                    if (decoded.startsWith('http') && !serverSources.includes(decoded)) {
                        serverSources.push(decoded);
                    }
                } catch (e) { }
            }

            // From dl2.php pattern
            const dl2Regex = /https?:\/\/animedekho\.app\/download\/dl2\.php\?url=([a-zA-Z0-9+/=]+)/gi;
            const dl2Matches = extractAllMatches(html, dl2Regex);
            for (const match of dl2Matches) {
                try {
                    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
                    if (decoded.startsWith('http') && !serverSources.includes(decoded)) {
                        serverSources.push(decoded);
                    }
                } catch (e) { }
            }

            // From raw iframes on page
            const iframeRegex = /<iframe[^>]*src="([^"]+)"/gi;
            const iframeMatches = extractAllMatches(html, iframeRegex);
            for (const match of iframeMatches) {
                let src = match[1];
                if (src.startsWith('/')) src = SITE_BASE + src;
                if (!serverSources.includes(src)) serverSources.push(src);
            }

            // 2. Resolve sources one by one
            let fallbackInternalLink = null;

            for (const source of serverSources) {
                if (this._isTutorialLink(source)) continue;

                // If already a known-good direct provider, return it
                if (this._isDirectVideoLink(source)) return source;

                // Try to resolve internal animedekho.app/embed links
                if (source.includes('animedekho.app/embed') || source.includes('animedekho.app/redirect')) {
                    const resolved = await this._resolveSource(source);
                    if (resolved) {
                        if (this._isDirectVideoLink(resolved)) {
                            return resolved; // Found a working direct link via this server!
                        } else if (!fallbackInternalLink && !this._isTutorialLink(resolved)) {
                            // Keep the first non-tutorial internal link as a last-resort fallback
                            fallbackInternalLink = resolved;
                        }
                    }
                } else if (!this._isTutorialLink(source)) {
                    // It's some other external link, return it if nothing else found
                    if (!fallbackInternalLink) fallbackInternalLink = source;
                }
            }

            return fallbackInternalLink;

        } catch (e) {
            console.error(`  Error in getEpisodeLink for ${episodeId}: ${e.message}`);
            return null;
        }
    }

    /**
     * Resolves an internal embed URL to its actual video provider link.
     */
    async _resolveSource(sourceUrl) {
        try {
            const embedHtml = await fetchHTML(sourceUrl);
            const iframeRegex = /<iframe[^>]*src="([^"]+)"/gi;
            const allIframes = extractAllMatches(embedHtml, iframeRegex);

            for (const match of allIframes) {
                const src = match[1];
                let fullSrc = src.startsWith('//') ? 'https:' + src : src;

                if (fullSrc.startsWith('/')) {
                    try {
                        const origin = new URL(sourceUrl).origin;
                        fullSrc = origin + fullSrc;
                    } catch (e) {
                        fullSrc = SITE_BASE + fullSrc;
                    }
                }

                if (this._isTutorialLink(fullSrc)) continue;
                if (this._isDirectVideoLink(fullSrc)) return fullSrc;
            }

            // Fallback: Check for video links in scripts
            const scriptRegex = /https?:\/\/[^/]+(?:as-cdn21\.top|play\.zephyrflick\.top|vidstreaming|dood|stream|vidmoly|gdmirrorbot|short\.icu|hubcloud|pixeldraw|streamwish)[^"'\\s<>]+/gi;
            const scriptMatches = embedHtml.match(scriptRegex);
            if (scriptMatches) {
                for (const link of scriptMatches) {
                    if (!this._isTutorialLink(link)) return link;
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Checks if a URL is a direct video provider link.
     */
    _isDirectVideoLink(url) {
        if (!url) return false;
        const providers = [
            'as-cdn21.top',
            'play.zephyrflick.top',
            'vidstreaming',
            'dood',
            'stream',
            'vidmoly',
            'gdmirrorbot',
            'short.icu',
            'hubcloud',
            'pixeldrain',
            'streamwish'
        ];
        return providers.some(p => url.toLowerCase().includes(p.toLowerCase()));
    }

    /**
     * Helper to detect tutorial or ad-skip tutorial links
     */
    _isTutorialLink(url) {
        if (!url) return false;
        const tutorialPatterns = [
            'youtube.com/embed/53ga7MRcQGg',
            'youtube.com/embed/JLD8SyY3o6Q',
            'youtube.com/embed/NNrCwPAj1IY',
            'youtube.com/embed/xV5Wm7qixyQ',
            'youtube.com/embed/KOWcj7XKnfQ', // Main "How to Watch" tutorial
            //'vimeo.com', // Removed as some animes use Vimeo for episodes
            '1122154449', // Specific Vimeo placeholder/trailer appearing on multiple pages
            'youtube.com/embed/watch',
            'how to watch',
            'tutorial',
            'skip-ad'
        ];

        const isTutorial = tutorialPatterns.some(p => url.toLowerCase().includes(p.toLowerCase()));

        // Additional check: on AnimeDekho, YouTube embeds are almost always tutorials
        if (!isTutorial && (url.includes('youtube.com/embed/') || url.includes('youtu.be/'))) {
            return true;
        }

        return isTutorial;
    }

    /**
     * Get all anime from the site by scraping homepage and category pages.
     */
    /**
     * Import anime directly to database
     */
    async importToDb(slugOrUrl) {
        try {
            const details = await this.getAnimeDetails(slugOrUrl);
            if (!details.title) return { success: false, error: 'Title not found' };

            const db = await getPool();

            // Clean up titles by removing common prefix/suffix words
            const cleanTitle = details.title.replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '').replace(/\s+/g, ' ').trim();

            // 1. Insert Anime
            await db.execute(
                'INSERT IGNORE INTO anime (title, description, poster_url, type) VALUES (?, ?, ?, ?)',
                [cleanTitle, details.description, details.poster, details.type]
            );

            // Get the ID (whether newly inserted or existing)
            const [animeRows] = await db.execute('SELECT id FROM anime WHERE title = ?', [cleanTitle]);
            const animeId = animeRows[0].id;

            if (details.type === 'movie') {
                const episodes = await this.getEpisodes(details.slug);
                const ep = episodes[0];
                if (ep) {
                    const link = await this.getEpisodeLink(ep.episodeId);

                    if (!link || this._isTutorialLink(link)) {
                        console.error(`  SKIPPED: No valid video link found for ${cleanTitle}`);
                        return { success: false, error: 'No valid video link found' };
                    }

                    // Purge existing movie entry to force update
                    await db.execute(
                        'DELETE FROM episodes WHERE anime_id = ? AND season_id IS NULL',
                        [animeId]
                    );

                    await db.execute(
                        `INSERT INTO episodes (anime_id, season_id, title, dood_id, ep_order) 
                         VALUES (?, NULL, 'Watch Full Movie', ?, 1)`,
                        [animeId, link]
                    );
                }
            } else {
                let globalEpCount = 1;
                for (const season of details.seasons) {
                    // 2. Insert Season
                    await db.execute(
                        'INSERT IGNORE INTO seasons (anime_id, title, season_number) VALUES (?, ?, ?)',
                        [animeId, season.title, season.seasonNumber]
                    );

                    const [seasonRows] = await db.execute(
                        'SELECT id FROM seasons WHERE anime_id = ? AND season_number = ?',
                        [animeId, season.seasonNumber]
                    );
                    const seasonId = seasonRows[0].id;

                    // 3. Purge existing episodes for Season to force update
                    await db.execute(
                        'DELETE FROM episodes WHERE anime_id = ? AND season_id = ?',
                        [animeId, seasonId]
                    );

                    const allEpisodes = await this.getEpisodes(season.slug);
                    const seasonEpisodes = allEpisodes.filter(e => e.season === season.seasonNumber);

                    for (const ep of seasonEpisodes) {
                        const link = await this.getEpisodeLink(ep.episodeId);
                        if (link && !link.includes('/epi/')) {
                            await db.execute(
                                'INSERT INTO episodes (anime_id, season_id, title, dood_id, ep_order) VALUES (?, ?, ?, ?, ?)',
                                [animeId, seasonId, ep.title || `Episode ${ep.number}`, link, globalEpCount]
                            );
                            console.error(`  Added S${season.seasonNumber}E${ep.number}: ${link}`);
                        }
                        globalEpCount++;
                        await sleep(200);
                    }
                }
            }
            return { success: true, title: details.title };
        } catch (e) {
            console.error('Import error:', e);
            return { success: false, error: e.message || String(e) };
        }
    }

    /**
     * Get all anime from the site by scraping homepage and category pages.
     */
    async getAllAnime() {
        const allAnime = [];
        const seenSlugs = new Set();

        const categories = [
            { name: 'Home', path: '/home/', paginated: false },
            { name: 'Anime', path: '/category/anime/', paginated: true },
            { name: 'Hindi Dub', path: '/category/hindi-dub/', paginated: true },
            { name: 'Tamil', path: '/category/tamil/', paginated: true },
            { name: 'Action', path: '/category/action/', paginated: true },
        ];

        for (const cat of categories) {
            console.error(`--- Scraping Category: ${cat.name} ---`);
            let page = 1;
            let hasMore = true;
            let catTotal = 0;

            while (hasMore) {
                try {
                    const pagePath = (page === 1) ? cat.path : `${cat.path}page/${page}/`;
                    const html = await fetchHTML(`${SITE_BASE}${pagePath}`);
                    const results = this._parseAnimeList(html);

                    if (results.length === 0) {
                        hasMore = false;
                        continue;
                    }

                    let newInPage = 0;
                    for (const anime of results) {
                        if (!seenSlugs.has(anime.slug)) {
                            seenSlugs.add(anime.slug);
                            allAnime.push(anime);
                            newInPage++;
                            catTotal++;
                        }
                    }

                    console.error(`  Page ${page}: Found ${results.length} anime (${newInPage} new)`);

                    // Stop if no NEW animes found on this page (safety) or if category isn't paginated
                    if (newInPage === 0 || !cat.paginated || page >= 50) {
                        hasMore = false;
                    } else {
                        page++;
                        await sleep(300);
                    }
                } catch (e) {
                    console.error(`  Error on ${cat.name} Page ${page}: ${e.message}`);
                    hasMore = false;
                }
            }
            console.error(`Scraped ${cat.name} totally: ${catTotal} new anime added`);
        }

        console.error(`\nTotal unique anime found: ${allAnime.length}`);
        return allAnime;
    }
}

// ─── Export Function ───────────────────────────────────────────────────────────

async function exportAnime(importer, queryOrSlug) {
    let slug = queryOrSlug;

    if (!queryOrSlug.startsWith('http') && !queryOrSlug.includes('-') && queryOrSlug.includes(' ')) {
        console.error(`Searching for: ${queryOrSlug}`);
        const results = await importer.search(queryOrSlug);
        if (results.length === 0) {
            console.error('No results found.');
            return;
        }
        const seriesResult = results.find(r => r.type === 'series') || results[0];
        slug = seriesResult.slug;
        console.error(`Found: ${seriesResult.title} (${slug})`);
    } else if (queryOrSlug.startsWith('http')) {
        slug = queryOrSlug.replace(/^https?:\/\/[^/]+\/serie\//, '').replace(/\/$/, '');
    }

    console.error('Fetching anime details...');
    const details = await importer.getAnimeDetails(slug);

    if (!details.title) {
        console.error('ERROR: Could not extract anime title.');
        return;
    }

    const type = details.type;
    const cleanTitle = details.title.replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '').replace(/\s+/g, ' ').trim();

    console.error(`Title: ${cleanTitle}`);
    console.error(`Type: ${type}`);
    console.error(`Seasons: ${details.seasons.length}`);
    console.error(`Poster: ${details.poster}`);

    process.stdout.write(`-- START ${cleanTitle} --\n`);
    process.stdout.write(`SET NAMES utf8mb4;\n`);
    process.stdout.write(`SET CHARACTER SET utf8mb4;\n\n`);
    process.stdout.write(`-- Ensure anime exists without duplicates (using WHERE NOT EXISTS for safety)\n`);
    process.stdout.write(`INSERT INTO anime (title, description, poster_url, type)\n`);
    process.stdout.write(`SELECT '${sqlEscape(cleanTitle)}', '${sqlEscape(details.description)}', '${sqlEscape(details.poster)}', '${type}'\n`);
    process.stdout.write(`FROM (SELECT 1) AS tmp\n`);
    process.stdout.write(`WHERE NOT EXISTS (SELECT 1 FROM anime WHERE title = '${sqlEscape(cleanTitle)}');\n\n`);

    if (type === 'movie') {
        console.error('Fetching movie episodes...');
        const episodes = await importer.getEpisodes(slug);
        const ep = episodes[0];
        const link = ep ? await importer.getEpisodeLink(ep.episodeId) : null;

        if (!link) {
            console.error('  SKIPPED: No video link found for movie.');
            return;
        }

        if (importer._isTutorialLink(link)) {
            console.error(`  SKIPPED: Movie is tutorial link only (${link})`);
            return;
        }

        console.error(`  Movie link: ${link}`);

        process.stdout.write(`-- Purge existing movie entry to force update\n`);
        process.stdout.write(`DELETE FROM episodes WHERE anime_id = (SELECT id FROM anime WHERE title = '${sqlEscape(cleanTitle)}' LIMIT 1) AND season_id IS NULL;\n`);

        process.stdout.write(`-- Insert movie episode if not exists:\n`);
        process.stdout.write(`INSERT IGNORE INTO episodes (anime_id, season_id, title, dood_id, ep_order)\n`);
        process.stdout.write(`SELECT a.id, NULL, 'Watch Full Movie', '${sqlEscape(link)}', 1\n`);
        process.stdout.write(`FROM anime a WHERE a.title = '${sqlEscape(cleanTitle)}';\n`);
    } else {
        let globalEpNumber = 1;

        for (const season of details.seasons) {
            console.error(`Fetching Season ${season.seasonNumber} episodes...`);
            const allEpisodes = await importer.getEpisodes(season.slug);
            const episodes = allEpisodes.filter(ep => ep.season === season.seasonNumber);
            console.error(`  Found ${episodes.length} episodes`);

            if (episodes.length === 0) {
                console.error(`  SKIPPED: No episodes found for Season ${season.seasonNumber}`);
                continue;
            }

            let validEpisodes = [];
            for (const ep of episodes) {
                await sleep(500);
                const link = await importer.getEpisodeLink(ep.episodeId);

                if (!link) {
                    console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: No video link found`);
                    continue;
                }

                if (importer._isTutorialLink(link)) {
                    console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: Tutorial link only (${link})`);
                    continue;
                }

                if (link && link.includes('/epi/') && !link.includes('cdn') && !link.includes('embed') && !link.includes('video')) {
                    console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: Invalid link (${link})`);
                    continue;
                }

                console.error(`    -> S${season.seasonNumber}E${ep.number}: ${link}`);
                validEpisodes.push({ ...ep, link });
            }

            if (validEpisodes.length === 0) {
                console.error(`  SKIPPED Season ${season.seasonNumber}: No valid video links`);
                continue;
            }

            process.stdout.write(`\n-- Season ${season.seasonNumber}\n`);
            process.stdout.write(`-- Ensure season exists without duplicates\n`);
            process.stdout.write(`INSERT INTO seasons (anime_id, title, season_number)\n`);
            process.stdout.write(`SELECT id, '${sqlEscape(season.title)}', ${season.seasonNumber}\n`);
            process.stdout.write(`FROM anime a WHERE a.title = '${sqlEscape(cleanTitle)}'\n`);
            process.stdout.write(`AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.anime_id = a.id AND s.season_number = ${season.seasonNumber});\n\n`);

            // Get Season ID for deletion query
            process.stdout.write(`SET @season_id = (SELECT id FROM seasons WHERE anime_id = (SELECT id FROM anime WHERE title = '${sqlEscape(cleanTitle)}' LIMIT 1) AND season_number = ${season.seasonNumber} LIMIT 1);\n`);

            // Purge episodes for this season to force update
            process.stdout.write(`-- Purge existing episodes for Season ${season.seasonNumber} to force update\n`);
            process.stdout.write(`DELETE FROM episodes WHERE season_id = @season_id;\n`);

            for (let i = 0; i < validEpisodes.length; i++) {
                const ep = validEpisodes[i];
                process.stdout.write(`INSERT IGNORE INTO episodes (anime_id, season_id, title, dood_id, ep_order)\n`);
                process.stdout.write(`SELECT\n`);
                process.stdout.write(`  a.id AS anime_id,\n`);
                process.stdout.write(`  @season_id AS season_id,\n`);
                process.stdout.write(`  '${sqlEscape(ep.title)}' AS title,\n`);
                process.stdout.write(`  '${sqlEscape(ep.link)}' AS dood_id,\n`);
                process.stdout.write(`  ${globalEpNumber} AS ep_order\n`);
                process.stdout.write(`FROM anime a\n`);
                process.stdout.write(`WHERE a.title = '${sqlEscape(cleanTitle)}';\n`);

                globalEpNumber++;
            }
        }
    }

    process.stdout.write(`-- END ${cleanTitle} --\n\n`);
    console.error(`Done: ${cleanTitle}`);
}

// ─── Bulk Export Function ──────────────────────────────────────────────────────

async function bulkExportAnime(importer, maxAnime = 50) {
    console.error('=== BULK EXPORT MODE ===');
    console.error('Fetching all available anime from animedekho.app...\n');

    const allAnime = await importer.getAllAnime();
    console.error(`Found ${allAnime.length} unique anime\n`);

    const toExport = maxAnime === 0 ? allAnime : allAnime.slice(0, maxAnime);
    console.error(`Will export ${toExport.length} anime ${maxAnime === 0 ? '(all)' : `(limited to ${maxAnime})`}\n`);

    process.stdout.write(`-- BULK ANIME EXPORT FROM ANIMEDEKHO.APP\n`);
    process.stdout.write(`-- Generated: ${new Date().toISOString()}\n`);
    process.stdout.write(`-- Total Anime: ${toExport.length}\n\n`);
    process.stdout.write(`SET NAMES utf8mb4;\n`);
    process.stdout.write(`SET CHARACTER SET utf8mb4;\n`);
    process.stdout.write(`SET FOREIGN_KEY_CHECKS = 0;\n\n`);

    let animeCount = 0;
    let totalEpisodes = 0;

    for (const anime of toExport) {
        try {
            console.error(`[${++animeCount}/${toExport.length}] Exporting: ${anime.title}`);

            const details = await importer.getAnimeDetails(anime.slug);
            if (!details.title) {
                console.error(`  SKIPPED: Could not extract title`);
                continue;
            }

            const cleanTitle = details.title.replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '').replace(/\s+/g, ' ').trim();

            process.stdout.write(`\n-- === ${cleanTitle} ===\n`);
            process.stdout.write(`-- Ensure anime exists without duplicates (using WHERE NOT EXISTS for safety)\n`);
            process.stdout.write(`INSERT INTO anime (title, description, poster_url, type)\n`);
            process.stdout.write(`SELECT '${sqlEscape(cleanTitle)}', '${sqlEscape(details.description)}', '${sqlEscape(details.poster)}', '${details.type}'\n`);
            process.stdout.write(`FROM (SELECT 1) AS tmp\n`);
            process.stdout.write(`WHERE NOT EXISTS (SELECT 1 FROM anime WHERE title = '${sqlEscape(cleanTitle)}');\n`);

            if (details.type === 'movie') {
                const episodes = await importer.getEpisodes(anime.slug);
                const ep = episodes[0];
                const link = ep ? await importer.getEpisodeLink(ep.episodeId) : null;

                if (!link) {
                    console.error(`  SKIPPED: No video link found for ${cleanTitle}`);
                    continue;
                }

                if (importer._isTutorialLink(link)) {
                    console.error(`  SKIPPED: Tutorial link found for ${cleanTitle}`);
                    continue;
                }

                process.stdout.write(`-- Purge existing movie entry to force update\n`);
                process.stdout.write(`DELETE FROM episodes WHERE anime_id = (SELECT id FROM anime WHERE title = '${sqlEscape(cleanTitle)}' LIMIT 1) AND season_id IS NULL;\n`);

                process.stdout.write(`INSERT IGNORE INTO episodes (anime_id, season_id, title, dood_id, ep_order)\n`);
                process.stdout.write(`SELECT a.id, NULL, 'Watch Full Movie', '${sqlEscape(link)}', 1\n`);
                process.stdout.write(`FROM anime a WHERE a.title = '${sqlEscape(cleanTitle)}';\n`);
                totalEpisodes++;
            } else {
                let globalEpNumber = 1;

                for (const season of details.seasons) {
                    process.stdout.write(`\n-- Season ${season.seasonNumber}\n`);
                    process.stdout.write(`-- Ensure season exists without duplicates\n`);
                    process.stdout.write(`INSERT INTO seasons (anime_id, title, season_number)\n`);
                    process.stdout.write(`SELECT id, '${sqlEscape(season.title)}', ${season.seasonNumber}\n`);
                    process.stdout.write(`FROM anime a WHERE a.title = '${sqlEscape(cleanTitle)}'\n`);
                    process.stdout.write(`AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.anime_id = a.id AND s.season_number = ${season.seasonNumber});\n`);

                    // Get Season ID for deletion query
                    process.stdout.write(`SET @season_id = (SELECT id FROM seasons WHERE anime_id = (SELECT id FROM anime WHERE title = '${sqlEscape(cleanTitle)}' LIMIT 1) AND season_number = ${season.seasonNumber} LIMIT 1);\n`);

                    const allEpisodes = await importer.getEpisodes(season.slug);
                    const episodes = allEpisodes.filter(ep => ep.season === season.seasonNumber);

                    if (episodes.length === 0) {
                        console.error(`  SKIPPED Season ${season.seasonNumber}: No episodes`);
                        continue;
                    }

                    // Purge episodes for this season to force update
                    process.stdout.write(`-- Purge existing episodes for Season ${season.seasonNumber} to force update\n`);
                    process.stdout.write(`DELETE FROM episodes WHERE season_id = @season_id;\n`);

                    for (const ep of episodes) {
                        await sleep(300);
                        const link = await importer.getEpisodeLink(ep.episodeId);

                        if (!link) {
                            console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: No video link found`);
                            continue;
                        }

                        if (importer._isTutorialLink(link)) {
                            console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: Tutorial link only (${link})`);
                            continue;
                        }

                        if (link && link.includes('/epi/') && !link.includes('cdn') && !link.includes('embed') && !link.includes('video')) {
                            console.error(`    SKIPPED S${season.seasonNumber}E${ep.number}: Invalid link (${link})`);
                            continue;
                        }

                        const epTitle = ep.title || `Episode ${ep.number}`;

                        // Output to stderr so user sees progress
                        console.error(`    -> S${season.seasonNumber}E${ep.number}: ${link}`);

                        process.stdout.write(`INSERT IGNORE INTO episodes (anime_id, season_id, title, dood_id, ep_order)\n`);
                        process.stdout.write(`SELECT\n`);
                        process.stdout.write(`  a.id AS anime_id,\n`);
                        process.stdout.write(`  @season_id AS season_id,\n`);
                        process.stdout.write(`  '${sqlEscape(epTitle)}' AS title,\n`);
                        process.stdout.write(`  '${sqlEscape(link)}' AS dood_id,\n`);
                        process.stdout.write(`  ${globalEpNumber} AS ep_order\n`);
                        process.stdout.write(`FROM anime a\n`);
                        process.stdout.write(`WHERE a.title = '${sqlEscape(cleanTitle)}';\n`);

                        globalEpNumber++;
                        totalEpisodes++;
                    }
                }
            }

            console.error(`  ✓ Exported`);
            await sleep(1000);

        } catch (e) {
            console.error(`  ✗ Error: ${e.message}`);
        }
    }

    process.stdout.write(`\nSET FOREIGN_KEY_CHECKS = 1;\n`);
    process.stdout.write(`-- BULK EXPORT COMPLETE --\n`);
    process.stdout.write(`-- Total Anime: ${animeCount}\n`);
    process.stdout.write(`-- Total Episodes: ${totalEpisodes}\n`);

    console.error(`\n=== BULK EXPORT COMPLETE ===`);
    console.error(`Anime: ${animeCount}`);
    console.error(`Episodes: ${totalEpisodes}`);
}

if (require.main === module) {
    const importer = new AnimeDekhoImporter();
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    (async () => {
        switch (command) {
            case 'search': {
                const query = args.slice(1).join(' ');
                if (!query) { console.log('Usage: node animedekho_importer.js search <query>'); break; }
                const results = await importer.search(query);
                if (results.length === 0) {
                    console.log('No results found.');
                } else {
                    results.forEach(r => console.log(`[${r.type}] ${r.title} | ${r.slug}`));
                }
                break;
            }

            case 'db-import': {
                const query = args.slice(1).join(' ');
                if (!query) { console.log('Usage: node animedekho_importer.js db-import <title or slug>'); break; }
                const result = await importer.importToDb(query);
                if (result.success) {
                    console.log(`Successfully imported: ${result.title}`);
                } else {
                    console.log(`Failed: ${result.error}`);
                }
                process.exit(0);
                break;
            }

            case 'db-export': {
                const query = args.slice(1).join(' ');
                if (!query) { console.log('Usage: node animedekho_importer.js db-export <title or slug>'); break; }
                await exportAnime(importer, query);
                break;
            }

            case 'bulk-export': {
                const limit = args[1] !== undefined ? parseInt(args[1]) : 50;
                await bulkExportAnime(importer, limit);
                break;
            }

            case 'debug-episodes': {
                const slug = args[1];
                if (!slug) { console.log('Usage: node animedekho_importer.js debug-episodes <slug>'); break; }
                const episodes = await importer.getEpisodes(slug);
                if (episodes.length === 0) {
                    console.log('No episodes found.');
                } else {
                    episodes.forEach(ep => console.log(`[S${ep.season}E${ep.number}] ${ep.title} | ID: ${ep.episodeId}`));
                }
                break;
            }

            case 'get-link': {
                const epId = args[1];
                if (!epId) { console.log('Usage: node animedekho_importer.js get-link <episodeId>'); break; }
                console.log(`Fetching link for ${epId}...`);
                const link = await importer.getEpisodeLink(epId);
                console.log(`Link: ${link}`);
                break;
            }

            case 'schedule': {
                const schedule = await importer.getSchedule();
                console.log(schedule);
                process.exit(0);
                break;
            }

            case 'schedule': {
                const schedule = await importer.getSchedule();
                console.log(schedule);
                process.exit(0);
                break;
            }

            default:
                console.log(`
AnimeDekho.app Importer (HTML Scraper version)
==============================================
Commands:
  search <query>             Search for anime by title
  debug-episodes <slug>      List all episodes with IDs
  db-export <title|slug>     Export a single anime to SQL
  bulk-export [limit]        Export all available anime (default: 50, use 0 for all)

Examples:
  node animedekho_importer.js search "Naruto"
  node animedekho_importer.js debug-episodes "naruto-shippuden-hindi-tamil-telugu"
  node animedekho_importer.js db-export "Naruto Shippuden" > naruto.sql
  node animedekho_importer.js bulk-export 0 > all_anime.sql
`);
        }
    })().catch(e => console.error('Fatal error:', e));
}

module.exports = { AnimeDekhoImporter, exportAnime, bulkExportAnime };
