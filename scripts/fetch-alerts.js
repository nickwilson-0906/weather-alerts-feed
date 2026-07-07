const fs = require('fs');
const https = require('https');

const MONITORED_COUNTRIES = ['Philippines', 'Guatemala', 'Colombia'];
const HISTORY_RETENTION_DAYS = 90;

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
    const pubDate = getTag('pubDate');
    const link = getTag('link');

    let affectedCountry = null;
    for (const c of MONITORED_COUNTRIES) {
      if (country.toLowerCase().includes(c.toLowerCase()) ||
          title.toLowerCase().includes(c.toLowerCase()) ||
          description.toLowerCase().includes(c.toLowerCase())) {
        affectedCountry = c;
        break;
      }
    }

    if (!affectedCountry) {
      const isNWPacific = title.includes('NWPacific') || description.includes('NWPacific');
      const isTropical = /typhoon|tropical|hurricane/i.test(title);
      const isSevere = alertLevel === 'Red' || alertLevel === 'Orange';

      if (isNWPacific && isTropical && isSevere) {
        affectedCountry = 'Philippines';
      }
    }

    if (!affectedCountry) continue;

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

    let severity = 'Moderate';
    if (alertLevel === 'Red') severity = 'Extreme';
    else if (alertLevel === 'Orange') severity = 'Severe';

    const windMatch = description.match(/(\d+)\s*km\/h/);
    const windSpeed = windMatch ? parseInt(windMatch[1]) : null;
    if (windSpeed && windSpeed >= 240) {
      severity = 'Extreme';
      if (eventType.includes('Typhoon') || eventType.includes('Cyclone')) {
        eventType = 'Super ' + eventType;
      }
    }

    if (!alerts[affectedCountry]) alerts[affectedCountry] = [];

    if (!alerts[affectedCountry].some(a => a.headline === title)) {
      alerts[affectedCountry].push({
        event: eventType,
        severity,
        urgency: severity === 'Extreme' ? 'Immediate' : severity === 'Severe' ? 'Expected' : 'Future',
        headline: title,
        description: description.substring(0, 300).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
        source: 'GDACS',
        link: link || null,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  const sevOrder = { Extreme: 0, Severe: 1, Moderate: 2 };
  for (const c of Object.keys(alerts)) {
    alerts[c].sort((a, b) => (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3));
  }

  return alerts;
}

function loadHistory() {
  try {
    if (fs.existsSync('history.json')) {
      return JSON.parse(fs.readFileSync('history.json', 'utf8'));
    }
  } catch (err) {
    console.error('Error loading history:', err.message);
  }
  return { events: [] };
}

function saveHistory(history) {
  fs.writeFileSync('history.json', JSON.stringify(history, null, 2));
}

function generateEventId(event, country) {
  const base = `${country}:${event.event}:${event.headline}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
  return base.substring(0, 100);
}

function updateHistory(history, currentAlerts) {
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Create a map of existing events by ID for quick lookup
  const existingEvents = new Map();
  for (const event of history.events) {
    existingEvents.set(event.id, event);
  }

  // Process current alerts
  for (const [country, alerts] of Object.entries(currentAlerts)) {
    for (const alert of alerts) {
      const eventId = generateEventId(alert, country);

      if (existingEvents.has(eventId)) {
        // Update existing event
        const existing = existingEvents.get(eventId);
        existing.lastSeen = now.toISOString();
        existing.currentSeverity = alert.severity;
        existing.active = true;
      } else {
        // Add new event
        const newEvent = {
          id: eventId,
          country,
          event: alert.event,
          severity: alert.severity,
          currentSeverity: alert.severity,
          urgency: alert.urgency,
          headline: alert.headline,
          description: alert.description,
          source: alert.source,
          link: alert.link,
          publishedAt: alert.publishedAt,
          firstSeen: now.toISOString(),
          lastSeen: now.toISOString(),
          active: true,
        };
        existingEvents.set(eventId, newEvent);
      }
    }
  }

  // Mark events no longer in current alerts as inactive
  const currentEventIds = new Set();
  for (const [country, alerts] of Object.entries(currentAlerts)) {
    for (const alert of alerts) {
      currentEventIds.add(generateEventId(alert, country));
    }
  }

  for (const event of existingEvents.values()) {
    if (!currentEventIds.has(event.id) && event.active) {
      event.active = false;
      event.endedAt = now.toISOString();
    }
  }

  // Filter out events older than retention period
  const filteredEvents = Array.from(existingEvents.values()).filter(event => {
    const lastSeenDate = new Date(event.lastSeen);
    return lastSeenDate >= cutoffDate;
  });

  // Sort by lastSeen descending
  filteredEvents.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

  return {
    lastUpdated: now.toISOString(),
    retentionDays: HISTORY_RETENTION_DAYS,
    totalEvents: filteredEvents.length,
    activeEvents: filteredEvents.filter(e => e.active).length,
    events: filteredEvents,
  };
}

async function main() {
  console.log('Fetching GDACS alerts...');

  try {
    const xml = await fetch('https://www.gdacs.org/xml/rss.xml');
    const alerts = parseGDACS(xml);

    // Save current alerts
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

    // Update history
    console.log('\nUpdating history...');
    const history = loadHistory();
    const updatedHistory = updateHistory(history, alerts);
    saveHistory(updatedHistory);
    console.log(`History updated: ${updatedHistory.totalEvents} total events, ${updatedHistory.activeEvents} active`);

  } catch (err) {
    console.error('Error fetching alerts:', err);
    process.exit(1);
  }
}

main();
