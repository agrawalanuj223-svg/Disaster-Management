# Smart Disaster Management & Early Warning System - India (Flask)

## Run
    pip install -r requirements.txt
    python app.py
Browser opens at http://127.0.0.1:5000 (internet required for live data + map tiles).

## Live data (free, no API key)
- USGS Earthquake API  - India region, last 7 days, every 2 min
- Open-Meteo Forecast  - weather + today's rain, 39 cities, every 15 min
- Open-Meteo Air Quality - US AQI / PM2.5, every 30 min

## Architecture
Monitor threads -> data_queue -> AlertProcessor thread -> SQLite + rules + alerts_log.csv
-> Flask REST API (/api/state ...) -> browser polls every 10 s.

## Files created at run time
disaster_system.db, disaster_system.log, alerts_log.csv, sos_log.csv

## Notes
- SOS is a demo: it records the request, raises a CRITICAL alert on the dashboard and
  gives call / WhatsApp-share buttons. It does NOT contact real responders.
- Always start with `python app.py` (not `flask run`) so the background threads start once.
