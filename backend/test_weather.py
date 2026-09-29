"""Weather widget API (Sep 29 2026): forecast shaping, ~1 km rounding before
anything leaves Nexus, the shared cache, and a provider outage.

    python -m unittest test_weather
"""
import os
import unittest
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import httpx
from fastapi.testclient import TestClient

import auth
import main
from routers import weather

FORECAST = {
    "timezone": "America/Los_Angeles",
    "current": {"time": "2026-09-28T20:15", "temperature_2m": 66.9, "apparent_temperature": 69.2,
                "relative_humidity_2m": 81, "is_day": 0, "precipitation": 0.0, "weather_code": 0,
                "wind_speed_10m": 3.2, "wind_direction_10m": 304},
    "hourly": {"time": [f"2026-09-28T{h:02d}:00" for h in range(18, 24)] + [f"2026-09-29T{h:02d}:00" for h in range(0, 18)],
               "temperature_2m": list(range(70, 94)), "precipitation_probability": [0] * 24,
               "weather_code": [0] * 24, "is_day": [0] * 24},
    "daily": {"time": ["2026-09-28", "2026-09-29"], "temperature_2m_max": [82.2, 80.0], "temperature_2m_min": [63.0, 61.0],
              "weather_code": [0, 3], "precipitation_probability_max": [26, 10], "uv_index_max": [6.85, 5.0],
              "sunrise": ["2026-09-28T06:40", "2026-09-29T06:41"], "sunset": ["2026-09-28T18:36", "2026-09-29T18:35"]},
}


class _Resp:
    def __init__(self, body, status=200):
        self._body, self.status_code = body, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=None)

    def json(self):
        return self._body


class WeatherTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        weather._cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        weather._cache.clear()

    def test_the_forecast_is_shaped_for_the_widget_and_rounded_before_it_leaves(self):
        with mock.patch.object(weather.httpx, "get", return_value=_Resp(FORECAST)) as get:
            r = self.client.get("/weather?lat=33.123456&lon=-117.087654")
        self.assertEqual(r.status_code, 200, r.text)
        params = get.call_args.kwargs["params"]
        self.assertEqual((params["latitude"], params["longitude"]), (33.12, -117.09))
        self.assertEqual(params["temperature_unit"], "fahrenheit")
        body = r.json()
        self.assertEqual(body["units"]["temp"], "°F")
        self.assertEqual(body["current"]["temp"], 66.9)
        self.assertFalse(body["current"]["isDay"])
        # The hourly strip starts at the current hour, twelve hours long.
        self.assertEqual(body["hourly"][0]["time"], "2026-09-28T20:00")
        self.assertEqual(len(body["hourly"]), 12)
        self.assertEqual(body["today"], {"high": 82.2, "low": 63.0, "precipChance": 26, "uvMax": 6.85,
                                         "sunrise": "2026-09-28T06:40", "sunset": "2026-09-28T18:36"})
        self.assertEqual([d["date"] for d in body["daily"]], ["2026-09-28", "2026-09-29"])

    def test_one_answer_serves_the_same_neighborhood(self):
        with mock.patch.object(weather.httpx, "get", return_value=_Resp(FORECAST)) as get:
            self.client.get("/weather?lat=33.121&lon=-117.091")
            self.client.get("/weather?lat=33.124&lon=-117.088")          # same ~1 km cell
            self.client.get("/weather?lat=33.121&lon=-117.091&units=metric")
        self.assertEqual(get.call_count, 2)                                # imperial once, metric once
        self.assertEqual(get.call_args.kwargs["params"]["temperature_unit"], "celsius")

    def test_a_provider_outage_is_a_friendly_502(self):
        with mock.patch.object(weather.httpx, "get", side_effect=httpx.ConnectError("down")):
            r = self.client.get("/weather?lat=10&lon=10")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["detail"], weather.UNAVAILABLE)

    def test_bad_input_is_refused(self):
        self.assertEqual(self.client.get("/weather?lat=95&lon=10").status_code, 400)
        self.assertEqual(self.client.get("/weather?lat=10&lon=10&units=kelvin").status_code, 422)
        self.assertEqual(self.client.get("/weather/places?q=a").status_code, 422)

    def test_city_search_and_a_readable_name(self):
        found = {"results": [{"name": "Pune", "admin1": "Maharashtra", "country": "India", "country_code": "IN",
                              "latitude": 18.52, "longitude": 73.86}, {"name": "No coords"}]}
        with mock.patch.object(weather.httpx, "get", return_value=_Resp(found)):
            places = self.client.get("/weather/places?q=Pune").json()["places"]
        self.assertEqual(places, [{"name": "Pune", "region": "Maharashtra", "country": "India",
                                   "countryCode": "IN", "lat": 18.52, "lon": 73.86}])
        rev = {"address": {"city": "Escondido", "state": "California", "country_code": "us", "ISO3166-2-lvl4": "US-CA"}}
        with mock.patch.object(weather.httpx, "get", return_value=_Resp(rev)) as get:
            self.assertEqual(self.client.get("/weather/place-name?lat=33.12&lon=-117.09").json(), {"name": "Escondido, CA"})
        self.assertIn("GreensNexus", get.call_args.kwargs["headers"]["User-Agent"])
        # A failed name lookup is an empty name, never an error.
        weather._cache.clear()
        with mock.patch.object(weather.httpx, "get", side_effect=httpx.ConnectError("down")):
            r = self.client.get("/weather/place-name?lat=33.12&lon=-117.09")
        self.assertEqual((r.status_code, r.json()), (200, {"name": ""}))


if __name__ == "__main__":
    unittest.main()
