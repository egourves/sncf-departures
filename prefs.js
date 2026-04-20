import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BASE_URL = 'https://api.sncf.com/v1';

/**
 * Perform a Navitia API request from the prefs process.
 */
async function _apiRequest(token, path) {
    const session = new Soup.Session();
    const uri = `${BASE_URL}${path}`;
    const message = Soup.Message.new('GET', uri);

    const credentials = GLib.base64_encode(`${token}:`);
    message.get_request_headers().append('Authorization', `Basic ${credentials}`);

    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                resolve(sess.send_and_read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });

    const status = message.get_status();
    if (status !== Soup.Status.OK)
        throw new Error(`HTTP ${status}: ${message.get_reason_phrase()}`);

    const decoder = new TextDecoder('utf-8');
    return JSON.parse(decoder.decode(bytes.get_data()));
}

export default class SncfPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const trainsPage = new Adw.PreferencesPage({
            title: _('Trains et gares'),
            icon_name: 'mark-location-symbolic',
        });
        window.add(trainsPage);
        this._buildFiltersGroup(trainsPage, settings);
        this._buildStationGroups(trainsPage, settings);

        const apiPage = new Adw.PreferencesPage({
            title: _('API et affichage'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(apiPage);
        this._buildDisplayGroup(apiPage, settings);
        this._buildApiGroup(apiPage, settings);
    }

    _buildApiGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('API'),
        });
        page.add(group);

        const tokenRow = new Adw.PasswordEntryRow({
            title: _('Token API'),
        });
        tokenRow.set_text(settings.get_string('api-token'));
        tokenRow.connect('changed', () => {
            settings.set_string('api-token', tokenRow.get_text());
        });
        group.add(tokenRow);
    }

    _buildStationGroups(page, settings) {
        this._buildStationSearchGroup(page, settings, {
            title: _('Gare de départ'),
            idKey: 'departure-station-id',
            nameKey: 'departure-station-name',
        });

        this._buildStationSearchGroup(page, settings, {
            title: _('Gare d\'arrivée (filtre optionnel)'),
            idKey: 'arrival-station-id',
            nameKey: 'arrival-station-name',
        });
    }

    /**
     * Build a station search group with search field and results list.
     */
    _buildStationSearchGroup(page, settings, {title, idKey, nameKey}) {
        const group = new Adw.PreferencesGroup({title});
        page.add(group);

        // Current selection display
        const currentId = settings.get_string(idKey);
        const currentName = settings.get_string(nameKey);
        const selectionRow = new Adw.ActionRow({
            title: _('Sélection'),
            subtitle: currentName ? `${currentName} (${currentId})` : _('Aucune'),
        });
        group.add(selectionRow);

        const clearBtn = new Gtk.Button({
            label: _('Effacer'),
            valign: Gtk.Align.CENTER,
        });
        clearBtn.connect('clicked', () => {
            settings.set_string(idKey, '');
            settings.set_string(nameKey, '');
            selectionRow.set_subtitle(_('Aucune'));
        });
        selectionRow.add_suffix(clearBtn);

        // Search field
        const searchRow = new Adw.EntryRow({
            title: _('Rechercher par nom'),
        });
        group.add(searchRow);

        const searchBtn = new Gtk.Button({
            label: _('Chercher'),
            valign: Gtk.Align.CENTER,
        });
        searchRow.add_suffix(searchBtn);

        // Results list — use a tracked array to allow reliable clearing
        const resultsGroup = new Adw.PreferencesGroup({
            title: _('Résultats'),
            visible: false,
        });
        page.add(resultsGroup);

        const statusRow = new Adw.ActionRow({title: '', visible: false});
        resultsGroup.add(statusRow);

        let resultRows = [];

        const doSearch = () => {
            this._searchStation(
                settings, searchRow.get_text(),
                resultsGroup, statusRow, resultRows,
                idKey, nameKey, selectionRow
            );
        };

        searchBtn.connect('clicked', doSearch);
        searchRow.connect('entry-activated', doSearch);
    }

    _buildFiltersGroup(page, settings) {
        const trainGroup = new Adw.PreferencesGroup({
            title: _('Types de train'),
            description: _('Sélectionner les types de train à afficher'),
        });
        page.add(trainGroup);

        const trainTypes = [
            'Train grande vitesse',
            'TER / Intercités',
            'Autocar',
        ];
        const activeTypes = settings.get_strv('train-type-filter');

        for (const trainType of trainTypes) {
            const row = new Adw.SwitchRow({
                title: trainType,
                active: activeTypes.includes(trainType),
            });
            row.connect('notify::active', () => {
                const current = settings.get_strv('train-type-filter');
                if (row.active && !current.includes(trainType)) {
                    current.push(trainType);
                    settings.set_strv('train-type-filter', current);
                } else if (!row.active && current.includes(trainType)) {
                    settings.set_strv('train-type-filter',
                        current.filter(t => t !== trainType));
                }
            });
            trainGroup.add(row);
        }
    }

    _buildDisplayGroup(page, settings) {
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Options d\'affichage'),
        });
        page.add(displayGroup);

        // Panel position
        const positionModel = new Gtk.StringList();
        positionModel.append(_('Gauche'));
        positionModel.append(_('Centre'));
        positionModel.append(_('Droite'));

        const positionValues = ['left', 'center', 'right'];
        const currentPosition = settings.get_string('panel-position');

        const positionRow = new Adw.ComboRow({
            title: _('Position dans le panneau'),
            model: positionModel,
            selected: positionValues.indexOf(currentPosition),
        });
        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positionValues[positionRow.selected]);
        });
        displayGroup.add(positionRow);

        // Max departures
        const maxAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 20,
            step_increment: 1,
            value: settings.get_int('max-departures'),
        });

        const maxRow = new Adw.SpinRow({
            title: _('Nombre de trains affichés'),
            adjustment: maxAdjustment,
        });
        maxRow.connect('notify::value', () => {
            settings.set_int('max-departures', maxRow.value);
        });
        displayGroup.add(maxRow);

        // Refresh interval
        const refreshAdjustment = new Gtk.Adjustment({
            lower: 15,
            upper: 3600,
            step_increment: 15,
            value: settings.get_int('refresh-interval'),
        });

        const refreshRow = new Adw.SpinRow({
            title: _('Intervalle d\'appel à l\'API (s)'),
            adjustment: refreshAdjustment,
        });
        refreshRow.connect('notify::value', () => {
            settings.set_int('refresh-interval', refreshRow.value);
        });
        displayGroup.add(refreshRow);

        // Log level
        const logLevelModel = new Gtk.StringList();
        const logLevels = ['off', 'error', 'warn', 'info', 'debug'];
        const logLevelLabels = [_('Désactivé'), _('Erreur'), _('Avertissement'), _('Info'), _('Débogage')];
        logLevelLabels.forEach(label => logLevelModel.append(label));

        const currentLogLevel = settings.get_string('log-level');
        const logLevelRow = new Adw.ComboRow({
            title: _('Niveau de log'),
            model: logLevelModel,
            selected: logLevels.indexOf(currentLogLevel),
        });
        logLevelRow.connect('notify::selected', () => {
            settings.set_string('log-level', logLevels[logLevelRow.selected]);
        });
        displayGroup.add(logLevelRow);
    }

    /**
     * Search for stations by name and populate results.
     */
    async _searchStation(settings, query, resultsGroup, statusRow, resultRows,
        idKey, nameKey, selectionRow) {
        if (!query || query.length < 2)
            return;

        const token = settings.get_string('api-token');
        if (!token) {
            statusRow.set_title(_('Token API requis'));
            statusRow.set_visible(true);
            resultsGroup.set_visible(true);
            return;
        }

        const coverage = settings.get_string('coverage-region');

        // Clear previous result rows using tracked references
        for (const row of resultRows)
            resultsGroup.remove(row);
        resultRows.length = 0;

        statusRow.set_title(_('Recherche en cours...'));
        statusRow.set_visible(true);
        resultsGroup.set_visible(true);

        try {
            const encoded = encodeURIComponent(query);
            const path = `/coverage/${encodeURIComponent(coverage)}/places?q=${encoded}&type[]=stop_area&count=10`;
            const data = await _apiRequest(token, path);

            const places = (data.places || [])
                .filter(p => p.embedded_type === 'stop_area');

            if (places.length === 0) {
                statusRow.set_title(_('Aucun résultat'));
                return;
            }

            statusRow.set_visible(false);

            for (const place of places) {
                const station = place.stop_area;
                const row = new Adw.ActionRow({
                    title: station.name,
                    subtitle: station.id,
                    activatable: true,
                });

                const selectBtn = new Gtk.Button({
                    label: _('Sélectionner'),
                    valign: Gtk.Align.CENTER,
                });
                row.add_suffix(selectBtn);

                selectBtn.connect('clicked', () => {
                    settings.set_string(idKey, station.id);
                    settings.set_string(nameKey, station.name);
                    selectionRow.set_subtitle(`${station.name} (${station.id})`);
                    resultsGroup.set_visible(false);
                });

                resultsGroup.add(row);
                resultRows.push(row);
            }
        } catch (e) {
            statusRow.set_title(_(`Erreur: ${e.message}`));
        }
    }
}
