# Waze map in the M340i layout's window

A tool for the MGU Store: it starts Waze on cluster with its map on the whole-panel target (`target = panel`) at
the M340i Sport layout's window (`map_rect = 416,128,1088,480`), instead of in the cluster's map slot under the
layout, where the KOMBI draws its own map screen over the map.

- `zz-m340-waze-window.conf`: a drop-in for `waze-on-cluster.service` that adds the two settings to its start
  command. The deploy tool lays it on install and takes it out on removal; Waze on cluster reads it at its next
  start.
- `hook.js`: the install and removal hooks; each only asks the Store for a head-unit restart.

The layout puts every piece not meant to show over the map below z 0 while its centre is Waze, so the map
(z 0 on the panel) is over them and under the gauges, the faded edges and the song line.

Test: `node tools/test_waze_window.js`.
