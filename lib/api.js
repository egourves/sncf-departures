import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import * as Logger from './logger.js';

const BASE_URL = 'https://api.sncf.com/v1';

const VJ_CACHE_MAX = 100;
const PERSISTENT_CACHE_MAX = 200;
const PERSISTENT_CACHE_TTL_DAYS = 7;

// The sncf coverage also carries urban transit (RATP métro, RER, Transilien…).
// TER trains share physical_mode:LocalTrain with Transilien, so Transilien is
// excluded through its commercial mode.
const URBAN_MODE_URIS = [
    'physical_mode:Metro',
    'physical_mode:RapidTransit',
    'physical_mode:Tramway',
    'physical_mode:Bus',
    'commercial_mode:LocalTrain',
];

export const CATEGORIES = ['mainline', 'ter', 'coach'];

export class NavitiaClient {
    constructor(token) {
        this._token = token;
        this._coverage = null;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
        this._vjCache = new Map();
        this._persistentCache = new Map();
        this._loadPersistentCache();
    }

    set coverage(regionId) {
        this._coverage = regionId;
        Logger.debug(`Coverage set to: ${regionId}`);
    }

    get coverage() {
        return this._coverage;
    }

    destroy() {
        this._cancellable.cancel();
        this._session = null;
        this._vjCache = null;
        this._persistentCache = null;
    }

