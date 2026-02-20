const https = require('https');
const fs = require('fs');
const path = require('path');
const { AnimeDekhoImporter } = require('./importer.js');

const SITE_BASE = 'https://animedekho.app';

async function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
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

    // 1. Get Schedule
    console.log('Fetching schedule...');
    const html = await fetchHTML(`${SITE_BASE}/home/`);
    const match = html.match(/const scheduleData = (\[[\s\S]*?\]);/);

    if (!match) {
        console.error('Could not find schedule data.');
        process.exit(1);
    }

    const schedule = JSON.parse(match[1]);

    // 2. Identify Today's Anime
    // Day index: Sunday=0, Monday=1, ..., Saturday=6
    // Schedule usually starts with Monday (index 0 in array)
    // Adjusting to local date to find the correct day in the array
    const now = new Date();
    // In the dashboard we use (day + 6) % 7 because Sunday is 6 in that system.
    // Let's match the logic from index.html: const day = (new Date().getDay() + 6) % 7;
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

        // Fuzzy search loop (reduced version of the one in server.js)
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
                // We need to capture the output of importer logic
                // Since importer.js is designed for CLI/Stdout, we'll mock stdout temporarily or wrap it.
                // For simplicity in this script, we'll just manually call the detail/episode methods
                // and build a basic SQL string.

                const details = await importer.getAnimeDetails(bestMatch.url);
                consolidatedSQL += `-- Data for ${details.title}\n`;
                consolidatedSQL += `INSERT IGNORE INTO anime (title, description, poster_url, type) VALUES ('${details.title.replace(/'/g, "''")}', '${details.description.replace(/'/g, "''")}', '${details.poster}', '${details.type}');\n\n`;

                // Add episodes logic if needed, but for a 11:50 PM scrape, 
                // generating the basic SQL is the priority.

                console.log(`✨ Scraped ${details.title} successfully.`);
            } catch (e) {
                console.error(`Error scraping ${originalTitle}: ${e.message}`);
            }
        } else {
            console.log(`⚠️ No match found for "${originalTitle}". skipping.`);
        }

        // Wait to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));
    }

    // 4. Save to file
    const dateStr = now.toISOString().split('T')[0];
    const fileName = `daily_export_${dateStr}.sql`;
    fs.writeFileSync(fileName, consolidatedSQL);
    console.log(`--- Done! Generated ${fileName} ---`);
}

runAutoScrape().catch(console.error);
