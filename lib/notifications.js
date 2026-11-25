import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class NotificationManager {
    constructor() {
        this._lastNotifiedDelays = new Map();
        this._lastNotifiedCancellations = new Set();
        this._errorNotified = false;

        this._source = new MessageTray.Source({
            title: _('SNCF Departures'),
            iconName: 'emblem-trains-symbolic',
        });
        Main.messageTray.add(this._source);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
        this._lastNotifiedDelays.clear();
        this._lastNotifiedCancellations.clear();
    }

    checkDepartures(departures) {
        this._errorNotified = false;

        for (const dep of departures) {
            const key = `${dep.headsign}-${dep.time.getTime()}`;

            if (dep.cancelled && !this._lastNotifiedCancellations.has(key)) {
                this._lastNotifiedCancellations.add(key);
                this._send(
                    _('Train supprimé'),
                    `${dep.badge} ${dep.headsign} → ${dep.direction}`);
            } else if (dep.delayMinutes >= 5) {
                const lastDelay = this._lastNotifiedDelays.get(key);
                if (lastDelay !== dep.delayMinutes) {
                    this._lastNotifiedDelays.set(key, dep.delayMinutes);
                    this._send(
                        _(`Retard +${dep.delayMinutes} min`),
                        `${dep.badge} ${dep.headsign} → ${dep.direction}`);
                }
            }
        }
    }

    notifyError(message) {
        if (this._errorNotified)
            return;
        this._errorNotified = true;
        this._send(_('Erreur API'), message);
    }

    _send(title, body) {
        if (!this._source)
            return;

        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
        });
        this._source.addNotification(notification);
    }
}