    cancel() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
    }

    async _request(path) {
        const uri = `${BASE_URL}${path}`;
        Logger.debug(`Requesting: ${uri}`);
        const message = Soup.Message.new('GET', uri);

        const credentials = GLib.base64_encode(`${this._token}:`);
        message.get_request_headers().append('Authorization', `Basic ${credentials}`);

        try {
            const bytes = await this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable);

            const status = message.get_status();
            Logger.debug(`Response status: ${status}`);

            const decoder = new TextDecoder('utf-8');
            const body = decoder.decode(bytes.get_data());

            if (status !== Soup.Status.OK)
                throw new Error(errorMessage(status, message.get_reason_phrase(), body));

            const parsed = JSON.parse(body);
            Logger.debug('Response parsed successfully');
            return parsed;
        } catch (e) {
            Logger.error(`Request failed: ${e.message}`);
            throw e;
        }
    }

    _requireCoverage() {
        if (!this._coverage)
            throw new Error('Coverage region not set. Configure location first.');
    }

    /**
     * Fetch departures from a stop_area.
     * @param {string} stationId - stop_area ID (e.g. stop_area:SNC:FR::LMU:a829e6f0-cb0a-11e8-8bfa-f784c1c7c611:)
     * @param {number} count - Number of departures to fetch
     * @returns {Promise<Array>} Parsed departure objects with disruption info
     */
    async fetchDepartures(stationId, count = 10) {
        this._requireCoverage();

        const now = new Date();
        const datetime = _formatNavitiaDate(now);
        const path = `/coverage/${encodeURIComponent(this._coverage)}/stop_areas/${encodeURIComponent(stationId)}/departures` +
            `?from_datetime=${datetime}&count=${count}&data_freshness=realtime` +
            URBAN_MODE_URIS.map(uri => `&forbidden_uris[]=${encodeURIComponent(uri)}`).join('');

        Logger.debug(`fetchDepartures: stationId=${stationId}, count=${count}`);
        const data = await this._request(path);

        if (!data.departures) {
            Logger.warn('No departures field in response');
            return [];
        }

        const disruptions = _indexDisruptions(data.disruptions || []);

        Logger.debug(`Parsing ${data.departures.length} departures`);
        return data.departures.map(dep => _parseDeparture(dep, disruptions));
    }

    /**
     * Search for stations by name within the configured coverage.
     * @param {string} query - Station name to search
     * @returns {Promise<Array<{id: string, name: string, label: string}>>}
     */
    async searchStations(query) {
        this._requireCoverage();

        const encoded = encodeURIComponent(query);
        const path = `/coverage/${encodeURIComponent(this._coverage)}/pt_objects?q=${encoded}&type[]=stop_area&count=10`;

        const data = await this._request(path);
        return stationsFromPtObjects(data);
    }

    /**
     * Fetch the list of stops for a vehicle journey.
     * @param {string} vehicleJourneyId
     * @returns {Promise<Array<{stopAreaId: string, name: string}>>}
     */
    async fetchVehicleJourneyStops(vehicleJourneyId) {
        this._requireCoverage();

        const path = `/coverage/${encodeURIComponent(this._coverage)}/vehicle_journeys/${encodeURIComponent(vehicleJourneyId)}?depth=2`;
        Logger.debug(`fetchVehicleJourneyStops: ${vehicleJourneyId}`);
        const data = await this._request(path);

        const vj = data.vehicle_journeys?.[0];
        if (!vj || !vj.stop_times)
            return [];

        return vj.stop_times.map(st => ({
            stopAreaId: st.stop_point?.stop_area?.id || '',
            name: st.stop_point?.name || '',
        }));
    }

    /**
     * Resolve the intermediary stop name between departure and arrival stations.
     * Uses a dual cache (in-memory by vehicleJourneyId, persistent by headsign).
     * @param {Object} departure - Parsed departure object
     * @param {string} departureStationId - stop_area ID of the departure station
     * @param {string} arrivalStationId - stop_area ID of the arrival station
     * @returns {Promise<string>} Stop name if found, otherwise departure.direction
     */
    async resolveIntermediaryStop(departure, departureStationId, arrivalStationId) {
        const {vehicleJourneyId, headsign, direction} = departure;

        if (!vehicleJourneyId)
            return direction;

        try {
            let stops = null;

            // 1. In-memory cache hit
            if (this._vjCache?.has(vehicleJourneyId)) {
                stops = this._vjCache.get(vehicleJourneyId);
                Logger.debug(`VJ in-memory cache hit: ${vehicleJourneyId}`);
            }

            // 2. Persistent cache hit
            if (!stops && headsign && this._persistentCache?.has(headsign)) {
                const entry = this._persistentCache.get(headsign);
                stops = entry.stops;
                Logger.debug(`VJ persistent cache hit: headsign=${headsign}`);
                // Populate in-memory cache
                this._vjCacheSet(vehicleJourneyId, stops);
            }

            // 3. Fetch from API
            if (!stops) {
                Logger.debug(`VJ cache miss, fetching: ${vehicleJourneyId}`);
                stops = await this.fetchVehicleJourneyStops(vehicleJourneyId);
                this._vjCacheSet(vehicleJourneyId, stops);
                if (headsign)
                    this._persistentCacheSet(headsign, stops);
            }

            // Walk stops: find departure station index, then look for arrival after it
            const depIndex = stops.findIndex(s => s.stopAreaId === departureStationId);
            if (depIndex === -1)
                return direction; // can't determine route, keep with terminus

            const arrivalStop = stops.slice(depIndex + 1).find(s => s.stopAreaId === arrivalStationId);
            return arrivalStop ? arrivalStop.name : null; // null = confirmed not stopping here
        } catch (e) {
            Logger.warn(`resolveIntermediaryStop failed: ${e.message}`);
            return direction;
        }
    }

    _vjCacheSet(vehicleJourneyId, stops) {
        if (!this._vjCache)
            return;
        // Evict oldest entry when at capacity
        if (this._vjCache.size >= VJ_CACHE_MAX) {
            const oldestKey = this._vjCache.keys().next().value;
            this._vjCache.delete(oldestKey);
        }
        this._vjCache.set(vehicleJourneyId, stops);
    }

    _persistentCacheSet(headsign, stops) {
        if (!this._persistentCache)
            return;
        if (this._persistentCache.size >= PERSISTENT_CACHE_MAX) {
            const oldestKey = this._persistentCache.keys().next().value;
            this._persistentCache.delete(oldestKey);
        }
        const now = new Date();
        const entry = {
            stops,
            date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
            fetchedAt: now.toISOString(),
        };
        this._persistentCache.set(headsign, entry);
        this._flushPersistentCache();
    }

    _persistentCachePath() {
        const cacheDir = GLib.get_user_cache_dir();
        return `${cacheDir}/sncf-departures/vj-stops.json`;
    }

    _loadPersistentCache() {
        try {
            const filePath = this._persistentCachePath();
            const file = Gio.File.new_for_path(filePath);
            if (!file.query_exists(null))
                return;

            const [, bytes] = file.load_contents(null);
            const decoder = new TextDecoder('utf-8');
            const data = JSON.parse(decoder.decode(bytes));

            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - PERSISTENT_CACHE_TTL_DAYS);

            for (const [headsign, entry] of Object.entries(data)) {
                if (entry.fetchedAt && new Date(entry.fetchedAt) >= cutoff)
                    this._persistentCache.set(headsign, entry);
            }
            Logger.debug(`Loaded ${this._persistentCache.size} persistent VJ cache entries`);
        } catch (e) {
            Logger.warn(`Failed to load persistent VJ cache: ${e.message}`);
        }
    }

    _flushPersistentCache() {
        try {
            const filePath = this._persistentCachePath();
            const file = Gio.File.new_for_path(filePath);
            const parent = file.get_parent();

            if (!parent.query_exists(null))
                parent.make_directory_with_parents(null);

            const obj = {};
            for (const [headsign, entry] of this._persistentCache.entries())
                obj[headsign] = entry;

            const json = JSON.stringify(obj, null, 2);
            const encoder = new TextEncoder();
            file.replace_contents(encoder.encode(json), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            Logger.debug('Persistent VJ cache flushed');
        } catch (e) {
            Logger.warn(`Failed to flush persistent VJ cache: ${e.message}`);
        }
    }

    /**
     * Filter departures by arrival station and/or train types.
     * @param {Array} departures - Parsed departure objects
     * @param {Object} options
     * @param {string} options.arrivalStationId - Keep only trains going to this stop_area
     * @param {string[]} options.trainTypes - Keep only these categories (see CATEGORIES)
     * @returns {Array} Filtered departures
     */
    filterDepartures(departures, {trainTypes = []} = {}) {
        // Ignore values saved by older versions, which filtered on physical_mode names.
        const active = trainTypes.filter(t => CATEGORIES.includes(t));
        if (active.length === 0)
            return departures;
        return departures.filter(dep => active.includes(dep.category));
    }
}

