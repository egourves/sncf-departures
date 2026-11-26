# SNCF API Reference

Reference for the `api.sncf.com` endpoints this extension actually uses.
(The SNCF API is based on Navitia, as documented on the SNCF developer site.)

---

## 1. Base URL and Authentication

```
https://api.sncf.com/v1
```

HTTP Basic Auth with the token as the username and an empty password:

```
Authorization: Basic base64("{token}:")
```

With curl:
```bash
curl -u "{token}:" https://api.sncf.com/v1/coverage/sncf
```

The extension implements this in `lib/api.js:49`:
```js
const credentials = GLib.base64_encode(`${this._token}:`);
message.get_request_headers().append('Authorization', `Basic ${credentials}`);
```

---

## 2. Coverage

`api.sncf.com` exposes a single coverage region with ID `sncf`. It is stored as
the default value of the `coverage-region` GSettings key and used to build every
endpoint path.

Since 24 November 2026 the data comes from NeTEx (timetables) and SIRI
(real time). The `sncf` coverage now also carries Île-de-France urban transit
(RATP métro, RER, Transilien, tramway, bus).

`/coverage/sncf/stop_areas` listed 4,653 stop areas on 25 November 2026. The
coverage reports `start_production_date` / `end_production_date` (a two-month
window) and `last_load_at`.
---

## 3. Station Search (Stop Area ID from Name)

Used by the preferences UI to resolve a station name into the `stop_area` ID
saved as `departure-station-id` / `arrival-station-id`.

```
GET /coverage/{region}/pt_objects?q={search_term}&type[]=stop_area&count=10
```

`/places` answers HTTP 401 (`authentification error: user not found`) for
regular tokens since the NeTEx switch, hence `pt_objects`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | required | Search term (station name) |
| `type[]` | string | all types | Filter: `stop_area`, `line`, `route`, `network`, … |
| `count` | integer | 10 | Max results |

**Response structure:**
```json
{
  "pt_objects": [
    {
      "id": "stop_area:SNC:FR::LMU:a829e6f0-cb0a-11e8-8bfa-f784c1c7c611:",
      "name": "Brest (Brest)",
      "embedded_type": "stop_area",
      "stop_area": {
        "id": "stop_area:SNC:FR::LMU:a829e6f0-cb0a-11e8-8bfa-f784c1c7c611:",
        "name": "Brest",
        "label": "Brest (Brest)"
      }
    }
  ]
}
```

The `stop_area.id` is the value saved to GSettings.

### SNCF stop_area ID format

Stop areas follow the pattern `stop_area:SNC:FR::LMU:<uuid>:`. The former
`stop_area:SNCF:87XXXXXX` IDs (UIC code) no longer resolve and the UIC code is
not exposed in `codes[]`; stations saved before the switch must be selected
again.

Implemented in `lib/api.js` (`searchStations`) and `prefs.js` (`_searchStation`).
---

## 4. Departures from a Station

```
GET /coverage/{region}/stop_areas/{stop_area_id}/departures
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `from_datetime` | string | now | Start time — format: `YYYYMMDDTHHmmss` |
| `count` | integer | 10 | Number of departures to return (max 200) |
| `data_freshness` | string | `base_schedule` | `realtime` for live data, `base_schedule` for timetable |
| `forbidden_uris[]` | string | none | Exclude objects, e.g. `physical_mode:Metro` |
| `duration` | integer | 86399 | Max seconds between `from_datetime` and the returned stop times |
| `until_datetime` | string | none | Upper bound instead of `duration` |

The extension excludes urban transit with `forbidden_uris[]`:
`physical_mode:Metro`, `physical_mode:RapidTransit`, `physical_mode:Tramway`,
`physical_mode:Bus` and `commercial_mode:LocalTrain` (Transilien). TER trains
use `physical_mode:LocalTrain` ("Train Transilien") too, so Transilien is
excluded by commercial mode, not physical mode.

Measured on 25 November 2026 at Paris Montparnasse, `count=50`: without
exclusion 46 Métro, 2 TER, 2 Transilien; with it 15 TER, 4 `TGV`, 31 `Train`.
Excluding `physical_mode:LocalTrain` instead drops the TER trains too.

**Example:**
```
GET /coverage/sncf/stop_areas/stop_area:SNC:FR::LMU:a829e6f0-cb0a-11e8-8bfa-f784c1c7c611:/departures
    ?from_datetime=20261125T170000
    &count=10
    &data_freshness=realtime
