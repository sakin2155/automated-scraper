const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AnimeDekhoImporter } = require('./importer.js');

const SITE_BASE = 'https://animedekho.app';

async function runAutoScrape() {
    console.log('--- Daily Auto-Scraper (Playwright) Started ---');

    // Launch browser to bypass Cloudflare "Just a moment"
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const importer = new AnimeDekhoImporter();
    let schedule = [];

    // 1. Get Schedule
    console.log('Fetching schedule via Playwright...');
    try {
        await page.goto(`${SITE_BASE}/home/`, { waitUntil: 'networkidle', timeout: 60000 });

        // Wait for the variable to be available or the script to load
        const html = await page.content();
        const match = html.match(/const scheduleData = (\[[\s\S]*?\]);/);

        if (!match) {
            console.error('❌ Could not find schedule data script in HTML.');
            // Diagnostic check: is there a Cloudflare title?
            const title = await page.title();
            console.log('Current Page Title:', title);
            if (title.includes('Just a moment')) {
                console.log('⚠️ Still stuck on Cloudflare challenge. Need a manual solution or more stealth.');
            }
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
        console.error('❌ Error fetching schedule:', e.message);
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
