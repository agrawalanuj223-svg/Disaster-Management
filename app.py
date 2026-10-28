"""
Smart Disaster Management & Early Warning System - INDIA (Flask Web App)
=======================================================================
Advanced Python Mini Project

Topics covered: Advanced Python, Multithreading, OOP, Exception Handling,
API Integration, SQLite Database, Real-Time Data Processing, Automated Alerts,
File Handling, Logging, Queue Management  (+ Flask web frontend instead of Tkinter)

Live data (all FREE, no API key):
  * USGS Earthquake API   -> earthquakes in the India region (last 7 days)
  * Open-Meteo Forecast   -> weather + today's rain for 39 Indian cities
  * Open-Meteo Air Quality-> US AQI / PM2.5 for the same cities

Data flow:
  Monitor threads (producers) --data_queue--> AlertProcessor thread (consumer)
        -> SQLite + alert rules + CSV file  <-- Flask REST API <-- Browser (polls)

Run:  pip install -r requirements.txt   then   python app.py
"""

import csv
import io
import json
import logging
import math
import os
import queue
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler

from flask import Flask, Response, jsonify, render_template, request

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "disaster_system.db")
LOG_PATH = os.path.join(BASE_DIR, "disaster_system.log")
ALERT_FILE = os.path.join(BASE_DIR, "alerts_log.csv")
SOS_FILE = os.path.join(BASE_DIR, "sos_log.csv")

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "5000"))

QUAKE_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
INDIA_BOX = {"minlatitude": 5.0, "maxlatitude": 38.0, "minlongitude": 66.0, "maxlongitude": 99.0}

QUAKE_INTERVAL = 120      # seconds
WEATHER_INTERVAL = 900    # 15 min (Open-Meteo "current" data refreshes every 15 min)
AIR_INTERVAL = 1800       # 30 min
ALERT_COOLDOWN = 10800    # same city+category alert repeats only after 3 hours
DEFAULT_QUAKE_THRESHOLD = 4.0

# (city, state/UT, latitude, longitude)
CITIES = [
    ("Delhi", "Delhi", 28.6139, 77.2090), ("Mumbai", "Maharashtra", 19.0760, 72.8777),
    ("Kolkata", "West Bengal", 22.5726, 88.3639), ("Chennai", "Tamil Nadu", 13.0827, 80.2707),
    ("Bengaluru", "Karnataka", 12.9716, 77.5946), ("Hyderabad", "Telangana", 17.3850, 78.4867),
    ("Ahmedabad", "Gujarat", 23.0225, 72.5714), ("Surat", "Gujarat", 21.1702, 72.8311),
    ("Pune", "Maharashtra", 18.5204, 73.8567), ("Nagpur", "Maharashtra", 21.1458, 79.0882),
    ("Jaipur", "Rajasthan", 26.9124, 75.7873), ("Lucknow", "Uttar Pradesh", 26.8467, 80.9462),
    ("Varanasi", "Uttar Pradesh", 25.3176, 82.9739), ("Patna", "Bihar", 25.5941, 85.1376),
    ("Bhopal", "Madhya Pradesh", 23.2599, 77.4126), ("Indore", "Madhya Pradesh", 22.7196, 75.8577),
    ("Chandigarh", "Chandigarh", 30.7333, 76.7794), ("Dehradun", "Uttarakhand", 30.3165, 78.0322),
    ("Shimla", "Himachal Pradesh", 31.1048, 77.1734), ("Srinagar", "Jammu & Kashmir", 34.0837, 74.7973),
    ("Leh", "Ladakh", 34.1526, 77.5771), ("Guwahati", "Assam", 26.1445, 91.7362),
    ("Imphal", "Manipur", 24.8170, 93.9368), ("Shillong", "Meghalaya", 25.5788, 91.8933),
    ("Itanagar", "Arunachal Pradesh", 27.0844, 93.6053), ("Gangtok", "Sikkim", 27.3389, 88.6065),
    ("Aizawl", "Mizoram", 23.7271, 92.7176), ("Kohima", "Nagaland", 25.6751, 94.1086),
    ("Agartala", "Tripura", 23.8315, 91.2868), ("Bhubaneswar", "Odisha", 20.2961, 85.8245),
    ("Ranchi", "Jharkhand", 23.3441, 85.3096), ("Raipur", "Chhattisgarh", 21.2514, 81.6296),
    ("Visakhapatnam", "Andhra Pradesh", 17.6868, 83.2185), ("Thiruvananthapuram", "Kerala", 8.5241, 76.9366),
    ("Kochi", "Kerala", 9.9312, 76.2673), ("Panaji", "Goa", 15.4909, 73.8278),
    ("Puducherry", "Puducherry", 11.9416, 79.8083), ("Port Blair", "Andaman & Nicobar", 11.6234, 92.7265),
    ("Kavaratti", "Lakshadweep", 10.5667, 72.6417),
]

WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers", 85: "Snow showers",
    86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
}

SOS_TYPES = ["Medical Emergency", "Fire", "Flood / Water Rescue", "Earthquake / Building Collapse",
             "Cyclone / Storm", "Road Accident", "Landslide", "Women Safety", "Other"]

SEV_RANK = {"NORMAL": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}
RANK_NAME = {v: k for k, v in SEV_RANK.items()}


# --------------------------------------------------------------------------
# Logging (Logging + File Handling)
# --------------------------------------------------------------------------
def setup_logging():
    logger = logging.getLogger("DisasterSystem")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s | %(levelname)-8s | %(threadName)-26s | %(message)s")
    try:
        fh = RotatingFileHandler(LOG_PATH, maxBytes=500_000, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except OSError as exc:
        print(f"Warning: cannot open log file: {exc}")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    return logger


log = setup_logging()


# --------------------------------------------------------------------------
# Exceptions (Exception Handling)
# --------------------------------------------------------------------------
class DisasterSystemError(Exception):
    """Base class for application errors."""


class ApiError(DisasterSystemError):
    """External API unreachable or returned bad data."""


class DatabaseError(DisasterSystemError):
    """SQLite failure."""


# --------------------------------------------------------------------------
# Helpers + data models (OOP)
# --------------------------------------------------------------------------
@dataclass
class Earthquake:
    quake_id: str
    magnitude: float
    place: str
    time_ms: int
    lat: float
    lon: float
    depth_km: float
    url: str


@dataclass
class Alert:
    created_ts: float
    category: str
    severity: str
    message: str
    source: str
    lat: float = None
    lon: float = None


def describe_weather(code):
    try:
        return WEATHER_CODES.get(int(code), f"Code {code}")
    except (TypeError, ValueError):
        return "Unknown"


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def nearest_city(lat, lon):
    """Return (city, state, distance_km) of the closest monitored city."""
    return min(((c[0], c[1], haversine_km(lat, lon, c[2], c[3])) for c in CITIES), key=lambda x: x[2])


def num(value):
    """Convert API value to float or None (APIs sometimes return null)."""
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def csv_safe(value):
    """Prevent CSV/Excel formula injection in exported files."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def fmt_ts(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


# --------------------------------------------------------------------------
# Thread-safe shared objects
# --------------------------------------------------------------------------
class Settings:
    def __init__(self):
        self._lock = threading.Lock()
        self._quake_threshold = DEFAULT_QUAKE_THRESHOLD

    @property
    def quake_threshold(self):
        with self._lock:
            return self._quake_threshold

    @quake_threshold.setter
    def quake_threshold(self, value):
        with self._lock:
            self._quake_threshold = float(value)


class StatusBoard:
    """Live health of every data feed (written by threads, read by the API)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._data = {}

    def set(self, name, text, ok):
        with self._lock:
            self._data[name] = {"text": text, "ok": ok, "ts": time.time()}

    def snapshot(self):
        with self._lock:
            return {k: dict(v) for k, v in self._data.items()}


class RateLimiter:
    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self._hits = {}
        self._lock = threading.Lock()

    def allow(self, key):
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return False
            hits.append(now)
            self._hits[key] = hits
            return True


class CsvLogger:
    """Appends rows to a CSV file safely from many threads (File Handling)."""

    def __init__(self, path, header):
        self.path, self.header = path, header
        self._lock = threading.Lock()

    def append(self, row):
        try:
            with self._lock:
                is_new = not os.path.exists(self.path) or os.path.getsize(self.path) == 0
                with open(self.path, "a", newline="", encoding="utf-8") as fh:
                    writer = csv.writer(fh)
                    if is_new:
                        writer.writerow(self.header)
                    writer.writerow([csv_safe(v) for v in row])
        except OSError as exc:
            log.error("Cannot write %s: %s", os.path.basename(self.path), exc)


# --------------------------------------------------------------------------
# SQLite layer
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS earthquakes (
    quake_id TEXT PRIMARY KEY, magnitude REAL NOT NULL, place TEXT, time_ms INTEGER,
    lat REAL, lon REAL, depth_km REAL, url TEXT);
CREATE TABLE IF NOT EXISTS cities (
    city TEXT PRIMARY KEY, state TEXT, lat REAL, lon REAL,
    temperature REAL, humidity REAL, wind_speed REAL, wind_gust REAL, precipitation REAL,
    rain_today REAL, weather_code INTEGER, aqi REAL, pm25 REAL, weather_ts REAL, aqi_ts REAL);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts REAL, category TEXT, severity TEXT,
    message TEXT, source TEXT, lat REAL, lon REAL);
