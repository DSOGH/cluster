# Waze map in the layout's window

A tool for the MGU Store, installed with Cluster Layouts (its `requires`). While a layout shows with
*Centre of the cluster: Waze*, Waze on cluster draws its map on the whole-panel target the layout draws on, at
the layout's window, instead of in the cluster's map slot under the layout, where the KOMBI draws its own map
screen over the map. With the layout off (Cluster Layouts' **Show** button, or *Show on the cluster: Off*) or
another centre, the map goes back to its own place on the stock cluster.

- `watch.js` (the service `m340-waze-window.service`, root): reads the window Cluster Layouts writes to
  `/dev/shm/cluster-info/map_window.txt` while it shows the Waze centre; when the wanted place changes (held 2 s
  on, 5 s off), it writes a runtime drop-in for `waze-on-cluster.service` in `/run` (`-s target=panel
  -s map_rect=X,Y,W,H` added to its start command, or none) and restarts it. The map comes back a few seconds
  after each switch. `/run` is empty at each start of the head unit, so Waze on cluster always starts in its own
  place.
- `hook.js`: on removal, stops the service, takes the drop-in out and puts the map back in its own place.

The layout puts every piece not meant to show over the map below z 0 while its centre is Waze, so the map (z 0 on
the panel) is over them and under the gauges, the faded edges and the texts.

Logs: `journalctl -u m340-waze-window`. Test: `node tools/test_waze_window.js`.
