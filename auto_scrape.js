const https = require('https');
const fs = require('fs');
const path = require('path');
const { AnimeDekhoImporter } = require('./importer.js');

const SITE_BASE = 'https://animedekho.app';

async function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://animedekho.app/'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function runAutoScrape() {
    console.log('--- Daily Auto-Scraper Started ---');
    const importer = new AnimeDekhoImporter();
    let schedule = [];

    // 1. Get Schedule
    console.log('Fetching schedule...');
    try {
        const html = await fetchHTML(`${SITE_BASE}/home/`);
        const match = html.match(/const scheduleData = (\[[\s\S]*?\]);/);

        if (!match) {
            console.error('❌ Could not find schedule data script in HTML.');
            console.log('--- HTML DEBUG (First 500 chars) ---');
            console.log(html.substring(0, 500));
            console.log('------------------------------------');
            process.exit(1);
        }

        // Use a more flexible parser for JS objects
        try {
            schedule = new Function(`return ${match[1]}`)();
        } catch (e) {
            console.error('❌ Failed to parse schedule data logic:', e.message);
            process.exit(1);
        }
    } catch (e) {
        console.error('❌ Error fetching schedule:', e.message);
        process.exit(1);
    }

    // 2. Identify Today's Anime
    const now = new Date();
    const dayIndex = (now.getDay() + 6) % 7;
    const todaysAnime = schedule[dayIndex] || [];

    console.log(`Today is Day ${dayIndex}. Found ${todaysAnime.length} anime on schedule.`);

    if (todaysAnime.length === 0) {
        console.log('Nothing to scrape today.');
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
}

runAutoScrape().catch(console.error);
