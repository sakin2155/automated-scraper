const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AnimeDekhoImporter } = require('./importer.js');

const SITE_BASE = 'https://animedekho.app';

async function runAutoScrape() {
    console.log('--- Daily Auto-Scraper (Stealth Browser) Started ---');

    const browser = await chromium.launch({ headless: true });
    // Use a very high-quality user agent and specific viewport to look more human
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    const importer = new AnimeDekhoImporter();
    let schedule = [];

    console.log('Fetching schedule via Stealth Playwright...');
    try {
        // Go to the page - Cloudflare often waits for 5 seconds
        await page.goto(`${SITE_BASE}/home/`, { waitUntil: 'domcontentloaded', timeout: 90000 });

        console.log('Waiting for Cloudflare challenge to resolve (15s)...');
        await page.waitForTimeout(15000);

        // Get HTML and check if blocked
        let html = await page.content();
        let title = await page.title();

        if (title.includes('Just a moment') || title.includes('Attention Required')) {
            console.log('⚠️ Detected Cloudflare block. Retrying with a reload...');
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(10000);
            html = await page.content();
            title = await page.title();
        }

        console.log('Current Page Title:', title);

        const match = html.match(/const scheduleData = (\[[\s\S]*?\]);/);

        if (!match) {
            console.error('❌ Could not find schedule data script in HTML.');
            console.log('--- HTML DEBUG (First 500 chars) ---');
            console.log(html.substring(0, 500));
            console.log('------------------------------------');
            await browser.close();
            process.exit(1);
        }

        try {
            schedule = new Function(`return ${match[1]}`)();
        } catch (e) {
            console.error('❌ Failed to parse schedule data logic:', e.message);
            await browser.close();
            process.exit(1);
        }
    } catch (e) {
        console.error('❌ Error during browser navigation:', e.message);
        await browser.close();
        process.exit(1);
    }

    // 2. Identify Today's Anime
    const now = new Date();
    const dayIndex = (now.getDay() + 6) % 7;
    const todaysAnime = schedule[dayIndex] || [];

    console.log(`Today is Day ${dayIndex}. Found ${todaysAnime.length} anime on schedule.`);

    if (todaysAnime.length === 0) {
        console.log('Nothing to scrape today.');
        await browser.close();
        return;
    }

    // 3. Scrape each one
    let consolidatedSQL = `-- Automated Export: ${now.toISOString()}\n\n`;

    for (let i = 0; i < todaysAnime.length; i++) {
        const item = todaysAnime[i];
        const originalTitle = item.title;
        let currentTitle = originalTitle;
        let bestMatch = null;

        console.log(`[${i + 1}/${todaysAnime.length}] Searching: "${originalTitle}"...`);

        while (currentTitle.length > 2) {
            const results = await importer.search(currentTitle);
            if (results.length > 0) {
                bestMatch = results[0];
                break;
            }
            currentTitle = currentTitle.slice(0, -1).trim();
        }

        if (bestMatch) {
            console.log(`✅ Found Match: ${bestMatch.title}. Extracting...`);
            try {
                const details = await importer.getAnimeDetails(bestMatch.url);
                consolidatedSQL += `-- Data for ${details.title}\n`;
                consolidatedSQL += `INSERT IGNORE INTO anime (title, description, poster_url, type) VALUES ('${details.title.replace(/'/g, "''")}', '${details.description.replace(/'/g, "''")}', '${details.poster}', '${details.type}');\n\n`;
                console.log(`✨ Scraped ${details.title} successfully.`);
            } catch (e) {
                console.error(`Error scraping ${originalTitle}: ${e.message}`);
            }
        } else {
            console.log(`⚠️ No match found for "${originalTitle}". skipping.`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Save to file
    const dateStr = now.toISOString().split('T')[0];
    const fileName = `daily_export_${dateStr}.sql`;
    fs.writeFileSync(fileName, consolidatedSQL);
    console.log(`--- Done! Generated ${fileName} ---`);

    await browser.close();
}

runAutoScrape().catch(console.error);