/**
 * Turn a pt_objects response into station search results.
 */
export function stationsFromPtObjects(data) {
    return (data.pt_objects || [])
        .filter(p => p.embedded_type === 'stop_area')
        .map(p => ({
            id: p.stop_area.id,
            name: p.stop_area.name,
            label: p.name,
        }));
}

/**
 * Prefer the API's own error message over the bare HTTP reason phrase.
 */
export function errorMessage(status, reason, body) {
    try {
        const message = JSON.parse(body)?.error?.message;
        if (message)
            return `HTTP ${status}: ${message}`;
    } catch {
        // non-JSON body
    }
    return `HTTP ${status}: ${reason}`;
}

/**
 * Classify a departure as mainline / ter / coach / other.
 * No single field is reliable since the NeTEx switch: most TGV INOUI come as
 * commercial_mode "Train", TER coaches as commercial_mode "TER".
 */
export function classify(info) {
    const commercial = info.commercial_mode || '';
    const physical = info.physical_mode || '';
    const network = info.network || '';

    if (physical === 'Autocar' ||
        (physical !== 'Train' && ['Autocar', 'Bus', 'Bus de substitution'].includes(commercial)))
        return {category: 'coach', badge: 'Bus'};
    if (commercial === 'TER' || network.startsWith('TER'))
        return {category: 'ter', badge: 'TER'};
    if (physical === 'Train') {
        if (network === 'OUIGO')
            return {category: 'mainline', badge: 'OUIGO'};
        if (network === 'Eurostar')
            return {category: 'mainline', badge: 'Eurostar'};
        if (commercial === 'TGV' || /\bTGV\b/.test(info.name || ''))
            return {category: 'mainline', badge: 'TGV'};
        if (commercial === 'Intercités' || network === "Lignes d'aménagement du territoire")
            return {category: 'mainline', badge: 'IC'};
        return {category: 'mainline', badge: 'Train'};
    }
    return {category: 'other', badge: commercial || physical};
}

/**
 * Build an index of disruptions keyed by their ID for fast lookup.
 */
function _indexDisruptions(disruptions) {
    const index = new Map();
    for (const d of disruptions) {
        const message = d.messages?.find(m => m.channel?.content_type === 'text/plain')?.text
            || d.messages?.[0]?.text
            || '';
        index.set(d.id, {
            effect: d.severity?.effect || d.effect || '',
            message,
        });
    }
    return index;
}

/**
 * Parse a raw departure object from the API into the extension's data model.
 */
function _parseDeparture(dep, disruptions) {
    const stopDateTime = dep.stop_date_time;
    const baseDeparture = _parseNavitiaDate(stopDateTime.base_departure_date_time);
    const realtimeDeparture = _parseNavitiaDate(stopDateTime.departure_date_time);

    const delayMinutes = Math.round((realtimeDeparture - baseDeparture) / 60000);

    const displayInfo = dep.display_informations || {};
    const route = dep.route || {};

    // Link disruptions and extract vehicle journey ID from the departure's links array
    let disruption = null;
    let vehicleJourneyId = null;
    const links = dep.links || [];
    for (const link of links) {
        if (link.type === 'disruption' && disruptions.has(link.id)) {
            disruption = disruptions.get(link.id);
        } else if (link.type === 'vehicle_journey' && !vehicleJourneyId) {
            vehicleJourneyId = link.id;
        }
    }

    return {
        time: baseDeparture,
        realtimeTime: realtimeDeparture,
        delayMinutes,
        direction: displayInfo.direction || route.name || '',
        direction_id: route.direction?.stop_area?.id || '',
        line: displayInfo.code || '',
        ...classify(displayInfo),
        // headsign carries the destination since the NeTEx switch; the train number moved to trip_short_name.
        headsign: displayInfo.trip_short_name || displayInfo.headsign || '',
        quay: dep.stop_point?.platform_code || dep.stop_date_time?.stop_point?.platform_code || '',
        cancelled: (stopDateTime.data_freshness === 'realtime' &&
                   stopDateTime.departure_date_time === '') ||
                   displayInfo.label?.includes('supprimé') || false,
        disruption,
        vehicleJourneyId,
    };
}

function _formatNavitiaDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
           `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function _parseNavitiaDate(str) {
    if (!str || str.length < 15)
        return new Date();

    const year = parseInt(str.substring(0, 4));
    const month = parseInt(str.substring(4, 6)) - 1;
    const day = parseInt(str.substring(6, 8));
    const hour = parseInt(str.substring(9, 11));
    const min = parseInt(str.substring(11, 13));
    const sec = parseInt(str.substring(13, 15));

    return new Date(year, month, day, hour, min, sec);
}
