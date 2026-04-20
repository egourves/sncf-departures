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

---

## 3. Station Search (Stop Area UUID from Name)

Used by the preferences UI to resolve a station name into the `stop_area` ID
saved as `departure-station-id` / `arrival-station-id`.

```
GET /coverage/{region}/places?q={search_term}&type[]=stop_area&count=10
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | required | Search term (station name) |
| `type[]` | string | all types | Filter: `stop_area`, `stop_point`, `address`, `poi`, `administrative_region` |
| `count` | integer | 10 | Max results |

**Example:**
```
GET /coverage/sncf/places?q=Brest&type[]=stop_area&count=10
```

**Response structure:**
```json
{
  "places": [
    {
      "id": "stop_area:SNCF:87474007",
      "name": "Brest",
      "embedded_type": "stop_area",
      "stop_area": {
        "id": "stop_area:SNCF:87474007",
        "name": "Brest",
        "label": "Brest (Brest)"
      }
    }
  ]
}
```

The `stop_area.id` is the value saved to GSettings.

### SNCF stop_area ID format

SNCF stop areas follow the pattern `stop_area:SNCF:87XXXXXX` where the 8-digit
number is the UIC station code. Example: `stop_area:SNCF:87474007` for Brest.

Implemented in `lib/api.js:110` (`searchStations`) and `prefs.js:292`
(`_searchStation`).

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

**Example:**
```
GET /coverage/sncf/stop_areas/stop_area:SNCF:87474007/departures
    ?from_datetime=20240315T080000
    &count=10
    &data_freshness=realtime
```

### Response structure

```json
{
  "departures": [
    {
      "stop_date_time": {
        "departure_date_time": "20240315T083200",
        "base_departure_date_time": "20240315T083000",
        "data_freshness": "realtime",
        "stop_point": { "platform_code": "3" }
      },
      "display_informations": {
        "direction": "Paris Montparnasse (Paris)",
        "code": "TGV 8710",
        "headsign": "8710",
        "commercial_mode": "TGV INOUI",
        "physical_mode": "Train grande vitesse",
        "network": "SNCF",
        "label": "TGV INOUI"
      },
      "route": {
        "name": "Brest - Paris Montparnasse",
        "direction": {
          "stop_area": { "id": "stop_area:SNCF:87391003" }
        }
      },
      "links": [
        { "type": "vehicle_journey", "id": "vehicle_journey:SNCF:..." },
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

### Field mapping to the extension's data model

Parsed in `lib/api.js:316` (`_parseDeparture`):

| Extension field | API field |
|-----------------|-----------|
| `time` | `stop_date_time.base_departure_date_time` |
| `realtimeTime` | `stop_date_time.departure_date_time` |
| `delayMinutes` | `(realtimeTime - time) / 60000` |
| `direction` | `display_informations.direction` \|\| `route.name` |
| `direction_id` | `route.direction.stop_area.id` |
| `line` | `display_informations.code` |
| `network` | `display_informations.commercial_mode` \|\| `display_informations.network` |
| `trainType` | `display_informations.physical_mode` |
| `headsign` | `display_informations.headsign` |
| `quay` | `stop_date_time.stop_point.platform_code` |
| `cancelled` | `data_freshness == realtime` && `departure_date_time == ""`, or `label` contains `supprimé` |
| `vehicleJourneyId` | first `links[]` entry with `type == vehicle_journey` |
| `disruption` | looked up from top-level `disruptions[]` by matching `links[].type == disruption` |

When `data_freshness` is `base_schedule`, `departure_date_time` equals
`base_departure_date_time` and `delayMinutes` is 0.

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
            "stop_area": { "id": "stop_area:SNCF:87474007" }
          }
        }
      ]
    }
  ]
}
```

Implemented in `lib/api.js:134` (`fetchVehicleJourneyStops`). Results are
cached in-memory by `vehicle_journey_id` and persistently by `headsign`
(see `lib/api.js:229`).

---

## 6. Physical Modes

The extension filters client-side by `display_informations.physical_mode`
(stored as `trainType` in the parsed departure). Configured via the
`train-type-filter` GSettings key; defaults to:

- `Train grande vitesse` (TGV / OUIGO / Intercités)
- `TER / Intercités`
- `Autocar`

Brand-level refinement (TGV vs OUIGO) is read from `commercial_mode` in
`extension.js:202` (`_shortModeName`).

---

## 7. Datetime Format

All datetimes use the format `YYYYMMDDTHHmmss` (no separators, `T` between
date and time):

```
20240315T083000  →  2024-03-15 at 08:30:00
```

Implemented in `lib/api.js:357` (`_formatNavitiaDate`) and `lib/api.js:363`
(`_parseNavitiaDate`).

---

## 8. Additional Resources

- SNCF API portal (token registration): https://api.sncf.com/
- SNCF Open Data: https://ressources.data.sncf.com