CREATE TABLE IF NOT EXISTS sos_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts REAL, name TEXT, phone TEXT,
    emergency_type TEXT, message TEXT, lat REAL, lon REAL, status TEXT DEFAULT 'OPEN',
    token TEXT);
"""


class Database:
    def __init__(self, path):
        self._lock = threading.Lock()
        try:
            self.conn = sqlite3.connect(path, check_same_thread=False)
            self.conn.row_factory = sqlite3.Row
            with self._lock, self.conn:
                self.conn.executescript(SCHEMA)
                self.conn.executemany(
                    "INSERT OR IGNORE INTO cities (city, state, lat, lon) VALUES (?,?,?,?)", CITIES)
        except sqlite3.Error as exc:
            raise DatabaseError(f"Cannot open database: {exc}") from exc
        cutoff_ms = int((time.time() - 30 * 86400) * 1000)
        self._run("DELETE FROM earthquakes WHERE time_ms < ?", (cutoff_ms,))

    def _run(self, sql, params=(), fetch=False):
        try:
            with self._lock:
                with self.conn:
                    cur = self.conn.execute(sql, params)
                    if fetch:
                        return [dict(r) for r in cur.fetchall()]
                    return cur.lastrowid if sql.lstrip().upper().startswith("INSERT INTO") else cur.rowcount
        except sqlite3.Error as exc:
            log.error("Database error: %s", exc)
            raise DatabaseError(str(exc)) from exc

    # ---- earthquakes
    def save_earthquake(self, q):
        """Insert quake; returns True only when it is NEW. Magnitude revisions are updated."""
        new = self._run(
            "INSERT OR IGNORE INTO earthquakes (quake_id, magnitude, place, time_ms, lat, lon, depth_km, url)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (q.quake_id, q.magnitude, q.place, q.time_ms, q.lat, q.lon, q.depth_km, q.url)) == 1
        if not new:
            self._run("UPDATE earthquakes SET magnitude=?, place=? WHERE quake_id=?",
                      (q.magnitude, q.place, q.quake_id))
        return new

    def recent_quakes(self, limit=300):
        return self._run("SELECT * FROM earthquakes ORDER BY time_ms DESC LIMIT ?", (limit,), fetch=True)

    # ---- cities
    def update_weather(self, u):
        self._run(
            "UPDATE cities SET temperature=?, humidity=?, wind_speed=?, wind_gust=?, precipitation=?,"
            " rain_today=?, weather_code=?, weather_ts=? WHERE city=?",
            (u["temperature"], u["humidity"], u["wind_speed"], u["wind_gust"], u["precipitation"],
             u["rain_today"], u["weather_code"], u["ts"], u["city"]))

    def update_air(self, u):
        self._run("UPDATE cities SET aqi=?, pm25=?, aqi_ts=? WHERE city=?",
                  (u["aqi"], u["pm25"], u["ts"], u["city"]))

    def get_city(self, name):
        rows = self._run("SELECT * FROM cities WHERE city=?", (name,), fetch=True)
        return rows[0] if rows else None

    def all_cities(self):
        return self._run("SELECT * FROM cities ORDER BY city", fetch=True)

    # ---- alerts
    def save_alert(self, a):
        return self._run(
            "INSERT INTO alerts (created_ts, category, severity, message, source, lat, lon)"
            " VALUES (?,?,?,?,?,?,?)",
            (a.created_ts, a.category, a.severity, a.message, a.source, a.lat, a.lon))

    def recent_alerts(self, limit=150):
        return self._run("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,), fetch=True)

    def alert_breakdown(self):
        rows = self._run("SELECT severity, COUNT(*) AS n FROM alerts GROUP BY severity", fetch=True)
        result = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0}
        for r in rows:
            result[r["severity"]] = r["n"]
        return result

    # ---- SOS
    def save_sos(self, s):
        return self._run(
            "INSERT INTO sos_requests (created_ts, name, phone, emergency_type, message, lat, lon, status, token)"
            " VALUES (?,?,?,?,?,?,?, 'OPEN', ?)",
            (s["created_ts"], s["name"], s["phone"], s["emergency_type"], s["message"],
             s["lat"], s["lon"], s["token"]))

    def recent_sos(self, limit=50):
        return self._run(
            "SELECT id, created_ts, name, emergency_type, lat, lon, status FROM sos_requests"
            " ORDER BY id DESC LIMIT ?", (limit,), fetch=True)

    def resolve_sos(self, sos_id, token):
        return self._run("UPDATE sos_requests SET status='RESOLVED' WHERE id=? AND token=? AND status='OPEN'",
                         (sos_id, token))

    def counts(self):
        one = lambda sql: self._run(sql, fetch=True)[0]["v"]
        return {
            "quakes": one("SELECT COUNT(*) AS v FROM earthquakes"),
            "max_mag": one("SELECT MAX(magnitude) AS v FROM earthquakes"),
            "alerts": one("SELECT COUNT(*) AS v FROM alerts"),
            "critical": one("SELECT COUNT(*) AS v FROM alerts WHERE severity='CRITICAL'"),
            "open_sos": one("SELECT COUNT(*) AS v FROM sos_requests WHERE status='OPEN'"),
        }


# --------------------------------------------------------------------------
# API client (API Integration)
# --------------------------------------------------------------------------
class ApiClient:
    def __init__(self, retries=3, timeout=20, backoff=2):
        self.retries, self.timeout, self.backoff = retries, timeout, backoff

    def get_json(self, url, params=None):
        if params:
            url = f"{url}?{urllib.parse.urlencode(params, safe=',')}"
        request_obj = urllib.request.Request(
            url, headers={"User-Agent": "SmartDisasterEWS-India/2.0 (student project)"})
        last_error = None
        for attempt in range(1, self.retries + 1):
            try:
                with urllib.request.urlopen(request_obj, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
            except (urllib.error.URLError, OSError, ValueError) as exc:
                last_error = exc
                log.warning("API attempt %d/%d failed: %s", attempt, self.retries, exc)
                if attempt < self.retries:
                    time.sleep(self.backoff * attempt)
        raise ApiError(f"API failed after {self.retries} attempts: {last_error}")


# --------------------------------------------------------------------------
# Producer threads (Multithreading + Queue Management)
# --------------------------------------------------------------------------
class BaseMonitor(threading.Thread):
    def __init__(self, name, interval, out_queue, api, board):
        super().__init__(name=name, daemon=True)
        self.interval, self.out_queue, self.api, self.board = interval, out_queue, api, board
        self._stop_event = threading.Event()
        self._wake = threading.Event()
        board.set(name, "Starting...", True)

    def fetch(self):
        raise NotImplementedError

    def request_refresh(self):
        self._wake.set()

    def stop(self):
        self._stop_event.set()
        self._wake.set()

    def _send(self, item):
        try:
            self.out_queue.put(item, timeout=5)
        except queue.Full:
            log.warning("%s: data queue full, dropping an item", self.name)

    def run(self):
        log.info("%s started", self.name)
        while not self._stop_event.is_set():
            try:
                records = self.fetch()
                for rec in records:
                    self._send(rec)
                self.board.set(self.name, f"OK - {len(records)} records", True)
            except ApiError as exc:
                log.error("%s: %s", self.name, exc)
                self.board.set(self.name, "API unreachable - will retry", False)
            except Exception:
                log.exception("%s: unexpected error", self.name)
                self.board.set(self.name, "Internal error (see log)", False)
            self._wake.wait(self.interval)
            self._wake.clear()
        log.info("%s stopped", self.name)


class EarthquakeMonitor(BaseMonitor):
    NAME = "Earthquakes (USGS)"

    def __init__(self, out_queue, api, board):
        super().__init__(self.NAME, QUAKE_INTERVAL, out_queue, api, board)

    @staticmethod
    def parse_feature(f):
        props = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or []
        qid, mag, ts = f.get("id"), props.get("mag"), props.get("time")
        if qid is None or mag is None or ts is None or len(coords) < 2:
            return None
        depth = float(coords[2]) if len(coords) > 2 and coords[2] is not None else 0.0
        return Earthquake(str(qid), float(mag), str(props.get("place") or "Unknown location"),
                          int(ts), float(coords[1]), float(coords[0]), depth, str(props.get("url") or ""))

    def fetch(self):
        start = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
        params = {"format": "geojson", "starttime": start, "minmagnitude": 2.5,
                  "orderby": "time", "limit": 500, **INDIA_BOX}
        features = self.api.get_json(QUAKE_URL, params).get("features", [])
        if not isinstance(features, list):
            raise ApiError("Unexpected earthquake feed format")
        quakes = []
        for f in features:
            try:
                q = self.parse_feature(f)
            except (TypeError, ValueError, AttributeError, OverflowError) as exc:
                log.warning("Skipping malformed quake record: %s", exc)
                continue
            if q:
                quakes.append(q)
        quakes.sort(key=lambda q: q.time_ms)
        return [("quake", q) for q in quakes]


def _multi_location_params():
    return {"latitude": ",".join(str(c[2]) for c in CITIES),
            "longitude": ",".join(str(c[3]) for c in CITIES)}


def _as_location_list(data):
    """Open-Meteo returns a dict for 1 location and a list for several."""
    if isinstance(data, dict):
        if data.get("error"):
            raise ApiError(f"API error: {data.get('reason')}")
        data = [data]
    if not isinstance(data, list) or len(data) != len(CITIES):
        raise ApiError("Unexpected multi-location response")
    return data


class WeatherMonitor(BaseMonitor):
    NAME = "Weather (Open-Meteo)"

    def __init__(self, out_queue, api, board):
        super().__init__(self.NAME, WEATHER_INTERVAL, out_queue, api, board)

    def fetch(self):
        params = _multi_location_params()
        params.update({"current": "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,"
                                  "precipitation,weather_code",
                       "daily": "precipitation_sum", "forecast_days": 1, "timezone": "auto"})
        data = _as_location_list(self.api.get_json(WEATHER_URL, params))
        records, now = [], time.time()
        for (city, _s, _la, _lo), item in zip(CITIES, data):
            cur = item.get("current") or {}
            rain_list = (item.get("daily") or {}).get("precipitation_sum") or [None]
            if num(cur.get("temperature_2m")) is None:
                continue
            code = num(cur.get("weather_code"))
            records.append(("weather", {
                "city": city, "ts": now,
                "temperature": num(cur.get("temperature_2m")),
                "humidity": num(cur.get("relative_humidity_2m")),
                "wind_speed": num(cur.get("wind_speed_10m")),
                "wind_gust": num(cur.get("wind_gusts_10m")),
                "precipitation": num(cur.get("precipitation")),
                "rain_today": num(rain_list[0]),
                "weather_code": int(code) if code is not None else None}))
        if not records:
            raise ApiError("No weather data in response")
        return records


class AirQualityMonitor(BaseMonitor):
    NAME = "Air Quality (Open-Meteo)"

    def __init__(self, out_queue, api, board):
        super().__init__(self.NAME, AIR_INTERVAL, out_queue, api, board)

    def fetch(self):
        params = _multi_location_params()
        params.update({"current": "us_aqi,pm2_5", "timezone": "auto"})
        data = _as_location_list(self.api.get_json(AIR_URL, params))
        records, now = [], time.time()
        for (city, _s, _la, _lo), item in zip(CITIES, data):
            cur = item.get("current") or {}
            if num(cur.get("us_aqi")) is None:
                continue
            records.append(("air", {"city": city, "ts": now,
                                    "aqi": num(cur.get("us_aqi")), "pm25": num(cur.get("pm2_5"))}))
        if not records:
            raise ApiError("No air-quality data in response")
        return records


# --------------------------------------------------------------------------
# Rule engine (Automated Alerts)
# --------------------------------------------------------------------------
# (limit, severity, category, advice) - highest first, first match wins
WIND_TIERS = (
    (90, "CRITICAL", "Cyclone-Force Winds", "Stay indoors away from windows and follow official cyclone warnings."),
    (60, "HIGH", "Storm Winds", "Avoid travel and secure loose objects."),
    (40, "MEDIUM", "Strong Winds", "Be careful outdoors; watch for falling branches."))
RAIN_NOW_TIERS = (
    (20, "CRITICAL", "Extreme Rainfall (hourly)", "Flash-flood risk - move to higher ground."),
    (10, "HIGH", "Heavy Rainfall (hourly)", "Waterlogging likely; avoid low-lying areas."),
    (5, "MEDIUM", "Moderate Rainfall", "Drive carefully."))
RAIN_DAY_TIERS = (   # IMD 24-hour rainfall categories
    (204.5, "CRITICAL", "Extremely Heavy Rain Forecast", "Severe flood risk - avoid rivers, drains and underpasses."),
    (115.6, "HIGH", "Very Heavy Rain Forecast", "Flooding possible; keep an emergency kit ready."),
    (64.5, "MEDIUM", "Heavy Rain Forecast", "Expect waterlogging in low areas."))
TEMP_TIERS = (
    (47, "CRITICAL", "Extreme Heatwave", "Avoid going out; drink water and ORS frequently."),
    (44, "HIGH", "Severe Heatwave", "Limit outdoor exposure, especially 12-4 PM."),
    (40, "MEDIUM", "Heatwave Conditions", "Stay hydrated and wear light cotton clothes."))
AQI_TIERS = (
    (300, "CRITICAL", "Hazardous Air Quality", "Avoid outdoor activity; wear an N95 mask."),
    (200, "HIGH", "Very Unhealthy Air", "Children, elderly and patients should stay indoors."),
    (150, "MEDIUM", "Unhealthy Air", "Limit prolonged outdoor exertion."))


class RuleEngine:
    @staticmethod
    def quake_severity(mag):
        return "CRITICAL" if mag >= 6.0 else "HIGH" if mag >= 5.0 else "MEDIUM"

    @staticmethod
    def quake_advice(severity):
        if severity in ("CRITICAL", "HIGH"):
            return "Drop, Cover, Hold On. Expect aftershocks; stay away from damaged buildings."
        return "Light-to-moderate shaking possible near the epicentre."

    @staticmethod
    def evaluate_city(c):
        """Return [(category, severity, message)] for one city's current conditions."""
        out = []
        label = f"{c['city']}, {c['state']}"

        def first(value, tiers, fmt):
            if value is None:
                return
            for limit, sev, cat, advice in tiers:
                if value >= limit:
                    out.append((cat, sev, f"{label}: {fmt(value)}. {advice}"))
                    return

        first(c.get("wind_speed"), WIND_TIERS, lambda v: f"wind {v:.0f} km/h")
        first(c.get("precipitation"), RAIN_NOW_TIERS, lambda v: f"{v:.1f} mm rain in the last hour")
        first(c.get("rain_today"), RAIN_DAY_TIERS, lambda v: f"{v:.0f} mm rain forecast today")
        first(c.get("temperature"), TEMP_TIERS, lambda v: f"temperature {v:.1f} C")
        first(c.get("aqi"), AQI_TIERS, lambda v: f"US AQI {v:.0f}")
        temp = c.get("temperature")
        if temp is not None and temp <= -10:
            out.append(("Extreme Cold", "HIGH", f"{label}: temperature {temp:.1f} C. Risk of frostbite; stay warm."))
        if c.get("weather_code") in (95, 96, 99):
            out.append(("Thunderstorm", "HIGH", f"{label}: {describe_weather(c['weather_code'])}. "
                                                  "Stay indoors; avoid open areas and tall trees."))
        return out


