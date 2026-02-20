const fs = require('fs');
const https = require('https');
const { chromium } = require('playwright');
const { AnimeDekhoImporter } = require('./importer.js');

const JIKAN_API = 'https://api.jikan.moe/v4/schedules';

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function runAutoScrape() {
    console.log('--- Daily Auto-Scraper (Jikan + Playwright) Started ---');

    // 1. Get Schedule from Jikan (Free MAL API - Never blocked)
    console.log('Fetching today\'s airing anime from Jikan API...');
    let todaysAnime = [];
    try {
        const fullDate = new Date();
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const dayName = days[fullDate.getDay()];

        const response = await fetchJSON(`${JIKAN_API}?filter=${dayName}`);
        todaysAnime = response.data.map(item => ({
            title: item.title_english || item.title,
            original: item.title
        }));

        console.log(`Successfully fetched ${todaysAnime.length} airing shows for ${dayName}.`);
    } catch (e) {
        console.error('❌ Failed to fetch from Jikan API:', e.message);
        process.exit(1);
    }

    if (todaysAnime.length === 0) {
        console.log('Nothing airing today.');
        return;
    }

    // 2. Setup Steathy Browser for Search
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const importer = new AnimeDekhoImporter();

    // 3. Scrape each one
    let consolidatedSQL = `-- Automated Export: ${new Date().toISOString()}\n\n`;
    let successCount = 0;

    for (let i = 0; i < Math.min(todaysAnime.length, 20); i++) { // Limit to 20 to avoid long runs
        const anime = todaysAnime[i];
        console.log(`[${i + 1}/${todaysAnime.length}] Searching for "${anime.title}"...`);

        try {
            // Test if search page is blocked
            const searchUrl = `https://animedekho.app/?s=${encodeURIComponent(anime.title)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            // Wait for Cloudflare
            await page.waitForTimeout(5000);
            const title = await page.title();

            if (title.includes('Attention Required')) {
                console.log(`⚠️ Search blocked for "${anime.title}". Trying original title...`);
                await page.goto(`https://animedekho.app/?s=${encodeURIComponent(anime.original)}`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(5000);
            }

            const html = await page.content();

            // Use importer to parse the search results from the browser HTML
            // We'll modify importer logic slightly or just parse manually here
            const linkMatch = html.match(/href="https:\/\/animedekho\.app\/serie\/([^\/]+)\/"/i);

            if (linkMatch) {
                const slug = linkMatch[1];
                console.log(`✅ Found: ${slug}. Extracting data...`);

                // Go to details page
                await page.goto(`https://animedekho.app/serie/${slug}/`, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(3000);

                const detailsHtml = await page.content();
                const descMatch = detailsHtml.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
                const posterMatch = detailsHtml.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);

                const desc = descMatch ? descMatch[1] : 'No description';
                const poster = posterMatch ? posterMatch[1] : '';

                consolidatedSQL += `-- Data for ${anime.title}\n`;
                consolidatedSQL += `INSERT IGNORE INTO anime (title, description, poster_url, type) VALUES ('${anime.title.replace(/'/g, "''")}', '${desc.replace(/'/g, "''")}', '${poster}', 'series');\n\n`;
                successCount++;
            } else {
                console.log(`❌ Not found on AnimeDekho.`);
            }
        } catch (e) {
            console.error(`Error processing ${anime.title}: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Save
    const fileName = `daily_export_${new Date().toISOString().split('T')[0]}.sql`;
    fs.writeFileSync(fileName, consolidatedSQL);
    console.log(`\n--- Done! Successfully scraped ${successCount} shows. Generated ${fileName} ---`);

    await browser.close();
}

runAutoScrape().catch(console.error);
