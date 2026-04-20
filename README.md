# SNCF Departures

GNOME Shell 49+ extension that displays SNCF train departures from a configured
station in the top bar.

> **Note:** The user interface is in French.

## Install

Clone into the GNOME Shell extensions directory, compile the schemas, then
restart the shell and enable the extension:

```bash
git clone <repo-url> \
    ~/.local/share/gnome-shell/extensions/sncf-departures@dev.gourves.net
cd ~/.local/share/gnome-shell/extensions/sncf-departures@dev.gourves.net
glib-compile-schemas schemas/
```

Restart GNOME Shell (log out and back in on Wayland, `Alt+F2` then `r` on X11),
then enable the extension:

```bash
gnome-extensions enable sncf-departures@dev.gourves.net
```

## Configuration

Open the extension preferences (`gnome-extensions prefs
sncf-departures@dev.gourves.net`) and fill in:

1. **API token** — register one at [api.sncf.com](https://api.sncf.com/).
2. **Departure station** — search by name and pick a result.
3. *(Optional)* **Arrival station** — filter departures to trains heading toward
   this station.
4. *(Optional)* **Train types** — restrict displayed trains (TGV, TER, Autocar).

## License

Released under the GNU General Public License version 2 or later — see [LICENSE](LICENSE).