# --------------------------------------------------------------------------
# Consumer thread: DB + rules + alerts
# --------------------------------------------------------------------------
class AlertProcessor(threading.Thread):
    def __init__(self, in_queue, db, settings, alert_log):
        super().__init__(name="Alert Processor", daemon=True)
        self.in_queue, self.db, self.settings, self.alert_log = in_queue, db, settings, alert_log
        self._stop_event = threading.Event()
        self._last_alert = {}

    def stop(self):
        self._stop_event.set()

    def _cooldown_ok(self, key):
        now = time.monotonic()
        last = self._last_alert.get(key)
        if last is not None and now - last < ALERT_COOLDOWN:
            return False
        self._last_alert[key] = now
        return True

    def _raise_alert(self, category, severity, message, source, lat=None, lon=None):
        alert = Alert(time.time(), category, severity, message, source, lat, lon)
        self.db.save_alert(alert)
        self.alert_log.append([fmt_ts(alert.created_ts), severity, category, source, message])
        log.warning("ALERT [%s] %s - %s", severity, category, message)

    def _handle_quake(self, q):
        if not self.db.save_earthquake(q):
            return
        city, state, km = nearest_city(q.lat, q.lon)
        if q.magnitude >= self.settings.quake_threshold and (km <= 600 or q.magnitude >= 6.0):
            sev = RuleEngine.quake_severity(q.magnitude)
            text = f"M{q.magnitude:.1f} earthquake - {q.place} (depth {q.depth_km:.0f} km)."
            if km <= 600:
                text += f" About {km:.0f} km from {city}, {state}."
            self._raise_alert("Earthquake", sev, f"{text} {RuleEngine.quake_advice(sev)}",
                              "quake", q.lat, q.lon)

    def _evaluate_city(self, name):
        city = self.db.get_city(name)
        if not city:
            return
        for category, severity, message in RuleEngine.evaluate_city(city):
            if self._cooldown_ok((name, category)):
                self._raise_alert(category, severity, message, "weather", city["lat"], city["lon"])

    def _handle_sos(self, s):
        where = "location not shared"
        if s.get("lat") is not None:
            city, state, km = nearest_city(s["lat"], s["lon"])
            where = f"near {city}, {state} (~{km:.0f} km)"
        self._raise_alert("SOS Emergency", "CRITICAL",
                          f"Emergency SOS #{s['id']} ({s['emergency_type']}) reported - {where}. "
                          "Nearby citizens: help only if it is safe; call 112.",
                          "sos", s.get("lat"), s.get("lon"))

    def run(self):
        log.info("Alert Processor started")
        while not self._stop_event.is_set():
            try:
                kind, payload = self.in_queue.get(timeout=1)
            except queue.Empty:
                continue
            try:
                if kind == "quake":
                    self._handle_quake(payload)
                elif kind == "weather":
                    self.db.update_weather(payload)
                    self._evaluate_city(payload["city"])
                elif kind == "air":
                    self.db.update_air(payload)
                    self._evaluate_city(payload["city"])
                elif kind == "sos":
                    self._handle_sos(payload)
                else:
                    log.warning("Unknown queue item: %s", kind)
            except DatabaseError:
                pass  # already logged
            except Exception:
                log.exception("Processor error while handling %s", kind)
            finally:
                self.in_queue.task_done()
        log.info("Alert Processor stopped")


