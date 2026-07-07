const fs = require('fs');
const https = require('https');

const MONITORED_COUNTRIES = ['Philippines', 'Guatemala', 'Colombia'];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WeatherAlertsFeed/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseGDACS(xml) {
  const alerts = {};

  // Simple XML parsing without dependencies
  const items = xml.split('<item>').slice(1);

  for (const item of items) {
    const getTag = (tag) => {
      const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return match ? match[1].trim() : '';
    };

    const title = getTag('title');
    const description = getTag('description');
    const country = getTag('gdacs:country');
    const alertLevel = getTag('gdacs:alertlevel') ||
      (title.startsWith('Red ') ? 'Red' : title.startsWith('Orange ') ? 'Orange' : 'Green');

    // Check if affects monitored countries
    let affectedCountry = null;
    for (const c of MONITORED_COUNTRIES) {
      if (country.toLowerCase().includes(c.toLowerCase()) ||
          title.toLowerCase().includes(c.toLowerCase()) ||
          description.toLowerCase().includes(c.toLowerCase())) {
        affectedCountry = c;
        break;
      }
    }

    // NW Pacific tropical systems affect Philippines
    if (!affectedCountry) {
      const isNWPacific = title.includes('NWPacific') || description.includes('NWPacific');
      const isTropical = /typhoon|tropical|hurricane/i.test(title);
      const isSevere = alertLevel === 'Red' || alertLevel === 'Orange';

      if (isNWPacific && isTropical && isSevere) {
        affectedCountry = 'Philippines';
      }
    }

    if (!affectedCountry) continue;

    // Determine event type
    let eventType = 'Weather Alert';
    const titleLower = title.toLowerCase();
    if (/typhoon|hurricane|tropical cyclone|tropical storm/i.test(title)) {
      const nameMatch = title.match(/(?:cyclone|storm)\s+([A-Z0-9-]+)/i);
      eventType = nameMatch ? `Typhoon ${nameMatch[1]}` : 'Tropical Cyclone';
    } else if (titleLower.includes('flood')) {
      eventType = 'Flood Alert';
    } else if (titleLower.includes('earthquake')) {
      eventType = 'Earthquake';
    } else if (titleLower.includes('volcano')) {
      eventType = 'Volcanic Activity';
    }

    // Map severity
    let severity = 'Moderate';
    if (alertLevel === 'Red') severity = 'Extreme';
    else if (alertLevel === 'Orange') severity = 'Severe';

    // Check wind speed for super typhoon classification
    const windMatch = description.match(/(\d+)\s*km\/h/);
    const windSpeed = windMatch ? parseInt(windMatch[1]) : null;
    if (windSpeed && windSpeed >= 240) {
      severity = 'Extreme';
      if (eventType.includes('Typhoon') || eventType.includes('Cyclone')) {
        eventType = 'Super ' + eventType;
      }
    }

    if (!alerts[affectedCountry]) alerts[affectedCountry] = [];

    // Avoid duplicates
    if (!alerts[affectedCountry].some(a => a.headline === title)) {
      alerts[affectedCountry].push({
        event: eventType,
        severity,
        urgency: severity === 'Extreme' ? 'Immediate' : severity === 'Severe' ? 'Expected' : 'Future',
        headline: title,
        description: description.substring(0, 300).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
        source: 'GDACS',
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  // Sort by severity
  const sevOrder = { Extreme: 0, Severe: 1, Moderate: 2 };
  for (const c of Object.keys(alerts)) {
    alerts[c].sort((a, b) => (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3));
  }

  return alerts;
}

async function main() {
  console.log('Fetching GDACS alerts...');

  try {
    const xml = await fetch('https://www.gdacs.org/xml/rss.xml');
    const alerts = parseGDACS(xml);

    const output = {
      lastUpdated: new Date().toISOString(),
      alerts,
    };

    fs.writeFileSync('alerts.json', JSON.stringify(output, null, 2));
    console.log('Alerts written to alerts.json');
    console.log('Countries with alerts:', Object.keys(alerts));
    for (const [country, countryAlerts] of Object.entries(alerts)) {
      console.log(`  ${country}: ${countryAlerts.length} alert(s)`);
      for (const a of countryAlerts) {
        console.log(`    - ${a.event} (${a.severity})`);
      }
    }
  } catch (err) {
    console.error('Error fetching alerts:', err);
    process.exit(1);
  }
}

main();