```

### Response structure

```json
{
  "departures": [
    {
      "stop_point": { "platform_code": null },
      "stop_date_time": {
        "departure_date_time": "20261125T172200",
        "base_departure_date_time": "20261125T172200",
        "data_freshness": "base_schedule"
      },
      "display_informations": {
        "direction": "Paris Montparnasse Hall 1 - 2 (Paris)",
        "code": "401A",
        "label": "401A",
        "headsign": "Paris Montparnasse Hall 1 - 2",
        "name": "Paris - Brest TGV",
        "trip_short_name": "8642",
        "commercial_mode": "Train",
        "physical_mode": "Train",
        "network": "Atlantique"
      },
      "route": { "name": "...", "direction": { "stop_area": { "id": "..." } } },
      "links": [
        { "type": "vehicle_journey", "id": "vehicle_journey:SNC:FR:ServiceJourney::SN8642FERRE_13479231" },
        { "type": "disruption", "id": "..." }
      ]
    }
  ],
  "disruptions": [
    {
      "id": "...",
      "severity": { "effect": "NO_SERVICE" },
      "messages": [
        { "channel": { "content_type": "text/plain" }, "text": "..." }
      ]
    }
  ]
}
```

`platform_code` was `null` on every departure sampled on 25 November 2026.

### Field mapping to the extension's data model

Parsed in `lib/api.js` (`_parseDeparture`):

| Extension field | API field |
|-----------------|-----------|
| `time` | `stop_date_time.base_departure_date_time` |
| `realtimeTime` | `stop_date_time.departure_date_time` |
| `delayMinutes` | `(realtimeTime - time) / 60000` |
| `direction` | `display_informations.direction` \|\| `route.name` |
| `direction_id` | `route.direction.stop_area.id` |
| `line` | `display_informations.code` |
| `category`, `badge` | derived by `classify()`, see §6 |
| `headsign` | `display_informations.trip_short_name` (train number) \|\| `display_informations.headsign` (now the destination) |
| `quay` | `stop_point.platform_code` |
| `cancelled` | `data_freshness == realtime` && `departure_date_time == ""`, or `label` contains `supprimé` |
| `vehicleJourneyId` | first `links[]` entry with `type == vehicle_journey` |
| `disruption` | looked up from top-level `disruptions[]` by matching `links[].type == disruption` |

When `data_freshness` is `base_schedule`, `departure_date_time` equals
`base_departure_date_time` and `delayMinutes` is 0.

`stop_point` sits on the departure itself, not under `stop_date_time` (whose
keys are `additional_informations`, `arrival_date_time`,
`base_arrival_date_time`, `base_departure_date_time`, `data_freshness`,
`departure_date_time`, `links`).

### Real-time coverage

SNCF announced 24 hours without real time after the switch. On 25 November
2026 at Brest, 2 of 44 departures requested with `data_freshness=realtime` came
back with `data_freshness: "realtime"`; the rest were `base_schedule`.

### Cancelled trains

A cancelled train (disruption effect `NO_SERVICE`) is **absent** from
`departures` with `data_freshness=realtime`, and the response's `disruptions[]`
does not mention it. With `data_freshness=base_schedule` it is listed at its
scheduled time, with a `display_informations.links[]` entry of type
`disruption` pointing to the `NO_SERVICE` disruption included in the response.
This matches the Navitia documentation's real-time section ("the departure time
of the cancelled train simply won't be displayed in the list of departures …
if data_freshness is set to realtime").

Verified on 26 November 2026 around 09:30:

| Train | Stop | `realtime` | `base_schedule` |
|-------|------|------------|-----------------|
| 9243 | Chambéry - Challes-les-Eaux, 09:44 | absent (of 40 departures) | present, 1 disruption link |
| 3108 | Bréauté - Beuzeville, 09:32 | absent | present, 1 disruption link |

The `cancelled` rule in the mapping above therefore never matches with
`data_freshness=realtime`.

Current cancellations can be found with
`GET /coverage/sncf/disruptions?since=<now>`: filter `severity.effect ==
"NO_SERVICE"`, take the `impacted_objects[].pt_object.id` of type `trip`, and
read its stops with `/vehicle_journeys/vehicle_journey:<trip id>`. On
26 November 2026 the endpoint returned 221 disruptions (155 `UNKNOWN_EFFECT`,
23 `SIGNIFICANT_DELAYS`, 9 `NO_SERVICE`, 8 `ADDITIONAL_SERVICE`,
5 `REDUCED_SERVICE`); the `NO_SERVICE` trips had no `impacted_stops`.
---

## 5. Vehicle Journey Stops

Used to resolve whether a departure actually stops at the configured arrival
station, and to display the name of that intermediary stop instead of the
terminus.

```
GET /coverage/{region}/vehicle_journeys/{vehicle_journey_id}?depth=2
```

**Response structure:**
```json
{
  "vehicle_journeys": [
    {
      "stop_times": [
        {
          "stop_point": {
            "name": "Brest",
            "stop_area": { "id": "stop_area:SNC:FR::LMU:a829e6f0-cb0a-11e8-8bfa-f784c1c7c611:" }
          }
        }
      ]
    }
  ]
}
```

Implemented in `lib/api.js` (`fetchVehicleJourneyStops`). Results are
cached in-memory by `vehicle_journey_id` and persistently by `headsign`
(`_persistentCachePath`).

---

## 6. Train Categories

No single field identifies the train type since the NeTEx switch: most
TGV INOUI come as `commercial_mode: "Train"`, OUIGO as `"TGV"`, TER coaches as
`commercial_mode: "TER"` with `physical_mode: "Autocar"`. `classify()` in
`lib/api.js` combines `physical_mode`, `commercial_mode`, `network` and `name`:

| Category | Rule | Badge |
|----------|------|-------|
| `coach` | `physical_mode == Autocar`, or `commercial_mode` ∈ {Autocar, Bus, Bus de substitution} unless `physical_mode == Train` | `Bus` |
| `ter` | `commercial_mode == TER` or `network` starts with `TER` | `TER` |
| `mainline` | `physical_mode == Train` | `OUIGO` / `Eurostar` (by `network`), `TGV` (`commercial_mode == TGV` or `name` contains `TGV`), `IC`, else `Train` |
| `other` | anything else | `commercial_mode` |

The `train-type-filter` GSettings key holds categories (`mainline`, `ter`,
`coach`); it defaults to `['mainline', 'ter']`. Values left over from older
versions are ignored.

Combinations observed on 25 November 2026 at Brest, Paris Montparnasse, Lyon
Part-Dieu and Lille Europe (`commercial_mode` / `physical_mode` / `network`):

| Example | Fields | Category / badge |
|---------|--------|------------------|
| Paris - Brest TGV | `Train` / `Train` / `Atlantique` | mainline / TGV (from `name`) |
| Paris - Bordeaux | `TGV` / `Train` / `Atlantique` | mainline / TGV |
| OUIGO Paris - Brest | `TGV` / `Train` / `OUIGO` | mainline / OUIGO |
| OUIGO Paris - Nantes | `Train` / `Train` / `OUIGO` | mainline / OUIGO |
| Londres - Bruxelles | `Train` / `Train` / `Eurostar` | mainline / Eurostar |
| Lux/Alsace/Loraine - LR | `Intercités` / `Train` / `Est` | mainline / IC |
| Nantes - Lyon | `Autocar` / `Train` / `Lignes d'aménagement du territoire` | mainline / IC |
| Paris - Littoral | `Train` / `Train` / `Nord` | mainline / Train |
| TER train | `TER` / `Train Transilien` / `TER …` | ter / TER |
| TER coach | `TER` / `Autocar` / `TER …` | coach / Bus |
| Coach | `Autocar` / `Autocar` / `TER Bretagne` | coach / Bus |
| Paris métro | `Métro` / `Métro` / `RATP` | excluded in the request |