# --------------------------------------------------------------------------
# Flask application
# --------------------------------------------------------------------------
app = Flask(__name__)
db = Database(DB_PATH)
settings = Settings()
board = StatusBoard()
api_client = ApiClient()
data_queue = queue.Queue(maxsize=2000)
alert_log = CsvLogger(ALERT_FILE, ["timestamp", "severity", "category", "source", "message"])
sos_log = CsvLogger(SOS_FILE, ["timestamp", "id", "name", "phone", "type", "message", "lat", "lon"])
sos_limiter = RateLimiter(limit=5, window=3600)
processor = AlertProcessor(data_queue, db, settings, alert_log)
monitors = [EarthquakeMonitor(data_queue, api_client, board),
            WeatherMonitor(data_queue, api_client, board),
            AirQualityMonitor(data_queue, api_client, board)]


def error(message, code):
    return jsonify({"ok": False, "error": message}), code


def enrich_city(c):
    issues = RuleEngine.evaluate_city(c)
    c = dict(c)
    c["risk"] = RANK_NAME[max([SEV_RANK[s] for _, s, _ in issues], default=0)]
    c["issues"] = [{"category": cat, "severity": sev, "message": msg} for cat, sev, msg in issues]
    c["condition"] = describe_weather(c["weather_code"]) if c.get("weather_code") is not None else None
    return c


