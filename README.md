# Weather Alerts Feed

Automated feed of international weather alerts for workforce impact monitoring.

## How it works

A GitHub Action runs every 15 minutes to:
1. Fetch alerts from GDACS (Global Disaster Alert and Coordination System)
2. Filter for monitored countries (Philippines, Guatemala, Colombia)
3. Update `alerts.json` with current alerts

## Usage

Access the live alerts JSON at:
```
https://YOUR_USERNAME.github.io/weather-alerts-feed/alerts.json
```

## Monitored Alert Types

- Typhoons / Tropical Cyclones (NW Pacific region)
- Floods
- Earthquakes
- Volcanic Activity

## Severity Mapping

| GDACS Level | Dashboard Severity |
|-------------|-------------------|
| Red | Extreme |
| Orange | Severe |
| Green | Moderate |

## Manual Trigger

You can manually trigger an update from the Actions tab in GitHub.
