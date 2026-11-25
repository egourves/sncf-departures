import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NavitiaClient} from './lib/api.js';
import {NotificationManager} from './lib/notifications.js';
import * as Logger from './lib/logger.js';

const DepartureRow = GObject.registerClass(
class DepartureRow extends PopupMenu.PopupBaseMenuItem {
    _init(departure) {
        super._init({reactive: false});

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'sncf-departure-row',
        });
        this.add_child(box);

        // Time column
        const timeStr = _formatTime(departure.time);
        const timeLabel = new St.Label({
            text: timeStr,
            style_class: 'sncf-time',
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(timeLabel);

        // Quay column — only show when within 20 minutes of departure
        const now = new Date();
        if (departure.quay && (departure.time - now) <= 20 * 60 * 1000) {
            const quayLabel = new St.Label({
                text: `V.${departure.quay}`,
                style_class: 'sncf-quay',
                x_align: Clutter.ActorAlign.START,
            });
            box.add_child(quayLabel);
        }

        // Train type column (TGV, TER, etc.)
        const typeLabel = new St.Label({
            text: departure.badge,
            style_class: 'sncf-train-type',
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(typeLabel);

        // Headsign column
        const headsignLabel = new St.Label({
            text: departure.headsign,
            style_class: 'sncf-headsign',
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(headsignLabel);

        // Delay column
        let delayText = '';
        let delayStyle = 'sncf-delay';
        if (departure.cancelled) {
            delayText = _('Supprimé');
            delayStyle += ' sncf-cancelled';
        } else if (departure.delayMinutes > 0) {
            delayText = `+${departure.delayMinutes}'`;
            delayStyle += ' sncf-delayed';
        } else if (departure.delayMinutes === 0) {
            delayText = _('à l\'heure');
            delayStyle += ' sncf-on-time';
        }

        const delayLabel = new St.Label({
            text: delayText,
            style_class: delayStyle,
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(delayLabel);

        // Direction column
        const dirLabel = new St.Label({
            text: departure.direction,
            style_class: 'sncf-direction',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(dirLabel);

        // Disruption indicator
        if (departure.disruption) {
            const disruptIcon = new St.Label({
                text: '\u26A0',
                style_class: 'sncf-disruption',
                x_align: Clutter.ActorAlign.END,
            });
            box.add_child(disruptIcon);
        }
    }
});

const SncfIndicator = GObject.registerClass(
class SncfIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('SNCF Departures'));
        this._extension = extension;

        // Top bar layout: icon + label
        this._box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this.add_child(this._box);

        const iconFile = Gio.File.new_for_path(`${extension.path}/icons/train-symbolic.svg`);
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            style_class: 'system-status-icon',
        });
        this._box.add_child(this._icon);

        this._label = new St.Label({
            text: '...',
            style_class: 'sncf-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._label);
    }

    updateTopBar(departures) {
        if (!departures || departures.length === 0) {
            this._label.set_text(_('--:--'));
            return;
        }

        const next = departures[0];
        const timeStr = _formatTime(next.realtimeTime);

        const parts = [timeStr];

        const now = new Date();
        if (next.quay && (next.time - now) <= 20 * 60 * 1000)
            parts.push(`V.${next.quay}`);

        parts.push('-');
        parts.push(next.badge);
        if (next.headsign)
            parts.push(next.headsign);

        let text = parts.join(' ');
        if (next.cancelled)
            text += ' \u2715';
        else if (next.delayMinutes > 0)
            text += ` +${next.delayMinutes}'`;

        this._label.set_text(text);
    }

    buildMenu(departures, stationName, error = null) {
        this.menu.removeAll();

        // Header
        const header = new PopupMenu.PopupMenuItem(
            stationName || _('SNCF Departures'), {reactive: false});
        header.label.add_style_class_name('sncf-header');
        this.menu.addMenuItem(header);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (error) {
            const errorItem = new PopupMenu.PopupMenuItem(error, {reactive: false});
            errorItem.label.add_style_class_name('sncf-error');
            this.menu.addMenuItem(errorItem);
        }

        if (!departures || departures.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                _('Aucun départ'), {reactive: false});
            this.menu.addMenuItem(empty);
        } else {
            for (const dep of departures)
                this.menu.addMenuItem(new DepartureRow(dep));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh button
        const refreshItem = new PopupMenu.PopupMenuItem(_('Actualiser'));
        refreshItem.connect('activate', () => this._extension._fetchAndUpdate());
        this.menu.addMenuItem(refreshItem);

        // Settings button
        const settingsItem = new PopupMenu.PopupMenuItem(_('Préférences...'));
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }
});

function _formatTime(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function _errorHint(message) {
    if (message.includes('Unable to find object'))
        return _('Gare introuvable : la resélectionner dans les préférences');
    return message;
}

export default class SncfDeparturesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._departures = [];
        this._consecutiveErrors = 0;

        Logger.setLevel(this._settings.get_string('log-level'));

        this._client = new NavitiaClient(this._settings.get_string('api-token'));
        this._client.coverage = this._settings.get_string('coverage-region');
        this._notifications = new NotificationManager();

        this._indicator = new SncfIndicator(this);
        const position = this._settings.get_string('panel-position');
        const box = position === 'left' ? 'left' : position === 'center' ? 'center' : 'right';
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, box);

        this._indicator.buildMenu([], this._settings.get_string('departure-station-name'));

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'log-level')
                Logger.setLevel(settings.get_string('log-level'));

            if (key === 'api-token') {
                this._client.destroy();
                this._client = new NavitiaClient(settings.get_string('api-token'));
                this._client.coverage = settings.get_string('coverage-region');
            }

            if (key === 'coverage-region')
                this._client.coverage = settings.get_string('coverage-region');

            if (['departure-station-id', 'api-token', 'refresh-interval',
                 'max-departures', 'train-type-filter', 'arrival-station-id'].includes(key)) {
                this._restartPolling();
            }
        });

        this._startPolling();
    }

    disable() {
        this._stopPolling();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._client?.destroy();
        this._client = null;

        this._notifications?.destroy();
        this._notifications = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
        this._departures = [];
    }

    _startPolling() {
        this._fetchAndUpdate();
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._fetchAndUpdate();
            return GLib.SOURCE_CONTINUE;
        });
        // Refresh display every 30s to prune departed trains without an API call
        this._displayTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refreshDisplay();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._displayTimerId) {
            GLib.source_remove(this._displayTimerId);
            this._displayTimerId = null;
        }
        this._client?.cancel();
    }

    _refreshDisplay() {
        const now = new Date();
        const visible = this._departures.filter(dep => {
            // Keep cancelled trains up to 1 minute after scheduled departure
            const cutoff = dep.cancelled ? dep.time + 60000 : dep.realtimeTime;
            return cutoff >= now;
        });
        this._indicator?.updateTopBar(visible);
        this._indicator?.buildMenu(visible, this._settings.get_string('departure-station-name'));
    }

    _restartPolling() {
        this._stopPolling();
        this._startPolling();
    }

    async _enrichDirections(departures, departureStationId, arrivalStationId) {
        const resolved = await Promise.all(
            departures.map(dep => this._client.resolveIntermediaryStop(
                dep, departureStationId, arrivalStationId))
        );
        const result = [];
        for (let i = 0; i < departures.length; i++) {
            if (resolved[i] === null)
                continue; // confirmed not stopping at arrival station
            if (resolved[i] !== departures[i].direction)
                result.push(Object.assign({}, departures[i], {direction: resolved[i]}));
            else
                result.push(departures[i]);
        }
        return result;
    }

    async _fetchAndUpdate() {
        Logger.debug('Fetch started');
        const stationId = this._settings.get_string('departure-station-id');
        const token = this._settings.get_string('api-token');

        Logger.debug(`Station ID: ${stationId}, Token: ${token ? 'set' : 'NOT SET'}`);

        if (!stationId || !token) {
            Logger.info('Missing station ID or token, showing config message');
            this._indicator?.updateTopBar([]);
            this._indicator?.buildMenu([], _('Configurer dans les préférences'));
            return;
        }

        try {
            const maxDepartures = this._settings.get_int('max-departures');
            const trainTypes = this._settings.get_strv('train-type-filter');
            const arrivalId = this._settings.get_string('arrival-station-id');
            // Fetch more when filters are active to ensure enough results after filtering
            const fetchCount = (arrivalId || trainTypes.length > 0) ? 50 : maxDepartures + 5;
            Logger.debug(`Fetching departures for station ${stationId}, fetchCount: ${fetchCount}`);
            let departures = await this._client.fetchDepartures(stationId, fetchCount);
            Logger.info(`Got ${departures.length} departures from API`);

            departures = this._client.filterDepartures(departures, {trainTypes});
            Logger.debug(`After filtering: ${departures.length} departures`);

            const departureId = this._settings.get_string('departure-station-id');
            if (arrivalId)
                departures = await this._enrichDirections(departures, departureId, arrivalId);

            departures = departures.slice(0, maxDepartures);

            this._departures = departures;
            this._consecutiveErrors = 0;

            Logger.info(`Displaying ${departures.length} departures`);
            this._indicator?.updateTopBar(departures);
            this._indicator?.buildMenu(
                departures, this._settings.get_string('departure-station-name'));

            this._notifications?.checkDepartures(departures);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;

            this._consecutiveErrors++;
            Logger.error(`Fetch error: ${e.message}`);
            Logger.debug(`Stack: ${e.stack}`);

            if (this._consecutiveErrors >= 3)
                this._notifications?.notifyError(e.message);

            // Keep showing last known departures rather than leaving display stale
            this._indicator?.updateTopBar(this._departures);
            this._indicator?.buildMenu(
                this._departures, this._settings.get_string('departure-station-name'),
                _errorHint(e.message));
        }
    }
}