def enrich_quake(q):
    q = dict(q)
    city, state, km = nearest_city(q["lat"], q["lon"])
    q["severity"] = RuleEngine.quake_severity(q["magnitude"])
    q["near_city"], q["near_state"], q["near_km"] = city, state, round(km)
    return q


def public_sos(row):
    first_name = (row["name"] or "").split(" ")[0] or "Anonymous"
    out = {"id": row["id"], "created_ts": row["created_ts"], "name": first_name,
           "emergency_type": row["emergency_type"], "status": row["status"],
           "lat": None, "lon": None, "near": None}
    if row["lat"] is not None and row["lon"] is not None:
        out["lat"], out["lon"] = round(row["lat"], 2), round(row["lon"], 2)   # ~1 km privacy blur
        city, state, _ = nearest_city(row["lat"], row["lon"])
        out["near"] = f"{city}, {state}"
    return out


def validate_sos(data):
    etype = str(data.get("emergency_type") or "").strip()
    if etype not in SOS_TYPES:
        raise ValueError("Please choose a valid emergency type.")
    name = str(data.get("name") or "").strip()[:60]
    message = str(data.get("message") or "").strip()[:300]
    phone = re.sub(r"[\s\-()]", "", str(data.get("phone") or ""))
    if phone:
        if not re.fullmatch(r"(?:\+91|91|0)?[6-9]\d{9}", phone):
            raise ValueError("Enter a valid 10-digit Indian mobile number.")
        phone = "+91" + phone[-10:]
    lat = lon = None
    if data.get("lat") not in (None, "") or data.get("lon") not in (None, ""):
        try:
            lat, lon = float(data.get("lat")), float(data.get("lon"))
        except (TypeError, ValueError):
            raise ValueError("Invalid location coordinates.") from None
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("Location coordinates are out of range.")
    if lat is None and not phone:
        raise ValueError("Share your location or a phone number so that help can reach you.")
    return {"created_ts": time.time(), "name": name, "phone": phone, "emergency_type": etype,
            "message": message, "lat": lat, "lon": lon, "token": secrets.token_hex(8)}