The train number is in `display_informations.trip_short_name` (e.g. `8642`);
`headsign` now holds the destination.
---

## 7. Datetime Format

All datetimes use the format `YYYYMMDDTHHmmss` (no separators, `T` between
date and time):

```
20240315T083000  →  2024-03-15 at 08:30:00
```

Implemented in `lib/api.js` (`_formatNavitiaDate`, `_parseNavitiaDate`).

---

## 8. Additional Resources

- SNCF API portal (token registration): https://api.sncf.com/
- SNCF Open Data: https://ressources.data.sncf.com
- Swagger 2.0 description of the API (269 paths): `GET /v1/schema`, same
  authentication
- Navitia documentation: https://doc.navitia.io/

---

## 9. Endpoints Evaluated and Not Used

- **`/places`** — HTTP 401 `authentification error: user not found` since the
  NeTEx switch, while other endpoints work with the same token.
- **`/journeys`** (trip planner) —
  `?from=<A>&to=<B>&max_nb_transfers=0&direct_path=none&min_nb_journeys=8`
  returned exactly the 8 next direct trains between two stations on the same line on
  26 November 2026, with arrival times. The Navitia documentation describes it
  as a multi-objective (pareto) planner returning "interesting" journeys, so a
  train leaving earlier but arriving later than another may be omitted, and in
  `realtime` a cancelled train is replaced by another journey. Not suited to a
  departure board.
- **`/stop_areas/<A>/stop_areas/<B>/vehicle_journeys`** — returns every run
  serving both stops (143 on 26 November 2026, repeated across dates, either
  direction).
- **`/vehicle_positions`, `/equipment_reports`** — listed in the schema, not
  tried.
- **Train composition** — no endpoint in the schema describes cars or
  formation.
