const fs = require('fs');
const { chromium } = require('playwright');

const SITE_BASE = 'https://animedekho.app';

async function runBulkScrape() {
    console.log('--- Daily Auto-Scraper (V4: BULK MODE) Started ---');

    // 1. Setup Browser
    console.log('Step 1: Launching Stealth Browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // 2. Identify Slugs to Scrape
    console.log('Step 2: Crawling categories for unique anime slugs...');
    const categories = [
        { name: 'Latest Additions', path: '/home/' },
        { name: 'Action', path: '/category/action/' },
        { name: 'Anime', path: '/category/anime/' },
        { name: 'Hindi Dub', path: '/category/hindi-dub/' },
    ];

    const seenSlugs = new Set();
    const finalSlugs = [];

    for (const cat of categories) {
        console.log(`   📂 Crawling category: ${cat.name}...`);
        try {
            await page.goto(`${SITE_BASE}${cat.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(6000);

            const html = await page.content();
            // Regex for /serie/slug/ and /movies/slug/
            const matches = html.matchAll(/href="([^"]*\/(serie|movies)\/([^\/"]+)\/)"/gi);

            for (const match of matches) {
                const url = match[1];
                const type = match[2];
                const slug = match[3];

                if (!seenSlugs.has(slug)) {
                    seenSlugs.add(slug);
                    finalSlugs.push({ slug, type, url: url.startsWith('http') ? url : `${SITE_BASE}${url}` });
                }
            }
        } catch (e) {
            console.error(`   ⚠️ Error crawling ${cat.name}: ${e.message}`);
        }
    }

    console.log(`✅ Identified ${finalSlugs.length} unique anime to process.`);

    // 3. Scrape Details for each
    let consolidatedSQL = `-- Automated Bulk Export: ${new Date().toISOString()}\n`;
    consolidatedSQL += `SET NAMES utf8mb4;\n\n`;

    let successCount = 0;
    // Limit to 100 per run to avoid GitHub timeout (6h)
    const limit = 100;
    const toProcess = finalSlugs.slice(0, limit);

    console.log(`\nStep 3: Scraping details for ${toProcess.length} anime...`);

    for (let i = 0; i < toProcess.length; i++) {
        const item = toProcess[i];
        console.log(`[${i + 1}/${toProcess.length}] Processing: ${item.slug}`);

        try {
            await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(4000);

            const html = await page.content();

            // Extract Info
            const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
            const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
            const posterMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);

            let title = ogTitleMatch ? ogTitleMatch[1].split('|')[0].trim() : item.slug;
            // Clean title
            title = title
                .replace(/\s*[-|]\s*(?:Watch|Free|Streaming|Anime|Online|ToonStream|Episode|Hindi Dubbed|All Season Episodes).*$/i, '')
                .replace(/Watch\s+Online\s+/i, '')
                .replace(/\s+/g, ' ')
                .trim();

            const desc = descMatch ? descMatch[1].replace(/'/g, "''") : 'No description found.';
            const poster = posterMatch ? posterMatch[1] : '';
            const type = item.type === 'movies' ? 'movie' : 'series';

            consolidatedSQL += `-- Entry for ${title}\n`;
            consolidatedSQL += `INSERT IGNORE INTO anime (title, description, poster_url, type) \n`;
            consolidatedSQL += `SELECT '${title.replace(/'/g, "''")}', '${desc}', '${poster}', '${type}'\n`;
            consolidatedSQL += `FROM (SELECT 1) AS tmp\n`;
            consolidatedSQL += `WHERE NOT EXISTS (SELECT 1 FROM anime WHERE title = '${title.replace(/'/g, "''")}');\n\n`;

            successCount++;
            console.log(`   ✨ Saved: ${title}`);

        } catch (e) {
            console.error(`   ❌ Error on ${item.slug}: ${e.message}`);
            if (e.message.includes('closed')) {
                console.log('   🔄 Re-creating page context...');
                // Simplified recovery
                break;
            }
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Finalize
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `bulk_export_${dateStr}.sql`;
    fs.writeFileSync(fileName, consolidatedSQL);

    console.log(`\n--- Final Report ---`);
    console.log(`Total Scraped: ${successCount}/${toProcess.length}`);
    console.log(`Generated: ${fileName}`);
    console.log(`--------------------\n`);

    await browser.close();
}

runBulkScrape().catch(console.error);