@app.after_request
def no_cache_api(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return render_template("index.html", sos_types=SOS_TYPES,
                           maptiler_key=os.environ.get("MAPTILER_KEY", "").strip())


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


@app.get("/api/state")
def api_state():
    try:
        counts = db.counts()
        cities = [enrich_city(c) for c in db.all_cities()]
        summary = {
            "quakes": counts["quakes"], "max_mag": counts["max_mag"], "alerts": counts["alerts"],
            "critical": counts["critical"], "open_sos": counts["open_sos"],
            "cities_total": len(cities), "cities_at_risk": sum(1 for c in cities if c["risk"] != "NORMAL"),
            "breakdown": db.alert_breakdown(), "quake_threshold": settings.quake_threshold}
        return jsonify({
            "ok": True, "server_time": time.time(), "summary": summary, "status": board.snapshot(),
            "quakes": [enrich_quake(q) for q in db.recent_quakes(300)], "cities": cities,
            "alerts": db.recent_alerts(150), "sos": [public_sos(r) for r in db.recent_sos(50)]})
    except DatabaseError:
        return error("Database error - see log file.", 500)


@app.get("/api/nearby")
def api_nearby():
    try:
        lat, lon = float(request.args["lat"]), float(request.args["lon"])
    except (KeyError, ValueError):
        return error("Valid 'lat' and 'lon' are required.", 400)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return error("Coordinates out of range.", 400)
    try:
        cities = db.all_cities()
        best = min(cities, key=lambda c: haversine_km(lat, lon, c["lat"], c["lon"]))
        city = enrich_city(best)
        city["distance_km"] = round(haversine_km(lat, lon, best["lat"], best["lon"]))
        quakes = []
        for q in db.recent_quakes(500):
            dist = haversine_km(lat, lon, q["lat"], q["lon"])
            if dist <= 1000:
                q = enrich_quake(q)
                q["distance_km"] = round(dist)
                quakes.append(q)
        quakes.sort(key=lambda q: q["distance_km"])
        return jsonify({"ok": True, "city": city, "quakes": quakes[:5]})
    except DatabaseError:
        return error("Database error - see log file.", 500)


@app.post("/api/sos")
def api_sos_create():
    if not sos_limiter.allow(request.remote_addr or "unknown"):
        return error("Too many SOS requests from this device. Please call 112 directly.", 429)
    try:
        sos = validate_sos(request.get_json(silent=True) or {})
        sos_id = db.save_sos(sos)
    except ValueError as exc:
        return error(str(exc), 400)
    except DatabaseError:
        return error("Could not save the SOS. Please call 112 directly.", 500)
    sos_log.append([fmt_ts(sos["created_ts"]), sos_id, sos["name"], sos["phone"],
                    sos["emergency_type"], sos["message"], sos["lat"], sos["lon"]])
    try:
        data_queue.put_nowait(("sos", {"id": sos_id, "emergency_type": sos["emergency_type"],
                                       "lat": sos["lat"], "lon": sos["lon"]}))
    except queue.Full:
        log.warning("Data queue full - SOS #%s saved but alert not queued", sos_id)
    log.warning("SOS #%s received (%s)", sos_id, sos["emergency_type"])
    return jsonify({"ok": True, "id": sos_id, "token": sos["token"]})


@app.post("/api/sos/<int:sos_id>/resolve")
def api_sos_resolve(sos_id):
    token = str((request.get_json(silent=True) or {}).get("token") or "")
    try:
        changed = db.resolve_sos(sos_id, token)
    except DatabaseError:
        return error("Database error - see log file.", 500)
    if not changed:
        return error("SOS not found, already resolved or token invalid.", 404)
    log.info("SOS #%s marked safe by the sender", sos_id)
    return jsonify({"ok": True})


@app.post("/api/settings")
def api_settings():
    try:
        value = float((request.get_json(silent=True) or {}).get("quake_threshold"))
    except (TypeError, ValueError):
        return error("quake_threshold must be a number.", 400)
    if not 2.5 <= value <= 9.0:
        return error("quake_threshold must be between 2.5 and 9.0.", 400)
    settings.quake_threshold = value
    log.info("Quake alert threshold set to %.1f", value)
    return jsonify({"ok": True, "quake_threshold": value})


@app.post("/api/refresh")
def api_refresh():
    for m in monitors:
        m.request_refresh()
    return jsonify({"ok": True})


@app.get("/api/export/alerts.csv")
def api_export_alerts():
    try:
        rows = db.recent_alerts(100000)
    except DatabaseError:
        return error("Database error - see log file.", 500)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["timestamp", "severity", "category", "source", "message"])
    for r in rows:
        writer.writerow([csv_safe(v) for v in (fmt_ts(r["created_ts"]), r["severity"],
                                                r["category"], r["source"], r["message"])])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=alerts_export.csv"})


# --------------------------------------------------------------------------
def main():
    processor.start()
    for m in monitors:
        m.start()
    url = f"http://{HOST}:{PORT}"
    log.info("Dashboard running at %s  (press CTRL+C to stop)", url)
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    try:
        # use_reloader=False is important: the reloader would start every thread twice
        app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)
    finally:
        for m in monitors:
            m.stop()
        processor.stop()
        log.info("Shutdown complete")


if __name__ == "__main__":
    main()