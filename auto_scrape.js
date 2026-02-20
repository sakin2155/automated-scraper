const fs = require('fs');
const https = require('https');
const { chromium } = require('playwright');

const JIKAN_API = 'https://api.jikan.moe/v4/schedules';

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${data.substring(0, 100)}`));
                }
            });
        }).on('error', reject);
    });
}

async function runAutoScrape() {
    console.log('--- Daily Auto-Scraper (Ultimate Stealth) Started ---');

    // 1. Get Schedule from Jikan
    const fullDate = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = days[fullDate.getDay()];
    console.log(`Step 1: Fetching ${dayName} schedule from Jikan API...`);

    let todaysAnime = [];
    try {
        const response = await fetchJSON(`${JIKAN_API}?filter=${dayName}`);
        if (!response.data) throw new Error('No data field in Jikan response');

        todaysAnime = response.data.map(item => ({
            title: item.title_english || item.title,
            original: item.title
        }));

        console.log(`✅ Found ${todaysAnime.length} shows airing today.`);
    } catch (e) {
        console.error('❌ Failed to fetch from Jikan API:', e.message);
        process.exit(1);
    }

    // 2. Setup Stealth Browser
    console.log('\nStep 2: Launching Stealth Browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    // 3. Scrape each one
    let consolidatedSQL = `-- Automated Export: ${new Date().toISOString()}\n\n`;
    let successCount = 0;

    console.log('\nStep 3: Searching AnimeDekho for matches...');
    const targetShows = todaysAnime.slice(0, 20); // First 20 shows

    for (let i = 0; i < targetShows.length; i++) {
        const anime = targetShows[i];
        console.log(`\n[${i + 1}/${targetShows.length}] Processing: "${anime.title}"`);

        try {
            // Remove colons/special chars for better search results
            const cleanTitle = anime.title.replace(/[:]/g, '').trim();
            const searchUrl = `https://animedekho.app/?s=${encodeURIComponent(cleanTitle)}`;

            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(6000);

            let html = await page.content();
            let pageTitle = await page.title();

            // Flexible match for both series and movies, handles full and relative URLs
            // Matches: /serie/[slug]/, /movies/[slug]/, https://.../serie/[slug]/
            const linkMatch = html.match(/href="([^"]*\/(serie|movies)\/([^\/"]+)\/)"/i);

            if (linkMatch) {
                let animeUrl = linkMatch[1];
                const type = linkMatch[2]; // 'serie' or 'movies'
                const slug = linkMatch[3];

                // Ensure absolute URL
                if (!animeUrl.startsWith('http')) {
                    animeUrl = `https://animedekho.app${animeUrl.startsWith('/') ? '' : '/'}${animeUrl}`;
                }

                console.log(`   ✅ Match Found! Category: ${type}, Slug: ${slug}`);

                await page.goto(animeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(4000);

                const detailsHtml = await page.content();

                // Extract Info
                const ogTitleMatch = detailsHtml.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
                const descMatch = detailsHtml.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
                const posterMatch = detailsHtml.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);

                const finalTitle = ogTitleMatch ? ogTitleMatch[1].split('|')[0].trim() : anime.title;
                const desc = descMatch ? descMatch[1] : 'No description found.';
                const poster = posterMatch ? posterMatch[1] : '';

                consolidatedSQL += `-- Data for ${finalTitle}\n`;
                consolidatedSQL += `INSERT IGNORE INTO anime (title, description, poster_url, type) VALUES ('${finalTitle.replace(/'/g, "''")}', '${desc.replace(/'/g, "''")}', '${poster}', '${type === 'movies' ? 'movie' : 'series'}');\n\n`;
                successCount++;
                console.log(`   ✨ Saved SQL entry for ${finalTitle}`);
            } else {
                console.log(`   ❌ No match found on AnimeDekho.`);
            }
        } catch (e) {
            console.error(`   ❌ Error: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Finalizing
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `daily_export_${dateStr}.sql`;
    fs.writeFileSync(fileName, consolidatedSQL);

    console.log(`\n--- Summary ---`);
    console.log(`Scraped ${successCount}/${targetShows.length} shows.`);
    console.log(`File: ${fileName}`);
    console.log(`--------------------\n`);

    await browser.close();
}

runAutoScrape().catch(console.error);
