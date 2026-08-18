const fs = require('fs');
const https = require('https');

const MONITORED_COUNTRIES = ['Philippines', 'Guatemala', 'Colombia'];
const HISTORY_RETENTION_DAYS = 90;

const MONITORED_CITIES = [
  { name: 'Manila', country: 'Philippines', lat: 14.5995, lon: 120.9842 },
  { name: 'Guatemala City', country: 'Guatemala', lat: 14.6349, lon: -90.5069 },
];

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

async function fetchCityWeather(city) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m&daily=weather_code,precipitation_sum,rain_sum,precipitation_probability_max&timezone=auto`;
  try {
    const data = JSON.parse(await fetch(url));
    return { city, data };
  } catch (err) {
    console.error(`Error fetching weather for ${city.name}:`, err.message);
    return { city, data: null };
  }
}

function parseWeatherCode(code) {
  const codes = {
    0: { desc: 'Clear sky', severity: null },
    1: { desc: 'Mainly clear', severity: null },
    2: { desc: 'Partly cloudy', severity: null },
    3: { desc: 'Overcast', severity: null },
    45: { desc: 'Fog', severity: 'Moderate' },
    48: { desc: 'Depositing rime fog', severity: 'Moderate' },
    51: { desc: 'Light drizzle', severity: null },
    53: { desc: 'Moderate drizzle', severity: null },
    55: { desc: 'Dense drizzle', severity: 'Moderate' },
    61: { desc: 'Slight rain', severity: null },
    63: { desc: 'Moderate rain', severity: 'Moderate' },
    65: { desc: 'Heavy rain', severity: 'Severe' },
    80: { desc: 'Slight rain showers', severity: null },
    81: { desc: 'Moderate rain showers', severity: 'Moderate' },
    82: { desc: 'Violent rain showers', severity: 'Severe' },
    95: { desc: 'Thunderstorm', severity: 'Severe' },
    96: { desc: 'Thunderstorm with slight hail', severity: 'Severe' },
    99: { desc: 'Thunderstorm with heavy hail', severity: 'Extreme' },
  };
  return codes[code] || { desc: 'Unknown', severity: null };
}

function generateCityAlerts(cityWeatherResults) {
  const cityAlerts = {};
  for (const { city, data } of cityWeatherResults) {
    if (!data || !data.current) continue;
    const alerts = [];
    const current = data.current;
    const daily = data.daily;
    const weatherInfo = parseWeatherCode(current.weather_code);
    const currentRain = current.rain || 0;
    const todayPrecip = daily && daily.precipitation_sum ? daily.precipitation_sum[0] : 0;

    let shouldAlert = false;
    let severity = 'Moderate';
    let eventType = 'Weather Advisory';
    let headline = '';
    let description = '';

    if (currentRain > 0 || [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(current.weather_code)) {
      shouldAlert = true;
      if (todayPrecip >= 30 || currentRain >= 5 || [65, 82, 95, 96, 99].includes(current.weather_code)) {
        severity = 'Severe';
        eventType = 'Heavy Rain Alert';
        headline = `Heavy rainfall in ${city.name}`;
      } else if (todayPrecip >= 50 || currentRain >= 15) {
        severity = 'Extreme';
        eventType = 'Flood Risk Alert';
        headline = `Extreme rainfall and flood risk in ${city.name}`;
      } else {
        eventType = 'Rain Advisory';
        headline = `${weatherInfo.desc} in ${city.name}`;
      }
      description = `Current conditions: ${weatherInfo.desc}. `;
      if (currentRain > 0) description += `Current rainfall rate: ${currentRain}mm. `;
      if (todayPrecip > 0) description += `Today's expected total: ${todayPrecip}mm. `;
    }

    if ([95, 96, 99].includes(current.weather_code)) {
      shouldAlert = true;
      severity = current.weather_code === 99 ? 'Extreme' : 'Severe';
      eventType = 'Thunderstorm Alert';
      headline = `Thunderstorm activity in ${city.name}`;
      description = `Active thunderstorm conditions. ${weatherInfo.desc}. `;
    }

    if (shouldAlert) {
      description += `Temperature: ${current.temperature_2m}°C, Humidity: ${current.relative_humidity_2m}%, Wind: ${current.wind_speed_10m} km/h.`;
      alerts.push({
        event: eventType,
        severity,
        urgency: severity === 'Extreme' ? 'Immediate' : severity === 'Severe' ? 'Expected' : 'Future',
        headline,
        description,
        source: 'Open-Meteo',
        link: 'https://open-meteo.com/',
        publishedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        cityLevel: true,
      });
    }

    if (daily && daily.precipitation_probability_max) {
      for (let i = 1; i < Math.min(7, daily.precipitation_probability_max.length); i++) {
        const prob = daily.precipitation_probability_max[i];
        const precip = daily.precipitation_sum[i];
        if (prob >= 70 && precip >= 15) {
          const date = new Date(daily.time[i]);
          const dayName = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
          alerts.push({
            event: precip >= 30 ? 'Heavy Rain Forecast' : 'Rain Forecast',
            severity: precip >= 50 ? 'Severe' : 'Moderate',
            urgency: 'Future',
            headline: `${precip >= 30 ? 'Heavy rain' : 'Rain'} expected in ${city.name} on ${dayName}`,
            description: `${precip.toFixed(1)}mm of precipitation forecast with ${prob}% probability.`,
            source: 'Open-Meteo',
            link: 'https://open-meteo.com/',
            publishedAt: new Date().toISOString(),
            fetchedAt: new Date().toISOString(),
            cityLevel: true,
          });
          break;
        }
      }
    }
    if (alerts.length > 0) cityAlerts[city.name] = alerts;
  }
  return cityAlerts;
}

async function main() {
  console.log('Fetching GDACS alerts...');

  try {
    const xml = await fetch('https://www.gdacs.org/xml/rss.xml');
    const alerts = parseGDACS(xml);

    console.log('\nFetching city-level weather...');
    const cityWeatherResults = await Promise.all(MONITORED_CITIES.map(fetchCityWeather));
    const cityAlerts = generateCityAlerts(cityWeatherResults);

    for (const [cityName, cityAlertList] of Object.entries(cityAlerts)) {
      console.log(`  ${cityName}: ${cityAlertList.length} alert(s)`);
      for (const a of cityAlertList) {
        console.log(`    - ${a.event} (${a.severity})`);
      }
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      alerts,
      cityAlerts,
    };

    fs.writeFileSync('alerts.json', JSON.stringify(output, null, 2));
    console.log('\nAlerts written to alerts.json');
    console.log('Countries with alerts:', Object.keys(alerts));
    for (const [country, countryAlerts] of Object.entries(alerts)) {
      console.log(`  ${country}: ${countryAlerts.length} alert(s)`);
      for (const a of countryAlerts) {
        console.log(`    - ${a.event} (${a.severity})`);
      }
    }

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
